// import package
import redis from 'redis'
import { promisify } from 'util'
import config from '../config/index.js'
import { toFixed } from '../lib/roundOf.js';
import { IncCntObjId } from '../lib/generalFun.js';
import { redisPassBook } from '../models/index.js';

const redisClient = redis.createClient({ url: config.REDIS_URL });
redisClient.get = promisify(redisClient.get);
redisClient.hget = promisify(redisClient.hget);
redisClient.set = promisify(redisClient.set);
redisClient.hset = promisify(redisClient.hset);
redisClient.HGETALL = promisify(redisClient.HGETALL);
redisClient.HDEL = promisify(redisClient.HDEL);
redisClient.HINCRBYFLOAT = promisify(redisClient.HINCRBYFLOAT);
redisClient.eval = promisify(redisClient.eval);

redisClient.on('connect', () => console.log('Connected to Redis'))

redisClient.on("error", function (error) {
    console.log("\x1b[31m", 'Error on redis client', error)
});

/**
 * Is the client actually talking to redis right now?
 *
 * node_redis v3 keeps `connected` false while it is retrying, and its offline
 * queue makes a command against a down server PEND rather than throw - so a
 * caller that wants to know the state (the health endpoint) has to ask this
 * rather than infer it from a command that never comes back. Same helper, same
 * name, same semantics as userapi's.
 */
export const isRedisConnected = () => Boolean(redisClient && redisClient.connected);


export const set = async (key, value) => {
    try {
        await redisClient.set(config.REDIS_PREFIX + key.toString(), value);
        return true
    } catch (err) {
        return false
    }
}

export const get = async (key) => {
    try {
        return await redisClient.get(config.REDIS_PREFIX + key.toString())
    } catch (err) {
        return null
    }
}
export const del = async (key) => {
    try {
        await redisClient.del(config.REDIS_PREFIX + key.toString())
    } catch (err) {
        return null
    }
}
export const hset = async (key, uniqueId, data) => {
    let result = await redisClient.hset(config.REDIS_PREFIX + key, uniqueId, JSON.stringify(data));
}


/**
 * SEED A FIELD, AND ONLY IF IT DOES NOT EXIST.
 * ============================================
 *
 * This service's job with the engine ledgers is HYDRATION: when a redis field
 * is missing (a fresh account, a flushed cache), put the persisted value there
 * so the service has a row to work with. It is NOT to have an opinion about a
 * field that already exists - redis is the authoritative ledger, which is the
 * premise `controllers/redisWalletBackUp.js` is built on, and mongo is a
 * backup of it that is up to ten seconds stale.
 *
 * Every hydration site here used to spell that as `hget` -> `if (!value)` ->
 * `hset`, which is wrong twice:
 *
 *   * it is a read-modify-write across two awaits, so a reservation landing in
 *     the gap is overwritten by a value from before it;
 *   * `updateUserWallet` did not even have the guard - it wrote every ledger
 *     unconditionally from a mongo snapshot. MEASURED on this stack, own
 *     throwaway account with a live position: one call zeroed both the balance
 *     and its reservation counter while the position still required the
 *     reservation, and (once the ten-second backup cron had persisted the
 *     balance) wrote the whole balance INTO the reservation counter, reserving
 *     the entire account against one position. spotapi calls it on the ordinary
 *     order path.
 *
 * HSETNX is "write only if absent", decided by redis in one command. A field
 * that exists is left exactly alone, so this can no longer contradict a live
 * ledger no matter what raced it. Returns true when THIS call's value is the
 * one now stored.
 */
export const hsetnx = async (key, uniqueId, data) => {
    const written = await redisClient.HSETNX(
        config.REDIS_PREFIX + key,
        uniqueId.toString(),
        typeof data === "string" ? data : JSON.stringify(data)
    );
    return parseFloat(written) === 1;
}

export const hget = async (key, uniqueId) => {
    return await redisClient.hget(config.REDIS_PREFIX + key, uniqueId);
}
export const hincby = async (key, uniqueId, incrementval) => {
    if (incrementval.toString().split('.')[1] && incrementval.toString().split('.')[1].length > 7) {
        incrementval = toFixed(incrementval, 7)
    }
    return await redisClient.HINCRBY(config.REDIS_PREFIX + key, uniqueId, incrementval, function (err, value) {
        if (value <= 0) {
            redisClient.HDEL(config.REDIS_PREFIX + key, uniqueId);
        }
    });
}

export const hincbyfloat = async (key, uniqueId, incrementval) => {
   
    return await redisClient.HINCRBYFLOAT(config.REDIS_PREFIX + key, uniqueId, incrementval);
}

export const hdel = async (key, uniqueId) => {
    return await redisClient.HDEL(config.REDIS_PREFIX + key, uniqueId.toString());
}

/**
 * ATOMIC CONDITIONAL DEBIT: subtract `amt` from the TOTAL field, but only if
 * the FREE balance (`total - locked`) can currently cover it.
 *
 * THE HALF OF THE BOUND NOBODY OWNED
 * ----------------------------------
 * The bound is `0 <= locked <= available`. An order-placement path enforces the
 * LEFT half (a reservation cannot exceed the free balance) inside one Lua step,
 * and every round of this work measured only `locked == SUM(obligations)`.
 * Nothing enforced the RIGHT half, because the only thing that can break it
 * from a standing start is a DEBIT of `available` taken while a reservation is
 * in flight - and every such debit lives HERE, in a handler that read the pair
 * with two plain HGETs, compared them in node, and then HINCRBYFLOATed the
 * total across a network call's worth of awaits.
 *
 * MEASURED ON THIS STACK, own throwaway accounts, before this existed:
 *
 *   a 500 payout raced against a limit order of cost 340
 *     both answered 200, NINE TIMES IN TEN
 *     balance        0
 *     locked         340   <- exact against the obligation
 *     the open-order hash still holds the order, orderCost 340
 *   -> free -340. A live resting order with NOTHING behind it, on an account
 *      whose entire balance had just been paid out.
 *
 *   THE DETECTORS SAW IT AND COULD NOT STOP IT. The margin sentinels test the
 *   bound separately from the identity, and on the scan taken while writing
 *   this they were reporting 42 such rows - EVERY ONE with a drift of exactly
 *   zero, because `locked` matched its obligation perfectly and it was
 *   `available` that had been moved out from under it. Those sentinels are
 *   read-only and repair nothing, so what they were reporting was damage that
 *   had already happened. The gate has to be here, on the write.
 *
 *   And 5 times out of 5: three concurrent 20000 debits of one 20000 balance
 *   all answered 200, leaving walletbalance_spot at -40000.
 *
 * Both are one defect: a gate computed in node from a snapshot is not a gate.
 * Deciding inside redis makes the answer correct across processes, with no lock
 * to acquire and no rollback to race.
 *
 * THE TOLERANCE. 1e-9 is a thousandth of the last decimal these ledgers keep
 * (8), and it exists so that a balance the javascript comparison called
 * affordable is not refused by the 2e-17 binary floating point leaves behind.
 * It is deliberately the same tolerance the reservation side uses, so the two
 * cannot disagree about affordability by a rounding step.
 *
 * Returns the total AS A STRING after the debit, or null when the guard refused
 * - INCLUDING when redis is unreachable, which is the safe direction: the
 * transfer refuses rather than paying out against an unverified balance.
 */
const DEBIT_IF_FREE_LUA =
    "local avail = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0') or 0 " +
    "local lock = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0') or 0 " +
    "local amt = tonumber(ARGV[2]) or 0 " +
    "if amt <= 0 then return false end " +
    "if avail - lock + 0.000000001 >= amt then " +
    "return redis.call('HINCRBYFLOAT', KEYS[1], ARGV[1], ARGV[3]) end " +
    "return false";

export const hdecrbyfloatIfFree = async (totalKey, lockedKey, uniqueId, amount) => {
    try {
        const amt = parseFloat(amount);
        if (!Number.isFinite(amt) || amt <= 0) return null;
        const value = await redisClient.eval(
            DEBIT_IF_FREE_LUA,
            2,
            config.REDIS_PREFIX + totalKey.toString(),
            config.REDIS_PREFIX + lockedKey.toString(),
            uniqueId.toString(),
            String(amt),
            String(-amt)
        );
        return value === undefined || value === null ? null : value;
    } catch (error) {
        console.log("HDECRBYFLOATIFFREE ERROR", error);
        return null;
    }
}

/**
 * REGISTER A VALUE-MOVING REQUEST AS IN FLIGHT, UNLESS THE ACCOUNT IS FROZEN.
 *
 * THE SPOTAPI HALF OF THIS IS THE AUTHORITY - see that service's
 * lib/valueFlight.js for the whole argument and the measurement. In short:
 * `spotapi POST /faucet/reset` restores a known total by writing ABSOLUTE
 * balances, which is only correct if nothing else moves the same account's
 * money while it does. `walletTransfer` moves a balance out of one of this
 * user's wallets and into another, in several separate redis commands, and the
 * reset zeroes the destination and SETS the source - so a transfer interleaved
 * with a reset leaves the account holding the restored grant AND the
 * transferred amount. That is minted demo money by a different door than the
 * order-placement one that was measured.
 *
 * So this service speaks the same protocol against the same key: the `EXISTS`
 * on the freeze and the `HSET` that records the flight are ONE step, and the
 * reset reads the registry after taking the freeze. Both orderings are safe.
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
    return allvalues;
}

export const hdetall = async (key) => {
    await redisCtrl.del(config.REDIS_PREFIX + key)
}

export const createPassBook = async (userId, coinId, coin, dbBal, redisBal,) => {
    try {

        var passbook = new redisPassBook();
        passbook["userId"] = userId;
        passbook["userCodeId"] = IncCntObjId(userId)
        passbook["currencyId"] = coinId;
        passbook["coin"] = coin;
        passbook["redisBalance"] = redisBal;
        passbook["dbBalance"] = dbBal;
        await passbook.save()
        return true
    } catch (err) {
        return false
    }
}