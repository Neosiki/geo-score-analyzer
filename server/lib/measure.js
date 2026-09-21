'use strict';
/**
 * measure.js — 측정 루프 (v3 고도화 C)
 *
 * "고쳤다"로 끝내지 않고 "숫자가 움직였는지"까지 확인하기 위한 순수 로직 모음.
 *  - 실험 보고서: 기준선 → 수정 → 14일 뒤 재측정, 항목별 점수 변화 + 인용 변화
 *  - 수동 인용 기록 엔진 목록 (API가 없는 ChatGPT·구글 AI 개요·네이버 AI 브리핑 등)
 *  - LLMO 점검: 브라우징 끈 모델이 매체를 아는가 (모름 / 틀리게 앎 / 맞게 앎)
 *  - AI 크롤러 방문 집계: 서버 접속 로그 → 날짜·봇별 방문 수 (인용의 선행 지표)
 *  - 낡은 데이터 판정: 값이 아니라 "값의 날짜"를 본다
 * 참고: leopard627/fire-your-seo-agency (MIT) references/measure.md 의 절차를 도구로 옮김
 */

const REMEASURE_DAYS = Number(process.env.GEO_REMEASURE_DAYS || 14);
const STALE_DAYS = Number(process.env.GEO_STALE_DAYS || 14);

const MANUAL_ENGINES = [
  { key: 'chatgpt', label: 'ChatGPT 검색' },
  { key: 'google_aio', label: '구글 AI 개요' },
  { key: 'naver_briefing', label: '네이버 AI 브리핑' },
  { key: 'perplexity', label: 'Perplexity' },
  { key: 'copilot', label: 'Copilot' },
  { key: 'gemini', label: 'Gemini' },
  { key: 'claude', label: 'Claude' },
];
const LLMO_ENGINES = [
  { key: 'chatgpt', label: 'ChatGPT' }, { key: 'claude', label: 'Claude' }, { key: 'gemini', label: 'Gemini' },
];
const LLMO_VERDICTS = { unknown: '모름', wrong: '틀리게 앎', correct: '맞게 앎' };

function engineLabel(engine) {
  const [kind, key] = String(engine).includes(':') ? String(engine).split(':') : ['api', engine];
  const list = kind === 'llmo' ? LLMO_ENGINES : MANUAL_ENGINES;
  const hit = list.find(e => e.key === key);
  if (kind === 'api') return 'Perplexity API' + (engine && engine !== 'sonar' ? ` (${engine})` : '');
  return (kind === 'llmo' ? 'LLMO·' : '') + (hit ? hit.label : key) + (kind === 'manual' ? ' (수동)' : '');
}

const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 864e5;
function isStale(iso, days = STALE_DAYS, now = new Date()) {
  if (!iso) return true;
  return daysBetween(iso, now) > days;
}
function addDays(iso, n) { return new Date(new Date(iso).getTime() + n * 864e5).toISOString(); }

// ── AI 크롤러 방문 집계 ───────────────────────────────────────────
// 긴 이름부터 검사 (Claude-SearchBot을 ClaudeBot보다 먼저 등)
const LOG_BOTS = [
  ['OAI-SearchBot', 'search'], ['ChatGPT-User', 'user'], ['GPTBot', 'training'],
  ['Claude-SearchBot', 'search'], ['Claude-User', 'user'], ['ClaudeBot', 'training'],
  ['Perplexity-User', 'user'], ['PerplexityBot', 'search'],
  ['Meta-ExternalAgent', 'training'], ['Applebot-Extended', 'training'], ['Bytespider', 'training'], ['CCBot', 'training'],
  ['Googlebot', 'engine'], ['bingbot', 'engine'], ['Yeti', 'engine'],
];
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function lineDay(line) {
  let m = line.match(/\[(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):/);                  // Apache/Nginx combined
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = line.match(/(20\d{2})-(\d{2})-(\d{2})[T\s]/);                             // ISO·CSV·JSON 로그
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return '';
}

function parseAccessLog(text) {
  const counts = new Map();   // day|bot → hits
  let lines = 0, matched = 0, undated = 0;
  String(text || '').split(/\r?\n/).forEach(line => {
    if (!line.trim()) return;
    lines++;
    const hit = LOG_BOTS.find(([b]) => line.toLowerCase().includes(b.toLowerCase()));
    if (!hit) return;
    const day = lineDay(line);
    if (!day) { undated++; return; }
    matched++;
    const k = day + '|' + hit[0];
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  const rows = [...counts.entries()].map(([k, hits]) => {
    const [day, bot] = k.split('|');
    return { day, bot, grp: LOG_BOTS.find(b => b[0] === bot)[1], hits };
  }).sort((a, b) => a.day.localeCompare(b.day) || b.hits - a.hits);
  return { lines, matched, undated, rows };
}

function crawlerSeries(rows) {
  const byDay = new Map();
  rows.forEach(r => {
    const e = byDay.get(r.day) || { day: r.day, training: 0, search: 0, user: 0, engine: 0 };
    e[r.grp] = (e[r.grp] || 0) + r.hits;
    byDay.set(r.day, e);
  });
  const byBot = {};
  rows.forEach(r => { byBot[r.bot] = (byBot[r.bot] || 0) + r.hits; });
  const lastImport = rows.reduce((m, r) => (r.importedAt > m ? r.importedAt : m), '');
  const lastDay = rows.length ? rows[rows.length - 1].day : '';
  return { series: [...byDay.values()], byBot, lastDay, lastImport, stale: isStale(lastDay ? lastDay + 'T23:59:59Z' : '', 7) };
}

// ── 인용 집계 ────────────────────────────────────────────────────
function citationStats(checks) {
  const byEngine = {};
  checks.forEach(c => {
    const e = byEngine[c.engine] || (byEngine[c.engine] = { engine: c.engine, label: engineLabel(c.engine), n: 0, cited: 0, lastAt: '' });
    e.n++; if (c.cited) e.cited++; if (c.checkedAt > e.lastAt) e.lastAt = c.checkedAt;
  });
  Object.values(byEngine).forEach(e => { e.rate = Math.round(e.cited / e.n * 100); e.stale = isStale(e.lastAt); });
  const n = checks.length, cited = checks.filter(c => c.cited).length;
  return { n, cited, rate: n ? Math.round(cited / n * 100) : null, byEngine: Object.values(byEngine) };
}

// 키워드·엔진별 최신값만 (같은 질문을 여러 번 쟀으면 마지막 결과)
function latestPerKeywordEngine(checks) {
  const m = new Map();
  checks.slice().sort((a, b) => b.checkedAt.localeCompare(a.checkedAt)).forEach(c => {
    const k = c.keyword + '|' + c.engine; if (!m.has(k)) m.set(k, c);
  });
  return [...m.values()];
}

// ── 실험 보고서 ──────────────────────────────────────────────────
function expStatus(exp, now = new Date()) {
  if (exp.resultAt) return { code: 'done', label: '재측정 완료' };
  if (!exp.changedAt) return { code: 'baseline', label: '기준선 기록됨 — 수정 후 "수정 완료"를 누르세요' };
  const left = Math.ceil(daysBetween(now, exp.dueAt));
  return left > 0 ? { code: 'waiting', label: `재측정까지 ${left}일`, daysLeft: left }
    : { code: 'due', label: '재측정할 때가 됐습니다', daysLeft: left };
}

function diffCriteria(before, after) {
  const crit = after.criteria || before.criteria || [];
  return crit.map(c => ({
    id: c.id, label: c.label, max: c.max,
    before: before.scores ? (before.scores[c.id] ?? null) : null,
    after: after.scores ? (after.scores[c.id] ?? 0) : 0,
  })).map(x => ({ ...x, delta: x.before === null ? null : x.after - x.before }))
    .filter(x => x.delta !== 0);
}

/**
 * @param exp        실험 레코드
 * @param before     기준선 분석 결과(전체)
 * @param after      재측정 분석 결과(전체)
 * @param checks     sov_checks 전체(수동·API·LLMO 포함)
 */
function buildReport(exp, before, after, checks) {
  const kw = (exp.keywords || []).filter(Boolean);
  const rel = checks.filter(c => !String(c.engine).startsWith('llmo:') && (!kw.length || kw.includes(c.keyword)));
  const winStart = addDays(exp.baselineAt, -28);
  const pre = latestPerKeywordEngine(rel.filter(c => c.checkedAt >= winStart && c.checkedAt < (exp.changedAt || exp.baselineAt)));
  const post = latestPerKeywordEngine(rel.filter(c => exp.changedAt && c.checkedAt >= exp.changedAt));
  const cb = citationStats(pre), ca = citationStats(post);

  const warnings = [];
  if ((before.engineVersion || 0) !== (after.engineVersion || 0)) warnings.push(`채점 엔진 버전이 다릅니다(v${before.engineVersion || '?'} → v${after.engineVersion}). 배점이 바뀐 항목의 점수 차이는 수정 효과가 아닐 수 있습니다.`);
  if (!pre.length) warnings.push('수정 전 인용 기록이 없습니다. 다음 실험부터는 수정 전에 대상 질문의 인용 여부를 먼저 기록하세요.');
  if (!post.length) warnings.push('수정 후 인용 기록이 없습니다. "수동 인용 기록"으로 ChatGPT·구글 AI 개요·네이버 AI 브리핑 결과를 입력하면 효과를 판단할 수 있습니다.');
  if (exp.changedAt && daysBetween(exp.changedAt, after.analyzedAt) < REMEASURE_DAYS) warnings.push(`수정 후 ${Math.floor(daysBetween(exp.changedAt, after.analyzedAt))}일 만의 재측정입니다. 검색·AI 반영에는 보통 ${REMEASURE_DAYS}일 안팎이 걸립니다.`);

  const gateB = before.indexability && before.indexability.status, gateA = after.indexability && after.indexability.status;
  const d = (a, b) => (b - a >= 0 ? '+' : '') + (b - a);
  const fmt = (iso) => String(iso || '').slice(0, 10);
  const citeTxt = (s, n) => s.n ? `AI 인용 ${s.cited}/${s.n}` : 'AI 인용 기록 없음';
  const lines = [
    `[실험] ${exp.name || exp.url}`,
    `[기준선] ${fmt(exp.baselineAt)}: ${before.totals.total}점(${before.grade}) · SEO ${before.totals.seoTotal} · GEO ${before.totals.geoTotal} · ${citeTxt(cb)}`,
    `[변경] ${fmt(exp.changedAt) || '-'}: ${exp.changeNote || '(변경 내용 미기재)'}`,
    `[재측정 예약] ${fmt(exp.dueAt) || '-'}`,
    `[재측정 결과] ${fmt(after.analyzedAt)}: ${after.totals.total}점(${after.grade}, ${d(before.totals.total, after.totals.total)}) · ${citeTxt(ca)}` +
      (cb.n && ca.n ? ` (인용률 ${cb.rate}% → ${ca.rate}%)` : ''),
  ];
  return {
    text: lines.join('\n'),
    score: { before: before.totals, after: after.totals, delta: after.totals.total - before.totals.total, gradeBefore: before.grade, gradeAfter: after.grade },
    indexability: { before: gateB || null, after: gateA || null, changed: gateB !== gateA },
    criteria: diffCriteria(before, after),
    citations: { before: cb, after: ca, keywords: kw },
    warnings,
  };
}

module.exports = {
  REMEASURE_DAYS, STALE_DAYS, MANUAL_ENGINES, LLMO_ENGINES, LLMO_VERDICTS,
  engineLabel, isStale, addDays, parseAccessLog, crawlerSeries, citationStats, latestPerKeywordEngine,
  expStatus, buildReport,
};
