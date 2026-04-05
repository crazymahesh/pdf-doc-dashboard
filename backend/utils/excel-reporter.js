'use strict';
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

const STATUS_COLORS = {
  completed: { fg: 'FFD1FAE5', font: 'FF065F46' },
  failed: { fg: 'FFFEE2E2', font: 'FF991B1B' },
  pending: { fg: 'FFF3F4F6', font: 'FF374151' },
  running: { fg: 'FFDBEAFE', font: 'FF1E40AF' },
  passed: { fg: 'FFD1FAE5', font: 'FF065F46' },
};

function cellColor(status) {
  return STATUS_COLORS[status] || STATUS_COLORS.pending;
}

async function generateReport(files, outputDir, date) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'PDF-DOC Dashboard';
  wb.created = new Date();

  const regularFiles   = files.filter((f) => f.category === 'regular');
  const scannedFiles   = files.filter((f) => f.category === 'scanned');
  const corruptedFiles = files.filter((f) => f.category === 'corrupted');
  const normalFiles    = files.filter((f) => f.category !== 'corrupted');

  // ── Sheet 1: PDF Download Log ──────────────────────────────────────────────
  const ws = wb.addWorksheet('PDF Download Log');

  ws.columns = [
    { header: '#',               key: 'seq',           width: 5  },
    { header: 'PDF Name',        key: 'name',          width: 42 },
    { header: 'Category',        key: 'category',      width: 13 },
    { header: 'Size (KB)',       key: 'sizeKB',        width: 11 },
    { header: 'Total Pages',     key: 'pages',         width: 13 },
    { header: 'Scanned PDF',     key: 'isScanned',     width: 13 },
    { header: 'Admin Folder',    key: 'adminFolder',   width: 13 },
    { header: 'Downloaded At',   key: 'downloadedAt',  width: 22 },
    { header: 'Ligature Fix',    key: 'ligatureFix',   width: 14 },
    { header: 'Final Status',    key: 'finalStatus',   width: 14 },
  ];

  const hdr = ws.getRow(1);
  hdr.font      = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
  hdr.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A56DB' } };
  hdr.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  hdr.height    = 24;

  files.forEach((f, i) => {
    const isCorrupted = f.category === 'corrupted';
    const row = ws.addRow({
      seq:          i + 1,
      name:         f.name,
      category:     isCorrupted ? 'CORRUPTED' : (f.isScanned ? 'Scanned' : 'Regular'),
      sizeKB:       f.sizeKB || 0,
      pages:        f.pages  || 0,
      isScanned:    f.isScanned ? 'Yes' : 'No',
      adminFolder:  f.adminFolder  || (isCorrupted ? '—' : ''),
      downloadedAt: f.downloadedAt ? new Date(f.downloadedAt).toLocaleString() : '',
      ligatureFix:  f.afterLigatureFixStatus || 'pending',
      finalStatus:  f.finalStatus || 'pending',
    });

    row.alignment = { vertical: 'middle' };

    // Corrupted row — full red highlight
    if (isCorrupted) {
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
        cell.font = { color: { argb: 'FF991B1B' } };
      });
      // Overwrite category cell to bold
      const catCell = row.getCell('category');
      catCell.font = { bold: true, color: { argb: 'FF991B1B' } };
      return; // skip further per-cell styling for corrupted rows
    }

    // Zebra striping for normal rows
    if ((i + 1) % 2 === 0) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
    }

    // Scanned cell
    const sc = row.getCell('isScanned');
    if (f.isScanned) {
      sc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };
      sc.font = { bold: true, color: { argb: 'FF92400E' } };
    } else {
      sc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
      sc.font = { color: { argb: 'FF065F46' } };
    }
    sc.alignment = { horizontal: 'center' };

    // Ligature fix cell
    const lf = row.getCell('ligatureFix');
    const lfColor = cellColor(f.afterLigatureFixStatus);
    lf.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: lfColor.fg } };
    lf.font      = { color: { argb: lfColor.font } };
    lf.alignment = { horizontal: 'center' };

    // Final status cell
    const fs2 = row.getCell('finalStatus');
    const fsColor = cellColor(f.finalStatus);
    fs2.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: fsColor.fg } };
    fs2.font      = { color: { argb: fsColor.font } };
    fs2.alignment = { horizontal: 'center' };
  });

  // Totals row
  ws.addRow([]);
  const totals = ws.addRow({
    seq:      '',
    name:     `TOTAL: ${files.length}  |  Regular: ${regularFiles.length}  |  Scanned: ${scannedFiles.length}  |  Corrupted: ${corruptedFiles.length}`,
    sizeKB:   normalFiles.reduce((s, f) => s + (f.sizeKB || 0), 0),
    pages:    normalFiles.reduce((s, f) => s + (f.pages  || 0), 0),
  });
  totals.font = { bold: true, size: 11 };
  totals.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };

  ws.views      = [{ state: 'frozen', xSplit: 0, ySplit: 1, activeCell: 'A2' }];
  ws.autoFilter = { from: 'A1', to: 'J1' };

  // ── Sheet 2: Corrupted Files ───────────────────────────────────────────────
  const cwsTitle = `Corrupted Files (${corruptedFiles.length})`;
  const cws = wb.addWorksheet(cwsTitle);
  cws.columns = [
    { header: '#',           key: 'seq',    width: 5  },
    { header: 'PDF Name',    key: 'name',   width: 45 },
    { header: 'Size (KB)',   key: 'sizeKB', width: 12 },
    { header: 'Error Reason',key: 'error',  width: 60 },
    { header: 'Folder',      key: 'folder', width: 20 },
  ];

  const chdr = cws.getRow(1);
  chdr.font      = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
  chdr.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF991B1B' } };
  chdr.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  chdr.height    = 24;

  if (corruptedFiles.length === 0) {
    const noRow = cws.addRow({ name: 'No corrupted files detected in this session.' });
    noRow.font = { italic: true, color: { argb: 'FF6B7280' } };
  } else {
    corruptedFiles.forEach((f, i) => {
      const row = cws.addRow({
        seq:    i + 1,
        name:   f.name,
        sizeKB: f.sizeKB || 0,
        error:  f.classifyError || 'Unknown error',
        folder: 'Corrupted PDF/',
      });
      row.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
      row.font      = { color: { argb: 'FF991B1B' } };
      row.alignment = { vertical: 'middle', wrapText: true };
      // Error cell — wrap long messages
      row.getCell('error').alignment = { wrapText: true, vertical: 'top' };
      row.height = 32;
    });
  }

  cws.views = [{ state: 'frozen', xSplit: 0, ySplit: 1, activeCell: 'A2' }];

  // ── Sheet 3: Summary ───────────────────────────────────────────────────────
  const summary = wb.addWorksheet('Summary');
  summary.columns = [
    { header: 'Metric', key: 'metric', width: 32 },
    { header: 'Value',  key: 'value',  width: 20 },
  ];
  const sh = summary.getRow(1);
  sh.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sh.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A56DB' } };

  const summaryData = [
    ['Report Date',            date],
    ['Total PDFs Downloaded',  files.length],
    ['Regular (Digital) PDFs', regularFiles.length],
    ['Scanned PDFs',           scannedFiles.length],
    ['Corrupted / Error PDFs', corruptedFiles.length],
    ['Total Pages',            normalFiles.reduce((s, f) => s + (f.pages  || 0), 0)],
    ['Total Size (KB)',        normalFiles.reduce((s, f) => s + (f.sizeKB || 0), 0)],
    ['After Ligature Fix',     files.filter((f) => f.afterLigatureFixStatus === 'completed').length],
    ['Moved to Final',         files.filter((f) => f.finalStatus === 'completed').length],
  ];

  summaryData.forEach(([metric, value], i) => {
    const row = summary.addRow({ metric, value });
    // Highlight corrupted row in red
    if (metric === 'Corrupted / Error PDFs' && value > 0) {
      row.getCell('metric').font = { bold: true, color: { argb: 'FF991B1B' } };
      row.getCell('value').font  = { bold: true, color: { argb: 'FF991B1B' } };
    }
    // Alternate shading
    if (i % 2 === 0) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9FAFB' } };
    }
  });

  const filename   = `PDF-DOC-Report-${date}.xlsx`;
  const outputPath = path.join(outputDir, filename);
  await wb.xlsx.writeFile(outputPath);
  return outputPath;
}

module.exports = { generateReport };
