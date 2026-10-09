// 방 만들기 / 방 들어가기 / 방별 닉네임 / 여러 계정 / 첫 실행 초기화
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

// 예전 버전 DB(계정 있음)로 서버를 켜면 비워지고, 관리자 설정은 남는지
const tmp = path.join(os.tmpdir(), 'rooms-test-' + process.pid + '.db');
{
  const old = new DatabaseSync(tmp);
  old.exec("CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL); INSERT INTO settings VALUES ('cfg_solo_plays','7');" +
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, salt TEXT, hash TEXT, points INTEGER, last_aid INTEGER, created_at INTEGER);" +
    "INSERT INTO users VALUES (1,'옛날사람','x','y',1000,0,1);"); old.close();
  const out = execFileSync(process.execPath, ['--no-warnings', '-e', "const {db}=require('./server');console.log(db.prepare('SELECT COUNT(*) n FROM users').get().n, db.prepare(\"SELECT v FROM settings WHERE k='cfg_solo_plays'\").get().v)"], { env: { ...process.env, DB_FILE: tmp }, cwd: __dirname }).toString().trim();
  assert.equal(out, '0 7', '예전 계정은 비워지고 관리자 설정은 유지: ' + out);
  for (const f of [tmp, tmp + '-wal', tmp + '-shm']) fs.rmSync(f, { force: true });
}

process.env.DB_FILE = ':memory:';
const { server } = require('./server');
server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}`;
  const enter = async (b) => { const r = await fetch(base + '/api/enter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { s: r.status, j: await r.json() }; };
  const me = async (t) => (await fetch(base + '/api/me', { headers: { Authorization: 'Bearer ' + t } })).json();
  try {
    // 방 만들기
    assert.equal((await enter({ mode: 'create', room: 'abc', name: '민수', pin: '1234' })).s, 400, '방 코드 4자 이상');
    assert.equal((await enter({ mode: 'create', room: 'dobak7', name: '민수', pin: '12' })).s, 400, 'PIN 4자 이상');
    const made = await enter({ mode: 'create', room: 'dobak7', name: '민수', pin: '1234' });
    assert.equal(made.s, 200); assert.equal(made.j.created_room, true);
    assert.equal((await me(made.j.token)).room, 'dobak7');
    assert.equal((await enter({ mode: 'create', room: 'dobak7', name: '지은', pin: '1234' })).s, 409, '이미 있는 방 코드로는 못 만듦');

    // 방 들어가기
    assert.equal((await enter({ mode: 'join', room: 'nothere', name: '지은', pin: '1234' })).s, 404, '없는 방');
    assert.equal((await enter({ mode: 'join', room: 'dobak7', name: '지은', pin: '9999' })).j.new_user, true, '새 닉네임 → 확인 단계');
    const jieun = await enter({ mode: 'join', room: 'dobak7', name: '지은', pin: '9999', create: true });
    assert.equal((await me(jieun.j.token)).group_size, 2, '같은 방 코드 → 같은 방');
    // 로그인: 방 코드 + 닉네임 + PIN. 같은 PIN이어도 남의 계정은 못 들어감 (PIN이 서로 달라서)
    assert.equal((await enter({ room: 'dobak7', name: '민수', pin: '1234' })).s, 200);
    assert.equal((await enter({ room: 'dobak7', name: '민수', pin: '9999' })).s, 401, '친구 PIN으로는 내 계정에 못 들어감');
    assert.equal((await enter({ room: 'dobak7', name: '민수', pin: 'dobak7' })).s, 401, '방 코드를 PIN으로 써도 못 들어감');

    // 한 사람이 여러 계정: 같은 방에 다른 닉네임으로, 다른 방에 같은 닉네임으로
    assert.equal((await enter({ room: 'dobak7', name: '민수부계', pin: '5555', create: true })).s, 200, '같은 방에 닉네임만 다르게');
    assert.equal((await enter({ room: 'dobak7', name: '민수', pin: '1234', create: true })).s, 200, '(이미 있으면 로그인)');
    const other = await enter({ mode: 'create', room: 'otherroom', name: '민수', pin: '7777' });
    assert.equal(other.s, 200, '다른 방에는 같은 닉네임을 써도 됨');
    assert.equal((await me(other.j.token)).group_size, 1);
    assert.equal((await enter({ room: 'otherroom', name: '민수', pin: '1234' })).s, 401, '방마다 계정이 따로: 다른 방 민수의 PIN으로는 못 들어감');
    console.log('방 만들기/들어가기 테스트 통과');
  } catch (e) { console.error(e); process.exitCode = 1; }
  server.close();
});
