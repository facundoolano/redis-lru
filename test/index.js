'use strict';

const assert = require('assert');

// const redis = require('redis').createClient(6379, 'redis-host');
// const Redis = require('ioredis'); const redis = new Redis(6379, 'redis-host');
const redis = require('./redisMock');

const LRU = require('../index');

beforeEach((done) => redis.flushdb(() => done()));

const dbsize = () => new Promise((resolve, reject) =>
  redis.dbsize((err, result) => {
    if (err) return reject(err);
    resolve(result);
  }));

// const printrange = (ns) => new Promise((resolve) =>
//   redis.zrange(`${ns || 'LRU-CACHE!'}-i`, 0, -1, (err, res) => { console.log(res); resolve(); }));

// sometimes need to force a ms change so multiple lru.get have different timestamp scores
const tick = (time) => new Promise((resolve) => setTimeout(resolve, time || 2));

describe('build cache', () => {
  it('should fail if no client given', () =>
    assert.throws(() => LRU(), /redis client is required\./));

  it('should fail if no max arg given', () => {
    assert.throws(() => LRU(redis), /max number of items in cache must be specified\./);
    assert.throws(() => LRU(redis, {}), /max number of items in cache must be specified\./);
  });
});

describe('set and get methods', () => {
  it('should save an item in the cache and allow to get it back', () => {
    const lru = LRU(redis, 3);

    return lru.set('key', 'hello')
      .then((result) => assert.equal(result, 'hello'))
      .then(() => lru.set('key2', {message: 'goodbye'}))
      .then(() => Promise.all([lru.get('key'), lru.get('key2')]))
      .then((results) => {
        assert.equal(results[0], 'hello');
        assert.deepEqual(results[1], {message: 'goodbye'});
      });
  });

  it('should return null if a key is not found in the cache', () => {
    const lru = LRU(redis, 3);

    return lru.get('key1')
      .then((result) => assert.equal(result, null));
  });

  it('should save up to opts.max items in the cache', () => {
    const lru = LRU(redis, 3);

    return Promise.all([
      lru.set('k1', 'v1'), lru.set('k2', 'v2'), lru.set('k3', 'v3')
    ])
    .then(() => lru.get('k1'))
    .then((r) => assert.equal(r, 'v1'))
    .then(tick)
    .then(() => lru.get('k2'))
    .then((r) => assert.equal(r, 'v2'))
    .then(tick)
    .then(() => lru.get('k3'))
    .then((r) => assert.equal(r, 'v3'))
    .then(dbsize)
    .then((r) => assert.equal(r, 4)) // DB size is #items + 1 for the index
    .then(() => lru.set('k4', 'v4'))
    .then(() => lru.get('k1'))
    .then((r) => assert.equal(r, null, 'k1 should have been evicted from the cache'))
    .then(() => lru.get('k2'))
    .then((r) => assert.equal(r, 'v2'))
    .then(() => lru.get('k3')) // set k4, get k1, k2 => k3 out of the cache
    .then((r) => assert.equal(r, 'v3'))
    .then(() => lru.get('k4'))
    .then((r) => assert.equal(r, 'v4'))
    .then(dbsize)
    .then((r) => assert.equal(r, 4, 'db size should not have grown'));
  });

  it('should keep different items in different namespaces', () => {
    const lru1 = LRU(redis, {max: 3, namespace: 'first'});
    const lru2 = LRU(redis, {max: 3, namespace: 'second'});

    return lru1.set('k1', 'first cache')
      .then(() => lru2.set('k1', 'second cache'))
      .then(() => Promise.all([lru1.get('k1'), lru2.get('k1')]))
      .then((results) => {
        assert.equal(results[0], 'first cache');
        assert.equal(results[1], 'second cache');
      });
  });

  it('should keep the last accessed items first', () => {
    const lru = LRU(redis, 3);

    return lru.set('k1', 'v1')
    .then(() => lru.set('k2', 'v2'))
    .then(() => lru.set('k3', 'v3'))
    .then(() => lru.get('k2')) // k2 last
    .then(tick)
    .then(() => lru.get('k3')) // k3 second
    .then(tick)
    .then(() => lru.get('k1')) // k1 first
    .then(tick)
    .then(() => lru.set('k4', 'v4')) // should evict oldest => k2 out
    .then(() => lru.get('k2'))
    .then((result) => {
      assert.equal(result, null);
    });
  });

  it('should update value and last accessed score when setting a key again', () => {
    const lru = LRU(redis, 3);

    return lru.set('k1', 'v1')
    .then(() => lru.set('k2', 'v2'))
    .then(() => lru.set('k3', 'v3'))
    .then(() => lru.get('k2'))
    .then(tick)
    .then(() => lru.get('k3'))
    .then(tick)
    .then(() => lru.get('k1'))
    .then(tick)
    .then(() => lru.set('k2', 'v2')) // k2 back to front, k3 is oldest
    .then(tick)
    .then(() => lru.set('k4', 'v4')) // k3 out
    .then(() => lru.get('k3'))
    .then((result) => {
      assert.equal(result, null);
    });
  });

  it('should not update last accessed score on a different namespace', () => {
    const lru1 = LRU(redis, {max: 2, namespace: 'c1'});
    const lru2 = LRU(redis, {max: 2, namespace: 'c2'});

    return lru1.set('k1', 'v1')
    .then(() => lru1.set('k2', 'v2'))
    .then(() => lru2.set('k1', 'v1'))
    .then(tick)
    .then(() => lru2.set('k2', 'v2'))
    .then(tick)
    .then(() => lru1.get('k1')) // bumps k1 in first cache
    .then(tick)
    .then(() => lru2.set('k3', 'v3')) // should evict k1 in second cache
    .then(() => lru2.get('k1'))
    .then((result) => {
      assert.equal(result, null);
    });
  });
});

describe('getOrSet method', () => {
  it('should get the value from cache and NOT call the function', () => {
    const lru = LRU(redis, 3);

    function fn () {
      throw Error('should not call');
    }

    return lru.set('key', 'hello')
      .then(() => lru.getOrSet('key', fn))
      .then((result) => assert.equal(result, 'hello'));
  });

  it('should set key to the return value of the function', () => {
    const lru = LRU(redis, 3);

    function fn () {
      return 5;
    }

    return lru.getOrSet('key', fn)
      .then((result) => assert.equal(result, 5))
      .then(() => lru.get('key'))
      .then((result) => assert.equal(result, 5));
  });

  it('should set key to the resolved value of the promise returned by the function', () => {
    const lru = LRU(redis, 3);

    function fn () {
      return Promise.resolve(5);
    }

    return lru.getOrSet('key', fn)
      .then((result) => assert.equal(result, 5))
      .then(() => lru.get('key'))
      .then((result) => assert.equal(result, 5));
  });

  it('should reject if function rejects', () => {
    const lru = LRU(redis, 3);

    function fn () {
      return Promise.reject(Error('something went wrong'));
    }

    return lru.getOrSet('key', fn)
      .then(() => { throw Error('should not resolve'); })
      .catch((err) => assert.equal(err.message, 'something went wrong'));
  });

  it('should reject if function throws', () => {
    const lru = LRU(redis, 3);

    function fn () {
      throw Error('something went wrong');
    }

    return lru.getOrSet('key', fn)
      .then(() => { throw Error('should not resolve'); })
      .catch((err) => assert.equal(err.message, 'something went wrong'));
  });

  it('should update recent-ness when getOrSet a saved value', () => {
    const lru = LRU(redis, 3);

    return lru.set('k1', 'v1')
    .then(() => lru.set('k2', 'v2'))
    .then(() => lru.set('k3', 'v3'))
    .then(() => lru.getOrSet('k2')) // k2 last
    .then(tick)
    .then(() => lru.getOrSet('k3')) // k3 second
    .then(tick)
    .then(() => lru.getOrSet('k1')) // k1 first
    .then(tick)
    .then(() => lru.set('k4', 'v4')) // should evict oldest => k2 out
    .then(() => lru.get('k2'))
    .then((result) => {
      assert.equal(result, null);
    });
  });

  it('should update recent-ness when getOrSet a missing value', () => {
    const lru = LRU(redis, 3);

    return lru.getOrSet('k2', () => 2) // k2 last
    .then(tick)
    .then(() => lru.getOrSet('k3', () => 3)) // k3 second
    .then(tick)
    .then(() => lru.getOrSet('k1', () => 1)) // k1 first
    .then(tick)
    .then(() => lru.set('k4', 'v4')) // should evict oldest => k2 out
    .then(() => lru.get('k2'))
    .then((result) => {
      assert.equal(result, null);
    });
  });
});

describe('peek method', () => {
  it('should return the value without changing the recent-ness score', () => {
    const lru = LRU(redis, 2);

    return lru.set('k1', 'v1')
      .then(tick)
      .then(() => lru.set('k2', 'v2'))
      .then(() => lru.peek('k1'))
      .then((r) => {
        assert.equal(r, 'v1');
        return lru.set('k3', 'v3'); // should evict k1 since last peek doesnt update recentness
      })
      .then(() => lru.get('k1'))
      .then((r) => assert.equal(r, null));
  });
});

describe('del method', () => {
  it('should remove the key from the cache and preserve the rest', () => {
    const lru = LRU(redis, 2);

    return lru.set('k1', 'v1')
      .then(() => lru.set('k2', 'v2'))
      .then(() => lru.del('k1'))
      .then(() => lru.get('k1'))
      .then((r) => assert.equal(r, null))
      .then(() => lru.get('k2'))
      .then((r) => assert.equal(r, 'v2'));
  });

  it('should not remove from other namespaces', () => {
    const lru = LRU(redis, 2);
    const lru2 = LRU(redis, {max: 2, namespace: 'c2'});

    return lru.set('k1', 'v1')
      .then(() => lru2.set('k1', 'v1'))
      .then(() => lru.del('k1'))
      .then(() => lru.get('k1'))
      .then((r) => assert.equal(r, null))
      .then(() => lru2.get('k1'))
      .then((r) => assert.equal(r, 'v1'));
  });
});

describe('reset method', () => {
  it('should remove all keys from the cache', () => {
    const lru = LRU(redis, 2);

    return lru.set('k1', 'v1')
      .then(() => lru.set('k2', 'v2'))
      .then(() => lru.reset())
      .then(() => lru.get('k1'))
      .then((r) => assert.equal(r, null))
      .then(() => lru.get('k2'))
      .then((r) => assert.equal(r, null));
  });

  it('should not empty other namespaces', () => {
    const lru = LRU(redis, 2);
    const lru2 = LRU(redis, {max: 2, namespace: 'c2'});

    return lru.set('k1', 'v1')
      .then(() => lru2.set('k1', 'v1'))
      .then(() => lru.reset())
      .then(() => lru.get('k1'))
      .then((r) => assert.equal(r, null))
      .then(() => lru2.get('k1'))
      .then((r) => assert.equal(r, 'v1'));
  });
});

describe('has method', () => {
  it('should return true if the item is in the cache without affecting the recent-ness', () => {
    const lru = LRU(redis, 2);

    return lru.set('k1', 'v1')
      .then(tick)
      .then(() => lru.set('k2', 'v2'))
      .then(() => lru.has('k1'))
      .then((r) => {
        assert.equal(r, true);
        return lru.set('k3', 'v3'); // should evict k1 since last peek doesnt update recentness
      })
      .then(() => lru.get('k1'))
      .then((r) => assert.equal(r, null));
  });

  it('should return false if the item is not in the cache', () => {
    const lru = LRU(redis, 2);

    return lru.set('k1', 'v1')
      .then(() => lru.set('k2', 'v2'))
      .then(() => lru.has('k3'))
      .then((r) => assert.equal(r, false));
  });
});

describe('keys method', () => {
  it('should return all keys inside the cache', () => {
    const lru = LRU(redis, 2);

    return lru.set('k1', 'v1')
      .then(tick)
      .then(() => lru.set('k2', 'v2'))
      .then(() => lru.keys())
      .then((r) => assert.deepEqual(r, ['k2', 'k1']));
  });

  it('should not return more keys if size exceeded before', () => {
    const lru = LRU(redis, 2);

    return lru.set('k1', 'v1')
      .then(tick)
      .then(() => lru.set('k2', 'v2'))
      .then(tick)
      .then(() => lru.set('k3', 'v3'))
      .then(() => lru.keys())
      .then((r) => assert.deepEqual(r, ['k3', 'k2']));
  });
});

describe('values method', () => {
  it('should return all values inside the cache', () => {
    const lru = LRU(redis, 2);

    return lru.set('k1', 'v1')
      .then(tick)
      .then(() => lru.set('k2', 'v2'))
      .then(() => lru.values())
      .then((r) => assert.deepEqual(r, ['v2', 'v1']));
  });

  it('should not return more values if size exceeded before', () => {
    const lru = LRU(redis, 2);

    return lru.set('k1', 'v1')
      .then(tick)
      .then(() => lru.set('k2', 'v2'))
      .then(tick)
      .then(() => lru.set('k3', 'v3'))
      .then(() => lru.values())
      .then((r) => assert.deepEqual(r, ['v3', 'v2']));
  });
});

describe('count method', () => {
  it('should return zero if no items in the cache', () => {
    const lru = LRU(redis, 2);

    return lru.count()
      .then((r) => assert.equal(r, 0));
  });

  it('should return the amount of items in the cache', () => {
    const lru = LRU(redis, 2);

    return lru.set('k1', 'v1')
      .then(tick)
      .then(() => lru.set('k2', 'v2'))
      .then(() => lru.count())
      .then((r) => assert.equal(r, 2));
  });

  it('should return the max size if cache size exceeded before', () => {
    const lru = LRU(redis, 2);

    return lru.set('k1', 'v1')
      .then(tick)
      .then(() => lru.set('k2', 'v2'))
      .then(tick)
      .then(() => lru.set('k3', 'v3'))
      .then(() => lru.count())
      .then((r) => assert.equal(r, 2));
  });
});

describe('maxAge option', () => {
  it('should return null after global maxAge has passed', () => {
    const lru = LRU(redis, {max: 2, maxAge: 10});

    return lru.set('k1', 'v1')
      .then(() => lru.get('k1'))
      .then((result) => assert.equal(result, 'v1'))
      .then(() => tick(11))
      .then(() => lru.get('k1'))
      .then((result) => assert.equal(result, null));
  });

  it('should return null after key maxAge has passed', () => {
    const lru = LRU(redis, {max: 2});

    return lru.set('k1', 'v1', 10)
      .then(() => lru.get('k1'))
      .then((result) => assert.equal(result, 'v1'))
      .then(() => tick(11))
      .then(() => lru.get('k1'))
      .then((result) => assert.equal(result, null));
  });

  it('should reduce dbsize after key expiration', () => {
    const lru = LRU(redis, {max: 2, maxAge: 10});

    return lru.set('k1', 'v1')
      .then(dbsize)
      .then((size) => assert.equal(size, 2))
      .then(() => tick(11))
      .then(() => lru.get('k1'))
      .then((result) => assert.equal(result, null))
      .then(dbsize)
      .then((size) => assert.equal(size, 0)); // zset doesnt count if empty
  });

  it('should remove expired key from index next time is getted', () => {
    const lru = LRU(redis, {max: 2});

    return lru.set('k1', 'v1')
      .then(() => lru.set('k2', 'v2', 10))
      .then(() => tick(11))
      .then(() => lru.get('k2'))
      .then((result) => assert.equal(result, null))
      .then(() => lru.count())
      .then((count) => assert.equal(count, 1))
      .then(() => lru.keys())
      .then((keys) => assert.deepEqual(keys, ['k1']));
  });

  it('should remove expired key from index next time is peeked', () => {
    const lru = LRU(redis, {max: 2});

    return lru.set('k1', 'v1')
      .then(() => lru.set('k2', 'v2', 10))
      .then(() => tick(11))
      .then(() => lru.peek('k2'))
      .then((result) => assert.equal(result, null))
      .then(() => lru.count())
      .then((count) => assert.equal(count, 1))
      .then(() => lru.keys())
      .then((keys) => assert.deepEqual(keys, ['k1']));
  });

  it('should not let key maxAge affect other keys', () => {
    const lru = LRU(redis, {max: 2, maxAge: 30});

    return lru.set('k1', 'v1', 10)
      .then(() => lru.set('k2', 'v2'))
      .then(() => lru.get('k1'))
      .then((result) => assert.equal(result, 'v1'))
      .then(() => lru.get('k2'))
      .then((result) => assert.equal(result, 'v2'))
      .then(() => tick(11))
      .then(() => lru.get('k1'))
      .then((result) => assert.equal(result, null))
      .then(() => lru.get('k2'))
      .then((result) => assert.equal(result, 'v2'))
      .then(() => tick(20))
      .then(() => lru.get('k2'))
      .then((result) => assert.equal(result, null));
  });

  it('should return false when calling has on an expired item', () => {
    const lru = LRU(redis, {max: 2, maxAge: 10});

    return lru.set('k1', 'v1')
      .then(() => lru.has('k1'))
      .then((result) => assert.equal(result, true))
      .then(() => tick(11))
      .then(() => lru.has('k1'))
      .then((result) => assert.equal(result, false));
  });
});

describe('custom score/increment options', () => {
  it('should allow building a LFU cache with a custom score and increment', () => {
    const lfu = LRU(redis, {max: 3, score: () => 1, increment: true});

    return lfu.set('k1', 'v1')
      .then(() => lfu.get('k1'))
      .then(() => lfu.get('k1')) // k1 used three times
      .then(() => lfu.set('k2', 'v2'))
      .then(() => lfu.set('k2', 'v22')) // k2 used 2 times
      .then(() => lfu.set('k3', 'v3'))
      .then(() => lfu.set('k4', 'v4')) // k3 should be removed
      .then(() => lfu.get('k3'))
      .then((result) => assert.equal(result, null))
      .then(() => lfu.keys())
      .then((keys) => assert.deepEqual(keys, ['k1', 'k2', 'k4']));
  });
});
