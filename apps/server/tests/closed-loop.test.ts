/**
 * 闭环集成测试：真实调用 Express 应用（supertest）+ 真实 SQLite + 真实图片处理。
 * 覆盖：建档 → 传图 → 标记 → 破损 → 修补 → 用料扣库存 → 变化 → 观察期 → 复检闭环 → 复发 → 退役
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const app = createApp();
let token = '';
let garmentId = '';
let photoId = '';
let damageId = '';
let repairId = '';
let fabricSourceId = '';
let dictionary: Record<string, Array<Record<string, string>>> = {};

const today = new Date();
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(today.getTime() - n * 86_400_000));

function auth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}

beforeAll(async () => {
  const unique = `test-${Date.now()}@example.com`;
  const registered = await request(app)
    .post('/api/auth/register')
    .send({ email: unique, password: 'mending123', displayName: '集成测试' })
    .expect(201);
  token = registered.body.data.token;

  const dict = await auth(request(app).get('/api/dictionary')).expect(200);
  dictionary = dict.body.data;
});

describe('衣物修补日志 · 闭环', () => {
  it('建档并生成可读编号', async () => {
    const response = await auth(request(app).post('/api/garments'))
      .send({
        name: '测试羊毛衫',
        category: 'sweater',
        materialPrimary: 'wool',
        knitOrWoven: 'knit',
        seasonTags: ['autumn', 'winter'],
        purchasePrice: 400,
        firstWearDate: daysAgo(20),
      })
      .expect(200);
    garmentId = response.body.data.garment.id;
    expect(response.body.data.garment.code).toMatch(/^G-\d{4}-\d{4}$/u);
    expect(response.body.data.garment.status).toBe('active');
  });

  it('上传照片会被转成 webp 并记录尺寸与 sha256', async () => {
    const image = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: { r: 90, g: 90, b: 95 } },
    })
      .jpeg()
      .toBuffer();
    const response = await auth(request(app).post(`/api/garments/${garmentId}/photos`))
      .field('view', 'front')
      .attach('file', image, 'front.jpg')
      .expect(201);
    photoId = response.body.data.photo.id;
    expect(response.body.data.photo.mimeType).toBe('image/webp');
    expect(response.body.data.photo.width).toBe(1200);
    expect(response.body.data.photo.sha256).toHaveLength(64);
  });

  it('照片标记坐标归一化到 4 位小数', async () => {
    const response = await auth(request(app).post(`/api/photos/${photoId}/annotations`))
      .send({ annotations: [{ kind: 'point', geometry: { x: 0.41235, y: 0.66719 } }] })
      .expect(201);
    expect(response.body.data.annotations[0].geometry.x).toBeCloseTo(0.4124, 4);
    expect(response.body.data.annotations[0].status).toBe('draft');
  });

  it('没有标记位置时拒绝登记破损', async () => {
    const response = await auth(request(app).post('/api/damage-events'))
      .send({
        garmentId,
        damageTypeId: dictionary.damageTypes.find((d) => d.code === 'hole')!.id,
        severity: 'moderate',
        detectedAt: daysAgo(60),
      })
      .expect(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('登记破损会冻结标记并推进衣物状态', async () => {
    const annotations = await auth(request(app).get(`/api/photos/${photoId}/annotations`)).expect(200);
    const annotationId = annotations.body.data.annotations[0].id;
    const response = await auth(request(app).post('/api/damage-events'))
      .send({
        garmentId,
        damageTypeId: dictionary.damageTypes.find((d) => d.code === 'hole')!.id,
        severity: 'moderate',
        partId: dictionary.partsFlat.find((p) => p.code === 'elbow_right')!.id,
        detectedAt: daysAgo(60),
        annotationIds: [annotationId],
        locationUnknown: false,
      })
      .expect(201);
    damageId = response.body.data.damage.id;
    expect(response.body.data.damage.status).toBe('pending');

    const garment = await auth(request(app).get(`/api/garments/${garmentId}`)).expect(200);
    expect(garment.body.data.garment.status).toBe('needs_repair');
    const frozen = garment.body.data.photos[0].annotations[0];
    expect(frozen.frozen).toBe(true);
    expect(frozen.damageEventId).toBe(damageId);
  });

  it('用料会扣减库存，超量会被拒绝', async () => {
    const source = await auth(request(app).post('/api/fabric-sources'))
      .send({
        name: '测试余料',
        kind: 'original_scrap',
        materialPrimary: 'wool',
        inventory: { unit: 'cm', initialAmount: 100 },
      })
      .expect(201);
    fabricSourceId = source.body.data.fabricSource.id;

    const repair = await auth(request(app).post('/api/repairs'))
      .send({
        damageEventId: damageId,
        executedBy: 'self',
        stitchId: dictionary.stitches.find((s) => s.code === 'darning_hand')!.id,
        // 时间线贴着"现在"：观察期已过但提醒还没超时失效，才能验证"点提醒→提交复检"这条路
        startedAt: daysAgo(25),
        finishedAt: daysAgo(20),
      })
      .expect(201);
    repairId = repair.body.data.repair.id;
    expect(repair.body.data.repair.round).toBe(1);
    expect(repair.body.data.repair.observationDays).toBe(14); // 自补默认观察期

    const consumed = await auth(request(app).post(`/api/repairs/${repairId}/materials`))
      .send({ fabricSourceId, amount: 30 })
      .expect(201);
    expect(consumed.body.data.inventory.remainingAmount).toBe(70);

    const overdraw = await auth(request(app).post(`/api/repairs/${repairId}/materials`))
      .send({ fabricSourceId, amount: 999 })
      .expect(409);
    expect(overdraw.body.error.code).toBe('INVENTORY_INSUFFICIENT');
  });

  it('未填写修补后变化不能进入观察期', async () => {
    const response = await auth(request(app).post(`/api/repairs/${repairId}/start-observation`))
      .send({})
      .expect(422);
    expect(response.body.error.code).toBe('REPAIR_CHANGE_REQUIRED');
  });

  it('填写变化后进入观察期并生成复检提醒', async () => {
    await auth(request(app).put(`/api/repairs/${repairId}/change`))
      .send({
        visibility: 'slight',
        colorMatch: 'close',
        stiffness: 'same',
        drapeChange: 'none',
        mobilityLimited: false,
        visibleFromOutside: false,
      })
      .expect(200);

    const observation = await auth(request(app).post(`/api/repairs/${repairId}/start-observation`))
      .send({})
      .expect(200);
    expect(observation.body.data.reminderCreated).toBe(true);

    const reminders = await auth(request(app).get('/api/reminders?scope=all&limit=50')).expect(200);
    const followup = reminders.body.data.items.find(
      (r: { occurrenceKey: string }) => r.occurrenceKey === `followup:repair:${repairId}`,
    );
    expect(followup).toBeTruthy();
    expect(followup.expireAt).toBeTruthy();
  });

  it('提醒会被幂等去重（重复扫描不产生第二条）', async () => {
    const { runReminderScan } = await import('../src/services/rules/engine.js');
    await runReminderScan();
    await runReminderScan();
    const count = await prisma.reminder.count({
      where: { subjectType: 'repair', subjectId: repairId, occurrenceKey: `followup:repair:${repairId}` },
    });
    expect(count).toBe(1);
  });

  it('穿着打点同日幂等，并推进频率统计', async () => {
    const first = await auth(request(app).post('/api/wear-logs'))
      .send({ garmentId, wornOn: daysAgo(20), session: 'full_day' })
      .expect(201);
    expect(first.body.data.duplicate).toBe(false);

    const duplicate = await auth(request(app).post('/api/wear-logs'))
      .send({ garmentId, wornOn: daysAgo(20), session: 'full_day' })
      .expect(200);
    expect(duplicate.body.meta.idempotent).toBe(true);

    // 服役不足 1 个月时按 1 个月计（口径见 13.1），10 次穿着 → 10 次/月 → 高频
    for (const offset of [15, 12, 10, 8, 5, 4, 3, 2, 1]) {
      await auth(request(app).post('/api/wear-logs'))
        .send({ garmentId, wornOn: daysAgo(offset), session: 'full_day' })
        .expect(201);
    }

    const stats = await auth(request(app).get(`/api/garments/${garmentId}/wear-stats`)).expect(200);
    expect(stats.body.data.wearCount).toBe(10);
    expect(stats.body.data.frequencyBand).toBe('high');
  });

  it('复检不合格必须选择返工或退役，并生成返工任务', async () => {
    const reminders = await auth(request(app).get('/api/reminders?scope=all&limit=50')).expect(200);
    const followup = reminders.body.data.items.find(
      (r: { occurrenceKey: string }) => r.occurrenceKey === `followup:repair:${repairId}`,
    );
    expect(followup.status).toBe('notified');

    // failed 不能直接闭环
    const invalid = await auth(request(app).post(`/api/reminders/${followup.id}/action`))
      .send({ review: { reviewedAt: daysAgo(3), verdict: 'failed', reoccurred: false, nextAction: 'close' } })
      .expect(422);
    expect(invalid.body.error.code).toBe('VALIDATION_FAILED');

    // failed + 返工：提醒闭环 + 生成返工任务 + 破损回到待修
    const response = await auth(request(app).post(`/api/reminders/${followup.id}/action`))
      .send({
        review: {
          reviewedAt: daysAgo(3),
          verdict: 'failed',
          reoccurred: false,
          verdictNote: '边缘又开了',
          nextAction: 'rework',
        },
      })
      .expect(201);
    expect(response.body.data.outcome.repairStatus).toBe('failed');
    expect(response.body.data.outcome.damageStatus).toBe('pending');
    expect(response.body.data.outcome.reminderCreated.kind).toBe('rework');

    const after = await auth(request(app).get('/api/reminders?scope=all&limit=50')).expect(200);
    const handled = after.body.data.items.find((r: { id: string }) => r.id === followup.id);
    expect(handled.status).toBe('done');
    expect(handled.resultRef.reviewId).toBeTruthy();
  });

  it('返工后第二轮修补：送修默认 7 天观察期，复检通过后破损收口', async () => {
    const secondRepair = await auth(request(app).post('/api/repairs'))
      .send({
        damageEventId: damageId,
        executedBy: 'shop',
        stitchId: dictionary.stitches.find((s) => s.code === 'patch_applique')!.id,
        startedAt: daysAgo(2),
        finishedAt: daysAgo(1),
      })
      .expect(201);
    const secondRepairId = secondRepair.body.data.repair.id;
    expect(secondRepair.body.data.repair.round).toBe(2);
    expect(secondRepair.body.data.repair.observationDays).toBe(7);

    await auth(request(app).put(`/api/repairs/${secondRepairId}/change`))
      .send({
        visibility: 'noticeable',
        colorMatch: 'close',
        stiffness: 'stiffer',
        drapeChange: 'slight',
        mobilityLimited: false,
        visibleFromOutside: true,
      })
      .expect(200);

    await auth(request(app).post(`/api/repairs/${secondRepairId}/start-observation`)).send({}).expect(200);

    // 观察期还没结束（送修 7 天）：先被拦下来，确认后才能提前复检
    const early = await auth(request(app).post(`/api/repairs/${secondRepairId}/review`))
      .send({ reviewedAt: iso(today), verdict: 'good', reoccurred: false, nextAction: 'close' })
      .expect(409);
    expect(early.body.error.code).toBe('OBSERVATION_NOT_FINISHED');

    const review = await auth(request(app).post(`/api/repairs/${secondRepairId}/review`))
      .send({
        reviewedAt: iso(today),
        verdict: 'good',
        reoccurred: false,
        nextAction: 'close',
        confirmEarly: true,
      })
      .expect(201);
    expect(review.body.data.repairStatus).toBe('passed');
    expect(review.body.data.damageStatus).toBe('resolved');

    const reminders = await auth(request(app).get('/api/reminders?scope=all&limit=50')).expect(200);
    const followup = reminders.body.data.items.find(
      (r: { occurrenceKey: string }) => r.occurrenceKey === `followup:repair:${secondRepairId}`,
    );
    expect(followup.status).toBe('done');
    expect(followup.resultRef.reviewId).toBeTruthy();

    const garment = await auth(request(app).get(`/api/garments/${garmentId}`)).expect(200);
    expect(garment.body.data.garment.status).toBe('active');
  });

  it('同一位置再次破损可确认为复发，并触发预警提醒', async () => {
    const recurrence = await auth(request(app).post('/api/damage-events'))
      .send({
        garmentId,
        damageTypeId: dictionary.damageTypes.find((d) => d.code === 'hole')!.id,
        severity: 'minor',
        partId: dictionary.partsFlat.find((p) => p.code === 'elbow_right')!.id,
        detectedAt: daysAgo(2),
        annotationIds: [],
        locationUnknown: true,
        locationNote: '沿用上次标记位置',
      })
      .expect(201);
    const newDamageId = recurrence.body.data.damage.id;

    const candidates = await auth(request(app).get(`/api/damage-events/${newDamageId}/recurrence-candidates`)).expect(200);
    expect(candidates.body.data.candidates.length).toBeGreaterThan(0);

    const linked = await auth(request(app).post(`/api/damage-events/${newDamageId}/link-recurrence`))
      .send({ recurrenceOfId: damageId })
      .expect(200);
    expect(linked.body.data.damage.recurrenceIndex).toBe(2);

    const reminders = await auth(request(app).get('/api/reminders?scope=all&limit=50')).expect(200);
    expect(
      reminders.body.data.items.some((r: { occurrenceKey: string }) => r.occurrenceKey === `recurrence:${newDamageId}`),
    ).toBe(true);

    const analytics = await auth(request(app).get('/api/analytics/by-material')).expect(200);
    expect(analytics.body.data.rows[0].recurrenceRate).toBeGreaterThan(0);
  });

  it('退役必填处置方式，并让未完成提醒失效', async () => {
    const retired = await auth(request(app).post(`/api/garments/${garmentId}/retire`))
      .send({ disposition: 'upcycle', dispositionNote: '改成抹布' })
      .expect(200);
    expect(retired.body.data.garment.status).toBe('retired');

    const open = await prisma.reminder.count({
      where: { subjectType: 'damage_event', subjectId: damageId, status: { in: ['pending', 'notified'] } },
    });
    expect(open).toBe(0);

    const blocked = await auth(request(app).post('/api/damage-events'))
      .send({
        garmentId,
        damageTypeId: dictionary.damageTypes.find((d) => d.code === 'hole')!.id,
        severity: 'minor',
        detectedAt: iso(today),
        annotationIds: [],
        locationUnknown: true,
        locationNote: '测试用',
      })
      .expect(409);
    expect(blocked.body.error.code).toBe('GARMENT_RETIRED');
  });

  it('终身档案包含服役天数、每穿成本与健康分', async () => {
    const report = await auth(request(app).get(`/api/garments/${garmentId}/lifetime-report`)).expect(200);
    expect(report.body.data.report.serviceDays).toBeGreaterThan(0);
    expect(report.body.data.report.costPerWear).not.toBeNull();
    expect(report.body.data.report.health.score).toBeGreaterThanOrEqual(0);
    expect(report.body.data.history.length).toBeGreaterThanOrEqual(2);
  });
});
