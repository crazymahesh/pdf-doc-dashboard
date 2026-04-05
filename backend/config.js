'use strict';
require('dotenv').config();
const path = require('path');

function todayDate() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

module.exports = {
  server: {
    port: parseInt(process.env.PORT || '3000'),
    title: process.env.DASHBOARD_TITLE || 'PDF-DOC Conversion Dashboard',
    org: process.env.ORGANIZATION || 'Organization',
    get publicUrl() {
      return (process.env.SERVER_PUBLIC_URL || `http://localhost:${this.port}`).replace(/\/$/, '');
    },
  },

  sftp: {
    host: process.env.SFTP_HOST || 'localhost',
    port: parseInt(process.env.SFTP_PORT || '22'),
    username: process.env.SFTP_USER || 'tester',
    password: process.env.SFTP_PASS || 'password',
    get remotePath() {
      return `${process.env.SFTP_REMOTE_BASE_PATH || '/daily'}/${todayDate()}`;
    },
    get outputRemotePath() {
      const base = process.env.SFTP_OUTPUT_FOLDER || 'Output_Converted_Doc';
      return `/${base}/${todayDate()}`;
    },
  },

  paths: {
    base: process.env.LOCAL_BASE_PATH || 'C:\\PDF-DOC-Dashboard\\dashboard\\Downloads',
    get dateFolder() {
      return path.join(this.base, todayDate());
    },
    get scannedPdf() {
      return path.join(this.dateFolder, 'Scanned PDF');
    },
    get corruptedPdf() {
      return path.join(this.dateFolder, 'Corrupted PDF');
    },
    get outputWithDatetime() {
      return path.join(this.dateFolder, 'output-with-datetime');
    },
    get admin1() {
      return path.join(this.outputWithDatetime, 'admin_1');
    },
    get admin2() {
      return path.join(this.outputWithDatetime, 'admin_2');
    },
    get admin3() {
      return path.join(this.outputWithDatetime, 'admin_3');
    },
    get afterLigatureFix() {
      return path.join(this.dateFolder, 'afterLigatureFix');
    },
    get finalConversion() {
      return path.join(this.dateFolder, 'final_conversion');
    },
    get reports() {
      return path.join(this.dateFolder, 'reports');
    },
  },

  email: {
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: process.env.EMAIL_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER || 'mahesh.mathesh@gmail.com',
      pass: process.env.EMAIL_PASS || 'mwhd whep rjdg zghu',
    },
    from: process.env.EMAIL_FROM || 'PDF Dashboard',
    to: process.env.EMAIL_TO || 'mahesh.mathesh@gmail.com',
    cc: process.env.EMAIL_CC || '',
  },
};
