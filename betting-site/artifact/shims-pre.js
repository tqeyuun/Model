/* ===== 구글 서비스를 흉내 내는 부분 (규칙 코드가 그대로 돌도록) ===== */
var ENG = ctx;
var console = { error: function (e) { if (!(e && e.message === 'NEED_LOCK') && typeof globalThis !== 'undefined') globalThis.console.error(e); }, log: function () {}, warn: function () {} };   // 임대 요청용 예외는 조용히
var __mem = { PEPPER: 'artifact' };
var __cache = {};
var CacheService = { getScriptCache: function () { return {
  get: function (k) { var e = __cache[k]; if (!e) return null; if (e.exp && e.exp < Date.now()) { delete __cache[k]; return null; } return e.v; },
  put: function (k, v, sec) { __cache[k] = { v: String(v), exp: sec ? Date.now() + sec * 1000 : 0 }; },
  remove: function (k) { delete __cache[k]; },
  removeAll: function (ks) { ks.forEach(function (k) { delete __cache[k]; }); }
}; } };
var PropertiesService = { getScriptProperties: function () { return {
  getProperty: function (k) { var v = ENG.getProp(k); if (v !== undefined) return v; return __mem[k] === undefined ? null : __mem[k]; },
  setProperty: function (k, v) { if (k === 'SETTINGS') ENG.setProp(k, v); else __mem[k] = v; }
}; } };
var LockService = { getScriptLock: function () { return {
  waitLock: function () { if (!ENG.lockOk()) throw new Error('NEED_LOCK'); },   // 쓰기 임대가 없으면 엔진이 임대를 잡고 다시 부름
  releaseLock: function () {}
}; } };
var Utilities = {
  getUuid: function () {
    var b = new Uint8Array(16); (typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : require('node:crypto').webcrypto).getRandomValues(b);
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
};
