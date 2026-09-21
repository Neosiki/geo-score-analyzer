# GEO Analyzer v3 — 사용 매뉴얼

기사·콘텐츠가 AI 검색엔진(Perplexity, ChatGPT 검색, Claude 등)에 얼마나 잘 인용될지 **점수화(GEO Score)** 하고, **AI 정성 평가·리라이팅**, **점수 추이 추적**, **실제 인용률(SoV) 실측**까지 한 번에 수행하는 도구입니다.

---

## 1. 설치 및 실행

### 요구 사항
- Node.js **18 이상** (권장: **22.13 이상** — 내장 SQLite로 이력이 저장됩니다. 그 미만은 JSON 파일로 자동 대체되므로 기능 차이는 없습니다)

### 실행
```bash
npm install        # 최초 1회
npm start          # http://localhost:3000 접속
```

포트 변경: `PORT=8080 npm start`

### 정상 기동 확인
시작 로그에 현재 상태가 표시됩니다.
```
✅ GEO Analyzer v3 (engine v2) — http://localhost:3000
   AI 정성 분석: API 키 미설정 — UI 도구 탭 또는 ANTHROPIC_API_KEY
   이력 저장소: SQLite (data/geo.db)
   실측 SoV: Perplexity 키 미설정 — UI SoV 탭 또는 PERPLEXITY_API_KEY
```

> API 키가 하나도 없어도 **채점·배치·비교·이력·추이·리포트는 모두 동작**합니다. 키는 AI 정성 분석(Claude)과 SoV 실측(Perplexity)에만 필요합니다.

---

## 2. 화면 구성 (탭)

| 탭 | 용도 |
|----|------|
| 🔍 단일 분석 | URL 또는 HTML 붙여넣기로 1건 채점 |
| 📋 배치 분석 | URL 최대 20개 일괄 채점 + Excel 다운로드 |
| 🆚 경쟁사 비교 | 두 URL 항목별 점수 비교 |
| 📜 분석 이력 | 서버 DB 이력 + URL별 점수 추이 차트 + 추적 URL 관리 |
| 📡 SoV 실측 | 키워드별 실제 AI 인용 여부 측정·추이·경쟁사 비교 |
| 🛠 도구 | Claude API 키 설정, 북마클릿, SoV 대시보드 링크 |

---

## 3. 기본 워크플로우

### ① 기사 채점 (단일 분석)
1. **단일 분석** 탭에 기사 URL 입력 → 분석 시작
2. 결과 화면: 총점(100점) = SEO 50 + GEO 50, 등급(A~F), 항목별 상세 20개
3. `본문 길이` 항목의 "추출: article" 표시는 본문 인식 방식입니다. `fallback`이면 페이지 구조상 본문 인식이 불완전할 수 있으니 HTML 직접 붙여넣기를 권합니다
4. PDF / Excel 버튼으로 리포트 다운로드

**채점 기준 (20항목 100점)**
- SEO 50점: 제목·메타 길이, H1/H2, 이미지 alt, 내부·외부 링크, 본문 길이, canonical
- GEO 50점: 수치·날짜 밀도, **첫 문단 완결성**(AI가 첫 문단만 발췌해도 답이 되는가), JSON-LD/NewsArticle 스키마, **목록·표 구조**, **질문형 헤딩·FAQ**, 저자·발행일(E-E-A-T)

### ② AI 정성 분석 (Claude) — 선택
1. **도구** 탭에서 Anthropic API 키 저장 (브라우저에만 저장됨)
2. 분석 결과 화면의 **🤖 AI 평가 실행** 클릭
3. 결과: AI 인용가능성 점수(0-100), 5축 평가(사실밀도·답변완결성·구조명료성·신뢰신호·고유정보가치), 강점·약점, 우선순위별 개선 제안, **이 기사가 인용될 만한 AI 검색 질문**
4. **✨ AI 리라이팅** 클릭 → 제목·메타·리드문·본문·JSON-LD를 Claude가 재작성해 재작성 패널에 채워줍니다. 수정 후 복사해 CMS에 반영하세요

> 룰 점수는 "형식"을, AI 평가는 "내용"을 봅니다. 둘 다 높아야 실제 인용 확률이 높습니다.

### ③ 개선 → 재분석 → 추이 확인
1. 리라이팅 반영 후 같은 URL을 다시 분석
2. **분석 이력** 탭 → **📈 URL별 점수 추이**에서 URL 선택 → 개선 전후 점수 변화 확인
3. 계속 관찰할 기사는 **🔁 추적 URL**에 등록 → 서버가 켜져 있으면 매일 6시 자동 재분석되어 추이가 쌓입니다 ("지금 전체 재분석"으로 즉시 실행도 가능)

### ④ 실측 SoV (Perplexity) — 선택
1. **SoV 실측** 탭에서 설정:
   - **자사 도메인**: 예) `mynews.co.kr` (URL을 넣어도 도메인만 자동 추출)
   - **경쟁사 도메인**: 선택 입력
   - **Perplexity API 키**: https://www.perplexity.ai/settings/api 에서 발급 (브라우저에만 저장)
2. **측정 키워드** 등록 — 독자가 AI에 물어볼 법한 질문형이 효과적입니다. ②의 "인용 예상 질문"을 그대로 쓰면 좋습니다
3. **▶ 지금 측정** → 키워드마다 Perplexity에 질의해 인용 출처를 수집, 자사/경쟁사 도메인 매칭
4. **SoV 현황**: 자사/경쟁사 SoV(%), 일자별 추이 차트, 키워드별 인용 여부·인용 순위·인용된 자사 URL
5. **점수-인용 상관**: 자사 기사들을 채점해 두면, 인용된 기사 vs 미인용 기사의 평균 GEO 점수가 비교됩니다 → 점수가 실제 인용을 예측하는지 검증

> **키 발급 전 체험**: `GEO_SOV_MOCK=1 npm start` 로 실행하면 가짜 인용 데이터로 전체 흐름을 미리 볼 수 있습니다 (결과에 "mock" 표시).

---

## 4. API 키 정리

| 키 | 용도 | 입력 위치 | 없을 때 |
|----|------|----------|---------|
| Anthropic (`sk-ant-...`) | AI 정성 분석·리라이팅 | 도구 탭 또는 환경변수 `ANTHROPIC_API_KEY` | 해당 버튼만 안내 표시 |
| Perplexity (`pplx-...`) | SoV 실측 | SoV 탭 또는 환경변수 `PERPLEXITY_API_KEY` | 측정 시 안내 표시 |

- UI에 입력한 키는 **브라우저(localStorage)에만 저장**되고 요청 시에만 서버를 경유합니다. 서버에 저장되지 않습니다
- **매일 자동 SoV 측정·자동 재분석**은 서버가 스스로 실행하므로 환경변수 방식이 필요합니다

## 5. 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | 3000 | 서버 포트 |
| `ANTHROPIC_API_KEY` | - | Claude 키 (서버 측) |
| `CLAUDE_MODEL` | claude-fable-5 | AI 분석 모델 |
| `PERPLEXITY_API_KEY` | - | Perplexity 키 (서버 측) |
| `GEO_RECRAWL_HOUR` | 6 | 추적 URL 자동 재분석 시각 (`off` 비활성) |
| `GEO_SOV_HOUR` | 6 | SoV 자동 측정 시각 (`off` 비활성) |
| `GEO_DATA_DIR` | ./data | DB 저장 경로 |
| `GEO_SOV_MOCK` | - | `1`이면 SoV 모크 모드 |

## 6. 데이터 관리

- 모든 이력은 `data/` 폴더에 저장됩니다 (`geo.db` 또는 `geo-history.json`)
- **백업 = `data/` 폴더 복사**. 다른 PC로 옮길 때도 이 폴더만 가져가면 됩니다
- 이력 전체 삭제: 분석 이력 탭의 "🗑 전체 삭제" (추적 URL·SoV 설정은 유지)

## 7. API 레퍼런스 (자동화·연동용)

```
POST /api/analyze        { url } 또는 { html }     단일 채점
POST /api/batch          { urls: [...] }           일괄 채점 (≤20)
POST /api/compare        { urlA, urlB }            비교
POST /api/ai/analyze     { result }                Claude 정성 평가  (헤더 x-anthropic-key)
POST /api/ai/rewrite     { result }                Claude 리라이팅   (헤더 x-anthropic-key)
POST /api/report/pdf     분석결과 JSON → PDF
POST /api/report/excel   분석결과 JSON → Excel
GET  /api/history        ?limit&q                  이력 목록
GET  /api/history/:id                              이력 스냅샷
GET  /api/timeseries     ?url=                     점수 추이
GET/POST/DELETE /api/track                          추적 URL · POST /api/track/run 즉시 재분석
GET/PUT /api/sov/config                             SoV 도메인 설정
GET/POST/DELETE /api/sov/keywords                   SoV 키워드
POST /api/sov/run                                   SoV 측정          (헤더 x-perplexity-key)
GET  /api/sov/summary                               SoV 요약·추이·상관
GET  /api/health                                    서버·DB·키 상태
```

예시:
```bash
curl -X POST localhost:3000/api/analyze -H 'Content-Type: application/json' \
  -d '{"url":"https://www.example.co.kr/news/123"}'
```

## 8. 문제 해결 (FAQ)

**Q. 점수가 이상하게 낮아요 (본문 길이 0 등)**
→ 항목 상세의 "추출:" 표시 확인. `fallback`이면 본문 인식 실패 가능성 — 기사 HTML을 복사해 "HTML 직접 붙여넣기"로 분석하세요. 로그인이 필요한 페이지나 JS 렌더링 페이지(SPA)는 URL 분석이 어렵습니다.

**Q. URL 분석 시 "URL 가져오기 실패"**
→ 해당 사이트가 봇 접근을 차단한 경우입니다. HTML 직접 붙여넣기를 이용하세요.

**Q. AI 평가/리라이팅 버튼이 에러를 띄워요**
→ 도구 탭에서 키 저장 여부 확인. 401이면 키 오타, 429면 사용량 초과입니다.

**Q. 추이 차트가 안 보여요**
→ 같은 "URL"로 2회 이상 분석해야 그려집니다. HTML 직접 붙여넣기는 URL이 없어 추이 대상에서 제외됩니다.

**Q. 자동 재분석·자동 SoV 측정이 안 돌아요**
→ 서버가 해당 시각(기본 6시)에 켜져 있어야 합니다. SoV 자동 측정은 환경변수 `PERPLEXITY_API_KEY`가 필요합니다(브라우저 키는 자동 실행에 사용되지 않음).

**Q. v2(이전 버전)와 점수가 달라요**
→ 정상입니다. 길이 판정 버그 수정과 항목 개편(18→20개)으로 v2 점수가 과대평가되던 것이 교정됐습니다. 추이 비교는 같은 엔진(v2 표시: engineVersion 2) 내에서 하세요.

## 9. 테스트

```bash
npm test   # 채점 엔진 스모크 테스트
```
