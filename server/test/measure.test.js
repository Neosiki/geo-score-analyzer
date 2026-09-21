'use strict';
// 측정 루프 테스트: node test/measure.test.js (DB는 임시 폴더, 네트워크 없음)
const assert = require('assert');
const os = require('os'), fs = require('fs'), path = require('path');
process.env.GEO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-m-'));
const db = require('../lib/db');
const M = require('../lib/measure');
const { scoreHTML } = require('../lib/scorer');

// ── 접속 로그 집계 ──
const log = [
  '1.2.3.4 - - [21/Sep/2026:10:00:01 +0900] "GET /news/1 HTTP/1.1" 200 5123 "-" "Mozilla/5.0 AppleWebKit/537.36; compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot"',
  '1.2.3.4 - - [21/Sep/2026:10:00:02 +0900] "GET /news/2 HTTP/1.1" 200 5123 "-" "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"',
  '1.2.3.5 - - [21/Sep/2026:11:00:00 +0900] "GET /news/3 HTTP/1.1" 200 5123 "-" "Mozilla/5.0 (compatible; Claude-SearchBot/1.0)"',
  '1.2.3.5 - - [22/Sep/2026:11:00:00 +0900] "GET /news/3 HTTP/1.1" 200 5123 "-" "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"',
  '1.2.3.6 - - [22/Sep/2026:12:00:00 +0900] "GET / HTTP/1.1" 200 1 "-" "Mozilla/5.0 (Linux; Android) Chrome/120 Mobile Safari"',
  '2026-09-22T13:00:00Z GET /news/9 "Mozilla/5.0 (compatible; Yeti/1.1; +https://naver.me/spd)"',
  '[no date] "Perplexity-User/1.0"',
].join('\n');
const L = M.parseAccessLog(log);
assert.strictEqual(L.lines, 7); assert.strictEqual(L.matched, 5); assert.strictEqual(L.undated, 1);
const find = (d, b) => (L.rows.find(r => r.day === d && r.bot === b) || {}).hits;
assert.strictEqual(find('2026-09-21', 'OAI-SearchBot'), 1);
assert.strictEqual(find('2026-09-21', 'Claude-SearchBot'), 1, 'Claude-SearchBot을 ClaudeBot으로 오분류 안 함');
assert.strictEqual(find('2026-09-22', 'ClaudeBot'), 1);
assert.strictEqual(find('2026-09-22', 'Yeti'), 1, 'ISO 날짜 로그');
db.saveCrawlerDays(L.rows, 'a.log'); db.saveCrawlerDays(L.rows, 'a.log');   // 같은 로그 두 번
const cs = M.crawlerSeries(db.listCrawlerDays({ days: 3650 }));
assert.strictEqual(cs.series.find(x => x.day === '2026-09-21').search, 2, '중복 업로드 미집계, 검색 색인 2');
assert.strictEqual(cs.series.find(x => x.day === '2026-09-21').training, 1);
console.log('✅ crawler log OK');

// ── 낡은 데이터 ──
assert.strictEqual(M.isStale(new Date(Date.now() - 20 * 864e5).toISOString()), true);
assert.strictEqual(M.isStale(new Date(Date.now() - 3 * 864e5).toISOString()), false);
assert.strictEqual(M.isStale(null), true, '기록 없으면 낡음');

// ── 실험 흐름 + 보고서 ──
const before = scoreHTML('<html><head><title>가상맙 CHMP 승인 권고</title></head><body><div id="article-view-content-div"><p>' + '[매체A 김가명 기자] 가나제약은 2026년 9월 CHMP 승인 권고를 받았다고 밝혔다. '.repeat(8) + '</p><p>' + '이번 승인 권고는 임상3상 결과를 근거로 한다. 투여군 사망 위험은 40% 낮았다. '.repeat(3) + '</p></div></body></html>', 'https://media-a.example/a/1');
const after = scoreHTML(before.meta ? '<html><head><title>가상맙 CHMP 승인 권고</title><script type="application/ld+json">{"@type":"NewsArticle","headline":"가상맙 CHMP 승인 권고","author":{"name":"김가명"},"datePublished":"2026-09-21"}</script></head><body><div id="article-view-content-div"><p>김가명 기자 2026.09.21</p><p>' + '[매체A 김가명 기자] 가나제약은 2026년 9월 CHMP 승인 권고를 받았다고 밝혔다. '.repeat(8) + '</p><p>' + '가상맙 승인 권고는 2026년 발표된 임상3상 결과를 근거로 한다. 투여군 사망 위험은 40% 낮았다. '.repeat(3) + '</p><a href="https://www.ema.europa.eu/x">EMA</a></div></body></html>' : '', 'https://media-a.example/a/1');
const b = db.saveAnalysis(before);
const base = new Date(Date.now() - 20 * 864e5).toISOString();
let exp = db.createExperiment({ url: 'https://media-a.example/a/1', name: 'JSON-LD·원출처 추가', keywords: ['가상맙 승인 권고'], baselineId: b.id, baselineAt: base, baselineTotal: before.totals.total, baselineGrade: before.grade, changedAt: null, dueAt: null, resultAt: null });
assert.strictEqual(M.expStatus(exp).code, 'baseline');
const changed = new Date(Date.now() - 15 * 864e5).toISOString();
exp = db.updateExperiment(exp.id, { changedAt: changed, changeNote: 'NewsArticle JSON-LD + EMA 원문 링크', dueAt: M.addDays(changed, 14) });
assert.strictEqual(M.expStatus(exp).code, 'due', '14일 지남 → 재측정 대상');
assert.strictEqual(M.expStatus({ ...exp, dueAt: M.addDays(new Date().toISOString(), 5) }).daysLeft, 5);

// 인용 기록: 수정 전 X, 수정 후 O (수동 2엔진 + API) · 다른 키워드는 제외 · LLMO는 제외
const at = (dAgo) => new Date(Date.now() - dAgo * 864e5).toISOString();
db.saveSovCheck({ keyword: '가상맙 승인 권고', engine: 'manual:naver_briefing', cited: false, checked_at: at(18) });
db.saveSovCheck({ keyword: '가상맙 승인 권고', engine: 'manual:naver_briefing', cited: true, checked_at: at(2) });
db.saveSovCheck({ keyword: '가상맙 승인 권고', engine: 'manual:chatgpt', cited: true, checked_at: at(1) });
db.saveSovCheck({ keyword: '다른 질문', engine: 'manual:chatgpt', cited: true, checked_at: at(1) });
db.saveSovCheck({ keyword: '매체A가 뭐야?', engine: 'llmo:claude', cited: false, detail: { verdict: 'unknown' }, checked_at: at(1) });
const rep = M.buildReport(exp, before, { ...after, analyzedAt: new Date().toISOString() }, db.listSovChecks({ limit: 100 }));
assert.strictEqual(rep.citations.before.n, 1); assert.strictEqual(rep.citations.before.cited, 0);
assert.strictEqual(rep.citations.after.n, 2); assert.strictEqual(rep.citations.after.cited, 2);
assert.ok(rep.score.delta > 0, '점수 상승');
assert.ok(rep.criteria.some(c => c.id === 'external_links' && c.delta > 0), '원출처 링크 항목 개선');
assert.ok(rep.text.includes('[기준선]') && rep.text.includes('[재측정 결과]') && rep.text.includes('인용률 0% → 100%'));
assert.strictEqual(rep.warnings.length, 0, '조건 충족 시 경고 없음');
console.log(rep.text);

// 경고: 이른 재측정 + 인용 기록 없음
const early = M.buildReport({ ...exp, keywords: ['기록 없는 질문'], changedAt: at(3) }, before, { ...after, analyzedAt: new Date().toISOString() }, db.listSovChecks({ limit: 100 }));
assert.ok(early.warnings.some(w => w.includes('3일 만의 재측정')));
assert.ok(early.warnings.some(w => w.includes('수정 후 인용 기록이 없습니다')));
// 엔진 버전이 다르면 경고
const vw = M.buildReport(exp, { ...before, engineVersion: 2 }, { ...after, analyzedAt: new Date().toISOString() }, []);
assert.ok(vw.warnings.some(w => w.includes('엔진 버전')));

// 엔진 라벨
assert.strictEqual(M.engineLabel('manual:naver_briefing'), '네이버 AI 브리핑 (수동)');
assert.strictEqual(M.engineLabel('llmo:claude'), 'LLMO·Claude');
assert.strictEqual(M.engineLabel('sonar'), 'Perplexity API');
console.log('✅ experiment report OK');
fs.rmSync(process.env.GEO_DATA_DIR, { recursive: true, force: true });
