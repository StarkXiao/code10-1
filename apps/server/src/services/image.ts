import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { env } from '../config/env.js';
import { HttpError } from '../lib/errors.js';

export interface ProcessedPhoto {
  storagePath: string;
  thumbPath: string;
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
}

const MAX_EDGE = 2048;
const THUMB_EDGE = 512;

/**
 * 图片管线（项目文档 11.2）：
 *   1. 按 EXIF Orientation 旋转（不做这步，手机竖拍图上的标记必然错位）
 *   2. 长边压到 2048
 *   3. 生成 512 缩略图
 *   4. 剥离 EXIF（含 GPS）
 *   5. 落盘并计算 sha256
 */
export async function processPhoto(
  buffer: Buffer,
  scope: { wardrobeId: string; garmentId: string },
): Promise<ProcessedPhoto> {
  let full: Buffer;
  let thumb: Buffer;
  let width = 0;
  let height = 0;
  try {
    full = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    const meta = await sharp(full).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
    thumb = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 70 })
      .toBuffer();
  } catch {
    throw new HttpError('UPLOAD_TYPE_NOT_ALLOWED', '图片无法解析，请改用 JPEG / PNG 格式后重试');
  }

  if (!width || !height) {
    throw new HttpError('UPLOAD_TYPE_NOT_ALLOWED', '图片尺寸无法识别，请换一张照片');
  }

  const fileName = `${randomUUID()}.webp`;
  const relDir = join(scope.wardrobeId, scope.garmentId);
  const absDir = join(env.uploadDir, relDir);
  await mkdir(absDir, { recursive: true });

  const relPath = join(relDir, fileName);
  const thumbName = `${fileName.replace(/\.webp$/u, '')}_thumb.webp`;
  const relThumb = join(relDir, thumbName);

  await writeFile(join(env.uploadDir, relPath), full);
  await writeFile(join(env.uploadDir, relThumb), thumb);

  return {
    storagePath: relPath,
    thumbPath: relThumb,
    width,
    height,
    sizeBytes: full.byteLength,
    sha256: createHash('sha256').update(full).digest('hex'),
    mimeType: 'image/webp',
  };
}

export function absolutePath(relative: string): string {
  return join(env.uploadDir, relative);
}

export async function ensureUploadDirs(): Promise<void> {
  await mkdir(env.uploadDir, { recursive: true });
  await mkdir(dirname(env.uploadDir), { recursive: true });
}
