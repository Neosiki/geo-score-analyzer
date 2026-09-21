'use strict';
/**
 * scorer.js — GEO Score 채점 엔진 v2
 * v2 변경점:
 *  - B1/B2 버그 수정: title_length / meta_length 범위 판정 (|| → &&)
 *  - B3: JSON-LD 전수 검사 (@graph 지원, NewsArticle 우선)
 *  - B4: 본문 추출 개선 — 한국 언론사 셀렉터 체인 → 폴백
 *  - B5: 링크 분류를 URL hostname 비교로 교체
 *  - 신규 GEO 항목: structure_lists(4), question_headings(3) / 배점 재조정 (총점 100 유지)
 * v3 변경점 (2026-09-21):
 *  - 색인·인용 차단 게이트(indexability): meta robots / 봇별 meta / X-Robots-Tag 헤더의
 *    noindex·none·nosnippet·max-snippet:0 감지. 점수와 별개로 "인용 불가/제한" 판정을 반환
 *  - scoreHTML(html, url, { headers, status }) — 세 번째 인자는 선택 (기존 호출과 호환)
 *  - 신규 GEO 항목 ld_consistency(3): JSON-LD headline·author·datePublished가 화면 내용과 일치하는지
 *    배점 조정 ld_json 5→4, article_schema 8→6 (GEO 50 유지)
 *  - 신규 GEO 항목 para_citability(4): 문단마다 떼어 읽어도 뜻이 통하는지(지시어 시작 여부)와
 *    수치에 기준 시점이 붙었는지. 배점 조정 first_para 10→6
 *  - external_links(4) 재정의: "외부 링크 1개 이상" → "원출처(1차 소스) 링크". 공시·임상등록·논문·
 *    규제기관·보도자료 배포처 링크를 우대하고 공유 버튼·SNS·광고 링크는 제외. 항목 id는 유지(이력 호환)
 *  - injectionSignals: 본문·숨김 요소 속 AI 대상 지시문(프롬프트 인젝션) 탐지. 점수 외 경고
 */

const cheerio = require('cheerio');

const ENGINE_VERSION = 3;

// ── 22 CRITERIA (SEO 50 + GEO 50) ─────────────────────────────────
const CRITERIA = [
  { id:'title_exists',      group:'seo', cat:'제목·메타',    label:'제목 태그 존재',                 max:5  },
  { id:'title_length',      group:'seo', cat:'제목·메타',    label:'제목 태그 길이 (45-65자)',        max:5  },
  { id:'meta_exists',       group:'seo', cat:'제목·메타',    label:'메타 디스크립션 존재',            max:5  },
  { id:'meta_length',       group:'seo', cat:'제목·메타',    label:'메타 디스크립션 길이 (120-160자)', max:3  },
  { id:'h1_count',          group:'seo', cat:'헤딩 구조',    label:'H1 태그 (1개)',                   max:5  },
  { id:'h2_count',          group:'seo', cat:'헤딩 구조',    label:'H2 태그 (2개 이상)',              max:5  },
  { id:'img_alt',           group:'seo', cat:'이미지',       label:'이미지 alt 텍스트',               max:5  },
  { id:'internal_links',    group:'seo', cat:'링크',         label:'내부 링크 (3개+)',                max:5  },
  { id:'external_links',    group:'seo', cat:'링크',         label:'원출처(1차 소스) 링크',           max:4  },
  { id:'content_length',    group:'seo', cat:'콘텐츠',       label:'본문 길이 (800자+)',              max:4  },
  { id:'canonical',         group:'seo', cat:'콘텐츠',       label:'Canonical 태그',                 max:4  },
  { id:'fact_numbers',      group:'geo', cat:'팩트 밀도',    label:'숫자·퍼센트 밀도 (5개+)',         max:8  },
  { id:'fact_dates',        group:'geo', cat:'팩트 밀도',    label:'날짜·연도 명시 (2개+)',           max:5  },
  { id:'first_para',        group:'geo', cat:'AI 인용 구조', label:'첫 문단 완결성',                  max:6  },
  { id:'para_citability',   group:'geo', cat:'AI 인용 구조', label:'문단 독립성·수치 기준 시점',      max:4  },
  { id:'ld_json',           group:'geo', cat:'AI 인용 구조', label:'JSON-LD 구조화 데이터',           max:4  },
  { id:'article_schema',    group:'geo', cat:'AI 인용 구조', label:'Article/NewsArticle 스키마',     max:6  },
  { id:'ld_consistency',    group:'geo', cat:'AI 인용 구조', label:'JSON-LD·화면 내용 일치',          max:3  },
  { id:'structure_lists',   group:'geo', cat:'AI 인용 구조', label:'목록·표 구조 (AI 발췌 친화)',     max:4  },
  { id:'question_headings', group:'geo', cat:'AI 인용 구조', label:'질문형 헤딩·FAQ 스키마',          max:3  },
  { id:'author',            group:'geo', cat:'E-E-A-T',     label:'저자(Byline) 정보',               max:4  },
  { id:'pub_date',          group:'geo', cat:'E-E-A-T',     label:'발행 날짜 태그',                  max:3  },
];

const SEO_MAX = CRITERIA.filter(c => c.group === 'seo').reduce((s, c) => s + c.max, 0); // 50
const GEO_MAX = CRITERIA.filter(c => c.group === 'geo').reduce((s, c) => s + c.max, 0); // 50

// ── 본문 컨테이너 셀렉터 체인 (한국 언론사 패턴 포함) ──────────────
const ARTICLE_SELECTORS = [
  '[itemprop="articleBody"]',
  '#articleBody', '#article-view-content-div', '#newsEndContents',
  '#dic_area',
  '.article_body', '.article-body', '.news_body', '.news-article-body',
  '.article_txt', '.article-text', '.art_txt', '#articletxt', '#news_body_area',
  'article',
];

// ── JSON-LD 전수 파싱 ──────────────────────────────────────────────
function parseAllLdJson($) {
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html() || '';
    if (!raw.trim()) return;
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed
        : parsed['@graph'] && Array.isArray(parsed['@graph']) ? parsed['@graph']
        : [parsed];
      items.forEach(it => { if (it && typeof it === 'object') blocks.push(it); });
    } catch (_) { /* 파싱 불가 블록 무시 */ }
  });
  const typeOf = (b) => JSON.stringify(b['@type'] || '');
  const articleBlock = blocks.find(b => /NewsArticle|BlogPosting/i.test(typeOf(b)))
    || blocks.find(b => /Article/i.test(typeOf(b)));
  const faqBlock = blocks.find(b => /FAQPage/i.test(typeOf(b)));
  return { blocks, articleBlock, faqBlock };
}

function hostnameOf(href, base) {
  try { return new URL(href, base || 'http://x.invalid').hostname.replace(/^www\./, ''); }
  catch (_) { return ''; }
}


// ── 색인·인용 차단 게이트 (v3) ─────────────────────────────────────
// 검색·AI 답변에 쓰이는 봇 이름. 'robots'는 전체 대상.
const GATE_BOTS = ['robots', 'googlebot', 'googlebot-news', 'bingbot', 'yeti', 'naverbot'];
const BOT_LABEL = {
  robots: '모든 검색봇', googlebot: 'Googlebot', 'googlebot-news': 'Googlebot-News',
  bingbot: 'Bingbot(Copilot·ChatGPT 검색)', yeti: 'Yeti(네이버)', naverbot: 'Naverbot',
};

function parseDirectives(str) {
  return String(str || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
}

// X-Robots-Tag 헤더: "noindex", "googlebot: noindex, nofollow", 여러 줄/배열 가능
function parseXRobots(value) {
  const vals = Array.isArray(value) ? value : value ? [value] : [];
  const out = []; // { bot, directives[] }
  vals.forEach(v => {
    String(v).split(/\n/).forEach(line => {
      const m = line.match(/^\s*([a-z0-9_-]+)\s*:\s*(.+)$/i);
      // "googlebot: noindex"는 봇 지정, "max-snippet: 0"처럼 콜론이 지시어 자체인 경우는 전체 대상
      if (m && !/^(max-snippet|max-image-preview|max-video-preview|unavailable_after)$/i.test(m[1])) {
        out.push({ bot: m[1].toLowerCase(), directives: parseDirectives(m[2]) });
      } else if (line.trim()) {
        out.push({ bot: 'robots', directives: parseDirectives(line) });
      }
    });
  });
  return out;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function detectIndexability($, opts = {}) {
  const rules = []; // { source, bot, directives[] }
  $('meta[name]').each((_, el) => {
    const name = String(el.attribs.name || '').toLowerCase().trim();
    if (!GATE_BOTS.includes(name)) return;
    rules.push({ source: 'meta', bot: name, directives: parseDirectives(el.attribs.content) });
  });
  parseXRobots(headerValue(opts.headers, 'x-robots-tag'))
    .forEach(r => rules.push({ source: 'header', ...r }));

  const blockers = [], limits = [];
  const where = (r) => (r.source === 'header' ? 'X-Robots-Tag 헤더' : '<meta name="' + r.bot + '">');
  rules.forEach(r => {
    const who = BOT_LABEL[r.bot] || r.bot;
    const d = r.directives;
    if (d.includes('noindex') || d.includes('none')) {
      blockers.push({ bot: r.bot, directive: d.includes('none') ? 'none' : 'noindex', source: r.source,
        message: where(r) + ' → ' + who + ' 색인 차단(noindex). 검색·AI 답변 모두에서 인용될 수 없음' });
    }
    if (d.includes('nosnippet')) {
      limits.push({ bot: r.bot, directive: 'nosnippet', source: r.source,
        message: where(r) + ' → ' + who + ' nosnippet. 구글 AI 개요·스니펫에 본문 인용 불가' });
    }
    const ms = d.map(x => x.match(/^max-snippet\s*:\s*(-?\d+)/)).find(Boolean);
    if (ms && Number(ms[1]) === 0) {
      limits.push({ bot: r.bot, directive: 'max-snippet:0', source: r.source,
        message: where(r) + ' → ' + who + ' max-snippet:0. nosnippet과 같은 효과' });
    }
  });
  const dataNosnippet = $('[data-nosnippet]').length;

  const httpStatus = Number(opts.status) || null;
  if (httpStatus && httpStatus >= 400) {
    blockers.push({ bot: 'robots', directive: 'http-' + httpStatus, source: 'http',
      message: 'HTTP ' + httpStatus + ' 응답. 검색엔진은 이 페이지를 색인하지 않음' });
  }

  const status = blockers.length ? 'blocked' : limits.length ? 'limited' : 'ok';
  return {
    status,
    citable: status !== 'blocked',
    label: status === 'blocked' ? '인용 불가 — 색인 차단' : status === 'limited' ? '인용 제한 — 스니펫 차단' : '색인·인용 가능',
    blockers, limits,
    dataNosnippet,
    headerChecked: !!opts.headers,
    rules,
  };
}

// ── JSON-LD ↔ 화면 일치 검사 (v3) ──────────────────────────────────
const normText = (t) => String(t || '').toLowerCase()
  .replace(/&[a-z]+;/g, ' ')
  .replace(/[\s"'“”‘’`·…,.:;!?()\[\]{}<>|\/\\\-–—_~@#$%^&*+=]/g, '');

// 제목 끝의 " - 매체명", " | 매체명", " : 매체명" 제거
const stripSiteSuffix = (t) => String(t || '')
  .replace(/\s*[-|:｜–—]\s*[^-|:｜–—]{1,20}$/, '')
  .replace(/\s*<\s*[^<]{1,20}<\s*기사본문\s*$/, '')   // 엔디소프트 CMS: "제목 < 섹션 < 기사본문 - 매체"
  .trim();

function bigramSim(a, b) {
  a = normText(a); b = normText(b);
  if (!a || !b) return 0;
  if (a === b || a.includes(b) || b.includes(a)) return 1;
  const grams = (x) => { const g = new Set(); for (let i = 0; i < x.length - 1; i++) g.add(x.slice(i, i + 2)); return g; };
  const A = grams(a), B = grams(b);
  let inter = 0; A.forEach(g => { if (B.has(g)) inter++; });
  return inter / Math.max(1, Math.min(A.size, B.size));
}

function ldAuthorNames(a) {
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  return arr.map(x => (typeof x === 'string' ? x : x && x.name) || '')
    .map(n => String(n).replace(/\s*(기자|특파원|논설위원|에디터|reporter)\s*$/i, '').trim())
    .filter(Boolean);
}

function ymd(v) {
  const m = String(v || '').match(/(20\d{2})[-.\/년\s]+(\d{1,2})[-.\/월\s]+(\d{1,2})/);
  return m ? { y: m[1], m: String(+m[2]), d: String(+m[3]) } : null;
}

function dateInText(date, text) {
  if (!date) return false;
  const { y, m, d } = date;
  const re = new RegExp(y + '\\s*[-.\\/년]\\s*0?' + m + '\\s*[-.\\/월]\\s*0?' + d + '(?!\\d)');
  return re.test(text);
}

function checkLdConsistency($, ld, visible) {
  const a = ld.articleBlock;
  const result = { checked: !!a, checks: [], issues: [], passed: 0 };
  if (!a) return result;

  // ① headline ↔ title / h1 / og:title
  const headline = typeof a.headline === 'string' ? a.headline : (a.name || '');
  const cands = [$('h1').first().text(), stripSiteSuffix($('title').first().text()),
    stripSiteSuffix($('meta[property="og:title"]').attr('content'))].filter(x => x && x.trim());
  if (!headline) {
    result.checks.push({ field: 'headline', ok: false, note: 'LD에 headline 없음' });
    result.issues.push('JSON-LD에 headline이 없습니다');
  } else {
    const best = cands.reduce((mx, c) => Math.max(mx, bigramSim(headline, c)), 0);
    const ok = best >= 0.6;
    result.checks.push({ field: 'headline', ok, ld: headline, visible: cands[0] || '', sim: Math.round(best * 100) / 100 });
    if (!ok) result.issues.push('LD headline "' + headline.slice(0, 40) + '"이(가) 화면 제목과 다릅니다');
  }

  // ② author ↔ 화면에 보이는 바이라인
  const names = ldAuthorNames(a.author);
  if (!names.length) {
    result.checks.push({ field: 'author', ok: false, note: 'LD에 author 없음' });
    result.issues.push('JSON-LD에 author가 없습니다');
  } else {
    const vis = normText(visible);
    const missing = names.filter(n => !vis.includes(normText(n)));
    const ok = missing.length === 0;
    result.checks.push({ field: 'author', ok, ld: names.join(', '), missing });
    if (!ok) result.issues.push('LD 저자 "' + missing.join(', ') + '"이(가) 화면 바이라인에 보이지 않습니다');
  }

  // ③ datePublished ↔ 화면 표시 날짜
  const pub = ymd(a.datePublished);
  if (!pub) {
    result.checks.push({ field: 'datePublished', ok: false, note: 'LD에 datePublished 없음' });
    result.issues.push('JSON-LD에 datePublished가 없습니다');
  } else {
    // UTC로 적힌 시각이면 한국시간 날짜도 허용 (예: 2026-06-08T23:30Z = 6월 9일 KST)
    const alts = [pub];
    const t = Date.parse(a.datePublished);
    if (!isNaN(t) && /T\d/.test(String(a.datePublished))) {
      const k = new Date(t + 9 * 3600e3);
      alts.push({ y: String(k.getUTCFullYear()), m: String(k.getUTCMonth() + 1), d: String(k.getUTCDate()) });
    }
    const ok = alts.some(dt => dateInText(dt, visible));
    result.checks.push({ field: 'datePublished', ok, ld: String(a.datePublished).slice(0, 25) });
    if (!ok) result.issues.push('LD 발행일 ' + pub.y + '-' + pub.m + '-' + pub.d + '이(가) 화면에 표시된 날짜와 맞지 않습니다');
  }

  // 참고: dateModified (점수 외)
  const mod = ymd(a.dateModified);
  result.dateModified = a.dateModified ? String(a.dateModified).slice(0, 25) : '';
  if (!a.dateModified) result.notes = ['dateModified 없음 — 수정 기사라면 실제 수정 시각을 넣으세요'];
  else if (pub && mod && (+mod.y * 1e4 + +mod.m * 100 + +mod.d) < (+pub.y * 1e4 + +pub.m * 100 + +pub.d)) {
    result.issues.push('dateModified가 datePublished보다 이릅니다');
  }

  result.passed = result.checks.filter(c => c.ok).length;
  return result;
}

// ── 문단 단위 인용 가능성 (v3) ─────────────────────────────────────
// AI는 기사 전체가 아니라 문단 하나를 잘라 인용한다. 떼어 놓아도 뜻이 통해야 한다.
// 지시어로 시작하는 문단 = 앞 문단 없이는 뜻이 안 통함. 접속어(또·아울러·한편·앞서 등)는 주어를 다시
// 쓰는 경우가 많아 그 자체로는 문제 삼지 않고, 접속어를 떼어낸 뒤 지시어가 오면 잡는다
// (예: "아울러 이번 승인은" → 이번). 매체A 기사 실사(2026-09-21)로 조정
const LEAD_CONNECTIVE = /^(또한|또|아울러|한편|특히|다만|이어서|이어|앞서|나아가|게다가|더불어|반면|하지만|그러나)\s*,?\s*/;
const DEPENDENT_OPENER = /^(이는|이에|이를|이와|이로|이로써|이같은|이 같은|이러한|이런|이번|이날|해당|위의|위와|상기|전술한|그는|그녀는|그의|그러면서|이 회사|이 약|이 치료제|이 연구|이 기술|동사|同社|같은 날|이 밖에|이밖에)(?=[\s,은는이가을를의에도])/;
// 기준 시점: 명시 날짜·연도·분기·"기준/현재/당시"
const EXPLICIT_ANCHOR = /20\d{2}\s*(년|\.|-)|\d{1,2}월\s*\d{1,2}일|\d{1,2}월|[1-4]\s*분기|상반기|하반기|기준|현재|당시|말\s*기준|FY\s?\d{2}/;
const RELATIVE_ANCHOR = /올해|지난해|작년|전년|전분기|전년\s*동기|내년|이번\s*분기|지난달|이달|최근/;
// 날짜가 아닌 '양'을 나타내는 수치
// '1회 이상', '주 1회', '6개월 이상 유지' 같은 조건·용법 표현은 통계가 아니므로 제외
const QUANTITY = /\d[\d,.]*\s?(%|퍼센트|%p|배|억|조|만|천|원|달러|유로|위안|엔|명|건|곳|종|mg|㎎|kg|㎏)/;

function stripLeadByline(t) {
  return String(t).replace(/^\s*[\[【(〔]\s*[^\]】)〕]{1,30}(기자|특파원|=)[^\]】)〕]*[\]】)〕]\s*/, '').trim();
}

function splitParagraphs($scope, $r) {
  let paras = [];
  $r.find('p').each((_, el) => {
    const t = $scope(el).text().replace(/\s+/g, ' ').trim();
    if (t.length >= 40) paras.push(t);
  });
  if (paras.length < 2) {
    // <p> 없이 <br><br>로 문단을 나누는 CMS 대응
    const html = $r.html() || '';
    paras = html.split(/<br\s*\/?>\s*(?:&nbsp;|\s)*<br\s*\/?>|<\/p>|<\/div>|\n\s*\n/i)
      .map(h => cheerio.load('<x>' + h + '</x>')('x').text().replace(/\s+/g, ' ').trim())
      .filter(t => t.length >= 40);
  }
  return paras.slice(0, 60);
}

function analyzeParagraphs(paras) {
  const items = paras.map((raw, i) => {
    const t = stripLeadByline(raw);
    const core = t.replace(LEAD_CONNECTIVE, '');
    const dependent = DEPENDENT_OPENER.test(core);
    const hasQty = QUANTITY.test(t);
    const explicit = EXPLICIT_ANCHOR.test(t);
    const relative = !explicit && RELATIVE_ANCHOR.test(t);
    const opener = dependent ? (core.match(DEPENDENT_OPENER) || [''])[0] : '';
    return { i: i + 1, text: t.slice(0, 80), dependent, opener, hasQty, anchored: hasQty ? (explicit ? 1 : relative ? 0.5 : 0) : null, relative };
  });
  const n = items.length;
  const indep = items.filter(x => !x.dependent).length;
  const qty = items.filter(x => x.hasQty);
  const anchorSum = qty.reduce((s, x) => s + x.anchored, 0);
  const indepRatio = n ? indep / n : 0;
  const anchorRatio = qty.length ? anchorSum / qty.length : null;

  let s1 = n === 0 ? 0 : indepRatio >= 0.8 ? 2 : indepRatio >= 0.6 ? 1 : 0;
  let s2 = anchorRatio === null ? (n ? 1 : 0) : anchorRatio >= 0.7 ? 2 : anchorRatio >= 0.4 ? 1 : 0;

  const problems = [];
  items.forEach(x => {
    if (x.dependent) problems.push({ para: x.i, type: 'dependent', message: x.i + '번째 문단이 "' + x.opener + '"(으)로 시작 — 떼어 읽으면 무엇을 가리키는지 모름. 주어(기업·약물명)를 다시 쓰세요', text: x.text });
    if (x.hasQty && x.anchored === 0) problems.push({ para: x.i, type: 'no_anchor', message: x.i + '번째 문단 수치에 기준 시점이 없음 — "2026년 2분기 기준"처럼 날짜를 붙이세요', text: x.text });
    else if (x.hasQty && x.anchored === 0.5) problems.push({ para: x.i, type: 'relative', message: x.i + '번째 문단은 "올해·지난해" 같은 상대 표현만 있음 — 연도를 명시하면 기사 날짜와 떨어져도 정확합니다', text: x.text });
  });

  return {
    count: n, independent: indep, indepRatio: Math.round(indepRatio * 100) / 100,
    qtyParas: qty.length, anchorRatio: anchorRatio === null ? null : Math.round(anchorRatio * 100) / 100,
    score: s1 + s2, problems: problems.slice(0, 12),
  };
}

// ── 원출처(1차 소스) 도메인 (v3) ───────────────────────────────────
// 바이오·경제 기사 기준. 도메인 끝부분 일치로 판정 (sub.domain 포함)
const PRIMARY_SOURCES = [
  // 공시·거래소
  ['dart.fss.or.kr', '전자공시(DART)'], ['kind.krx.co.kr', 'KRX 공시(KIND)'], ['sec.gov', '美 SEC 공시'],
  // 임상시험 등록
  ['clinicaltrials.gov', 'ClinicalTrials.gov'], ['cris.nih.go.kr', '임상연구정보(CRIS)'],
  ['clinicaltrialsregister.eu', 'EU 임상등록'], ['euclinicaltrials.eu', 'EU CTIS'], ['trialsearch.who.int', 'WHO ICTRP'],
  // 논문·학회
  ['doi.org', 'DOI 논문'], ['pubmed.ncbi.nlm.nih.gov', 'PubMed'], ['ncbi.nlm.nih.gov', 'NCBI'],
  ['nejm.org', 'NEJM'], ['thelancet.com', 'Lancet'], ['nature.com', 'Nature'], ['science.org', 'Science'],
  ['jamanetwork.com', 'JAMA'], ['bmj.com', 'BMJ'], ['cell.com', 'Cell'], ['sciencedirect.com', 'ScienceDirect'],
  ['springer.com', 'Springer'], ['wiley.com', 'Wiley'], ['ascopubs.org', 'ASCO'], ['aacrjournals.org', 'AACR'],
  ['biorxiv.org', 'bioRxiv(프리프린트)'], ['medrxiv.org', 'medRxiv(프리프린트)'], ['arxiv.org', 'arXiv(프리프린트)'],
  // 규제기관·공공
  ['fda.gov', '美 FDA'], ['ema.europa.eu', 'EMA'], ['ec.europa.eu', 'EU 집행위'], ['pmda.go.jp', '日 PMDA'],
  ['mhlw.go.jp', '日 후생노동성'], ['nmpa.gov.cn', '中 NMPA'], ['gov.uk', '英 정부(MHRA 등)'], ['who.int', 'WHO'],
  ['cdc.gov', '美 CDC'], ['nih.gov', '美 NIH'], ['mfds.go.kr', '식약처'], ['nedrug.mfds.go.kr', '의약품안전나라'],
  ['mohw.go.kr', '보건복지부'], ['kdca.go.kr', '질병관리청'], ['hira.or.kr', '심평원'], ['nhis.or.kr', '건보공단'],
  ['law.go.kr', '국가법령정보'], ['korea.kr', '정책브리핑'], ['kosis.kr', '통계청 KOSIS'], ['bok.or.kr', '한국은행'],
  // 보도자료 배포처
  ['prnewswire.com', 'PR Newswire'], ['businesswire.com', 'Business Wire'], ['globenewswire.com', 'GlobeNewswire'],
];
// 기사 신뢰와 무관한 링크: 공유 버튼·SNS·광고·앱스토어
const NOISE_LINK = /(^|\.)(facebook|twitter|x|instagram|youtube|kakao|kakaocorp|band|pinterest|linkedin|t|telegram|line|naver|daum|google|doubleclick|googlesyndication|apple|play\.google)\.(com|me|us|co\.kr|net)$|share|sharer|intent\/tweet/i;

function classifyPrimary(host) {
  const hit = PRIMARY_SOURCES.find(([d]) => host === d || host.endsWith('.' + d));
  return hit ? hit[1] : '';
}

// 링크 없이 본문에만 적힌 1차 출처 단서 (링크로 바꾸라고 안내)
function sourceMentions(text) {
  const out = [];
  const nct = text.match(/NCT\d{8}/g); if (nct) out.push({ kind: 'nct', value: [...new Set(nct)].slice(0, 3), hint: 'clinicaltrials.gov/study/' + nct[0] + ' 링크' });
  const doi = text.match(/\b10\.\d{4,9}\/[^\s"'<>]+/g); if (doi) out.push({ kind: 'doi', value: doi.slice(0, 2), hint: 'https://doi.org/' + doi[0] + ' 링크' });
  if (/(FDA|식품의약국)/.test(text)) out.push({ kind: 'fda', hint: 'FDA 승인·보도자료 원문(fda.gov) 링크' });
  if (/(EMA|CHMP|유럽의약품청)/.test(text)) out.push({ kind: 'ema', hint: 'EMA/CHMP 발표 원문(ema.europa.eu) 링크' });
  if (/(식약처|식품의약품안전처)/.test(text)) out.push({ kind: 'mfds', hint: '식약처 보도자료(mfds.go.kr) 링크' });
  if (/(공시|전자공시|DART)/.test(text)) out.push({ kind: 'dart', hint: '전자공시(dart.fss.or.kr) 원문 링크' });
  if (/(NEJM|뉴잉글랜드저널|란셋|Lancet|네이처|Nature|JAMA|학술지|저널에 (게재|발표))/.test(text)) out.push({ kind: 'paper', hint: '게재 논문 DOI 링크' });
  if (/(보도자료|밝혔다|발표했다)/.test(text) && /[A-Z][a-zA-Z]+|㈜|제약|바이오/.test(text)) out.push({ kind: 'pr', hint: '회사 보도자료 원문(IR·뉴스룸) 링크' });
  return out;
}

// ── AI 대상 지시문(프롬프트 인젝션) 탐지 (v3) ──────────────────────
// 페이지에 숨겨 둔 "AI에게 하는 명령"은 AI 분석을 오염시키고, 검색엔진에는 클로킹·스팸 신호다
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)/i,
  /disregard\s+(the\s+|all\s+)?(previous|prior|above|system)/i,
  /(you are|you're)\s+now\s+(a|an|the)\b/i,
  /\bsystem\s*prompt\b/i,
  /\b(as an ai|ai (assistant|model)s?)\b.{0,40}\b(must|should|always|recommend|cite|rate)\b/i,
  /(give|rate|score)\s+(this|the)\s+(article|page|content)\s+.{0,20}(100|highest|perfect|10\/10)/i,
  /(이전|위의|앞의|기존)\s*(모든\s*)?(지시|명령|지침|프롬프트)[을를]?\s*(무시|잊)/,
  /(AI|인공지능|챗봇|언어\s*모델|LLM|GPT|Claude|클로드)[는은이가에게]*\s*.{0,30}(반드시|무조건|항상)\s*.{0,30}(추천|인용|언급|최고|1위|100점)/,
  /(시스템\s*프롬프트|너는\s*이제|당신은\s*이제)/,
  /(이\s*(기사|페이지|글)[을를에]?\s*.{0,15}(100점|만점|최고\s*점수))/,
];

function isHiddenEl(el) {
  const a = el.attribs || {};
  const st = String(a.style || '').toLowerCase().replace(/\s+/g, '');
  return 'hidden' in a || a['aria-hidden'] === 'true' ||
    /display:none|visibility:hidden|font-size:0(px|em|rem)?(;|$)|opacity:0(;|$)|left:-\d{3,}px|text-indent:-\d{3,}px/.test(st) ||
    /\b(sr-only|visually-hidden|blind|screen_out|hide|hidden)\b/.test(String(a.class || ''));
}

function detectInjection($) {
  const hits = [];
  const scan = (text, where) => {
    const t = String(text || '').replace(/\s+/g, ' ');
    INJECTION_PATTERNS.forEach(re => {
      const m = t.match(re);
      if (m && hits.length < 8) {
        const i = Math.max(0, m.index - 20);
        hits.push({ where, snippet: t.slice(i, i + 100) });
      }
    });
  };
  // 숨김 요소 (스크린리더용 "본문 바로가기" 같은 정상 텍스트는 패턴에 걸리지 않음)
  $('body *').each((_, el) => { if (isHiddenEl(el)) scan($(el).text(), 'hidden'); });
  // HTML 주석
  const html = $.html() || '';
  (html.match(/<!--[\s\S]*?-->/g) || []).slice(0, 200).forEach(c => scan(c, 'comment'));
  // meta 태그
  $('meta[content]').each((_, el) => scan(el.attribs.content, 'meta'));
  // 보이는 본문
  const $v = cheerio.load(html); $v('script,style,noscript,template').remove();
  scan($v('body').text(), 'visible');
  // 중복 제거
  const seen = new Set();
  return hits.filter(h => { const k = h.where + h.snippet; if (seen.has(k)) return false; seen.add(k); return true; });
}

function scoreHTML(html, url = '', opts = {}) {
  const $ = cheerio.load(html);
  const indexability = detectIndexability($, opts || {});
  const injectionSignals = detectInjection($);

  // ── 메타 추출 ───────────────────────────────────────────────────
  const title = $('title').first().text().trim();
  const metaDesc =
    $('meta[name="description"]').attr('content') ||
    $('meta[name="Description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') || '';

  const h1s = $('h1');
  const canonical = $('link[rel="canonical"]');

  const ld = parseAllLdJson($);
  const hasArticleSchema = !!ld.articleBlock;
  const hasAnyLd = ld.blocks.length > 0;

  const $vis = cheerio.load($.html());
  $vis('script, style, noscript, template').remove();
  const visibleText = $vis('body').text().replace(/\s+/g, ' ');
  const ldCheck = checkLdConsistency($, ld, visibleText);

  const ldAuthor = (() => {
    const a = ld.articleBlock && ld.articleBlock.author;
    if (!a) return '';
    if (typeof a === 'string') return a;
    if (Array.isArray(a)) return a.map(x => x && x.name).filter(Boolean).join(', ');
    return a.name || '';
  })();
  const authorEl =
    ldAuthor ||
    $('meta[name="author"]').attr('content') ||
    $('[itemprop="author"]').first().text().trim() ||
    $('[class*="author"], [class*="byline"], [class*="journalist"]').first().text().trim().slice(0, 60) || '';
  const dateEl =
    $('meta[property="article:published_time"]').attr('content') ||
    (ld.articleBlock && ld.articleBlock.datePublished) ||
    $('time[datetime]').first().attr('datetime') || '';

  // ── 본문 추출 (v2: 셀렉터 체인 → 폴백) ──────────────────────────
  let $body = null, extraction = 'fallback';
  for (const sel of ARTICLE_SELECTORS) {
    const cand = $(sel).first();
    if (cand.length && cand.text().replace(/\s+/g, '').length >= 200) {
      $body = cand; extraction = sel; break;
    }
  }

  const scopeHtml = $body ? ($.html($body) || '') : ($.html($('body').length ? $('body') : $.root()) || '');
  const $scope = cheerio.load('<div id="__r">' + scopeHtml + '</div>');
  $scope('script, style, nav, header, footer, aside, [class*="comment"], [class*="related"], [class*="recommend"], [class*="copyright"]').remove();
  const $r = $scope('#__r');

  const bodyText = $r.text().replace(/\s+/g, ' ').trim();
  const bodyLen = bodyText.replace(/\s+/g, '').length;

  const firstP = $r.find('p').filter((_, el) => $scope(el).text().trim().length >= 40).first().text().trim();
  const firstPara = (firstP || bodyText).slice(0, 300);
  const paraInfo = analyzeParagraphs(splitParagraphs($scope, $r));

  const h2c = $r.find('h2, h3').length || $('h2').length;
  const h2Texts = [];
  ($r.find('h2, h3').length ? $r.find('h2, h3') : $('h2, h3')).each((_, el) => {
    h2Texts.push($scope(el).length ? $scope(el).text().trim() : $(el).text().trim());
  });
  const listCount = $r.find('ul li, ol li').length;
  const tableCount = $r.find('table').length;
  const imgs = $r.find('img').length ? $r.find('img') : $('img');

  // ── 링크 분류 (v2: hostname 비교) ───────────────────────────────
  const pageDomain = hostnameOf(url);
  let internalCount = 0, externalCount = 0, noiseCount = 0;
  const primaryLinks = [];
  // 기사 본문을 찾았으면 외부·원출처 링크는 본문 안에서만 센다 (메뉴·푸터·배너 링크 제외).
  // 내부 링크는 기존 방식 유지(이력 호환): 본문에 링크가 없으면 페이지 전체
  const bodyFound = extraction !== 'fallback';
  const $links = $r.find('a[href]').length ? $r.find('a[href]') : $('a[href]');
  const fromBody = $r.find('a[href]').length > 0;
  $links.each((_, el) => {
    const href = (el.attribs && el.attribs.href) || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    if (href.startsWith('/')) { internalCount++; return; }
    if (!/^https?:/.test(href)) return;
    const h = hostnameOf(href);
    if (!h) return;
    if (pageDomain && (h === pageDomain || h.endsWith('.' + pageDomain) || pageDomain.endsWith('.' + h))) { internalCount++; return; }
    if (bodyFound && !fromBody) return;   // 본문에 링크 0개 → 페이지 주변부 외부 링크는 출처로 인정 안 함
    if (NOISE_LINK.test(h) || NOISE_LINK.test(href)) { noiseCount++; return; }
    externalCount++;
    const kind = classifyPrimary(h);
    if (kind) primaryLinks.push({ host: h, kind, text: ($(el).text() || '').trim().slice(0, 40) });
  });
  const primaryKinds = [...new Set(primaryLinks.map(x => x.kind))];
  const mentions = sourceMentions(bodyText);

  // ── 팩트 밀도 ───────────────────────────────────────────────────
  const numAll = (bodyText.match(/\b\d[\d,.]*\b/g) || []).length;
  const factNums = Math.max(
    (bodyText.match(/\d+\.?\d*\s?[%억만천백원달러위안건명개사㎎㎏mg]/g) || []).length,
    Math.floor(numAll * 0.35)
  );
  const dateMatches = (bodyText.match(/20\d{2}년|20\d{2}\.\s?\d{1,2}|20\d{2}-\d{2}|\d{1,2}월\s*\d{1,2}일/g) || []).length;
  const firstHasNum = /\d/.test(firstPara.slice(0, 150));
  const firstHasName =
    /[가-힣]{2,}(㈜|주식회사|코스피|코스닥|FDA|EMA|임상)/.test(firstPara.slice(0, 150)) ||
    /[A-Z][a-zA-Z]{2,}/.test(firstPara.slice(0, 150)) ||
    firstPara.length >= 100;

  // ── 이미지 alt ──────────────────────────────────────────────────
  let imgTotal = 0, imgsWithAlt = 0;
  imgs.each((_, el) => {
    imgTotal++;
    if (el.attribs && el.attribs.alt && el.attribs.alt.trim()) imgsWithAlt++;
  });
  const imgAltRatio = imgTotal > 0 ? imgsWithAlt / imgTotal : 1;

  // ── 질문형 헤딩 / FAQ ───────────────────────────────────────────
  const questionHeadings = h2Texts.filter(t => /\?|는가|일까|할까|무엇|어떻게|왜\s/.test(t)).length;
  const hasFaqSchema = !!ld.faqBlock;

  // ── 채점 ────────────────────────────────────────────────────────
  const scores = {};
  const tl = title.length, ml = metaDesc.length;
  const h1c = h1s.length;

  scores.title_exists   = tl > 0 ? 5 : 0;
  scores.title_length   = (tl >= 45 && tl <= 65) ? 5 : (tl >= 30 && tl <= 80) ? 3 : tl > 0 ? 1 : 0;
  scores.meta_exists    = ml > 0 ? 5 : 0;
  scores.meta_length    = (ml >= 120 && ml <= 160) ? 3 : (ml >= 80 && ml <= 200) ? 2 : ml > 0 ? 1 : 0;
  scores.h1_count       = h1c === 1 ? 5 : h1c === 0 ? 0 : 2;
  scores.h2_count       = h2c >= 2 ? 5 : h2c === 1 ? 3 : 0;
  scores.img_alt        = imgTotal === 0 ? 3 : imgAltRatio >= 0.8 ? 5 : imgAltRatio >= 0.5 ? 3 : 1;
  scores.internal_links = internalCount >= 5 ? 5 : internalCount >= 3 ? 4 : internalCount >= 1 ? 2 : 0;
  // 원출처 2종 이상 4 · 1종 3 · 일반 외부 링크만 2 · 링크 없이 출처 단서(NCT·DOI)만 1 · 없음 0
  scores.external_links = primaryKinds.length >= 2 ? 4 : primaryKinds.length === 1 ? 3
    : externalCount >= 1 ? 2 : mentions.some(m => m.kind === 'nct' || m.kind === 'doi') ? 1 : 0;
  scores.content_length = bodyLen >= 800 ? 4 : bodyLen >= 400 ? 2 : bodyLen >= 200 ? 1 : 0;
  scores.canonical      = canonical.length > 0 ? 4 : 0;

  scores.fact_numbers   = factNums >= 8 ? 8 : factNums >= 5 ? 6 : factNums >= 3 ? 4 : factNums >= 1 ? 2 : 0;
  scores.fact_dates     = dateMatches >= 3 ? 5 : dateMatches >= 2 ? 4 : dateMatches >= 1 ? 2 : 0;
  let fp = 0;
  if (firstHasNum)  fp += 3;
  if (firstHasName) fp += 2;
  if (firstPara.length >= 100) fp += 1;
  scores.first_para     = Math.min(fp, 6);
  scores.para_citability = paraInfo.score;
  scores.ld_json        = hasAnyLd ? 4 : 0;
  scores.article_schema = hasArticleSchema ? 6 : hasAnyLd ? 2 : 0;
  // 3개 필드 중 일치 개수 = 점수. 발행일 역전 같은 명백한 오류가 있으면 1점 감점
  scores.ld_consistency = !ldCheck.checked ? 0
    : Math.max(0, ldCheck.passed - (ldCheck.issues.some(x => /dateModified/.test(x)) ? 1 : 0));
  scores.structure_lists = (listCount >= 3 || tableCount >= 1) ? 4 : listCount >= 1 ? 2 : 0;
  scores.question_headings = hasFaqSchema ? 3 : questionHeadings >= 1 ? 2 : 0;
  scores.author         = authorEl.length > 0 ? 4 : 0;
  scores.pub_date       = String(dateEl).length > 0 ? 3 : 0;

  // ── 세부 설명 ───────────────────────────────────────────────────
  const details = {
    title_exists:   tl > 0 ? '"' + title.slice(0, 50) + (tl > 50 ? '...' : '') + '" (' + tl + '자)' : '제목 태그 없음',
    title_length:   tl > 0 ? tl + '자 (최적: 45-65자)' : '제목 없음',
    meta_exists:    ml > 0 ? ml + '자' : '메타 없음',
    meta_length:    ml > 0 ? ml + '자 (최적: 120-160자)' : '메타 없음',
    h1_count:       'H1 ' + h1c + '개',
    h2_count:       '본문 헤딩(H2/H3) ' + h2c + '개',
    img_alt:        imgTotal > 0 ? '이미지 ' + imgTotal + '개 중 ' + imgsWithAlt + '개 alt' : '이미지 없음',
    internal_links: '내부 링크 ' + internalCount + '개',
    external_links: primaryKinds.length ? '원출처 ' + primaryKinds.join(', ') + ' (외부 링크 ' + externalCount + '개)'
      : externalCount ? '외부 링크 ' + externalCount + '개 — 원출처(공시·임상등록·논문·규제기관) 아님'
      : (bodyFound && !fromBody ? '기사 본문에 링크 0개' : '외부 링크 없음') + (mentions.length ? ' — 본문에 출처 단서 있음: ' + mentions.slice(0, 2).map(m => m.hint).join(', ') : ''),
    content_length: '본문 ' + bodyLen.toLocaleString() + '자 (추출: ' + extraction + ')',
    canonical:      canonical.length > 0 ? 'canonical 있음' : 'canonical 없음',
    fact_numbers:   '수치 약 ' + factNums + '개',
    fact_dates:     '날짜·연도 ' + dateMatches + '회',
    first_para:     '첫 문단 ' + firstPara.length + '자 / 숫자:' + (firstHasNum ? '✓' : '✗') + ' 고유명사:' + (firstHasName ? '✓' : '✗'),
    para_citability: paraInfo.count === 0 ? '문단을 찾지 못함'
      : '문단 ' + paraInfo.count + '개 중 독립 ' + paraInfo.independent + '개'
        + (paraInfo.qtyParas ? ' · 수치 문단 ' + paraInfo.qtyParas + '개 기준시점 ' + Math.round(paraInfo.anchorRatio * 100) + '%' : ' · 수치 문단 없음'),
    ld_json:        hasAnyLd ? 'JSON-LD ' + ld.blocks.length + '개 블록' : 'JSON-LD 없음',
    article_schema: hasArticleSchema ? JSON.stringify(ld.articleBlock['@type']) + ' 확인' : hasAnyLd ? 'Article 계열 스키마 없음' : '없음',
    ld_consistency: !ldCheck.checked ? 'Article 스키마 없음 — 검사 불가'
      : ldCheck.issues.length ? '불일치: ' + ldCheck.issues.join(' / ')
      : 'headline·저자·발행일 모두 화면과 일치' + (ldCheck.dateModified ? '' : ' (dateModified 없음)'),
    structure_lists: '목록 항목 ' + listCount + '개 · 표 ' + tableCount + '개',
    question_headings: hasFaqSchema ? 'FAQPage 스키마 있음' : questionHeadings >= 1 ? '질문형 헤딩 ' + questionHeadings + '개' : '질문형 헤딩·FAQ 없음',
    author:         authorEl ? '저자: ' + authorEl.slice(0, 40) : '저자 정보 없음',
    pub_date:       dateEl ? '날짜: ' + String(dateEl).slice(0, 30) : '날짜 태그 없음',
  };

  // ── 합산 ────────────────────────────────────────────────────────
  let seoTotal = 0, geoTotal = 0;
  CRITERIA.forEach(c => {
    if (c.group === 'seo') seoTotal += scores[c.id] || 0;
    else geoTotal += scores[c.id] || 0;
  });
  const total = seoTotal + geoTotal;
  const grade = total >= 90 ? 'A' : total >= 75 ? 'B' : total >= 60 ? 'C' : total >= 40 ? 'D' : 'F';

  return {
    engineVersion: ENGINE_VERSION,
    scores,
    details,
    totals: { total, seoTotal, geoTotal, seoMax: SEO_MAX, geoMax: GEO_MAX },
    grade,
    indexability,
    ldConsistency: ldCheck,
    paragraphs: paraInfo,
    injectionSignals,
    meta: {
      title, metaDesc, h1c, h2c, bodyLen, firstPara,
      bodyText: bodyText.slice(0, 6000),
      extraction,
      ldText: ld.articleBlock ? JSON.stringify(ld.articleBlock).slice(0, 8000) : '',
      h1Text: $('h1').first().text().replace(/\s+/g, ' ').trim().slice(0, 200),
      factNums, dateMatches, authorEl, dateEl,
      internalLinks: internalCount, externalLinks: externalCount, noiseLinks: noiseCount,
      primaryLinks: primaryLinks.slice(0, 10), sourceMentions: mentions,
      listCount, tableCount, questionHeadings, hasFaqSchema,
    },
    criteria: CRITERIA,
    analyzedAt: new Date().toISOString(),
    url,
  };
}

module.exports = { scoreHTML, detectIndexability, CRITERIA, ENGINE_VERSION };
