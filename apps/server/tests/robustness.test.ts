/**
 * 健壮性回归（都是真实踩到过的坑）：
 *   1. 并发写入不能冒 500（建档编号 / 同日打点 / 修补轮次）
 *   2. 日期必须是真实存在的日期，且不能随手填到未来
 *   3. 观察期没结束就复检，必须显式确认
 *   4. 导出某个衣橱的备份，不能夹带别人的照片
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { buildBackupZip } from '../src/modules/export.routes.js';

const app = createApp();

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

interface Account {
  token: string;
  wardrobeId: string;
  auth: (req: request.Test) => request.Test;
  dictionary: Record<string, Array<Record<string, string>>>;
}

async function register(label: string): Promise<Account> {
  // 邮箱只允许 ASCII，这里把中文标签转成 slug（displayName 仍保留中文）
  const slug = label.replace(/[^a-zA-Z0-9]/gu, '') || 'user';
  const registered = await request(app)
    .post('/api/auth/register')
    .send({
      email: `${slug}-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.com`,
      password: 'mending123',
      displayName: label,
    })
    .expect(201);
  const token = registered.body.data.token as string;
  const dictionary = (
    await request(app).get('/api/dictionary').set('authorization', `Bearer ${token}`).expect(200)
  ).body.data;
  return {
    token,
    wardrobeId: registered.body.data.wardrobe.id,
    auth: (req) => req.set('authorization', `Bearer ${token}`),
    dictionary,
  };
}

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 90, b: 70 } } })
    .png()
    .toBuffer();
}

let account: Account;

beforeAll(async () => {
  account = await register('健壮性');
});

describe('并发写入不会冒 500', () => {
  it('同时建 6 件衣物：全部成功且编号唯一', async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        account
          .auth(request(app).post('/api/garments'))
          .send({
            name: `并发衣物${index}`,
            category: 'sweater',
            materialPrimary: 'wool',
            knitOrWoven: 'knit',
            seasonTags: ['winter'],
          }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const codes = responses.map((r) => r.body.data.garment.code as string);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('同一天并发打 5 次卡：只有一次新建，其余幂等，计数只加 1', async () => {
    const garment = (
      await account.auth(request(app).post('/api/garments')).send({
        name: '并发打点衣物',
        category: 'shirt',
        materialPrimary: 'cotton',
        knitOrWoven: 'woven',
        seasonTags: ['summer'],
      })
    ).body.data.garment;

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        account.auth(request(app).post('/api/wear-logs')).send({ garmentId: garment.id, wornOn: daysAgo(1) }),
      ),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(4);
    expect(statuses.some((s) => s >= 500)).toBe(false);

    const stats = await account.auth(request(app).get(`/api/garments/${garment.id}/wear-stats`)).expect(200);
    expect(stats.body.data.wearCount).toBe(1);
  });

  it('并发登记 4 条修补：轮次各不相同且没有 500', async () => {
    const garment = (
      await account.auth(request(app).post('/api/garments')).send({
        name: '并发修补衣物',
        category: 'jacket',
        materialPrimary: 'denim',
        knitOrWoven: 'woven',
        seasonTags: ['autumn'],
      })
    ).body.data.garment;

    const damage = (
      await account.auth(request(app).post('/api/damage-events')).send({
        garmentId: garment.id,
        damageTypeId: account.dictionary.damageTypes.find((d) => d.code === 'seam_open')!.id,
        severity: 'minor',
        detectedAt: daysAgo(10),
        annotationIds: [],
        locationUnknown: true,
        locationNote: '并发用例',
      })
    ).body.data.damage;

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        account.auth(request(app).post('/api/repairs')).send({
          damageEventId: damage.id,
          executedBy: 'self',
          stitchId: account.dictionary.stitches.find((s) => s.code === 'backstitch')!.id,
          startedAt: daysAgo(8),
          finishedAt: daysAgo(7),
        }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    const rounds = responses.map((r) => r.body.data.repair.round as number).sort((a, b) => a - b);
    expect(rounds).toEqual([1, 2, 3, 4]);
  });
});

describe('日期校验', () => {
  it('拒绝不存在的日期（2026-02-31）', async () => {
    const response = await account.auth(request(app).post('/api/garments')).send({
      name: '日期校验衣物',
      category: 'shirt',
      materialPrimary: 'cotton',
      knitOrWoven: 'woven',
      seasonTags: ['summer'],
      purchaseDate: '2026-02-31',
    });
    expect(response.status).toBe(422);
    expect(response.body.error.details?.[0]?.path).toContain('purchaseDate');
  });

  it('拒绝把穿着日期填到未来（年份手误）', async () => {
    const garment = (
      await account.auth(request(app).post('/api/garments')).send({
        name: '未来日期衣物',
        category: 'shirt',
        materialPrimary: 'cotton',
        knitOrWoven: 'woven',
        seasonTags: ['summer'],
      })
    ).body.data.garment;

    const response = await account
      .auth(request(app).post('/api/wear-logs'))
      .send({ garmentId: garment.id, wornOn: '2062-01-01' });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('观察期未到的复检', () => {
  it('未确认时返回 OBSERVATION_NOT_FINISHED，确认后可提交', async () => {
    const garment = (
      await account.auth(request(app).post('/api/garments')).send({
        name: '提前复检衣物',
        category: 'sweater',
        materialPrimary: 'wool',
        knitOrWoven: 'knit',
        seasonTags: ['winter'],
      })
    ).body.data.garment;

    const damage = (
      await account.auth(request(app).post('/api/damage-events')).send({
        garmentId: garment.id,
        damageTypeId: account.dictionary.damageTypes.find((d) => d.code === 'hole')!.id,
        severity: 'moderate',
        detectedAt: daysAgo(3),
        annotationIds: [],
        locationUnknown: true,
        locationNote: '提前复检用例',
      })
    ).body.data.damage;

    const repair = (
      await account.auth(request(app).post('/api/repairs')).send({
        damageEventId: damage.id,
        executedBy: 'self',
        stitchId: account.dictionary.stitches.find((s) => s.code === 'darning_hand')!.id,
        startedAt: daysAgo(1),
        finishedAt: iso(new Date()),
        observationDays: 14,
      })
    ).body.data.repair;

    const early = await account
      .auth(request(app).post(`/api/repairs/${repair.id}/review`))
      .send({ reviewedAt: iso(new Date()), verdict: 'good', nextAction: 'close' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('OBSERVATION_NOT_FINISHED');
    expect(early.body.error.details.observationUntil).toBeTruthy();

    const confirmed = await account
      .auth(request(app).post(`/api/repairs/${repair.id}/review`))
      .send({ reviewedAt: iso(new Date()), verdict: 'good', nextAction: 'close', confirmEarly: true })
      .expect(201);
    expect(confirmed.body.data.repairStatus).toBe('passed');
  });
});

describe('备份的数据隔离', () => {
  it('导出 A 的备份不会夹带 B 的照片', async () => {
    const ownerA = await register('备份A');
    const ownerB = await register('备份B');
    const image = await png();

    const paths: string[] = [];
    for (const [owner, name] of [
      [ownerA, 'A 的衣服'],
      [ownerB, 'B 的衣服'],
    ] as Array<[Account, string]>) {
      const garment = (
        await owner.auth(request(app).post('/api/garments')).send({
          name,
          category: 'shirt',
          materialPrimary: 'cotton',
          knitOrWoven: 'woven',
          seasonTags: ['summer'],
        })
      ).body.data.garment;
      const photo = (
        await owner
          .auth(request(app).post(`/api/garments/${garment.id}/photos`))
          .field('view', 'front')
          .attach('file', image, 'front.png')
          .expect(201)
      ).body.data.photo;
      paths.push(photo.storagePath as string);
    }

    const zip = await buildBackupZip(ownerA.wardrobeId);
    const entries = zip.getEntries().map((entry) => entry.entryName);

    const aPhotoPath = paths[0].split('/').slice(1).join('/');
    const bPhotoPath = paths[1].split('/').slice(1).join('/');
    expect(entries.some((name) => name.includes(aPhotoPath))).toBe(true);
    expect(entries.some((name) => name.includes(bPhotoPath))).toBe(false);
  });
});
