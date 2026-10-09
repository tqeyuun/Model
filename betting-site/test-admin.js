// 관리자: 설정 조절 / 게임 방 닫기 / PIN 방 삭제
process.env.DB_FILE = ':memory:';
const assert = require('node:assert');
const G = require('./games-core');
const { server, db, ADMIN_KEY, applySettings } = require('./server');
server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const call = async (m, p, b, t, key) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}), ...(key ? { 'X-Admin-Key': key } : {}) }, body: b && m !== 'GET' ? JSON.stringify(b) : undefined }); const raw = await r.text(); return { s: r.status, j: JSON.parse(raw), raw }; };
  const adm = (m, p, b) => call(m, p, b, null, ADMIN_KEY);
  const mk = async (n, pin) => (await call('POST', '/api/signup', { name: n, pin })).j.token;
  const pts = async (t) => (await call('GET', '/api/me', null, t)).j.points;
  const count = (sql, ...a) => db.prepare(sql).get(...a).n;
  try {
    const [a1, a2, a3] = [await mk('에이원', '1111'), await mk('에이투', '1111'), await mk('에이삼', '1111')];
    const [b1, b2] = [await mk('비원', '2222'), await mk('비투', '2222')];
    const sf = async () => (await adm('GET', '/api/admin/overview')).j;

    /* ---- 인증 ---- */
    for (const [m, p] of [['GET', '/api/admin/overview'], ['POST', '/api/admin/settings'], ['POST', '/api/admin/room'], ['POST', '/api/admin/group']])
      assert.equal((await call(m, p, {}, a1)).s, 403, p + ' 는 관리자 키 없이 안 됨');
    assert.equal((await call('GET', '/api/admin/overview', null, null, 'wrong')).s, 403);

    /* ---- 설정 ---- */
    let ov = await sf();
    assert.deepEqual(ov.settings.map((x) => x.key), ['solo_net_cap', 'solo_plays', 'bj_max_bet', 'slot_max_bet', 'room_stake_max', 'lucky_percent', 'shop_open']);
    const def = Object.fromEntries(ov.settings.map((x) => [x.key, x.default]));
    assert.equal(def.solo_net_cap, 500); assert.equal(def.solo_plays, 30); assert.equal(def.shop_open, false);
    for (const bad of [{ solo_net_cap: -1 }, { solo_net_cap: 1.5 }, { solo_net_cap: '100' }, { bj_max_bet: 5 }, { lucky_percent: 101 }, { shop_open: 1 }, { nope: 1 }, { room_stake_max: 9 }])
      assert.equal((await adm('POST', '/api/admin/settings', { values: bad })).s, 400, JSON.stringify(bad));
    assert.equal((await sf()).settings.find((x) => x.key === 'solo_net_cap').value, 500, '잘못된 요청은 아무것도 안 바꿈');
    assert.equal((await adm('POST', '/api/admin/settings', { values: { solo_net_cap: 120, solo_plays: 5, bj_max_bet: 200, slot_max_bet: 100, room_stake_max: 300, shop_open: true } })).s, 200);
    // 바로 게임에 반영됨
    const sl = (await call('GET', '/api/slots', null, a1)).j;
    assert.equal(sl.limits.net_cap, 120); assert.equal(sl.limits.plays_cap, 5); assert.equal(sl.max, 100);
    assert.equal((await call('GET', '/api/blackjack', null, a1)).j.rules.MAX_BET, 200);
    assert.equal((await call('POST', '/api/blackjack/start', { bet: 300 }, a1)).s, 400, '블랙잭 최대 200');
    assert.equal((await call('POST', '/api/slots/spin', { bet: 150 }, a1)).s, 400, '슬롯 최대 100');
    assert.equal((await call('POST', '/api/lun/create', { stake: 500, cap: 3, num: 1 }, a1)).s, 400, '방 판돈 최대 300');
    assert.equal((await call('POST', '/api/lun/create', { stake: 300, cap: 3, num: 1 }, a1)).s, 200);
    assert.ok((await call('GET', '/api/shop', null, a1)).j.length > 10, '상점이 열림');
    // 저장돼서 재시작해도 유지: 메모리 값을 망가뜨린 뒤 저장본으로 복원
    G.SOLO.DAILY_NET_CAP = 999; G.BJ.MAX_BET = 7; applySettings();
    assert.equal(G.SOLO.DAILY_NET_CAP, 120); assert.equal(G.BJ.MAX_BET, 200);
    // 일부만 기본값으로
    const r = (await adm('POST', '/api/admin/settings', { reset: ['solo_net_cap', 'shop_open'] })).j;
    assert.equal(r.settings.find((x) => x.key === 'solo_net_cap').value, 500); assert.equal(r.settings.find((x) => x.key === 'shop_open').value, false);
    assert.equal(r.settings.find((x) => x.key === 'solo_plays').value, 5, '나머지는 유지');
    assert.deepEqual((await call('GET', '/api/shop', null, a1)).j, [], '상점이 다시 닫힘');
    // 럭키 확률 100% → 이긴 사람 모두 보너스
    await adm('POST', '/api/admin/settings', { values: { lucky_percent: 100 } });
    const bet = (await call('POST', '/api/bets', { title: '럭키', options: ['x', 'y'] }, a1)).j;
    await call('POST', '/api/wager', { option_id: bet.options[0].id, amount: 100 }, a1); await call('POST', '/api/wager', { option_id: bet.options[1].id, amount: 100 }, a2);
    const p0 = await pts(a1);
    await call('POST', '/api/bets/action', { bet_id: bet.id, action: 'resolve', option_id: bet.options[0].id }, a1);
    assert.equal(await pts(a1) - p0, 300, '200 + 럭키 50%');
    await adm('POST', '/api/admin/settings', { values: { lucky_percent: 0, solo_plays: 30 } });
    await adm('POST', '/api/admin/settings', { reset: ['bj_max_bet', 'slot_max_bet', 'room_stake_max', 'solo_plays', 'lucky_percent'] });

    /* ---- 게임 방 ---- */
    const total0 = async () => (await Promise.all([a1, a2, a3, b1, b2].map(pts))).reduce((x, y) => x + y);
    const before = (await total0()) + 300;   // + 앞에서 연 300점 눈치게임 방에 맡겨져 있던 판돈 (이 방도 아래에서 같이 닫힘)
    const rps = (await call('POST', '/api/rps/create', { hand: 'rock', stake: 50 }, a1)).j;
    const lun = (await call('POST', '/api/lun/create', { stake: 70, cap: 4, num: 7 }, a2)).j;   // (위에서 만든 300점 방도 하나 있음)
    await call('POST', '/api/lun/join', { room_id: lun.id, num: 9 }, a3);
    const lad = (await call('POST', '/api/ladder/create', { stake: 80, slots: 3, slot: 1 }, b1)).j;
    ov = await sf();
    assert.equal(ov.rooms.length, 4, '대기 중인 방: 가위바위보 1 + 눈치게임 2(앞에서 만든 300점 방 포함) + 사다리 1');
    assert.ok(!/host_hand|"num"|"hand"|rock/.test(JSON.stringify(ov.rooms)), '관리자 화면에도 가려진 패/숫자는 안 나옴');
    const lunRoom = ov.rooms.find((x) => x.kind === 'lun' && x.id === lun.id);
    assert.deepEqual(lunRoom.players, ['에이투', '에이삼']); assert.equal(lunRoom.cap, 4);
    assert.equal((await adm('POST', '/api/admin/room', { kind: 'zzz', room_id: 1 })).s, 400);
    assert.equal((await adm('POST', '/api/admin/room', { kind: 'rps', room_id: 99999 })).s, 404);
    for (const x of ov.rooms) assert.equal((await adm('POST', '/api/admin/room', { kind: x.kind, room_id: x.id })).s, 200);
    assert.equal(await total0(), before, '방을 닫으면 판돈이 모두 돌아옴');
    assert.equal((await sf()).rooms.length, 0);
    assert.equal((await adm('POST', '/api/admin/room', { kind: 'rps', room_id: rps.id })).s, 400, '이미 닫힌 방');
    assert.equal((await call('POST', '/api/rps/join', { room_id: rps.id, hand: 'paper' }, a2)).s, 400, '닫힌 방엔 못 들어옴');

    /* ---- PIN 방 삭제 ---- */
    ov = await sf();
    assert.deepEqual(ov.groups.map((g) => [g.count, g.members.length]), [[3, 3], [2, 2]]);
    const gA = ov.groups.find((g) => g.count === 3), gB = ov.groups.find((g) => g.count === 2);
    // B 방 활동: 도박·채팅·가위바위보·눈치게임·사다리·블랙잭·슬롯
    const bBet = (await call('POST', '/api/bets', { title: 'B방 도박', options: ['x', 'y'] }, b1)).j;
    await call('POST', '/api/wager', { option_id: bBet.options[0].id, amount: 100 }, b2);
    await call('POST', '/api/chat', { bet_id: bBet.id, text: 'B방 채팅' }, b1);
    await call('POST', '/api/rps/create', { hand: 'rock', stake: 50 }, b1);
    await call('POST', '/api/lun/create', { stake: 50, cap: 3, num: 2 }, b2);
    await call('POST', '/api/ladder/create', { stake: 50, slots: 2, slot: 0 }, b1);
    await call('POST', '/api/slots/spin', { bet: 20 }, b1); await call('POST', '/api/blackjack/start', { bet: 20 }, b2);
    const aBetCount = count('SELECT COUNT(*) n FROM bets b JOIN users u ON u.id=b.creator_id WHERE u.grp=?', gA.id);
    const aPoints = [await pts(a1), await pts(a2), await pts(a3)];
    assert.equal((await adm('POST', '/api/admin/group', { grp: 'zzzz' })).s, 404);
    const del = await adm('POST', '/api/admin/group', { grp: gB.id });
    assert.equal(del.s, 200); assert.equal(del.j.deleted_users, 2);
    assert.equal((await call('POST', '/api/login', { name: '비원', pin: '2222' })).s, 401, 'B방 사람들은 사라짐');
    assert.equal((await call('GET', '/api/me', null, b1)).s, 401, '세션도 사라짐');
    for (const [t, col] of [['users', 'id'], ['wagers', 'user_id'], ['messages', 'user_id'], ['bj', 'user_id'], ['slots', 'user_id'], ['sessions', 'user_id'], ['user_items', 'user_id'], ['lun_p', 'user_id'], ['lad_p', 'user_id']])
      assert.equal(count(`SELECT COUNT(*) n FROM ${t} WHERE ${col} IN (SELECT id FROM users WHERE name IN ('비원','비투'))`), 0);
    assert.equal(count("SELECT COUNT(*) n FROM bets WHERE title='B방 도박'"), 0, 'B방 도박도 사라짐');
    assert.equal(count('SELECT COUNT(*) n FROM options WHERE bet_id=?', bBet.id), 0);
    assert.equal(count('SELECT COUNT(*) n FROM messages WHERE bet_id=?', bBet.id), 0);
    assert.equal(count("SELECT COUNT(*) n FROM rps WHERE status='waiting'"), 0); assert.equal(count("SELECT COUNT(*) n FROM lun WHERE status='waiting'"), 0); assert.equal(count("SELECT COUNT(*) n FROM lad WHERE status='waiting'"), 0);
    // A방은 그대로
    assert.deepEqual([await pts(a1), await pts(a2), await pts(a3)], aPoints);
    assert.equal(count('SELECT COUNT(*) n FROM bets b JOIN users u ON u.id=b.creator_id WHERE u.grp=?', gA.id), aBetCount);
    assert.equal((await call('GET', '/api/bets', null, a1)).j.length, aBetCount);
    assert.equal((await sf()).groups.length, 1);
    console.log('관리자 기능 테스트 통과');
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();
});
