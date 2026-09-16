/**
 * THE DEFINITION OF A CRYPTODEX VENUE, FROM NOTHING.
 * ================================================
 *
 * Every constant here was read back off the running venue (branch
 * `paper-trading`, HEAD 1f0dc62) rather than invented, so that a reset
 * reproduces the venue that demonstrably trades instead of a plausible-looking
 * one. Where this file deliberately DIFFERS from what is live, the difference
 * is called out at the constant.
 *
 * WHY THE _ids ARE PINNED
 * -----------------------
 * Currency ids, spot-pair ids and the liquidity bot's user id are hardcoded to
 * the values the live venue already uses. That is not cosmetic:
 *
 *   - redis order-book keys are `buy_depth_binance_<pairId>` /
 *     `sell_depth_binance_<pairId>` and the open-order hashes are
 *     `buyOpenOrders_<pairId>`; a reset that minted fresh pair ids would
 *     strand every one of them under a dead id.
 *   - `walletbalance_spot` is keyed `<userId>_<currencyId>`, so a fresh
 *     currency id silently detaches every balance the engine reads.
 *   - the chart collections in `cryptodex_spot` are named by tikerRoot
 *     (`chart_BTCUSD_1m`), but the frontend links a market by pair id.
 *
 * Pinning them makes the reset REPRODUCIBLE: run it twice, on two machines,
 * and the two venues are the same venue.
 */

/* ------------------------------------------------------------------ *
 * CURRENCIES  ->  <prefix>_wallet.currency
 * ------------------------------------------------------------------ *
 *
 * THREE, since the venue went single-market (BTC/USD): USDC, BTC and USD. It
 * held five while ETH and SOL were listed, and the current live state is NOT the
 * "1 currency row" bug it looks like.
 * `cryptodex_wallet.currency` - the collection BOTH the walletapi model
 * (models/currency.js, explicit third argument 'currency') and the spotapi
 * model (models/currency.js, walletDb.model(..., 'currency')) bind to - holds
 * exactly these rows. What holds one row is `cryptodex_wallet.currencies`,
 * a collection nothing in the product reads; it is residue from a script that
 * let mongoose pluralise the model name. See the note in ops/README.md.
 *
 * Why two and not one:
 *   USD   quote of the pair, and the only coin the faucet issues. spot
 *         orderPlace reads the buy-side balance at `walletbalance_spot
 *         <userId>_<pair.secondCurrencyId>`, so without a USD currency row
 *         nobody can BUY anything.
 *   BTC   the only base. This venue lists exactly one market; ETH and SOL were
 *         removed with their pairs.
 * Two is the floor, not a preference: one base and the quote it trades against.
 *
 * There was a third, USDC, described here as the paper-trading spec currency
 * and seeded at registration alongside USD. It never had a market - no BTC/USDC
 * pair existed - so the balance could not be traded, converted or spent, and it
 * sat on the wallet page as 1,000 units of nothing. It is removed entirely:
 * currency row, every balance, the four priceconversion directions, and the
 * flat `assets` collection that existed only to hold it.
 *
 * DELIBERATE DEVIATION FROM LIVE: `symbol` and `gateway_code` are added.
 * The walletapi Currency schema marks both `required`, and the live rows have
 * neither - they were inserted raw, so any `Currency.save()` on one of them
 * throws ValidationError. Adding them is inert for every read path (nothing
 * reads gateway_code on this venue) and removes a latent write failure.
 */
export const CURRENCIES = [
  {
    _id: '695bf0e2b9aba016fb8ce3c1',
    coin: 'BTC',
    symbol: 'BTC',
    gateway_code: 'BTC',
    name: 'Bitcoin',
    type: 'crypto',
    status: 'active',
    network: 'BTC',
    decimals: 8,
  },
  {
    _id: '695bf0e2b9aba016fb8ce3c4',
    coin: 'USD',
    symbol: 'USD',
    gateway_code: 'USD',
    name: 'US Dollar',
    type: 'fiat',
    status: 'active',
    network: 'FIAT',
    decimals: 2,
  },
];

export const CURRENCY_ID = Object.fromEntries(
  CURRENCIES.map((c) => [c.coin, c._id])
);

/* ------------------------------------------------------------------ *
 * SPOT PAIRS  ->  <prefix>_spot.spotpair
 * ------------------------------------------------------------------ *
 *
 * `botstatus: 'binance'` and `secondCurrencySymbol: 'USD'` are LOad-BEARING,
 * not decoration. lib/binanceWebSocket.js selects its streams with
 * `{ status:'active', botstatus:'binance' }` and then builds the upstream
 * symbol as `secondCurrencySymbol === 'USD' ? base + 'USDT' : base + quote`.
 * Change either and the depth feed goes dark, which takes the paper ladder
 * (which is built from that depth) with it - no depth, no fills.
 *
 * The price fields below are a COLD-START value only. They are overwritten
 * within seconds of spotapi booting, and controllers/loadPairs.js carries the
 * cached redis value forward for any of them mongo has no value for
 * (LIVE_ONLY_FIELDS). They exist so the market list is not full of zeros in
 * the window before the first binance tick arrives.
 *
 * FAITHFUL TO LIVE, INCLUDING THE ODD BITS. `pairName`, `maxLeverage`,
 * `makerFee`, `takerFee` and `spotFee` are NOT in the spotpair mongoose schema
 * - they are legacy columns, invisible to any hydrated
 * `SpotPair.findOne()`. They are reproduced anyway because
 * controllers/loadPairs.js reads pairs with `.lean()`, which does NOT strip
 * them, so they DO reach the `spotPairdata` redis hash the frontend reads, and
 * lib/restingSpotOrders.js falls back to `pair.pairName` for the order-history
 * label. Equally deliberate is what is NOT added: the live rows carry no
 * `minOrderValue`, `maxOrderValue` or `isSecondTradeFee`, and nothing in
 * spotapi reads them, so inventing values here would be a behaviour change
 * dressed up as completeness.
 */
export const SPOT_PAIRS = [
  {
    _id: '695bf1017573eeb15a749c9d',
    pairName: 'BTC/USD',
    tikerRoot: 'BTCUSD',
    firstCurrencyId: CURRENCY_ID.BTC,
    secondCurrencyId: CURRENCY_ID.USD,
    firstCurrencySymbol: 'BTC',
    secondCurrencySymbol: 'USD',
    firstFloatDigit: 8,
    secondFloatDigit: 2,
    maxLeverage: 10,
    makerFee: 0.1,
    takerFee: 0.1,
    spotFee: 0.1,
    maker_rebate: 0,
    taker_fees: 0,
    minPricePercentage: -90,
    maxPricePercentage: 100,
    minQuantity: 0.0001,
    maxQuantity: 1000,
    status: 'active',
    botstatus: 'binance',
    coldStartPrice: 65000,
  },
];

/* ------------------------------------------------------------------ *
 * THE LIQUIDITY BOT  ->  <prefix>_user.user + redis admin_liquidity
 * ------------------------------------------------------------------ *
 *
 * SPOT CANNOT FILL A SINGLE ORDER WITHOUT THIS, and nothing in the product
 * creates it on a fresh database. controllers/paperBook.controller.js reads
 * `hget("admin_liquidity","liquidation")` before it builds a ladder; if the
 * field is absent it logs "orders cannot fill", calls dropLadder(pairId,
 * "no_admin_liquidity") and returns - so the book is empty and every user
 * order rests forever.
 *
 * `POST /api/admin/add-bot-user` NO LONGER EXISTS. It was removed with the
 * privileged router it lived on, and this seed is now the ONLY way the
 * liquidity bot and its redis cache entry come into being. That is a
 * strengthening, not a loss: the endpoint was never usable as the reset path,
 * for the two reasons below, both of which still read as the reasons it was
 * safe to delete.
 *
 * WAS IT THE INTENDED PATH? PARTLY.
 * It reached userapi's grpc `botUser()` (user.controller.js), which DOES write
 * the redis entry - `hset("admin_liquidity","liquidation", doc)` on both the
 * update and the create branch - so the endpoint was a genuine writer of the
 * cache, not just of mongo. It was still not usable as the reset path:
 *   1. It needed a privileged JWT, i.e. a privileged account had to already
 *      exist and be logged in - so it could not be the first step of a
 *      bring-up.
 *   2. `newBotUser` validated firstName/lastName/email and NOT `type`, and
 *      `botUser()` then ran `User.findOne({ role: reqBody.type })`. Mongoose
 *      strips an undefined value out of a filter, so a body without `type`
 *      degrades to `User.findOne({})`, which selects an ARBITRARY account,
 *      OVERWRITES its name and e-mail with the bot's, and installs that user
 *      as the house liquidity account. (Same shape as the documented
 *      `resendMail` hazard in auth.controller.js.) Deleting the endpoint
 *      removed that hazard outright rather than leaving it to be fixed.
 *
 * So the reset seeds the account and the cache entry directly, in the exact
 * shape `botUser()` wrote them. Proved with
 * `node ops/reset-and-seed.mjs --verify`, which reports the bot user and
 * `admin_liquidity/liquidation` present and matching.
 *
 * WHY THE REDIS VALUE IS A LEAN SUBSET. `botUser()`'s update branch writes the
 * document it fetched under the projection {firstName,lastName,email,role,
 * userId,_id}, mongoose adds its `id` virtual on JSON.stringify, and that is
 * what is in redis on the live venue right now. Reproduced field for field.
 * The only fields any consumer touches are `_id` (paperBook.buildPaperOrders
 * stamps it as the synthetic order's userId, and spot.controller.js compares
 * against it to decide maker vs taker) and `userId` (the synthetic's userCode).
 *
 * `userId: '12024756'` is not arbitrary either: it is
 * IncCntObjId('695af33fe64f3be062b77bb4') = parseInt('b77bb4', 16), the same
 * derivation registration uses. Pinning the _id pins this too.
 */
export const LIQUIDITY_BOT = {
  _id: '695af33fe64f3be062b77bb4',
  firstName: 'admin',
  lastName: 'bot',
  email: 'adminbot@bot.com',
  role: 'admin_bot',
  userId: '12024756',
};

/* ------------------------------------------------------------------ *
 * PRICE CONVERSION  ->  <prefix>_wallet.priceconversion
 * ------------------------------------------------------------------ *
 *
 * One row per ORDERED pair of distinct currencies: with two currencies that is
 * 2 x 1 = 2 (it was 3 x 2 = 6 with USDC, and 5 x 4 = 20 when ETH and SOL were
 * listed). The COUNT is
 * derived, not written down - the rows are generated from CURRENCIES below, so
 * removing a coin removes its directions automatically. It is the shape
 * walletapi's priceCNV cron
 * expects to find - `PriceConversion.find({})` drives the fetch, and rows it
 * does not find are (mostly) never created, so a missing direction is a
 * conversion that silently returns nothing forever.
 *
 * `convertPrice: 0` is a cold start: the cron overwrites within one tick.
 * `fetchFrom: 'off'` matches live (the paper venue does not pull live FX).
 */
export const priceConversionRows = () => {
  const rows = [];
  for (const base of CURRENCIES) {
    for (const quote of CURRENCIES) {
      if (base.coin === quote.coin) continue;
      rows.push({
        baseSymbol: base.coin,
        convertSymbol: quote.coin,
        convertPrice: 0,
        source: 'cryptocompare',
        fetchFrom: 'off',
      });
    }
  }
  return rows;
};

/* ------------------------------------------------------------------ *
 * SITE SETTING  ->  <prefix>_user.sitesetting
 * ------------------------------------------------------------------ *
 *
 * Exactly one row, and the frontend fetches it on EVERY page through
 * components/HelperRoute.tsx -> getsiteSetting() -> GET /user/siteSetting.
 * pages/index.tsx guards its banner block with `!isEmpty(siteSetting)`, so a
 * missing row does not crash the home page - it deletes the banner section
 * from it. The e-mail templates also interpolate ##SITE_NAME## and
 * ##SUPPORT_MAIL## out of this row.
 */
export const SITE_SETTING = {
  _id: '695b0e962fe7b8b00381210f',
  marketTrend: [],
  companyName: '',
  siteName: 'Cryptodex Exchange',
  address: '123 Exchange Street',
  contactNo: '+1234567890',
  supportMail: 'support@cryptodex.exchange',
  facebookLink: 'https://facebook.com/cryptodex',
  facebookIcon: '',
  twitterIcon: '',
  twitterUrl: 'https://twitter.com/cryptodex',
  linkedinIcon: '',
  telegramLink: 'https://t.me/cryptodex',
  instaLink: 'https://instagram.com/cryptodex',
  sitelogo: '',
  emailLogo: 'logo.png',
  bannerImg1: '',
  bannerImg2: '',
  bannerImg3: '',
  bannerImg4: '',
  binanceDeposit: { startTime: 0, endTime: 0, offest: 0, limit: 500 },
  userDashboard: [],
};

/* ------------------------------------------------------------------ *
 * SUPPORT SUBJECTS  ->  <prefix>_user.supportcategory
 * ------------------------------------------------------------------ *
 *
 * Copied from cryptodex-userapi/scripts/
 * seed-support-categories.js, which explains why this matters: the subject on
 * /support-ticket is required and its dropdown is fed by this collection, so
 * an empty collection means no ticket can be raised at all.
 *
 * REPRODUCED VERBATIM ON PURPOSE: silently rewriting product copy is not the
 * reset's call. Nothing seeds this list any more - support tickets were removed
 * from the product and `reset-and-seed.mjs` no longer writes the collection.
 */
export const SUPPORT_CATEGORIES = [
  'Account and Login',
  'Deposit and Withdrawal',
  'Spot Trading',
  'Identity Verification',
  'Security and Two Factor',
  'Bug Report',
  'Other',
];

/* ------------------------------------------------------------------ *
 * FAQ  ->  <prefix>_user.faqcategory + <prefix>_user.faq
 * ------------------------------------------------------------------ *
 *
 * pages/faq.tsx calls GET /api/user/faq unconditionally. Both collections are
 * EMPTY on the live venue, so /faq renders an empty page today - seeding it is
 * a fix, not a reproduction. The copy is deliberately about this product (a
 * simulator that holds no money) rather than exchange boilerplate.
 */
export const FAQ_CATEGORIES = [{ key: 'general', name: 'Getting Started' }];

export const FAQS = [
  {
    category: 'general',
    question: 'Is any of this real money?',
    answer:
      'No. Cryptodex is a paper-trading simulator. Every balance, order, trade and fee is virtual. No real money and no real cryptocurrency is ever deposited, held, transferred or withdrawn.',
  },
  {
    category: 'general',
    question: 'Where do my starting funds come from?',
    answer:
      'A new account is credited with demo USD automatically at registration. You can top up again from the faucet on the wallet page once every 24 hours.',
  },
  {
    category: 'general',
    question: 'Which markets can I trade?',
    answer:
      'BTC/USD, with market and limit orders on both sides. Prices and order-book depth follow the real market, so fills behave realistically.',
  },
  {
    category: 'general',
    question: 'Why was my order not filled?',
    answer:
      'A limit order only fills when the market reaches your price. If the order book looks empty, the upstream price feed may be reconnecting - the order book shows a stale-feed badge while that is happening.',
  },
];

/* ------------------------------------------------------------------ *
 * CMS  ->  <prefix>_user.cms
 * ------------------------------------------------------------------ *
 *
 * NOT REQUIRED BY THE TRADING FRONTEND, and this is worth stating plainly
 * because the opposite is easy to assume. `getCMSPage`, `getHomeContent` and
 * `getCMSPageConent` are exported from services/common.service.ts and called
 * by NOTHING under pages/, components/, store/ or hooks/. The legal pages that
 * used to be the argument for this - pages/terms.tsx and pages/privacy-policy.tsx
 * kept their copy in the repository so stale CMS text could never reach a consent
 * screen - are themselves deleted now, along with the footer that linked them: a
 * paper venue that issues virtual balances and pays nothing out has no terms to
 * state. That removes the last thing anyone might have expected `cms` to feed.
 * It is empty on the live venue and no frontend page is blank because of it.
 *
 * These rows are kept so the identifiers exist if the owner ever wires them up;
 * `reset-and-seed.mjs` no longer writes the collection. The content is honest
 * about the product rather than placeholder lorem.
 */
export const CMS_PAGES = [
  {
    identifier: 'terms',
    title: 'Terms of Service',
    content:
      '<p>Cryptodex is a paper-trading simulator. Every balance, order, trade, position, fee and profit or loss is virtual. No real money and no real cryptocurrency is ever deposited, held, transferred, withdrawn or paid out.</p><p>The authoritative copy of these terms is served by the application itself at /terms and is defined in the frontend repository, not from this record.</p>',
  },
  {
    identifier: 'privacy',
    title: 'Privacy Policy',
    content:
      '<p>Cryptodex collects an e-mail address, login security data and your simulated trading activity. It collects no identity documents and no payment data, because it holds no money and custodies nothing.</p><p>The authoritative copy of this policy is served by the application itself at /privacy-policy and is defined in the frontend repository, not from this record.</p>',
  },
  {
    identifier: 'about',
    title: 'About Cryptodex',
    content:
      '<p>Cryptodex is a spot paper-trading venue. It quotes BTC/USD against real market depth and settles every fill against a virtual ledger.</p>',
  },
];

/* ------------------------------------------------------------------ *
 * ORDER-CODE SEQUENCE  ->  <prefix>_spot.sequenceId
 * ------------------------------------------------------------------ *
 *
 * getSequenceId('orderHistory') stamps every order's human-facing orderCode.
 * It upserts, so an absent row self-heals - but it would restart the venue's
 * order numbering at a value that collides with nothing, which is fine, and
 * seeding it makes the starting number a decision rather than an accident.
 */
export const SEQUENCE_SEED = { type: 'orderHistory', lastIndex: 100000000000 };

/* The three databases a spot-only Cryptodex venue owns. */
export const DATABASES = ['user', 'wallet', 'spot'];
