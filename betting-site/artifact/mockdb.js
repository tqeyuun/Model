// 아티팩트 db 의 가짜 구현 (테스트 전용): 여러 사람이 같은 저장소를 보고, 바뀌면 구독자에게 알림, acquire 임대 지원
function createStore() {
  const docs = new Map();            // path -> { data, version }
  const leases = new Map();          // path -> { holder, exp }
  const listeners = new Set();       // { match(), notify() }
  const state = { calls: 0 };
  const parent = (p) => p.split('/').slice(0, -1).join('/');
  const idOf = (p) => p.split('/').pop();
  const snapDoc = (p) => { const d = docs.get(p); return { id: idOf(p), exists: !!d, data: () => (d ? JSON.parse(JSON.stringify(d.data)) : undefined), metadata: { fromCache: false, hasPendingWrites: false } }; };
  function notifyAll() { listeners.forEach((l) => l.check()); }
  function runQuery(coll, filters, order, lim) {
    let list = [...docs.keys()].filter((p) => parent(p) === coll);
    list = list.filter((p) => filters.every(([f, op, v]) => { const x = docs.get(p).data[f]; return op === '==' ? x === v : op === '!=' ? x !== v : op === '<' ? x < v : op === '<=' ? x <= v : op === '>' ? x > v : op === '>=' ? x >= v : op === 'in' ? v.includes(x) : true; }));
    if (order) list.sort((a, b) => { const x = docs.get(a).data[order[0]], y = docs.get(b).data[order[0]]; return (x < y ? -1 : x > y ? 1 : 0) * (order[1] === 'desc' ? -1 : 1); });
    else list.sort();
    if (lim) list = list.slice(0, lim);
    return list;
  }
  function viewer(opts = {}) {
    const latency = opts.latency ?? 0, who = opts.name || 'v';
    const delay = () => new Promise((r) => setTimeout(r, latency ? Math.random() * latency : 0));
    function docRef(path) {
      return {
        id: idOf(path), path,
        async get() { state.calls++; await delay(); return snapDoc(path); },
        async set(data) { state.calls++; await delay(); if (!data || typeof data !== 'object' || Array.isArray(data)) throw { code: 'invalid_argument' }; docs.set(path, { data: JSON.parse(JSON.stringify(data)), version: (docs.get(path)?.version || 0) + 1 }); notifyAll(); },
        async update(data) { state.calls++; await delay(); const d = docs.get(path); if (!d) throw { code: 'invalid_argument' }; Object.assign(d.data, JSON.parse(JSON.stringify(data))); d.version++; notifyAll(); },
        async delete() { state.calls++; await delay(); docs.delete(path); notifyAll(); },
        async acquire({ holder, ttlMs = 30000 }) {
          state.calls++; await delay();
          const l = leases.get(path), t = Date.now();
          if (l && l.exp > t && l.holder !== holder) return { acquired: false, expiresAt: new Date(l.exp).toISOString() };
          leases.set(path, { holder, exp: t + Math.max(1000, Math.min(ttlMs, 600000)) });
          return { acquired: true, holder, version: 1, expiresAt: new Date(leases.get(path).exp).toISOString() };
        },
        onSnapshot(next) {
          let last = null, dead = false;
          const check = () => { const cur = snapDoc(path); const s = JSON.stringify(cur.data()); if (s !== last) { last = s; setTimeout(() => { if (!dead) next(cur); }, latency ? Math.random() * latency : 0); } };
          const l = { check }; listeners.add(l); setTimeout(() => { if (!dead) { last = null; check(); } }, 0);
          return () => { dead = true; listeners.delete(l); };
        },
        collection: (p) => collRef(path + '/' + p),
      };
    }
    function queryRef(coll, filters = [], order = null, lim = 0) {
      const q = {
        where: (f, op, v) => queryRef(coll, [...filters, [f, op, v]], order, lim),
        orderBy: (f, dir = 'asc') => queryRef(coll, filters, [f, dir], lim),
        limit: (n) => queryRef(coll, filters, order, n),
        async get() { state.calls++; await delay(); const ps = runQuery(coll, filters, order, lim); return { docs: ps.map(snapDoc), size: ps.length, empty: !ps.length }; },
        onSnapshot(next) {
          let prev = new Map(), dead = false, first = true;
          const check = () => {
            const ps = runQuery(coll, filters, order, lim), cur = new Map(ps.map((p) => [p, JSON.stringify(docs.get(p).data)]));
            const changes = [];
            for (const [p, s] of cur) if (!prev.has(p)) changes.push({ type: 'added', doc: snapDoc(p) }); else if (prev.get(p) !== s) changes.push({ type: 'modified', doc: snapDoc(p) });
            for (const [p] of prev) if (!cur.has(p)) changes.push({ type: 'removed', doc: { id: idOf(p), exists: true, data: () => JSON.parse(prev.get(p)) } });
            prev = cur;
            if (changes.length || first) { first = false; const snap = { docs: ps.map(snapDoc), size: ps.length, empty: !ps.length, docChanges: () => changes }; setTimeout(() => { if (!dead) next(snap); }, latency ? Math.random() * latency : 0); }
          };
          const l = { check }; listeners.add(l); setTimeout(check, 0);
          return () => { dead = true; listeners.delete(l); };
        },
      };
      return q;
    }
    function collRef(path) {
      const q = queryRef(path);
      return Object.assign(q, { path, doc: (id) => docRef(path + '/' + (id || 'auto' + Math.random().toString(36).slice(2, 10))), async add(data) { const r = this.doc(); await r.set(data); return r; } });
    }
    return { doc: docRef, collection: collRef };
  }
  return { viewer, docs, state };
}
module.exports = { createStore };
