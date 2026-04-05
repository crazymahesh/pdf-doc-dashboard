'use strict';
/**
 * Step 1 — SFTP Download & PDF Classification  (phased pipeline)
 *
 * PHASE 1 · CONNECT & LIST
 *   Connect to SFTP, list today's remote folder.
 *
 * PHASE 2 · DOWNLOAD (per-file)
 *   Download each PDF into the date folder temp area.
 *   Uses directory-snapshot diff to resolve the REAL filename on disk —
 *   RebexTinyFTP on Windows can return 8.3 short names (e.g. NATION~1.PDF)
 *   in the listing, but the bytes land under the long name.
 *
 * PHASE 3 · CLASSIFY (per-file, independently isolated)
 *   Analyse each PDF (page count, scanned detection).
 *   Copy → target subfolder, delete temp copy.
 *   Uses copyFileSync + unlinkSync (never renameSync) to avoid Windows
 *   cross-directory rename failures with 8.3-aliased source paths.
 *
 * PHASE 4 · REPORT
 *   Generate Excel, mark stages complete.
 */

const SftpClient = require('ssh2-sftp-client');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const { analyzePDF } = require('../utils/pdf-analyzer');
const { generateReport } = require('../utils/excel-reporter');
const {
  getTodayDate,
  getOrCreateTodaySession,
  updateStage,
  updateStats,
  upsertFile,
  addActivityLog,
  getTodaySession,
} = require('../utils/state-manager');
const logger = require('../utils/logger');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Snapshot the PDF files in a directory.
 * Returns a Set of basenames.
 */
function snapshotDir(dir) {
  try {
    return new Set(fs.readdirSync(dir).filter((f) => /\.pdf$/i.test(f)));
  } catch {
    return new Set();
  }
}

/**
 * Find the file that appeared in `dir` after `before` snapshot was taken.
 * This is the canonical way to get the REAL filename when the SFTP server
 * returned a Windows 8.3 short name — the bytes on disk always carry the
 * long name even if the listing said NATION~1.PDF.
 *
 * Strategy (in order):
 *  1. Exact match by expected name (most common case: long names throughout)
 *  2. Any single new PDF in the dir since the snapshot (short-name mismatch)
 *  3. Case-insensitive exact match among all PDFs in the dir
 *
 * Returns the full resolved path, or null if the file cannot be located.
 */
function resolveDownloadedFile(expectedPath, dir, before) {
  const expectedBase = path.basename(expectedPath);
  const after = fs.readdirSync(dir).filter((f) => /\.pdf$/i.test(f));

  // 1. Exact match
  if (after.includes(expectedBase)) {
    return path.join(dir, expectedBase);
  }

  // 2. New file since snapshot (handles short-name → long-name mismatch)
  const newFiles = after.filter((f) => !before.has(f));
  if (newFiles.length === 1) {
    logger.warn(`Short-name resolved: "${expectedBase}" → "${newFiles[0]}"`);
    addActivityLog('warning', `Short-name resolved: "${expectedBase}" → "${newFiles[0]}"`, {});
    return path.join(dir, newFiles[0]);
  }

  // 3. Case-insensitive fallback
  const ci = after.find((f) => f.toLowerCase() === expectedBase.toLowerCase());
  if (ci) return path.join(dir, ci);

  // Not found — log directory contents for diagnostics
  logger.error(
    `File not found after download. Expected: "${expectedBase}". ` +
    `Dir contents: [${after.join(', ')}]`
  );
  return null;
}

/**
 * Move a file by copying + deleting the source.
 * Safer than renameSync for Windows paths containing 8.3 short-name aliases.
 */
function moveFile(src, dest) {
  fs.copyFileSync(src, dest);
  fs.unlinkSync(src);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const today = getTodayDate();
  getOrCreateTodaySession();

  // Pre-compute ALL paths once — avoids getter re-evaluation inconsistencies
  const PATHS = {
    dateFolder:          config.paths.dateFolder,
    scannedPdf:          config.paths.scannedPdf,
    corruptedPdf:        config.paths.corruptedPdf,
    outputWithDatetime:  config.paths.outputWithDatetime,
    reports:             config.paths.reports,
  };

  logger.info('── PHASE 1: CONNECT & LIST ──────────────────────────────────────');

  updateStage(today, 'download', {
    status: 'running',
    startTime: new Date().toISOString(),
    message: `Connecting to ${config.sftp.host}…`,
  });
  addActivityLog('info', 'SFTP download started', { date: today, host: config.sftp.host });

  // ── Ensure all local directories exist ────────────────────────────────────
  for (const [key, dir] of Object.entries(PATHS)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info(`Directory ready [${key}]: ${dir}`);
  }

  const sftp = new SftpClient();

  try {
    // ── PHASE 1: Connect ───────────────────────────────────────────────────
    logger.info(`Connecting to ${config.sftp.host}:${config.sftp.port} as ${config.sftp.username}`);
    await sftp.connect({
      host:         config.sftp.host,
      port:         config.sftp.port,
      username:     config.sftp.username,
      password:     config.sftp.password,
      readyTimeout: 20000,
    });
    addActivityLog('success', `SFTP connected: ${config.sftp.host}`, {
      remotePath: config.sftp.remotePath,
    });

    // ── List remote folder ─────────────────────────────────────────────────
    updateStage(today, 'download', { message: `Listing: ${config.sftp.remotePath}` });
    let remoteFiles = [];
    try {
      remoteFiles = await sftp.list(config.sftp.remotePath);
    } catch (err) {
      throw new Error(`Remote folder not accessible: ${config.sftp.remotePath} — ${err.message}`);
    }

    const pdfFiles = remoteFiles.filter((f) => /\.pdf$/i.test(f.name) && f.type === '-');
    logger.info(`Found ${pdfFiles.length} PDF file(s) on SFTP`);

    if (pdfFiles.length === 0) {
      updateStage(today, 'download', {
        status: 'completed',
        endTime: new Date().toISOString(),
        message: 'No PDF files found in remote folder',
      });
      updateStage(today, 'classification', {
        status: 'completed',
        endTime: new Date().toISOString(),
        message: 'Nothing to classify',
      });
      addActivityLog('warning', 'No PDF files found on SFTP', {
        remotePath: config.sftp.remotePath,
      });
      await sftp.end();
      return;
    }

    addActivityLog('info', `Found ${pdfFiles.length} PDF file(s) on SFTP`, {
      count: pdfFiles.length,
    });

    // ── PHASE 2: Download ──────────────────────────────────────────────────
    logger.info('── PHASE 2: DOWNLOAD ────────────────────────────────────────────');
    const downloaded = []; // { name, localPath, remoteSize }

    for (let i = 0; i < pdfFiles.length; i++) {
      const file     = pdfFiles[i];
      const progress = `[${i + 1}/${pdfFiles.length}]`;
      const expected = path.join(PATHS.dateFolder, file.name);
      const remote   = `${config.sftp.remotePath}/${file.name}`;

      updateStage(today, 'download', {
        message: `${progress} Downloading: ${file.name}`,
      });
      logger.info(`${progress} Downloading: ${file.name} → ${expected}`);

      // Snapshot BEFORE download so we can diff for the real filename
      const before = snapshotDir(PATHS.dateFolder);

      try {
        await sftp.fastGet(remote, expected);
      } catch (dlErr) {
        logger.error(`${progress} fastGet failed for "${file.name}": ${dlErr.message}`);
        addActivityLog('error', `Download failed: ${file.name}`, { error: dlErr.message });
        upsertFile(today, {
          name: file.name,
          sizeKB: Math.round((file.size || 0) / 1024),
          pages: 0,
          isScanned: false,
          category: 'unknown',
          downloadStatus: 'failed',
          downloadError: dlErr.message,
          conversionStatus: 'pending',
          qualityStatus: 'pending',
          finalStatus: 'pending',
        });
        continue; // skip to next file — do NOT crash the batch
      }

      // Resolve actual on-disk path (handles 8.3 → long-name mismatch)
      const actualPath = resolveDownloadedFile(expected, PATHS.dateFolder, before);
      if (!actualPath) {
        logger.error(`${progress} File disappeared after download: "${file.name}"`);
        addActivityLog('error', `File missing after download: ${file.name}`, {});
        upsertFile(today, {
          name: file.name, sizeKB: 0, pages: 0, isScanned: false,
          category: 'unknown', downloadStatus: 'failed',
          downloadError: 'File not found on disk after fastGet',
          conversionStatus: 'pending', qualityStatus: 'pending', finalStatus: 'pending',
        });
        continue;
      }

      const actualName = path.basename(actualPath);
      downloaded.push({ name: actualName, localPath: actualPath, remoteSize: file.size || 0 });
      addActivityLog('info', `${progress} Downloaded: ${actualName}`, {
        sizeKB: Math.round((file.size || 0) / 1024),
      });
    }

    // Disconnect SFTP before heavy local work
    try { await sftp.end(); } catch {}
    logger.info(`Download phase done — ${downloaded.length}/${pdfFiles.length} succeeded`);
    updateStage(today, 'download', {
      status: 'completed',
      endTime: new Date().toISOString(),
      message: `${downloaded.length} of ${pdfFiles.length} file(s) downloaded`,
    });

    if (downloaded.length === 0) {
      updateStage(today, 'classification', {
        status: 'failed',
        endTime: new Date().toISOString(),
        message: 'No files were successfully downloaded',
      });
      addActivityLog('error', 'No files downloaded successfully');
      process.exit(1);
    }

    // ── PHASE 3: Classify (per-file, independently isolated) ──────────────
    logger.info('── PHASE 3: CLASSIFY ────────────────────────────────────────────');
    updateStage(today, 'classification', {
      status: 'running',
      startTime: new Date().toISOString(),
      message: `Classifying ${downloaded.length} file(s)…`,
    });

    let scannedCount   = 0;
    let regularCount   = 0;
    let corruptedCount = 0;
    let totalPages     = 0;
    let classifyOk     = 0;
    let classifyFail   = 0;

    for (let i = 0; i < downloaded.length; i++) {
      const dl       = downloaded[i];
      const progress = `[${i + 1}/${downloaded.length}]`;

      updateStage(today, 'classification', {
        message: `${progress} Classifying: ${dl.name}`,
      });
      logger.info(`${progress} Classifying: ${dl.name} (source: ${dl.localPath})`);

      // ── Per-file try-catch — one failure never kills the batch ──────────
      try {
        // Sanity check — source must exist before we try to move it
        if (!fs.existsSync(dl.localPath)) {
          throw new Error(`Source file not found on disk: ${dl.localPath}`);
        }

        // Analyse PDF
        const analysis = await analyzePDF(dl.localPath);

        // ── Corrupted / unreadable file ──────────────────────────────────────
        if (analysis.error) {
          const corruptDir  = PATHS.corruptedPdf;
          const corruptPath = path.join(corruptDir, dl.name);
          fs.mkdirSync(corruptDir, { recursive: true });
          moveFile(dl.localPath, corruptPath);
          corruptedCount++;
          classifyOk++;

          upsertFile(today, {
            name:           dl.name,
            sizeKB:         Math.round(dl.remoteSize / 1024),
            pages:          0,
            isScanned:      false,
            category:       'corrupted',
            localPath:      corruptPath,
            downloadStatus: 'completed',
            downloadedAt:   new Date().toISOString(),
            classifyError:  analysis.error,
            finalStatus:    'pending',
          });

          logger.warn(`${progress} Corrupted/unreadable — moved to "Corrupted PDF/": ${dl.name} | Error: ${analysis.error}`);
          addActivityLog('warning',
            `${progress} Corrupted PDF detected: ${dl.name}`,
            { error: analysis.error, folder: 'Corrupted PDF' }
          );
          continue; // skip scanned/regular classification
        }

        // ── Normal classification ────────────────────────────────────────────
        const isScanned  = analysis.isScanned;
        const targetDir  = isScanned ? PATHS.scannedPdf : PATHS.outputWithDatetime;
        const targetPath = path.join(targetDir, dl.name);
        const label      = isScanned ? 'Scanned PDF' : 'output-with-datetime';

        // Ensure target directory exists (belt-and-suspenders)
        fs.mkdirSync(targetDir, { recursive: true });

        // Move: copy + delete (safe alternative to renameSync for Windows 8.3 paths)
        moveFile(dl.localPath, targetPath);

        if (isScanned) scannedCount++;
        else           regularCount++;
        totalPages += analysis.pages || 0;
        classifyOk++;

        upsertFile(today, {
          name:             dl.name,
          sizeKB:           analysis.sizeKB || Math.round(dl.remoteSize / 1024),
          pages:            analysis.pages  || 0,
          isScanned,
          category:         isScanned ? 'scanned' : 'regular',
          localPath:        targetPath,
          downloadStatus:   'completed',
          downloadedAt:     new Date().toISOString(),
          finalStatus:      'pending',
        });

        addActivityLog(isScanned ? 'warning' : 'success',
          `${progress} Classified → ${label}: ${dl.name}`,
          { pages: analysis.pages, sizeKB: analysis.sizeKB, isScanned });

        logger.info(`${progress} ✓ Classified → ${label}: ${dl.name}`);

      } catch (fileErr) {
        classifyFail++;
        logger.error(`${progress} Classify failed for "${dl.name}": ${fileErr.message}`, {
          stack: fileErr.stack,
        });
        addActivityLog('error', `Classify failed: ${dl.name}`, { error: fileErr.message });
        upsertFile(today, {
          name:           dl.name,
          sizeKB:         Math.round(dl.remoteSize / 1024),
          downloadStatus: 'completed',
          downloadedAt:   new Date().toISOString(),
          category:       'unknown',
          classifyError:  fileErr.message,
          conversionStatus: 'pending',
          qualityStatus:    'pending',
          finalStatus:      'pending',
        });
        // Continue to next file
      }
    }

    // ── Update stats & stage ───────────────────────────────────────────────
    updateStats(today, {
      totalPdfs:     downloaded.length,
      scannedPdfs:   scannedCount,
      regularPdfs:   regularCount,
      corruptedPdfs: corruptedCount,
      totalPages,
    });

    updateStage(today, 'classification', {
      status:  classifyFail === 0 ? 'completed' : (classifyOk > 0 ? 'completed' : 'failed'),
      endTime: new Date().toISOString(),
      message: `${regularCount} regular · ${scannedCount} scanned` +
               (corruptedCount > 0 ? ` · ${corruptedCount} corrupted` : '') +
               (classifyFail   > 0 ? ` · ${classifyFail} error(s)`   : ''),
    });

    // ── PHASE 4: Excel Report ──────────────────────────────────────────────
    logger.info('── PHASE 4: REPORT ──────────────────────────────────────────────');
    try {
      const session    = getTodaySession();
      const reportPath = await generateReport(session.files, PATHS.reports, today);
      addActivityLog('success', 'Excel report generated', { path: reportPath });
      logger.info(`Excel report saved: ${reportPath}`);
    } catch (rptErr) {
      logger.warn(`Excel report generation failed (non-fatal): ${rptErr.message}`);
      addActivityLog('warning', 'Excel report generation failed', { error: rptErr.message });
    }

    addActivityLog('success', 'Download & classification complete', {
      total: downloaded.length, regular: regularCount,
      scanned: scannedCount, totalPages, errors: classifyFail,
    });
    logger.info(
      `All phases complete — total: ${downloaded.length}, ` +
      `regular: ${regularCount}, scanned: ${scannedCount}, ` +
      `pages: ${totalPages}, classify errors: ${classifyFail}`
    );

  } catch (fatalErr) {
    // Only fatal errors reach here (connection failure, listing failure)
    logger.error(`Fatal error in download pipeline: ${fatalErr.message}`, {
      stack: fatalErr.stack,
    });
    updateStage(today, 'download', {
      status:  'failed',
      endTime: new Date().toISOString(),
      message: fatalErr.message,
    });
    addActivityLog('error', 'Download pipeline fatal error', { error: fatalErr.message });
    try { await sftp.end(); } catch {}
    process.exit(1);
  }
}

run();
