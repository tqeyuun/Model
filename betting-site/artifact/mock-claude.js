// 브라우저에서 아티팩트의 window.claude(db, user)를 흉내 냄 (테스트 전용). 저장소는 Node 쪽 서버(e2e.js)가 가짐.
(function () {
  const q = new URLSearchParams(location.search), uid = q.get('uid') || 'u_default_viewer_000', owner = q.get('owner') === '1';
  const op = (o) => fetch('/__db', { method: 'POST', body: JSON.stringify(o) }).then((r) => r.json());
  const wrap = (d) => ({ id: d.id, exists: d.exists, data: () => d.data, metadata: { fromCache: false, hasPendingWrites: false } });
  function poll(get, next, keyOf) {
    let prev = new Map(), first = true, dead = false;
    const tick = async () => {
      if (dead) return;
      try {
        const docs = await get(), cur = new Map(docs.map((d) => [d.id, JSON.stringify(d.data)])), ch = [];
        for (const d of docs) { if (!prev.has(d.id)) ch.push({ type: 'added', doc: wrap(d) }); else if (prev.get(d.id) !== cur.get(d.id)) ch.push({ type: 'modified', doc: wrap(d) }); }
        for (const [id, s] of prev) if (!cur.has(id)) ch.push({ type: 'removed', doc: { id, exists: true, data: () => JSON.parse(s) } });
        prev = cur;
        if (ch.length || first) { first = false; next({ docs: docs.map(wrap), size: docs.length, empty: !docs.length, docChanges: () => ch }); }
      } catch (e) { /* 다음 주기에 */ }
      setTimeout(tick, 150);
    };
    tick(); return () => { dead = true; };
  }
  function docRef(path) {
    return {
      id: path.split('/').pop(), path,
      get: async () => wrap(await op({ k: 'get', path })),
      set: (data) => op({ k: 'set', path, data }), update: (data) => op({ k: 'update', path, data }), delete: () => op({ k: 'delete', path }),
      acquire: (o) => op({ k: 'acquire', path, o }),
      onSnapshot(next) { let first = true, last = null, dead = false; const t = async () => { if (dead) return; const s = JSON.stringify((await op({ k: 'get', path })).data); if (s !== last || first) { last = s; first = false; next(wrap(await op({ k: 'get', path }))); } setTimeout(t, 200); }; t(); return () => { dead = true; }; },
      collection: (p) => collRef(path + '/' + p),
    };
  }
  function query(coll, filters = [], order = null, lim = 0) {
    const get = async () => (await op({ k: 'query', coll, filters, order, lim })).docs;
    return {
      where: (f, o, v) => query(coll, [...filters, [f, o, v]], order, lim), orderBy: (f, d = 'asc') => query(coll, filters, [f, d], lim), limit: (n) => query(coll, filters, order, n),
      get: async () => { const docs = await get(); return { docs: docs.map(wrap), size: docs.length, empty: !docs.length }; },
      onSnapshot: (next) => poll(get, next),
    };
  }
  function collRef(path) { return Object.assign(query(path), { path, doc: (id) => docRef(path + '/' + (id || 'a' + Math.random().toString(36).slice(2, 10))) }); }
  const DB = { doc: docRef, collection: collRef };
  const USER = { id: async () => uid, isOwner: async () => owner, canEdit: async () => owner, can: async () => true, me: async () => ({ id: uid, name: '', isOwner: owner }), profiles: async () => ({}) };
  window.claude = { use: async (n) => (n === 'db' ? DB : n === 'user' ? USER : null) };
})();
