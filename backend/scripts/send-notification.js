'use strict';
/**
 * Step 4 – Email Notification
 *
 * Attaches converted DOC/DOCX files from final_conversion/ to the email.
 * Size strategy:
 *   • Always zips the final files into a single ZIP archive.
 *   • If ZIP ≤ 25 MB  → attaches ZIP directly (+ Excel report).
 *   • If ZIP > 25 MB  → saves ZIP to reports/ folder, embeds a download
 *     link button in the email body instead of attaching the ZIP.
 *     Recipients click the link to fetch it from the local Express server.
 *
 * Triggered automatically by move-to-final.js, or manually via:
 *   node scripts/send-notification.js
 * or via the dashboard UI → POST /api/trigger/notify
 */

const nodemailer = require('nodemailer');
const archiver   = require('archiver');
const path       = require('path');
const fs         = require('fs');

const config = require('../config');
const {
  getTodayDate,
  getTodaySession,
  getOrCreateTodaySession,
  updateStage,
  addActivityLog,
} = require('../utils/state-manager');
const logger = require('../utils/logger');

const today = getTodayDate();

const MB               = 1024 * 1024;
const ATTACH_LIMIT_MB  = 25;           // Gmail hard limit
const ATTACH_LIMIT     = ATTACH_LIMIT_MB * MB;

// ── Zip helper ────────────────────────────────────────────────────────────────

/**
 * Creates a ZIP archive from an array of file paths.
 * Returns a Promise that resolves to the output zip path.
 */
function createZip(filePaths, outputZipPath) {
  return new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(outputZipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', () => resolve(outputZipPath));
    archive.on('error', reject);

    archive.pipe(output);
    for (const fp of filePaths) {
      archive.file(fp, { name: path.basename(fp) });
    }
    archive.finalize();
  });
}

/**
 * Returns total size in bytes for a list of file paths.
 * Missing files are skipped.
 */
function totalSizeBytes(filePaths) {
  return filePaths.reduce((sum, fp) => {
    try { return sum + fs.statSync(fp).size; } catch { return sum; }
  }, 0);
}

function stageColor(status) {
  return status === 'completed' ? '#065F46'
       : status === 'failed'    ? '#991B1B'
       : status === 'running'   ? '#1E40AF'
       : '#6B7280';
}

function stageBg(status) {
  return status === 'completed' ? '#D1FAE5'
       : status === 'failed'    ? '#FEE2E2'
       : status === 'running'   ? '#DBEAFE'
       : '#F3F4F6';
}

function buildHtml(session, downloadInfo = null) {
  const { stats, stages, date, files } = session;

  const stageRows = [
    ['SFTP Download',                   stages.download],
    ['PDF Classification',              stages.classification],
    ['Split Admin Folders',             stages.splitAdmin],
    ['Convert + Ligature Fix (Manual)', stages.afterLigatureFix],
    ['Move to Final + SFTP Upload',     stages.moveToFinal],
    ['Email Notification',              stages.notification],
  ]
    .map(([label, s]) => {
      // Guard: stage may not exist on older sessions
      const status  = s ? s.status  : 'pending';
      const message = s ? s.message : '';
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #E5E7EB;">${label}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #E5E7EB;">
          <span style="background:${stageBg(status)};color:${stageColor(status)};padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600;">
            ${status.toUpperCase()}
          </span>
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #E5E7EB;color:#6B7280;font-size:13px;">${message}</td>
      </tr>`;
    })
    .join('');

  const fileRows = files
    .slice(0, 20)
    .map(
      (f) => `<tr style="background:${f.isScanned ? '#FFFBEB' : '#FFFFFF'}">
      <td style="padding:6px 10px;border-bottom:1px solid #E5E7EB;font-size:13px;">${f.name}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #E5E7EB;font-size:13px;text-align:center;">${f.pages || 0}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #E5E7EB;font-size:13px;text-align:center;">
        <span style="color:${f.isScanned ? '#92400E' : '#065F46'}">${f.isScanned ? 'Yes' : 'No'}</span>
      </td>
      <td style="padding:6px 10px;border-bottom:1px solid #E5E7EB;font-size:13px;text-align:center;">
        <span style="color:${f.adminFolder ? '#065F46' : '#6B7280'}">
          ${f.adminFolder || (f.isScanned ? '—' : 'pending')}
        </span>
      </td>
      <td style="padding:6px 10px;border-bottom:1px solid #E5E7EB;font-size:13px;text-align:center;">
        <span style="color:${f.afterLigatureFixStatus === 'completed' ? '#065F46' : f.afterLigatureFixStatus === 'failed' ? '#991B1B' : '#6B7280'}">
          ${f.afterLigatureFixStatus || 'pending'}
        </span>
      </td>
    </tr>`
    )
    .join('');

  const moreFiles = files.length > 20
    ? `<p style="color:#6B7280;font-size:13px;">…and ${files.length - 20} more files (see attached report)</p>`
    : '';

  // Download-link block — shown when ZIP exceeds 25 MB and is served via HTTP
  const downloadBlock = downloadInfo
    ? `<div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
        <p style="margin:0 0 6px;font-weight:700;color:#1E40AF;font-size:14px;">
          📦 Converted files are too large to attach (${downloadInfo.sizeMb} MB)
        </p>
        <p style="margin:0 0 12px;color:#374151;font-size:13px;">
          The ZIP archive containing <strong>${downloadInfo.fileCount} converted file(s)</strong>
          is hosted on the dashboard server. Click the button below to download it.
          <em>The link is available as long as the dashboard server is running.</em>
        </p>
        <a href="${downloadInfo.url}" style="display:inline-block;background:#1A56DB;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px;">
          ⬇ Download ${downloadInfo.filename}
        </a>
        <p style="margin:10px 0 0;font-size:11px;color:#9CA3AF;">URL: ${downloadInfo.url}</p>
      </div>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;color:#111827;max-width:800px;margin:0 auto;padding:20px;">
    <div style="background:#1A56DB;color:#fff;padding:20px 30px;border-radius:8px 8px 0 0;">
      <h2 style="margin:0;font-size:20px;">${config.server.title}</h2>
      <p style="margin:6px 0 0;font-size:14px;opacity:0.85;">${config.server.org} · Processing Report: ${date}</p>
    </div>

    <div style="background:#fff;border:1px solid #E5E7EB;border-top:none;padding:24px;">
      ${downloadBlock}
      <h3 style="margin:0 0 16px;color:#1A56DB;">Summary Statistics</h3>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px;">
        ${[
          ['Total PDFs',        stats.totalPdfs,             '#1A56DB'],
          ['Scanned',           stats.scannedPdfs,           '#D97706'],
          ['After Ligature Fix',stats.afterLigatureFixCount, '#059669'],
          ['Final Count',       stats.finalCount,            '#7C3AED'],
        ]
          .map(
            ([label, val, color]) =>
              `<div style="border:1px solid #E5E7EB;border-top:3px solid ${color};padding:12px;border-radius:6px;text-align:center;">
            <div style="font-size:28px;font-weight:700;color:${color};">${val || 0}</div>
            <div style="font-size:12px;color:#6B7280;margin-top:4px;">${label}</div>
          </div>`
          )
          .join('')}
      </div>

      <h3 style="margin:0 0 12px;color:#1A56DB;">Pipeline Status</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <thead>
          <tr style="background:#F9FAFB;">
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#6B7280;border-bottom:2px solid #E5E7EB;">Stage</th>
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#6B7280;border-bottom:2px solid #E5E7EB;">Status</th>
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#6B7280;border-bottom:2px solid #E5E7EB;">Notes</th>
          </tr>
        </thead>
        <tbody>${stageRows}</tbody>
      </table>

      <h3 style="margin:0 0 12px;color:#1A56DB;">File Details</h3>
      <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
        <thead>
          <tr style="background:#F9FAFB;">
            <th style="padding:8px 10px;text-align:left;font-size:12px;color:#6B7280;border-bottom:2px solid #E5E7EB;">File Name</th>
            <th style="padding:8px 10px;text-align:center;font-size:12px;color:#6B7280;border-bottom:2px solid #E5E7EB;">Pages</th>
            <th style="padding:8px 10px;text-align:center;font-size:12px;color:#6B7280;border-bottom:2px solid #E5E7EB;">Scanned</th>
            <th style="padding:8px 10px;text-align:center;font-size:12px;color:#6B7280;border-bottom:2px solid #E5E7EB;">Admin Folder</th>
            <th style="padding:8px 10px;text-align:center;font-size:12px;color:#6B7280;border-bottom:2px solid #E5E7EB;">Ligature Fix</th>
          </tr>
        </thead>
        <tbody>${fileRows}</tbody>
      </table>
      ${moreFiles}
    </div>

    <div style="background:#F9FAFB;border:1px solid #E5E7EB;border-top:none;padding:14px 24px;border-radius:0 0 8px 8px;font-size:12px;color:#9CA3AF;">
      Generated by PDF-DOC Dashboard · ${new Date().toLocaleString()}
    </div>
  </body></html>`;
}

async function run() {
  getOrCreateTodaySession();
  const session = getTodaySession();

  if (!session) {
    logger.warn('No session found for today — skipping notification');
    process.exit(0);
  }

  if (!config.email.to) {
    logger.warn('EMAIL_TO not configured — skipping notification');
    addActivityLog('warning', 'Email notification skipped — EMAIL_TO not configured');
    process.exit(0);
  }

  updateStage(today, 'notification', {
    status: 'running',
    startTime: new Date().toISOString(),
    message: 'Sending email…',
  });
  addActivityLog('info', 'Sending email notification', { to: config.email.to });

  try {
    const transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      auth: config.email.auth.user ? config.email.auth : undefined,
    });

    const attachments  = [];
    let   downloadInfo = null;   // set when ZIP > 25 MB → embed link instead

    // ── 1. Excel report (always attach) ──────────────────────────────────────
    const reportsDir = config.paths.reports;
    if (fs.existsSync(reportsDir)) {
      const xlsxFiles = fs.readdirSync(reportsDir)
        .filter((f) => f.endsWith('.xlsx'))
        .sort().reverse();
      if (xlsxFiles.length > 0) {
        const xlsxPath = path.join(reportsDir, xlsxFiles[0]);
        attachments.push({ filename: xlsxFiles[0], path: xlsxPath });
        logger.info(`Attaching Excel report: ${xlsxFiles[0]}`);
      }
    }

    // ── 2. final_conversion DOC/DOCX files → always ZIP them ─────────────────
    const finalDir  = config.paths.finalConversion;
    let   zipInfo   = null;

    if (fs.existsSync(finalDir)) {
      const docFiles = fs.readdirSync(finalDir)
        .filter((f) => /\.(docx|doc)$/i.test(f))
        .map((f) => path.join(finalDir, f));

      if (docFiles.length > 0) {
        const zipFilename = `PDF-DOC-Files-${today}.zip`;
        const zipPath     = path.join(reportsDir, zipFilename);

        // Ensure reports dir exists before writing zip
        fs.mkdirSync(reportsDir, { recursive: true });

        logger.info(`Zipping ${docFiles.length} file(s) → ${zipPath}`);
        addActivityLog('info', `Zipping ${docFiles.length} final file(s)`, { count: docFiles.length });

        await createZip(docFiles, zipPath);

        const zipSize   = fs.statSync(zipPath).size;
        const zipSizeMb = (zipSize / MB).toFixed(1);
        logger.info(`ZIP created: ${zipFilename} (${zipSizeMb} MB)`);

        zipInfo = { path: zipPath, filename: zipFilename, sizeMb: zipSizeMb, fileCount: docFiles.length };

        if (zipSize <= ATTACH_LIMIT) {
          // ✅ Under 25 MB — attach the zip directly
          attachments.push({ filename: zipFilename, path: zipPath });
          logger.info(`ZIP under ${ATTACH_LIMIT_MB} MB — attaching directly`);
          addActivityLog('success', `ZIP attached (${zipSizeMb} MB)`, { filename: zipFilename });
        } else {
          // ⚠ Over 25 MB — serve via HTTP, embed download link in email
          const downloadUrl = `${config.server.publicUrl}/api/downloads/${encodeURIComponent(zipFilename)}`;
          downloadInfo = {
            url:       downloadUrl,
            filename:  zipFilename,
            sizeMb:    zipSizeMb,
            fileCount: docFiles.length,
          };
          logger.warn(`ZIP is ${zipSizeMb} MB (> ${ATTACH_LIMIT_MB} MB) — embedding download link: ${downloadUrl}`);
          addActivityLog('warning', `ZIP too large to attach (${zipSizeMb} MB) — link embedded in email`, { url: downloadUrl });
        }
      } else {
        logger.info('No DOC/DOCX files in final_conversion — skipping ZIP');
      }
    }

    // ── 3. Send ───────────────────────────────────────────────────────────────
    const normaliseRecipients = (str) =>
      (str || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean).join(', ');

    const toList = normaliseRecipients(config.email.to);
    const ccList = normaliseRecipients(config.email.cc) || undefined;

    const zipNote  = zipInfo
      ? (downloadInfo ? ` · ZIP link embedded (${zipInfo.sizeMb} MB)` : ` · ZIP attached (${zipInfo.sizeMb} MB)`)
      : '';
    const subject  = `[${config.server.org}] PDF-DOC Conversion Complete — ${today}`;

    await transporter.sendMail({
      from:        config.email.from,
      to:          toList,
      cc:          ccList,
      subject,
      html:        buildHtml(session, downloadInfo),
      attachments,
    });

    updateStage(today, 'notification', {
      status:  'completed',
      endTime: new Date().toISOString(),
      message: `Sent to ${toList} · ${attachments.length} attachment(s)${zipNote}`,
    });
    addActivityLog('success', 'Email notification sent', {
      to:          toList,
      attachments: attachments.length,
      zipNote,
    });
    logger.info(`Email sent to ${toList} | attachments: ${attachments.length}${zipNote}`);
  } catch (err) {
    updateStage(today, 'notification', {
      status: 'failed',
      endTime: new Date().toISOString(),
      message: err.message,
    });
    addActivityLog('error', 'Email notification failed', { error: err.message });
    logger.error(`Email failed: ${err.message}`);
    process.exit(1);
  }
}

run();
