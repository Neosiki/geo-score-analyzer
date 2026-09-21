'use strict';
/**
 * server.js — GEO Analyzer v3 (Express 백엔드, engine v2 + Claude AI)
 *
 * POST /api/analyze       단일 URL 또는 HTML 분석
 * POST /api/batch         복수 URL 배치 분석 (최대 20개)
 * POST /api/compare       두 URL 나란히 비교
 * /api/exp·/api/citations·/api/llmo·/api/crawlers  측정 루프 (v3 고도화 C)
 * POST /api/site          사이트 점검 (robots AI 크롤러·사이트맵·llms.txt·404·SSR·엔티티·네이버/빙)
 * POST /api/ai/analyze    Claude 정성 분석 (인용가능성)
 * POST /api/ai/rewrite    Claude GEO 리라이팅
 * POST /api/report/pdf    분석 결과 JSON → PDF 다운로드
 * POST /api/report/excel  분석 결과 JSON → Excel 다운로드
 * GET  /api/health        서버 상태
 * GET  *                  public/index.html SPA
 */

const express   = require('express');
const axios     = require('axios');
const cors      = require('cors');
const path      = require('path');
const { scoreHTML, CRITERIA, ENGINE_VERSION } = require('./lib/scorer');
const { buildPDF, buildExcel } = require('./lib/reports');
const { aiAnalyze, aiRewrite, aiAvailable, DEFAULT_MODEL } = require('./lib/ai');
const db = require('./lib/db');
const { checkKeyword, sovAvailable, MOCK: SOV_MOCK } = require('./lib/sov');
const { auditSite } = require('./lib/site');
const M = require('./lib/measure');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── 미들웨어 ───────────────────────────────────────────────────
// 공개 웹(예: GitHub Pages의 geo-dashboard)에서 localhost 분석기를 부를 때 크롬의 사설망 접근 사전확인 허용
app.use((req, res, next) => { if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true'); next(); });
app.use(cors());
app.use(express.json({ limit: '5mb' }));
const textParser = express.text({ limit: '5mb' });
// 접속 로그 업로드는 50MB까지 받도록 전역 5MB 파서를 건너뛴다
app.use((req, res, next) => (req.path === '/api/crawlers/import' ? next() : textParser(req, res, next)));
app.use(express.static(path.join(__dirname, 'public')));

// ── URL 가져오기 (서버사이드, CORS 걱정 없음) ──────────────────
async function fetchURL(url) {
  const res = await axios.get(url, {
    timeout: 15000,
    maxContentLength: 5 * 1024 * 1024,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; GEO-Analyzer/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    },
  });
  return {
    html: typeof res.data === 'string' ? res.data : String(res.data),
    headers: res.headers || {},   // X-Robots-Tag 검사용 (v3 색인 게이트)
    status: res.status,
  };
}

// ─────────────────────────────────────────────────────────────
// POST /api/analyze   { url } 또는 { html }
// ─────────────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const { url, html: bodyHtml } = req.body;
    let html, page = null, targetUrl = url || '';

    if (url) {
      try { page = await fetchURL(url); html = page.html; }
      catch (e) { return res.status(502).json({ error: `URL 가져오기 실패: ${e.message}` }); }
    } else if (bodyHtml) {
      html = bodyHtml;
    } else {
      return res.status(400).json({ error: 'url 또는 html 필드가 필요합니다.' });
    }

    const result = scoreHTML(html, targetUrl, page || {});
    try { const saved = db.saveAnalysis(result); if (saved) result.dbId = saved.id; } catch (e) { console.error('[db]', e.message); }
    res.json(result);
  } catch (e) {
    console.error('[analyze]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/batch   { urls: string[] }
// ─────────────────────────────────────────────────────────────
app.post('/api/batch', async (req, res) => {
  try {
    let urls = [];
    if (req.is('text/*')) {
      urls = req.body.split(/[\r\n,]+/).map(u => u.trim()).filter(u => u.startsWith('http'));
    } else {
      urls = (req.body.urls || []).filter(u => typeof u === 'string' && u.startsWith('http'));
    }

    if (!urls.length) return res.status(400).json({ error: '분석할 URL이 없습니다.' });
    if (urls.length > 20) return res.status(400).json({ error: '최대 20개 URL까지 가능합니다.' });

    const results = [];
    for (const url of urls) {
      try {
        const page = await fetchURL(url);
        const html = page.html;
        const one = { url, success: true, ...scoreHTML(html, url, page) };
        try { const saved = db.saveAnalysis(one); if (saved) one.dbId = saved.id; } catch (e2) { console.error('[db]', e2.message); }
        results.push(one);
      } catch (e) {
        results.push({
          url, success: false, error: e.message,
          scores: {}, details: {},
          totals: { total: 0, seoTotal: 0, geoTotal: 0, seoMax: 50, geoMax: 50 },
          grade: 'F', criteria: CRITERIA,
        });
      }
      await new Promise(r => setTimeout(r, 300)); // 과부하 방지
    }

    res.json({ count: results.length, results });
  } catch (e) {
    console.error('[batch]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/compare   { urlA, urlB }
// ─────────────────────────────────────────────────────────────
app.post('/api/compare', async (req, res) => {
  try {
    const { urlA, urlB } = req.body;
    if (!urlA || !urlB) return res.status(400).json({ error: 'urlA 와 urlB 가 모두 필요합니다.' });

    const analyze = async (url) => {
      try {
        const page = await fetchURL(url);
        const html = page.html;
        const one = { url, success: true, ...scoreHTML(html, url, page) };
        try { const saved = db.saveAnalysis(one); if (saved) one.dbId = saved.id; } catch (e2) { console.error('[db]', e2.message); }
        return one;
      } catch (e) {
        return {
          url, success: false, error: e.message,
          scores: {}, details: {},
          totals: { total: 0, seoTotal: 0, geoTotal: 0, seoMax: 50, geoMax: 50 },
          grade: 'F', criteria: CRITERIA,
        };
      }
    };

    const [resultA, resultB] = await Promise.all([analyze(urlA), analyze(urlB)]);

    const diff = {};
    CRITERIA.forEach(c => {
      diff[c.id] = (resultA.scores[c.id] || 0) - (resultB.scores[c.id] || 0);
    });

    res.json({ resultA, resultB, diff });
  } catch (e) {
    console.error('[compare]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/report/pdf   — 분석 결과 JSON → PDF
// ─────────────────────────────────────────────────────────────
app.post('/api/report/pdf', async (req, res) => {
  try {
    const result = req.body;
    if (!result || !result.scores) {
      return res.status(400).json({ error: '유효한 분석 결과 JSON이 필요합니다.' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="geo-report-${Date.now()}.pdf"`);
    await buildPDF(result, res);
  } catch (e) {
    console.error('[pdf]', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/report/excel — 단일 또는 배열 → Excel
// ─────────────────────────────────────────────────────────────
app.post('/api/report/excel', (req, res) => {
  try {
    const results = req.body;
    if (!results) return res.status(400).json({ error: '분석 결과가 필요합니다.' });
    const buf = buildExcel(results);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="geo-report-${Date.now()}.xlsx"`);
    res.send(buf);
  } catch (e) {
    console.error('[excel]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/ai/analyze — Claude 정성 분석 (Phase 2)
// body: { result }  (기존 /api/analyze 응답 JSON)
// 키: 헤더 x-anthropic-key 또는 ANTHROPIC_API_KEY
// ─────────────────────────────────────────────────────────────
app.post('/api/ai/analyze', async (req, res) => {
  try {
    const { result } = req.body;
    if (!result || !result.meta) return res.status(400).json({ error: '분석 결과(result)가 필요합니다. 먼저 /api/analyze 를 실행하세요.' });
    const review = await aiAnalyze(result, { apiKey: req.get('x-anthropic-key') });
    try { db.saveAiReview(result.dbId, result.url, review); } catch (e2) { console.error('[db]', e2.message); }
    res.json(review);
  } catch (e) {
    console.error('[ai/analyze]', e.message);
    res.status(e.code === 'NO_API_KEY' ? 400 : 502).json({ error: e.message, code: e.code });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/site — 사이트 점검 (도메인 1회)  { url, articleUrl? }
// ─────────────────────────────────────────────────────────────
app.post('/api/site', async (req, res) => {
  try {
    const { url, articleUrl } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url(사이트 또는 기사 주소)이 필요합니다.' });
    res.json(await auditSite(url.trim(), { articleUrl: articleUrl && String(articleUrl).trim() }));
  } catch (e) {
    console.error('[site]', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/ai/rewrite — Claude GEO 리라이팅 (Phase 2)
// ─────────────────────────────────────────────────────────────
app.post('/api/ai/rewrite', async (req, res) => {
  try {
    const { result } = req.body;
    if (!result || !result.meta) return res.status(400).json({ error: '분석 결과(result)가 필요합니다. 먼저 /api/analyze 를 실행하세요.' });
    const rewrite = await aiRewrite(result, { apiKey: req.get('x-anthropic-key') });
    res.json(rewrite);
  } catch (e) {
    console.error('[ai/rewrite]', e.message);
    res.status(e.code === 'NO_API_KEY' ? 400 : 502).json({ error: e.message, code: e.code });
  }
});

// ─────────────────────────────────────────────────────────────
// 이력·시계열·추적 (Phase 3, lib/db.js)
// ─────────────────────────────────────────────────────────────
app.get('/api/history', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    res.json({ driver: db.driver, items: db.listAnalyses({ limit, q: (req.query.q || '').trim() }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history/urls', (_, res) => {
  try { res.json(db.distinctUrls()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history/:id', (req, res) => {
  try {
    const row = db.getAnalysis(req.params.id);
    if (!row) return res.status(404).json({ error: '이력을 찾을 수 없습니다.' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/history/:id', (req, res) => {
  try { db.deleteAnalysis(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/history', (_, res) => {
  try { db.clearAnalyses(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/timeseries', (req, res) => {
  try {
    const url = (req.query.url || '').trim();
    if (!url) return res.status(400).json({ error: 'url 쿼리가 필요합니다.' });
    res.json({ url, points: db.timeseries(url) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 추적 URL (주기 재분석) ───────────────────────────────────
app.get('/api/track', (_, res) => {
  try { res.json(db.listTracked()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/track', (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !url.startsWith('http')) return res.status(400).json({ error: '올바른 url이 필요합니다.' });
    res.json(db.trackUrl(url.trim()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/track/:id', (req, res) => {
  try { db.untrackUrl(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

async function runTrackedRecrawl() {
  const tracked = db.listTracked();
  const out = [];
  for (const t of tracked) {
    try {
      const page = await fetchURL(t.url);
        const html = page.html;
      const result = scoreHTML(html, t.url, page);
      db.saveAnalysis(result);
      db.touchTracked(t.id);
      out.push({ url: t.url, ok: true, total: result.totals.total, grade: result.grade });
    } catch (e) {
      out.push({ url: t.url, ok: false, error: e.message });
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return out;
}

app.post('/api/track/run', async (_, res) => {
  try { res.json({ ran: new Date().toISOString(), results: await runTrackedRecrawl() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 주기 재분석 스케줄러: 매일 GEO_RECRAWL_HOUR시(기본 6시) 1회. GEO_RECRAWL_HOUR=off 로 비활성화
const RECRAWL_HOUR = process.env.GEO_RECRAWL_HOUR ?? '6';
if (RECRAWL_HOUR !== 'off') {
  let lastRunDay = '';
  setInterval(async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() === Number(RECRAWL_HOUR) && lastRunDay !== day && db.listTracked().length) {
      lastRunDay = day;
      console.log('[recrawl] 추적 URL 재분석 시작');
      const r = await runTrackedRecrawl().catch(e => console.error('[recrawl]', e.message));
      if (r) console.log('[recrawl] 완료:', r.map(x => `${x.url} ${x.ok ? x.total : 'ERR'}`).join(', '));
    }
  }, 10 * 60 * 1000); // 10분 간격 체크
}

// ─────────────────────────────────────────────────────────────
// 실측 SoV (Phase 4, lib/sov.js)
// 키: 헤더 x-perplexity-key 또는 PERPLEXITY_API_KEY (체험: GEO_SOV_MOCK=1)
// ─────────────────────────────────────────────────────────────
app.get('/api/sov/config', (_, res) => {
  try { res.json(db.getConfig()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/sov/config', (req, res) => {
  try {
    const { myDomains, competitorDomains, sovEngine } = req.body || {};
    const patch = {};
    const norm = (a) => (Array.isArray(a) ? a : String(a || '').split(/[\n,]+/))
      .map(x => String(x).trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))
      .filter(Boolean);
    if (myDomains !== undefined) patch.myDomains = norm(myDomains);
    if (competitorDomains !== undefined) patch.competitorDomains = norm(competitorDomains);
    if (sovEngine) patch.sovEngine = String(sovEngine);
    res.json(db.setConfig(patch));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sov/keywords', (_, res) => {
  try { res.json(db.listKeywords()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sov/keywords', (req, res) => {
  try {
    const { keyword } = req.body || {};
    if (!keyword || !String(keyword).trim()) return res.status(400).json({ error: 'keyword가 필요합니다.' });
    res.json(db.addKeyword(String(keyword).trim()));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/sov/keywords/:id', (req, res) => {
  try { db.delKeyword(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

async function runSovChecks(apiKey) {
  const config = db.getConfig();
  if (!config.myDomains.length) {
    const err = new Error('자사 도메인이 설정되지 않았습니다. SoV 탭에서 먼저 설정하세요.');
    err.code = 'NO_CONFIG';
    throw err;
  }
  const keywords = db.listKeywords();
  if (!keywords.length) {
    const err = new Error('등록된 키워드가 없습니다.');
    err.code = 'NO_KEYWORDS';
    throw err;
  }
  const results = [];
  for (const k of keywords) {
    try {
      const r = await checkKeyword(k.keyword, config, { apiKey });
      db.saveSovCheck({ keyword: r.keyword, engine: r.engine, cited: r.cited, domain: r.myDomain, detail: r, checked_at: r.checkedAt });
      results.push(r);
    } catch (e) {
      if (e.code === 'NO_API_KEY' || e.code === 'BAD_API_KEY') throw e; // 키 문제면 전체 중단
      results.push({ keyword: k.keyword, error: e.message });
    }
    await new Promise(r2 => setTimeout(r2, 400));
  }
  const ok = results.filter(r => !r.error);
  return {
    ranAt: new Date().toISOString(),
    total: results.length,
    sov: ok.length ? Math.round(ok.filter(r => r.cited).length / ok.length * 100) : 0,
    compSov: ok.length ? Math.round(ok.filter(r => r.compCited).length / ok.length * 100) : 0,
    results,
  };
}

app.post('/api/sov/run', async (req, res) => {
  try { res.json(await runSovChecks(req.get('x-perplexity-key'))); }
  catch (e) {
    console.error('[sov/run]', e.message);
    res.status(['NO_API_KEY', 'NO_CONFIG', 'NO_KEYWORDS'].includes(e.code) ? 400 : 502).json({ error: e.message, code: e.code });
  }
});

app.get('/api/sov/checks', (req, res) => {
  try { res.json(db.listSovChecks({ keyword: (req.query.keyword || '').trim(), limit: Math.min(parseInt(req.query.limit, 10) || 200, 2000) })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sov/summary', (_, res) => {
  try {
    const all = db.listSovChecks({ limit: 2000 });
    // 기존 SoV(자동 측정) 지표는 API 결과만으로 계산. 수동 기록·LLMO는 engines 표에 따로
    const checks = all.filter(c => !String(c.engine).includes(':'));
    const nonLlmo = all.filter(c => !String(c.engine).startsWith('llmo:'));
    const config = db.getConfig();

    // 키워드별 최신 측정
    const latestByKw = new Map();
    checks.forEach(c => { if (!latestByKw.has(c.keyword)) latestByKw.set(c.keyword, c); });
    const latest = [...latestByKw.values()];

    // 일자별 SoV 추이
    const byDay = new Map();
    checks.forEach(c => {
      const day = String(c.checkedAt).slice(0, 10);
      const e = byDay.get(day) || { day, n: 0, my: 0, comp: 0 };
      e.n++; if (c.cited) e.my++; if (c.detail && c.detail.compCited) e.comp++;
      byDay.set(day, e);
    });
    const series = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
      .map(e => ({ day: e.day, n: e.n, mySov: Math.round(e.my / e.n * 100), compSov: Math.round(e.comp / e.n * 100) }));

    // 점수-인용 상관 힌트: 인용된 자사 URL과 분석 이력 매칭
    const citedUrls = new Set();
    checks.forEach(c => (c.detail && c.detail.myUrls || []).forEach(u => citedUrls.add(u.replace(/[?#].*$/, ''))));
    const analyses = db.listAnalyses({ limit: 500 });
    const isMine = (u) => { try { const h = new URL(u).hostname.replace(/^www\./, ''); return config.myDomains.some(d => h === d || h.endsWith('.' + d)); } catch (_) { return false; } };
    const mine = analyses.filter(a => a.url && isMine(a.url));
    const cited = mine.filter(a => citedUrls.has(a.url.replace(/[?#].*$/, '')));
    const uncited = mine.filter(a => !citedUrls.has(a.url.replace(/[?#].*$/, '')));
    const avg = (arr) => arr.length ? Math.round(arr.reduce((s2, a) => s2 + a.total, 0) / arr.length) : null;

    res.json({
      configured: config.myDomains.length > 0,
      mock: SOV_MOCK,
      keywords: db.listKeywords().length,
      totalChecks: checks.length,
      latest: latest.map(c => ({ keyword: c.keyword, cited: c.cited, compCited: !!(c.detail && c.detail.compCited), rank: c.detail && c.detail.rank || 0, myUrls: c.detail && c.detail.myUrls || [], engine: c.engine, checkedAt: c.checkedAt })),
      currentSov: latest.length ? Math.round(latest.filter(c => c.cited).length / latest.length * 100) : null,
      currentCompSov: latest.length ? Math.round(latest.filter(c => c.detail && c.detail.compCited).length / latest.length * 100) : null,
      series,
      correlation: { citedCount: cited.length, citedAvgScore: avg(cited), uncitedCount: uncited.length, uncitedAvgScore: avg(uncited) },
      // v3 고도화 C: 엔진별(자동+수동) 키워드 최신값 기준 인용률 + 낡은 데이터 표시
      engines: M.citationStats(M.latestPerKeywordEngine(nonLlmo)).byEngine,
      lastCheckedAt: checks.length ? checks[0].checkedAt : null,
      stale: M.isStale(checks.length ? checks[0].checkedAt : null),
      staleDays: M.STALE_DAYS,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ═════════════════════════════════════════════════════════════
// 측정 루프 (v3 고도화 C) — 기준선 → 수정 → 14일 뒤 재측정
// ═════════════════════════════════════════════════════════════
async function analyzeAndSave(url) {
  const page = await fetchURL(url);
  const result = scoreHTML(page.html, url, page);
  try { const saved = db.saveAnalysis(result); if (saved) result.dbId = saved.id; } catch (e) { console.error('[db]', e.message); }
  return result;
}
const expView = (e) => e && ({ ...e, status: M.expStatus(e) });

app.get('/api/exp', (_, res) => {
  try { res.json({ remeasureDays: M.REMEASURE_DAYS, items: db.listExperiments().map(expView) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 실험 시작 = 지금 상태를 기준선으로 채점·저장 (HTML 직접 입력도 허용)
app.post('/api/exp', async (req, res) => {
  try {
    const { url, name, keywords, html } = req.body || {};
    if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: '기사 URL(https://…)이 필요합니다.' });
    const result = html ? scoreHTML(html, url) : await analyzeAndSave(url);
    if (html) { const saved = db.saveAnalysis(result); if (saved) result.dbId = saved.id; }
    const kws = (Array.isArray(keywords) ? keywords : String(keywords || '').split(/[\n,]+/)).map(k => String(k).trim()).filter(Boolean).slice(0, 20);
    kws.forEach(k => { try { db.addKeyword(k); } catch (_) {} });   // 인용 측정 키워드로도 등록
    const exp = db.createExperiment({
      url, name: String(name || '').slice(0, 100), keywords: kws,
      baselineId: result.dbId || null, baselineAt: result.analyzedAt,
      baselineTotal: result.totals.total, baselineGrade: result.grade,
      changedAt: null, changeNote: '', dueAt: null, resultId: null, resultAt: null,
    });
    res.json(expView(exp));
  } catch (e) { res.status(502).json({ error: '기준선 채점 실패: ' + e.message }); }
});

// 수정 완료 표시 → 재측정일 예약
app.post('/api/exp/:id/changed', (req, res) => {
  try {
    const cur = db.getExperiment(req.params.id);
    if (!cur) return res.status(404).json({ error: '실험 없음' });
    const at = req.body && req.body.changedAt ? new Date(req.body.changedAt).toISOString() : new Date().toISOString();
    res.json(expView(db.updateExperiment(cur.id, {
      changedAt: at, changeNote: String((req.body && req.body.note) || '').slice(0, 500),
      dueAt: M.addDays(at, M.REMEASURE_DAYS),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function remeasure(exp) {
  const after = await analyzeAndSave(exp.url);
  const base = exp.baselineId ? db.getAnalysis(exp.baselineId) : null;
  if (!base) throw new Error('기준선 분석 기록을 찾지 못했습니다(이력에서 삭제됨).');
  const report = M.buildReport(exp, base.result, after, db.listSovChecks({ limit: 2000 }));
  return db.updateExperiment(exp.id, { resultId: after.dbId || null, resultAt: after.analyzedAt, resultTotal: after.totals.total, resultGrade: after.grade, report });
}

app.post('/api/exp/:id/remeasure', async (req, res) => {
  try {
    const exp = db.getExperiment(req.params.id);
    if (!exp) return res.status(404).json({ error: '실험 없음' });
    res.json(expView(await remeasure(exp)));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.delete('/api/exp/:id', (req, res) => {
  try { db.deleteExperiment(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 수동 인용 기록 (API가 없는 엔진) ─────────────────────────────
app.get('/api/measure/meta', (_, res) => res.json({
  manualEngines: M.MANUAL_ENGINES, llmoEngines: M.LLMO_ENGINES, llmoVerdicts: M.LLMO_VERDICTS,
  remeasureDays: M.REMEASURE_DAYS, staleDays: M.STALE_DAYS,
}));

app.post('/api/citations/manual', (req, res) => {
  try {
    const { keyword, engine, cited, compCited, citedUrl, note, checkedAt } = req.body || {};
    if (!keyword || !String(keyword).trim()) return res.status(400).json({ error: '질문(키워드)이 필요합니다.' });
    if (!M.MANUAL_ENGINES.some(e => e.key === engine)) return res.status(400).json({ error: '엔진 값이 올바르지 않습니다.' });
    const kw = String(keyword).trim();
    try { db.addKeyword(kw); } catch (_) {}
    db.saveSovCheck({
      keyword: kw, engine: 'manual:' + engine, cited: !!cited, domain: '',
      detail: { source: 'manual', compCited: !!compCited, myUrls: citedUrl ? [String(citedUrl).slice(0, 500)] : [], note: String(note || '').slice(0, 500) },
      checked_at: checkedAt ? new Date(checkedAt).toISOString() : new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LLMO 분기 점검 (브라우징 끈 모델이 매체를 아는가) ───────────
app.get('/api/llmo', (_, res) => {
  try {
    const rows = db.listSovChecks({ limit: 2000 }).filter(c => String(c.engine).startsWith('llmo:'))
      .map(c => ({ id: c.id, engine: c.engine.slice(5), label: M.engineLabel(c.engine), question: c.keyword, verdict: c.detail.verdict, verdictLabel: M.LLMO_VERDICTS[c.detail.verdict] || '', answer: c.detail.answer || '', checkedAt: c.checkedAt }));
    const last = rows.length ? rows[0].checkedAt : null;
    res.json({ items: rows, lastAt: last, stale: M.isStale(last, 92), nextDue: last ? M.addDays(last, 91) : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/llmo', (req, res) => {
  try {
    const { engine, question, verdict, answer } = req.body || {};
    if (!M.LLMO_ENGINES.some(e => e.key === engine)) return res.status(400).json({ error: '엔진 값이 올바르지 않습니다.' });
    if (!M.LLMO_VERDICTS[verdict]) return res.status(400).json({ error: '판정(unknown/wrong/correct)이 필요합니다.' });
    if (!question || !String(question).trim()) return res.status(400).json({ error: '질문이 필요합니다.' });
    db.saveSovCheck({ keyword: String(question).trim().slice(0, 200), engine: 'llmo:' + engine, cited: verdict === 'correct', domain: '',
      detail: { source: 'llmo', verdict, answer: String(answer || '').slice(0, 2000) } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── geo-dashboard 연동용 묶음 내보내기 ──────────────────────────
// 대시보드가 서버 주소로 직접 불러오거나(GET), 파일로 저장해 올릴 수 있게 한 번에 내보낸다
function measureBundle() {
  const all = db.listSovChecks({ limit: 2000 });
  const nonLlmo = all.filter(c => !String(c.engine).startsWith('llmo:'));
  const latest = M.latestPerKeywordEngine(nonLlmo);
  const llmo = all.filter(c => String(c.engine).startsWith('llmo:'));
  const config = db.getConfig();
  return {
    format: 'geo-measure-bundle', version: 1, exportedAt: new Date().toISOString(),
    myDomains: config.myDomains || [],
    staleDays: M.STALE_DAYS,
    engines: M.citationStats(latest).byEngine,
    citations: latest.map(c => ({ keyword: c.keyword, engine: c.engine, label: M.engineLabel(c.engine), cited: c.cited, compCited: !!(c.detail && c.detail.compCited), urls: (c.detail && c.detail.myUrls) || [], checkedAt: c.checkedAt })),
    citationDays: Object.values(nonLlmo.reduce((m, c) => { const d = String(c.checkedAt).slice(0, 10); const e = m[d] || (m[d] = { day: d, n: 0, cited: 0 }); e.n++; if (c.cited) e.cited++; return m; }, {})).sort((a, b) => a.day.localeCompare(b.day)),
    crawlers: M.crawlerSeries(db.listCrawlerDays({ days: 365 })),
    llmo: llmo.map(c => ({ engine: c.engine.slice(5), question: c.keyword, verdict: c.detail.verdict, checkedAt: c.checkedAt })),
    experiments: db.listExperiments().map(e => ({ id: e.id, name: e.name, url: e.url, status: M.expStatus(e).code, baselineAt: e.baselineAt, baselineTotal: e.baselineTotal, changedAt: e.changedAt, dueAt: e.dueAt, resultAt: e.resultAt, resultTotal: e.resultTotal || null, reportText: e.report ? e.report.text : '' })),
  };
}
app.get('/api/measure/export', (req, res) => {
  try {
    const b = measureBundle();
    if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="geo-measure-${b.exportedAt.slice(0, 10)}.json"`);
    res.json(b);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI 크롤러 방문 (서버 접속 로그 업로드) ──────────────────────
app.post('/api/crawlers/import', express.text({ type: '*/*', limit: '50mb' }), (req, res) => {
  try {
    const text = typeof req.body === 'string' ? req.body : (req.body && req.body.log) || '';
    if (!text.trim()) return res.status(400).json({ error: '로그 내용이 비어 있습니다.' });
    const parsed = M.parseAccessLog(text);
    const source = String(req.query.source || 'upload').slice(0, 50);
    db.saveCrawlerDays(parsed.rows, source);
    res.json({ lines: parsed.lines, matched: parsed.matched, undated: parsed.undated, days: [...new Set(parsed.rows.map(r => r.day))].length, bots: [...new Set(parsed.rows.map(r => r.bot))] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/crawlers', (req, res) => {
  try { res.json(M.crawlerSeries(db.listCrawlerDays({ days: Math.min(parseInt(req.query.days, 10) || 90, 730) }))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 재측정 예약일이 지난 실험은 매일 한 번 자동 재측정
if ((process.env.GEO_RECRAWL_HOUR || '6') !== 'off') {
  let lastExpDay = '';
  setInterval(async () => {
    const now = new Date(); const day = now.toISOString().slice(0, 10);
    if (lastExpDay === day || now.getHours() !== Number(process.env.GEO_RECRAWL_HOUR || 6)) return;
    lastExpDay = day;
    for (const e of db.listExperiments()) {
      if (e.changedAt && !e.resultAt && new Date(e.dueAt) <= now) {
        try { await remeasure(e); console.log('[exp] 자동 재측정 완료:', e.id, e.url); }
        catch (err) { console.error('[exp] 자동 재측정 실패:', e.id, err.message); }
      }
    }
  }, 10 * 60 * 1000);
}

// SoV 주기 측정: 추적 재분석과 동일 시각, 서버 환경변수 키가 있을 때만
const SOV_HOUR = process.env.GEO_SOV_HOUR ?? process.env.GEO_RECRAWL_HOUR ?? '6';
if (SOV_HOUR !== 'off') {
  let lastSovDay = '';
  setInterval(async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() === Number(SOV_HOUR) && lastSovDay !== day && sovAvailable() && db.listKeywords().length && db.getConfig().myDomains.length) {
      lastSovDay = day;
      console.log('[sov] 주기 측정 시작');
      const r = await runSovChecks().catch(e => console.error('[sov]', e.message));
      if (r) console.log(`[sov] 완료: SoV ${r.sov}% (경쟁사 ${r.compSov}%)`);
    }
  }, 10 * 60 * 1000);
}

// ─────────────────────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({
  status: 'ok',
  engineVersion: ENGINE_VERSION,
  aiModel: DEFAULT_MODEL,
  aiKeyConfigured: aiAvailable(),
  db: db.stats(),
  sov: { available: sovAvailable(), mock: SOV_MOCK, keywords: db.listKeywords().length },
  time: new Date().toISOString(),
}));

// ─────────────────────────────────────────────────────────────
// SPA fallback
// ─────────────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`✅ GEO Analyzer v3 (engine v${ENGINE_VERSION}) — http://localhost:${PORT}`);
  console.log(`   AI 정성 분석: ${aiAvailable() ? `활성 (${DEFAULT_MODEL})` : 'API 키 미설정 — UI 도구 탭 또는 ANTHROPIC_API_KEY'}`);
  console.log(`   이력 저장소: ${db.driver === 'sqlite' ? 'SQLite (data/geo.db)' : 'JSON 파일 (data/geo-history.json — Node 22.13+ 에서 SQLite 자동 사용)'}`);
  console.log(`   실측 SoV: ${SOV_MOCK ? '모크 모드 (GEO_SOV_MOCK=1)' : sovAvailable() ? '활성 (Perplexity)' : 'Perplexity 키 미설정 — UI SoV 탭 또는 PERPLEXITY_API_KEY'}`);
});
