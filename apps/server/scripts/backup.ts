#!/usr/bin/env node
/** 全量备份：数据库 + 图片 + JSON 导出 → data/backup/backup-<时间>.zip */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../src/config/env.js';
import { buildBackupZip } from '../src/modules/export.routes.js';
import { prisma } from '../src/lib/prisma.js';

const wardrobeId = process.argv[2];
mkdirSync(env.backupDir, { recursive: true });
const zip = await buildBackupZip(wardrobeId);
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const target = join(env.backupDir, `backup-${stamp}.zip`);
writeFileSync(target, zip.toBuffer());
console.log(`备份完成：${target}`);
await prisma.$disconnect();
