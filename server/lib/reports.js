'use strict';
/**
 * reports.js — PDF·Excel 리포트 생성기
 * pdfkit → PDF / xlsx(SheetJS) → Excel
 */

const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');
const { CRITERIA } = require('./scorer');

// ── 색상 팔레트 (PDF) ──────────────────────────────────────────────
const C = {
  navy:   '#065A82',
  teal:   '#1C7293',
  cyan:   '#00B4D8',
  mid:    '#21295C',
  accent: '#FF6B35',
  green:  '#2D9E6B',
  yellow: '#F59E0B',
  red:    '#EF4444',
  muted:  '#64748B',
  bg:     '#F0F5F9',
  white:  '#FFFFFF',
  dark:   '#1A2332',
};

const GRADE_COLOR = { A: C.green, B: C.teal, C: C.yellow, D: C.accent, F: C.red };

// ────────────────────────────────────────────────────────────────────
// PDF 생성
// ────────────────────────────────────────────────────────────────────
function buildPDF(result, outputStream) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: 'GEO Score Report' } });
    doc.pipe(outputStream);
    outputStream.on('error', reject);

    const { scores, details, totals, grade, meta, url, analyzedAt } = result;
    const { total, seoTotal, geoTotal } = totals;
    const gradeColor = GRADE_COLOR[grade] || C.muted;

    // ── 헤더 배너 ────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 90).fill(C.mid);
    doc.fillColor(C.white)
       .font('Helvetica-Bold').fontSize(18).text('GEO Score Report', 50, 24);
    doc.font('Helvetica').fontSize(10)
       .text(`분석 일시: ${new Date(analyzedAt).toLocaleString('ko-KR')}`, 50, 50)
       .text(url ? `URL: ${url.slice(0, 80)}` : '(HTML 직접 분석)', 50, 65);

    // ── 총점 원형 ─────────────────────────────────────────────────
    doc.y = 110;
    const cx = doc.page.width - 110, cy = 150, r = 40;
    doc.circle(cx, cy, r).fill(gradeColor);
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(26)
       .text(String(total), cx - 18, cy - 18, { width: 36, align: 'center' });
    doc.fontSize(9).text('/ 100', cx - 18, cy + 10, { width: 36, align: 'center' });

    doc.fillColor(C.dark).font('Helvetica-Bold').fontSize(22)
       .text(`등급: ${grade}`, 50, 120);
    doc.font('Helvetica').fontSize(11)
       .fillColor(C.muted)
       .text(`SEO 기반: ${seoTotal}/50점    GEO 특화: ${geoTotal}/50점`, 50, 148)
       .text(meta.title ? `제목: ${meta.title.slice(0, 70)}` : '(제목 없음)', 50, 163);
    // v3 색인·인용 게이트
    const gate = result.indexability;
    if (gate && gate.status !== 'ok') {
      doc.font('Helvetica-Bold').fontSize(10)
         .fillColor(gate.status === 'blocked' ? '#B91C1C' : '#B45309')
         .text(`${gate.status === 'blocked' ? '[인용 불가]' : '[인용 제한]'} ${gate.blockers.concat(gate.limits).map(x => x.message).join(' / ').slice(0, 110)}`, 50, 176, { width: doc.page.width - 100 });
      doc.font('Helvetica');
    }

    // ── 구분선 ────────────────────────────────────────────────────
    doc.moveTo(50, 190).lineTo(doc.page.width - 50, 190).strokeColor(C.bg).lineWidth(1.5).stroke();

    // ── 섹션 헬퍼 ────────────────────────────────────────────────
    const sectionTitle = (text, color = C.navy) => {
      doc.y += 10;
      doc.rect(50, doc.y, doc.page.width - 100, 22).fill(color);
      doc.fillColor(C.white).font('Helvetica-Bold').fontSize(11)
         .text(text, 56, doc.y + 5, { width: doc.page.width - 112 });
      doc.y += 26;
    };

    const row = (label, score, max, detail) => {
      const ratio = score / max;
      const dotColor = ratio >= 0.8 ? C.green : ratio >= 0.4 ? C.yellow : C.red;
      const yStart = doc.y;
      if (yStart > doc.page.height - 80) { doc.addPage(); }
      doc.circle(58, doc.y + 5, 4).fill(dotColor);
      doc.fillColor(C.dark).font('Helvetica').fontSize(9.5)
         .text(label, 68, doc.y, { width: 220 });
      doc.font('Helvetica-Bold').fontSize(9.5)
         .text(`${score}/${max}`, 300, yStart, { width: 40, align: 'right' });
      doc.fillColor(C.muted).font('Helvetica').fontSize(8.5)
         .text(detail || '', 350, yStart, { width: 200 });
      doc.y = Math.max(doc.y, yStart + 16);
    };

    // ── SEO 항목 ─────────────────────────────────────────────────
    sectionTitle('SEO 기반 항목 (50점)', C.teal);
    CRITERIA.filter(c => c.group === 'seo').forEach(c => {
      row(c.label, scores[c.id] || 0, c.max, details[c.id]);
    });

    // ── GEO 항목 ─────────────────────────────────────────────────
    sectionTitle('GEO 특화 항목 (50점)', C.mid);
    CRITERIA.filter(c => c.group === 'geo').forEach(c => {
      row(c.label, scores[c.id] || 0, c.max, details[c.id]);
    });

    // ── 개선 권고 ─────────────────────────────────────────────────
    const failed = CRITERIA
      .filter(c => (scores[c.id] || 0) / c.max < 0.8)
      .sort((a, b) => b.max - a.max)
      .slice(0, 6);

    if (failed.length) {
      sectionTitle('개선 권고 TOP ' + failed.length, C.accent);
      failed.forEach((c, i) => {
        if (doc.y > doc.page.height - 60) doc.addPage();
        doc.fillColor(C.dark).font('Helvetica-Bold').fontSize(9.5)
           .text(`${i + 1}. ${c.label}`, 56, doc.y);
        doc.y += 13;
        doc.fillColor(C.muted).font('Helvetica').fontSize(8.5)
           .text(`현재: ${details[c.id]}  |  최대 ${c.max}점 항목`, 68, doc.y);
        doc.y += 13;
      });
    }

    // ── 푸터 ─────────────────────────────────────────────────────
    const range = doc.bufferedPageRange();
    const pageCount = range.count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(range.start + i);
      doc.rect(0, doc.page.height - 30, doc.page.width, 30).fill(C.mid);
      doc.fillColor(C.white).font('Helvetica').fontSize(8)
         .text('GEO Score Analyzer — Option A (Node.js)',
               50, doc.page.height - 19, { width: doc.page.width - 120 });
      doc.text(`${i + 1} / ${pageCount}`,
               doc.page.width - 80, doc.page.height - 19, { width: 60, align: 'right' });
    }

    doc.end();
    doc.on('end', resolve);
    doc.on('error', reject);
  });
}

// ────────────────────────────────────────────────────────────────────
// Excel 생성 (단일 결과 또는 배치 결과 배열)
// ────────────────────────────────────────────────────────────────────
function buildExcel(results) {
  // results: 단일 객체 또는 배열
  const arr = Array.isArray(results) ? results : [results];

  const wb = XLSX.utils.book_new();

  // ① 요약 시트
  const gateText = (r) => {
    const g = r.indexability;
    if (!g) return '';
    return g.status === 'ok' ? '가능' : (g.status === 'blocked' ? '불가: ' : '제한: ')
      + g.blockers.concat(g.limits).map(x => x.directive + '(' + x.bot + ')').join(', ');
  };
  const summaryHeader = ['URL', '분석일시', '총점', '등급', '색인·인용', 'SEO(50)', 'GEO(50)',
    ...CRITERIA.map(c => c.label)];
  const summaryRows = arr.map(r => [
    r.url || '',
    r.analyzedAt ? new Date(r.analyzedAt).toLocaleString('ko-KR') : '',
    r.totals.total,
    r.grade,
    gateText(r),
    r.totals.seoTotal,
    r.totals.geoTotal,
    ...CRITERIA.map(c => r.scores[c.id] || 0),
  ]);
  const summarySheet = XLSX.utils.aoa_to_sheet([summaryHeader, ...summaryRows]);

  // 열 너비 설정
  summarySheet['!cols'] = [
    { wch: 50 }, { wch: 20 }, { wch: 8 }, { wch: 6 }, { wch: 24 }, { wch: 8 }, { wch: 8 },
    ...CRITERIA.map(() => ({ wch: 18 })),
  ];
  XLSX.utils.book_append_sheet(wb, summarySheet, '요약');

  // ② 항목별 상세 시트 (첫 번째 결과 또는 배치 전체)
  const detailHeader = ['항목', '구분', '카테고리', '최대점수',
    ...arr.map((r, i) => r.url ? r.url.slice(0, 40) : `기사 ${i + 1}`)];
  const detailRows = CRITERIA.map(c => [
    c.label, c.group.toUpperCase(), c.cat, c.max,
    ...arr.map(r => r.scores[c.id] || 0),
  ]);
  const detailSheet = XLSX.utils.aoa_to_sheet([detailHeader, ...detailRows]);
  detailSheet['!cols'] = [
    { wch: 28 }, { wch: 6 }, { wch: 14 }, { wch: 8 },
    ...arr.map(() => ({ wch: 10 })),
  ];
  XLSX.utils.book_append_sheet(wb, detailSheet, '항목별 상세');

  // ③ 개선 권고 시트 (첫 번째 결과 기준)
  if (arr.length === 1) {
    const r = arr[0];
    const failed = CRITERIA
      .filter(c => (r.scores[c.id] || 0) / c.max < 0.8)
      .sort((a, b) => b.max - a.max);
    const recoHeader = ['항목', '구분', '현재점수', '최대점수', '달성률', '현재 상태'];
    const recoRows = failed.map(c => [
      c.label, c.group.toUpperCase(),
      r.scores[c.id] || 0, c.max,
      `${Math.round(((r.scores[c.id] || 0) / c.max) * 100)}%`,
      r.details[c.id] || '',
    ]);
    const recoSheet = XLSX.utils.aoa_to_sheet([recoHeader, ...recoRows]);
    recoSheet['!cols'] = [{ wch: 28 }, { wch: 6 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, recoSheet, '개선 권고');
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildPDF, buildExcel };
