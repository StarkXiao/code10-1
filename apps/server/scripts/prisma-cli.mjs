#!/usr/bin/env node
/**
 * Prisma CLI 包装器：
 * - 保证 DATABASE_URL 有默认值（未建 .env 时也能跑）
 * - 保证 data 目录存在（SQLite 文件需要目录）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const repoRoot = resolve(serverRoot, '../..');

// 与 .env.example 保持同一个落点：apps/server/data/app.db
process.env.DATABASE_URL ??= `file:${resolve(serverRoot, 'data/app.db')}`;
// 见 migrate.mjs 的说明：本机 schema engine 需要 RUST_LOG 才能正常工作
process.env.RUST_LOG ??= 'info';
process.env.UPLOAD_DIR ??= resolve(serverRoot, 'data/uploads');
process.env.BACKUP_DIR ??= resolve(serverRoot, 'data/backup');

// schema 里 SQLite 相对路径按 schema 目录解析，这里把两个可能的落点都建好，避免 engine 报错
for (const dir of [resolve(serverRoot, 'data'), resolve(serverRoot, 'prisma/data')]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const args = process.argv.slice(2);
const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['prisma', ...args, '--schema', resolve(serverRoot, 'prisma/schema.prisma')],
  { stdio: 'inherit', cwd: repoRoot, env: process.env },
);

process.exit(result.status ?? 1);
