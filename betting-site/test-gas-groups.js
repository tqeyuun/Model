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

// 업그레이드: 방(grp) 열이 없던 예전 users 시트(열 11개)에 예전 계정이 있는 상황
vm.runInContext('TBL = {}; HOLDING = false;', sb);
const oldUsers = sb.SpreadsheetApp.getActiveSpreadsheet().insertSheet('users');
oldUsers.appendRow(['id', 'name', 'salt', 'hash', 'points', 'last_aid', 'created_at', 'eq_title', 'eq_color', 'eq_fx', 'eq_badge']);
const salt = 'abcd1234', hash = vm.runInContext(`hashPin('1111', '${salt}')`, sb);
oldUsers.appendRow([1, '​옛날사람', '​' + salt, '​' + hash, 1000, 0, 1, '', '', '', '']);

const [a1, a2] = [mk('에이원', '1111'), mk('에이투', '1111')];
const [b1, b2] = [mk('비원', '2222'), mk('비투', '2222')];
assert.equal(oldUsers.data[0].length, 12, '머리글에 grp 열이 보강돼야 함');
assert.equal(oldUsers.data[0][11], 'grp');
assert.equal(state(a1).me.group_size, 2, '예전 계정(방 없음)은 아직 같은 방이 아님');

// 예전 계정은 처음 로그인할 때 PIN으로 방이 정해짐
const legacy = ok(call('', 'POST', '/api/login', { name: '옛날사람', pin: '1111' })).token;
assert.equal(state(a1).me.group_size, 3);
assert.equal(state(legacy).me.group_size, 3);

// 도박: 같은 PIN끼리만 보임
const bet = ok(call(a1, 'POST', '/api/bets', { title: 'A방 도박', options: ['x', 'y'] }));
assert.deepEqual(titles(a2), ['A방 도박']);
assert.deepEqual(titles(legacy), ['A방 도박']);
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
assert.deepEqual(state(a1).ranking.map((r) => r.name).sort(), ['에이원', '에이투', '옛날사람'].sort());
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
assert.deepEqual(titles(ok(call('', 'POST', '/api/enter', { name: '에이원', pin: '1111' })).token), ['A방 도박']);
err(call('', 'POST', '/api/enter', { name: '에이원', pin: '2222' }), 401);   // 다른 PIN으로는 그 사람 계정에 못 들어옴

// 관리자: 방이 구분돼 보이고, PIN을 바꿔주면 그 사람의 방이 바뀜
const K = (vm.runInContext('TBL = {}; HOLDING = false;', sb), sb.secret('ADMIN_KEY'));
const ov = ok(call('', 'GET', '/api/admin/overview', {}, K));
assert.equal(new Set(ov.users.map((u) => u.grp)).size, 2);
ok(call('', 'POST', '/api/admin/user', { user_id: ov.users.find((u) => u.name === '에이투').id, action: 'reset_pin', value: '2222' }, K));
assert.deepEqual(titles(ok(call('', 'POST', '/api/login', { name: '에이투', pin: '2222' })).token), ['B방 도박']);
console.log('GAS PIN 방 분리 테스트 통과');
