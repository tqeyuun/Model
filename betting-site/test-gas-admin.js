// Code.gs 관리자: 시트 비밀번호 / 설정 조절 / 게임 방 닫기 / PIN 방 삭제
const vm = require('node:vm');
const assert = require('node:assert');
const { makeSandbox } = require('./gas-mock');
const { sb, sheets } = makeSandbox();
const G = sb.GAMES;
const call = (token, method, url, body, adminKey = '') => { vm.runInContext('TBL = {}; HOLDING = false;', sb); return JSON.parse(sb.handle(token, adminKey, method, url, body)); };
const ok = (r) => { assert.ok(!r.error, JSON.stringify(r)); return r.data; };
const err = (r, code) => { assert.equal(r.code, code, JSON.stringify(r)); return r; };
const mk = (name, pin) => ok(call('', 'POST', '/api/signup', { name, pin })).token;
const pts = (t) => ok(call(t, 'GET', '/api/state')).me.points;
sb.CFG.LUCKY_CHANCE = 0;
const KEY = (vm.runInContext('TBL = {}; HOLDING = false;', sb), sb.secret('ADMIN_KEY'));
const adm = (m, p, b) => call('', m, p, b, KEY);
const rows = (name) => { vm.runInContext('TBL = {};', sb); return vm.runInContext(`tbl('${name}').all()`, sb); };

/* ---- 관리자 비밀번호: 시트 '관리자' 탭 B1 ---- */
err(call('', 'GET', '/api/admin/overview', {}, 'wrong-password'), 403);
assert.ok(sheets['관리자'], "틀린 접속을 해도 '관리자' 탭이 만들어져 안내가 보임");
assert.ok(String(sheets['관리자'].data[0][0]).includes('비밀번호') && sheets['관리자'].data[0][1] === undefined, 'B1 은 비어 있음');
err(call('', 'GET', '/api/admin/overview', {}, ''), 403);
sheets['관리자'].data[0][1] = 'short';                                            // 8자 미만은 무시
err(call('', 'GET', '/api/admin/overview', {}, 'short'), 403);
sheets['관리자'].data[0][1] = 'dobak-secret-77';
ok(call('', 'GET', '/api/admin/overview', {}, 'dobak-secret-77'));                // 시트 비밀번호로 입장
ok(call('', 'GET', '/api/admin/overview', {}, KEY));                              // 예전 자동 키도 계속 됨
err(call('', 'GET', '/api/admin/overview', {}, 'dobak-secret-78'), 403);          // 한 글자만 달라도 거부
sheets['관리자'].data[0][1] = 123456789;                                           // 숫자로만 적어도 글자로 처리
ok(call('', 'GET', '/api/admin/overview', {}, '123456789'));
sheets['관리자'].data[0][1] = '  space-trim-ok  ';
ok(call('', 'GET', '/api/admin/overview', {}, 'space-trim-ok'));
sheets['관리자'].data[0][1] = 'dobak-secret-77';
err(call('', 'GET', '/api/admin/overview', {}, 'space-trim-ok'), 403);            // 비밀번호를 바꾸면 이전 것은 바로 못 씀
assert.equal(safeEqCheck(), true); function safeEqCheck() { return sb.safeEq('abc', 'abc') && !sb.safeEq('abc', 'abd') && !sb.safeEq('abc', 'abcd'); }
const A = (m, p, b) => call('', m, p, b, 'dobak-secret-77');
for (const [m, p] of [['POST', '/api/admin/settings'], ['POST', '/api/admin/room'], ['POST', '/api/admin/group']]) err(call('', m, p, {}, 'nope-nope-nope'), 403);

const [a1, a2, a3] = [mk('에이원', '1111'), mk('에이투', '1111'), mk('에이삼', '1111')];
const [b1, b2] = [mk('비원', '2222'), mk('비투', '2222')];

/* ---- 설정 ---- */
let ov = ok(A('GET', '/api/admin/overview'));
assert.deepEqual(ov.settings.map((x) => x.key), ['solo_net_cap', 'solo_plays', 'bj_max_bet', 'slot_max_bet', 'room_stake_max', 'lucky_percent', 'shop_open']);
const def = Object.fromEntries(ov.settings.map((x) => [x.key, x.default]));
assert.equal(def.solo_net_cap, 500); assert.equal(def.solo_plays, 30); assert.equal(def.shop_open, false); assert.equal(def.room_stake_max, 1000);
for (const bad of [{ solo_net_cap: -1 }, { solo_net_cap: 1.5 }, { solo_net_cap: '100' }, { bj_max_bet: 5 }, { lucky_percent: 101 }, { shop_open: 1 }, { nope: 1 }, { room_stake_max: 9 }])
  err(A('POST', '/api/admin/settings', { values: bad }), 400);
assert.equal(ok(A('GET', '/api/admin/overview')).settings.find((x) => x.key === 'solo_net_cap').value, 500, '잘못된 요청은 아무것도 안 바꿈');
ok(A('POST', '/api/admin/settings', { values: { solo_net_cap: 120, solo_plays: 5, bj_max_bet: 200, slot_max_bet: 100, room_stake_max: 300, shop_open: true } }));
const sl = ok(call(a1, 'GET', '/api/slots'));
assert.equal(sl.limits.net_cap, 120); assert.equal(sl.limits.plays_cap, 5); assert.equal(sl.max, 100);
assert.equal(ok(call(a1, 'GET', '/api/blackjack')).rules.MAX_BET, 200);
err(call(a1, 'POST', '/api/blackjack/start', { bet: 300 }), 400); err(call(a1, 'POST', '/api/slots/spin', { bet: 150 }), 400);
err(call(a1, 'POST', '/api/lun/create', { stake: 500, cap: 3, num: 1 }), 400);
ok(call(a1, 'POST', '/api/lun/create', { stake: 300, cap: 3, num: 1 }));
assert.ok(ok(call(a1, 'GET', '/api/shop')).length > 10, '상점이 열림');
// 저장돼서 다음 실행(새 프로세스)에서도 유지: 메모리 값을 망가뜨려도 저장본이 다시 적용됨
G.SOLO.DAILY_NET_CAP = 999; G.BJ.MAX_BET = 7;
assert.equal(ok(call(a1, 'GET', '/api/blackjack')).rules.MAX_BET, 200); assert.equal(G.SOLO.DAILY_NET_CAP, 120);
const rr = ok(A('POST', '/api/admin/settings', { reset: ['solo_net_cap', 'shop_open'] }));
assert.equal(rr.settings.find((x) => x.key === 'solo_net_cap').value, 500); assert.equal(rr.settings.find((x) => x.key === 'shop_open').value, false);
assert.equal(rr.settings.find((x) => x.key === 'solo_plays').value, 5, '나머지는 유지');
assert.deepEqual(ok(call(a1, 'GET', '/api/shop')), [], '상점이 다시 닫힘');
ok(A('POST', '/api/admin/settings', { values: { lucky_percent: 100 } }));
const bet = ok(call(a1, 'POST', '/api/bets', { title: '럭키', options: ['x', 'y'] }));
ok(call(a1, 'POST', '/api/wager', { option_id: bet.options[0].id, amount: 100 })); ok(call(a2, 'POST', '/api/wager', { option_id: bet.options[1].id, amount: 100 }));
const p0 = pts(a1); ok(call(a1, 'POST', '/api/bets/action', { bet_id: bet.id, action: 'resolve', option_id: bet.options[0].id }));
assert.equal(pts(a1) - p0, 300, '200 + 럭키 50%');
ok(A('POST', '/api/admin/settings', { reset: ['bj_max_bet', 'slot_max_bet', 'room_stake_max', 'solo_plays', 'lucky_percent'] }));
assert.equal(ok(call(a1, 'GET', '/api/slots')).limits.plays_cap, 30);
assert.equal(JSON.parse(vm.runInContext("props().getProperty('SETTINGS')", sb)).shop_open, undefined, '기본값으로 되돌린 항목은 저장본에서 빠짐');

/* ---- 게임 방 ---- */
const total0 = () => [a1, a2, a3, b1, b2].map(pts).reduce((x, y) => x + y);
const before = total0() + 300;      // 앞에서 연 300점 눈치게임 방에 맡겨져 있던 판돈
const rps = ok(call(a1, 'POST', '/api/rps/create', { hand: 'rock', stake: 50 }));
const lun = ok(call(a2, 'POST', '/api/lun/create', { stake: 70, cap: 4, num: 7 }));
ok(call(a3, 'POST', '/api/lun/join', { room_id: lun.id, num: 9 }));
ok(call(b1, 'POST', '/api/ladder/create', { stake: 80, slots: 3, slot: 1 }));
ov = ok(A('GET', '/api/admin/overview'));
assert.equal(ov.rooms.length, 4);
assert.ok(!/host_hand|"num"|"hand"|rock/.test(JSON.stringify(ov.rooms)), '관리자 화면에도 가려진 패/숫자는 안 나옴');
const lunRoom = ov.rooms.find((x) => x.kind === 'lun' && x.id === lun.id);
assert.deepEqual(lunRoom.players, ['에이투', '에이삼']); assert.equal(lunRoom.cap, 4);
err(A('POST', '/api/admin/room', { kind: 'zzz', room_id: 1 }), 400); err(A('POST', '/api/admin/room', { kind: 'rps', room_id: 99999 }), 404);
ov.rooms.forEach((x) => ok(A('POST', '/api/admin/room', { kind: x.kind, room_id: x.id })));
assert.equal(total0(), before, '방을 닫으면 판돈이 모두 돌아옴');
assert.equal(ok(A('GET', '/api/admin/overview')).rooms.length, 0);
err(A('POST', '/api/admin/room', { kind: 'rps', room_id: rps.id }), 400);
err(call(a2, 'POST', '/api/rps/join', { room_id: rps.id, hand: 'paper' }), 400);

/* ---- PIN 방 삭제 ---- */
ov = ok(A('GET', '/api/admin/overview'));
assert.deepEqual(ov.groups.map((g) => g.count), [3, 2]);
const gA = ov.groups.find((g) => g.count === 3), gB = ov.groups.find((g) => g.count === 2);
const bBet = ok(call(b1, 'POST', '/api/bets', { title: 'B방 도박', options: ['x', 'y'] }));
ok(call(b2, 'POST', '/api/wager', { option_id: bBet.options[0].id, amount: 100 }));
ok(call(b1, 'POST', '/api/chat', { bet_id: bBet.id, text: 'B방 채팅' }));
ok(call(b1, 'POST', '/api/rps/create', { hand: 'rock', stake: 50 })); ok(call(b2, 'POST', '/api/lun/create', { stake: 50, cap: 3, num: 2 }));
ok(call(b1, 'POST', '/api/ladder/create', { stake: 50, slots: 2, slot: 0 }));
ok(call(b1, 'POST', '/api/slots/spin', { bet: 20 })); ok(call(b2, 'POST', '/api/blackjack/start', { bet: 20 }));
const aBets = rows('bets').filter((b) => b.creator_id <= 3).length, aPoints = [pts(a1), pts(a2), pts(a3)];
err(A('POST', '/api/admin/group', { grp: 'zzzz' }), 404);
assert.equal(ok(A('POST', '/api/admin/group', { grp: gB.id })).deleted_users, 2);
err(call('', 'POST', '/api/login', { name: '비원', pin: '2222' }), 401);
err(call(b1, 'GET', '/api/state'), 401);
const left = (t, fn) => rows(t).filter(fn).length;
const bIds = new Set(rows('users').filter((u) => ['비원', '비투'].includes(u.name)).map((u) => u.id));
assert.equal(bIds.size, 0, 'B방 사람들은 사라짐');
for (const [t, fn] of [['bets', (r) => r.title === 'B방 도박'], ['options', (r) => r.bet_id === bBet.id], ['messages', (r) => r.bet_id === bBet.id], ['wagers', (r) => r.bet_id === bBet.id],
  ['rps', (r) => r.status === 'waiting'], ['lun', (r) => r.status === 'waiting'], ['lad', (r) => r.status === 'waiting'], ['bj', (r) => r.user_id > 3 && r.user_id < 6], ['slots', (r) => r.user_id > 3 && r.user_id < 6]])
  assert.equal(left(t, fn), 0, t + ' 에 B방 흔적이 남음');
assert.equal(rows('lunp').filter((r) => r.user_id > 3 && r.user_id < 6).length, 0); assert.equal(rows('ladp').filter((r) => r.user_id > 3 && r.user_id < 6).length, 0);
assert.deepEqual([pts(a1), pts(a2), pts(a3)], aPoints, 'A방은 그대로');
assert.equal(ok(call(a1, 'GET', '/api/state')).bets.length, aBets);
assert.equal(ok(A('GET', '/api/admin/overview')).groups.length, 1);
console.log('GAS 관리자 기능 테스트 통과');
