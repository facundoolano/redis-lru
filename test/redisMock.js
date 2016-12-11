'use strict';

// none of the redis mock modules properly support zsets, so here goes a quick & dirty one

let db = {};

const redisMock = {
  get: (key, cb) => cb(null, db[key] || null),
  set: (key, value, px, ms, cb) => {
    if (!ms) {
      cb = px;
    } else if (px.toLowerCase() === 'px') {
      setTimeout(() => { delete db[key]; }, ms);
    }

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
  zadd: function (key, xx, ch, score, member, cb) {
    // BEING LAZY HERE, assuming that if XX comes in, CH comes in too, and in that order
    let optXX = xx && typeof xx === 'string' && xx.toLowerCase() === 'xx';
    if (!optXX) {
      cb = score;
      member = ch;
      score = xx;
    }

    db[key] = db[key] || [];

    let result = 0;
    const index = db[key].findIndex((item) => item.member === member);
    if (index !== -1) {
      db[key][index] = {member, score};
      result = optXX ? 1 : 0; // if XX, also assume CH, return amount changed
    } else if (!optXX) {
      db[key].push({member, score});
      result = 1; // if not XX, return amount added, always 1
    }

    db[key] = db[key].sort((a, b) => a.score - b.score);
    cb(null, result);
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

    if (!db[key].length) {
      delete db[key]; // redis seems to do this
    }

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
    multiObj.set = (key, value, px, ms) => {
      if (ms) {
        return callOnClient('set', key, value, px, ms);
      }
      return callOnClient('set', key, value);
    };
    multiObj.del = (key) => callOnClient('del', key);
    multiObj.zadd = (key, xx, ch, score, member) => {
      if (member) {
        return callOnClient('zadd', key, xx, ch, score, member);
      }
      return callOnClient('zadd', key, xx, ch);
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
