'use strict';
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

// If avg extractable text per page is below this threshold, consider the PDF scanned
const SCANNED_CHARS_PER_PAGE_THRESHOLD = 50;

/**
 * Analyze a PDF file.
 * Returns: { name, sizeKB, pages, isScanned, textLength, error }
 * Never throws — all errors are returned in the `error` field.
 */
async function analyzePDF(filePath) {
  const name = path.basename(filePath);

  try {
    // statSync is inside the try-catch so a missing file returns { error } instead of throwing
    const stat = fs.statSync(filePath);
    const sizeKB = Math.round(stat.size / 1024);

    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);

    const pages = data.numpages || 0;
    const textLength = (data.text || '').replace(/\s+/g, '').length;
    const avgCharsPerPage = pages > 0 ? textLength / pages : 0;
    const isScanned = avgCharsPerPage < SCANNED_CHARS_PER_PAGE_THRESHOLD;

    return { name, filePath, sizeKB, pages, isScanned, textLength, error: null };
  } catch (err) {
    return { name, filePath, sizeKB: 0, pages: 0, isScanned: false, textLength: 0, error: err.message };
  }
}

module.exports = { analyzePDF };
