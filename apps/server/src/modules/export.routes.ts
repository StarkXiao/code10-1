import { Router } from 'express';
import { mkdirSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import AdmZip from 'adm-zip';
import multer from 'multer';
import { env } from '../config/env.js';
import { HttpError } from '../lib/errors.js';
import { handler, ok } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { logActivity } from '../lib/activity.js';
import { requireAuth } from '../middleware/auth.js';
import { garmentMarkdown, printGarmentHtml, printWorksheetHtml, wardrobeCsv } from '../services/export.js';
import { logger } from '../lib/logger.js';

export const exportRouter = Router();
exportRouter.use(requireAuth);

/**
 * 备份包可能有几百 MB（含全部照片），用内存存储会把进程直接撑爆，
 * 所以先落到临时文件，读完就删。
 */
const importUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      mkdirSync(env.backupDir, { recursive: true });
      cb(null, env.backupDir);
    },
    filename: (_req, file, cb) => cb(null, `import-${Date.now()}-${file.originalname.replace(/[^\w.-]/gu, '_')}`),
  }),
  limits: { fileSize: 1024 * 1024 * 1024 },
});

exportRouter.get(
  '/garments/:id.md',
  handler(async (req, res) => {
    const garment = await prisma.garment.findFirst({
      where: { id: req.params.id, wardrobeId: req.ctx.wardrobeId, deletedAt: null },
    });
    if (!garment) throw new HttpError('NOT_FOUND', '衣物档案不存在');
    const markdown = await garmentMarkdown(garment.id);
    if (!markdown) throw new HttpError('NOT_FOUND', '档案内容不可用');
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'garment',
      entityId: garment.id,
      action: 'export',
      diff: { kind: 'markdown' },
      requestId: req.ctx.requestId,
    });
    const fileName = `${garment.code}-${garment.name}.md`.replace(/[/\\:*?"<>|]/gu, '_');
    res.setHeader('content-type', 'text/markdown; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.send(markdown);
  }),
);

exportRouter.get(
  '/wardrobe.csv',
  handler(async (req, res) => {
    const dataset = String(req.query.dataset ?? 'garments');
    if (!['garments', 'damages', 'repairs', 'wears'].includes(dataset)) {
      throw new HttpError('VALIDATION_FAILED', 'dataset 只能是 garments / damages / repairs / wears');
    }
    const csv = await wardrobeCsv(req.ctx.wardrobeId, dataset);
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'wardrobe',
      entityId: req.ctx.wardrobeId,
      action: 'export',
      diff: { kind: 'csv', dataset },
      requestId: req.ctx.requestId,
    });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${dataset}.csv"`);
    // 加 BOM，Excel 打开中文不乱码
    res.send(`\uFEFF${csv ?? ''}`);
  }),
);

exportRouter.get(
  '/backup',
  handler(async (req, res) => {
    const zip = await buildBackupZip(req.ctx.wardrobeId);
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'wardrobe',
      entityId: req.ctx.wardrobeId,
      action: 'export',
      diff: { kind: 'backup_zip' },
      requestId: req.ctx.requestId,
    });
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', `attachment; filename="mending-log-backup-${stamp}.zip"`);
    res.send(zip.toBuffer());
  }),
);

exportRouter.post(
  '/import',
  importUpload.single('file'),
  handler(async (req, res) => {
    if (req.query.confirm !== 'OVERWRITE') {
      throw new HttpError('VALIDATION_FAILED', '恢复备份会覆盖当前数据，请加 ?confirm=OVERWRITE 明确确认');
    }
    if (!req.file) throw new HttpError('VALIDATION_FAILED', '请上传备份 zip');
    try {
      const result = await restoreFromZip(await readFile(req.file.path));
      ok(req, res, {
        ...result,
        note: '数据库文件已替换，请重启服务后生效；图片已恢复到 uploads 目录。',
      });
    } finally {
      await rm(req.file.path, { force: true });
    }
  }),
);

export const printRouter = Router();
printRouter.use(requireAuth);

printRouter.get(
  '/garment/:id',
  handler(async (req, res) => {
    const garment = await prisma.garment.findFirst({
      where: { id: req.params.id, wardrobeId: req.ctx.wardrobeId, deletedAt: null },
    });
    if (!garment) throw new HttpError('NOT_FOUND', '衣物档案不存在');
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const html = await printGarmentHtml(garment.id, { token });
    if (!html) throw new HttpError('NOT_FOUND', '档案内容不可用');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(html);
  }),
);

printRouter.get(
  '/repair-worksheet/:damageEventId',
  handler(async (req, res) => {
    const damage = await prisma.damageEvent.findFirst({
      where: { id: req.params.damageEventId, garment: { wardrobeId: req.ctx.wardrobeId, deletedAt: null } },
    });
    if (!damage) throw new HttpError('NOT_FOUND', '破损事件不存在');
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const html = await printWorksheetHtml(damage.id, { token });
    if (!html) throw new HttpError('NOT_FOUND', '工单内容不可用');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(html);
  }),
);

export async function buildBackupZip(wardrobeId?: string): Promise<AdmZip> {
  const zip = new AdmZip();
  const dbPath = databaseFilePath();
  if (existsSync(dbPath)) {
    zip.addLocalFile(dbPath, 'db', 'app.db');
  }
  // 指定衣橱导出时，只打包这个衣橱自己的照片：
  // 否则导出的 zip 里会带上别人的照片（多成员共用一个实例时就是数据越权）。
  if (existsSync(env.uploadDir)) {
    if (wardrobeId) {
      const photos = await prisma.garmentPhoto.findMany({
        where: { garment: { wardrobeId } },
        select: { storagePath: true, thumbPath: true },
      });
      let added = 0;
      for (const photo of photos) {
        for (const relative of [photo.storagePath, photo.thumbPath]) {
          const absolute = join(env.uploadDir, relative);
          if (existsSync(absolute)) {
            // zip 内路径统一用正斜杠（Windows 上 join 会产生反斜杠，解压后目录结构会错）
            zip.addLocalFile(absolute, join('uploads', dirname(relative)).split(sep).join('/'));
            added += 1;
          }
        }
      }
      logger.debug({ wardrobeId, added }, 'backup: 已打包该衣橱的照片');
    } else {
      zip.addLocalFolder(env.uploadDir, 'uploads');
    }
  }

  const where = wardrobeId ? { wardrobeId } : {};
  const [garments, damages, repairs, wears, reviews, fabricSources, reminders, dictionary] = await Promise.all([
    prisma.garment.findMany({ where }),
    prisma.damageEvent.findMany({ where: { garment: where } }),
    prisma.repair.findMany({ where: { damageEvent: { garment: where } } }),
    prisma.wearLog.findMany({ where: { garment: where } }),
    prisma.reviewResult.findMany({ where: { repair: { damageEvent: { garment: where } } } }),
    prisma.fabricSource.findMany({ where }),
    prisma.reminder.findMany({ where }),
    prisma.stitch.findMany(),
  ]);

  zip.addFile(
    'export/data.json',
    Buffer.from(
      JSON.stringify(
        { exportedAt: new Date().toISOString(), wardrobeId: wardrobeId ?? null, garments, damages, repairs, wears, reviews, fabricSources, reminders, dictionary },
        null,
        2,
      ),
    ),
  );
  const media = await prisma.garmentPhoto.findMany({
    where: { garment: where, deletedAt: null },
    select: { id: true, storagePath: true, thumbPath: true, sha256: true, width: true, height: true, garmentId: true },
  });
  zip.addFile('export/media-manifest.json', Buffer.from(JSON.stringify({ photos: media }, null, 2)));
  zip.addFile(
    'README.txt',
    Buffer.from(
      [
        '衣物修补日志 · 备份包',
        `导出时间：${new Date().toISOString()}`,
        '',
        '目录说明：',
        '  db/app.db                  SQLite 数据库文件',
        '  uploads/                   原始照片与缩略图（相对路径与数据库记录一致）',
        '  export/data.json           业务数据 JSON 全量导出',
        '  export/media-manifest.json 图片清单与 sha256 校验值',
        '',
        '恢复方式：npm run restore -- <这个zip>，或在应用内「设置 → 数据恢复」上传。',
      ].join('\n'),
    ),
  );
  return zip;
}

export async function restoreFromZip(buffer: Buffer): Promise<{ dbRestored: boolean; filesRestored: number }> {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  let dbRestored = false;
  let filesRestored = 0;

  const dbEntry = entries.find((e) => e.entryName === 'db/app.db' || e.entryName.endsWith('/app.db'));
  if (dbEntry) {
    const data = dbEntry.getData();
    if (!data.subarray(0, 15).toString('utf8').startsWith('SQLite format 3')) {
      throw new HttpError('VALIDATION_FAILED', '备份里的数据库文件不是有效的 SQLite 文件');
    }
    const dbPath = databaseFilePath();
    mkdirSync(resolve(dbPath, '..'), { recursive: true });
    // 先写临时文件再替换，避免中途失败把现有库写坏
    const tmp = `${dbPath}.restore-tmp`;
    await writeFile(tmp, data);
    // 只在旧库确实存在时才留回滚副本，避免写一个 0 字节的 .bak 让人误以为可以回滚
    if (existsSync(dbPath)) {
      await writeFile(`${dbPath}.before-restore.bak`, await readFile(dbPath));
    }
    const { renameSync } = await import('node:fs');
    renameSync(tmp, dbPath);
    dbRestored = true;
  }

  for (const entry of entries) {
    if (entry.isDirectory || !entry.entryName.startsWith('uploads/')) continue;
    const relative = entry.entryName.slice('uploads/'.length);
    if (relative.includes('..')) continue;
    const target = join(env.uploadDir, relative);
    mkdirSync(resolve(target, '..'), { recursive: true });
    await writeFile(target, entry.getData());
    filesRestored += 1;
  }

  return { dbRestored, filesRestored };
}

export function databaseFilePath(): string {
  const url = env.databaseUrl;
  if (url.startsWith('file:')) return resolve(url.slice(5));
  throw new HttpError('VALIDATION_FAILED', '当前数据库不是 SQLite 文件模式，请用 pg_dump 备份');
}
