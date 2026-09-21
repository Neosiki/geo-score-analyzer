'use strict';
// 사이트 점검 오프라인 테스트: node test/site.test.js (가짜 fetcher로 네트워크 없이 검증)
const assert = require('assert');
const { auditSite, parseRobots, robotsVerdict } = require('../lib/site');

// ── robots 파서 ──
const R = parseRobots(`User-agent: *
Disallow: /admin/
Allow: /admin/public$

User-agent: GPTBot
User-agent: CCBot
Disallow: /

User-agent: bingbot
Crawl-delay: 30

Sitemap: https://ex.com/sitemap.xml`);
const v = (bot, path) => robotsVerdict(R, bot, path).allowed;
assert.strictEqual(v('Googlebot', '/news/1'), true);
assert.strictEqual(v('Googlebot', '/admin/x'), false);
assert.strictEqual(v('Googlebot', '/admin/public'), true, '더 긴 Allow 우선, $ 끝 일치');
assert.strictEqual(v('GPTBot', '/news/1'), false, '여러 UA 한 그룹');
assert.strictEqual(v('CCBot', '/'), false);
assert.strictEqual(v('ChatGPT-User', '/news/1'), true, 'GPTBot 차단이 ChatGPT-User에 번지지 않음(정확 일치)');
assert.strictEqual(v('Bingbot', '/admin/x'), true, '전용 그룹이 있으면 * 무시(구글 명세)');
assert.strictEqual(R.groups.find(g => g.agents.includes('bingbot')).crawlDelay, 30);
assert.deepStrictEqual(R.sitemaps, ['https://ex.com/sitemap.xml']);
console.log('✅ robots parser OK');

// ── 가짜 사이트 ──
function site(map) {
  return async (url) => {
    const p = new URL(url).pathname + new URL(url).search;
    const hit = Object.keys(map).find(k => k === p) || (p.startsWith('/geo-analyzer-404-check-') ? '__404' : null);
    const r = hit ? map[hit] : { status: 404, body: '<html>not found</html>', ct: 'text/html' };
    return { status: r.status, headers: { 'content-type': r.ct || 'text/html' }, body: r.body };
  };
}
const htmlErr = '<!doctype html><html><head><meta name="robots" content="noindex"><title>매체A</title></head><body>페이지 없음</body></html>';
const articleHtml = `<html><head><title>라마제약 다라정 FDA 승인 &lt; 암 &lt; 기사본문 - 매체A</title>
<meta name="viewport" content="width=1100"><meta name="naver-site-verification" content="abc">
<meta property="og:title" content="t"><meta property="og:description" content="d"><meta property="og:image" content="i">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"매체A","sameAs":["https://facebook.com/x"]}</script></head>
<body><div id="article-view-content-div"><p>${'[매체A 김가명 기자] 라마제약는 2026년 9월 FDA로부터 다라정 병용요법 승인을 받았다고 밝혔다. '.repeat(15)}</p></div></body></html>`;

// 매체A형 (2026-09-21 실사 구조)
const thebio = site({
  '/': { status: 200, body: articleHtml },
  '/robots.txt': { status: 200, ct: 'text/plain', body: 'User-agent: *\nDisallow: /admin/\n\n\nUser-agent: bingbot\nCrawl-delay: 30\n\nSitemap: https://www.media-a.example/sitemap.xml\n' },
  '/sitemap.xml': { status: 200, ct: 'application/xml', body: '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">' + '<url><loc>https://www.media-a.example/news/articleView.html?idxno=1</loc><news:news></news:news></url>'.repeat(100) + '</urlset>' },
  '/llms.txt': { status: 404, body: htmlErr },
  '__404': { status: 404, body: htmlErr },
  '/news/articleView.html?idxno=1': { status: 200, body: articleHtml },
});

// 문제 사이트: AI 검색 봇 차단, soft 404, llms.txt가 HTML 200, 사이트맵 없음, JS 렌더링
const bad = site({
  '/': { status: 200, body: '<html><head></head><body><div id="app"></div><script src="app.js"></script></body></html>' },
  '/robots.txt': { status: 200, ct: 'text/plain', body: 'User-agent: *\nAllow: /\n\nUser-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /\n\nUser-agent: Yeti\nDisallow: /\n' },
  '/llms.txt': { status: 200, body: '<!doctype html><html><body>home</body></html>' },
  '__404': { status: 200, body: '<html><body>home</body></html>' },
  '/a/1': { status: 200, body: '<html><head><meta name="viewport" content="width=device-width"></head><body><div id="app"></div></body></html>' },
});

(async () => {
  const a = await auditSite('https://www.media-a.example/news/articleView.html?idxno=1', { fetcher: thebio });
  const st = (r, id) => (r.items.find(i => i.id === id) || {}).status;
  assert.strictEqual(st(a, 'robots_file'), 'ok');
  assert.strictEqual(st(a, 'bots_search'), 'ok');
  assert.strictEqual(st(a, 'bots_engine'), 'ok');
  assert.strictEqual(st(a, 'crawl_delay'), 'warn', 'bingbot Crawl-delay 30 경고');
  assert.strictEqual(st(a, 'sitemap'), 'ok');
  assert.strictEqual(st(a, 'news_sitemap'), 'ok');
  assert.strictEqual(st(a, 'sitemap_coverage'), 'warn', '최근 100개뿐');
  assert.strictEqual(st(a, 'llms_txt'), 'warn');
  assert.strictEqual(st(a, 'soft_404'), 'ok');
  assert.strictEqual(st(a, 'ssr'), 'ok');
  assert.strictEqual(st(a, 'org_entity'), 'fail', 'Person으로 선언된 매체');
  assert.ok(a.items.find(i => i.id === 'org_entity').evidence.includes('Person'));
  assert.strictEqual(st(a, 'author_entity'), 'fail', '기사 JSON-LD 없음');
  assert.strictEqual(st(a, 'naver_verify'), 'ok');
  assert.strictEqual(st(a, 'viewport'), 'warn', 'width=1100 고정 폭');
  console.log('✅ media-A-type site audit OK —', JSON.stringify(a.summary));

  const b = await auditSite('https://bad.example/a/1', { fetcher: bad });
  assert.strictEqual(st(b, 'bots_search'), 'fail');
  assert.ok(b.items.find(i => i.id === 'bots_search').evidence.includes('OAI-SearchBot'));
  assert.strictEqual(st(b, 'bots_engine'), 'fail', 'Yeti 차단');
  assert.strictEqual(st(b, 'llms_txt'), 'warn');
  assert.ok(b.items.find(i => i.id === 'llms_txt').evidence.includes('soft 200'));
  assert.strictEqual(st(b, 'soft_404'), 'fail');
  assert.strictEqual(st(b, 'sitemap'), 'fail');
  assert.strictEqual(st(b, 'ssr'), 'fail', 'JS 렌더링 본문 없음');
  assert.strictEqual(st(b, 'viewport'), 'ok');
  // 네트워크 오류도 죽지 않음
  // 접속 불가(주소 오타·사내망 차단)는 빈 결과표 대신 원인 메시지
  await assert.rejects(auditSite('https://down.example', { fetcher: async () => { throw new Error('ECONNREFUSED'); } }), /접속하지 못했습니다.*ECONNREFUSED/);
  await assert.rejects(auditSite('https://blocked.example/a', { fetcher: async () => ({ status: 403, headers: {}, body: 'Forbidden' }) }), /정상 응답하지 않습니다 \(홈 403, 기사 403\)/);
  console.log('✅ bad site audit OK —', JSON.stringify(b.summary));
})().catch(e => { console.error(e); process.exit(1); });
