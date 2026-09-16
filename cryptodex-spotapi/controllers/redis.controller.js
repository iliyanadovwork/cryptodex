// import package
import redis from "redis";
import { promisify } from "util";
import config from "../config/index.js";
import { toFixed } from "../lib/roundOf.js";
const redisClient = redis.createClient({ url: config.REDIS_URL });
redisClient.get = promisify(redisClient.get);
redisClient.hget = promisify(redisClient.hget);
redisClient.set = promisify(redisClient.set);
redisClient.hset = promisify(redisClient.hset);
redisClient.HGETALL = promisify(redisClient.HGETALL);
redisClient.HDEL = promisify(redisClient.HDEL);
redisClient.HINCRBYFLOAT = promisify(redisClient.HINCRBYFLOAT);
redisClient.rpush = promisify(redisClient.rpush);
redisClient.lpop = promisify(redisClient.lpop);
redisClient.rpop = promisify(redisClient.rpop);
redisClient.lrange = promisify(redisClient.lrange);
redisClient.DEL = promisify(redisClient.DEL)
redisClient.hmset = promisify(redisClient.hmset);
redisClient.hmget = promisify(redisClient.hmget);
redisClient.HLEN = promisify(redisClient.HLEN);
redisClient.eval = promisify(redisClient.eval);
redisClient.xrange = promisify(redisClient.xrange);
redisClient.xlen = promisify(redisClient.xlen);
redisClient.config = promisify(redisClient.config);

redisClient.on("connect", () =>
  console.log("Connected to Redis", config.REDIS_URL)
);

redisClient.on("error", function (error) {
  console.log("\x1b[31m", "Error on redis client", error);
});

/**
 * Is the redis connection currently usable?
 *
 * node-redis v3 keeps a `connected` flag on the client and flips it on the
 * socket lifecycle, so this needs no round trip - which matters, because the
 * health endpoint must never be the thing that hangs.
 *
 * Redis is a HARD dependency for this service specifically: the authoritative
 * spot balances and the live order book both live in it, so a disconnected
 * redis means orders cannot be reserved and the matcher cannot read the book.
 * Mirrors walletapi's helper of the same name.
 */
export const isRedisConnected = () =>
  Boolean(redisClient && redisClient.connected);

export const set = async (key, value) => {
  try {
    await redisClient.set(config.REDIS_PREFIX + key, value);
    return true;
  } catch (err) {
    return false;
  }
};

export const get = async (key) => {
  try {
    return await redisClient.get(config.REDIS_PREFIX + key);
  } catch (err) {
    console.log("err---------- ", err);
    return null;
  }
};
export const del = async (key) => {
  try {
    await redisClient.del(config.REDIS_PREFIX + key);
  } catch (err) {
    return null;
  }
};
export const hset = async (key, uniqueId, data) => {
  let result = await redisClient.hset(
    config.REDIS_PREFIX + key,
    uniqueId.toString(),
    JSON.stringify(data)
  );
  // console.log("-----result", result)
};

export const hlen = async (key) => {
  return await redisClient.HLEN(config.REDIS_PREFIX + key);
};


export const hget = async (key, uniqueId) => {
  return await redisClient.hget(config.REDIS_PREFIX + key, uniqueId.toString());
};
export const hincby = async (key, uniqueId, incrementval) => {
  if (
    incrementval.toString().split(".")[1] &&
    incrementval.toString().split(".")[1].length > 7
  ) {
    incrementval = toFixed(incrementval, 7);
  }
  return await redisClient.HINCRBY(
    config.REDIS_PREFIX + key,
    uniqueId,
    incrementval,
    function (err, value) {
      if (value <= 0) {
        redisClient.HDEL(config.REDIS_PREFIX + key, uniqueId);
      }
    }
  );
};

export const hincbyfloat = async (key, uniqueId, incrementval) => {
  try {
    return await redisClient.HINCRBYFLOAT(
      config.REDIS_PREFIX + key,
      uniqueId,
      incrementval
    );
  } catch (err) {
    console.log("-----------", err);
  }
};

export const hdel = async (key, uniqueId) => {
  return await redisClient.HDEL(config.REDIS_PREFIX + key, uniqueId.toString());
};

/**
 * ATOMIC RESERVATION: debit a balance field ONLY if it can cover the debit.
 *
 * Order placement is the one place a balance is turned into a claim on funds,
 * and it was written as READ, COMPARE IN NODE, HINCRBYFLOAT, then - if the
 * result came back negative - HINCRBYFLOAT the same amount back and refuse.
 * That is a repair, not a reservation, and it has two costs even though it does
 * arrive at the right final number:
 *
 *   - Between the debit and the repair the field is NEGATIVE in redis. Every
 *     other reader sees it: a concurrent order's affordability check, the
 *     passbook rows the repair itself writes (they record a negative
 *     beforeBalance/afterBalance as fact), walletapi, the withdrawal path.
 *   - It leans on the refund actually running. Anything that can end the
 *     request between the two calls - a throw, a redis error swallowed by
 *     hincbyfloat's try/catch, a process restart - leaves the user's balance
 *     permanently short by the whole order value, with no order to show for it.
 *
 * Redis runs a Lua script atomically, so the read, the comparison and the debit
 * are one indivisible step: of N concurrent placements against one balance,
 * exactly those that fit are debited and the rest are refused having moved
 * nothing at all. The balance can never go negative and never needs repairing.
 *
 * The arithmetic itself is still HINCRBYFLOAT, so the stored value is produced
 * by exactly the same code path (and the same long-double precision) as before.
 *
 * Returns the new balance as a string, `FROZEN` while the caller's margin
 * freeze is held, or null when the field cannot cover `amount` (which is also
 * what a non-positive or non-numeric amount returns - a reservation that is not
 * a positive number is not a reservation).
 *
 * THE FREEZE KEY IS CHECKED IN THE SAME STEP.
 * ---------------------------------------------------------------------------
 * `faucet.resetFaucet` takes a per-user margin freeze (lib/marginFreeze.js) and
 * then writes ABSOLUTE balances. This is the ONLY command in the venue that
 * takes a reservation, which makes the check here the whole of the protection.
 *
 * THIS COMMAND DID NOT CHECK IT ORIGINALLY, and it is the command that takes
 * every SPOT reservation - so a `faucet/reset` racing a spot order placement reserved
 * against a balance the reset was about to overwrite, and the account ended up
 * holding the fresh grant AND an order funded out of the old one. Measured: an
 * account taken from 10,000 to 48,039.52 in four consecutive wins.
 *
 * Redis serialises the freeze against this script, so there are exactly two
 * orderings and both are safe:
 *
 *   reserve lands first -> the order exists and the reset's own gate sees it
 *                          (faucet.controller reads the resting books, and the
 *                          request is registered as in flight until it has
 *                          published), so the reset refuses
 *   freeze lands first  -> this returns FROZEN, the order is refused having
 *                          moved NOTHING, so there is nothing to unwind
 *
 * A caller that passes no freeze key gets a key that cannot exist, so the
 * EXISTS is false and the verdict is exactly what it was before.
 */
/** What a freeze-aware writer answers while a margin freeze is held. */
export const FROZEN = "FROZEN";

// `x ~= x` is the NaN test: Lua's tonumber() is strtod-backed, so it happily
// turns the string "NaN" into a NaN NUMBER rather than nil, and every ordinary
// comparison against NaN is false - so `amt <= 0` and `bal < amt` both let it
// straight through to HINCRBYFLOAT, which then errors out mid-request. Found by
// running this script against real redis; the in-memory mock the unit suite
// uses cannot reproduce it, which is precisely why it was worth running.
//
// `FROZEN` is safe as a sentinel because every other non-nil answer this script
// gives is HINCRBYFLOAT's, which is always a numeric string.
const RESERVE_LUA =
  "if redis.call('EXISTS', KEYS[2]) == 1 then return 'FROZEN' end " +
  "local amt = tonumber(ARGV[2]) " +
  "if amt == nil or amt ~= amt or amt <= 0 then return nil end " +
  "local cur = redis.call('HGET', KEYS[1], ARGV[1]) " +
  "local bal = 0 " +
  "if cur then bal = tonumber(cur) end " +
  "if bal == nil or bal ~= bal or bal < amt then return nil end " +
  "return redis.call('HINCRBYFLOAT', KEYS[1], ARGV[1], '-' .. ARGV[2])";

export const hincrbyfloatIfEnough = async (key, uniqueId, amount, freezeKey) => {
  // Refused before the round trip as well as inside it. An amount that is not a
  // positive finite number is not a reservation, and answering "no" here means
  // no caller can turn a corrupt size into a redis error it did not expect.
  const requested = Number(amount);
  if (!Number.isFinite(requested) || requested <= 0) {
    return null;
  }
  const value = await redisClient.eval(
    RESERVE_LUA,
    2,
    config.REDIS_PREFIX + key,
    config.REDIS_PREFIX + (freezeKey ? freezeKey.toString() : "__no_freeze__"),
    uniqueId.toString(),
    // Serialised by JS so the number redis compares is the number node
    // compared. Number.prototype.toString round-trips a double exactly.
    requested.toString()
  );
  return value === undefined ? null : value;
};

/**
 * ATOMIC CLAIM: read a hash field and remove it in one indivisible step.
 *
 * Every "cancel an order" flow in this service is a read-modify-delete against
 * an open-order hash that also MOVES MONEY (walletbalance_spot is credited with
 * the order's reservation). Doing that as HGET ... HINCRBYFLOAT ... HDEL is a
 * race: N concurrent cancels of the same order all see the field still present,
 * all refund, and one reservation is paid out N times - money creation.
 *
 * Redis executes a Lua script atomically, so exactly ONE caller can ever get a
 * non-nil reply for a given field. That reply is therefore both:
 *   - the claim ("I, and nobody else, removed this order, so I own the refund"),
 *     and
 *   - the authoritative snapshot AT THE MOMENT OF REMOVAL, so the refund is
 *     computed from the remaining quantity a concurrent partial fill left
 *     behind rather than from a stale pre-fill read.
 *
 * Returns the removed value (a JSON string, as stored by hset) or null when the
 * field was already gone. Errors are NOT swallowed: a failed claim must never
 * be mistaken for a successful one, so callers see the throw and refund nothing.
 */
const HGETDEL_LUA =
  "local v = redis.call('HGET', KEYS[1], ARGV[1]) " +
  "if v then redis.call('HDEL', KEYS[1], ARGV[1]) end " +
  "return v";

export const hgetdel = async (key, uniqueId) => {
  const value = await redisClient.eval(
    HGETDEL_LUA,
    1,
    config.REDIS_PREFIX + key,
    uniqueId.toString()
  );
  return value === undefined ? null : value;
};

/**
 * TAKE AN EXCLUSIVE, SELF-EXPIRING CLAIM ON A KEY.
 *
 * SETNX and the PEXPIRE in ONE Lua step, so a process that dies holding the
 * claim costs one TTL of waiting rather than wedging the thing it claimed
 * forever. Returns true only when THIS caller took it; a redis failure returns
 * false, which is the safe direction for every current caller (the faucet
 * reset, which must not run without the margin freeze it is trying to take).
 *
 * The claim/release pair is kept as one protocol against one key, so that any
 * future holder of the same freeze takes it the same way.
 */
const CLAIM_ONCE_LUA =
  "if redis.call('SETNX', KEYS[1], ARGV[1]) == 1 then " +
  "redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1 end " +
  "return 0";

export const claimOnce = async (key, token, ttlMs = 15000) => {
  try {
    const result = await redisClient.eval(
      CLAIM_ONCE_LUA,
      1,
      config.REDIS_PREFIX + key.toString(),
      String(token),
      String(Math.max(1, Math.floor(ttlMs)))
    );
    return parseInt(result, 10) === 1;
  } catch (error) {
    console.log("CLAIMONCE ERROR", error);
    return false;
  }
};

/**
 * Give a `claimOnce` claim back, but only if this caller still holds it.
 *
 * The token comparison is what stops a slow caller whose TTL already expired
 * from deleting a claim a DIFFERENT caller has since taken.
 */
const RELEASE_CLAIM_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then " +
  "return redis.call('DEL', KEYS[1]) end return 0";

export const releaseClaim = async (key, token) => {
  try {
    const result = await redisClient.eval(
      RELEASE_CLAIM_LUA,
      1,
      config.REDIS_PREFIX + key.toString(),
      String(token)
    );
    return parseInt(result, 10) === 1;
  } catch (error) {
    console.log("RELEASECLAIM ERROR", error);
    return false;
  }
};

/**
 * REGISTER A VALUE-MOVING REQUEST AS IN FLIGHT, UNLESS THE ACCOUNT IS FROZEN.
 *
 * The `EXISTS` on the freeze key and the `HSET` that records the flight are ONE
 * step, which is what makes lib/valueFlight.js's exclusion airtight rather than
 * merely narrow. See that file for the whole argument; the only thing that
 * needs saying here is why it is a HASH FIELD WITH A DEADLINE and not a counter:
 *
 *   - a counter that leaks (a process that dies between the increment and the
 *     decrement) refuses every future reset for that account FOREVER, and
 *     nothing in the product could tell the leak from a real flight;
 *   - a field carries its own deadline, so a leaked one stops counting on its
 *     own, and the PEXPIRE on the whole hash is refreshed by every registration
 *     so the key can only vanish once every field in it has already expired.
 *
 * Returns "OK" or "FROZEN". Errors are NOT swallowed: a caller that cannot
 * register its flight must refuse rather than proceed unregistered.
 */
const BEGIN_FLIGHT_LUA =
  "if redis.call('EXISTS', KEYS[2]) == 1 then return 'FROZEN' end " +
  "redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) " +
  "redis.call('PEXPIRE', KEYS[1], ARGV[3]) " +
  "return 'OK'";

export const beginFlight = async (flightKey, freezeKey, token, deadline, ttlMs) => {
  return await redisClient.eval(
    BEGIN_FLIGHT_LUA,
    2,
    config.REDIS_PREFIX + flightKey.toString(),
    config.REDIS_PREFIX + freezeKey.toString(),
    String(token),
    String(deadline),
    String(Math.max(1, Math.floor(ttlMs)))
  );
};

export const hgetall = async (key) => {
  let allvalues = await redisClient.HGETALL(config.REDIS_PREFIX + key);
  // console.log('config.REDIS_PREFIX + key: ', config.REDIS_PREFIX + key);
  return allvalues;
};

export const hdetall = async (key) => {
  await redisCtrl.del(key);
};

export const hdelAll = async (key) => {
  await redisClient.DEL(config.REDIS_PREFIX + key);
};

export const rpush = async (key, data) => {
  const result = await redisClient.rpush(key, data);
  return result;
};
export const lpop = async (listKey) => {
  let result = await redisClient.lpop(listKey);
  return result; // will return null if there is no data
};
export const rpop = async (listKey) => {
  let result = await redisClient.rpop(listKey);
  return result; // will return null if there is no data
};
export const lrange = async (listKey, start = 0, end = -1) => {
  let result = redisClient.lrange(listKey, start, end);
  return result; // will return empty if there are no results
};

export const hmset = async (key, data) => {
  try {
      await redisClient.hmset(config.REDIS_PREFIX + key, data);
      return true;
  } catch (err) {
      return false;
  }
}

export const hmget = async (key, fields) => {
  return await redisClient.hmget(config.REDIS_PREFIX + key, ...fields);
}

/**
 * THE LEDGER IS THE SOURCE OF TRUTH; THE BALANCE IS A PROJECTION OF IT.
 * =====================================================================
 *
 * A balance used to be the only record that a movement happened. It lived in
 * redis, it was moved by HINCRBYFLOAT, and the passbook row that described the
 * move was written to mongo AFTERWARDS, separately, in several places without
 * being awaited. So anything that ended the request in between - a throw, a
 * restart, a swallowed redis error - left a balance that had moved and no
 * record that it had. A log with holes cannot be a source of truth, because a
 * hole is indistinguishable from a balance that was always that value.
 *
 * These two scripts append the ledger entry INSIDE the same atomic step that
 * moves the balance. Redis runs a script to completion before anything else, so
 * the entry and the movement are one indivisible operation: there is no window
 * in which either exists without the other, and no ordering to get wrong.
 *
 * The stream is what survives. The balance is a cache of it and can be thrown
 * away - see replayBalance in lib/ledger.js, which recomputes one from the
 * entries. That is the arrangement the old design had inverted.
 *
 * XADD, not RPUSH: the stream gives every entry a monotonic id, so a rebuild
 * can resume from a position and the mongo flusher can record how far it has
 * copied without a second cursor.
 */
const LEDGER_MAXLEN = Number(process.env.LEDGER_MAXLEN || 100000);

// Credit: no affordability check, because a credit cannot overdraw.
const LEDGER_CREDIT_LUA =
  "local amt = tonumber(ARGV[2]) " +
  "if amt == nil or amt ~= amt or amt <= 0 then return nil end " +
  "local before = redis.call('HGET', KEYS[1], ARGV[1]) " +
  "if not before then before = '0' end " +
  "local after = redis.call('HINCRBYFLOAT', KEYS[1], ARGV[1], ARGV[2]) " +
  "local id = redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[5], '*', " +
  "  'field', ARGV[1], 'delta', ARGV[2], 'before', before, 'after', after, " +
  "  'reason', ARGV[3], 'ref', ARGV[4]) " +
  "return {after, id}";

// Debit: refuses on a freeze, and refuses rather than overdrawing. The entry is
// only appended on the branch that actually moved the balance, so a refused
// debit leaves no trace to replay.
const LEDGER_DEBIT_LUA =
  "if redis.call('EXISTS', KEYS[3]) == 1 then return 'FROZEN' end " +
  "local amt = tonumber(ARGV[2]) " +
  "if amt == nil or amt ~= amt or amt <= 0 then return nil end " +
  "local cur = redis.call('HGET', KEYS[1], ARGV[1]) " +
  "local bal = 0 " +
  "if cur then bal = tonumber(cur) end " +
  "if bal == nil or bal ~= bal or bal < amt then return nil end " +
  "local before = cur " +
  "if not before then before = '0' end " +
  "local after = redis.call('HINCRBYFLOAT', KEYS[1], ARGV[1], '-' .. ARGV[2]) " +
  "local id = redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[5], '*', " +
  "  'field', ARGV[1], 'delta', '-' .. ARGV[2], 'before', before, 'after', after, " +
  "  'reason', ARGV[3], 'ref', ARGV[4]) " +
  "return {after, id}";

// Applies a SIGNED delta unconditionally and logs it. This is the faithful
// translation of a bare hincbyfloat: it does not check affordability and it can
// take a balance negative, exactly as that call always could.
//
// It exists so converting the existing call sites is a 1:1 substitution rather
// than a behaviour change wearing a refactor's clothes. A hincbyfloat that
// suddenly REFUSED would turn a refund into a silent no-op, and the place that
// happens is settlement - where the counterparty has already been paid.
// Tightening any particular site into a checked debit is a separate decision,
// made per site, with its own test.
const LEDGER_APPLY_LUA =
  "local d = tonumber(ARGV[2]) " +
  "if d == nil or d ~= d then return nil end " +
  // A ZERO DELTA IS A READ, NOT A REFUSAL. hincbyfloat(x, 0) returns the
  // balance; callers assign that and go on to use it. Answering null instead
  // put `afterBalance: null` into passbook rows and emitted spotBal: null to
  // the browser. Nothing is logged, because nothing moved.
  "if d == 0 then " +
  "  local cur0 = redis.call('HGET', KEYS[1], ARGV[1]) " +
  "  if not cur0 then cur0 = '0' end " +
  "  return {cur0, ''} " +
  "end " +
  "local before = redis.call('HGET', KEYS[1], ARGV[1]) " +
  "if not before then before = '0' end " +
  "local after = redis.call('HINCRBYFLOAT', KEYS[1], ARGV[1], ARGV[2]) " +
  "local id = redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[5], '*', " +
  "  'field', ARGV[1], 'delta', ARGV[2], 'before', before, 'after', after, " +
  "  'reason', ARGV[3], 'ref', ARGV[4]) " +
  "return {after, id}";

/** The append-only ledger for one account field. */
export const ledgerStreamKey = (field) => `ledger_${field}`;

/**
 * Move a balance and record why, atomically.
 *
 * `direction` is 'credit' or 'debit'. A debit refuses rather than overdrawing
 * and returns null, exactly as hincrbyfloatIfEnough does, so callers that
 * already branch on null need no change. `reason` and `ref` are what a human
 * reads back off the stream: what moved this, and which order or request it
 * belonged to.
 *
 * Returns { balance, entryId } on success, null when refused, 'FROZEN' while a
 * freeze is held.
 */
export const moveBalanceLogged = async (
  key,
  field,
  amount,
  { direction = "credit", reason = "unspecified", ref = "", freezeKey = null } = {}
) => {
  const requested = Number(amount);
  if (!Number.isFinite(requested) || requested <= 0) {
    return null;
  }
  const prefixed = config.REDIS_PREFIX + key;
  const stream = config.REDIS_PREFIX + ledgerStreamKey(field.toString());
  const args = [
    field.toString(),
    requested.toString(),
    String(reason),
    String(ref),
    String(LEDGER_MAXLEN),
  ];

  let reply;
  if (direction === "debit") {
    reply = await redisClient.eval(
      LEDGER_DEBIT_LUA,
      3,
      prefixed,
      stream,
      config.REDIS_PREFIX + (freezeKey ? freezeKey.toString() : "__no_freeze__"),
      ...args
    );
  } else {
    reply = await redisClient.eval(LEDGER_CREDIT_LUA, 2, prefixed, stream, ...args);
  }

  if (reply === "FROZEN") return "FROZEN";
  if (!reply || reply === undefined) return null;
  return { balance: reply[0], entryId: reply[1] };
};

/**
 * SET a balance to an absolute value, and record the movement it implies.
 *
 * The faucet reset and the zeroing of non-faucet coins do not adjust a balance,
 * they OVERWRITE it - and an overwrite is invisible to a delta ledger unless it
 * is expressed as one. Left unlogged, these were the two remaining ways to move
 * money without a record: reconcile reported a spurious mismatch after every
 * reset, and a rebuild would have written the pre-reset balance back over it.
 *
 * So the script reads the current value, works out `target - current`, and
 * appends THAT as the delta. A replay therefore still lands on the target,
 * because the sum of deltas is the definition of the balance either way.
 *
 * Setting a field to the value it already holds writes no entry: nothing moved.
 */
const LEDGER_SET_LUA =
  "local target = tonumber(ARGV[2]) " +
  "if target == nil or target ~= target then return nil end " +
  "local cur = redis.call('HGET', KEYS[1], ARGV[1]) " +
  "local before = 0 " +
  "if cur then before = tonumber(cur) end " +
  "if before == nil or before ~= before then before = 0 end " +
  "local delta = target - before " +
  "redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) " +
  "if delta == 0 then return {ARGV[2], ''} end " +
  "local id = redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[5], '*', " +
  "  'field', ARGV[1], 'delta', tostring(delta), 'before', tostring(before), " +
  "  'after', ARGV[2], 'reason', ARGV[3], 'ref', ARGV[4]) " +
  "return {ARGV[2], id}";

/**
 * The logged form of `hset(<balance key>, field, value)`.
 *
 * Returns the value written, as a string, or null when it is not a usable
 * number. Errors are swallowed for the same reason moveBalanceSigned swallows
 * them: these run inside a reset that has already moved other coins.
 */
export const setBalanceLogged = async (
  key,
  field,
  value,
  { reason = "absolute_set", ref = "" } = {}
) => {
  const target = Number(value);
  if (!Number.isFinite(target)) return null;
  let reply;
  try {
    reply = await redisClient.eval(
      LEDGER_SET_LUA,
      2,
      config.REDIS_PREFIX + key,
      config.REDIS_PREFIX + ledgerStreamKey(field.toString()),
      field.toString(),
      target.toString(),
      String(reason),
      String(ref),
      String(LEDGER_MAXLEN)
    );
  } catch (err) {
    console.log("[Ledger] absolute set failed:", err && err.message);
    return null;
  }
  if (!reply || reply === undefined) return null;
  return reply[0];
};

/** Read a field's ledger entries, oldest first. */
export const readLedger = async (field, { from = "-", to = "+" } = {}) => {
  const stream = config.REDIS_PREFIX + ledgerStreamKey(field.toString());
  const rows = await redisClient.xrange(stream, from, to);
  if (!rows) return [];
  return rows.map(([id, flat]) => {
    const e = { id };
    for (let i = 0; i < flat.length; i += 2) e[flat[i]] = flat[i + 1];
    return e;
  });
};

/** How many entries a field's ledger holds. */
export const ledgerLength = async (field) => {
  const stream = config.REDIS_PREFIX + ledgerStreamKey(field.toString());
  return (await redisClient.xlen(stream)) || 0;
};

/**
 * IS THE LEDGER ACTUALLY DURABLE?
 *
 * The ledger is only a source of truth if it survives a restart, and that is
 * not a property of this code - it is a property of how redis was started.
 * With `appendonly no` (the default) redis keeps only periodic RDB snapshots,
 * so a crash discards every entry written since the last one: up to an hour on
 * a quiet venue. The balances would then be unrecoverable in exactly the
 * situation the ledger exists for.
 *
 * Redis here is provisioned externally and configured by whoever runs it, so
 * this cannot be fixed in code. It can be REPORTED, which is the difference
 * between a guarantee that is false and a guarantee that is known to be false.
 *
 * Returns { durable, appendonly, save, reason }. Never throws: a service must
 * not fail to boot because it could not read a config key.
 */
export const ledgerDurability = async () => {
  try {
    const aof = await redisClient.config("GET", "appendonly");
    const save = await redisClient.config("GET", "save");
    const appendonly = Array.isArray(aof) ? aof[1] : String(aof || "");
    const savePolicy = Array.isArray(save) ? save[1] : String(save || "");
    const durable = appendonly === "yes";
    return {
      durable,
      appendonly,
      save: savePolicy,
      reason: durable
        ? "appendonly on"
        : "appendonly is off: ledger entries survive only to the last RDB snapshot",
    };
  } catch (err) {
    return {
      durable: null,
      appendonly: null,
      save: null,
      reason: `could not read redis config: ${err && err.message}`,
    };
  }
};

/**
 * Say so at boot, once, loudly enough to be noticed and not so loudly that it
 * becomes noise. A warning that prints every request gets filtered out.
 */
export const warnIfLedgerNotDurable = async () => {
  const d = await ledgerDurability();
  if (d.durable === true) return d;
  console.log(
    "\x1b[33m%s\x1b[0m",
    `[Ledger] NOT DURABLE - ${d.reason}. Balances are recoverable only as far ` +
      `back as the last snapshot (save policy: ${d.save || "unknown"}). ` +
      `Set appendonly yes on this redis to make the ledger mean what it says.`
  );
  return d;
};

/**
 * Apply a signed delta to a balance and record it, atomically.
 *
 * The drop-in replacement for `hincbyfloat` on a balance field: same arithmetic,
 * same permissiveness, and it RETURNS THE SAME THING - the new balance as a
 * string, or null. Deliberately not { balance, entryId }: every existing caller
 * does parseFloat() on the result, and handing them an object turns each of
 * those into a silent NaN. A migration that changes a return type is not a
 * drop-in, whatever the commit message says.
 *
 * Use moveBalanceLogged with direction 'debit' where the caller wants the
 * affordability check; this one deliberately has none.
 */
export const moveBalanceSigned = async (
  key,
  field,
  delta,
  { reason = "unspecified", ref = "" } = {}
) => {
  const d = Number(delta);
  if (!Number.isFinite(d)) return null;
  // ERRORS ARE SWALLOWED, AS hincbyfloat SWALLOWED THEM.
  //
  // These sites are inside settlement: a price-improvement refund, a cancel
  // credit, a fill credit. They run after the orders have left the book and
  // after the counterparty has been paid, so a throw here does not undo a fill
  // - it abandons the rest of the tick, including the history flush. That is
  // strictly worse than the failed credit it is reacting to.
  //
  // The same reasoning settlementCredit is wrapped under. Making any of these
  // throw is a separate change that needs a transactional settlement path.
  let reply;
  try {
    reply = await redisClient.eval(
      LEDGER_APPLY_LUA,
      2,
      config.REDIS_PREFIX + key,
      config.REDIS_PREFIX + ledgerStreamKey(field.toString()),
      field.toString(),
      d.toString(),
      String(reason),
      String(ref),
      String(LEDGER_MAXLEN)
    );
  } catch (err) {
    console.log("[Ledger] signed apply failed:", err && err.message);
    return null;
  }
  if (!reply || reply === undefined) return null;
  return reply[0];
};
