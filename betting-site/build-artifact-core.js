// 규칙 코드(Games.gs + Code.gs)에 아티팩트용 저장소를 붙인 함수 본문(문자열)을 만듭니다.
const fs = require('node:fs');
const path = require('node:path');
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
function gsSource() {
  return [read('artifact/shims-pre.js'), read('gas/Games.gs'), read('gas/Code.gs'), read('artifact/shims-post.js')].join('\n');
}
function makeGS(ctx) { return new Function('ctx', gsSource())(ctx); }
module.exports = { gsSource, makeGS };
