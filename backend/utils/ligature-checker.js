'use strict';
const mammoth = require('mammoth');
const path = require('path');
const fs = require('fs');

/**
 * Unicode ligature characters that Adobe Acrobat may preserve unresolved
 * during PDF→DOC conversion, causing readability/copy-paste issues.
 */
const LIGATURES = {
  '\uFB00': 'ff',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\uFB03': 'ffi',
  '\uFB04': 'ffl',
  '\uFB05': 'st',
  '\uFB06': 'st',
};

/**
 * Check a single DOCX/DOC file for ligature characters.
 * Returns { fileName, hasLigatures, ligaturesFound, totalLigatureCount, status, error, checkedAt }
 */
async function checkFile(filePath) {
  const fileName = path.basename(filePath);

  try {
    const result = await mammoth.extractRawText({ path: filePath });
    const text = result.value || '';

    const found = [];
    let total = 0;

    for (const [char, replacement] of Object.entries(LIGATURES)) {
      const count = (text.match(new RegExp(char, 'g')) || []).length;
      if (count > 0) {
        found.push({ char, replacement, count });
        total += count;
      }
    }

    return {
      fileName,
      hasLigatures: found.length > 0,
      ligaturesFound: found,
      totalLigatureCount: total,
      status: found.length > 0 ? 'failed' : 'passed',
      error: null,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      fileName,
      hasLigatures: false,
      ligaturesFound: [],
      totalLigatureCount: 0,
      status: 'error',
      error: err.message,
      checkedAt: new Date().toISOString(),
    };
  }
}

/**
 * Check all DOCX/DOC files in a directory.
 */
async function checkDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const files = fs
    .readdirSync(dirPath)
    .filter((f) => /\.(docx|doc)$/i.test(f))
    .map((f) => path.join(dirPath, f));

  const results = [];
  for (const fp of files) {
    results.push(await checkFile(fp));
  }
  return results;
}

module.exports = { checkFile, checkDirectory };
