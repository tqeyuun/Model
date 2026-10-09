// Code.gs: 방 만들기 / 방 들어가기 / 방별 닉네임 / 여러 계정 / 첫 실행 초기화
const vm = require('node:vm');
const assert = require('node:assert');
const { makeSandbox } = require('./gas-mock');
const { sb, sheets, cache, props } = makeSandbox();
const call = (token, method, url, body) => { vm.runInContext('TBL = {}; HOLDING = false;', sb); return JSON.parse(sb.handle(token, '', method, url, body || {})); };
const ok = (r) => { assert.ok(!r.error, JSON.stringify(r)); return r.data; };
const err = (r, code) => { assert.equal(r.code, code, JSON.stringify(r)); return r; };
const enter = (b) => call('', 'POST', '/api/enter', b);
const me = (t) => ok(call(t, 'GET', '/api/state')).me;

// ---- 첫 실행 초기화: 예전 계정·로그인(캐시 포함)은 사라지고, 관리자 설정/비밀번호는 남음 ----
{
  vm.runInContext("TBL = {}; ['users','sessions','bets'].forEach(function (n) { tbl(n); });", sb);
  sheets.users.appendRow(['1', '​옛날사람', '​salt', '​hash', 1000, 0, 1, '', '', '', '', '​grp']);
  sheets.sessions.appendRow(['​oldtoken', 1, 1]); cache.set('s_oldtoken', '1');                 // 예전 로그인(캐시에도 남아 있음)
  sheets.bets.appendRow([1, '​예전 도박', 1, '​open', '', '', 1]);
  props.set('SETTINGS', JSON.stringify({ solo_plays: 7 }));
  vm.runInContext("TBL = {}; ensureAdminSheet();", sb); sheets['관리자'].data[0][1] = 'keep-this-password';
  const first = enter({ mode: 'create', room: 'dobak7', name: '민수', pin: '1234' });         // 새 구조의 첫 요청 → 이때 초기화
  ok(first);
  assert.equal(sheets.users.data.length, 2, '예전 계정은 지워지고 새 계정만 (머리글 + 1명)');
  assert.equal(sheets.bets.data.length, 1, '예전 도박도 지워짐 (머리글만)');
  assert.equal(sheets.users.data[1][1], '​민수');
  err(call('oldtoken', 'GET', '/api/state'), 401);                                                // 새 계정이 id 1 이어도 예전 로그인으로는 못 들어감
  assert.equal(cache.get('s_oldtoken'), null, '캐시에 남은 예전 로그인도 지워짐');
  assert.equal(JSON.parse(props.get('SETTINGS')).solo_plays, 7, '관리자 설정은 유지'); assert.equal(sheets['관리자'].data[0][1], 'keep-this-password', '관리자 비밀번호는 유지');
  ok(enter({ room: 'dobak7', name: '민수', pin: '1234' }));
  assert.equal(sheets.users.data.length, 2, '두 번째 요청부터는 다시 지우지 않음');
}

// ---- 방 만들기 ----
err(enter({ mode: 'create', room: 'abc', name: '철수', pin: '1234' }), 400);
err(enter({ mode: 'create', room: 'newroom1', name: '철수', pin: '12' }), 400);
assert.equal(vm.runInContext("TBL = {}; tbl('rooms').all().filter(function (r) { return r.code === 'newroom1'; }).length", sb), 0, 'PIN이 잘못되면 방이 만들어지지 않음');
const made = ok(enter({ mode: 'create', room: 'newroom1', name: '철수', pin: '1234' }));
assert.equal(made.created_room, true); assert.equal(me(made.token).room, 'newroom1');
err(enter({ mode: 'create', room: 'newroom1', name: '영희', pin: '1234' }), 409);
// ---- 방 들어가기 ----
err(enter({ mode: 'join', room: 'nothere', name: '지은', pin: '1234' }), 404);
assert.equal(ok(enter({ mode: 'join', room: 'dobak7', name: '지은', pin: '9999' })).new_user, true);
const jieun = ok(enter({ mode: 'join', room: 'dobak7', name: '지은', pin: '9999', create: true })).token;
assert.equal(me(jieun).group_size, 2);
ok(enter({ room: 'dobak7', name: '민수', pin: '1234' }));
err(enter({ room: 'dobak7', name: '민수', pin: '9999' }), 401);        // 친구 PIN으로는 못 들어감
err(enter({ room: 'dobak7', name: '민수', pin: 'dobak7' }), 401);      // 방 코드를 PIN으로 써도 못 들어감
// ---- 한 사람이 여러 계정 ----
ok(enter({ room: 'dobak7', name: '민수부계', pin: '5555', create: true }));       // 같은 방, 닉네임만 다르게
const other = ok(enter({ mode: 'create', room: 'otherroom', name: '민수', pin: '7777' }));   // 다른 방, 같은 닉네임
assert.equal(me(other.token).group_size, 1);
err(enter({ room: 'otherroom', name: '민수', pin: '1234' }), 401);                // 방마다 계정이 따로
console.log('GAS 방 만들기/들어가기 테스트 통과');
