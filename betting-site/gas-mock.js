// Code.gs 를 실행하기 위한 가짜 구글 서비스(시트/락/캐시). 테스트 전용.
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');

function makeSandbox() {
  const sheets = {};
  const mkSheet = (name) => {
    const data = [];
    const sh = {
      name, data,
      getLastRow: () => data.length,
      getLastColumn: () => data.reduce((m, r) => Math.max(m, r.length), 0),
      getRange(r, c, nr = 1, nc = 1) {
        if (typeof r === 'string') { const m = /^([A-Z])(\d+)$/.exec(r); c = m[1].charCodeAt(0) - 64; r = Number(m[2]); }
        const rng = {
          getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (data[r - 1 + i] || [])[c - 1 + j] ?? '')),
          setValues(v) { v.forEach((row, i) => { data[r - 1 + i] = data[r - 1 + i] || []; row.forEach((x, j) => { data[r - 1 + i][c - 1 + j] = x; }); }); return rng; },
          getValue: () => data[r - 1]?.[c - 1] ?? '',
          setValue(v) { data[r - 1] = data[r - 1] || []; data[r - 1][c - 1] = v; return rng; },
          setFontWeight: () => rng,
        };
        return rng;
      },
      appendRow: (row) => { data.push(row.slice()); },
      deleteRow: (n) => { data.splice(n - 1, 1); },
      deleteRows: (n, k) => { data.splice(n - 1, k); },
      setFrozenRows: () => {}, clear: () => { data.length = 0; },
    };
    return sh;
  };
  const cache = new Map(), props = new Map();
  let locked = false;
  const sb = {
    console, Math, Date, JSON, Object, Array, String, Number, Error, RegExp, Promise,
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = mkSheet(n)) }) },
    LockService: { getScriptLock: () => ({ waitLock() { if (locked) throw new Error('락 교착(재진입)'); locked = true; }, releaseLock() { locked = false; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), remove: (k) => cache.delete(k), removeAll: (ks) => ks.forEach((k) => cache.delete(k)) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeDigest: (_alg, s) => [...crypto.createHash('sha256').update(s).digest()],
      base64Encode: (b) => Buffer.from(b).toString('base64'),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
    },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }) },
    HtmlService: { createTemplateFromFile: (f) => ({ evaluate: () => ({ setTitle() { return this; }, addMetaTag() { return this; }, file: f }) }) },
    Logger: { log() {} },
  };
  vm.createContext(sb);
  // 실제 앱스 스크립트는 파일을 읽는 순서가 보장되지 않아서, 일부러 Code.gs 를 먼저 실행해 봄 (Games.gs 를 최상단에서 참조하면 여기서 터짐)
  vm.runInContext(fs.readFileSync(__dirname + '/gas/Code.gs', 'utf8'), sb);
  vm.runInContext(fs.readFileSync(__dirname + '/gas/Games.gs', 'utf8'), sb);   // 게임 규칙 (Node 서버와 같은 games-core.js)
  return { sb, sheets, cache, props };
}

module.exports = { makeSandbox };
