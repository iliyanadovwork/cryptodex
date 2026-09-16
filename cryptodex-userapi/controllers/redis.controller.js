// import package
import redis from 'redis'
import { promisify } from 'util'
import config from '../config/index.js'
import { toFixed } from '../lib/roundOf.js';
const redisClient = redis.createClient({ url: config.REDIS_URL });
redisClient.get = promisify(redisClient.get);
redisClient.hget = promisify(redisClient.hget);
redisClient.set = promisify(redisClient.set);
redisClient.hset = promisify(redisClient.hset);
redisClient.hmget = promisify(redisClient.hmget);
redisClient.hmset = promisify(redisClient.hmset);
redisClient.HGETALL = promisify(redisClient.HGETALL);
redisClient.HDEL = promisify(redisClient.HDEL);
redisClient.HINCRBYFLOAT = promisify(redisClient.HINCRBYFLOAT);

redisClient.on('connect', () => console.log('Connected to Redis'))

redisClient.on("error", function (error) {
    console.log("\x1b[31m", 'Error on redis client', error)
});

/**
 * Connection state only - no command is issued, so this is safe to call from
 * the unauthenticated health endpoint without adding load or blocking.
 * @returns {boolean}
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
    let result = await redisClient.hset(config.REDIS_PREFIX + key.toString(), uniqueId.toString(), JSON.stringify(data));
    // console.log("-----result", result)
}

export const hmget = async (key, fields) => {
    return await redisClient.hmget(config.REDIS_PREFIX + key, ...fields);
}

export const hmset = async (key, data) => {
    try {
        await redisClient.hmset(config.REDIS_PREFIX + key, data);
        return true;
    } catch (err) {
        return false;
    }
}

export const hget = async (key, uniqueId) => {
    console.log(key, uniqueId, 'key, uniqueId')
    return await redisClient.hget(config.REDIS_PREFIX + key.toString(), uniqueId.toString());
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

export const hgetall = async (key) => {
    let allvalues = await redisClient.HGETALL(config.REDIS_PREFIX + key);
    return allvalues;
}

export const hdetall = async (key) => {
    await redisCtrl.del(config.REDIS_PREFIX + key)
}
