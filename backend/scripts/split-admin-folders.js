'use strict';
/**
 * Split Admin Folders — distributes regular (digital) PDFs from
 * output-with-datetime/ into three equal-page-count admin subfolders:
 *   output-with-datetime/admin_1/
 *   output-with-datetime/admin_2/
 *   output-with-datetime/admin_3/
 *
 * Algorithm: greedy min-bucket assignment (largest-page files first)
 * Guarantee: each bucket gets the next file assigned to whichever has
 * the smallest running page total → minimises the max-min spread.
 *
 * Re-run safe: searches both the root output dir AND existing admin_X
 * subdirectories so files already split are relocated correctly.
 */

const fs   = require('fs');
const path = require('path');

const config = require('../config');
const {
  getTodayDate,
  getTodaySession,
  updateStage,
  updateStats,
  updateFile,
  addActivityLog,
} = require('../utils/state-manager');
const logger = require('../utils/logger');

const NUM_BUCKETS = 3;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Copy + delete — avoids Windows 8.3-alias renameSync failures */
function moveFile(src, dest) {
  fs.copyFileSync(src, dest);
  fs.unlinkSync(src);
}

/**
 * Locate a PDF by name inside `root` and its immediate admin_X subdirectories.
 * Returns the full path if found, or null.
 */
function findFile(name, root) {
  // Check root
  const rootPath = path.join(root, name);
  if (fs.existsSync(rootPath)) return rootPath;

  // Check admin_1, admin_2, admin_3 subdirs
  for (let i = 1; i <= NUM_BUCKETS; i++) {
    const sub = path.join(root, `admin_${i}`, name);
    if (fs.existsSync(sub)) return sub;
  }
  return null;
}

/**
 * Greedy balanced partition into NUM_BUCKETS groups.
 * Input: array of { name, pages, localPath }
 * Output: array of NUM_BUCKETS arrays of file objects.
 */
function greedySplit(files) {
  // Sort descending by pages so greedy gives the tightest balance
  const sorted = [...files].sort((a, b) => b.pages - a.pages);

  const buckets = Array.from({ length: NUM_BUCKETS }, () => ({
    files: [],
    total: 0,
  }));

  for (const file of sorted) {
    // Assign to the bucket with the smallest running total
    const target = buckets.reduce((min, b) => (b.total < min.total ? b : min));
    target.files.push(file);
    target.total += file.pages || 0;
  }

  return buckets;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const today = getTodayDate();

  // Pre-compute paths once
  const outputRoot = config.paths.outputWithDatetime;

  logger.info('── SPLIT ADMIN FOLDERS ──────────────────────────────────────────────');

  updateStage(today, 'splitAdmin', {
    status:    'running',
    startTime: new Date().toISOString(),
    message:   'Distributing PDFs into admin_1 / admin_2 / admin_3 by page count…',
  });
  addActivityLog('info', 'Admin folder split started', { date: today });

  // ── 1. Get today's regular (digital) PDF files from state ─────────────────
  const session = getTodaySession();
  if (!session) {
    const msg = 'No session found for today. Run SFTP Download first.';
    logger.error(msg);
    updateStage(today, 'splitAdmin', { status: 'failed', endTime: new Date().toISOString(), message: msg });
    addActivityLog('error', msg);
    process.exit(1);
  }

  const regularFiles = (session.files || []).filter(
    (f) => f.category === 'regular' && f.downloadStatus === 'completed'
  );

  if (regularFiles.length === 0) {
    const msg = 'No regular (digital) PDFs found in today\'s session. Classification may not have run yet.';
    logger.warn(msg);
    updateStage(today, 'splitAdmin', { status: 'failed', endTime: new Date().toISOString(), message: msg });
    addActivityLog('warning', msg);
    process.exit(1);
  }

  logger.info(`${regularFiles.length} regular PDF(s) found in session — resolving disk paths…`);

  // ── 2. Resolve each file's current on-disk path ───────────────────────────
  const resolved = [];
  for (const f of regularFiles) {
    const diskPath = findFile(f.name, outputRoot);
    if (!diskPath) {
      logger.warn(`File not found on disk, skipping: ${f.name}`);
      addActivityLog('warning', `Split skipped (not on disk): ${f.name}`, {});
      continue;
    }
    resolved.push({ name: f.name, pages: f.pages || 0, localPath: diskPath });
  }

  if (resolved.length === 0) {
    const msg = 'No files found on disk in output-with-datetime/. Cannot split.';
    logger.error(msg);
    updateStage(today, 'splitAdmin', { status: 'failed', endTime: new Date().toISOString(), message: msg });
    addActivityLog('error', msg);
    process.exit(1);
  }

  // ── 3. Greedy split by page count ─────────────────────────────────────────
  const buckets = greedySplit(resolved);

  logger.info('Bucket assignment (greedy min-pages):');
  buckets.forEach((b, i) =>
    logger.info(`  admin_${i + 1}: ${b.files.length} file(s), ${b.total} pages — [${b.files.map(f => f.name).join(', ')}]`)
  );

  // ── 4. Create admin dirs & move files ─────────────────────────────────────
  let movedCount  = 0;
  let errorCount  = 0;

  for (let i = 0; i < buckets.length; i++) {
    const bucket    = buckets[i];
    const adminDir  = path.join(outputRoot, `admin_${i + 1}`);
    const adminName = `admin_${i + 1}`;

    fs.mkdirSync(adminDir, { recursive: true });

    for (const file of bucket.files) {
      const destPath = path.join(adminDir, file.name);
      try {
        // Skip if already in the correct location
        if (file.localPath === destPath) {
          logger.info(`Already in place: ${file.name} → ${adminName}`);
        } else {
          moveFile(file.localPath, destPath);
          logger.info(`Moved: ${file.name} → ${adminName}/`);
        }

        // Update state record
        updateFile(today, file.name, {
          adminFolder: adminName,
          localPath:   destPath,
        });

        addActivityLog('success', `Split → ${adminName}: ${file.name}`, {
          pages:       file.pages,
          adminFolder: adminName,
        });

        movedCount++;
      } catch (err) {
        errorCount++;
        logger.error(`Failed to move "${file.name}" → ${adminName}: ${err.message}`);
        addActivityLog('error', `Split failed: ${file.name}`, { error: err.message });
      }
    }
  }

  // ── 5. Build summary & update stats/stage ─────────────────────────────────
  const summary = buckets
    .map((b, i) => `admin_${i + 1}: ${b.files.length} file(s) / ${b.total} pages`)
    .join(' · ');

  const pageTotals = buckets.map((b) => b.total);
  const spread     = Math.max(...pageTotals) - Math.min(...pageTotals);

  updateStats(today, { adminSplitCount: movedCount });

  updateStage(today, 'splitAdmin', {
    status:  errorCount === 0 ? 'completed' : (movedCount > 0 ? 'completed' : 'failed'),
    endTime: new Date().toISOString(),
    message: `${summary} · page spread: ${spread}` +
             (errorCount > 0 ? ` · ${errorCount} error(s)` : ''),
  });

  addActivityLog(
    errorCount === 0 ? 'success' : 'warning',
    `Admin split complete — ${movedCount} file(s) distributed (page spread: ${spread})`,
    { buckets: buckets.map((b, i) => ({ folder: `admin_${i + 1}`, files: b.files.length, pages: b.total })) }
  );

  logger.info(
    `Split complete — moved: ${movedCount}, errors: ${errorCount}, page spread: ${spread}`
  );
  logger.info(`  Page distribution: ${pageTotals.join(' / ')} pages`);
}

run();
