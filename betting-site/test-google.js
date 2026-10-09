// 구글 로그인(가짜 tokeninfo 서버 사용) + 닉네임 + 채팅 테스트
const assert = require('node:assert');
const http = require('node:http');
const fake = http.createServer((req, res) => {
  const t = new URL(req.url, 'http://x').searchParams.get('id_token');
  const m = /^good-(\w+)$/.exec(t) || /^wrongaud-(\w+)$/.exec(t);
  if (!m) { res.writeHead(400); return res.end('{}'); }
  res.end(JSON.stringify({ aud: t.startsWith('wrongaud') ? 'other' : 'cid', iss: 'https://accounts.google.com', sub: m[1], exp: String(Math.floor(Date.now() / 1000) + 3600) }));
});
fake.listen(0, () => {
  process.env.DB_FILE = ':memory:';
  process.env.GOOGLE_CLIENT_ID = 'cid';
  process.env.GOOGLE_TOKENINFO_URL = `http://localhost:${fake.address().port}/tokeninfo`;
  const { server } = require('./server');
  server.listen(0, async () => {
    const base = `http://localhost:${server.address().port}`;
    const call = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json() }; };
    try {
      assert.equal((await call('GET', '/api/config')).j.google_client_id, 'cid');
      assert.equal((await call('POST', '/api/google', { credential: 'bad' })).s, 401, '가짜 토큰');
      assert.equal((await call('POST', '/api/google', { credential: 'wrongaud-x' })).s, 401, '다른 앱용 토큰');
      // 첫 로그인 → 닉네임 필요
      const g1 = (await call('POST', '/api/google', { credential: 'good-u1' })).j;
      assert.ok(g1.needs_nickname && g1.pending);
      assert.equal((await call('POST', '/api/google/signup', { pending: g1.pending, name: '' })).s, 400);
      const t1 = (await call('POST', '/api/google/signup', { pending: g1.pending, name: '민수' })).j.token;
      assert.equal((await call('GET', '/api/me', null, t1)).j.points, 1000);
      assert.equal((await call('POST', '/api/google/signup', { pending: g1.pending, name: '또' })).s, 400, '임시토큰 재사용 금지');
      // 같은 구글 계정으로 다시 로그인 → 같은 계정
      const again = (await call('POST', '/api/google', { credential: 'good-u1' })).j;
      assert.ok(again.token && !again.needs_nickname);
      assert.equal((await call('GET', '/api/me', null, again.token)).j.name, '민수');
      // 닉네임 중복 방지 + 변경
      const g2 = (await call('POST', '/api/google', { credential: 'good-u2' })).j;
      assert.equal((await call('POST', '/api/google/signup', { pending: g2.pending, name: '민수' })).s, 409);
      const t2 = (await call('POST', '/api/google/signup', { pending: g2.pending, name: '지은' })).j.token;
      assert.equal((await call('POST', '/api/nickname', { name: '민수' }, t2)).s, 409);
      assert.equal((await call('POST', '/api/nickname', { name: '지은이' }, t2)).s, 200);
      assert.equal((await call('GET', '/api/me', null, t2)).j.name, '지은이');
      // 구글 계정은 PIN 로그인 불가
      assert.equal((await call('POST', '/api/login', { name: '민수', pin: '0000' })).s, 401);
      // 채팅
      assert.equal((await call('GET', '/api/chat')).s, 401);
      assert.equal((await call('POST', '/api/chat', { text: '안녕' }, t1)).s, 200);
      assert.equal((await call('POST', '/api/chat', { text: '연타' }, t1)).s, 429, '도배 방지');
      assert.equal((await call('POST', '/api/chat', { text: 'x'.repeat(201) }, t2)).s, 400);
      assert.equal((await call('POST', '/api/chat', { text: '<b>hi</b>' }, t2)).s, 200);
      const log = (await call('GET', '/api/chat', null, t2)).j;
      assert.deepEqual(log.map((m) => [m.name, m.mine]), [['민수', false], ['지은이', true]]);
      assert.equal((await call('GET', `/api/chat?after=${log[0].id}`, null, t1)).j.length, 1);
      console.log('구글/닉네임/채팅 테스트 통과');
    } catch (e) { console.error(e); process.exitCode = 1; }
    server.close(); fake.close();
  });
});
