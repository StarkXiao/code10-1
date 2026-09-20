#!/usr/bin/env node
/** 从备份 zip 恢复（会覆盖当前数据库，恢复前自动留 .before-restore.bak） */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { restoreFromZip } from '../src/modules/export.routes.js';
import { prisma } from '../src/lib/prisma.js';

const file = process.argv[2];
if (!file) {
  console.error('用法：npm run restore -- <备份zip路径>');
  process.exit(1);
}
const result = await restoreFromZip(readFileSync(resolve(file)));
console.log(JSON.stringify(result, null, 2));
console.log('数据库文件已替换，请重启服务后生效。');
await prisma.$disconnect();
