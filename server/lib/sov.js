'use strict';
/**
 * sov.js — 실측 SoV(Share of Voice) 추적 (Phase 4)
 *
 * 키워드를 Perplexity API(검색 기반 AI, 인용 URL 반환)에 질의하고
 * 응답 인용 출처에서 자사/경쟁사 도메인을 매칭해 실제 인용 여부를 기록한다.
 *
 * 키 우선순위: opts.apiKey (요청 헤더 x-perplexity-key) → process.env.PERPLEXITY_API_KEY
 * 모델: config.sovEngine (기본 'sonar')
 * 모크 모드: GEO_SOV_MOCK=1 — 키 없이 UI/플로우 체험용 가짜 인용 생성
 */

const PPLX_URL = 'https://api.perplexity.ai/chat/completions';
const MOCK = process.env.GEO_SOV_MOCK === '1';

function resolveKey(opts = {}) {
  return opts.apiKey || process.env.PERPLEXITY_API_KEY || '';
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

function matchDomain(host, domains) {
  return domains.find(d => {
    const dd = String(d).trim().replace(/^www\./, '').toLowerCase();
    return dd && (host === dd || host.endsWith('.' + dd));
  }) || '';
}

/** Perplexity 1회 질의 → { answer, citations[] } */
async function queryPerplexity(keyword, opts = {}) {
  if (MOCK) {
    // 결정적 가짜 응답 (키워드 해시 기반) — 키 발급 전 플로우 점검용
    const h = [...keyword].reduce((a, c) => a + c.charCodeAt(0), 0);
    const my = (opts.myDomains || [])[0] || 'example.co.kr';
    const comp = (opts.competitorDomains || [])[0] || 'rival.co.kr';
    const pool = [
      `https://${my}/news/${h % 1000}`,
      `https://${comp}/article/${h % 777}`,
      `https://news.naver.com/main/${h % 500}`,
      `https://ko.wikipedia.org/wiki/k${h % 99}`,
    ];
    const citations = pool.filter((_, i) => (h >> i) % 2 === 0 || i === pool.length - 1);
    return { answer: `[모크 응답] "${keyword}"에 대한 요약입니다.`, citations, model: 'mock', mock: true };
  }

  const key = resolveKey(opts);
  if (!key) {
    const err = new Error('Perplexity API 키가 없습니다. SoV 탭에서 키를 입력하거나 PERPLEXITY_API_KEY 환경변수를 설정하세요. (키 발급 전 체험: GEO_SOV_MOCK=1)');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const model = opts.model || 'sonar';
  const res = await fetch(PPLX_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '당신은 검색 기반 어시스턴트다. 한국어 질문에 최신 출처를 인용해 간결히 답하라.' },
        { role: 'user', content: keyword },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Perplexity API 오류 (${res.status}): ${body.slice(0, 300)}`);
    err.code = res.status === 401 ? 'BAD_API_KEY' : 'API_ERROR';
    throw err;
  }

  const data = await res.json();
  const answer = data.choices?.[0]?.message?.content || '';
  // 응답 형식 호환: citations(string[]) 또는 search_results([{url,...}])
  let citations = Array.isArray(data.citations) ? data.citations.slice() : [];
  if (!citations.length && Array.isArray(data.search_results)) {
    citations = data.search_results.map(r => r && r.url).filter(Boolean);
  }
  return { answer, citations, model };
}

/**
 * 키워드 1개 측정 → 도메인 매칭 결과
 * @returns { keyword, cited, myDomain, myUrls, compCited, compDomain, citations, answer, rank }
 */
async function checkKeyword(keyword, config, opts = {}) {
  const myDomains = config.myDomains || [];
  const compDomains = config.competitorDomains || [];
  const r = await queryPerplexity(keyword, { ...opts, model: config.sovEngine, myDomains, competitorDomains: compDomains });

  let myDomain = '', compDomain = '', rank = 0;
  const myUrls = [], compUrls = [];
  r.citations.forEach((u, i) => {
    const host = hostOf(u);
    const m = matchDomain(host, myDomains);
    if (m) { if (!myDomain) { myDomain = m; rank = i + 1; } myUrls.push(u); }
    const c = matchDomain(host, compDomains);
    if (c) { if (!compDomain) compDomain = c; compUrls.push(u); }
  });

  return {
    keyword,
    engine: r.model + (r.mock ? ' (mock)' : ''),
    cited: !!myDomain,
    myDomain, myUrls, rank,
    compCited: !!compDomain, compDomain, compUrls,
    citations: r.citations,
    answer: (r.answer || '').slice(0, 600),
    checkedAt: new Date().toISOString(),
  };
}

function sovAvailable() {
  return MOCK || !!process.env.PERPLEXITY_API_KEY;
}

module.exports = { queryPerplexity, checkKeyword, sovAvailable, MOCK };
