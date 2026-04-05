'use strict';
/**
 * After-Ligature-Fix Watcher
 *
 * Watches the <date>/afterLigatureFix/ folder.
 * When the operator places converted + ligature-fixed DOCX/DOC files here,
 * the dashboard stage "After Ligature Fix" is automatically marked completed.
 *
 * Run via dashboard button or:
 *   node scripts/watch-after-ligature.js
 */

const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const {
  getTodayDate,
  getOrCreateTodaySession,
  getTodaySession,
  updateStage,
  updateStats,
  upsertFile,
  addActivityLog,
} = require('../utils/state-manager');
const logger = require('../utils/logger');

const today = getTodayDate();
const watchDir = config.paths.afterLigatureFix;

function handleFile(filePath) {
  const fileName = path.basename(filePath);
  logger.info(`After-ligature file detected: ${fileName}`);
  addActivityLog('info', `After-ligature file placed: ${fileName}`, { path: filePath });

  // Mark stage running on first file
  const session = getTodaySession();
  if (session && session.stages.afterLigatureFix.status === 'pending') {
    updateStage(today, 'afterLigatureFix', {
      status: 'running',
      startTime: new Date().toISOString(),
      message: 'Files being placed in afterLigatureFix…',
    });
  }

  // Match back to the original PDF name (strip .docx/.doc extension)
  const pdfName = fileName.replace(/\.(docx|doc)$/i, '.pdf');
  upsertFile(today, {
    name: pdfName,
    afterLigatureFixStatus: 'completed',
    afterLigatureFixPath: filePath,
    afterLigatureFixAt: new Date().toISOString(),
  });

  addActivityLog('success', `After-ligature fix recorded: ${fileName}`);

  // Count all DOCX/DOC files now in the folder
  const allFixed = fs.readdirSync(watchDir).filter((f) => /\.(docx|doc)$/i.test(f));
  const session2 = getTodaySession();
  const totalRegular = session2 ? session2.stats.regularPdfs || 0 : 0;

  updateStats(today, { afterLigatureFixCount: allFixed.length });

  // Mark complete when count matches expected (or after settle — always update)
  const msg = `${allFixed.length} file(s) placed` +
    (totalRegular > 0 ? ` of ${totalRegular} expected` : '');

  updateStage(today, 'afterLigatureFix', {
    status: allFixed.length > 0 ? 'completed' : 'running',
    endTime: allFixed.length > 0 ? new Date().toISOString() : null,
    message: msg,
  });

  if (allFixed.length > 0) {
    addActivityLog('success', `After Ligature Fix stage complete — ${allFixed.length} file(s) ready`, {
      count: allFixed.length,
    });
  }
}

function startWatcher() {
  getOrCreateTodaySession();

  if (!fs.existsSync(watchDir)) fs.mkdirSync(watchDir, { recursive: true });

  logger.info(`Watching afterLigatureFix folder: ${watchDir}`);
  addActivityLog('info', 'After-Ligature-Fix watcher started', { watchDir });

  const watcher = chokidar.watch(watchDir, {
    ignored: /(^|[/\\])\../,
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 },
  });

  watcher
    .on('add', (filePath) => {
      if (/\.(docx|doc)$/i.test(filePath)) {
        handleFile(filePath);
      }
    })
    .on('error', (err) => logger.error(`Watcher error: ${err.message}`));

  process.on('SIGINT', () => {
    logger.info('After-Ligature-Fix watcher stopped');
    watcher.close();
    process.exit(0);
  });
}

startWatcher();
