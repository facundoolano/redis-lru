'use strict';

// TODO add maxAge (i.e. support expiration)

function buildCache (client, opts) {
  if (typeof opts === 'number') {
    opts = {max: opts};
  }

  opts = Object.assign({
    namespace: 'LRU-CACHE!'
  }, opts);

  if (!opts.max) {
    throw Error('max number of items in cache must be specified.');
  }

  const ZSET_KEY = `${opts.namespace}-i`;

  function namedKey (key) {
    if (!typeof key === 'string') {
      throw Error('key should be a string.');
    }

    return `${opts.namespace}-k-${key}`;
  }

  /*
  * Gets the value for the given key and updates its timestamp score, only if
  * already present in the zset. The result is JSON.parsed before returned.
  */
  const get = (key) => new Promise((resolve, reject) => {
    const score = -new Date().getTime();
    key = namedKey(key);

    client.multi()
      .get(key)
      .zadd(ZSET_KEY, 'XX', score, key)
      .exec((err, results) => {
        if (err) return reject(err);

        const value = results[0] && JSON.parse(results[0]);
        resolve(value);
      });
  });

  /*
  * Save (add/update) the new value for the given key, and update its timestamp
  * score. The value is JSON.stringified before saving.
  *
  * If there are more than opts.max items in the cache after the operation
  * then remove each exceeded key from the zset index and its value from the
  * cache (in a single transaction).
  */
  const set = (key, value) => new Promise((resolve, reject) => {
    const score = -new Date().getTime();
    key = namedKey(key);

    client.multi()
      .set(key, JSON.stringify(value))
      .zadd(ZSET_KEY, score, key)
      .zrange(ZSET_KEY, opts.max, -1)
      .exec((err, results) => {
        if (err) return reject(err);

        // we get zrange first then zrem each one instead of just zremrange,
        // that way we guarantee that zset is always in sync with available data in the cache

        const exceededKeys = results[2];
        if (exceededKeys.length) {
          return client.multi()
            .zrem(ZSET_KEY, exceededKeys)
            .del(exceededKeys)
            .exec((err) => {
              if (err) return reject(err);
              resolve();
            });
        }

        return resolve();
      });
  });

  /*
  * Retrieve the value for key in the cache (if present), without updating the
  * timestamp score. The result is JSON.parsed before returned.
  */
  const peek = (key) => new Promise((resolve, reject) =>
    client.get(namedKey(key), (err, result) => {
      if (err) return reject(err);

      const value = result && JSON.parse(result);
      resolve(value);
    }));

  /*
  * Remove the value of key from the cache (and the zset index).
  */
  function del (key) {
    // del from key
    // zrem from zset
  }

  /*
  * Remove all items from cache (and the zset index).
  */
  function reset () {
    // get all from zet
    // del all keys from result
    // del zset
  }

  /*
  * Return true if the given key is in the cache
  */
  function has (key) {
    // !! zscore
  }

  /*
  * Return an array of the keys currenlty in the cache, most reacently accessed
  * first.
  */
  function keys () {
    // get all from zset
    // remove prefix from all
  }

  /*
  * Return an array of the values currenlty in the cache, most reacently accessed
  * first.
  */
  function values () {
    // get all from zset
    // get each value from result keys
  }

  /*
  * Return the amount of items currenlty in the cache.
  */
  function count () {

  }

  return {
    get: get,
    set: set,
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
