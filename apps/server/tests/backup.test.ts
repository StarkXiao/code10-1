/**
 * 备份/恢复的安全边界：
 * 备份包必须包含数据库、照片、JSON 导出与清单；
 * 恢复时必须拒绝非 SQLite 的数据库文件，且不写 0 字节回滚副本。
 */
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { createApp } from '../src/app.js';
import { buildBackupZip, databaseFilePath, restoreFromZip } from '../src/modules/export.routes.js';

const app = createApp();
let token = '';
let wardrobeId = '';

beforeAll(async () => {
  const registered = await request(app)
    .post('/api/auth/register')
    .send({ email: `backup-${Date.now()}@example.com`, password: 'mending123', displayName: '备份测试' })
    .expect(201);
  token = registered.body.data.token;
  wardrobeId = registered.body.data.wardrobe.id;
});

describe('备份与恢复', () => {
  it('备份包包含数据库、媒体清单与 JSON 全量导出', async () => {
    const zip = await buildBackupZip(wardrobeId);
    const names = zip.getEntries().map((entry) => entry.entryName);
    expect(names).toContain('db/app.db');
    expect(names).toContain('export/data.json');
    expect(names).toContain('export/media-manifest.json');
    expect(names).toContain('README.txt');

    const buffer = zip.toBuffer();
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    const data = JSON.parse(zip.readAsText('export/data.json')) as {
      wardrobeId: string;
      garments: unknown[];
      exportedAt: string;
    };
    expect(data.wardrobeId).toBe(wardrobeId);
    expect(Array.isArray(data.garments)).toBe(true);
    expect(data.exportedAt).toBeTruthy();
  });

  it('恢复时会拒绝不是 SQLite 的数据库文件', async () => {
    const zip = new AdmZip();
    zip.addFile('db/app.db', Buffer.from('这不是一个 SQLite 数据库'));
    await expect(restoreFromZip(zip.toBuffer())).rejects.toThrow(/SQLite/u);
  });

  it('只含图片的备份包不会替换数据库，但仍会恢复图片', async () => {
    const zip = new AdmZip();
    zip.addFile('uploads/demo/restored.txt', Buffer.from('fake-image'));
    const result = await restoreFromZip(zip.toBuffer());
    expect(result.dbRestored).toBe(false);
    expect(result.filesRestored).toBe(1);
  });

  it('数据库文件路径可从 DATABASE_URL 解析出来', () => {
    const path = databaseFilePath();
    expect(path.endsWith('.db')).toBe(true);
    expect(existsSync(path)).toBe(true);
    // 备份里写的是真实文件内容，不是空文件
    expect(readFileSync(path).length).toBeGreaterThan(0);
  });
});
