'use strict';
/**
 * db.js — 분석 이력 영구 저장소 (Phase 3)
 *
 * 드라이버 자동 선택:
 *  1) node:sqlite (Node >= 22.13, 내장 — 추가 설치 불필요)  → data/geo.db
 *  2) 미지원 Node → JSON 파일 폴백                          → data/geo-history.json
 *
 * 동일 인터페이스:
 *  saveAnalysis(result) → {id}
 *  listAnalyses({limit, q})         이력 목록 (요약)
 *  getAnalysis(id)                  전체 스냅샷
 *  deleteAnalysis(id) / clearAnalyses()
 *  timeseries(url)                  URL별 점수 추이
 *  distinctUrls()                   2회 이상 분석된 URL 목록
 *  saveAiReview(analysisId, url, review)
 *  trackUrl(url) / untrackUrl(id) / listTracked() / touchTracked(id)
 *  driver                           'sqlite' | 'json'
 *
 * v3 고도화 C (측정 루프, 2026-09-21):
 *  createExperiment / updateExperiment / getExperiment / listExperiments / deleteExperiment
 *  saveCrawlerDays(rows, source) / listCrawlerDays({days})
 *  수동 인용 기록·LLMO 점검은 sov_checks 테이블 재사용 (engine = 'manual:chatgpt', 'llmo:claude' 등)
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.GEO_DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let driver = 'json';
let sq = null;
try {
  const { DatabaseSync } = require('node:sqlite');
  sq = new DatabaseSync(path.join(DATA_DIR, 'geo.db'));
  // 스키마 초기화까지 성공해야 sqlite 채택 (일부 FS는 잠금 미지원)
  sq.exec(`
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      total INTEGER NOT NULL,
      seo_total INTEGER NOT NULL,
      geo_total INTEGER NOT NULL,
      grade TEXT NOT NULL,
      engine_version INTEGER NOT NULL DEFAULT 1,
      analyzed_at TEXT NOT NULL,
      result_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_analyses_url ON analyses(url);
    CREATE INDEX IF NOT EXISTS idx_analyses_at  ON analyses(analyzed_at);
    CREATE TABLE IF NOT EXISTS ai_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_id INTEGER,
      url TEXT NOT NULL DEFAULT '',
      citability INTEGER,
      model TEXT,
      review_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tracked_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_run TEXT
    );
    CREATE TABLE IF NOT EXISTS sov_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      engine TEXT NOT NULL,
      cited INTEGER NOT NULL DEFAULT 0,
      domain TEXT,
      response_json TEXT,
      checked_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sov_checked ON sov_checks(checked_at);
    CREATE TABLE IF NOT EXISTS sov_keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS experiments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crawler_days (
      day TEXT NOT NULL,
      bot TEXT NOT NULL,
      grp TEXT NOT NULL,
      hits INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL,
      PRIMARY KEY (day, bot, source)
    );
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  driver = 'sqlite';
} catch (_) {
  try { if (sq) sq.close(); } catch (_2) {}
  sq = null; // node:sqlite 미지원(Node<22.13) 또는 FS 제약 → JSON 폴백
}

// ════════════════════════════════════════════════════════════════
// JSON 폴백 드라이버 (Node < 22.13)
// ════════════════════════════════════════════════════════════════
const JSON_PATH = path.join(DATA_DIR, 'geo-history.json');
function jload() {
  try { return jnorm(JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'))); }
  catch (_) { return { seq: 0, analyses: [], ai_reviews: [], tracked_urls: [], sov_keywords: [], sov_checks: [], config: {}, experiments: [], crawler_days: [] }; }
}
function jnorm(d) {  // 구버전 파일 호환
  d.sov_keywords = d.sov_keywords || []; d.sov_checks = d.sov_checks || []; d.config = d.config || {};
  d.experiments = d.experiments || []; d.crawler_days = d.crawler_days || [];
  return d;
}
function jsave(d) { fs.writeFileSync(JSON_PATH, JSON.stringify(d)); }

// ════════════════════════════════════════════════════════════════
// 공통 API
// ════════════════════════════════════════════════════════════════
function rowSummary(r) {
  return {
    id: r.id, url: r.url, title: r.title,
    total: r.total, seoTotal: r.seo_total, geoTotal: r.geo_total,
    grade: r.grade, engineVersion: r.engine_version, analyzedAt: r.analyzed_at,
  };
}

function saveAnalysis(result) {
  if (!result || !result.totals) return null;
  const row = {
    url: result.url || '',
    title: (result.meta && result.meta.title || '').slice(0, 200),
    total: result.totals.total,
    seo_total: result.totals.seoTotal,
    geo_total: result.totals.geoTotal,
    grade: result.grade,
    engine_version: result.engineVersion || 1,
    analyzed_at: result.analyzedAt || new Date().toISOString(),
    result_json: JSON.stringify(result),
  };
  if (driver === 'sqlite') {
    const st = sq.prepare(`INSERT INTO analyses (url,title,total,seo_total,geo_total,grade,engine_version,analyzed_at,result_json)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const info = st.run(row.url, row.title, row.total, row.seo_total, row.geo_total, row.grade, row.engine_version, row.analyzed_at, row.result_json);
    return { id: Number(info.lastInsertRowid) };
  }
  const d = jload();
  row.id = ++d.seq;
  d.analyses.unshift(row);
  if (d.analyses.length > 2000) d.analyses.length = 2000;
  jsave(d);
  return { id: row.id };
}

function listAnalyses({ limit = 100, q = '' } = {}) {
  if (driver === 'sqlite') {
    const rows = q
      ? sq.prepare(`SELECT id,url,title,total,seo_total,geo_total,grade,engine_version,analyzed_at
          FROM analyses WHERE url LIKE ? OR title LIKE ? ORDER BY id DESC LIMIT ?`).all(`%${q}%`, `%${q}%`, limit)
      : sq.prepare(`SELECT id,url,title,total,seo_total,geo_total,grade,engine_version,analyzed_at
          FROM analyses ORDER BY id DESC LIMIT ?`).all(limit);
    return rows.map(rowSummary);
  }
  const d = jload();
  let rows = d.analyses;
  if (q) rows = rows.filter(r => (r.url + r.title).includes(q));
  return rows.slice(0, limit).map(rowSummary);
}

function getAnalysis(id) {
  if (driver === 'sqlite') {
    const r = sq.prepare('SELECT * FROM analyses WHERE id = ?').get(id);
    return r ? { ...rowSummary(r), result: JSON.parse(r.result_json) } : null;
  }
  const r = jload().analyses.find(x => x.id === Number(id));
  return r ? { ...rowSummary(r), result: JSON.parse(r.result_json) } : null;
}

function deleteAnalysis(id) {
  if (driver === 'sqlite') { sq.prepare('DELETE FROM analyses WHERE id = ?').run(id); return; }
  const d = jload(); d.analyses = d.analyses.filter(x => x.id !== Number(id)); jsave(d);
}

function clearAnalyses() {
  if (driver === 'sqlite') { sq.exec('DELETE FROM analyses'); return; }
  const d = jload(); d.analyses = []; jsave(d);
}

function timeseries(url) {
  if (!url) return [];
  if (driver === 'sqlite') {
    return sq.prepare(`SELECT id, total, seo_total AS seoTotal, geo_total AS geoTotal, grade, analyzed_at AS analyzedAt
      FROM analyses WHERE url = ? ORDER BY analyzed_at ASC`).all(url);
  }
  return jload().analyses
    .filter(r => r.url === url)
    .map(r => ({ id: r.id, total: r.total, seoTotal: r.seo_total, geoTotal: r.geo_total, grade: r.grade, analyzedAt: r.analyzed_at }))
    .reverse();
}

function distinctUrls() {
  if (driver === 'sqlite') {
    return sq.prepare(`SELECT url, COUNT(*) AS cnt, MAX(analyzed_at) AS lastAt
      FROM analyses WHERE url != '' GROUP BY url ORDER BY lastAt DESC LIMIT 100`).all();
  }
  const m = new Map();
  jload().analyses.forEach(r => {
    if (!r.url) return;
    const e = m.get(r.url) || { url: r.url, cnt: 0, lastAt: '' };
    e.cnt++; if (r.analyzed_at > e.lastAt) e.lastAt = r.analyzed_at;
    m.set(r.url, e);
  });
  return [...m.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, 100);
}

function saveAiReview(analysisId, url, review) {
  const created = new Date().toISOString();
  if (driver === 'sqlite') {
    sq.prepare('INSERT INTO ai_reviews (analysis_id,url,citability,model,review_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(analysisId || null, url || '', review.citability ?? null, review.model || '', JSON.stringify(review), created);
    return;
  }
  const d = jload();
  d.ai_reviews.unshift({ id: ++d.seq, analysis_id: analysisId || null, url, citability: review.citability, model: review.model, review_json: JSON.stringify(review), created_at: created });
  if (d.ai_reviews.length > 500) d.ai_reviews.length = 500;
  jsave(d);
}

function trackUrl(url) {
  const created = new Date().toISOString();
  if (driver === 'sqlite') {
    try { sq.prepare('INSERT INTO tracked_urls (url, created_at) VALUES (?,?)').run(url, created); }
    catch (e) { if (!/UNIQUE/.test(e.message)) throw e; }
    return listTracked();
  }
  const d = jload();
  if (!d.tracked_urls.find(t => t.url === url)) d.tracked_urls.push({ id: ++d.seq, url, created_at: created, last_run: null });
  jsave(d);
  return listTracked();
}

function untrackUrl(id) {
  if (driver === 'sqlite') { sq.prepare('DELETE FROM tracked_urls WHERE id = ?').run(id); return; }
  const d = jload(); d.tracked_urls = d.tracked_urls.filter(t => t.id !== Number(id)); jsave(d);
}

function listTracked() {
  if (driver === 'sqlite') return sq.prepare('SELECT * FROM tracked_urls ORDER BY id').all();
  return jload().tracked_urls;
}

function touchTracked(id) {
  const now = new Date().toISOString();
  if (driver === 'sqlite') { sq.prepare('UPDATE tracked_urls SET last_run = ? WHERE id = ?').run(now, id); return; }
  const d = jload(); const t = d.tracked_urls.find(x => x.id === Number(id)); if (t) t.last_run = now; jsave(d);
}

function stats() {
  if (driver === 'sqlite') {
    const a = sq.prepare('SELECT COUNT(*) AS c FROM analyses').get().c;
    const t = sq.prepare('SELECT COUNT(*) AS c FROM tracked_urls').get().c;
    return { driver, analyses: Number(a), tracked: Number(t) };
  }
  const d = jload();
  return { driver, analyses: d.analyses.length, tracked: d.tracked_urls.length };
}

// ════════════════════════════════════════════════════════════════
// Phase 4 — SoV 실측
// ════════════════════════════════════════════════════════════════
function getConfig() {
  const defaults = { myDomains: [], competitorDomains: [], sovEngine: 'sonar' };
  if (driver === 'sqlite') {
    const out = { ...defaults };
    sq.prepare('SELECT key, value FROM config').all().forEach(r => {
      try { out[r.key] = JSON.parse(r.value); } catch (_) { out[r.key] = r.value; }
    });
    return out;
  }
  return { ...defaults, ...jload().config };
}

function setConfig(patch) {
  if (driver === 'sqlite') {
    const st = sq.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    Object.entries(patch).forEach(([k, v]) => st.run(k, JSON.stringify(v)));
    return getConfig();
  }
  const d = jload(); Object.assign(d.config, patch); jsave(d);
  return getConfig();
}

function addKeyword(keyword) {
  const created = new Date().toISOString();
  if (driver === 'sqlite') {
    try { sq.prepare('INSERT INTO sov_keywords (keyword, created_at) VALUES (?, ?)').run(keyword, created); }
    catch (e) { if (!/UNIQUE/.test(e.message)) throw e; }
    return listKeywords();
  }
  const d = jload();
  if (!d.sov_keywords.find(k => k.keyword === keyword)) d.sov_keywords.push({ id: ++d.seq, keyword, created_at: created });
  jsave(d);
  return listKeywords();
}

function delKeyword(id) {
  if (driver === 'sqlite') { sq.prepare('DELETE FROM sov_keywords WHERE id = ?').run(id); return; }
  const d = jload(); d.sov_keywords = d.sov_keywords.filter(k => k.id !== Number(id)); jsave(d);
}

function listKeywords() {
  if (driver === 'sqlite') return sq.prepare('SELECT * FROM sov_keywords ORDER BY id').all();
  return jload().sov_keywords;
}

function saveSovCheck(c) {
  const checked = c.checked_at || new Date().toISOString();
  if (driver === 'sqlite') {
    sq.prepare('INSERT INTO sov_checks (keyword, engine, cited, domain, response_json, checked_at) VALUES (?,?,?,?,?,?)')
      .run(c.keyword, c.engine, c.cited ? 1 : 0, c.domain || '', JSON.stringify(c.detail || {}), checked);
    return;
  }
  const d = jload();
  d.sov_checks.unshift({ id: ++d.seq, keyword: c.keyword, engine: c.engine, cited: c.cited ? 1 : 0, domain: c.domain || '', response_json: JSON.stringify(c.detail || {}), checked_at: checked });
  if (d.sov_checks.length > 5000) d.sov_checks.length = 5000;
  jsave(d);
}

function listSovChecks({ keyword = '', limit = 2000 } = {}) {
  let rows;
  if (driver === 'sqlite') {
    rows = keyword
      ? sq.prepare('SELECT * FROM sov_checks WHERE keyword = ? ORDER BY id DESC LIMIT ?').all(keyword, limit)
      : sq.prepare('SELECT * FROM sov_checks ORDER BY id DESC LIMIT ?').all(limit);
  } else {
    rows = jload().sov_checks.filter(r => !keyword || r.keyword === keyword).slice(0, limit);
  }
  return rows.map(r => {
    let detail = {};
    try { detail = JSON.parse(r.response_json || '{}'); } catch (_) {}
    return { id: r.id, keyword: r.keyword, engine: r.engine, cited: !!r.cited, domain: r.domain, detail, checkedAt: r.checked_at };
  });
}

// ════════════════════════════════════════════════════════════════
// v3 고도화 C — 측정 루프 (실험·크롤러 방문)
// ════════════════════════════════════════════════════════════════
// 실험은 필드가 자주 늘어날 수 있어 JSON 한 덩어리로 저장한다
function createExperiment(data) {
  const created = new Date().toISOString();
  if (driver === 'sqlite') {
    const info = sq.prepare('INSERT INTO experiments (data_json, created_at) VALUES (?, ?)').run(JSON.stringify(data), created);
    return getExperiment(Number(info.lastInsertRowid));
  }
  const d = jload(); const id = ++d.seq;
  d.experiments.unshift({ id, data_json: JSON.stringify(data), created_at: created }); jsave(d);
  return getExperiment(id);
}
function expRow(r) { return r ? { id: Number(r.id), createdAt: r.created_at, ...JSON.parse(r.data_json) } : null; }
function getExperiment(id) {
  if (driver === 'sqlite') return expRow(sq.prepare('SELECT * FROM experiments WHERE id = ?').get(id));
  return expRow(jload().experiments.find(x => x.id === Number(id)));
}
function updateExperiment(id, patch) {
  const cur = getExperiment(id); if (!cur) return null;
  const { id: _i, createdAt: _c, ...rest } = cur;
  const next = { ...rest, ...patch };
  if (driver === 'sqlite') sq.prepare('UPDATE experiments SET data_json = ? WHERE id = ?').run(JSON.stringify(next), id);
  else { const d = jload(); const r = d.experiments.find(x => x.id === Number(id)); r.data_json = JSON.stringify(next); jsave(d); }
  return getExperiment(id);
}
function listExperiments() {
  if (driver === 'sqlite') return sq.prepare('SELECT * FROM experiments ORDER BY id DESC').all().map(expRow);
  return jload().experiments.map(expRow);
}
function deleteExperiment(id) {
  if (driver === 'sqlite') { sq.prepare('DELETE FROM experiments WHERE id = ?').run(id); return; }
  const d = jload(); d.experiments = d.experiments.filter(x => x.id !== Number(id)); jsave(d);
}

// 같은 날·봇·출처는 덮어쓴다 (같은 로그를 두 번 올려도 중복 집계 안 됨)
function saveCrawlerDays(rows, source = '') {
  const now = new Date().toISOString();
  if (driver === 'sqlite') {
    const st = sq.prepare(`INSERT INTO crawler_days (day, bot, grp, hits, source, imported_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(day, bot, source) DO UPDATE SET hits = excluded.hits, grp = excluded.grp, imported_at = excluded.imported_at`);
    rows.forEach(r => st.run(r.day, r.bot, r.grp, r.hits, source, now));
    return rows.length;
  }
  const d = jload();
  rows.forEach(r => {
    const e = d.crawler_days.find(x => x.day === r.day && x.bot === r.bot && x.source === source);
    if (e) { e.hits = r.hits; e.grp = r.grp; e.imported_at = now; }
    else d.crawler_days.push({ day: r.day, bot: r.bot, grp: r.grp, hits: r.hits, source, imported_at: now });
  });
  jsave(d);
  return rows.length;
}
function listCrawlerDays({ days = 90 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const rows = driver === 'sqlite'
    ? sq.prepare('SELECT day, bot, grp, SUM(hits) AS hits, MAX(imported_at) AS importedAt FROM crawler_days WHERE day >= ? GROUP BY day, bot, grp ORDER BY day').all(since)
    : Object.values(jload().crawler_days.filter(r => r.day >= since).reduce((m, r) => {
        const k = r.day + '|' + r.bot; const e = m[k] || (m[k] = { day: r.day, bot: r.bot, grp: r.grp, hits: 0, importedAt: '' });
        e.hits += r.hits; if (r.imported_at > e.importedAt) e.importedAt = r.imported_at; return m;
      }, {})).sort((a, b) => a.day.localeCompare(b.day));
  return rows.map(r => ({ day: r.day, bot: r.bot, grp: r.grp, hits: Number(r.hits), importedAt: r.importedAt }));
}

module.exports = {
  driver, saveAnalysis, listAnalyses, getAnalysis, deleteAnalysis, clearAnalyses,
  timeseries, distinctUrls, saveAiReview, trackUrl, untrackUrl, listTracked, touchTracked, stats,
  getConfig, setConfig, addKeyword, delKeyword, listKeywords, saveSovCheck, listSovChecks,
  createExperiment, getExperiment, updateExperiment, listExperiments, deleteExperiment,
  saveCrawlerDays, listCrawlerDays,
};
