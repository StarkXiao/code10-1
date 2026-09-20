import multer from 'multer';
import { HttpError } from '../lib/errors.js';
import { maxUploadBytes } from '../config/env.js';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

export const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      cb(new HttpError('UPLOAD_TYPE_NOT_ALLOWED', '仅支持 JPEG / PNG / WebP / HEIC 图片'));
      return;
    }
    cb(null, true);
  },
});
