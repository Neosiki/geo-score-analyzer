# GEO Analyzer 고도화 설계서 (v2 → v3)

작성일: 2026-06-10 · 대상: geo-analyzer-server v2 (Express + cheerio, 18항목 룰 채점)

---

## 1. 현재 상태 진단

### 구조
```
server.js          Express 라우팅 (analyze/batch/compare/report/health)
lib/scorer.js      18항목 100점 룰 채점 엔진 (cheerio)
lib/reports.js     PDF(pdfkit) · Excel(SheetJS) 리포트
public/index.html  SPA (940줄, 탭 5개 + 동적 결과 탭 3개)
```

### 발견된 결함 (Phase 1에서 수정)
| # | 위치 | 문제 |
|---|------|------|
| B1 | scorer.js `title_length` | `(tl >= 30 \|\| tl <= 80)` — 항상 참. 어떤 길이든 3점 보장되는 버그 (`&&` 의도) |
| B2 | scorer.js `meta_length` | 동일 패턴 버그 `(ml >= 80 \|\| ml <= 200)` |
| B3 | scorer.js JSON-LD | 첫 번째 `<script type="application/ld+json">`만 검사. 언론사 페이지는 보통 다수(Organization, BreadcrumbList, NewsArticle...) → Article 스키마 오탐지 |
| B4 | scorer.js 본문 추출 | nav/header/footer 제거 후 **문서 전체 텍스트** 사용 → 추천기사·댓글·광고 문구 혼입. `firstPara = slice(0,200)`이 실제 리드문이 아닌 경우 다수 |
| B5 | scorer.js 링크 분류 | `href.includes(domain)` 문자열 매칭 → `evil.com/?ref=joongang.co.kr` 오분류 |

### 구조적 한계
- 정량 룰만 존재 → "AI가 실제로 인용할 만한가"라는 정성 판단 불가
- 점수와 실제 AI 노출(SoV) 간 상관 검증 수단 없음
- 이력이 브라우저 localStorage에만 존재(30개 제한, 기기 종속) → 시계열 분석 불가

---

## 2. 고도화 로드맵 (4 Phase)

```
Phase 1  채점 엔진 v2 정교화        [이번 세션 구현] 외부 의존성 없음
Phase 2  Claude AI 정성 분석        [이번 세션 구현] ANTHROPIC_API_KEY 필요
Phase 3  운영 인프라 (DB·시계열)     [구현 완료] node:sqlite 내장 (의존성 0)
Phase 4  실측 SoV 추적              [구현 완료] Perplexity 키 입력 시 활성 (모크 모드 내장)
```

Phase 4(실측 SoV)는 우선순위가 높지만 측정 결과를 **저장·누적**할 DB가 전제이므로 Phase 3 뒤에 배치.

---

## 3. Phase 1 — 채점 엔진 v2 정교화 ✅

**파일: `lib/scorer.js` 전면 개정 (외부 패키지 추가 없음)**

1. **버그 수정**: B1, B2 (`&&` 보정), B5 (URL 객체 hostname 비교)
2. **본문 추출 개선**: 한국 언론사 우선순위 셀렉터 체인으로 기사 컨테이너 탐지
   `article → [itemprop=articleBody] → #articleBody/#article-view-content-div → .article_body/.news_body/.article-body → og:description 보조` → 실패 시 기존 방식 폴백. 추출 방식을 `meta.extraction`으로 노출해 신뢰도 표시
3. **JSON-LD 전수 검사**: 모든 ld+json 파싱, `@graph` 배열 지원, NewsArticle 우선 탐지
4. **GEO 항목 보강** (GEO 50점 내 재배분, 총점 100 유지):

| 항목 | 변경 |
|------|------|
| fact_numbers | 10 → 8 |
| fact_dates | 8 → 5 |
| ld_json | 7 → 5 |
| **structure_lists** (신규) | 4 — 목록(ul/ol)·표 등 AI 발췌 친화 구조 |
| **question_headings** (신규) | 3 — 질문형 헤딩/FAQ 스키마 (AI 검색 질의 매칭) |

5. **호환성**: 프런트·리포트는 `CRITERIA` 배열 기반 렌더링이라 자동 반영. 응답에 `engineVersion: 2` 추가

## 4. Phase 2 — Claude AI 정성 분석 ✅

**신규 파일 `lib/ai.js` + server.js 라우트 2개 + index.html UI**

| 엔드포인트 | 기능 |
|-----------|------|
| `POST /api/ai/analyze` | 룰 채점 결과 + 본문을 Claude에 전달 → **AI 인용가능성 평가** JSON 반환 |
| `POST /api/ai/rewrite` | 본문 → GEO 최적화 리라이팅 (제목·메타·리드문·본문·JSON-LD). 기존 룰 기반 재작성 패널의 AI 업그레이드 |

**AI 평가 스키마** (5축 정성 평가, 룰 점수와 별도):
```json
{
  "citability": 0-100,
  "axes": { "사실밀도":n, "답변완결성":n, "구조명료성":n, "신뢰신호":n, "고유정보가치":n },
  "strengths": [...], "weaknesses": [...],
  "suggestions": [{ "priority": "high|mid|low", "action": "..." }],
  "predictedQueries": ["이 기사가 인용될 만한 AI 검색 질문들"]
}
```

**운영 방식**
- API 키: `ANTHROPIC_API_KEY` 환경변수 또는 UI(도구 탭)에서 입력 → localStorage 저장, 요청 헤더 `x-anthropic-key`로 전송. 서버에 키 저장 안 함
- 모델: 기본 `claude-fable-5`, `CLAUDE_MODEL` 환경변수로 교체 가능
- SDK 미사용, Node 18+ 내장 fetch로 직접 호출 (의존성 0 추가)
- 키 없으면 룰 채점은 정상 동작, AI 카드만 안내 메시지 (graceful degradation)

**UI**: 결과 탭에 "🤖 AI 정성 분석" 카드 추가 (버튼 클릭 시 호출 — 토큰 비용 고려해 자동 실행 안 함)

## 5. Phase 3 — 운영 인프라 (DB·시계열) ✅

**신규 `lib/db.js` + server.js 라우트 + 이력 탭 개편**

저장소 (설계 변경: better-sqlite3 → 의존성 0 구성):
- 1순위 **node:sqlite** (Node 22.13+ 내장) → `data/geo.db`
- 미지원 환경은 **JSON 파일 폴백** (`data/geo-history.json`) — 동일 인터페이스, 자동 전환
- 경로는 `GEO_DATA_DIR` 환경변수로 변경 가능
- 테이블: `analyses`(전체 스냅샷 JSON 포함), `ai_reviews`, `tracked_urls`, `sov_checks`(Phase 4 예약)

| 엔드포인트 | 기능 |
|-----------|------|
| `GET /api/history` `?limit&q` | 이력 목록 (단일·배치·비교·재분석 모두 자동 저장) |
| `GET /api/history/urls` | 분석된 URL 목록 (횟수 포함) |
| `GET /api/history/:id` | 전체 결과 스냅샷 (클릭 → 결과 재표시) |
| `DELETE /api/history(/:id)` | 개별·전체 삭제 |
| `GET /api/timeseries?url=` | URL별 총점/SEO/GEO 추이 |
| `GET/POST/DELETE /api/track` | 추적 URL 등록·해제 |
| `POST /api/track/run` | 추적 URL 전체 즉시 재분석 |

- 주기 재분석: 의존성 없는 내장 스케줄러 — 매일 `GEO_RECRAWL_HOUR`시(기본 6시) 추적 URL 자동 재분석, `off`로 비활성화 (node-cron 불필요로 설계 변경)
- UI: 이력 탭 서버 전환(서버 불가 시 localStorage 폴백 표시), **📈 URL별 점수 추이 차트**(총점/SEO/GEO 라인), **🔁 추적 URL 관리** 카드
- AI 정성 분석 결과도 `ai_reviews`에 누적 → Phase 4에서 점수-인용 상관 분석에 활용

## 6. Phase 4 — 실측 SoV 추적 ✅

**신규 `lib/sov.js` + 라우트 7개 + "📡 SoV 실측" 탭**

흐름: 키워드 등록 → Perplexity API(sonar, 인용 URL 반환) 질의 → 인용 출처 hostname을 자사/경쟁사 도메인과 매칭 → `sov_checks`에 누적 → SoV(%)·추이·상관 산출

| 엔드포인트 | 기능 |
|-----------|------|
| `GET/PUT /api/sov/config` | 자사·경쟁사 도메인, 엔진 설정 (URL 입력해도 도메인 자동 정규화) |
| `GET/POST/DELETE /api/sov/keywords` | 측정 키워드 관리 |
| `POST /api/sov/run` | 전체 키워드 즉시 측정 (키: 헤더 `x-perplexity-key` 또는 `PERPLEXITY_API_KEY`) |
| `GET /api/sov/summary` | 현재 자사/경쟁사 SoV, 일자별 추이, 키워드별 최신 결과, 점수-인용 상관 |
| `GET /api/sov/checks` | 원본 측정 기록 |

- **키 미발급 대응**: 키가 없으면 안내 메시지로 안전 동작. `GEO_SOV_MOCK=1`로 가짜 인용을 생성하는 **모크 모드** 내장 — 키 발급 전 전체 플로우 체험 가능. 키는 UI(SoV 탭)에서 입력(localStorage)하거나 환경변수로 설정
- **주기 측정**: 추적 재분석과 동일한 내장 스케줄러 — 매일 `GEO_SOV_HOUR`시(기본 6시) 자동 측정 (서버 환경변수 키 필요)
- **점수-인용 상관**: 인용된 자사 URL과 분석 이력(`analyses`)을 매칭해 인용/미인용 평균 GEO 점수 비교 → 채점 가중치 보정 근거
- 제약: ChatGPT/Gemini는 공식 인용 API 없음 → Perplexity 우선. `lib/sov.js`의 `queryPerplexity`만 교체하면 타 엔진 확장 가능

## 7. 산출물 현황

- Phase 1: `lib/scorer.js` v2 (버그 수정 + 본문추출 + 신규 2항목) + `test/smoke.js`
- Phase 2: `lib/ai.js` 신규, AI 라우트 2개, AI 분석 카드 + API 키 설정 UI
- Phase 3: `lib/db.js` 신규(node:sqlite/JSON 이중 드라이버), 이력·추이·추적 라우트 8개, 이력 탭 개편
- Phase 4: `lib/sov.js` 신규, SoV 라우트 7개, "📡 SoV 실측" 탭 (설정·키워드·측정·추이·상관)
- **로드맵 4단계 전체 구현 완료** — 남은 작업: Perplexity API 키 발급 후 SoV 탭에 입력
