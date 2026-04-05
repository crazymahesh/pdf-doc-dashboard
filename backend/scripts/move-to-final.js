'use strict';
/**
 * Move to Final + SFTP Upload
 *
 * PHASE 1 · LOCAL MOVE
 *   Moves all DOCX/DOC files from afterLigatureFix/ → final_conversion/.
 *   Uses copyFileSync + unlinkSync (safe on Windows paths).
 *
 * PHASE 2 · SFTP UPLOAD
 *   Uploads every file in final_conversion/ to the SFTP server under
 *   Output_Converted_Doc/<today>/ so stakeholders can retrieve them directly.
 *
 * PHASE 3 · REPORT + NOTIFY
 *   Regenerates Excel report, then auto-triggers email notification.
 *
 * Triggered via dashboard button → POST /api/trigger/move-final
 * or:  node scripts/move-to-final.js
 */

const fs         = require('fs');
const path       = require('path');
const SftpClient = require('ssh2-sftp-client');

const config = require('../config');
const { generateReport } = require('../utils/excel-reporter');
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

function moveFile(src, dest) {
  fs.copyFileSync(src, dest);
  fs.unlinkSync(src);
}

// ─── SFTP Upload ──────────────────────────────────────────────────────────────

/**
 * Ensure a remote path exists on the SFTP server, creating each segment
 * recursively if needed.  ssh2-sftp-client's mkdir throws if the dir already
 * exists, so we check first.
 */
async function ensureRemoteDir(sftp, remotePath) {
  const parts = remotePath.replace(/^\//, '').split('/');
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    try {
      const stat = await sftp.stat(current).catch(() => null);
      if (!stat) {
        await sftp.mkdir(current, false); // false = non-recursive (we walk manually)
      }
    } catch {
      // Already exists or permission not needed — continue
    }
  }
}

/**
 * Upload all files from a local directory to a remote SFTP path.
 * Returns { uploaded, failed } counts.
 */
async function uploadToSftp(localDir, remotePath) {
  const sftp = new SftpClient();
  let uploaded = 0;
  let failed   = 0;

  const files = fs.readdirSync(localDir).filter((f) => /\.(docx|doc)$/i.test(f));

  if (files.length === 0) {
    logger.warn('No DOCX/DOC files in final_conversion to upload');
    return { uploaded: 0, failed: 0 };
  }

  logger.info(`Connecting to SFTP for upload: ${config.sftp.host}:${config.sftp.port}`);
  await sftp.connect({
    host:         config.sftp.host,
    port:         config.sftp.port,
    username:     config.sftp.username,
    password:     config.sftp.password,
    readyTimeout: 20000,
  });
  addActivityLog('success', `SFTP connected for upload: ${config.sftp.host}`, { remotePath });

  // Create remote directory if it doesn't exist
  await ensureRemoteDir(sftp, remotePath);
  logger.info(`Remote directory ready: ${remotePath}`);

  for (let i = 0; i < files.length; i++) {
    const fileName   = files[i];
    const localPath  = path.join(localDir, fileName);
    const remoteDest = `${remotePath}/${fileName}`;
    const progress   = `[${i + 1}/${files.length}]`;

    try {
      logger.info(`${progress} Uploading: ${fileName} → ${remoteDest}`);
      await sftp.put(localPath, remoteDest);
      uploaded++;
      addActivityLog('success', `${progress} Uploaded to SFTP: ${fileName}`, { remoteDest });
      logger.info(`${progress} ✓ Uploaded: ${fileName}`);
    } catch (err) {
      failed++;
      logger.error(`${progress} Upload failed: "${fileName}": ${err.message}`);
      addActivityLog('error', `Upload failed: ${fileName}`, { error: err.message });
    }
  }

  try { await sftp.end(); } catch {}
  return { uploaded, failed };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  getOrCreateTodaySession();

  // Pre-compute paths once
  const srcDir        = config.paths.afterLigatureFix;
  const destDir       = config.paths.finalConversion;
  const outputRemote  = config.sftp.outputRemotePath; // /Output_Converted_Doc/<today>

  // ── PHASE 1: Local Move ───────────────────────────────────────────────────
  logger.info('── PHASE 1: LOCAL MOVE ──────────────────────────────────────────────');

  if (!fs.existsSync(srcDir)) {
    const msg = `afterLigatureFix folder not found: ${srcDir}`;
    logger.warn(msg);
    addActivityLog('warning', msg);
    process.exit(0);
  }

  const filesToMove = fs.readdirSync(srcDir).filter((f) => /\.(docx|doc)$/i.test(f));

  if (filesToMove.length === 0) {
    logger.warn('No DOCX/DOC files in afterLigatureFix — nothing to move');
    addActivityLog('warning', 'No files found in afterLigatureFix folder');
    process.exit(0);
  }

  fs.mkdirSync(destDir, { recursive: true });

  updateStage(today, 'moveToFinal', {
    status:    'running',
    startTime: new Date().toISOString(),
    message:   `Moving ${filesToMove.length} file(s) to final_conversion…`,
  });
  addActivityLog('info', `Moving ${filesToMove.length} file(s) to final_conversion`, { count: filesToMove.length });

  let movedCount = 0;

  for (const fileName of filesToMove) {
    const srcPath  = path.join(srcDir, fileName);
    const destPath = path.join(destDir, fileName);
    const pdfName  = fileName.replace(/\.(docx|doc)$/i, '.pdf');

    try {
      moveFile(srcPath, destPath);
      movedCount++;

      upsertFile(today, {
        name:        pdfName,
        finalStatus: 'completed',
        finalPath:   destPath,
        movedAt:     new Date().toISOString(),
      });

      addActivityLog('success', `Moved to final_conversion: ${fileName}`);
      logger.info(`Moved: ${fileName} → ${destPath}`);
    } catch (err) {
      logger.error(`Failed to move "${fileName}": ${err.message}`);
      addActivityLog('error', `Move failed: ${fileName}`, { error: err.message });
    }
  }

  updateStats(today, { finalCount: movedCount });

  addActivityLog(
    movedCount === filesToMove.length ? 'success' : 'warning',
    `Local move complete — ${movedCount}/${filesToMove.length} files moved to final_conversion`
  );

  if (movedCount === 0) {
    updateStage(today, 'moveToFinal', {
      status:  'failed',
      endTime: new Date().toISOString(),
      message: 'No files could be moved',
    });
    process.exit(1);
  }

  // ── PHASE 2: SFTP Upload ──────────────────────────────────────────────────
  logger.info('── PHASE 2: SFTP UPLOAD ─────────────────────────────────────────────');
  updateStage(today, 'moveToFinal', {
    message: `Uploading ${movedCount} file(s) to SFTP: ${outputRemote}…`,
  });
  addActivityLog('info', `Starting SFTP upload → ${outputRemote}`, {
    host: config.sftp.host, remotePath: outputRemote,
  });

  let uploadedCount = 0;
  let uploadFailed  = 0;

  try {
    const result  = await uploadToSftp(destDir, outputRemote);
    uploadedCount = result.uploaded;
    uploadFailed  = result.failed;

    addActivityLog(
      uploadFailed === 0 ? 'success' : 'warning',
      `SFTP upload complete — ${uploadedCount} uploaded, ${uploadFailed} failed`,
      { remotePath: outputRemote }
    );
    logger.info(`SFTP upload done — uploaded: ${uploadedCount}, failed: ${uploadFailed}`);
  } catch (sftpErr) {
    uploadFailed = movedCount;
    logger.error(`SFTP upload phase failed: ${sftpErr.message}`, { stack: sftpErr.stack });
    addActivityLog('error', 'SFTP upload failed', { error: sftpErr.message });
    // Non-fatal — continue to report & notify
  }

  // Mark moveToFinal completed (upload status included in message)
  const uploadNote = uploadFailed === 0
    ? `· uploaded ${uploadedCount} to Output_Converted_Doc`
    : `· SFTP upload: ${uploadedCount} ok / ${uploadFailed} failed`;

  updateStage(today, 'moveToFinal', {
    status:  'completed',
    endTime: new Date().toISOString(),
    message: `${movedCount} file(s) moved ${uploadNote}`,
  });

  // ── PHASE 3: Excel Report + Notification ──────────────────────────────────
  logger.info('── PHASE 3: REPORT & NOTIFY ─────────────────────────────────────────');

  const updatedSession = getTodaySession();
  if (updatedSession && updatedSession.files.length > 0) {
    try {
      const reportPath = await generateReport(updatedSession.files, config.paths.reports, today);
      logger.info(`Excel report updated: ${reportPath}`);
      addActivityLog('info', 'Excel report updated with final status');
    } catch (err) {
      logger.warn(`Report update failed (non-fatal): ${err.message}`);
    }
  }

  logger.info('Triggering email notification…');
  require('./send-notification');
}

run().catch((err) => {
  logger.error(`move-to-final failed: ${err.message}`, { stack: err.stack });
  addActivityLog('error', 'Move-to-final failed', { error: err.message });
  process.exit(1);
});
