// Code.gs 를 가짜 구글 서비스(시트/락/캐시) 위에서 실행해 검증한다.
const vm = require('node:vm');
const assert = require('node:assert');
const { makeSandbox } = require('./gas-mock');

const { sb, sheets, cache } = makeSandbox();
// 요청마다 새 "실행"처럼 TBL/HOLDING 초기화 (실제 GAS는 호출마다 전역이 새로 만들어짐)
const call = (token, method, url, body, adminKey = '') => {
  vm.runInContext('TBL = {}; HOLDING = false;', sb);
  return JSON.parse(sb.handle(token, adminKey, method, url, body));
};
const ok = (r) => { assert.ok(!r.error, JSON.stringify(r)); return r.data; };
const err = (r, code) => { assert.equal(r.code, code, JSON.stringify(r)); return r; };

sb.CFG.LUCKY_CHANCE = 0;
const signup = (n) => ok(call('', 'POST', '/api/signup', { name: n, pin: '1234' })).token;
const state = (t) => ok(call(t, 'GET', '/api/state'));
const pts = (t) => state(t).me.points;

// 업그레이드: 예전 버전의 messages 시트(열 4개, bet_id 없음)가 이미 있어도 동작해야 함
const oldSheet = sb.SpreadsheetApp.getActiveSpreadsheet().insertSheet('messages');
oldSheet.appendRow(['id', 'user_id', 'text', 'created_at']);
oldSheet.appendRow([1, 1, '\u200B옛 전체채팅', 1]);
const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(signup);
const chatBetId = ok(call(a, 'POST', '/api/bets', { title: '채팅방', options: ['가', '나'] })).id;
const chatBet2Id = ok(call(a, 'POST', '/api/bets', { title: '다른방', options: ['가', '나'] })).id;
err(call('', 'POST', '/api/signup', { name: 'a', pin: '1234' }), 409);
err(call('', 'POST', '/api/login', { name: 'a', pin: '0000' }), 401);
assert.ok(ok(call('', 'POST', '/api/login', { name: 'a', pin: '1234' })).token);
err(call('bad-token', 'GET', '/api/state'), 401);
assert.equal(state(a).me.points, 1000);

// 시트에 글자가 숫자/수식으로 오인되지 않는지: 이름이 "123", 채팅이 "=1+1" 이어도 그대로
const t123 = signup('123');
assert.equal(state(t123).me.name, '123');
ok(call(t123, 'POST', '/api/chat', { bet_id: chatBetId, text: '=1+1' }));
assert.equal(ok(call(t123, 'GET', `/api/chat?bet=${chatBetId}`))[0].text, '=1+1');

// 역배: 1명 100 vs 3명 100씩 → 비중 25% < 30% → 보너스 20%
const bet = ok(call(a, 'POST', '/api/bets', { title: '테스트', options: ['X', 'Y'] }));
const [X, Y] = bet.options.map((o) => o.id);
ok(call(a, 'POST', '/api/wager', { option_id: X, amount: 100 }));
for (const t of [b, c, d]) ok(call(t, 'POST', '/api/wager', { option_id: Y, amount: 100 }));
err(call(a, 'POST', '/api/wager', { option_id: Y, amount: 100 }), 400);  // 헷지
err(call(b, 'POST', '/api/wager', { option_id: Y, amount: 5 }), 400);    // 최소금액
err(call(b, 'POST', '/api/wager', { option_id: Y, amount: 99999 }), 400); // 잔액초과
err(call(b, 'POST', '/api/bets/action', { bet_id: bet.id, action: 'resolve', option_id: X }), 403);
const view = state(b).bets.find((x) => x.id === bet.id);
assert.equal(view.total, 400); assert.equal(view.options[0].underdog, true);
ok(call(a, 'POST', '/api/bets/action', { bet_id: bet.id, action: 'close' }));
err(call(b, 'POST', '/api/wager', { option_id: Y, amount: 10 }), 400);   // 마감 후
ok(call(a, 'POST', '/api/bets/action', { bet_id: bet.id, action: 'resolve', option_id: X }));
assert.equal(pts(a), 900 + 480); assert.equal(pts(b), 900);

// 일반 정산: 총합 보존
const bet2 = ok(call(b, 'POST', '/api/bets', { title: '2', options: ['P', 'Q'] }));
const [P, Q] = bet2.options.map((o) => o.id);
ok(call(b, 'POST', '/api/wager', { option_id: P, amount: 100 }));
ok(call(c, 'POST', '/api/wager', { option_id: P, amount: 200 }));
ok(call(d, 'POST', '/api/wager', { option_id: Q, amount: 300 }));
const sum = () => [a, b, c, d].reduce((s, t) => s + pts(t), 0);
const before = sum();
ok(call(b, 'POST', '/api/bets/action', { bet_id: bet2.id, action: 'resolve', option_id: P }));
assert.equal(sum() - before, 600); assert.equal(pts(d), 600);

// 아무도 못 맞히면 환불
const bet3 = ok(call(a, 'POST', '/api/bets', { title: '3', options: ['M', 'N'] }));
const a0 = pts(a);
ok(call(a, 'POST', '/api/wager', { option_id: bet3.options[0].id, amount: 50 }));
ok(call(a, 'POST', '/api/bets/action', { bet_id: bet3.id, action: 'resolve', option_id: bet3.options[1].id }));
assert.equal(pts(a), a0);

// 마감 시간이 지나면 자동 마감 (락 재진입 없이)
const bet4 = ok(call(a, 'POST', '/api/bets', { title: '4', options: ['U', 'V'], closes_in_minutes: 1 }));
vm.runInContext(`tbl('bets').find(function(b){return b.id===${bet4.id}}).closes_at = Date.now()-1000; tbl('bets').save(tbl('bets').find(function(b){return b.id===${bet4.id}}));`, sb);
err(call(b, 'POST', '/api/wager', { option_id: bet4.options[0].id, amount: 10 }), 400);
assert.equal(state(b).bets.find((x) => x.id === bet4.id).status, 'closed');

// 럭키 100% → +50%
sb.CFG.LUCKY_CHANCE = 1;
const bet5 = ok(call(a, 'POST', '/api/bets', { title: '5', options: ['L', 'M'] }));
ok(call(a, 'POST', '/api/wager', { option_id: bet5.options[0].id, amount: 100 }));
ok(call(b, 'POST', '/api/wager', { option_id: bet5.options[1].id, amount: 100 }));
const a1 = pts(a);
ok(call(a, 'POST', '/api/bets/action', { bet_id: bet5.id, action: 'resolve', option_id: bet5.options[0].id }));
assert.equal(pts(a) - a1, 300);
assert.equal(state(a).bets.find((x) => x.id === bet5.id).my_lucky, true);
sb.CFG.LUCKY_CHANCE = 0;

// 닉네임
err(call(b, 'POST', '/api/nickname', { name: 'a' }), 409);
ok(call(b, 'POST', '/api/nickname', { name: '비비' }));
assert.equal(state(b).me.name, '비비');

// 채팅
err(call('', 'GET', `/api/chat?bet=${chatBetId}`), 401);
err(call(b, 'GET', '/api/chat?bet=99999'), 404);
err(call(b, 'POST', '/api/chat', { bet_id: 99999, text: 'x' }), 404);
ok(call(a, 'POST', '/api/chat', { bet_id: chatBetId, text: '안녕' }));
err(call(a, 'POST', '/api/chat', { bet_id: chatBetId, text: '연타' }), 429);
err(call(b, 'POST', '/api/chat', { bet_id: chatBetId, text: 'x'.repeat(201) }), 400);
const log = ok(call(b, 'GET', `/api/chat?bet=${chatBetId}`));
assert.deepEqual(log.map((m) => m.text), ['=1+1', '안녕']);
assert.equal(ok(call(b, 'GET', `/api/chat?bet=${chatBetId}&after=${log[0].id}`)).length, 1);

// 방 분리와 채팅 수
assert.deepEqual(oldSheet.data[0], ['id', 'user_id', 'text', 'created_at', 'bet_id'], '머리글에 bet_id 열이 보강돼야 함');
assert.ok(!JSON.stringify(ok(call(b, 'GET', `/api/chat?bet=${chatBetId}`))).includes('옛 전체채팅'), '예전 전체 채팅은 도박방에 안 섞임');
assert.deepEqual(ok(call(b, 'GET', `/api/chat?bet=${chatBet2Id}`)), []);
vm.runInContext('Date.now = (function (o) { return function () { return o() + 5000; }; })(Date.now);', sb);   // 도배 방지 시간 건너뛰기
ok(call(a, 'POST', '/api/chat', { bet_id: chatBet2Id, text: '여긴 다른 방' }));
assert.deepEqual(ok(call(b, 'GET', `/api/chat?bet=${chatBet2Id}`)).map((m) => m.text), ['여긴 다른 방']);
const lst = state(a).bets;
assert.equal(lst.find((x) => x.id === chatBetId).chat_count, 2);
assert.equal(lst.find((x) => x.id === chatBet2Id).chat_count, 1);

// 상점
err(call(a, 'POST', '/api/shop/buy', { item_id: 't_legend' }), 400);
err(call(a, 'POST', '/api/shop/equip', { item_id: 't_gambler' }), 400);
const pa = pts(a);
ok(call(a, 'POST', '/api/shop/buy', { item_id: 't_gambler' }));
assert.equal(pts(a), pa - 300);
err(call(a, 'POST', '/api/shop/buy', { item_id: 't_gambler' }), 400);
assert.equal(state(a).me.title, '도박꾼');
assert.equal(state(a).ranking.find((r) => r.title === '도박꾼').name, 'a');
assert.equal(ok(call(a, 'GET', `/api/chat?bet=${chatBetId}`)).find((m) => m.text === '안녕').title, '도박꾼');
ok(call(a, 'POST', '/api/shop/equip', { item_id: null, slot: 'title' }));
assert.equal(state(a).me.title, null);
ok(call(a, 'POST', '/api/shop/equip', { item_id: 't_gambler' }));
assert.equal(ok(call(a, 'GET', '/api/shop')).filter((i) => i.owned).length, 1);

// 구제금
ok(call(c, 'POST', '/api/admin/user', { user_id: 3, action: 'set_points', value: 5 }, KEY()));
function KEY() { vm.runInContext('TBL = {}; HOLDING = false;', sb); return sb.secret('ADMIN_KEY'); }
assert.equal(pts(c), 5);
ok(call(c, 'POST', '/api/aid', {}));
assert.equal(pts(c), 105);
err(call(c, 'POST', '/api/aid', {}), 400);

// 관리자
const K = KEY();
err(call('', 'GET', '/api/admin/overview', {}, 'wrong'), 403);
const ov = ok(call('', 'GET', '/api/admin/overview', {}, K));
assert.equal(ov.users.length, 5);
const ua = ov.users.find((u) => u.name === 'a');
ok(call('', 'POST', '/api/admin/user', { user_id: ua.id, action: 'add_points', value: 500 }, K));
const a2 = pts(a);
err(call('', 'POST', '/api/admin/user', { user_id: ua.id, action: 'add_points', value: -999999 }, K), 400);
const bb = pts(b); ok(call('', 'POST', '/api/admin/gift', { amount: 100 }, K)); assert.equal(pts(b), bb + 100);
ok(call('', 'POST', '/api/admin/user', { user_id: ua.id, action: 'reset_pin', value: '9999' }, K));
err(call(a, 'GET', '/api/state'), 401);   // 기존 세션 종료
assert.ok(ok(call('', 'POST', '/api/login', { name: 'a', pin: '9999' })).token);
// 진행 중 내기 삭제 → 환불
const bet6 = ok(call(b, 'POST', '/api/bets', { title: '6', options: ['U', 'V'] }));
const b0 = pts(b);
ok(call(b, 'POST', '/api/wager', { option_id: bet6.options[0].id, amount: 100 }));
ok(call('', 'POST', '/api/admin/bet', { bet_id: bet6.id, action: 'delete' }, K));
assert.equal(pts(b), b0);
// 채팅 삭제, 유저 삭제
const msg = ov.messages[0];
ok(call('', 'POST', '/api/admin/chat', { id: msg.id }, K));
ok(call('', 'POST', '/api/admin/user', { user_id: ov.users.find((u) => u.name === '123').id, action: 'delete' }, K));
assert.equal(ok(call('', 'GET', '/api/admin/overview', {}, K)).users.length, 4);

// 하나로 합친 시작하기: 있으면 로그인, 없으면 확인 후 가입
assert.equal(ok(call('', 'POST', '/api/enter', { name: '신입', pin: '4321' })).new_user, true);
err(call('', 'POST', '/api/login', { name: '신입', pin: '4321' }), 401);             // 아직 가입 안 됨
const nt = ok(call('', 'POST', '/api/enter', { name: '신입', pin: '4321', create: true })).token;
assert.equal(state(nt).me.points, 1000);
assert.ok(ok(call('', 'POST', '/api/enter', { name: '신입', pin: '4321' })).token);   // 이제는 로그인
err(call('', 'POST', '/api/enter', { name: '신입', pin: '0000' }), 401);              // PIN 틀림
err(call('', 'POST', '/api/enter', { name: '새로운', pin: '12' }), 400);              // PIN 형식
err(call('', 'POST', '/api/enter', { name: '', pin: '1234' }), 400);                  // 빈 닉네임

// 가위바위보
const [ra, rb, rc] = ['ra', 'rb', 'rc'].map(signup);
const rpsGet = (t) => ok(call(t, 'GET', '/api/rps'));
err(call(ra, 'POST', '/api/rps/create', { hand: 'lizard', stake: 100 }), 400);
err(call(ra, 'POST', '/api/rps/create', { hand: 'rock', stake: 5 }), 400);
err(call(ra, 'POST', '/api/rps/create', { hand: 'rock', stake: 99999 }), 400);
const room1 = ok(call(ra, 'POST', '/api/rps/create', { hand: 'rock', stake: 100 }));
assert.equal(pts(ra), 900);
assert.ok(!JSON.stringify(rpsGet(rb)).includes('rock'), '대기 중 방장의 손 노출 금지');
assert.ok(!JSON.stringify(state(rb)).includes('"rock"'), '/api/state 에도 노출 금지');
assert.equal(rpsGet(ra).rooms[0].my_hand, 'rock');
err(call(ra, 'POST', '/api/rps/join', { room_id: room1.id, hand: 'paper' }), 400);       // 본인 방
const jr = ok(call(rb, 'POST', '/api/rps/join', { room_id: room1.id, hand: 'paper' }));   // 보 > 바위
assert.equal(jr.outcome, 'win'); assert.equal(jr.net, 100);
assert.equal(pts(ra), 900); assert.equal(pts(rb), 1100);
err(call(rc, 'POST', '/api/rps/join', { room_id: room1.id, hand: 'paper' }), 400);       // 끝난 방
const room2 = ok(call(ra, 'POST', '/api/rps/create', { hand: 'scissors', stake: 200 }));
assert.equal(ok(call(rb, 'POST', '/api/rps/join', { room_id: room2.id, hand: 'paper' })).outcome, 'lose');
assert.equal(pts(ra), 900 - 200 + 400); assert.equal(pts(rb), 900);
const room3 = ok(call(ra, 'POST', '/api/rps/create', { hand: 'paper', stake: 50 }));
const ra0 = pts(ra);
assert.equal(ok(call(rc, 'POST', '/api/rps/join', { room_id: room3.id, hand: 'paper' })).outcome, 'draw');
assert.equal(pts(ra), ra0 + 50); assert.equal(pts(rc), 1000);
assert.deepEqual(rpsGet(ra).recent.map((r) => r.net).sort(), [-100, 0, 200].sort());
const room4 = ok(call(ra, 'POST', '/api/rps/create', { hand: 'rock', stake: 300 }));
const rbefore = pts(ra);
err(call(rb, 'POST', '/api/rps/cancel', { room_id: room4.id }), 403);
ok(call(ra, 'POST', '/api/rps/cancel', { room_id: room4.id }));
assert.equal(pts(ra), rbefore + 300);
for (let i = 0; i < 3; i++) ok(call(ra, 'POST', '/api/rps/create', { hand: 'rock', stake: 10 }));
err(call(ra, 'POST', '/api/rps/create', { hand: 'rock', stake: 10 }), 400);               // 동시 3개 제한
// 12시간 지난 방은 자동으로 닫히고 환불 (락 재진입 없이)
const rOld = ok(call(rc, 'POST', '/api/rps/create', { hand: 'rock', stake: 100 }));
const rc0 = pts(rc);
vm.runInContext(`var o = tbl('rps').find(function(r){return r.id===${rOld.id}}); o.created_at = Date.now() - 13*3600e3; tbl('rps').save(o);`, sb);
assert.equal(rpsGet(rb).rooms.some((r) => r.id === rOld.id), false);
assert.equal(pts(rc), rc0 + 100);

// 관리자 링크 생성 + 페이지 서빙
vm.runInContext('showAdminLink()', sb);
assert.ok(sheets['관리자'].data[1][0].includes('?admin=' + K));
assert.equal(sb.doGet({ parameter: {} }).file, 'index');
assert.equal(sb.doGet({ parameter: { admin: 'x' } }).file, 'admin');
console.log('GAS 테스트 통과');
