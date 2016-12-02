'use strict';

// TODO add maxAge (i.e. support expiration)
// FIXME maybe add a promisify function to avoid repetition

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
  * Remove a set of keys from the cache and the index, in a single transaction,
  * to avoid orphan indexes or cache values.
  */
  const safeDelete = (keys) => new Promise((resolve, reject) => {
    if (keys.length) {
      return client.multi()
        .zrem(ZSET_KEY, keys)
        .del(keys)
        .exec((err) => {
          if (err) return reject(err);
          resolve();
        });
    }

    resolve();
  });

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

        // we get zrange first then safe delete instead of just zremrange,
        // that way we guarantee that zset is always in sync with available data in the cache
        resolve(safeDelete(results[2]));
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
  const del = (key) => new Promise((resolve, reject) => {
    key = namedKey(key);

    client.multi()
      .del(key)
      .zrem(ZSET_KEY, key)
      .exec((err, results) => {
        if (err) return reject(err);

        resolve(results[1]);
      });
  });

  /*
  * Remove all items from cache and the zset index.
  */
  const reset = () => new Promise((resolve, reject) =>
    client.zrange(ZSET_KEY, 0, -1, (err, results) => {
      if (err) return reject(err);

      resolve(safeDelete(results));
    }));

  /*
  * Return true if the given key is in the cache
  */
  const has = (key) => new Promise((resolve, reject) =>
    client.zscore(ZSET_KEY, namedKey(key), (err, result) => {
      if (err) return reject(err);
      resolve(!!result);
    }));

  /*
  * Return an array of the keys currently in the cache, most reacently accessed
  * first.
  */
  const keys = () => new Promise((resolve, reject) =>
    client.zrange(ZSET_KEY, 0, opts.max, (err, results) => {
      if (err) return reject(err);

      resolve(results.map((key) => key.slice(`${opts.namespace}-k-`.length)));
    }));

  /*
  * Return an array of the values currently in the cache, most reacently accessed
  * first.
  */
  const values = () => new Promise((resolve, reject) =>
    client.zrange(ZSET_KEY, 0, opts.max, (err, results) => {
      if (err) return reject(err);

      const multi = client.multi();
      results.forEach((key) => multi.get(key));

      multi.exec((err, results) => {
        if (err) return reject(err);

        resolve(results.map(JSON.parse));
      });
    }));

  /*
  * Return the amount of items currently in the cache.
  */
  const count = () => new Promise((resolve, reject) =>
    client.zcard(ZSET_KEY, (err, result) => {
      if (err) return reject(err);

      resolve(result);
    }));

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
