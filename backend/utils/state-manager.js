'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOGS_FILE = path.join(DATA_DIR, 'activity-logs.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

function getState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    const initial = { sessions: [] };
    fs.writeFileSync(STATE_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { sessions: [] };
  }
}

function saveState(state) {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getTodaySession() {
  const state = getState();
  return state.sessions.find((s) => s.date === getTodayDate()) || null;
}

function getOrCreateTodaySession() {
  const today = getTodayDate();
  const state = getState();
  let session = state.sessions.find((s) => s.date === today);

  if (!session) {
    session = {
      id: `session-${today}`,
      date: today,
      createdAt: new Date().toISOString(),
      overallStatus: 'in_progress',
      stages: {
        download:        { status: 'pending', startTime: null, endTime: null, message: 'Waiting to start' },
        classification:  { status: 'pending', startTime: null, endTime: null, message: '' },
        splitAdmin:      { status: 'pending', startTime: null, endTime: null, message: 'Split regular PDFs into admin_1 / admin_2 / admin_3' },
        afterLigatureFix: {
          status: 'pending', startTime: null, endTime: null,
          message: 'Manual — Adobe conversion + ligature fix → place files in afterLigatureFix/',
        },
        moveToFinal:     { status: 'pending', startTime: null, endTime: null, message: '' },
        notification:    { status: 'pending', startTime: null, endTime: null, message: '' },
      },
      stats: {
        totalPdfs: 0,
        scannedPdfs: 0,
        regularPdfs: 0,
        corruptedPdfs: 0,
        totalPages: 0,
        afterLigatureFixCount: 0,
        finalCount: 0,
        adminSplitCount: 0,
      },
      files: [],
      reportPath: null,
    };
    state.sessions.push(session);
    saveState(state);
  }

  return session;
}

function updateStage(date, stageName, updates) {
  const state = getState();
  const session = state.sessions.find((s) => s.date === date);
  if (!session) return null;
  session.stages[stageName] = { ...session.stages[stageName], ...updates };
  saveState(state);
  return session;
}

function updateStats(date, statsUpdate) {
  const state = getState();
  const session = state.sessions.find((s) => s.date === date);
  if (!session) return null;
  session.stats = { ...session.stats, ...statsUpdate };
  saveState(state);
  return session;
}

function upsertFile(date, fileRecord) {
  const state = getState();
  const session = state.sessions.find((s) => s.date === date);
  if (!session) return null;
  const idx = session.files.findIndex((f) => f.name === fileRecord.name);
  if (idx >= 0) {
    session.files[idx] = { ...session.files[idx], ...fileRecord };
  } else {
    session.files.push(fileRecord);
  }
  saveState(state);
  return session;
}

function updateFile(date, fileName, updates) {
  const state = getState();
  const session = state.sessions.find((s) => s.date === date);
  if (!session) return null;
  const idx = session.files.findIndex((f) => f.name === fileName);
  if (idx >= 0) session.files[idx] = { ...session.files[idx], ...updates };
  saveState(state);
  return session;
}

function addActivityLog(type, message, details = {}) {
  ensureDataDir();
  let logs = [];
  if (fs.existsSync(LOGS_FILE)) {
    try {
      logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
    } catch {}
  }
  logs.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    type, // 'info' | 'success' | 'warning' | 'error'
    message,
    details,
  });
  if (logs.length > 500) logs.splice(500);
  fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2));
}

function getActivityLogs(limit = 100) {
  ensureDataDir();
  if (!fs.existsSync(LOGS_FILE)) return [];
  try {
    const logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
    return logs.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Completely wipe today's session and activity logs so the pipeline
 * can be re-run from scratch. Returns the fresh empty session.
 */
function resetTodaySession() {
  const today = getTodayDate();

  // Remove today's session from state
  const state = getState();
  state.sessions = state.sessions.filter((s) => s.date !== today);
  saveState(state);

  // Trim activity logs — keep only entries NOT from today
  ensureDataDir();
  if (fs.existsSync(LOGS_FILE)) {
    try {
      const logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
      const kept = logs.filter((l) => !l.timestamp.startsWith(today));
      fs.writeFileSync(LOGS_FILE, JSON.stringify(kept, null, 2));
    } catch {}
  }

  // Create fresh session
  return getOrCreateTodaySession();
}

module.exports = {
  getTodayDate,
  getState,
  saveState,
  getTodaySession,
  getOrCreateTodaySession,
  resetTodaySession,
  updateStage,
  updateStats,
  upsertFile,
  updateFile,
  addActivityLog,
  getActivityLogs,
};
