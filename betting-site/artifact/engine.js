/**
 * 아티팩트용 저장소 엔진.
 * 구글 앱스 스크립트 버전의 규칙 코드(Code.gs)를 그대로 쓰고, 시트 대신 아티팩트의 공유 DB(claude.use('db'))에 저장합니다.
 *
 * - 읽기: 실시간 구독으로 유지되는 메모리 사본에서 바로 (빠름)
 * - 쓰기(POST): DB 의 짧은 임대(acquire)로 한 번에 한 사람씩 → 최신 상태로 맞춘 뒤 규칙 실행 → 바뀐 문서만 저장
 * - 채팅은 새 문서를 추가할 뿐이라 임대 없이 바로 저장
 */
(function (root) {
  'use strict';
  var PERSIST = ['users', 'bets', 'options', 'wagers', 'items', 'rooms', 'rps', 'lun', 'lunp', 'lad', 'ladp', 'bj', 'slots', 'bb', 'bbr', 'bbrp', 'drops', 'dropc', 'begs', 'begg'];
  var LOCAL = ['sessions'];                       // 이 브라우저에만 있는 표 (로그인 표시)
  var MESSAGES = 'messages';                      // 채팅: 최근 것만 구독, 임대 없이 추가
  var MSG_LIMIT = 400;
  var LEASE_MS = 1200;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function byId(a, b) { return a.id - b.id; }

  function Engine(opts) {
    var self = this;
    this.db = opts.db;
    this.uid = opts.uid;                          // 이 사람의 아이디 (user.id())
    this.isOwner = !!opts.isOwner;
    this.makeGS = opts.makeGS;                    // (ctx) => 규칙 코드 모듈
    this.tables = {};                             // name -> { map: Map(key -> row), arr: [row...] }
    this.dirty = new Map();                       // 'table/key' -> { table, key, data|null }
    this.pendingKeys = new Set();                 // 저장 중인 문서는 구독이 덮어쓰지 않게
    this.listeners = [];
    this.unsubs = [];
    this.settingsJson = '';
    this.settingsWrite = null;
    this.leaseHeld = false;
    this.needLock = false;
    this.rev = 0;
    this.lastFull = 0;
    this.ready = false;
    this.queue = Promise.resolve();               // 이 브라우저 안에서도 쓰기는 한 줄로
    PERSIST.concat(LOCAL, [MESSAGES]).forEach(function (n) { self.tables[n] = { map: new Map(), arr: [] }; });
    this.msgSeq = 0;

    var ctx = {
      rows: function (name) { return self._rows(name); },
      nextId: function (name) { return self._nextId(name); },
      add: function (name, row) { self._add(name, row); },
      touch: function (name, row) { self._touch(name, row); },
      del: function (name, row) { self._del(name, row); },
      isOwner: function () { return self.isOwner; },
      lockOk: function () { if (self.leaseHeld) return true; self.needLock = true; return false; },
      getProp: function (k) { return k === 'SETTINGS' ? self.settingsJson : undefined; },
      setProp: function (k, v) { if (k === 'SETTINGS') { self.settingsJson = v; self.settingsWrite = v; } },
    };
    this.ctx = ctx;
    this.gs = this.makeGS(ctx);
  }

  /* ---------- 메모리 사본 ---------- */
  Engine.prototype._rows = function (name) {
    var t = this.tables[name]; if (!t) throw new Error('없는 표: ' + name);
    if (t.unsorted) { t.arr.sort(byId); t.unsorted = false; }   // 한꺼번에 받은 문서는 읽을 때 한 번만 정렬 (넣을 때마다 정렬하면 2만 건에 4초)
    return t.arr;
  };
  Engine.prototype._keyOf = function (name, row) {
    if (name === 'items') return row.user_id + '_' + row.item_id;
    return String(row.id);
  };
  Engine.prototype._nextId = function (name) {
    if (name === MESSAGES) return Date.now() * 1000 + (this.msgSeq = (this.msgSeq + 1) % 1000);   // 임대 없이 쓰므로 겹치지 않게 시간 기반
    var m = 0; this.tables[name].arr.forEach(function (r) { if (r.id > m) m = r.id; });
    return m + 1;
  };
  Engine.prototype._sortedInsert = function (name, row) {
    var t = this.tables[name]; t.arr.push(row);
    if (name !== 'items' && t.arr.length > 1 && t.arr[t.arr.length - 2].id > row.id) t.unsorted = true;
  };
  Engine.prototype._add = function (name, row) {
    var key = this._keyOf(name, row); row._key = key;
    var t = this.tables[name], old = t.map.get(key);
    if (old && old !== row) { var i = t.arr.indexOf(old); if (i >= 0) t.arr.splice(i, 1); }
    t.map.set(key, row); this._sortedInsert(name, row);
    this._mark(name, row);
  };
  Engine.prototype._touch = function (name, row) { if (!row._key) row._key = this._keyOf(name, row); this._mark(name, row); };
  Engine.prototype._del = function (name, row) {
    var t = this.tables[name], key = row._key || this._keyOf(name, row), cur = t.map.get(key);
    if (cur) { var i = t.arr.indexOf(cur); if (i >= 0) t.arr.splice(i, 1); t.map.delete(key); }
    if (LOCAL.indexOf(name) < 0) { this.dirty.set(name + '/' + key, { table: name, key: key, data: null }); }
  };
  Engine.prototype._mark = function (name, row) {
    if (LOCAL.indexOf(name) >= 0) return;
    var data = {}; Object.keys(row).forEach(function (k) { if (k !== '_key' && row[k] !== undefined) data[k] = row[k]; });
    this.dirty.set(name + '/' + row._key, { table: name, key: row._key, data: clone(data) });
  };
  /** 서버에서 온 문서를 사본에 반영 (같은 행 객체를 계속 쓰도록 안쪽만 바꿈) */
  Engine.prototype._apply = function (name, key, data) {
    var t = this.tables[name]; if (!t) return;
    if (this.pendingKeys.has(name + '/' + key)) return;   // 내가 저장 중인 건 내 값을 유지
    var cur = t.map.get(key);
    if (data === null) { if (cur) { var i = t.arr.indexOf(cur); if (i >= 0) t.arr.splice(i, 1); t.map.delete(key); } return; }
    if (cur) { Object.keys(cur).forEach(function (k) { delete cur[k]; }); Object.assign(cur, data); cur._key = key; }
    else { var row = Object.assign({}, data, { _key: key }); t.map.set(key, row); this._sortedInsert(name, row); }
  };
  Engine.prototype._replaceAll = function (name, docs, truncated) {
    var self = this, seen = new Set();
    docs.forEach(function (d) { seen.add(d.id); self._apply(name, d.id, d.data()); });
    if (truncated) return;     // 1000개를 꽉 채워 받았으면 일부만 본 것일 수 있어 지우지 않음 (구독이 채워 줌)
    var t = this.tables[name];
    Array.from(t.map.keys()).forEach(function (k) { if (!seen.has(k) && !self.pendingKeys.has(name + '/' + k)) self._apply(name, k, null); });
  };
  Engine.prototype._emit = function () { var self = this; if (this._emitT) return; this._emitT = setTimeout(function () { self._emitT = null; self.listeners.forEach(function (f) { try { f(); } catch (e) { /* 무시 */ } }); }, 60); };
  Engine.prototype.onChange = function (f) { this.listeners.push(f); };

  /* ---------- 시작: 구독 ---------- */
  Engine.prototype.start = function () {
    var self = this, db = this.db, waits = [];
    function sub(name, query) {
      var first = true, resolve; var p = new Promise(function (r) { resolve = r; });
      var un = query.onSnapshot(function (snap) {
        snap.docChanges().forEach(function (c) { self._apply(name, c.doc.id, c.type === 'removed' ? null : clone(c.doc.data())); });
        if (first) { first = false; resolve(); } else self._emit();
      }, function () { if (first) { first = false; resolve(); } });
      self.unsubs.push(un); waits.push(p);
    }
    PERSIST.forEach(function (n) { sub(n, db.collection(n)); });
    sub(MESSAGES, db.collection(MESSAGES).orderBy('created_at', 'desc').limit(MSG_LIMIT));
    var pc = new Promise(function (resolve) {
      var first = true;
      self.unsubs.push(db.doc('config/settings').onSnapshot(function (s) {
        self.settingsJson = s.exists && s.data().json ? String(s.data().json) : '';
        if (first) { first = false; resolve(); } else self._emit();
      }, function () { if (first) { first = false; resolve(); } }));
    });
    waits.push(pc);
    return Promise.all(waits).then(function () {
      return db.doc('meta/rev').get();
    }).then(function (s) { self.rev = s.exists ? s.data().n : 0; self.lastFull = Date.now(); self.ready = true; });
  };
  Engine.prototype.stop = function () { this.unsubs.forEach(function (u) { try { u(); } catch (e) { /* 무시 */ } }); this.unsubs = []; };

  /* ---------- 임대(한 번에 한 사람씩 쓰기) ---------- */
  Engine.prototype._lease = function () {
    var self = this;
    return (async function () {
      for (var tries = 0; tries < 40; tries++) {
        var r = await self.db.doc('locks/main').acquire({ holder: self.uid, ttlMs: LEASE_MS });
        if (r.acquired) return;
        var wait = r.expiresAt ? Date.parse(r.expiresAt) - Date.now() : 300;
        await sleep(Math.min(Math.max(wait, 80), 2000) + Math.random() * 80);
      }
      throw new Error('다른 사람이 처리 중입니다. 잠시 뒤 다시 해주십시오.');
    })();
  };
  Engine.prototype._fresh = async function () {
    var self = this, s = await this.db.doc('meta/rev').get(), rev = s.exists ? s.data() : { n: 0, tables: [] };
    var full = Date.now() - this.lastFull > 60000;
    if (rev.n === this.rev && !full) return;
    var names = rev.n === this.rev + 1 && rev.tables && !full ? rev.tables.filter(function (n) { return PERSIST.indexOf(n) >= 0; }) : PERSIST;
    await Promise.all(names.map(async function (n) { var snap = await self.db.collection(n).limit(1000).get(); self._replaceAll(n, snap.docs, snap.docs.length >= 1000); }));
    this.rev = rev.n; if (names === PERSIST) this.lastFull = Date.now();
  };
  Engine.prototype._flush = async function () {
    var self = this, items = Array.from(this.dirty.values()), tables = {};
    this.dirty.clear();
    items.forEach(function (e) { self.pendingKeys.add(e.table + '/' + e.key); tables[e.table] = 1; });
    var i = 0, err = null;
    async function worker() {
      while (i < items.length) {
        var e = items[i++];
        try {
          var ref = self.db.collection(e.table).doc(e.key);
          if (e.data) await ref.set(e.data); else await ref.delete();
        } catch (x) { err = err || x; }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker(), worker()]);
    items.forEach(function (e) { self.pendingKeys.delete(e.table + '/' + e.key); });
    if (self.settingsWrite !== null) { var v = self.settingsWrite; self.settingsWrite = null; try { await self.db.doc('config/settings').set({ json: v }); } catch (x) { err = err || x; } }
    return { tables: Object.keys(tables), err: err };
  };

  /* ---------- 호출 (화면의 api() 가 부름) ---------- */
  Engine.prototype._run = function (token, method, url, body) {
    return JSON.parse(this.gs.handle(token, '', method, url, body || {}));
  };
  Engine.prototype.call = function (token, method, url, body) {
    var self = this;
    var p = this._call(token, method, url, body || {});
    return p;
  };
  Engine.prototype._isLeaseFree = function (method, url) { return method === 'POST' && /^\/api\/chat(\?|$)/.test(url); };
  Engine.prototype._call = async function (token, method, url, body) {
    var self = this;
    if (!this.ready) return { error: '연결 중입니다. 잠시 뒤 다시 해주십시오.', code: 503 };
    // 읽기: 메모리 사본에서 바로. 정리(환불 등)가 필요하면 임대를 잡고 다시
    if (method !== 'POST') {
      this.needLock = false; this.dirty.clear();
      var out = this._run(token, method, url, body);
      if (!this.needLock) { if (this.dirty.size) await this._persistFree(); return out; }
      this.dirty.clear(); this.needLock = false;
    } else if (this._isLeaseFree(method, url)) {
      var o; this.leaseHeld = true;            // 새 문서를 추가할 뿐이라 임대 없이 (아래 실행은 중간에 멈추지 않음)
      try { o = this._run(token, method, url, body); } finally { this.leaseHeld = false; }
      await this._persistFree();
      return o;
    }
    return this._locked(token, method, url, body);
  };
  Engine.prototype._persistFree = async function () { var r = await this._flush(); if (r.err) this._emit(); };
  Engine.prototype._locked = function (token, method, url, body) {
    var self = this;
    var job = this.queue.then(async function () {
      await self._lease();
      self.leaseHeld = true;
      try {
        await self._fresh();
        self.dirty.clear();
        var out = self._run(token, method, url, body);
        if (self.dirty.size || self.settingsWrite !== null) {
          await self.db.doc('locks/main').acquire({ holder: self.uid, ttlMs: LEASE_MS });   // 저장하는 동안 임대 연장
          var r = await self._flush();
          if (r.tables.length) {
            self.rev = self.rev + 1;
            try { await self.db.doc('meta/rev').set({ n: self.rev, tables: r.tables, by: self.uid, at: Date.now() }); } catch (x) { /* 다음 호출 때 전체를 다시 읽음 */ self.rev = -1; }
          }
          if (r.err) return { error: '저장 중 문제가 생겼습니다. 새로고침 후 확인하십시오. (' + (r.err.message || r.err.code) + ')', code: 500 };
        }
        return out;
      } finally { self.leaseHeld = false; }
    });
    this.queue = job.catch(function () { /* 다음 호출은 계속 */ });
    return job.catch(function (e) { return { error: e.message || '처리하지 못했습니다.', code: 503 }; });
  };


  /* ---------- 입장: 계정 번호(user.id)로 자동 로그인, 처음이면 닉네임으로 가입 ---------- */
  var ROOM = 'dobak';
  Engine.prototype.devKey = function () { var k = String(this.uid).replace(/[^A-Za-z0-9]/g, ''); while (k.length < 16) k += '0'; return k.slice(0, 64); };
  Engine.prototype.myUser = function () { var k = this.devKey(); return this.tables.users.arr.filter(function (u) { return u.dev === k; })[0] || null; };
  Engine.prototype.enter = async function (name) {
    var mine = this.myUser(), self = this, body;
    if (!this.ready) return { error: '연결 중입니다. 잠시 뒤 다시 해주십시오.', code: 503 };
    if (mine) {      // 이미 가입한 사람: 저장 없이 로그인 표시만
      body = { room: ROOM, name: mine.name, pin: this.devKey().slice(0, 16), dev: this.devKey(), mode: 'join', create: true };
      this.needLock = false; this.leaseHeld = true;
      try { var out = this._run('', 'POST', '/api/enter', body); } finally { this.leaseHeld = false; }
      if (this.dirty.size) await this._persistFree();
      return out;
    }
    name = String(name || '').trim();
    if (this.tables.users.arr.some(function (u) { return u.name === name; })) return { error: '이미 사용 중인 닉네임입니다. 다른 닉네임을 정하십시오.', code: 409 };
    var exists = this.tables.rooms.arr.length > 0;
    body = { room: ROOM, name: name, pin: this.devKey().slice(0, 16), dev: this.devKey(), mode: exists ? 'join' : 'create', create: true };
    return this._locked('', 'POST', '/api/enter', body);
  };

  root.ArtifactEngine = Engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
