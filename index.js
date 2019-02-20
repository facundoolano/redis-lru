'use strict';

function asPromise (fn) {
  return new Promise((resolve, reject) => {
    const args = Array.from(arguments).slice(1);
    args.push((err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
    fn.apply(null, args);
  });
}

function isArray (item) {
  return Array.isArray(item);
}

/*
* IORedis uses a different format than node_redis for transactional results.
* Instead of ['OK', 1] it returns [[null, 'OK'], [null, 1]]. This function
* is used to convert the IORedis results to the same format as node_redis.
*/
function convertToNodeRedis (results) {
  if (isArray(results[0])) {
    return results.map((result) => result[1]);
  }
  return results;
}

function buildCache (client, opts) {
  if (!client) {
    throw Error('redis client is required.');
  }

  if (typeof opts === 'number') {
    opts = {max: opts};
  }

  opts = Object.assign({
    namespace: 'LRU-CACHE!',
    score: () => new Date().getTime(),
    increment: false
  }, opts);

  if (!opts.max) {
    throw Error('max number of items in cache must be specified.');
  }

  const ZSET_KEY = `${opts.namespace}-i`;

  function namedKey (key) {
    if (!typeof key === 'string') {
      return Promise.reject(Error('key should be a string.'));
    }

    return `${opts.namespace}-k-${key}`;
  }

  /*
  * Remove a set of keys from the cache and the index, in a single transaction,
  * to avoid orphan indexes or cache values.
  */
  const safeDelete = (keys) => {
    if (keys.length) {
      const multi = client.multi()
        .zrem(ZSET_KEY, keys)
        .del(keys);

      return asPromise(multi.exec.bind(multi));
    }

    return Promise.resolve();
  };

  /*
  * Gets the value for the given key and updates its timestamp score, only if
  * already present in the zset. The result is JSON.parsed before returned.
  */
  const get = (key) => {
    const score = -1 * opts.score(key);
    key = namedKey(key);

    const multi = client.multi()
      .get(key);

    if (opts.increment) {
      multi.zadd(ZSET_KEY, 'XX', 'CH', 'INCR', score, key);
    } else {
      multi.zadd(ZSET_KEY, 'XX', 'CH', score, key);
    }

    return asPromise(multi.exec.bind(multi))
      .then(convertToNodeRedis)
      .then((results) => {
        if (results[0] === null && results[1]) {
          // value has been expired, remove from zset
          return asPromise(client.zrem.bind(client), ZSET_KEY, key)
            .then(() => null);
        }
        return JSON.parse(results[0]);
      });
  };

  /*
  * Save (add/update) the new value for the given key, and update its timestamp
  * score. The value is JSON.stringified before saving.
  *
  * If there are more than opts.max items in the cache after the operation
  * then remove each exceeded key from the zset index and its value from the
  * cache (in a single transaction).
  */
  const set = (key, value, maxAge) => {
    const score = -1 * opts.score(key);
    key = namedKey(key);
    maxAge = maxAge || opts.maxAge;

    const multi = client.multi();
    if (maxAge) {
      multi.set(key, JSON.stringify(value), 'PX', maxAge);
    } else {
      multi.set(key, JSON.stringify(value));
    }

    if (opts.increment) {
      multi.zadd(ZSET_KEY, 'INCR', score, key);
    } else {
      multi.zadd(ZSET_KEY, score, key);
    }

    // we get zrange first then safe delete instead of just zremrange,
    // that way we guarantee that zset is always in sync with available data in the cache
    // also, include the last item inside the cache size, because we always want to
    // preserve the one that was just set, even if it has same or less score than other.
    multi.zrange(ZSET_KEY, opts.max - 1, -1);

    return asPromise(multi.exec.bind(multi))
      .then(convertToNodeRedis)
      .then((results) => {
        if (results[2].length > 1) { // the first one is inside the limit
          let toDelete = results[2].slice(1);
          if (toDelete.indexOf(key) !== -1) {
            toDelete = results[2].slice(0, 1).concat(results[2].slice(2));
          }
          return safeDelete(toDelete);
        }
      })
      .then(() => value);
  };

  /*
  * Try to get the value of key from the cache. If missing, call function and store
  * the result.
  */
  const getOrSet = (key, fn, maxAge) => get(key)
    .then((result) => {
      if (result === null) {
        return Promise.resolve()
          .then(fn)
          .then((result) => set(key, result, maxAge));
      }
      return result;
    });

  /*
  * Retrieve the value for key in the cache (if present), without updating the
  * timestamp score. The result is JSON.parsed before returned.
  */
  const peek = (key) => {
    key = namedKey(key);

    return asPromise(client.get.bind(client), key)
      .then((result) => {
        if (result === null) {
          // value may have been expired, remove from zset
          return asPromise(client.zrem.bind(client), ZSET_KEY, key)
            .then(() => null);
        }
        return JSON.parse(result);
      });
  };

  /*
  * Remove the value of key from the cache (and the zset index).
  */
  const del = (key) => safeDelete([namedKey(key)]);

  /*
  * Remove all items from cache and the zset index.
  */
  const reset = () => asPromise(client.zrange.bind(client), ZSET_KEY, 0, -1)
    .then(safeDelete);

  /*
  * Return true if the given key is in the cache
  */
  const has = (key) => asPromise(client.get.bind(client), namedKey(key))
    .then((result) => (!!result));

  /*
  * Return an array of the keys currently in the cache, most reacently accessed
  * first.
  */
  const keys = () => asPromise(client.zrange.bind(client), ZSET_KEY, 0, opts.max - 1)
    .then((results) => results.map((key) => key.slice(`${opts.namespace}-k-`.length)));

  /*
  * Return an array of the values currently in the cache, most reacently accessed
  * first.
  */
  const values = () => asPromise(client.zrange.bind(client), ZSET_KEY, 0, opts.max - 1)
    .then((results) => {
      const multi = client.multi();
      results.forEach((key) => multi.get(key));
      return asPromise(multi.exec.bind(multi));
    })
    .then((results) => {
      return results.map((res) => {
        if (isArray(res)) {
          res = res[1];
        }
        return JSON.parse(res);
      });
    });
  /*
  * Return the amount of items currently in the cache.
  */
  const count = () => asPromise(client.zcard.bind(client), ZSET_KEY);

  return {
    get: get,
    set: set,
    getOrSet: getOrSet,
    peek: peek,
    del: del,
    reset: reset,
    has: has,
    keys: keys,
    values: values,
    count: count
  };
}

module.exports = buildCache;
