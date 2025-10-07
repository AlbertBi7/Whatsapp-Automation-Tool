import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

import { sendDocumentToContacts } from '../../source/sender';
import { client, isClientReady, waitForClient } from '../../source/client';
import { getCurrentContacts } from './contacts';

const router = express.Router();

// Configure Multer for file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/documents');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);

  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = file.originalname.replace(ext, '').replace(/\s+/g, '-');
    const timestamp = Date.now();
    cb(null, `${name}-${timestamp}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ];
    cb(null, allowed.includes(file.mimetype));
  }
});

// Helper for filtering contacts
function filterContacts(allContacts: any[], filters: any): any[] {
  if (!filters || Object.keys(filters).length === 0) return allContacts;

  return allContacts.filter((contact: any) =>
    Object.entries(filters).every(([field, value]) =>
      !value || !contact[field]
        ? false
        : String(contact[field]).toLowerCase().includes(String(value).toLowerCase())
    )
  );
}

// POST /api/upload-document
router.post('/upload-document', (req, res) => {
  upload.single('document')(req, res, async (err) => {
    if (err) {
      console.error('❌ Multer error:', err.message);
      return res.status(400).json({ success: false, message: err.message });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
      }

      const filters = req.body.filters ? JSON.parse(req.body.filters) : null;
      const allContacts = getCurrentContacts();
      const targetContacts = filterContacts(allContacts, filters);

      if (targetContacts.length === 0) {
        return res.status(400).json({ success: false, message: 'No contacts matched the filters' });
      }

      if (!(await isClientReady())) {
        await waitForClient(60000);
      }
      
      await sendDocumentToContacts({
        client,
        fileName: req.file.filename,
        contacts: targetContacts
      });

      return res.json({
        success: true,
        sent: targetContacts.length,
        filePath: `/uploads/documents/${req.file.filename}`
      });
    } catch (e: any) {
      console.error('🚨 Unexpected error:', e.message);
      return res.status(500).json({ success: false, message: e.message });
    }
  });
});

export default router;
