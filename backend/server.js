'use strict';
/**
 * PDF-DOC Conversion Dashboard — Express API Server
 *
 * Exposes REST endpoints consumed by the Angular dashboard.
 * Triggers automation scripts via child_process.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const config = require('./config');
const {
  getState,
  getTodayDate,
  getTodaySession,
  getOrCreateTodaySession,
  resetTodaySession,
  getActivityLogs,
  addActivityLog,
} = require('./utils/state-manager');
const logger = require('./utils/logger');

const app = express();

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Helpers ────────────────────────────────────────────────────────────────
function runScript(scriptName, res, actionLabel) {
  const scriptPath = path.join(__dirname, 'scripts', scriptName);
  logger.info(`Spawning script: ${scriptName}`);
  addActivityLog('info', `Manual trigger: ${actionLabel}`, { script: scriptName });

  // Respond immediately — script runs in background
  res.json({ ok: true, message: `${actionLabel} triggered` });

  const child = spawn(process.execPath, [scriptPath], {
    cwd: __dirname,
    stdio: 'pipe',
    detached: false,
  });

  child.stdout.on('data', (d) => logger.info(`[${scriptName}] ${d.toString().trim()}`));
  child.stderr.on('data', (d) => logger.warn(`[${scriptName}] ${d.toString().trim()}`));
  child.on('exit', (code) => {
    if (code !== 0) {
      logger.error(`Script ${scriptName} exited with code ${code}`);
      addActivityLog('error', `Script exited with code ${code}`, { script: scriptName });
    }
  });
}

// ── Routes ─────────────────────────────────────────────────────────────────

// GET /api/health
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), version: '1.0.0' });
});

// GET /api/config  — sanitised (no passwords)
app.get('/api/config', (_req, res) => {
  res.json({
    title: config.server.title,
    org: config.server.org,
    sftp: { host: config.sftp.host, port: config.sftp.port, username: config.sftp.username },
    paths: {
      base: config.paths.base,
      dateFolder: config.paths.dateFolder,
      scannedPdf: config.paths.scannedPdf,
      outputWithDatetime: config.paths.outputWithDatetime,
      convertedRaw: config.paths.convertedRaw,
      finalConversion: config.paths.finalConversion,
    },
    emailTo: config.email.to,
  });
});

// GET /api/dashboard  — single endpoint for the Angular dashboard (polled every 15 s)
app.get('/api/dashboard', (_req, res) => {
  const session = getTodaySession() || getOrCreateTodaySession();
  const logs = getActivityLogs(100);
  const allSessions = getState().sessions.map((s) => ({
    id: s.id,
    date: s.date,
    overallStatus: s.overallStatus,
    stats: s.stats,
    createdAt: s.createdAt,
  }));

  res.json({
    today: getTodayDate(),
    session,
    logs,
    history: allSessions,
    serverTime: new Date().toISOString(),
  });
});

// GET /api/session/today
app.get('/api/session/today', (_req, res) => {
  const session = getTodaySession() || getOrCreateTodaySession();
  res.json(session);
});

// GET /api/sessions  — history list
app.get('/api/sessions', (_req, res) => {
  const state = getState();
  res.json(state.sessions.map((s) => ({ ...s, files: undefined })).reverse());
});

// GET /api/sessions/:date  — session detail
app.get('/api/sessions/:date', (req, res) => {
  const state = getState();
  const session = state.sessions.find((s) => s.date === req.params.date);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// GET /api/files  — today's files
app.get('/api/files', (_req, res) => {
  const session = getTodaySession();
  res.json(session ? session.files : []);
});

// GET /api/logs  — activity log
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit || '100');
  res.json(getActivityLogs(limit));
});

// POST /api/trigger/download  — Step 1
app.post('/api/trigger/download', (req, res) => {
  runScript('sftp-download.js', res, 'SFTP Download');
});

// POST /api/trigger/move-final  — Step 3 (manual)
app.post('/api/trigger/move-final', (req, res) => {
  runScript('move-to-final.js', res, 'Move to Final');
});

// POST /api/trigger/notify  — Step 4 (manual retry or re-send)
app.post('/api/trigger/notify', (req, res) => {
  runScript('send-notification.js', res, 'Email Notification');
});

// POST /api/trigger/split-admin  — split regular PDFs into admin_1/2/3 by page count
app.post('/api/trigger/split-admin', (_req, res) => {
  runScript('split-admin-folders.js', res, 'Split Admin Folders');
});

// POST /api/trigger/watch-after-ligature  — watch afterLigatureFix folder
app.post('/api/trigger/watch-after-ligature', (req, res) => {
  runScript('watch-after-ligature.js', res, 'After-Ligature-Fix Watcher');
});

// POST /api/trigger/rerun  — reset today's session and start fresh
app.post('/api/trigger/rerun', (_req, res) => {
  try {
    const fresh = resetTodaySession();
    addActivityLog('warning', 'Pipeline re-run triggered — session reset', {});
    logger.info('Session reset for re-run');
    res.json({ ok: true, message: 'Session reset — pipeline ready to re-run', session: fresh });
  } catch (err) {
    logger.error(`Rerun reset failed: ${err.message}`);
    res.status(500).json({ ok: false, message: err.message });
  }
});

// GET /api/downloads/:filename  — stream a zip from the reports folder (oversized attachments)
app.get('/api/downloads/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // sanitise — strip any path traversal
  const filePath = path.join(config.paths.reports, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.download(filePath, filename);
});

// GET /api/report/download  — stream the latest Excel report
app.get('/api/report/download', (_req, res) => {
  const reportsDir = config.paths.reports;
  if (!fs.existsSync(reportsDir)) {
    return res.status(404).json({ error: 'No reports available yet' });
  }
  const files = fs
    .readdirSync(reportsDir)
    .filter((f) => f.endsWith('.xlsx'))
    .sort()
    .reverse();
  if (files.length === 0) return res.status(404).json({ error: 'No Excel report found' });
  const filePath = path.join(reportsDir, files[0]);
  res.download(filePath, files[0]);
});

// GET /api/folder-status  — check existence of key local folders
app.get('/api/folder-status', (_req, res) => {
  const folders = {
    dateFolder:          config.paths.dateFolder,
    scannedPdf:          config.paths.scannedPdf,
    corruptedPdf:        config.paths.corruptedPdf,
    outputWithDatetime:  config.paths.outputWithDatetime,
    admin1:              config.paths.admin1,
    admin2:              config.paths.admin2,
    admin3:              config.paths.admin3,
    afterLigatureFix:    config.paths.afterLigatureFix,
    finalConversion:     config.paths.finalConversion,
    reports:             config.paths.reports,
  };
  const result = {};
  for (const [key, dir] of Object.entries(folders)) {
    const exists = fs.existsSync(dir);
    let fileCount = 0;
    if (exists) {
      try {
        fileCount = fs.readdirSync(dir).length;
      } catch {}
    }
    result[key] = { path: dir, exists, fileCount };
  }
  res.json(result);
});

// ── Start server ───────────────────────────────────────────────────────────
const PORT = config.server.port;
app.listen(PORT, () => {
  logger.info(`PDF-DOC Dashboard API running on http://localhost:${PORT}`);
  logger.info(`Dashboard: http://localhost:4200`);
  addActivityLog('info', 'API server started', { port: PORT });
});
