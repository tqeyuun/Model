// PIN이 같은 사람끼리만 같은 방: 도박·채팅·가위바위보·랭킹이 방별로 분리되는지 검증
process.env.DB_FILE = ':memory:';
const assert = require('node:assert');
const { server, db, ADMIN_KEY } = require('./server');
server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const call = async (m, p, b, t, extra = {}) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...extra }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json() }; };
  const mk = async (name, pin) => (await call('POST', '/api/signup', { name, pin })).j.token;
  const ids = async (t) => (await call('GET', '/api/bets', null, t)).j.map((b) => b.title);
  try {
    const [a1, a2] = [await mk('에이원', '1111'), await mk('에이투', '1111')];
    const [b1, b2] = [await mk('비원', '2222'), await mk('비투', '2222')];
    assert.equal((await call('GET', '/api/me', null, a1)).j.group_size, 2);

    // 도박: 같은 PIN끼리만 보임
    const bet = (await call('POST', '/api/bets', { title: 'A방 도박', options: ['x', 'y'] }, a1)).j;
    assert.deepEqual(await ids(a2), ['A방 도박']);
    assert.deepEqual(await ids(b1), [], '다른 PIN 방의 도박은 안 보임');
    assert.equal((await call('POST', '/api/wager', { option_id: bet.options[0].id, amount: 100 }, a2)).s, 200);
    assert.equal((await call('POST', '/api/wager', { option_id: bet.options[0].id, amount: 100 }, b1)).s, 404, '직접 호출해도 다른 방 도박엔 못 걸음');
    assert.equal((await call('GET', `/api/chat?bet=${bet.id}`, null, b1)).s, 404, '다른 방 채팅 읽기 금지');
    assert.equal((await call('POST', '/api/chat', { bet_id: bet.id, text: '훔쳐보기' }, b1)).s, 404, '다른 방 채팅 쓰기 금지');
    assert.equal((await call('POST', '/api/chat', { bet_id: bet.id, text: '안녕' }, a2)).s, 200);
    assert.equal((await call('GET', `/api/chat?bet=${bet.id}`, null, a1)).j.length, 1);
    assert.equal((await call('POST', '/api/bets/action', { bet_id: bet.id, action: 'cancel' }, b1)).s, 403, '남의 방 도박은 건드릴 수 없음');
    assert.equal((await call('POST', '/api/bets', { title: 'B방 도박', options: ['x', 'y'] }, b1)).s, 200);
    assert.deepEqual(await ids(b2), ['B방 도박']);
    assert.deepEqual(await ids(a1), ['A방 도박']);

    // 랭킹: 같은 방만
    assert.deepEqual((await call('GET', '/api/ranking', null, a1)).j.map((r) => r.name).sort(), ['에이원', '에이투']);
    assert.deepEqual((await call('GET', '/api/ranking', null, b1)).j.map((r) => r.name).sort(), ['비원', '비투']);

    // 가위바위보: 같은 방만 보이고, 다른 방 방에는 못 들어옴
    const room = (await call('POST', '/api/rps/create', { hand: 'rock', stake: 100 }, a1)).j;
    assert.equal((await call('GET', '/api/rps', null, a2)).j.rooms.length, 1);
    assert.equal((await call('GET', '/api/rps', null, b1)).j.rooms.length, 0, '다른 방의 가위바위보는 안 보임');
    assert.equal((await call('POST', '/api/rps/join', { room_id: room.id, hand: 'paper' }, b1)).s, 404, '직접 호출해도 다른 방엔 못 들어옴');
    assert.equal((await call('POST', '/api/rps/join', { room_id: room.id, hand: 'paper' }, a2)).s, 200);
    assert.equal((await call('GET', '/api/rps', null, a1)).j.recent.length, 1);
    assert.equal((await call('GET', '/api/rps', null, b1)).j.recent.length, 0);

    // 로그인: 같은 닉네임+PIN이면 같은 방으로 다시 들어옴, 방은 PIN에서 결정
    const re = (await call('POST', '/api/enter', { room: '1111', name: '에이원', pin: '1111' })).j.token;
    assert.deepEqual(await ids(re), ['A방 도박']);
    assert.equal((await call('POST', '/api/enter', { room: '1111', name: '에이원', pin: '2222' })).s, 401, 'PIN이 다르면 로그인 안 됨');
    assert.equal((await call('POST', '/api/enter', { room: '2222', name: '에이원', pin: '1111' })).j.new_user, true, '다른 방에는 그 닉네임이 없으니 새 계정 (한 사람이 여러 계정을 써도 됨)');

    // 관리자: 모든 방을 보고, PIN을 바꿔주면 그 사람의 방이 바뀜
    const adm = (m, p, b) => call(m, p, b, null, { 'X-Admin-Key': ADMIN_KEY });
    const ov = (await adm('GET', '/api/admin/overview')).j;
    assert.equal(ov.users.length, 4);
    assert.equal(new Set(ov.users.map((u) => u.grp)).size, 2, '관리자 화면에서 방이 구분돼 보임');
    const a2id = ov.users.find((u) => u.name === '에이투').id;
    await adm('POST', '/api/admin/user', { user_id: a2id, action: 'reset_pin', value: '2222' });
    const a2new = (await call('POST', '/api/login', { room: '1111', name: '에이투', pin: '2222' })).j.token;
    assert.deepEqual(await ids(a2new), ['A방 도박'], 'PIN만 바뀌고 방은 그대로(A방)');
    await adm('POST', '/api/admin/user', { user_id: a2id, action: 'move_room', value: '2222' });
    assert.deepEqual(await ids(a2new), ['B방 도박'], '방 변경 → B방으로 이동');
    console.log('방 분리 테스트 통과');
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();
});
