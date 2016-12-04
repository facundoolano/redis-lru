# redis lru cache

A least recently used (LRU) cache backed by Redis, allowing data to be shared by
multiple Node.JS processes. API inspired by [node-lru-cache](https://github.com/isaacs/node-lru-cache).

```js
var redis = require('redis').createClient(port, host, opts);
var lru = require('redis-lru');

var personCache = lru(5); // up to 5 items

nameCache.set('john', {name: 'John Doe', age: 27})
  .then(() => nameCache.set('jane', {name: 'Jane Doe', age: 30}))
  .then(() => nameCache.get('john'))
  .then(console.log) // prints {name: 'John Doe', age: 27}
  .then(() => nameCache.reset()) //clear the cache

var bandCache = lru({max: 2, namespace: 'bands'}); // use a different namespace

bandCache.set('beatles', 'john, paul, george, ringo')
  .then(() => bandCache.set('zeppelin', 'jimmy, robert, john, bonzo'))
  .then(() => bandCache.get('beatles')) // now beatles are the most recently accessed
  .then(console.log) // 'john, paul, george, ringo'
  .then(() => bandCache.set('floyd', 'david, roger, syd, richard, nick')) // cache full, remove least recently accessed
  .then(() => bandCache.get('zeppelin'))
  .then(console.log) // null, was evicted from cache
```

Works both with [node_redis](https://github.com/NodeRedis/node_redis) and [ioredis](https://github.com/luin/ioredis) clients.

## Installation

```
npm install redis-lru
```

## Options

* `max`: Maximum amount of items the cache can hold. This option is required; if no
other option is needed, it can be passed directly as the second parameter when creating
the cache.
* `namespace`: prefix appended to all keys saved in Redis, to avoid clashes with other applications
and to allow multiple instances of the cache.

## API

All methods return a Promise.

* `set(key, value)`: set value for the given key, marking it as the most recently accessed one.
Keys should be strings, values will be JSON.stringified.
* `get(key)`: resolve to the value stored in the cache for the given key or `null` if not present.
If present, the key will be marked as the most recently accessed one.
* `peek(key)`: resolve to the value stored in the cache for the given key, without changing its
last accessed time.
* `del(key)`: removes the item from the cache.
* `reset()`: empties the cache.
* `has(key)`: resolves to true if the given key is present in the cache.
* `keys()`: resolves to an array of keys in the cache, sorted from most to least recently accessed.
* `values()`: resolves to an array of values in the cache, sorted from most to least recently accessed.
* `count()`: resolves to the number of items currently in the cache.


## Implementation

Each item in the cache is stored as a regular key/value in Redis. Additionally,
a [ZSET](https://redis.io/topics/data-types#sorted-sets) is used to keep an
index of the keys sorted by last-accessed timestamp.

Requires Redis 3.0.2 or greater, since it uses the
[XX option of ZADD](https://redis.io/commands/zadd#zadd-options-redis-302-or-greater).
