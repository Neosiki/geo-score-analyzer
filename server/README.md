# GEO Score Analyzer 서버 (v3.1 · 채점 엔진 v3)

기사 URL을 SEO·GEO 100점으로 채점하고, 매체 사이트 전체의 AI 인용 준비 상태를 점검하며, 고친 뒤 실제로 인용·유입이 움직였는지 추적하는 Node.js 서버입니다.

```bash
npm install
npm test          # 오프라인 테스트 4종 (API 키·네트워크 불필요)
npm start         # http://localhost:3000
```

Node 18 이상. Node 22.13 이상이면 이력이 `data/geo.db`(내장 SQLite)에, 그 아래 버전이면 `data/geo-history.json`에 저장됩니다.

## 화면(탭)

| 탭 | 기능 |
|---|---|
| 🔍 단일 분석 | URL 또는 HTML 붙여넣기 → 22개 항목 100점 채점, 색인·인용 차단 경고, 재구성(제목·메타·첫 문단·본문·JSON-LD) |
| 📋 배치 분석 · 🆚 경쟁사 비교 | URL 20개 일괄, 두 기사 항목별 비교 |
| 🌐 사이트 점검 | robots.txt의 AI 크롤러 정책(학습 / AI 검색 색인 / 실시간 열람 / 검색엔진), 사이트맵·뉴스 사이트맵, llms.txt, soft 404, 서버 렌더링, 매체·기자 엔티티, 네이버·빙 설정 |
| 🧪 측정 루프 | 개선 실험(기준선 → 수정 → 14일 뒤 재측정 보고서), 수동 인용 기록(ChatGPT·구글 AI 개요·네이버 AI 브리핑 등), LLMO 분기 점검, AI 크롤러 방문 집계, 대시보드용 내보내기 |
| 📜 분석 이력 · 📡 SoV 실측 | 점수 추이·추적 URL 자동 재분석, Perplexity API 인용 측정 |
| 🛠 도구 | Claude API 키(AI 정성 분석·리라이팅), 북마클릿 |

## 채점 엔진 v3 (SEO 50 + GEO 50)

v2 대비 추가·변경:

- **색인·인용 게이트** — `meta robots`·봇별 meta·`X-Robots-Tag` 헤더의 noindex/none/nosnippet/max-snippet:0, HTTP 4xx. 점수와 별개로 "인용 불가/제한" 판정
- **JSON-LD·화면 일치**(3점) — headline·author·datePublished가 화면 제목·바이라인·표시 날짜와 같은지
- **문단 독립성·수치 기준 시점**(4점) — 지시어("이번·해당·이는")로 시작하는 문단, 기준 시점 없는 통계
- **원출처(1차 소스) 링크**(4점) — 공시·임상등록·논문·규제기관·보도자료 배포처 약 50곳. SNS·공유 버튼 제외
- **AI 대상 지시문 탐지** — 숨김 요소·주석·메타의 프롬프트 인젝션 경고
- 배점 조정: JSON-LD 5→4, Article 스키마 8→6, 첫 문단 10→6 → v2 이력과 점수를 직접 비교하지 마세요

AI 정성 분석·리라이팅은 페이지 텍스트를 무작위 경계 태그로 격리해 전달하고, 리라이팅 결과에 원문에 없는 숫자가 있으면 표시합니다.

## 주요 API

```
POST /api/analyze              { url } | { html }
POST /api/batch · /api/compare
POST /api/site                 { url }            사이트 점검
POST /api/exp                  { url, name, keywords }   실험 기준선
POST /api/exp/:id/changed      { note }           수정 완료 → 재측정 예약
POST /api/exp/:id/remeasure                       재측정 + 보고서
POST /api/citations/manual     { keyword, engine, cited, ... }
POST /api/llmo                 { engine, question, verdict }
POST /api/crawlers/import      (text/plain 접속 로그, 50MB까지)
GET  /api/measure/export       geo-dashboard 연동용 묶음 JSON
POST /api/ai/analyze · /api/ai/rewrite   (Claude API 키 필요)
```

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | 3000 | |
| `ANTHROPIC_API_KEY` · `CLAUDE_MODEL` | — | AI 정성 분석·리라이팅 (화면에서 키 입력도 가능) |
| `PERPLEXITY_API_KEY` · `GEO_SOV_MOCK=1` | — | SoV 자동 측정 / 키 없이 체험 |
| `GEO_RECRAWL_HOUR` | 6 | 추적 URL·예약 실험 자동 재측정 시각, `off`로 끔 |
| `GEO_REMEASURE_DAYS` · `GEO_STALE_DAYS` | 14 · 14 | 재측정 간격 · 낡은 데이터 기준 |
| `GEO_DATA_DIR` | `./data` | 저장 위치 |

## geo-dashboard 연동

[geo-dashboard](https://github.com/Neosiki/geo-dashboard)의 "가시성 지표" 화면에서 이 서버 주소를 넣거나, 측정 루프 탭의 **대시보드용 내보내기** JSON을 올리면 AI 크롤러 방문 → AI 인용 → GA4 유입을 엔진별로 이어 봅니다. 공개 웹에서 `localhost`를 부를 수 있도록 서버가 `Access-Control-Allow-Private-Network` 사전확인에 응답합니다.

## 참고

사이트 점검의 AI 크롤러 용도 분류와 측정 루프 절차는 [leopard627/fire-your-seo-agency](https://github.com/leopard627/fire-your-seo-agency)(MIT)의 진단·측정 레퍼런스를 채점기 구조로 옮긴 것입니다. 변경 이력은 [`docs/고도화설계서.md`](../docs/고도화설계서.md).
