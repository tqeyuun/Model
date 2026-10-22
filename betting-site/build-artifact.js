// 아티팩트 버전 만들기: gas/index.html(화면) + gas/admin.html(관리자) + 규칙 코드(Games.gs, Code.gs) + 저장소 엔진 → artifact/dobakjang.html
// 먼저 `node build-gas.js` 로 gas/ 를 최신으로 만든 뒤 실행하세요.
const fs = require('node:fs');
const path = require('node:path');
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const rep = (s, a, b) => { if (!s.includes(a)) throw new Error('변환 지점을 못 찾음: ' + a.slice(0, 70)); return s.split(a).join(b); };
const cut = (s, a, b, replacement) => { const i = s.indexOf(a); if (i < 0) throw new Error('시작 지점을 못 찾음: ' + a.slice(0, 60)); const j = s.indexOf(b, i); if (j < 0) throw new Error('끝 지점을 못 찾음: ' + b.slice(0, 60)); return s.slice(0, i) + replacement + s.slice(j); };
const between = (s, a, b, last) => { const i = s.indexOf(a); const j = last ? s.lastIndexOf(b) : s.indexOf(b, i); if (i < 0 || j < 0) throw new Error('구간을 못 찾음: ' + a); return s.slice(i + a.length, j); };

const idx = read('gas/index.html'), adm = read('gas/admin.html');
let css = between(idx, '<style>', '</style>');
let script = between(idx, '<script>\n', '</script>', true);
let admCss = between(adm, '<style>', '</style>');
let admScript = between(adm, '<script>\n', '</script>', true);

/* ================= 화면 스크립트 변환 ================= */
// 저장된 로그인 대신 계정(user.id)으로 자동 입장
script = rep(script, "let token = LS.get('token'), user = null", "let token = null, user = null");
script = cut(script, 'function api(method, url, body) {', 'function toast(', `async function api(method, url, body) {
  if (!ENGINE) throw new Error(ENG_ERR || '연결 중입니다. 잠시 뒤 다시 해주십시오.');
  const j = await ENGINE.call(token || '', method, url, body || {});
  if (j.error) { if (j.code === 401 && token) logout(); const e = new Error(j.error); e.code = j.code; throw e; }
  return j.data;
}
`);
// 로그인 화면: 닉네임 하나만
script = cut(script, "let authMode = 'join';", 'const rename = guard(', `const loginForm = () => \`
  <input id="n" placeholder="사용할 닉네임 (12자 이내)" maxlength="12" autocomplete="off" onkeydown="if(event.key==='Enter')auth()">
  <button class="pri" style="width:100%;margin-top:6px" onclick="auth()">입장하기</button>\`;
function authView() {
  if (ENG_ERR) return \`<div class="card"><h2>🔒 입장할 수 없습니다</h2><p class="mute">\${esc(ENG_ERR)}</p></div>\`;
  if (!ENGINE) return '<div class="card"><p class="mute">불러오는 중…</p></div>';
  return \`<div class="card"><h2>들어가기</h2><p class="mute">초대받은 사람끼리 쓰는 도박장입니다. 사용할 닉네임을 정하면 1000🪙이 지급됩니다. 이기면 낮은 확률로 🍀 럭키 보너스가 발생합니다. (실제 돈과 무관한 사이트 전용 칩)</p>\${loginForm()}</div>\`;
}
const auth = guard(async () => {
  const r = await ENGINE.enter($('#n').value);
  if (r.error) throw new Error(r.error);
  token = r.data.token; render(); await refresh();
});
`);
// 확인·입력 창: 아티팩트에서는 브라우저 기본 창이 안 떠서 화면 안의 창으로
script = rep(script, `onclick="if(confirm('취소하고 전부 환불합니까?'))act(\${b.id},'cancel')"`, `onclick="askThen('취소하고 전부 환불합니까?',()=>act(\${b.id},'cancel'))"`);
script = script.replace(/\bconfirm\(/g, 'await ask(').replace(/\bprompt\(/g, 'await askText(');
// 방 코드 대신 도박장 이름, 초대는 공유 메뉴
script = rep(script, '🚪 내 방 코드 <b style="color:var(--cyan)">${esc(user.room)}</b>', '🚪 도박장');
script = rep(script, '상대에게 이 코드를 알려주십시오', '초대는 아티팩트의 공유 메뉴에서 합니다');
// 계정은 Claude 계정에 묶여 있어서 로그아웃 없음, 소유자에게만 관리 버튼
script = rep(script, `<button onclick="logout()" style="padding:2px 8px;font-size:12px">로그아웃</button>`, `\${ENGINE && ENGINE.isOwner ? '<button onclick="openAdmin()" style="padding:2px 8px;font-size:12px">⚙️ 관리</button>' : ''}`);
script = rep(script, 'function render() {\n', 'function render() {\n  if (window.__adminMode) { renderHeader(); return; }\n');
// 빠른 반영: 저장소가 바뀌면 바로 새로고침, 주기는 짧게 (읽기는 메모리에서)
script = rep(script, '}, 4000); // 앱스 스크립트는 호출이 느려서 간격을 넉넉히', '}, 1500);');
script = cut(script, '(async () => {\n  render(); refresh();', '// 글자 🪙 → 게임칩', `/* ===== 시작: 아티팩트 저장소 연결 ===== */
let ENGINE = null, ENG_ERR = '';
async function boot() {
  try {
    const c = window.claude;
    if (!c || !c.use) throw new Error('Claude에서 열어야 합니다. 아티팩트 링크로 들어오십시오.');
    const [db, userNs] = await Promise.all([c.use('db'), c.use('user')]);
    if (!db || !userNs) throw new Error('이 페이지는 Claude에 로그인한 상태에서만 열립니다. 로그인한 뒤 다시 열어주십시오.');
    const uid = await userNs.id();
    if (!uid) throw new Error('계정 정보를 확인할 수 없습니다. 로그인한 뒤 다시 열어주십시오.');
    const canWrite = await userNs.can('data.write');
    if (canWrite === false) throw new Error('읽기 전용 권한입니다. 도박장 주인에게 "Contributor(참여자)" 권한으로 초대해 달라고 요청하십시오.');
    const eng = new ArtifactEngine({ db, uid, isOwner: await userNs.isOwner(), makeGS });
    await eng.start();
    ENGINE = eng;
    ENGINE.onChange(() => { if (!document.hidden) refresh(); });
    if (ENGINE.myUser()) { const r = await ENGINE.enter(); if (!r.error) token = r.data.token; }
  } catch (e) { ENG_ERR = e.message || '연결하지 못했습니다.'; }
  render(); refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 3000);
}
boot();

/* ===== 화면 안의 확인·입력 창 ===== */
let modalQ = Promise.resolve();
function showModal(opts) {
  return new Promise((resolve) => {
    modalQ = modalQ.then(() => new Promise((done) => {
      const m = document.getElementById('modal');
      m.innerHTML = \`<div class="mbox"><div class="mmsg"></div>\${opts.input ? '<input id="minput" autocomplete="off">' : ''}<div class="mbtn"><button id="mno">취소</button><button class="pri" id="myes">확인</button></div></div>\`;
      m.querySelector('.mmsg').textContent = opts.msg;
      const inp = m.querySelector('#minput'); if (inp) inp.value = opts.def || '';
      m.hidden = false;
      const close = (v) => { m.hidden = true; m.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(v); done(); };
      const onKey = (e) => { if (e.key === 'Escape') close(opts.input ? null : false); if (e.key === 'Enter' && inp) close(inp.value); };
      document.addEventListener('keydown', onKey);
      m.querySelector('#myes').onclick = () => close(opts.input ? inp.value : true);
      m.querySelector('#mno').onclick = () => close(opts.input ? null : false);
      (inp || m.querySelector('#myes')).focus();
    }));
  });
}
const ask = (msg) => showModal({ msg });
const askText = (msg, def) => showModal({ msg, input: true, def });
const askThen = async (msg, fn) => { if (await ask(msg)) fn(); };
window.ask = ask; window.askText = askText; window.askThen = askThen;
const openAdmin = () => { window.__adminMode = true; ADM.open(); };
const closeAdmin = () => { window.__adminMode = false; ADM.close(); render(); };
window.openAdmin = openAdmin; window.closeAdmin = closeAdmin;

`);

/* ================= 관리자 스크립트 변환 (이름 충돌을 피해 ADM 안에 가둠) ================= */
admScript = admScript.replace(/\/\/ 글자 🪙 → 게임칩[\s\S]*$/, '');       // 칩 변환은 화면 쪽 것을 같이 씀
admScript = rep(admScript, "const $ = (s) => document.querySelector(s);\nconst esc = (s) => String(s).replace(/[&<>\"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\n", '');
admScript = cut(admScript, '// 관리자 키는', 'let data = null;', '');
admScript = cut(admScript, 'function api(method, url, body) {', 'function toast(', `async function api(method, url, body) {
  const j = await ENGINE.call('', method, url, body || {});
  if (j.error) { const e = new Error(j.error); e.code = j.code; throw e; }
  return j.data;
}
`);
admScript = cut(admScript, 'function toast(', 'const guard =', '');                // 화면 쪽 toast / guard 를 그대로 씀
admScript = cut(admScript, 'const guard =', 'const load =', '');
admScript = cut(admScript, 'load(); setInterval(', '\n', '');
admScript = admScript.replace(/\bconfirm\(/g, 'await ask(').replace(/\bprompt\(/g, 'await askText(');
admScript = admScript.replace(/const (ask\w+) = \(/g, 'const $1 = async (');
admScript = rep(admScript, '<h1>🛠 관리자 콘솔</h1>', '<div class="row"><h1 style="margin:0">🛠 관리자 콘솔</h1><button onclick="closeAdmin()">← 도박장</button></div>');
const handlers = ['resetSetting', 'saveSettings', 'resetAllSettings', 'delGroup', 'closeRoom', 'gift', 'userAct', 'askPoints', 'askName', 'askPin', 'askRoom', 'delMsg', 'betAct'];
admScript = admScript.replace(new RegExp('onclick=(\\\\?")(' + handlers.join('|') + ')\\(', 'g'), 'onclick=$1ADM.$2(');
admScript = rep(admScript, "$('#app').innerHTML = `<h1>🔒 관리자</h1>", "$('#app').innerHTML = `<div class=\"row\"><h1>🔒 관리자</h1><button onclick=\"closeAdmin()\">← 도박장</button></div>");
const admBlock = `const ADM = (function () {
let timer = null;
${admScript}
return { ${handlers.join(', ')}, open() { load(); timer = setInterval(() => { if (document.activeElement?.tagName !== 'INPUT' && !document.hidden) load(); }, 5000); }, close() { clearInterval(timer); } };
})();`;

/* ================= 스타일: 관리자 전용 규칙만 더함 ================= */
const rules = (c) => [...c.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[0]]);
const have = new Set(rules(css).map(([s]) => s));
const extra = rules(admCss).filter(([s]) => !have.has(s) && !/^(:root|\*|body|main|html)$/.test(s)).map(([, r]) => r).join('\n');
css += `\n:root{color-scheme:dark}
/* 관리자 화면 */
${extra}
/* 화면 안의 확인·입력 창 */
#modal{position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:50;padding:16px}
#modal[hidden]{display:none}
.mbox{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;max-width:420px;width:100%;box-shadow:0 0 30px rgba(168,85,247,.35)}
.mmsg{white-space:pre-wrap;margin-bottom:12px}.mbox input{width:100%;margin-bottom:12px}.mbtn{display:flex;gap:8px;justify-content:flex-end}
`;

/* ================= 합치기 ================= */
const engine = read('artifact/engine.js');
const gsFn = `const makeGS = function (ctx) {\n${read('artifact/shims-pre.js')}\n${read('gas/Games.gs')}\n${read('gas/Code.gs')}\n${read('artifact/shims-post.js')}\n};`;
for (const [name, text] of [['engine', engine], ['규칙 코드', gsFn], ['화면', script], ['관리자', admBlock]]) if (/<\/script/i.test(text)) throw new Error(name + ' 에 </script 가 있음');
const head = idx.slice(idx.indexOf('<title>'), idx.indexOf('<style>'));
const body = between(idx, '<body>\n', '<script>', false);
const out = `${head}<style>\n${css}\n</style>\n${body}<div id="modal" hidden></div>\n<script>\n${engine}\n${gsFn}\n${script}\n${admBlock}\n</script>\n`;
// 문법 검사 (브라우저에서 실행할 스크립트 전체)
new Function(engine + '\n' + gsFn + '\n' + script + '\n' + admBlock);
fs.writeFileSync(path.join(__dirname, 'artifact/dobakjang.html'), out);
console.log('artifact/dobakjang.html 생성 완료 (' + Math.round(out.length / 1024) + 'KB)');
