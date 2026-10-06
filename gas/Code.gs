/**
 * 시장 날씨판 (Google Apps Script 웹 앱)
 * - 페이지를 열 때마다 FRED 공개 자료로 계산 (6시간 캐시). 자료가 바뀌면 자동으로 최신이 됩니다.
 * - installMonthlyTrigger()를 한 번 실행하면 매달 1일 아침 요약 메일을 나에게 보냅니다 (선택).
 * 매매 신호가 아니라 지금 상황을 보는 용도입니다.
 */
var SERIES = ['SP500', 'T10Y3M', 'T10Y2Y', 'SAHMREALTIME', 'BAMLH0A0HYM2', 'VIXCLS'];

function doGet() {
  var t = HtmlService.createTemplateFromFile('Index');
  t.data = JSON.stringify(getData_());
  return t.evaluate().setTitle('시장 날씨판').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getData_() {
  var cache = CacheService.getScriptCache(), hit = cache.get('data');
  if (hit) return JSON.parse(hit);
  var csv = {};
  var start = Utilities.formatDate(new Date(Date.now() - 11 * 365 * 864e5), 'UTC', 'yyyy-MM-dd');
  SERIES.forEach(function (id) {
    csv[id] = UrlFetchApp.fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + id + '&cosd=' + start).getContentText();
  });
  var data = buildData(csv, new Date());
  try { cache.put('data', JSON.stringify(data), 6 * 3600); } catch (e) {}
  return data;
}

/** 순수 계산 (테스트 가능): csv = {시리즈ID: FRED CSV 문자열} */
function buildData(csv, today) {
  function parse(text) {
    return text.trim().split('\n').slice(1).map(function (l) { var p = l.split(','); return [p[0], parseFloat(p[1])]; })
      .filter(function (p) { return isFinite(p[1]); });
  }
  var showFrom = new Date(today.getTime() - 3 * 365.25 * 864e5).toISOString().slice(0, 10);
  function recent(s, step) {
    var r = s.filter(function (p) { return p[0] >= showFrom; }), out = [];
    for (var i = 0; i < r.length; i += step) out.push(r[i]);
    if (out[out.length - 1] !== r[r.length - 1]) out.push(r[r.length - 1]);
    return out.map(function (p) { return [p[0], Math.round(p[1] * 1000) / 1000]; });
  }
  function status(v, rules) { for (var i = 0; i < rules.length; i++) if (rules[i][0](v)) return [rules[i][1], rules[i][2]]; return ['good', '정상']; }
  var ind = [];

  var spx = parse(csv.SP500), peak = -Infinity, dd = [], gap = [], sum = 0;
  spx.forEach(function (p, i) {
    peak = Math.max(peak, p[1]); dd.push([p[0], (p[1] / peak - 1) * 100]);
    sum += p[1]; if (i >= 200) sum -= spx[i - 200][1];
    if (i >= 199) gap.push([p[0], (p[1] / (sum / 200) - 1) * 100]);
  });
  var v = dd[dd.length - 1][1], s = status(v, [[function (x) { return x <= -20; }, 'critical', '약세장'], [function (x) { return x <= -10; }, 'warning', '조정']]);
  ind.push({ id: 'dd', name: 'S&P500 고점 대비', unit: '%', value: v, level: s[0], label: s[1], ref: [-10, -20], date: dd[dd.length - 1][0],
    note: '최근 10년 중 최고점에서 얼마나 내려왔는지. −10%면 조정, −20%면 약세장이라고 부릅니다.', series: recent(dd, 3) });
  v = gap[gap.length - 1][1]; s = v < 0 ? ['warning', '하락 추세'] : ['good', '상승 추세'];
  ind.push({ id: 'ma', name: 'S&P500 200일선 대비', unit: '%', value: v, level: s[0], label: s[1], ref: [0], date: gap[gap.length - 1][0],
    note: '200일 평균 가격보다 위면 상승 추세, 아래면 하락 추세. 신호가 늦고 오경보가 잦습니다.', series: recent(gap, 3) });

  var specs = [
    ['T10Y3M', '장단기 금리차 (10년−3개월)', '%p', [0], [[function (x) { return x < 0; }, 'warning', '역전']],
      '음수(역전)가 되면 1~2년 안에 경기침체가 온 적이 많았습니다. 시점은 들쭉날쭉합니다.', 3, '정상'],
    ['T10Y2Y', '장단기 금리차 (10년−2년)', '%p', [0], [[function (x) { return x < 0; }, 'warning', '역전']],
      '위와 같은 성격. 역전이 풀리는(다시 양수가 되는) 시기에 침체가 시작된 경우가 많았습니다.', 3, '정상'],
    ['SAHMREALTIME', '샴 룰 (실업률 상승폭)', '%p', [0.3, 0.5], [[function (x) { return x >= 0.5; }, 'critical', '침체 신호'], [function (x) { return x >= 0.3; }, 'warning', '주의']],
      '0.5 이상이면 경기침체가 이미 시작됐을 가능성이 큽니다. 늦지만 오경보가 적습니다.', 1, '정상'],
    ['BAMLH0A0HYM2', '하이일드 신용 스프레드', '%p', [4.5, 6], [[function (x) { return x >= 6; }, 'critical', '위험'], [function (x) { return x >= 4.5; }, 'warning', '주의']],
      '위험한 회사채에 붙는 추가 금리. 금융 스트레스가 커지면 빠르게 올라갑니다.', 3, '정상'],
    ['VIXCLS', 'VIX 변동성 지수', '', [20, 30], [[function (x) { return x >= 30; }, 'critical', '공포'], [function (x) { return x >= 20; }, 'warning', '불안']],
      '시장이 예상하는 앞으로 한 달의 흔들림. 지금의 분위기를 보여줄 뿐 방향을 알려주지는 않습니다.', 3, '평온']
  ];
  specs.forEach(function (sp) {
    var ser = parse(csv[sp[0]]), last = ser[ser.length - 1], st = status(last[1], sp[4]);
    if (st[0] === 'good') st[1] = sp[7];
    ind.push({ id: sp[0], name: sp[1], unit: sp[2], value: last[1], level: st[0], label: st[1], ref: sp[3], note: sp[5],
      series: recent(ser, sp[6]), date: last[0], src: 'https://fred.stlouisfed.org/series/' + sp[0] });
  });

  var by = {}; ind.forEach(function (i) { by[i.id] = i; });
  var warn = ind.filter(function (i) { return i.level === 'warning'; }).length, crit = ind.filter(function (i) { return i.level === 'critical'; }).length;
  var regime = (by.dd.value <= -20 || by.SAHMREALTIME.value >= 0.5 || by.BAMLH0A0HYM2.value >= 6) ? ['critical', '약세장 · 위기 경계']
    : (crit || warn >= 3 || by.dd.value <= -10) ? ['warning', '조정 · 불안'] : ['good', '정상 · 상승 국면'];
  return { updated: today.toISOString().slice(0, 10), regime: regime, n_warn: warn, n_crit: crit, indicators: ind,
    spx: { level: Math.round(spx[spx.length - 1][1] * 10) / 10, date: spx[spx.length - 1][0] } };
}

/** 선택: 매달 1일 오전 8시 요약 메일 (한 번만 실행) */
function installMonthlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'monthlyEmail') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('monthlyEmail').timeBased().onMonthDay(1).atHour(8).create();
}

function monthlyEmail() {
  CacheService.getScriptCache().remove('data');
  var d = getData_(), url = ScriptApp.getService().getUrl();
  var lines = d.indicators.map(function (i) { return '- ' + i.name + ': ' + i.value.toFixed(2) + i.unit + ' (' + i.label + ')'; });
  MailApp.sendEmail(Session.getActiveUser().getEmail(), '[시장 날씨판] ' + d.updated + ' · ' + d.regime[1],
    '종합 국면: ' + d.regime[1] + '\n\n' + lines.join('\n') + '\n\n이번 달 할 일: 자동매수 그대로 유지\n' + (url ? '\n' + url : ''));
}

if (typeof module !== 'undefined') module.exports = { buildData: buildData };   // 로컬 테스트용 (Apps Script에서는 무시됨)
