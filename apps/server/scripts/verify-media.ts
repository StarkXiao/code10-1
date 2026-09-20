#!/usr/bin/env node
/** 校验图片完整性：磁盘 sha256 与数据库记录比对，输出丢失/损坏清单 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma.js';
import { absolutePath } from '../src/services/image.js';

const photos = await prisma.garmentPhoto.findMany({ where: { deletedAt: null } });
const missing: string[] = [];
const corrupted: string[] = [];
let ok = 0;

for (const photo of photos) {
  try {
    const buffer = await readFile(absolutePath(photo.storagePath));
    const hash = createHash('sha256').update(buffer).digest('hex');
    if (hash !== photo.sha256) corrupted.push(photo.id);
    else ok += 1;
  } catch {
    missing.push(photo.id);
  }
}

console.log(
  JSON.stringify(
    {
      total: photos.length,
      ok,
      missingCount: missing.length,
      corruptedCount: corrupted.length,
      missing,
      corrupted,
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
