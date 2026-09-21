'use strict';
/**
 * site.js — 사이트 점검 모듈 (도메인 1회, v3 고도화 B)
 *
 * 기사 한 편이 아니라 "이 매체 사이트가 검색·AI에 인용될 준비가 됐는가"를 본다.
 * 점수(100점)에는 넣지 않고 항목별 ✅/⚠️/❌ 판정 + 한 줄 근거 + 고칠 방법을 돌려준다.
 *
 *  1. robots.txt — AI 크롤러를 용도 3가지(학습 / AI 검색 색인 / 실시간 열람)로 나눠 허용 여부 판정
 *                  + 검색엔진(Googlebot·Bingbot·Yeti)
 *  2. 사이트맵 — robots 참조, 일반/뉴스 사이트맵, lastmod
 *  3. llms.txt — 존재·형식(HTML 오류 페이지를 200으로 주는 경우 구분)
 *  4. 404 응답 — 없는 주소에 404를 주는지(soft 404 여부)
 *  5. 서버 렌더링 — 자바스크립트 없이 받은 HTML에 기사 본문이 있는지
 *  6. 엔티티 — Organization(NewsMediaOrganization) @id·sameAs·logo, 기사 publisher·저자 Person
 *  7. 네이버·빙 — 소유확인 메타, og 태그, 모바일 viewport
 *
 * auditSite(url, { fetcher }) — fetcher(url) → { status, headers, body } (테스트에서 주입)
 * 참고: leopard627/fire-your-seo-agency (MIT)의 Phase 0 진단·AI 크롤러 정책표를 채점기 구조로 옮김
 */

const cheerio = require('cheerio');
const crypto = require('crypto');
const { scoreHTML } = require('./scorer');

// ── AI 크롤러 용도별 명단 (각사 공개 문서 기준, 분기마다 확인 권장) ─────────
const BOT_GROUPS = [
  { key: 'training', label: '학습용', desc: '모델 훈련 데이터 수집 — 막으면 미래 모델의 브랜드 인지(LLMO)가 약해짐',
    bots: ['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot', 'Applebot-Extended', 'Meta-ExternalAgent', 'Bytespider'] },
  { key: 'search', label: 'AI 검색 색인', desc: 'AI 검색의 자체 색인 — 막으면 ChatGPT·Claude·Perplexity 검색 답변에 인용되지 않음',
    bots: ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot'] },
  { key: 'user', label: '실시간 열람', desc: '사용자가 질문할 때 AI가 페이지를 여는 봇 — 막으면 답변 시점 인용·유입이 끊김',
    bots: ['ChatGPT-User', 'Claude-User', 'Perplexity-User'] },
  { key: 'engine', label: '검색엔진', desc: '구글·빙·네이버 — 빙 색인은 Copilot·ChatGPT 검색이 함께 씀',
    bots: ['Googlebot', 'Bingbot', 'Yeti'] },
];

// ── robots.txt 파서 (구글 명세: 가장 구체적인 UA 그룹, 가장 긴 규칙 우선, 동률이면 Allow) ──
function parseRobots(text) {
  const groups = []; const sitemaps = [];
  let cur = null, lastWasUA = false;
  String(text || '').split(/\r?\n/).forEach(raw => {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) return;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) return;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'sitemap') { if (val) sitemaps.push(val); return; }
    if (key === 'user-agent') {
      if (!cur || !lastWasUA) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasUA = true; return;
    }
    lastWasUA = false;
    if (!cur) return;
    if (key === 'allow' || key === 'disallow') cur.rules.push({ type: key, path: val });
    if (key === 'crawl-delay') cur.crawlDelay = Number(val) || 0;
  });
  return { groups, sitemaps };
}

function ruleMatches(rulePath, path) {
  if (rulePath === '') return false;               // "Disallow:" 빈 값 = 제한 없음
  let re = '^' + rulePath.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  if (re.endsWith('\\$')) re = re.slice(0, -2) + '$';
  return new RegExp(re).test(path);
}

function robotsVerdict(parsed, bot, path) {
  const b = bot.toLowerCase();
  // 봇 이름과 정확히 같은 UA 그룹(대소문자 무시), 없으면 *. 같은 UA가 여러 그룹에 나오면 규칙을 합친다
  let matched = parsed.groups.filter(g => g.agents.includes(b));
  const specific = matched.length > 0;
  if (!specific) matched = parsed.groups.filter(g => g.agents.includes('*'));
  if (!matched.length) return { allowed: true, group: 'none', rule: '' };
  const rules = matched.flatMap(g => g.rules);
  let win = null;
  rules.forEach(r => {
    if (!ruleMatches(r.path, path)) return;
    const len = r.path.replace(/\*/g, '').length;
    if (!win || len > win.len || (len === win.len && r.type === 'allow')) win = { ...r, len };
  });
  return { allowed: !win || win.type === 'allow', group: specific ? 'specific' : '*', rule: win ? `${win.type === 'allow' ? 'Allow' : 'Disallow'}: ${win.path}` : '' };
}

// ── 판정 도우미 ─────────────────────────────────────────────────
const OK = 'ok', WARN = 'warn', FAIL = 'fail', INFO = 'info';
const item = (id, area, label, status, evidence, fix = '') => ({ id, area, label, status, evidence, fix });

function ldBlocks($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const p = JSON.parse($(el).html() || '');
      const arr = Array.isArray(p) ? p : p['@graph'] ? p['@graph'] : [p];
      arr.forEach(x => x && typeof x === 'object' && out.push(x));
    } catch (_) {}
  });
  return out;
}
const typeHas = (b, re) => re.test(JSON.stringify(b['@type'] || ''));

async function defaultFetcher(url) {
  const axios = require('axios');
  const res = await axios.get(url, {
    timeout: 15000, maxContentLength: 8 * 1024 * 1024, validateStatus: () => true, responseType: 'text',
    transformResponse: [d => d],
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GEO-Analyzer/3.0; site-audit)', 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });
  return { status: res.status, headers: res.headers || {}, body: typeof res.data === 'string' ? res.data : String(res.data || '') };
}

async function safeFetch(fetcher, url) {
  try { return await fetcher(url); }
  catch (e) { return { status: 0, headers: {}, body: '', error: e.message }; }
}

const ctype = (r) => String((r.headers && (r.headers['content-type'] || r.headers['Content-Type'])) || '').toLowerCase();
const looksHtml = (r) => /text\/html/.test(ctype(r)) || /^\s*(<!doctype html|<html)/i.test(r.body || '');

// ────────────────────────────────────────────────────────────────
async function auditSite(inputUrl, opts = {}) {
  const fetcher = opts.fetcher || defaultFetcher;
  let u;
  try { u = new URL(/^https?:\/\//.test(inputUrl) ? inputUrl : 'https://' + inputUrl); }
  catch (_) { throw new Error('올바른 URL이 아닙니다: ' + inputUrl); }
  const origin = u.origin;
  const articleUrl = u.pathname && u.pathname !== '/' ? u.href : (opts.articleUrl || '');
  const articlePath = articleUrl ? new URL(articleUrl).pathname + (new URL(articleUrl).search || '') : '/';

  const items = [];

  // 병렬 수집
  const probe = '/geo-analyzer-404-check-' + crypto.randomBytes(4).toString('hex');
  const [home, robotsRes, llms, notFound, article] = await Promise.all([
    safeFetch(fetcher, origin + '/'),
    safeFetch(fetcher, origin + '/robots.txt'),
    safeFetch(fetcher, origin + '/llms.txt'),
    safeFetch(fetcher, origin + probe),
    articleUrl ? safeFetch(fetcher, articleUrl) : Promise.resolve(null),
  ]);

  // 사이트에 아예 접속되지 않으면(주소 오타·사내망 차단 등) 결과표 대신 원인을 알려준다
  if (!home.status && !robotsRes.status && !notFound.status && (!article || !article.status)) {
    const why = home.error || robotsRes.error || '';
    throw new Error(`사이트에 접속하지 못했습니다 (${origin}). 주소가 맞는지, 이 PC에서 인터넷에 나갈 수 있는지 확인하세요.` + (why ? ` [${why.slice(0, 120)}]` : ''));
  }
  const okStatus = (r) => r && r.status >= 200 && r.status < 400;
  if (!okStatus(home) && (!article || !okStatus(article))) {
    throw new Error(`사이트가 정상 응답하지 않습니다 (홈 ${home.status}${article ? ', 기사 ' + article.status : ''}). 주소 오류이거나, 사이트가 봇·해외 접속을 막고 있을 수 있습니다. 브라우저에서 열리는데 여기서 안 되면 "봇 차단"이 원인입니다 — 그 경우 검색·AI 봇도 막혔는지 robots.txt와 방화벽 설정을 확인하세요.`);
  }

  // ── 1. robots.txt · 크롤러 정책 ─────────────────────────────
  const robotsOk = robotsRes.status === 200 && !looksHtml(robotsRes);
  const parsed = robotsOk ? parseRobots(robotsRes.body) : { groups: [], sitemaps: [] };
  if (!robotsOk) {
    items.push(item('robots_file', '크롤러 정책', 'robots.txt', robotsRes.status >= 500 ? FAIL : WARN,
      robotsRes.status === 200 ? 'robots.txt 주소가 HTML 페이지를 돌려줌(파일 없음)' : `robots.txt 응답 ${robotsRes.status || '실패'}` + (robotsRes.status >= 500 ? ' — 5xx면 구글은 사이트 전체 크롤링을 멈출 수 있음' : ' — 없으면 모든 봇 허용으로 간주'),
      'robots.txt를 만들어 AI 크롤러 정책과 Sitemap 주소를 명시하세요'));
  } else {
    items.push(item('robots_file', '크롤러 정책', 'robots.txt', OK, `그룹 ${parsed.groups.length}개 · Sitemap ${parsed.sitemaps.length}개 선언`));
  }

  const crawler = BOT_GROUPS.map(g => ({
    key: g.key, label: g.label, desc: g.desc,
    bots: g.bots.map(bot => {
      const home = robotsVerdict(parsed, bot, '/');
      const art = articlePath !== '/' ? robotsVerdict(parsed, bot, articlePath) : home;
      return { bot, allowedHome: home.allowed, allowedArticle: art.allowed, rule: (art.allowed ? home : art).rule, group: art.group };
    }),
  }));
  const blockedIn = (key) => crawler.find(c => c.key === key).bots.filter(b => !b.allowedArticle).map(b => b.bot);
  const bTrain = blockedIn('training'), bSearch = blockedIn('search'), bUser = blockedIn('user'), bEngine = blockedIn('engine');

  items.push(item('bots_engine', '크롤러 정책', '검색엔진 허용 (Googlebot·Bingbot·Yeti)', bEngine.length ? FAIL : OK,
    bEngine.length ? `차단됨: ${bEngine.join(', ')}` : '모두 허용',
    bEngine.length ? `${bEngine.join(', ')} 차단을 풀어야 검색·AI 답변에 노출됩니다${bEngine.includes('Bingbot') ? ' (빙 색인은 Copilot·ChatGPT 검색이 사용)' : ''}${bEngine.includes('Yeti') ? ' (Yeti = 네이버)' : ''}` : ''));
  items.push(item('bots_search', '크롤러 정책', 'AI 검색 색인 봇 허용', bSearch.length ? FAIL : OK,
    bSearch.length ? `차단됨: ${bSearch.join(', ')}` : 'OAI-SearchBot·Claude-SearchBot·PerplexityBot 모두 허용',
    bSearch.length ? '인용 유입이 목표라면 검색 색인 봇은 허용하세요. 학습만 막고 싶다면 GPTBot·ClaudeBot 등 학습용만 Disallow' : ''));
  items.push(item('bots_user', '크롤러 정책', '실시간 열람 봇 허용', bUser.length ? WARN : OK,
    bUser.length ? `차단됨: ${bUser.join(', ')}` : 'ChatGPT-User·Claude-User·Perplexity-User 모두 허용',
    bUser.length ? '사용자 질문 시점의 인용·유입이 끊깁니다. 차단 의도가 없다면 허용하세요' : ''));
  items.push(item('bots_training', '크롤러 정책', '학습용 봇 정책', INFO,
    bTrain.length ? `차단: ${bTrain.join(', ')}${bTrain.length < 7 ? ' · 허용: ' + crawler[0].bots.filter(b => b.allowedArticle).map(b => b.bot).join(', ') : ''}` : '학습용 봇 모두 허용',
    bTrain.length && (bSearch.length || bUser.length) ? '학습 차단은 선택이지만, 검색·열람 봇까지 함께 막혀 있으면 인용이 사라집니다' : 'AI 학습 허용 여부는 매체 정책 판단 사항입니다(검색 인용과는 별개)'));

  // Crawl-delay: 구글은 무시하지만 빙·네이버는 따른다 → 값이 크면 새 기사 수집이 느려짐
  const delays = parsed.groups.filter(g => g.crawlDelay >= 5).map(g => ({ agents: g.agents.join(','), d: g.crawlDelay }));
  if (delays.length) {
    const worst = delays.reduce((a, b) => (b.d > a.d ? b : a));
    items.push(item('crawl_delay', '크롤러 정책', 'Crawl-delay (수집 간격)', worst.d >= 10 ? WARN : INFO,
      delays.map(x => `${x.agents}: ${x.d}초`).join(' · ') + ` → 하루 최대 약 ${Math.floor(86400 / worst.d).toLocaleString()}쪽`,
      '빙·네이버는 Crawl-delay를 따릅니다. 빙 색인은 Copilot·ChatGPT 검색이 쓰므로, 서버 부하 문제가 없다면 값을 줄이거나 지우세요(구글은 무시)'));
  }

  // ── 2. 사이트맵 ────────────────────────────────────────────
  const smUrls = parsed.sitemaps.length ? parsed.sitemaps.slice(0, 3) : [origin + '/sitemap.xml'];
  const smRes = await Promise.all(smUrls.map(s => safeFetch(fetcher, s)));
  const smInfo = smRes.map((r, i) => {
    const b = r.body || '';
    const ok = r.status === 200 && /<(urlset|sitemapindex)\b/i.test(b);
    return { url: smUrls[i], status: r.status, ok,
      index: /<sitemapindex\b/i.test(b), news: /xmlns:news=|<news:news\b|news[-_]?sitemap/i.test(b + smUrls[i]),
      urls: (b.match(/<loc>/gi) || []).length, lastmod: /<lastmod>/i.test(b) };
  });
  const smGood = smInfo.filter(x => x.ok);
  if (!smGood.length) {
    items.push(item('sitemap', '색인', '사이트맵', FAIL, parsed.sitemaps.length ? `robots에 선언된 사이트맵 응답 오류(${smInfo.map(x => x.status).join(', ')})` : 'robots.txt에 Sitemap 선언 없음, /sitemap.xml도 없음',
      '사이트맵을 만들고 robots.txt에 "Sitemap: 주소"로 선언하세요. 새 기사가 빨리 색인됩니다'));
  } else {
    const noRef = !parsed.sitemaps.length;
    items.push(item('sitemap', '색인', '사이트맵', noRef ? WARN : OK,
      smGood.map(x => `${x.index ? '인덱스' : 'URL목록'} ${x.urls}개${x.lastmod ? '' : '(lastmod 없음)'}`).join(' · ') + (noRef ? ' — robots.txt에 선언 안 됨' : ''),
      noRef ? 'robots.txt에 "Sitemap: ' + smGood[0].url + '"를 추가하세요' : smGood.some(x => !x.lastmod) ? 'lastmod(수정 시각)를 정확히 넣으면 구글이 갱신 기사를 빨리 다시 읽습니다' : ''));
  }
  if (smGood.length && smGood.every(x => !x.index) && smGood.reduce((n, x) => n + x.urls, 0) <= 1000) {
    items.push(item('sitemap_coverage', '색인', '전체 기사 사이트맵', WARN,
      `사이트맵에 최근 URL ${smGood.reduce((n, x) => n + x.urls, 0)}개뿐 — 지난 기사는 사이트맵에 없음`,
      '최근 기사용 뉴스 사이트맵과 별도로, 전체 기사를 월별로 나눈 사이트맵 인덱스를 두면 지난 기사도 색인·인용됩니다'));
  }
  items.push(item('news_sitemap', '색인', '뉴스 사이트맵', smGood.some(x => x.news) ? OK : WARN,
    smGood.some(x => x.news) ? '뉴스 사이트맵 확인' : '뉴스 사이트맵(news:news) 확인 안 됨 — 인덱스 안쪽에 있을 수 있음',
    smGood.some(x => x.news) ? '' : '언론사라면 최근 2일 기사를 담은 구글 뉴스 사이트맵을 두는 것이 좋습니다'));

  // ── 3. llms.txt ───────────────────────────────────────────
  const llmsOk = llms.status === 200 && !looksHtml(llms) && (llms.body || '').trim().length > 20;
  items.push(item('llms_txt', 'AI 안내', 'llms.txt', llmsOk ? OK : WARN,
    llmsOk ? `있음 (${(llms.body || '').length.toLocaleString()}자${/^#\s/m.test(llms.body) ? ', 마크다운 제목 있음' : ''})`
      : llms.status === 200 ? '주소가 HTML 페이지를 돌려줌 — 파일 없음(soft 200)' : `없음 (응답 ${llms.status || '실패'})`,
    llmsOk ? '' : '사이트 루트에 /llms.txt(마크다운)로 매체 소개·핵심 섹션·데이터 출처·인용 표기 방법을 적으세요. 아직 표준은 아니지만 비용이 거의 들지 않습니다'));

  // ── 4. 404 응답 ────────────────────────────────────────────
  const nfOk = notFound.status === 404 || notFound.status === 410;
  items.push(item('soft_404', '색인', '없는 주소 응답', nfOk ? OK : notFound.status === 200 ? FAIL : WARN,
    `존재하지 않는 주소에 ${notFound.status || '응답 실패'} 반환`,
    nfOk ? '' : notFound.status === 200 ? '없는 페이지가 200(정상)으로 응답 — soft 404는 색인 예산을 낭비합니다. 404를 돌려주세요' : ''));

  // ── 5. 서버 렌더링 ────────────────────────────────────────
  let articleScore = null;
  if (article && article.status === 200) {
    articleScore = scoreHTML(article.body, articleUrl, { headers: article.headers, status: article.status });
    const len = articleScore.meta.bodyLen;
    items.push(item('ssr', '색인', '자바스크립트 없이 본문 보임', len >= 400 ? OK : len >= 150 ? WARN : FAIL,
      `JS 없이 받은 HTML의 본문 ${len.toLocaleString()}자 (추출: ${articleScore.meta.extraction})`,
      len >= 400 ? '' : '본문이 자바스크립트로 그려지면 검색·AI 봇이 못 읽습니다. 서버 렌더링(SSR)으로 바꾸세요'));
  } else if (article) {
    items.push(item('ssr', '색인', '자바스크립트 없이 본문 보임', WARN, `기사 주소 응답 ${article.status || '실패'} — 확인 못함`));
  } else {
    items.push(item('ssr', '색인', '자바스크립트 없이 본문 보임', INFO, '기사 URL을 함께 넣으면 확인합니다'));
  }

  // ── 6. 엔티티 (Organization · publisher · 저자) ───────────
  const $h = cheerio.load(home.body || '');
  const $a = article && article.status === 200 ? cheerio.load(article.body) : null;
  const allLd = ldBlocks($h).concat($a ? ldBlocks($a) : []);
  const org = allLd.find(b => typeHas(b, /Organization|NewsMediaOrganization/)) ||
    (allLd.find(b => typeHas(b, /Article/) && b.publisher && typeof b.publisher === 'object') || {}).publisher;
  const wrongOrg = allLd.find(b => typeHas(b, /^"?Person"?$/) && b.sameAs && !org);
  if (org) {
    const miss = ['@id', 'sameAs', 'logo', 'url'].filter(k => !org[k] || (Array.isArray(org[k]) && !org[k].length));
    items.push(item('org_entity', '엔티티', '매체(Organization) 정보', miss.length >= 2 ? WARN : OK,
      `${JSON.stringify(org['@type'] || 'publisher')} "${org.name || '(이름 없음)'}"` + (miss.length ? ` — 없음: ${miss.join(', ')}` : ` · sameAs ${[].concat(org.sameAs).length}개`),
      miss.length ? '@id(고정 식별자)·sameAs(공식 SNS·위키 등)·logo를 넣으면 AI가 매체를 하나의 실체로 인식합니다. 전 페이지에서 같은 @id를 쓰세요' : ''));
  } else {
    items.push(item('org_entity', '엔티티', '매체(Organization) 정보', FAIL,
      wrongOrg ? `매체를 "Person"(사람)으로 선언함: "${wrongOrg.name || ''}"` : 'Organization/NewsMediaOrganization JSON-LD 없음',
      '"@type":"NewsMediaOrganization"으로 매체명·로고·sameAs·@id를 선언하세요' + (wrongOrg ? '. 지금의 Person 선언은 매체를 사람으로 알려줍니다' : '')));
  }
  if ($a) {
    const art = ldBlocks($a).find(b => typeHas(b, /Article/));
    const auth = art && [].concat(art.author || [])[0];
    const authObj = auth && typeof auth === 'object' ? auth : null;
    items.push(item('author_entity', '엔티티', '기자(저자) 정보', !art ? FAIL : !authObj ? WARN : (authObj.url || authObj.sameAs) ? OK : WARN,
      !art ? '기사 JSON-LD 없음 — 저자 정보를 기계가 읽을 수 없음'
        : !authObj ? `author ${auth ? '"' + auth + '" (문자열)' : '없음'}`
        : `Person "${authObj.name || ''}"${authObj.url ? ' · 기자 페이지 있음' : ''}${authObj.sameAs ? ' · sameAs 있음' : ''}`,
      !art ? 'NewsArticle JSON-LD에 author(Person)를 넣으세요' : (authObj && (authObj.url || authObj.sameAs)) ? '' : 'author를 {"@type":"Person","name":…,"url":기자 페이지}로 쓰면 전문성(E-E-A-T) 신호가 됩니다'));
  }

  // ── 7. 네이버·빙·소셜 ─────────────────────────────────────
  const $p = $a || $h;
  const meta = (sel) => ($p(sel).attr('content') || $h(sel).attr('content') || '').trim();
  const naverV = meta('meta[name="naver-site-verification"]');
  const bingV = meta('meta[name="msvalidate.01"]');
  items.push(item('naver_verify', '네이버·빙', '네이버 서치어드바이저 소유확인', naverV ? OK : INFO,
    naverV ? '메타 태그 확인' : '메타 태그 없음 — 파일 방식으로 인증했을 수 있음',
    naverV ? '' : '서치어드바이저 등록 여부를 확인하세요. 수집 요청·검색어 통계를 쓰려면 필수입니다'));
  items.push(item('bing_verify', '네이버·빙', '빙 웹마스터도구 소유확인', bingV ? OK : INFO,
    bingV ? '메타 태그 확인' : '메타 태그 없음 — DNS·파일·구글서치콘솔 가져오기로 인증했을 수 있음',
    bingV ? '' : '빙 웹마스터도구 등록 여부를 확인하세요. Copilot·ChatGPT 검색이 빙 색인을 씁니다'));
  const og = ['og:title', 'og:description', 'og:image'].filter(k => !meta(`meta[property="${k}"]`));
  items.push(item('og_tags', '네이버·빙', 'OG 태그 (공유·네이버 미리보기)', og.length ? WARN : OK,
    og.length ? `없음: ${og.join(', ')}` : 'og:title·description·image 모두 있음', og.length ? '기사마다 고유한 OG 태그를 넣으세요' : ''));
  const vp = meta('meta[name="viewport"]');
  const responsive = /width\s*=\s*device-width/i.test(vp);
  items.push(item('viewport', '네이버·빙', '모바일 viewport', !vp ? FAIL : responsive ? OK : WARN,
    vp ? vp.slice(0, 60) + (responsive ? '' : ' — 고정 폭(모바일 대응 아님)') : 'viewport 메타 없음',
    responsive ? '' : '네이버·구글 모두 모바일 화면 기준으로 평가합니다. 모바일 페이지가 따로 없다면 width=device-width 반응형으로 바꾸세요'));

  const count = (s) => items.filter(i => i.status === s).length;
  return {
    origin, articleUrl, checkedAt: new Date().toISOString(),
    summary: { ok: count(OK), warn: count(WARN), fail: count(FAIL), info: count(INFO) },
    items, crawler,
    sitemaps: smInfo, robotsSitemaps: parsed.sitemaps,
    homeStatus: home.status,
    article: articleScore ? { total: articleScore.totals.total, grade: articleScore.grade, indexability: articleScore.indexability } : null,
  };
}

module.exports = { auditSite, parseRobots, robotsVerdict, BOT_GROUPS };
