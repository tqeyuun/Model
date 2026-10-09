// Code.gs: PIN이 같은 사람끼리만 같은 방 (+ 예전 시트에서의 업그레이드)
const vm = require('node:vm');
const assert = require('node:assert');
const { makeSandbox } = require('./gas-mock');
const { sb, sheets } = makeSandbox();
const call = (token, method, url, body, adminKey = '') => { vm.runInContext('TBL = {}; HOLDING = false;', sb); return JSON.parse(sb.handle(token, adminKey, method, url, body)); };
const ok = (r) => { assert.ok(!r.error, JSON.stringify(r)); return r.data; };
const err = (r, code) => { assert.equal(r.code, code, JSON.stringify(r)); return r; };
sb.CFG.LUCKY_CHANCE = 0;
const mk = (name, pin) => ok(call('', 'POST', '/api/signup', { name, pin })).token;
const titles = (t) => ok(call(t, 'GET', '/api/state')).bets.map((b) => b.title);
const state = (t) => ok(call(t, 'GET', '/api/state'));

const [a1, a2] = [mk('에이원', '1111'), mk('에이투', '1111')];
const [b1, b2] = [mk('비원', '2222'), mk('비투', '2222')];
assert.equal(state(a1).me.group_size, 2);
assert.equal(state(a1).me.room, '1111');

// 도박: 같은 PIN끼리만 보임
const bet = ok(call(a1, 'POST', '/api/bets', { title: 'A방 도박', options: ['x', 'y'] }));
assert.deepEqual(titles(a2), ['A방 도박']);
assert.deepEqual(titles(b1), [], '다른 PIN 방의 도박은 안 보임');
ok(call(a2, 'POST', '/api/wager', { option_id: bet.options[0].id, amount: 100 }));
err(call(b1, 'POST', '/api/wager', { option_id: bet.options[0].id, amount: 100 }), 404);          // 직접 호출해도 못 걸음
err(call(b1, 'GET', `/api/chat?bet=${bet.id}`), 404);
err(call(b1, 'POST', '/api/chat', { bet_id: bet.id, text: '훔쳐보기' }), 404);
ok(call(a2, 'POST', '/api/chat', { bet_id: bet.id, text: '안녕' }));
assert.equal(ok(call(a1, 'GET', `/api/chat?bet=${bet.id}`)).length, 1);
err(call(b1, 'POST', '/api/bets/action', { bet_id: bet.id, action: 'cancel' }), 403);
ok(call(b1, 'POST', '/api/bets', { title: 'B방 도박', options: ['x', 'y'] }));
assert.deepEqual(titles(b2), ['B방 도박']);
assert.deepEqual(titles(a1), ['A방 도박']);

// 랭킹: 같은 방만
assert.deepEqual(state(a1).ranking.map((r) => r.name).sort(), ['에이원', '에이투'].sort());
assert.deepEqual(state(b1).ranking.map((r) => r.name).sort(), ['비원', '비투']);

// 가위바위보: 같은 방만, 다른 방 방에는 못 들어옴
const room = ok(call(a1, 'POST', '/api/rps/create', { hand: 'rock', stake: 100 }));
assert.equal(state(a2).rps.rooms.length, 1);
assert.equal(state(b1).rps.rooms.length, 0);
err(call(b1, 'POST', '/api/rps/join', { room_id: room.id, hand: 'paper' }), 404);
assert.equal(ok(call(a2, 'POST', '/api/rps/join', { room_id: room.id, hand: 'paper' })).outcome, 'win');
assert.equal(state(a1).rps.recent.length, 1);
assert.equal(state(b1).rps.recent.length, 0);

// 로그인
assert.deepEqual(titles(ok(call('', 'POST', '/api/enter', { room: '1111', name: '에이원', pin: '1111' })).token), ['A방 도박']);
err(call('', 'POST', '/api/enter', { room: '1111', name: '에이원', pin: '2222' }), 401);   // PIN이 다르면 못 들어감
assert.equal(ok(call('', 'POST', '/api/enter', { room: '2222', name: '에이원', pin: '1111' })).new_user, true);   // 다른 방에는 그 닉네임이 없으니 새 계정(한 사람이 여러 계정 가능)

// 관리자: 방이 구분돼 보이고, PIN 초기화는 방을 안 바꾸고, 방 변경은 방 코드로 옮김
const K = (vm.runInContext('TBL = {}; HOLDING = false;', sb), sb.secret('ADMIN_KEY'));
const ov = ok(call('', 'GET', '/api/admin/overview', {}, K));
assert.equal(new Set(ov.users.map((u) => u.grp)).size, 2);
const a2id = ov.users.find((u) => u.name === '에이투').id;
ok(call('', 'POST', '/api/admin/user', { user_id: a2id, action: 'reset_pin', value: '2222' }, K));
const a2new = ok(call('', 'POST', '/api/login', { room: '1111', name: '에이투', pin: '2222' })).token;
assert.deepEqual(titles(a2new), ['A방 도박'], 'PIN만 바뀌고 방은 그대로(A방)');
ok(call('', 'POST', '/api/admin/user', { user_id: a2id, action: 'move_room', value: '2222' }, K));
assert.deepEqual(titles(a2new), ['B방 도박'], '방 변경 → B방으로 이동');
console.log('GAS 방 분리 테스트 통과');
