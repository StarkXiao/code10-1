/** 建测试库并写入字典基线数据（与开发库完全隔离） */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export default function setup(): void {
  const serverRoot = resolve(import.meta.dirname, '..');
  const dbPath = resolve(serverRoot, 'data/test.db');
  if (existsSync(dbPath)) rmSync(dbPath);

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: `file:${dbPath}`,
    UPLOAD_DIR: resolve(serverRoot, 'data/test-uploads'),
    JWT_SECRET: 'test-secret',
    CRON_ENABLED: 'false',
  };

  execFileSync('node', ['scripts/migrate.mjs'], { cwd: serverRoot, env, stdio: 'ignore' });
  execFileSync('npx', ['tsx', 'prisma/seed.ts'], { cwd: serverRoot, env, stdio: 'ignore' });
}
