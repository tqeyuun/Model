// public/index.html, public/admin.html → gas/index.html, gas/admin.html (앱스 스크립트용 변환)
// 사용: node build-gas.js   (화면을 고친 뒤에는 이걸 다시 실행해서 gas/ 를 갱신)
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function cut(s, from, to, replacement) {           // from 부터 to 직전까지를 교체
  const a = s.indexOf(from), b = s.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('변환 지점을 못 찾음: ' + from);
  return s.slice(0, a) + replacement + s.slice(b);
}
function rep(s, a, b) { if (!s.includes(a)) throw new Error('변환 지점을 못 찾음: ' + a); return s.split(a).join(b); }

const runner = (tokenExpr, adminExpr, on401) => `function api(method, url, body) {
  return new Promise((resolve, reject) => {
    google.script.run
      .withSuccessHandler((s) => {
        const j = JSON.parse(s);
        if (j.error) { ${on401} const e = new Error(j.error); e.code = j.code; reject(e); } else resolve(j.data);
      })
      .withFailureHandler((e) => reject(new Error((e && e.message) || '연결에 문제가 있어요.')))
      .handle(${tokenExpr}, ${adminExpr}, method, url, body || {});
  });
}
`;

/* ---------------- index ---------------- */
let s = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
s = rep(s, "localStorage.getItem(", "LS.get(");
s = rep(s, "localStorage.setItem(", "LS.set(");
s = rep(s, "localStorage.removeItem(", "LS.del(");
s = cut(s, "let token = LS.get('token')", "async function api(", `const LS = { // 앱스 스크립트 화면에서는 저장소가 막힐 수 있어 안전하게 감쌈
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 무시 */ } },
};
let token = LS.get('token'), user = null, tab = 'bets', bets = [], ranking = [], busy = false;

`);
s = cut(s, "async function api(", "function toast(", runner("token || ''", "''", "if (j.code === 401 && token) logout();"));
s = rep(s, "let cfg = {}, pending = null, chatMsgs = [], lastChatId = 0;", "let chatMsgs = [], lastChatId = 0;");
s = rep(s, "[user, bets, ranking, rps] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/bets'), api('GET', '/api/ranking'), api('GET', '/api/rps')]);",
           "({ me: user, bets, ranking, rps } = await api('GET', '/api/state'));");
s = rep(s, "  if (!token) initGoogle();\n", "");
s = cut(s, "function authView() {", "const auth = guard(", `function authView() {
  return \`<div class="card"><h2>들어가기</h2><p class="mute">닉네임 + 숫자 4자리 PIN으로 들어와요. 처음 쓰는 닉네임이면 새 계정이 만들어지고 1000점이 지급돼요! <b>PIN이 같은 사람들끼리만</b> 같은 방에서 도박·가위바위보·채팅을 해요. 이기면 낮은 확률로 🍀 럭키 보너스도 터져요. (실제 돈과 무관한 사이트 전용 포인트)</p>
  <input id="n" placeholder="닉네임" maxlength="12"><input id="p" placeholder="PIN 4자리" inputmode="numeric" maxlength="4" type="password" onkeydown="if(event.key==='Enter')auth()">
  <div class="betrow"><button class="pri" style="flex:1" onclick="auth()">시작하기</button></div></div>\`;
}
`);
s = cut(s, "function initGoogle() {", "const rename = guard(", "");
s = rep(s, "  try { cfg = await (await fetch('/api/config')).json(); } catch {}\n", "");
s = rep(s, "setInterval(pollChat, 2000);", "setInterval(() => { if (!document.hidden) pollChat(); }, 4000); // 앱스 스크립트는 호출이 느려서 간격을 넉넉히");
s = rep(s, "setInterval(refresh, 5000);", "setInterval(() => { if (!document.hidden) refresh(); }, 8000);");
for (const bad of ['fetch(', 'google.accounts', 'initGoogle', 'cfg.']) if (s.includes(bad)) throw new Error('남은 코드: ' + bad);
if (s.includes('<?')) throw new Error('스크립틀릿과 충돌하는 <? 가 있음');
fs.writeFileSync(path.join(__dirname, 'gas/index.html'), s);

/* ---------------- admin ---------------- */
let a = fs.readFileSync(path.join(__dirname, 'public/admin.html'), 'utf8');
a = cut(a, "// 키는 주소의 # 뒤에", "let data = null;", "// 관리자 키는 주소의 ?admin=... 로 들어오고, 서버가 페이지에 넣어줘요.\nconst key = <?!= adminKey ?>;\n");
a = cut(a, "async function api(", "function toast(", runner("''", 'key', ''));
a = rep(a, "서버를 켤 때 터미널에 나온 관리자 링크로 들어와 주세요.", "관리자 시트는 다른 사람에게 공유하지 마세요.");
for (const bad of ['fetch(', 'location.hash', 'sessionStorage']) if (a.includes(bad)) throw new Error('남은 코드: ' + bad);
fs.writeFileSync(path.join(__dirname, 'gas/admin.html'), a);

/* ---------------- 게임 규칙: Node 서버와 같은 파일을 Games.gs 로 복사 ---------------- */
fs.writeFileSync(path.join(__dirname, 'gas/Games.gs'), fs.readFileSync(path.join(__dirname, 'games-core.js'), 'utf8'));

/* ---------------- 문법 검사 ---------------- */
for (const f of ['index', 'admin']) {
  const html = fs.readFileSync(path.join(__dirname, `gas/${f}.html`), 'utf8').replace('<?!= adminKey ?>', '""');
  const m = /<script>([\s\S]*)<\/script>/.exec(html);
  new vm.Script(m[1]);   // 문법 오류가 있으면 여기서 예외
}
console.log('gas/index.html, gas/admin.html, gas/Games.gs 생성 완료');
