/**
 * Faucet Controller
 * Paper-trading faucet: credits virtual demo funds to user accounts.
 *
 * Every balance write goes through controllers/paperLedger.js so the trading
 * engine ledger (Redis `<userId>_<currencyId>`), the wallet-API ledger
 * (Redis `<userId>_<assetDocId>`), the flat `assets` collection and
 * wallet.assets stay in step.
 */

import Currency from '../models/currency.js';
import { DepositEvent } from '../models/index.js';
import redis from 'redis';
import { promisify } from 'util';
import config from '../config/index.js';
import {
  hset,
  hget,
  hincbyfloat,
  claimOnce,
  releaseClaim,
  setBalanceLogged,
} from './redis.controller.js';
import { randomUUID } from 'crypto';
import {
  MARGIN_FREEZE_TTL_MS,
  marginFreezeKey,
} from '../lib/marginFreeze.js';
// The reset is the WRITER of the per-user reader/writer exclusion; every
// value-moving spot request is a reader. See lib/valueFlight.js.
import { readLiveValueFlights } from '../lib/valueFlight.js';
import {
  listRestingSpotOrders,
  SpotBookUnreadable,
} from '../lib/restingSpotOrders.js';
import { updateUserAsset } from '../grpc/walletService.js';
import { DEPOSIT_DECIMALS, toBaseUnits } from '../lib/depositUnits.js';
import {
  SPOT_BALANCE_KEY,
  toObjectId,
  resolveAccount,
  adjustSpotBalance,
  setSpotBalance,
} from './paperLedger.js';

// Redis client for cooldown keys (SET NX EX)
const redisClient = redis.createClient({ url: config.REDIS_URL });
redisClient.set = promisify(redisClient.set);
redisClient.ttl = promisify(redisClient.ttl);
redisClient.del = promisify(redisClient.del);

const FAUCET_AMOUNT = 1000; // per coin
const FAUCET_COOLDOWN_SECONDS = 24 * 60 * 60;

/**
 * PAPER TRADING: the faucet credits the quote currency of the venue's markets,
 * and nothing else.
 *
 * It used to credit USDC as well. USDC was the spec currency, so the original
 * faucet issued only that - but every spot pair quotes in USD and orderPlace
 * reads the buy-side balance from `walletbalance_spot <userId>_<pair
 * .secondCurrencyId>`, which is the USD currency, so a USDC-only faucet left
 * the user unable to BUY anything. Crediting both was the fix.
 *
 * With the venue down to a single BTC/USD market, USD is the leg that does the
 * work and USDC had no market at all: no BTC/USDC pair existed, so the balance
 * could not be traded, converted or spent. It was 1,000 units of nothing, and
 * it is gone - currency, balances and all.
 *
 * Mirrors DEMO_SEED_COINS in walletapi controllers/createAsset.js. The two are
 * pinned to each other by tests on BOTH sides, because a reset and a fresh
 * registration must produce the same account; changing one alone is precisely
 * the defect that pinning exists to catch.
 */
const FAUCET_COINS = ['USD'];
const PRIMARY_COIN = 'USD';

/**
 * THE SIGNUP SEED IS THE RESET'S FIXED POINT, AND THAT IS ONE FACT, NOT TWO.
 * =========================================================================
 *
 * `resetFaucet` writes ABSOLUTE balances: FAUCET_AMOUNT of each FAUCET_COIN in
 * spot, zero everywhere else. For the word "restore" to mean anything, that
 * point has to be the account a registration produces - and once it was not.
 * Any coin one side seeds and the other does not is a difference a reset mints
 * out of nothing on a brand-new account: repeatable, with no cooldown, so
 * unlimited.
 *
 * walletapi controllers/createAsset.js and this file are the only two
 * definitions of "a fresh paper account" and they agree number for number. The
 * cross-service guard is a test on each side pinning the literals; see the note
 * in createAsset.js for exactly what that does and does not catch.
 */


// Every Redis balance ledger a reset has to clear. Anything left funded here
// would survive the reset and be added on top of the fresh FAUCET_AMOUNT, which
// is how a user mints demo balance by parking funds elsewhere (internal
// transfer to another wallet, an open order, a lock) and resetting.
//
// CLEARING THEM IS NOT ON ITS OWN ENOUGH, and the earlier version of this
// comment claimed a completeness the code did not have. The list only decides
// what the reset zeroes; it says nothing about what may move AFTERWARDS. An
// order placed, or a cancel refunded, in the window around these writes lands
// on top of the grant however long this list is. What makes the total right is
// the exclusion the reset takes before it writes any of them - the margin
// freeze plus the value-flight registry, and the refusal while any obligation
// is still outstanding. See resetFaucet below and lib/valueFlight.js.
// LEDGERS THAT BELONG TO NO CURRENT PRODUCT ARE NO LONGER ZEROED, and that is
// deliberate rather than an omission. Nothing writes them and nothing reads
// them. A reset that still zeroed them would be
// this service reaching into a ledger no product uses to destroy stored numbers
// whose fate is the venue owner's decision, not the reset's - and it could not
// be undone. They keep whatever they last held.
//
// `walletbalance_p2p` HAS NOW LEFT THE LIST FOR EXACTLY THAT REASON. It was the
// p2p wallet's ledger, and the p2p remnants have been removed: walletapi no
// longer seeds it in `updatewalletfromdb`, no longer reads it in `getAsset`,
// and `redisWalletBackUp` no longer mirrors it to or from `assets.p2pBal`. With
// no writer left anywhere, nothing can park value in it, so it cannot be a
// route by which a balance survives the reset - and zeroing it would be this
// endpoint destroying stored numbers on the same terms the retired ledgers
// above are protected from. This line WAS the last thing in spotapi that wrote the
// hash, which is why it goes.
//
const OTHER_LEDGERS = [
  'walletbalance_spot_locked',
  'walletbalance_spot_inOrder'
];

const cooldownKey = (userId) => `${config.REDIS_PREFIX}faucet_cooldown_${userId}`;

/**
 * THE RECEIPT: WHAT WAS CREDITED, IN FULL, IN THE RESPONSE
 * ========================================================
 *
 * The faucet advertised "10,000 USDC + 10,000 USD" and then also credited
 * several coins of extra collateral - about $8,834 at the time it was measured
 * - so a portfolio moved ~$28,850 on a claim the button said was worth
 * $20,000. Nothing was wrong with the seeding itself. What was wrong is that
 * the claim did not say so.
 *
 * The same for the reset, in the other direction: the confirm copy named
 * wallets as "zeroed" that the reset then re-seeded.
 *
 * So both endpoints now answer with `credited` - EVERY coin that moved, the
 * wallet it moved into and the balance it ended at - plus a one-line `headline`
 * built from that same list. The UI renders the list; it cannot describe a
 * credit the API did not report, and it cannot omit one the API did.
 *
 * A CLAIM ALSO PERSISTS THAT LIST (see recordCreditedLegs). The receipt only
 * ever reached the browser that made the call; the deposit rows are the user's
 * history, readable from any device and from the API directly.
 */

/** Human amount: thousands separated, trailing zeros dropped. */
const formatQty = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
};

const creditLine = (coin, amount, wallet, balance) => ({
  coin,
  amount,
  wallet,
  balance
});

/** "10,000 USDC + 10,000 USD" for one wallet's worth of credits. */
const creditPhrase = (credits) =>
  credits.map((c) => `${formatQty(c.amount)} ${c.coin}`).join(' + ');

/**
 * The single sentence a receipt can be rendered from, covering EVERY wallet
 * that was touched - never just the spot half.
 */
const buildHeadline = (credits, { verb = 'credited' } = {}) => {
  const byWallet = new Map();
  for (const credit of credits) {
    if (!byWallet.has(credit.wallet)) byWallet.set(credit.wallet, []);
    byWallet.get(credit.wallet).push(credit);
  }

  const labels = { spot: 'spot wallet' };
  const parts = [];
  for (const [wallet, list] of byWallet) {
    parts.push(`${creditPhrase(list)} to your ${labels[wallet] || wallet}`);
  }

  if (parts.length === 0) return 'Nothing was credited';
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${parts.join(', and ')}`;
};

/**
 * EVERY CREDITED LEG BECOMES A DEPOSIT ROW
 * ========================================
 *
 * The receipt above tells the device that made the claim what it was given.
 * That is not the user's history: a receipt lives in the browser that made the
 * call, so on any other device - or a plain API read - a credit the receipt
 * named simply did not exist in the user's own deposit history.
 *
 * So the SAME `credited` list the receipt is built from is what gets persisted,
 * one DepositEvent per leg. The list cannot describe a credit that was not
 * written and cannot omit one that was, because there is only one list.
 *
 * The signature carries the wallet - `faucet-<ts>-<userId>-<wallet>-<coin>` -
 * so a coin credited to two wallets in one claim gets two distinct rows rather
 * than colliding on the collection's unique signature index.
 *
 * `creditedAt` is the claim's single timestamp for every leg, not a per-row
 * `new Date()`: the legs of one claim have to sort as one group, and the
 * history's tiebreak is insertion order within an identical timestamp.
 *
 * A failure here never fails the claim - the balances are already credited and
 * the cooldown is already held, and refusing the claim at this point would take
 * the money back without taking the cooldown back.
 */
async function recordCreditedLegs(userId, credited, timestamp) {
  const creditedAt = new Date(timestamp);
  const recorded = [];

  for (const credit of credited) {
    const amount = toBaseUnits(credit.amount, DEPOSIT_DECIMALS);
    if (amount === null) {
      console.error('[Faucet] Refusing to record a non-numeric credit:', credit);
      recorded.push({ ...credit });
      continue;
    }

    const signature = `faucet-${timestamp}-${userId}-${credit.wallet}-${credit.coin}`;
    try {
      await DepositEvent.create({
        // No chain is recorded. The schema required one and permitted a single
        // value, so every demo credit was stamped with a chain this venue does
        // not use. A faucet credit does not happen on one.
        signature: signature,
        fromAddress: 'faucet',
        toAddress: 'faucet',
        asset: credit.coin,
        wallet: credit.wallet,
        amount: amount,
        decimals: DEPOSIT_DECIMALS,
        status: 'credited',
        creditedAt: creditedAt,
        userId: userId
      });
      recorded.push({ ...credit, signature });
    } catch (err) {
      console.error(
        '[Faucet] Failed to save deposit record:',
        credit.wallet,
        credit.coin,
        err
      );
      recorded.push({ ...credit });
    }
  }

  return recorded;
}

/**
 * The faucet currencies that actually exist, primary coin first so the response
 * keeps reporting the USDC balance in `balance`.
 */
async function getFaucetCurrencies() {
  const currencies = await Currency.find({ coin: { $in: FAUCET_COINS } });
  const list = Array.isArray(currencies) ? currencies.filter(Boolean) : [];

  const missing = FAUCET_COINS.filter((coin) => !list.some((c) => c.coin === coin));
  if (missing.length > 0) {
    console.warn('[Faucet] Currency missing, it will not be credited:', missing.join(', '));
  }

  return list.sort((a, b) => FAUCET_COINS.indexOf(a.coin) - FAUCET_COINS.indexOf(b.coin));
}

/**
 * WHY THE RESET NO LONGER CANCELS SPOT ORDERS, AND REFUSES INSTEAD.
 * =================================================================
 *
 * It used to. `cancelOpenSpotOrders` asked mongo for this user's open orders,
 * dropped them from the redis books and marked the rows cancelled, and the
 * comment above it said that this meant "the balance an order reserves can
 * never be released back after a reset". It did not mean that, twice over:
 *
 *   1. THE QUESTION WAS ASKED OF THE WRONG STORE. `limitOrderPlace` reserves in
 *      redis BEFORE it writes the mongo document, and `newOrderHistory` does
 *      not even await that write - so an order in flight was invisible to the
 *      query by construction. MEASURED: `faucet/reset` raced against spot limit
 *      placement took an account from 10,000 to 48,039.52 in four consecutive
 *      wins; 12 of 32 races broke.
 *   2. CANCELLING IS NOT THE ONLY WAY A RESERVATION COMES BACK. A resting order
 *      can also FILL. The matcher credits the proceeds from its own loop, long
 *      after the request that placed the order has ended, and no exclusion this
 *      endpoint can take covers a settlement that is already in progress.
 *
 * So the reset now REFUSES while this account has any spot obligation at all.
 * A reset writes ABSOLUTE balances; an absolute write is only
 * correct as the last word. The precondition that makes it the last word is not
 * "I have cancelled everything I could see", it is "there is nothing left that
 * can move this account's money", and only the second one is checkable.
 *
 * WHY REFUSING IS THE RIGHT TRADE ON A PAPER VENUE
 * ------------------------------------------------
 * The reset is a convenience: it restores a known total, and the user can reach
 * the same state by cancelling their orders and pressing it again. What it is
 * NOT is a way to get out of something - a stuck order is cancelled from the
 * order panel, which is always available and is deliberately never gated. So
 * the cost of refusing is one extra click, on the rare occasion a user resets
 * with orders resting; the cost of not refusing is a scoreboard that can be
 * inflated without limit, on a product whose whole point is the scoreboard.
 *
 * An ordinary reset - the overwhelmingly common case, an account with nothing
 * resting - is byte-for-byte what it was, and `cleared.cancelledSpotOrders`
 * still answers 0 because that is now the only honest value it can take.
 */

/**
 * Every coin the user holds a ledger entry for, with all the Redis field ids it
 * can be addressed by. A coin bought on a USD pair only exists in wallet.assets
 * (the flat `assets` collection is USDC-only), so both stores are merged -
 * otherwise a reset silently leaves the bought BTC behind.
 */
async function collectUserCoins(userIdObj) {
  const walletDb = Currency.db;
  const byCoin = new Map();

  const add = (coin, ids) => {
    if (!coin) return;
    const entry = byCoin.get(coin) || { coin, ids: new Set(), currencyId: null };
    for (const id of ids) {
      if (id) entry.ids.add(id.toString());
    }
    byCoin.set(coin, entry);
  };

  // The flat `assets` collection was read here first, because it held a second
  // copy of one coin's balance. It held USDC alone and went with that currency,
  // so wallet.assets below is the whole of what a user can hold.

  try {
    const walletDoc = await walletDb.collection('wallet').findOne({ _id: userIdObj });
    if (walletDoc && Array.isArray(walletDoc.assets)) {
      for (const asset of walletDoc.assets) {
        add(asset.coin, [asset.currencyId, asset._id], null);
        const entry = byCoin.get(asset.coin);
        if (entry && !entry.currencyId && asset.currencyId) {
          entry.currencyId = asset.currencyId.toString();
        }
      }
    }
  } catch (err) {
    console.error('[Faucet] Could not read wallet.assets while resetting:', err?.message || err);
  }

  return [...byCoin.values()];
}

/**
 * THE RESERVATION COUNTERS, READ DIRECTLY - THE QUESTION THAT IS TRUE NOW.
 * =======================================================================
 *
 * Asking mongo whether the user has an unfinished order answers only
 * eventually: this venue RESERVES BEFORE IT PUBLISHES, so the document is
 * written LAST. The reservation COUNTER moves FIRST, in the same redis command
 * that decides the order is affordable, so `locked > 0` is true from the
 * instant the account acquires an obligation - which is the instant that
 * matters to something about to zero the counter.
 *
 * It is read here in exactly the field styles zeroOtherBalances is about to
 * WRITE (`collectUserCoins` produces both the trading engine's `userId_currencyId` and
 * the wallet API's `userId_assetDocId`), so anything the reset could destroy is
 * something this loop looked at. Reading a narrower set than the reset writes
 * would be the same class of enumeration error all over again.
 *
 * ZERO IS NOT ASSUMED FROM A MISSING FIELD BEING UNREADABLE: a redis error
 * propagates to the caller, which refuses. "I could not tell" must never be
 * spelled "no exposure" here - that is the direction that destroys margin.
 */

/**
 * Zero every balance the user holds outside the faucet coins: the other coins'
 * spot balances plus the lock / in-order ledgers, in
 * every Redis field style (userId_currencyId for the trading engine,
 * userId_assetDocId for the Wallet API).
 *
 * Returns what it touched, so the reset's response can state it rather than the
 * UI having to assume: `clearedCoins` had their non-spot ledgers cleared,
 * `zeroedCoins` additionally had their SPOT balance set to 0 (everything that
 * is not a faucet coin).
 */
async function zeroOtherBalances(userId, faucetCoins, preCollectedCoins) {
  const userIdObj = toObjectId(userId);
  // The caller has already collected these to read the reservation counters
  // with; re-collecting would read the wallet a second time and, worse, could
  // return a DIFFERENT set from the one the gate cleared.
  const coins = preCollectedCoins || (await collectUserCoins(userIdObj));
  const clearedCoins = [];
  const zeroedCoins = [];

  for (const entry of coins) {
    const fields = [...entry.ids].map((id) => `${userIdObj.toString()}_${id}`);
    clearedCoins.push(entry.coin);

    for (const ledger of OTHER_LEDGERS) {
      for (const field of fields) {
        await hset(ledger, field, 0);
      }
    }

    // The faucet coins are set to FAUCET_AMOUNT right after this; every other
    // coin has to go to zero so it cannot be sold back into them.
    if (!faucetCoins.includes(entry.coin)) {
      zeroedCoins.push(entry.coin);

      for (const field of fields) {
        // Zeroing a coin is a movement of the whole balance out of it, and the
        // ledger has to say so or a replay restores what the reset removed.
        await setBalanceLogged(SPOT_BALANCE_KEY, field, 0, {
          reason: 'faucet_reset_zero',
          ref: userIdObj.toString(),
        });
      }

      try {
        await updateUserAsset({
          id: userIdObj.toString(),
          currencyId: entry.currencyId,
          spotBal: '0'
        });
      } catch (grpcErr) {
        console.error(
          '[Faucet] LEDGER SYNC FAILURE: gRPC updateUserAsset failed while zeroing a non-faucet coin; wallet.assets is now diverged from Redis (Redis remains authoritative)',
          { userId: userIdObj.toString(), coin: entry.coin },
          grpcErr
        );
      }
    }

  }

  return { clearedCoins, zeroedCoins };
}

/**
 * Claim demo funds
 * POST /api/spot/faucet/claim
 * Auth: User token (passport)
 */
export const claimFaucet = async (req, res) => {
  const userId = req.user?.id;
  let creditedAny = false;

  try {
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // 24h cooldown per user
    const acquired = await redisClient.set(
      cooldownKey(userId),
      Date.now().toString(),
      'EX',
      FAUCET_COOLDOWN_SECONDS,
      'NX'
    );

    if (acquired !== 'OK') {
      const retryAfter = await redisClient.ttl(cooldownKey(userId));
      return res.status(429).json({
        success: false,
        message: 'Faucet already claimed, please try again later',
        retryAfter: retryAfter > 0 ? retryAfter : FAUCET_COOLDOWN_SECONDS
      });
    }

    const currencies = await getFaucetCurrencies();
    if (currencies.length === 0) {
      await redisClient.del(cooldownKey(userId));
      return res.status(500).json({
        success: false,
        message: `Faucet currency not found (${FAUCET_COINS.join(', ')})`
      });
    }

    const balances = {};
    const timestamp = Date.now();

    for (const currency of currencies) {
      const account = await resolveAccount(userId, currency, { create: true });
      // Increment the live engine balance (never set from the flat ledger,
      // which trading does not update) so the claim credits exactly
      // FAUCET_AMOUNT - in every Redis field style at once.
      balances[currency.coin] = await adjustSpotBalance(account, FAUCET_AMOUNT, {
        label: 'credit'
      });
      creditedAny = true;
    }

    const creditedCoins = currencies.map((c) => c.coin);
    const primaryCoin = creditedCoins.includes(PRIMARY_COIN) ? PRIMARY_COIN : creditedCoins[0];

    // EVERY credit. Built from the same map the credits were written from, so
    // it cannot drift from what actually happened.
    const creditedLegs = creditedCoins.map((coin) =>
      creditLine(coin, FAUCET_AMOUNT, 'spot', balances[coin])
    );

    // ...and every one of them is written to the user's history, not just the
    // spot half. See recordCreditedLegs.
    const credited = await recordCreditedLegs(userId, creditedLegs, timestamp);

    // Back-compat: the response has always carried a coin -> signature map and
    // a single primary signature. Each credit line now carries its own
    // signature too, which is the one that survives a coin credited to more
    // than one wallet.
    const signatures = {};
    for (const credit of credited) {
      if (credit.signature && !signatures[credit.coin]) {
        signatures[credit.coin] = credit.signature;
      }
    }

    const headline = buildHeadline(credited, { verb: 'credited' });

    res.json({
      success: true,
      amount: FAUCET_AMOUNT,
      balance: balances[primaryCoin],
      balances: balances,
      coins: creditedCoins,
      signature: signatures[primaryCoin],
      signatures: signatures,
      credited: credited,
      headline: headline,
      message: headline
    });

  } catch (error) {
    console.error('[Faucet] Claim error:', error);
    // Only hand the cooldown back when nothing was credited - releasing it
    // after a partial credit would let the credited coins be claimed twice.
    if (userId && !creditedAny) {
      await redisClient.del(cooldownKey(userId)).catch(() => {});
    }
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Reset demo account balance
 * POST /api/spot/faucet/reset
 * Auth: User token (passport)
 * Restores a known TOTAL: every ledger other than the faucet coins' spot
 * balance is zeroed, so the account always ends at exactly FAUCET_AMOUNT per
 * faucet coin rather than FAUCET_AMOUNT plus whatever was parked elsewhere.
 *
 * REFUSED while the account holds ANY obligation - a resting spot order, or a
 * value-moving request of its own still in flight. See the note above
 * `collectUserCoins` for why refusing replaced the spot-order cancellation that
 * used to happen here, and lib/valueFlight.js for the in-flight half.
 *
 * AND IT IS REFUSED FROM BEHIND A FREEZE, BECAUSE THE OLD GATE ASKED A QUESTION
 * THAT WAS ONLY EVENTUALLY TRUE.
 * ============================================================================
 * The old gate read mongo documents. This venue RESERVES BEFORE IT PUBLISHES:
 * the ledger moves first and the document that would justify it is written
 * last. So an order in FLIGHT is invisible to a document-based gate by
 * construction, and the reset ran straight through it and zeroed value the
 * order had already paid for.
 *
 * MEASURED, five fresh throwaway accounts, `faucet/reset` fired 5ms after
 * `orderPlace`: THREE of the five finished holding a reservation the reset had
 * already written over.
 *
 * The order of operations below is the fix, and each step earns the next:
 *
 *   1. take the per-user MARGIN FREEZE (lib/marginFreeze.js). From here on NO
 *      reservation can be created for this user: spot's reservation checks the
 *      same key with an `EXISTS` inside the single Lua step that takes the
 *      reservation, so there is no window between the check and the write. It
 *      did not, which is what made this endpoint an unlimited mint.
 *   2. read the VALUE-FLIGHT REGISTRY. The freeze stops a request from STARTING
 *      to move money; it does not stop one that started a microsecond earlier
 *      from finishing. A request that has already reserved and has not yet
 *      published its order is invisible to every store, so it is registered as
 *      in flight for the whole stretch between those two things, and its
 *      registration and the freeze are ordered by redis. See lib/valueFlight.js.
 *   3. read the RESERVATION COUNTERS. They move first, so any obligation the
 *      account already has is visible in them; and nothing can be added while
 *      the freeze is held. This is the question that is true at the moment it
 *      matters.
 *   4. read what is RESTING IN THE SPOT BOOKS. That is the store the order path
 *      awaits before it answers, and step 2 has established that nothing is
 *      between its debit and that write. Not mongo - mongo lags the books by an
 *      unbounded amount (lib/restingSpotOrders.js).
 *   5. only then, mutate.
 *
 * Redis serialises the freeze against both the reservation and the flight
 * registration, so there are exactly two orderings and both are safe: the other
 * request got there first and steps 2-4 refuse the reset, or the freeze got
 * there first and the other request is refused with nothing moved.
 *
 * WHAT A RESET IS, IN BOTH DIRECTIONS, AND WHY IT HAS NO COOLDOWN.
 * ================================================================
 * This paragraph used to read: "The claim CREATES demo money, so how often it
 * may run is the grant rate and has to be bounded. A reset creates none." The
 * second sentence is FALSE, and it was the sentence the whole no-cooldown
 * decision rested on. A reset SETS. On an account BELOW the fixed point it
 * creates the difference out of nothing - a blown-up account goes from 0 back
 * to the full seed - and that is not a side effect, it is the entire product
 * purpose of the button.
 *
 * The statements that ARE true, and that the code enforces:
 *
 *   1. A reset leaves the account at THE SIGNUP SEED, exactly, whatever it held
 *      before - FAUCET_COINS x FAUCET_AMOUNT of spot balance, and zero in
 *      every other ledger and every other coin. Bidirectional: it CREATES
 *      value on an account below the
 *      seed and DESTROYS value on an account above it. See THE SIGNUP SEED IS
 *      THE RESET'S FIXED POINT above for how the two ends were made to agree.
 *   2. It is IDEMPOTENT. `reset(reset(x)) == reset(x)`, so running it a
 *      thousand times leaves the account where one run left it, and it can
 *      never put the account ABOVE the seed.
 *   3. It is NOT a bound on the venue's demo-money supply, and nothing here
 *      claims it is. An account that loses a seed's worth to a counterparty and
 *      resets has moved that value into the counterparty and refilled itself,
 *      and it may repeat that as often as it can arrange to lose. Nothing in
 *      this file bounds that loop. It is written down so the next reader does
 *      not infer a bound the code does not provide.
 *
 * WHY NO COOLDOWN - a reason that is true, rather than the one that was not.
 * -------------------------------------------------------------------------
 * A cooldown on the RESET would bound nothing a user cannot have for free.
 * Registration on this venue is open (email + password, no KYC - the product
 * owner has refused KYC) and unlimited, and it hands out THE SAME SEED, from
 * the same function. "Wait 24 hours" and "register again" are therefore the
 * same wait with extra paperwork, and the second is strictly WORSE for the
 * scoreboard this product exists to keep: it scatters one person's demo money
 * across accounts nothing can relate, instead of leaving it on the one account
 * they already have. A restart limit is worth having only when a fresh seed is
 * scarce. Here it is not. If registration ever stops being open, this
 * paragraph stops being true and the reset needs the same 24h rule the claim
 * has.
 *
 * The CLAIM's cooldown is not made pointless by that, because the claim is a
 * different shape: it ADDS. An unbounded claim is unbounded ACCUMULATION on one
 * account - another 10,000 USDC every time, for ever - which registering again
 * cannot give you, because a fresh account starts at the seed and not above it.
 * A reset can never exceed the seed. Different shapes, different rules.
 *
 * WHICH KIND OF RULE THIS WOULD HAVE BEEN. The product owner has refused rate
 * limiting AS PROTECTION; a cooldown expressing "you may restart once a day"
 * would have been a PRODUCT RULE and would have been in scope. It is not being
 * added because the argument above says it buys nothing - NOT because rate
 * limiting is out of scope. And it would not have closed the remaining race
 * either: a cooldown makes a race rarer, and "rarer" is the shape of fix that
 * leaves a mint in the product with a smaller window. What closes the races
 * this endpoint DOES close is the exclusion above. What it does not close is
 * listed under WHAT THIS EXCLUSION DOES NOT COVER, below.
 *
 * WHAT THIS EXCLUSION DOES NOT COVER - STATED, BECAUSE IT IS NOT COVERED.
 * =======================================================================
 * The freeze plus the flight registry excludes every REQUEST that moves this
 * account's money. It does NOT exclude the ENGINE LOOP below, because the
 * matcher registers no flight and moves a user's balance from a cron long
 * after the request that created the obligation has returned:
 *
 *   SPOT MATCHER (controllers/spot.controller.js tradeMatching /
 *   marketMatching). An order leaves the book at `hdel("buyOpenOrders_"+pairId,
 *   id)` and the proceeds are paid by `settlementCredit` some way further down.
 *   Between those two points the order is resting nowhere, no reservation
 *   counter names it, and no flight is registered - so every one of this
 *   endpoint's gates answers "this account is idle" and the reset writes an
 *   absolute balance that the settlement then lands on top of. Measured window
 *   on this stack: 0.704 ms per fill.
 *
 * THE DECISION, EXPLICITLY: these are NOT closed in this change, and they are
 * NOT judged harmless. Sub-millisecond is not "safe", it is "rare" - this file
 * already says in as many words that "rarer" is the shape of fix that leaves a
 * mint in the product with a smaller window, and the same standard has to apply
 * to a window nobody chose as much as to one somebody did. A win is worth one
 * fill's proceeds landing on top of a full seed, and it is repeatable, so the
 * aggregate is unbounded exactly as the original 10,000 -> 48,039.52 was.
 *
 * WHY IT IS NOT CLOSED HERE. Closing it means the matcher registering a flight
 * for BOTH users of every fill, held across the whole stretch from the `hdel`
 * to the settlement - four `settlementCredit` call sites reached through about
 * ten `hdel` sites in a 1,300-line matching loop that every pair shares. That
 * is a change to the engine's hot path, and it is not one to make in the same
 * pass as the ledger changes above
 * without room to mutation-test the matcher itself. It is written down here,
 * with the call sites named, rather than left for the next round to rediscover.
 *
 * WHAT WILL NOT DO AS A SUBSTITUTE, so it is not tried later by mistake: the
 * per-pair `tradePair` latch in spot.controller.js looks like a ready-made
 * gate and is not one. It is a module-level variable (so it says nothing about
 * a matcher in another process), it is only set `if (topCross)`, and it is
 * cleared after the FIRST settled match while the `while` loop goes on
 * settling more. It covers neither end of the window it appears to name.
 *
 * The freeze is released in a `finally`, and expires on its own if this process
 * dies holding it.
 */
export const resetFaucet = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const freezeKey = marginFreezeKey(userId);
  const freezeToken = randomUUID();
  // FAILS CLOSED. claimOnce answers false both when someone else holds the
  // freeze and when redis cannot be reached, and neither is a state in which
  // this endpoint may start zeroing ledgers.
  const frozen = await claimOnce(freezeKey, freezeToken, MARGIN_FREEZE_TTL_MS);
  if (!frozen) {
    return res.status(409).json({
      success: false,
      code: 'RESET_IN_PROGRESS',
      message:
        'A reset for this account is already running (or could not be started safely). Nothing has been changed - please try again in a moment.'
    });
  }

  try {
    // BEFORE ANY MUTATION, AND AFTER THE FREEZE. Every write below is
    // irreversible from here, so the checks that decide whether they may happen
    // have to come first - and they have to be asked while nothing can be
    // reserved behind their back.
    // STEP 2. IS ANY REQUEST OF THIS USER'S STILL MOVING MONEY?
    //
    // The freeze stops the NEXT one; this catches the one that started first.
    // A request that has reserved and not yet published is invisible to every
    // store there is, so the only way to see it is to have it say so, which is
    // what the registry is. It FAILS CLOSED - a redis error propagates to the
    // catch below and the reset answers 500 rather than assuming an empty
    // registry means an idle account.
    const flights = await readLiveValueFlights(userId);
    if (flights.length > 0) {
      return res.status(409).json({
        success: false,
        code: 'RESET_BUSY',
        message:
          'Another request on your account is still being processed - an ' +
          'order, a cancellation or a withdrawal is in flight. A reset ' +
          'restores fixed balances, and doing that underneath a request that ' +
          'is still moving money would leave your account holding both. ' +
          'Nothing has been changed - please try again in a moment.',
        positions: [],
        orders: [],
        unavailable: []
      });
    }

    const userIdObj = toObjectId(userId);
    // Collected ONCE and reused by the zeroing below, so the fields checked are
    // exactly the fields written.
    //
    // The SPOT obligations this must refuse on are checked below: resting spot
    // orders, and the value-flight registry.
    const coins = await collectUserCoins(userIdObj);

    // STEP 3. IS ANYTHING OF THIS USER'S RESTING IN A SPOT BOOK?
    //
    // A resting spot order holds money that has ALREADY left
    // `walletbalance_spot` and can come back two different ways - a cancel
    // refunds it, a fill pays out the proceeds - both of them after this
    // request has returned. Setting the balance to FAUCET_AMOUNT while either
    // is outstanding is what the verifier turned into 48,039.52. The books are
    // read rather than mongo because they are the store the order path awaits;
    // see lib/restingSpotOrders.js.
    //
    // The refusal carries `orders`, with productLabel + pairName, so the
    // frontend's describeResetRefusal already renders "Cancel your 2 resting
    // orders - Spot BTCUSD" with no new case.
    let restingSpotOrders;
    try {
      restingSpotOrders = await listRestingSpotOrders(userId);
    } catch (err) {
      if (err instanceof SpotBookUnreadable) {
        console.error('[Faucet] Spot books unreadable, refusing reset:', err.message);
        return res.status(503).json({
          success: false,
          code: 'SPOT_BOOK_UNAVAILABLE',
          message:
            'Your open spot orders could not be checked, so the reset has not ' +
            'run and nothing has been changed. Please try again in a moment.',
          positions: [],
          orders: [],
          unavailable: []
        });
      }
      throw err;
    }
    if (restingSpotOrders.length > 0) {
      const count = restingSpotOrders.length;
      return res.status(409).json({
        success: false,
        code: 'OPEN_SPOT_ORDERS',
        message:
          `You still have ${count} spot order${count === 1 ? '' : 's'} resting ` +
          'in the book. Those orders are holding balance that would be paid ' +
          'back on top of the restored total, so nothing has been changed. ' +
          'Cancel them and try again.',
        positions: [],
        orders: restingSpotOrders,
        unavailable: []
      });
    }

    const currencies = await getFaucetCurrencies();
    if (currencies.length === 0) {
      return res.status(500).json({
        success: false,
        message: `Faucet currency not found (${FAUCET_COINS.join(', ')})`
      });
    }

    const faucetCoins = currencies.map((c) => c.coin);

    // The absolute `hset(<ledger>, field, 0)` this performs on the spot
    // reservation counters is safe HERE and nowhere else: the margin freeze is
    // held, so nothing can reserve, and the reset has already refused while any
    // spot order is resting. Outside those facts it would be the very "absolute
    // write to a delta-only counter" the ledgers forbid.
    //
    // EXCLUDE BY THE CONSTANT, NOT THE RESOLVED SET. `faucetCoins` is only the
    // faucet coins whose Currency doc resolved; a faucet coin whose doc is
    // absent (a misconfigured venue) is missing from it, so zeroing "every coin
    // not in faucetCoins" would set THAT coin's spot balance to 0 - and, with
    // no currency to resolve an account from, the credit loop below never
    // restores it, destroying the user's balance in a coin the reset is meant
    // to preserve. FAUCET_COINS is the full intended set, so a faucet coin is
    // never zeroed even when it cannot be re-credited. In a correctly seeded
    // venue the two sets are identical and this changes nothing.
    const zeroed = await zeroOtherBalances(userId, FAUCET_COINS, coins);

    const balances = {};
    for (const currency of currencies) {
      const account = await resolveAccount(userId, currency, { create: true });
      balances[currency.coin] = await setSpotBalance(account, FAUCET_AMOUNT);
    }

    const primaryCoin = faucetCoins.includes(PRIMARY_COIN) ? PRIMARY_COIN : faucetCoins[0];

    // The reset's receipt states BOTH halves: what it set, and what it cleared.
    // The old copy named a wallet as "zeroed" and then re-seeded it, which is
    // the same dishonesty as the claim's, told backwards.
    //
    // DELIBERATELY NOT PERSISTED as DepositEvents, unlike a claim's legs, and
    // NOT because "only the claim creates demo money" - an earlier version of
    // this comment said that and it is false; a reset on a depleted account
    // creates the whole shortfall (see WHAT A RESET IS above). The reason is
    // that the numbers below are not amounts GIVEN. A reset SETS: `credited`
    // here is the account's resulting POSITION, and on an account already at
    // the seed nothing moved at all, while on one above it value was destroyed.
    // Writing FAUCET_AMOUNT into the deposit history as though it had been
    // handed over would state a credit that did not happen, in either
    // direction. A deposit row is a record of a transfer in; the honest record
    // of a reset is a reset row, and this endpoint does not have one to write.
    const credited = faucetCoins.map((coin) =>
      creditLine(coin, FAUCET_AMOUNT, 'spot', balances[coin])
    );
    // The sentence states only what this endpoint actually did. It used to end
    // "and any open spot orders are cancelled", which stopped being true the
    // moment the reset started REFUSING while orders are resting instead of
    // cancelling them - and a reset that reaches this line has already proved
    // there were none.
    const headline = `${buildHeadline(credited, { verb: 'reset to' })}. ` +
      'Every other coin balance is set to 0.';

    res.json({
      success: true,
      balance: balances[primaryCoin],
      balances: balances,
      coins: faucetCoins,
      credited: credited,
      cleared: {
        // Named exactly as the ledgers they correspond to, so the confirm
        // dialog can list them without paraphrasing. EMPTY now: the reset used
        // to name a wallet here because it zeroed it, and it no longer touches
        // any wallet outside OTHER_LEDGERS. Reporting a wallet this
        // endpoint did not clear would be the same class of lie the `credited`
        // receipt was built to stop.
        wallets: [],
        // ALWAYS 0, and it is kept only because clients read it. A reset that
        // gets this far has proved the account had nothing resting; it no
        // longer cancels anything, because it can no longer run while there is
        // anything to cancel. See the note above collectUserCoins.
        cancelledSpotOrders: 0,
        zeroedCoins: zeroed.zeroedCoins,
        clearedCoins: zeroed.clearedCoins
      },
      headline: headline,
      message: headline
    });

  } catch (error) {
    console.error('[Faucet] Reset error:', error);
    res.status(500).json({ success: false, message: error.message });
  } finally {
    // ALWAYS, and on every early return above too - a freeze left behind would
    // refuse the user's next order for the whole TTL. The token comparison
    // inside releaseClaim means a call that has already timed out cannot delete
    // a freeze somebody else has since taken.
    await releaseClaim(freezeKey, freezeToken).catch(() => {});
  }
};

/**
 * How long until this account may claim again
 * GET /api/spot/faucet/status
 * Auth: User token (passport)
 *
 * THE COOLDOWN IS A PRODUCT RULE, NOT PROTECTION.
 * ----------------------------------------------
 * The claim page had no way to ask, so it left the Claim button enabled for the
 * whole 24 hours and the user found out by pressing it and being handed a 429
 * error toast - a failure, for behaving exactly as designed. The 429 already
 * carries `retryAfter`; this route is the same number, available BEFORE the
 * click, so the page can say when instead of refusing after.
 *
 * It reports, and never writes: `ttl` is a read, so asking cannot start,
 * extend or reset a cooldown. Redis returns -2 for a key that does not exist
 * and -1 for one with no expiry; both mean "nothing is stopping this account",
 * and only a positive TTL is a wait.
 */
export const faucetStatus = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const ttl = await redisClient.ttl(cooldownKey(userId));
    const retryAfter = typeof ttl === 'number' && ttl > 0 ? ttl : 0;

    return res.status(200).json({
      success: true,
      canClaim: retryAfter === 0,
      retryAfter,
      cooldownSeconds: FAUCET_COOLDOWN_SECONDS
    });
  } catch (error) {
    console.error('[Faucet] Status error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export default {
  claimFaucet,
  resetFaucet,
  faucetStatus
};
