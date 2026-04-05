'use strict';
/**
 * Step 2 (monitor) + Step 3 (quality check)
 *
 * Watches the <date>/converted_raw/ folder for DOCX/DOC files produced
 * by Adobe Acrobat Pro.  Whenever a new file stabilises (no more writes),
 * the ligature quality check runs automatically and the dashboard is updated.
 *
 * Run this script in the background while the operator is doing manual
 * Adobe conversion:
 *   node scripts/watch-conversion.js
 */

const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');

const config = require('../config');
const { checkFile } = require('../utils/ligature-checker');
const {
  getTodayDate,
  getOrCreateTodaySession,
  getTodaySession,
  updateStage,
  updateStats,
  updateFile,
  addActivityLog,
} = require('../utils/state-manager');
const logger = require('../utils/logger');

const today = getTodayDate();
const watchDir = config.paths.convertedRaw;

// Debounce map: fileName → timeout handle
const debounceMap = new Map();
const SETTLE_DELAY_MS = 3000; // wait 3 s after last write before processing

async function handleNewFile(filePath) {
  const fileName = path.basename(filePath);
  logger.info(`New converted file detected: ${fileName}`);
  addActivityLog('info', `Converted file detected: ${fileName}`, { path: filePath });

  // Mark conversion stage running if first file
  const session = getTodaySession();
  if (session && session.stages.conversion.status !== 'running') {
    updateStage(today, 'conversion', {
      status: 'running',
      startTime: session.stages.conversion.startTime || new Date().toISOString(),
      message: 'Adobe conversion in progress…',
    });
  }

  // Update file record
  updateFile(today, fileName.replace(/\.(docx|doc)$/i, '.pdf'), {
    conversionStatus: 'completed',
    convertedAt: new Date().toISOString(),
    convertedFilePath: filePath,
    qualityStatus: 'running',
  });

  // ── Run ligature quality check ────────────────────────────────────────────
  addActivityLog('info', `Running ligature check: ${fileName}`);
  updateStage(today, 'qualityCheck', {
    status: 'running',
    startTime: new Date().toISOString(),
    message: `Checking: ${fileName}`,
  });

  const result = await checkFile(filePath);
  logger.info(
    `Ligature check [${result.status}] ${fileName} — ${result.totalLigatureCount} ligature(s) found`
  );

  const pdfName = fileName.replace(/\.(docx|doc)$/i, '.pdf');
  updateFile(today, pdfName, {
    qualityStatus: result.status === 'passed' ? 'passed' : 'failed',
    ligaturesFound: result.totalLigatureCount,
    ligaturesDetail: result.ligaturesFound,
    qualityCheckedAt: result.checkedAt,
  });

  if (result.hasLigatures) {
    addActivityLog('warning', `Ligature check FAILED: ${fileName}`, {
      count: result.totalLigatureCount,
      ligatures: result.ligaturesFound,
    });
  } else {
    addActivityLog('success', `Ligature check PASSED: ${fileName}`);
  }

  // Re-compute aggregate stats
  const updatedSession = getTodaySession();
  if (updatedSession) {
    const converted = updatedSession.files.filter((f) => f.conversionStatus === 'completed').length;
    const qualityPassed = updatedSession.files.filter((f) => f.qualityStatus === 'passed').length;
    const qualityFailed = updatedSession.files.filter((f) => f.qualityStatus === 'failed').length;

    updateStats(today, { converted, qualityPassed, qualityFailed });

    // Are all expected files converted?
    const totalRegular = updatedSession.stats.regularPdfs || 0;
    if (totalRegular > 0 && converted >= totalRegular) {
      updateStage(today, 'conversion', {
        status: 'completed',
        endTime: new Date().toISOString(),
        message: `${converted} file(s) converted`,
      });
      updateStage(today, 'qualityCheck', {
        status: 'completed',
        endTime: new Date().toISOString(),
        message: `${qualityPassed} passed · ${qualityFailed} failed`,
      });
      addActivityLog('success', 'All conversions complete — quality check done', {
        converted,
        qualityPassed,
        qualityFailed,
      });
    } else {
      updateStage(today, 'qualityCheck', {
        message: `${qualityPassed} passed · ${qualityFailed} failed (${converted}/${totalRegular || '?'} converted)`,
      });
    }
  }
}

function startWatcher() {
  getOrCreateTodaySession();

  // Ensure the folder exists so chokidar can watch it
  if (!fs.existsSync(watchDir)) fs.mkdirSync(watchDir, { recursive: true });

  logger.info(`Watching for converted files: ${watchDir}`);
  addActivityLog('info', 'Conversion watcher started', { watchDir });

  const watcher = chokidar.watch(watchDir, {
    ignored: /(^|[/\\])\../,
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: SETTLE_DELAY_MS, pollInterval: 500 },
  });

  watcher
    .on('add', (filePath) => {
      if (/\.(docx|doc)$/i.test(filePath)) {
        // Debounce rapid events for the same file
        if (debounceMap.has(filePath)) clearTimeout(debounceMap.get(filePath));
        debounceMap.set(
          filePath,
          setTimeout(() => {
            debounceMap.delete(filePath);
            handleNewFile(filePath).catch((err) => logger.error(`Error handling ${filePath}: ${err.message}`));
          }, 1000)
        );
      }
    })
    .on('error', (err) => logger.error(`Watcher error: ${err.message}`));

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Conversion watcher stopped');
    watcher.close();
    process.exit(0);
  });
}

startWatcher();
