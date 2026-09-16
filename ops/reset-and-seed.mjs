#!/usr/bin/env node
/**
 * CRYPTODEX - RESET AND SEED. One command, from nothing to a venue that trades.
 * ===========================================================================
 *
 *   node ops/reset-and-seed.mjs --help
 *   node ops/reset-and-seed.mjs                       # seed / repair, never destroys
 *   node ops/reset-and-seed.mjs --verify              # read-only audit, exit 1 on gaps
 *   node ops/reset-and-seed.mjs --reset --confirm cryptodex   # wipe, then rebuild
 *
 * WHAT PROBLEM THIS SOLVES
 * ------------------------
 * A full reset of this venue was authorised, and there was no working path to
 * rebuild it afterwards. The pieces existed in three places and none of them
 * covered the one that matters most:
 *
 *   createSpotPairs.js          quotes in USDT; this venue quotes in USD
 *   scripts/seed-pairs.js       WIPES currencies and pairs and replaces them
 *                               with 20 coins and 22 USDT pairs - running it
 *                               on this venue destroys it (see README)
 *   seed-email-templates.js     hardcodes the live database URI
 *
 * (Two more scripts that were on this list have since been deleted from the
 * tree. The currency rows this file seeds were recovered from git 375de7c,
 * where one of them lived.)
 *
 * and NOTHING AT ALL seeded redis `admin_liquidity/liquidation`, without which
 * paperBook refuses to build a ladder and not one order can fill. That entry
 * was created by hand in January and has survived only because redis has not
 * been flushed. It is the single point of failure this script exists for.
 *
 * IDEMPOTENT. Every write is an upsert keyed on a pinned _id or a natural key.
 * Running it twice changes nothing the second time; running it against a
 * half-built venue fills in only what is missing. The one destructive path is
 * `--reset`, which is opt-in twice over (`--reset` AND `--confirm <prefix>`).
 *
 * TARGETS ANY VENUE, WHICH IS HOW IT WAS TESTED. `--db-prefix`,
 * `--redis-prefix` and `--redis-db` select the target, so the whole thing can
 * be exercised end to end against scratch databases without going anywhere
 * near live data. `--verify` runs read-only and can therefore be pointed at
 * the live venue to compare the two.
 *
 * WHAT IT DOES NOT DO. It does not start, stop or restart any service, and it
 * does not touch a user balance except through the seeded accounts it creates
 * itself. Ordinary user wallets are not its job: walletapi's
 * controllers/createAsset.js builds them at registration, including the demo
 * USDC/USD seed.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';
import { promisify } from 'util';

import { templates as EMAIL_TEMPLATES } from './seed/email-templates.mjs';
import {
  CURRENCIES,
  CURRENCY_ID,
  SPOT_PAIRS,
  LIQUIDITY_BOT,
  priceConversionRows,
  SITE_SETTING,
  SUPPORT_CATEGORIES,
  FAQ_CATEGORIES,
  FAQS,
  CMS_PAGES,
  SEQUENCE_SEED,
  DATABASES,
} from './seed/venue-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

/**
 * mongodb and redis are not installed at the repository root - only inside the
 * services. Resolving them from userapi (mongodb 7.0.0, redis 3.1.2) keeps this
 * script dependency-free in its own right and guarantees it uses the same
 * driver versions the product is already running against. (bcrypt was resolved
 * here too, for a password hash this script no longer needs to produce.)
 */
const serviceRequire = createRequire(
  path.join(REPO_ROOT, 'cryptodex-userapi', 'package.json')
);
const { MongoClient, ObjectId } = serviceRequire('mongodb');
const redisLib = serviceRequire('redis');

/* ================================================================== *
 * ARGUMENTS
 * ================================================================== */

const DEFAULTS = {
  mongoUri: 'mongodb://127.0.0.1:27017',
  dbPrefix: 'cryptodex',
  redisUrl: 'redis://127.0.0.1:6379',
  redisPrefix: 'cryptodex_',
  redisDb: 0,
  // THE THREE `admin*` DEFAULTS THAT WERE HERE ARE GONE, along with their
  // flags and their help text. They fed an `admin` document this seed no
  // longer writes. The flags survived that change and did NOTHING -
  // `--admin-password hunter2` parsed cleanly, printed nothing and created
  // nothing. An option that is accepted and ignored is worse than one that is
  // rejected: it tells the operator a credential was set.
};

const parseArgs = (argv) => {
  const opts = { ...DEFAULTS, reset: false, confirm: null, verify: false, help: false };
  const map = {
    '--mongo-uri': 'mongoUri',
    '--db-prefix': 'dbPrefix',
    '--redis-url': 'redisUrl',
    '--redis-prefix': 'redisPrefix',
    '--redis-db': 'redisDb',
    '--confirm': 'confirm',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--reset') { opts.reset = true; continue; }
    if (arg === '--verify' || arg === '--verify-only') { opts.verify = true; continue; }
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    const key = map[arg];
    if (!key) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    opts[key] = key === 'redisDb' ? Number(value) : value;
  }
  if (!Number.isInteger(opts.redisDb) || opts.redisDb < 0 || opts.redisDb > 15) {
    throw new Error('--redis-db must be an integer 0-15');
  }
  return opts;
};

const HELP = `
Cryptodex reset-and-seed - rebuild a spot-only paper-trading venue from nothing.

  node ops/reset-and-seed.mjs [options]

  (no flags)              Seed or repair. Idempotent, never destroys anything.
  --verify                Read-only audit of the target. Exit 1 if incomplete.
  --reset --confirm <p>   DESTRUCTIVE. Drops <p>_user, <p>_wallet, <p>_spot and
                          deletes every redis key under the redis prefix in the
                          selected redis db, then rebuilds. <p> must equal the
                          value of --db-prefix, typed out, or nothing happens.

  --mongo-uri <uri>       default ${DEFAULTS.mongoUri}
  --db-prefix <name>      default ${DEFAULTS.dbPrefix}   -> <name>_user/_wallet/_spot
  --redis-url <url>       default ${DEFAULTS.redisUrl}
  --redis-prefix <str>    default ${DEFAULTS.redisPrefix}
  --redis-db <0-15>       default ${DEFAULTS.redisDb}

Examples
  # rehearse the whole thing on scratch databases, touching nothing live
  node ops/reset-and-seed.mjs --reset --confirm resettest \\
       --db-prefix resettest --redis-prefix resettest_ --redis-db 9

  # audit the live venue without writing to it
  node ops/reset-and-seed.mjs --verify
`;

/* ================================================================== *
 * OUTPUT
 * ================================================================== */

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const tally = { created: 0, updated: 0, unchanged: 0 };
const heading = (s) => console.log(`\n${C.bold}${C.cyan}${s}${C.reset}`);
const note = (s) => console.log(`  ${C.dim}${s}${C.reset}`);
const warn = (s) => console.log(`  ${C.yellow}!${C.reset} ${s}`);
const fail = (s) => console.log(`  ${C.red}x${C.reset} ${s}`);
const report = (verb, what) => {
  tally[verb]++;
  const mark = verb === 'created' ? `${C.green}+${C.reset}`
    : verb === 'updated' ? `${C.yellow}~${C.reset}`
      : `${C.dim}={C.reset}`.replace('{C.reset}', C.reset);
  console.log(`  ${mark} ${what}`);
};

/* ================================================================== *
 * REDIS - thin promisified wrapper over redis@3, using the SAME key
 * composition the services use (config.REDIS_PREFIX + key, values
 * JSON.stringify'd into a hash field). See each service's
 * controllers/redis.controller.js.
 * ================================================================== */

const openRedis = async ({ redisUrl, redisDb }) => {
  const client = redisLib.createClient({ url: redisUrl });
  const ready = new Promise((resolve, reject) => {
    client.on('ready', resolve);
    client.on('error', reject);
  });
  await ready;
  const call = (name) => promisify(client[name]).bind(client);
  const select = call('select');
  await select(redisDb);
  return {
    raw: client,
    hset: call('hset'),
    hget: call('hget'),
    // hdel was missing while the stale-cache branch below already called it
    // (`redis.hdel(spotPairdata, id)` when a cached pair id has no mongo row).
    // That path threw `redis.hdel is not a function`, was swallowed by the outer
    // try/catch, and failed the whole seed with exit 1 - reachable on any venue
    // whose pair list had shrunk since the last seed.
    hdel: call('hdel'),
    hkeys: call('hkeys'),
    hlen: call('hlen'),
    keys: call('keys'),
    del: call('del'),
    exists: call('exists'),
    quit: () => new Promise((r) => client.quit(r)),
  };
};

/* ================================================================== *
 * PASSWORDS
 * ================================================================== */

/**
 * Reproduces UserSchema's `password` virtual byte for byte
 * (cryptodex-userapi/models/user.js): a 16-byte base64
 * salt, then pbkdf2 sha512, 100000 iterations, 128 bytes, base64. The pre-save
 * hook rejects a user document whose `hash` is empty, so a bot account written
 * without these two fields would be rejected the first time any code path
 * loaded and saved it.
 */
const makeUserCredentials = (password) => {
  const salt = crypto.randomBytes(16).toString('base64');
  const hash = crypto
    .pbkdf2Sync(password, Buffer.from(salt, 'base64'), 100000, 128, 'sha512')
    .toString('base64');
  return { salt, hash };
};

// `makeAdminHash` (bcrypt, for the `admin` collection) and `generatePassword`
// were the last two users of bcrypt in this file. Both are gone: nothing here
// writes an `admin` document any more, so nothing needs a bcrypt hash or a
// password to put in it.

/* ================================================================== *
 * MONGO HELPERS
 * ================================================================== */

const now = () => new Date();

/**
 * Upsert on a pinned _id, reporting created/updated/unchanged honestly rather
 * than claiming a write that did not happen.
 */
const upsertById = async (coll, id, doc, label) => {
  const _id = new ObjectId(id);
  const existing = await coll.findOne({ _id });
  if (!existing) {
    await coll.insertOne({ _id, ...doc, createdAt: now(), updatedAt: now() });
    report('created', label);
    return 'created';
  }
  const drift = Object.keys(doc).filter(
    (k) => JSON.stringify(existing[k]) !== JSON.stringify(doc[k])
  );
  if (drift.length === 0) { report('unchanged', label); return 'unchanged'; }
  await coll.updateOne({ _id }, { $set: { ...doc, updatedAt: now() } });
  report('updated', `${label} ${C.dim}(${drift.join(', ')})${C.reset}`);
  return 'updated';
};

/** Upsert on a natural key, for rows whose _id is not worth pinning. */
const upsertByKey = async (coll, filter, doc, label) => {
  const existing = await coll.findOne(filter);
  if (!existing) {
    await coll.insertOne({ ...filter, ...doc, createdAt: now(), updatedAt: now() });
    report('created', label);
    return 'created';
  }
  const drift = Object.keys(doc).filter(
    (k) => JSON.stringify(existing[k]) !== JSON.stringify(doc[k])
  );
  if (drift.length === 0) { report('unchanged', label); return 'unchanged'; }
  await coll.updateOne(filter, { $set: { ...doc, updatedAt: now() } });
  report('updated', `${label} ${C.dim}(${drift.join(', ')})${C.reset}`);
  return 'updated';
};

/* ================================================================== *
 * TEARDOWN
 * ================================================================== */

const teardown = async (mongo, redis, opts) => {
  heading('TEARDOWN');
  for (const suffix of DATABASES) {
    const name = `${opts.dbPrefix}_${suffix}`;
    await mongo.db(name).dropDatabase();
    console.log(`  ${C.red}-${C.reset} dropped mongo database ${name}`);
  }
  const keys = await redis.keys(`${opts.redisPrefix}*`);
  if (keys.length) {
    // Chunked: DEL with tens of thousands of arguments is a needless risk.
    for (let i = 0; i < keys.length; i += 500) await redis.del(keys.slice(i, i + 500));
  }
  console.log(
    `  ${C.red}-${C.reset} deleted ${keys.length} redis key(s) matching ` +
    `${opts.redisPrefix}* in db ${opts.redisDb}`
  );
};

/* ================================================================== *
 * SEED
 * ================================================================== */

const seed = async (mongo, redis, opts) => {
  const userDb = mongo.db(`${opts.dbPrefix}_user`);
  const walletDb = mongo.db(`${opts.dbPrefix}_wallet`);
  const spotDb = mongo.db(`${opts.dbPrefix}_spot`);

  /* ---- currencies ------------------------------------------------ */
  heading('CURRENCIES  ->  ' + walletDb.databaseName + '.currency');
  note('the collection BOTH walletapi and spotapi bind to by explicit name');
  for (const c of CURRENCIES) {
    const { _id, ...rest } = c;
    await upsertById(walletDb.collection('currency'), _id, rest, `${c.coin} (${c.type})`);
  }

  /* ---- price conversion ------------------------------------------ */
  heading('PRICE CONVERSION  ->  ' + walletDb.databaseName + '.priceconversion');
  note('one row per ordered pair of distinct currencies; the walletapi cron fills the prices in');
  let convNew = 0, convOld = 0;
  for (const row of priceConversionRows()) {
    const { baseSymbol, convertSymbol, ...rest } = row;
    const existing = await walletDb
      .collection('priceconversion')
      .findOne({ baseSymbol, convertSymbol });
    if (existing) { convOld++; continue; }
    await walletDb
      .collection('priceconversion')
      .insertOne({ baseSymbol, convertSymbol, ...rest, createdAt: now(), updatedAt: now(), __v: 0 });
    convNew++;
  }
  if (convNew) report('created', `${convNew} conversion row(s)`);
  if (convOld) report('unchanged', `${convOld} conversion row(s) already present`);

  /* ---- spot pairs ------------------------------------------------ */
  heading('SPOT PAIRS  ->  ' + spotDb.databaseName + '.spotpair');
  note("botstatus 'binance' + quote 'USD' is what selects the upstream <BASE>USDT depth stream");
  for (const p of SPOT_PAIRS) {
    const { _id, coldStartPrice, firstCurrencyId, secondCurrencyId, ...rest } = p;
    const doc = {
      ...rest,
      firstCurrencyId: new ObjectId(firstCurrencyId),
      secondCurrencyId: new ObjectId(secondCurrencyId),
    };
    const existing = await spotDb.collection('spotpair').findOne({ _id: new ObjectId(_id) });
    if (!existing) {
      // Cold-start prices only on first insert: overwriting a live price with
      // a stale literal on a re-run would put a wrong number in front of users
      // until the next binance tick.
      Object.assign(doc, {
        markPrice: coldStartPrice,
        prevMarkPrice: coldStartPrice,
        last: coldStartPrice,
        low: coldStartPrice,
        high: coldStartPrice,
        last_bid: coldStartPrice,
        last_ask: coldStartPrice,
        change: 0,
        changePrice: 0,
        firstVolume: 0,
        secondVolume: 0,
      });
    }
    await upsertById(spotDb.collection('spotpair'), _id, doc, `${p.tikerRoot} (${p.pairName})`);
  }

  /* ---- delist anything this venue no longer declares -------------- */
  //
  // WITHOUT THIS THE SEED CANNOT CONVERGE AN EXISTING VENUE. It upserts the
  // pairs it declares and said nothing about the rest, so a database seeded when
  // the venue listed ETH and SOL kept serving them: loadPairsToRedis reads
  // SpotPair.find({}) on every boot, so those rows are re-cached, the matcher's
  // active-pair query picks them up, a depth stream is opened for each and users
  // can still land on and trade a market the venue no longer claims to list.
  //
  // status, NOT delete. Both gates that matter read it - paperBook builds no
  // ladder unless `status === "active"`, and spot.controller's pair sweep queries
  // {status:'active'} - so flipping it withdraws the market while leaving the row
  // (and every order and trade that references it) intact and readable. Dropping
  // rows is what --reset is for, and it asks first.
  const declaredIds = SPOT_PAIRS.map((p) => new ObjectId(p._id));
  const undeclared = await spotDb
    .collection('spotpair')
    .find({ _id: { $nin: declaredIds }, status: 'active' })
    .toArray();
  if (undeclared.length) {
    const { modifiedCount } = await spotDb.collection('spotpair').updateMany(
      { _id: { $nin: declaredIds }, status: 'active' },
      { $set: { status: 'delisted' } }
    );
    for (const row of undeclared) {
      console.log(
        `  ${C.red}-${C.reset} delisted ${row.tikerRoot || row._id} ` +
        `(no longer declared; row kept, market withdrawn)`
      );
    }
    if (modifiedCount !== undeclared.length) {
      console.log(`  ${C.red}!${C.reset} expected to delist ${undeclared.length}, modified ${modifiedCount}`);
    }
  }

  /* ---- order-code sequence --------------------------------------- */
  heading('ORDER SEQUENCE  ->  ' + spotDb.databaseName + '.sequenceId');
  await upsertByKey(
    spotDb.collection('sequenceId'),
    { type: SEQUENCE_SEED.type },
    { lastIndex: SEQUENCE_SEED.lastIndex },
    `${SEQUENCE_SEED.type} starts at ${SEQUENCE_SEED.lastIndex}`
  );

  /* ---- site setting / templates / content ------------------------ */
  heading('SITE SETTING  ->  ' + userDb.databaseName + '.sitesetting');
  note('fetched on every frontend page load by components/HelperRoute.tsx');
  {
    const { _id, ...rest } = SITE_SETTING;
    await upsertById(userDb.collection('sitesetting'), _id, { ...rest, __v: 0 }, rest.siteName);
  }

  heading('EMAIL TEMPLATES  ->  ' + userDb.databaseName + '.emailtemplate');
  note('activate_register_user is the registration -> activation link');
  for (const t of EMAIL_TEMPLATES) {
    await upsertByKey(
      userDb.collection('emailtemplate'),
      { identifier: t.identifier, langCode: t.langCode },
      { subject: t.subject, content: t.content, status: t.status },
      `${t.identifier} (${t.langCode})`
    );
  }

  /* ---- support subjects, FAQ, CMS pages and the `admin` document ------
   *
   * ALL FOUR ARE GONE, and seeding them would rebuild surfaces the product no
   * longer has:
   *
   *   supportcategory   the /support-ticket subject dropdown. Support tickets,
   *                     FAQ, announcements, CMS pages, the newsletter and the
   *                     contact form were removed from userapi; nothing serves
   *                     or renders any of it.
   *   faqcategory/faq   pages/faq.tsx is deleted.
   *   cms               the frontend never read this collection, and
   *                     /privacy-policy and /terms are deleted outright - both
   *                     now redirect to "/".
   *   admin             a privileged login with nothing left to log into, and
   *                     a seeded credential nobody uses is a liability rather
   *                     than a convenience.
   *
   * `--verify` no longer looks for them either. Left in place on an existing
   * venue rather than deleted here: `--reset` clears the databases wholesale,
   * and a seed script is not the right place to drop collections behind an
   * operator's back.
   */

  /* ---- the liquidity bot ----------------------------------------- */
  heading('LIQUIDITY BOT  ->  ' + userDb.databaseName + '.user + redis admin_liquidity');
  note('SPOT CANNOT FILL A SINGLE ORDER WITHOUT THIS. Nothing else in the product creates it.');
  {
    const botId = new ObjectId(LIQUIDITY_BOT._id);
    const existing = await userDb.collection('user').findOne({ _id: botId });
    if (!existing) {
      const { salt, hash } = makeUserCredentials(crypto.randomBytes(24).toString('hex'));
      await userDb.collection('user').insertOne({
        _id: botId,
        profileImage: '', firstName: LIQUIDITY_BOT.firstName, lastName: LIQUIDITY_BOT.lastName,
        email: LIQUIDITY_BOT.email, phoneCode: '', phoneNo: '', walletaddress: '',
        otp: '', otptime: null, phoneOTP: '', phoneOTPtime: null,
        emailOTP: '', emailOTPtime: null, newEmail: '', requestType: '',
        newEmailToken: '', newPhone: { phoneCode: '', phoneNo: '' },
        // A random, unrecorded password. The bot never authenticates - it has
        // no session and no route - but the user pre-save hook rejects a
        // document with an empty hash, so it needs credentials that exist and
        // that nobody holds.
        hash, salt,
        blockNo: '', address: '', city: '', state: '', country: '', postalCode: '',
        google2Fa: { secret: '', uri: '' },
        emailStatus: 'unverified', phoneStatus: 'unverified', type: 'basic_pending',
        mailToken: '', conFirmMailToken: '', refferalCode: '', refferedBy: '',
        status: 'unverified', updatedAt: null, userLocked: 'false', userIp: '',
        antiphishingcode: '', antiphishingStatus: false,
        role: LIQUIDITY_BOT.role,
        assetPassword: '', assetPasswordStatus: false, isBlock: false,
        login_attempt: 0, changepassword: false, percentage: 0,
        feeManagement: [], isAff: false, bankDetails: [], upiDetails: [], qrDetails: [],
        createdAt: now(), userId: LIQUIDITY_BOT.userId, __v: 0,
      });
      report('created', `${LIQUIDITY_BOT.email} role=${LIQUIDITY_BOT.role} _id=${LIQUIDITY_BOT._id}`);
    } else if (existing.role !== LIQUIDITY_BOT.role) {
      await userDb.collection('user').updateOne({ _id: botId }, { $set: { role: LIQUIDITY_BOT.role } });
      report('updated', `${LIQUIDITY_BOT.email} role -> ${LIQUIDITY_BOT.role}`);
    } else {
      report('unchanged', `${LIQUIDITY_BOT.email} role=${LIQUIDITY_BOT.role}`);
    }

    // Default settings row, exactly as auth.controller.js defaultUserSetting
    // does it: _id === userId.
    await upsertById(
      userDb.collection('usersetting'),
      LIQUIDITY_BOT._id,
      { userId: botId, currencySymbol: 'USD', theme: 'dark', __v: 0 },
      'usersetting for the bot'
    );

    // A wallet document, which the live venue's bot does NOT have - it was
    // created by hand before walletapi's newAsset() existed in this form.
    // Seeding it costs nothing. Balances are ZERO on purpose: the paper
    // ladder's orders carry isPaper:true and are never debited
    // (paperBook.controller.js says so where it refuses to route a synthetic
    // through cancelOrder), so the house does not need funding to quote.
    //
    // KEEP THIS FIELD LIST EQUAL TO walletapi's models/wallet.js, AND KNOW
    // THAT NOTHING ENFORCES IT. This script writes through the RAW mongo
    // driver, which applies no schema, while every real user's wallet is
    // built by mongoose (walletapi controllers/createAsset.js `emptyAsset`
    // -> `.save()`) and therefore carries only the paths the schema declares.
    // A name kept here that the schema no longer declares becomes a field the
    // seeded bot has and no other wallet in the database does - which is how
    // this list went on writing seven balance fields for products that had
    // already been deleted from the schema.
    const walletAssets = CURRENCIES.map((c) => ({
      _id: new ObjectId(c._id), currencyId: new ObjectId(c._id), coin: c.coin,
      address: '', destTag: '', privateKey: '',
      spotBal: 0, spotLockedBal: 0, spotInOrder: 0,
      erc20BlockNo: 0, beb20BlockNo: 0, trx20BlockNo: 0, poly20BlockNo: 0,
      p2pBal: 0, tokenAddressArray: [], blockNo: 0,
    }));
    await upsertById(
      walletDb.collection('wallet'),
      LIQUIDITY_BOT._id,
      { userCode: LIQUIDITY_BOT.userId, binSubAcctId: '', assets: walletAssets, __v: 0 },
      'wallet for the bot (5 assets, zero balances)'
    );
  }

  /* ---- redis ------------------------------------------------------ */
  heading(`REDIS  ->  db ${opts.redisDb}, prefix ${opts.redisPrefix}`);

  // THE ONE THAT MATTERS. Written in the exact shape userapi's grpc botUser()
  // writes: the projected lean document plus mongoose's `id` virtual.
  const liqValue = {
    _id: LIQUIDITY_BOT._id,
    firstName: LIQUIDITY_BOT.firstName,
    lastName: LIQUIDITY_BOT.lastName,
    email: LIQUIDITY_BOT.email,
    role: LIQUIDITY_BOT.role,
    userId: LIQUIDITY_BOT.userId,
    id: LIQUIDITY_BOT._id,
  };
  // Every redis write below goes through this, so that a re-run reports
  // "already correct" instead of claiming a creation that was really an
  // overwrite with identical bytes. A seed script that overstates what it did
  // is a seed script you cannot use to diagnose anything.
  const hsetReporting = async (key, field, value, label) => {
    const encoded = JSON.stringify(value);
    const before = await redis.hget(`${opts.redisPrefix}${key}`, field);
    if (before === encoded) { report('unchanged', label); return 'unchanged'; }
    await redis.hset(`${opts.redisPrefix}${key}`, field, encoded);
    report(before ? 'updated' : 'created', label);
    return before ? 'updated' : 'created';
  };

  await hsetReporting(
    'admin_liquidity', 'liquidation', liqValue,
    `admin_liquidity/liquidation -> ${LIQUIDITY_BOT.email}`
  );

  // spotPairdata. spotapi rebuilds this from mongo on boot
  // (controllers/loadPairs.js, called from server.js), so this is a warm start
  // rather than a requirement - but it means the market list is correct from
  // the first request instead of from the first boot.
  for (const p of SPOT_PAIRS) {
    const doc = await spotDb.collection('spotpair').findOne({ _id: new ObjectId(p._id) });
    if (!doc) { fail(`spotPairdata ${p.tikerRoot}: pair missing from mongo`); continue; }
    const value = {
      ...doc,
      _id: String(doc._id),
      firstCurrencyId: String(doc.firstCurrencyId),
      secondCurrencyId: String(doc.secondCurrencyId),
      firstCurrencyImage: '',
      secondCurrencyImage: '',
    };
    await hsetReporting('spotPairdata', p._id, value, `spotPairdata/${p.tikerRoot}`);
  }

  // ...AND THE CACHE ENTRIES FOR PAIRS THIS VENUE NO LONGER DECLARES.
  //
  // Delisting in mongo alone does not withdraw a market. getPairList prefers
  // this hash over mongo and filters it with getActivePairs, which reads the
  // status out of the CACHED json - so a pair delisted above went on being
  // served as active from a stale cache entry until spotapi next restarted and
  // loadPairsToRedis refreshed it. Measured exactly that: mongo said delisted,
  // redis still said active, and /spot still redirected to the delisted market.
  // Re-mirroring the row here makes the delist take effect immediately, on a
  // running stack, which is the only way it is any use to an operator.
  const cachedPairIds = await redis.hkeys(`${opts.redisPrefix}spotPairdata`);
  const declaredPairIds = new Set(SPOT_PAIRS.map((p) => p._id));
  for (const id of cachedPairIds) {
    if (declaredPairIds.has(id)) continue;
    const doc = await spotDb.collection('spotpair').findOne({ _id: new ObjectId(id) });
    if (!doc) {
      // The row is gone entirely; the cache must not outlive it.
      await redis.hdel(`${opts.redisPrefix}spotPairdata`, id);
      report('updated', `spotPairdata/${id} removed (no mongo row)`);
      continue;
    }
    await hsetReporting(
      'spotPairdata', id,
      {
        ...doc,
        _id: String(doc._id),
        firstCurrencyId: String(doc.firstCurrencyId),
        secondCurrencyId: String(doc.secondCurrencyId),
        firstCurrencyImage: '',
      },
      `spotPairdata/${doc.tikerRoot} -> ${doc.status}`
    );
  }

  // `currecny` - spelling is the product's, not a typo here. walletapi
  // currency.controller.js currencyUpdateRedis() rebuilds it at module load,
  // so this too is a warm start. spotapi's fee path reads it.
  for (const c of CURRENCIES) {
    const doc = await walletDb.collection('currency').findOne({ _id: new ObjectId(c._id) });
    await hsetReporting('currecny', c._id, { ...doc, _id: String(doc._id) }, `currecny/${c.coin}`);
  }

  // priceCnv, in the shape the walletapi cron writes
  // ({baseSymbol, convertSymbol, convertPrice}). Zeroed until the first tick.
  // Written only when the field is ABSENT: the walletapi cron owns this hash
  // once the stack is up, and re-stamping a live conversion price back to zero
  // would be this script corrupting data it only meant to bootstrap.
  let cnvNew = 0, cnvKept = 0;
  for (const row of priceConversionRows()) {
    const field = row.baseSymbol + row.convertSymbol;
    if (await redis.hget(`${opts.redisPrefix}priceCnv`, field)) { cnvKept++; continue; }
    await redis.hset(
      `${opts.redisPrefix}priceCnv`, field,
      JSON.stringify({
        baseSymbol: row.baseSymbol, convertSymbol: row.convertSymbol, convertPrice: '0',
      })
    );
    cnvNew++;
  }
  if (cnvNew) report('created', `priceCnv (${cnvNew} conversion(s) bootstrapped at 0)`);
  if (cnvKept) report('unchanged', `priceCnv (${cnvKept} conversion(s) already priced)`);
};

/* ================================================================== *
 * VERIFY - read-only, and deliberately checks SHAPE rather than mere
 * presence, because "the key exists" is not the same claim as "the
 * engine can use it".
 * ================================================================== */

const verify = async (mongo, redis, opts) => {
  heading('VERIFY');
  const userDb = mongo.db(`${opts.dbPrefix}_user`);
  const walletDb = mongo.db(`${opts.dbPrefix}_wallet`);
  const spotDb = mongo.db(`${opts.dbPrefix}_spot`);
  const problems = [];
  const ok = (s) => console.log(`  ${C.green}v${C.reset} ${s}`);
  const bad = (s) => { problems.push(s); fail(s); };

  /* currencies */
  const currencies = await walletDb.collection('currency').find({}).toArray();
  const coins = currencies.map((c) => c.coin).sort();
  const wanted = CURRENCIES.map((c) => c.coin).sort();
  if (JSON.stringify(coins) === JSON.stringify(wanted)) {
    ok(`currency: ${coins.join(', ')}`);
  } else {
    bad(`currency: expected [${wanted.join(', ')}] got [${coins.join(', ')}]`);
  }
  for (const c of currencies) {
    if (c.status !== 'active') bad(`currency ${c.coin} status=${c.status}, must be active`);
  }

  /* spot pairs, and the referential integrity that actually matters */
  const pairs = await spotDb.collection('spotpair').find({}).toArray();
  // NOT a row-count equality. A venue that once listed more markets keeps those
  // rows (seed delists them rather than deleting them - see above), and every
  // order and trade ever placed against them still points at them. The invariant
  // is not "there are exactly N rows", it is "every declared pair is ACTIVE and
  // nothing undeclared is". Counting rows reported a false failure, and exited 1,
  // on every database that predated the venue becoming single-market.
  const declared = new Set(SPOT_PAIRS.map((p) => p._id));
  const strayActive = pairs.filter(
    (p) => !declared.has(String(p._id)) && p.status === 'active'
  );
  for (const stray of strayActive) {
    bad(
      `spotpair ${stray.tikerRoot || stray._id}: still active but not declared ` +
      `- run the seed to delist it`
    );
  }
  for (const want of SPOT_PAIRS) {
    const got = pairs.find((p) => String(p._id) === want._id);
    if (!got) { bad(`spotpair ${want.tikerRoot}: missing (_id ${want._id})`); continue; }
    const base = currencies.find((c) => String(c._id) === String(got.firstCurrencyId));
    const quote = currencies.find((c) => String(c._id) === String(got.secondCurrencyId));
    if (!base) bad(`spotpair ${want.tikerRoot}: firstCurrencyId points at no currency row`);
    if (!quote) bad(`spotpair ${want.tikerRoot}: secondCurrencyId points at no currency row`);
    if (got.status !== 'active') bad(`spotpair ${want.tikerRoot}: status=${got.status}`);
    if (got.botstatus !== 'binance') {
      bad(`spotpair ${want.tikerRoot}: botstatus=${got.botstatus}, the depth feed only picks up 'binance'`);
    }
    if (got.secondCurrencySymbol !== 'USD') {
      bad(`spotpair ${want.tikerRoot}: quote is ${got.secondCurrencySymbol}; the binance symbol rule needs USD`);
    }
    if (base && quote) ok(`spotpair ${want.tikerRoot}: ${base.coin}/${quote.coin} active, feed=binance`);
  }

  /* the liquidity bot, mongo side */
  const bot = await userDb.collection('user').findOne({ role: 'admin_bot' });
  if (!bot) bad('user: no account with role admin_bot - the paper ladder has no owner');
  else ok(`user: liquidity bot ${bot.email} _id=${bot._id}`);

  /* the liquidity bot, redis side - the single point of failure */
  const rawLiq = await redis.hget(`${opts.redisPrefix}admin_liquidity`, 'liquidation');
  if (!rawLiq) {
    bad('redis admin_liquidity/liquidation: MISSING - paperBook drops every ladder ("no_admin_liquidity") and no order can fill');
  } else {
    let parsed = null;
    try { parsed = JSON.parse(rawLiq); } catch { /* handled below */ }
    if (!parsed || !parsed._id) {
      bad('redis admin_liquidity/liquidation: present but has no _id - paperBook treats that as missing');
    } else if (bot && String(bot._id) !== String(parsed._id)) {
      bad(`redis admin_liquidity/liquidation: _id ${parsed._id} does not match the admin_bot user ${bot._id}`);
    } else if (!parsed.userId) {
      bad('redis admin_liquidity/liquidation: no userId - synthetic orders would carry an empty userCode');
    } else {
      ok(`redis admin_liquidity/liquidation: ${parsed.email} _id=${parsed._id} userId=${parsed.userId}`);
    }
  }

  /* redis caches */
  const pairHash = await redis.hkeys(`${opts.redisPrefix}spotPairdata`);
  const missingPair = SPOT_PAIRS.filter((p) => !pairHash.includes(p._id));
  if (missingPair.length) {
    warn(`redis spotPairdata: missing ${missingPair.map((p) => p.tikerRoot).join(', ')} (spotapi rebuilds this on boot)`);
  } else ok(`redis spotPairdata: ${pairHash.length} pair(s)`);

  const curHash = await redis.hkeys(`${opts.redisPrefix}currecny`);
  if (curHash.length < CURRENCIES.length) {
    warn(`redis currecny: ${curHash.length}/${CURRENCIES.length} (walletapi rebuilds this at boot)`);
  } else ok(`redis currecny: ${curHash.length} currencies`);

  const cnvCount = await redis.hlen(`${opts.redisPrefix}priceCnv`);
  const wantCnv = priceConversionRows().length;
  if (cnvCount < wantCnv) warn(`redis priceCnv: ${cnvCount} entries (the walletapi cron refreshes these)`);
  else ok(`redis priceCnv: ${cnvCount} entries`);

  /* content the frontend and the flows read */
  const checks = [
    [userDb, 'sitesetting', {}, 1, 'every frontend page fetches it', true],
    [userDb, 'emailtemplate', { identifier: 'activate_register_user' }, 1, 'register -> activation link', true],
    // `admin`, `supportcategory`, `faq` and `cms` are NOT checked. Each backed
    // a surface that has been removed - a privileged login, support tickets,
    // the FAQ page, the CMS. Verifying them would report a healthy venue as
    // broken for lacking content nothing can display.
    [walletDb, 'priceconversion', {}, wantCnv, 'walletapi conversion cron', false],
    [spotDb, 'sequenceId', { type: 'orderHistory' }, 1, 'order codes (self-healing upsert)', false],
  ];
  for (const [db, coll, filter, min, why, required] of checks) {
    const n = await db.collection(coll).countDocuments(filter);
    const label = `${db.databaseName}.${coll}: ${n} (need >= ${min}) - ${why}`;
    if (n >= min) ok(label);
    else if (required) bad(label);
    else warn(label);
  }

  /* residue that misleads more than it breaks */
  for (const [db, coll] of [[walletDb, 'currencies'], [spotDb, 'currencies'], [spotDb, 'spotpairs'], [walletDb, 'spotpairs']]) {
    const n = await db.collection(coll).countDocuments({});
    if (n > 0) {
      warn(`${db.databaseName}.${coll}: ${n} row(s) - nothing in the product reads this collection; it is residue from a script that let mongoose pluralise a model name`);
    }
  }

  console.log('');
  if (problems.length === 0) {
    console.log(`${C.green}${C.bold}VERIFY PASSED${C.reset} - every collection and redis key the venue reads is populated and consistent.`);
  } else {
    console.log(`${C.red}${C.bold}VERIFY FAILED${C.reset} - ${problems.length} problem(s):`);
    problems.forEach((p) => console.log(`  ${C.red}x${C.reset} ${p}`));
  }
  return problems;
};

/* ================================================================== *
 * MAIN
 * ================================================================== */

const main = async () => {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(`${C.red}${err.message}${C.reset}\n${HELP}`); process.exit(2); }
  if (opts.help) { console.log(HELP); process.exit(0); }

  console.log(`${C.bold}Cryptodex reset-and-seed${C.reset}`);
  console.log(`  mongo   ${opts.mongoUri}  databases ${DATABASES.map((d) => `${opts.dbPrefix}_${d}`).join(', ')}`);
  console.log(`  redis   ${opts.redisUrl}  db ${opts.redisDb}  prefix ${opts.redisPrefix}`);
  console.log(`  mode    ${opts.verify ? 'VERIFY (read-only)' : opts.reset ? `${C.red}RESET + SEED (destructive)${C.reset}` : 'SEED (idempotent, non-destructive)'}`);

  if (opts.reset && opts.confirm !== opts.dbPrefix) {
    console.error(
      `\n${C.red}Refusing to reset.${C.reset} --reset drops ` +
      `${DATABASES.map((d) => `${opts.dbPrefix}_${d}`).join(', ')} and every redis key ` +
      `matching ${opts.redisPrefix}* in db ${opts.redisDb}.\n` +
      `Type the database prefix back to confirm:  --confirm ${opts.dbPrefix}\n`
    );
    process.exit(2);
  }

  // REDIS MUST BE UNDER THE CONFIRMED PREFIX, NOT JUST MONGO.
  // --confirm vouches for the mongo dbPrefix only, but teardown ALSO deletes
  // every redis key matching redisPrefix* in redisDb - and redisPrefix/redisDb
  // default to the PRODUCTION values (cryptodex_ / db 0) independently of
  // dbPrefix. Without this check `--reset --confirm resettest --db-prefix
  // resettest` with the redis flags forgotten passes the mongo guard, drops the
  // harmless resettest_* databases, and then wipes the LIVE cryptodex_* redis
  // keyspace - including admin_liquidity/liquidation, the ladder SPOF whose loss
  // stops every order filling - which the operator never confirmed. Requiring
  // the redis prefix to begin with the confirmed dbPrefix means confirming a
  // mongo prefix can never authorise deleting a different prefix's redis keys.
  // The documented convention already satisfies it (--db-prefix resettest goes
  // with --redis-prefix resettest_), and production (cryptodex / cryptodex_)
  // passes unchanged.
  if (opts.reset && !opts.redisPrefix.startsWith(opts.dbPrefix)) {
    console.error(
      `\n${C.red}Refusing to reset.${C.reset} The redis prefix ` +
      `${C.bold}${opts.redisPrefix}${C.reset} is not under the confirmed database ` +
      `prefix ${C.bold}${opts.dbPrefix}${C.reset}, so teardown would delete redis keys ` +
      `you did not confirm (redis prefix/db default to the PRODUCTION keyspace, ` +
      `cryptodex_ / db 0).\n` +
      `Align them - e.g. --redis-prefix ${opts.dbPrefix}_ - or point --db-prefix at ` +
      `the venue you actually mean to reset.\n`
    );
    process.exit(2);
  }

  const mongo = new MongoClient(opts.mongoUri);
  let redis;
  try {
    await mongo.connect();
    redis = await openRedis(opts);

    if (opts.verify) {
      const problems = await verify(mongo, redis, opts);
      process.exitCode = problems.length ? 1 : 0;
      return;
    }

    if (opts.reset) await teardown(mongo, redis, opts);
    await seed(mongo, redis, opts);
    const problems = await verify(mongo, redis, opts);

    heading('SUMMARY');
    console.log(`  created ${tally.created}   updated ${tally.updated}   already correct ${tally.unchanged}`);
    console.log(`  ${C.dim}Next: start the stack. spotapi loads pairs into redis on boot and`);
    console.log(`  connects the binance depth feed; the first fills need that feed to be up.${C.reset}`);
    process.exitCode = problems.length ? 1 : 0;
  } catch (err) {
    console.error(`\n${C.red}FAILED:${C.reset} ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  } finally {
    if (redis) await redis.quit().catch(() => {});
    await mongo.close().catch(() => {});
  }
};

main();
