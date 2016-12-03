'use strict';

// none of the redis mock modules properly support zsets, so here goes a quick & dirty one

let db = {};

const redisMock = {
  get: (key, cb) => cb(null, db[key] || null),
  set: (key, value, cb) => {
    db[key] = value;
    cb(null);
  },
  del: (key, cb) => {
    const keys = Array.isArray(key) && key || [key];
    keys.forEach((k) => {
      delete db[k];
    });
    cb(null);
  },

  zadd: function (key, xx, score, member, cb) {
    let optXX = xx && typeof xx === 'string' && xx.toLowerCase() === 'xx';
    if (!optXX) {
      cb = member;
      member = score;
      score = xx;
    }

    db[key] = db[key] || [];

    const index = db[key].findIndex((item) => item.member === member);
    if (index !== -1) {
      db[key][index] = {member, score};
    } else if (!optXX) {
      db[key].push({member, score});
    }

    db[key] = db[key].sort((a, b) => a.score - b.score);
    cb(null);
  },

  zrange: (key, start, end, cb) => {
    if (end === -1) {
      end = Infinity;
    } else {
      end = end + 1;
    }

    const result = (db[key] || []).slice(start, end).map((item) => item.member);
    return cb(null, result);
  },

  zscore: (key, member, cb) => {
    const item = db[key] && db[key].find((i) => i.member === member);
    cb(null, item && item.score || null);
  },

  zcard: (key, cb) => cb(null, db[key] && db[key].length || 0),

  zrem: (key, member, cb) => {
    const members = Array.isArray(member) && member || [member];

    members.forEach((m) => {
      db[key] = db[key].filter((item) => item.member !== m);
    });

    cb(null);
  },

  multi: function () {
    const client = this;
    const results = [];

    const multiObj = {};

    function callOnClient (method) {
      const args = [...arguments].slice(1);
      args.push((e, res) => results.push(res));
      client[method].apply(client, args);

      return multiObj;
    }

    multiObj.get = (key) => callOnClient('get', key);
    multiObj.set = (key, value) => callOnClient('set', key, value);
    multiObj.del = (key) => callOnClient('del', key);
    multiObj.zadd = (key, xx, score, member) => {
      if (member) {
        return callOnClient('zadd', key, xx, score, member);
      } else {
        return callOnClient('zadd', key, xx, score);
      }
    };
    multiObj.zrange = (key, start, end) => callOnClient('zrange', key, start, end);
    multiObj.zrem = (key, member) => callOnClient('zrem', key, member);
    multiObj.exec = (cb) => cb(null, results);

    return multiObj;
  },

  flushdb: (cb) => {
    db = {};
    cb(null);
  },
  dbsize: (cb) => cb(null, Object.keys(db).length)
};

module.exports = redisMock;
