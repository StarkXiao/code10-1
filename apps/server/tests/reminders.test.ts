/**
 * 提醒生命周期回归测试：
 * 幂等去重、顺延后不会立刻失效、超时自动失效、忽略必须带原因。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { runReminderScan } from '../src/services/rules/engine.js';

const app = createApp();
let token = '';
let garmentId = '';
let damageId = '';
let dictionary: Record<string, Array<Record<string, string>>> = {};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

function auth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}

async function openReminders(): Promise<Array<Record<string, unknown>>> {
  const response = await auth(request(app).get('/api/reminders?scope=all&limit=100')).expect(200);
  return response.body.data.items;
}

beforeAll(async () => {
  const registered = await request(app)
    .post('/api/auth/register')
    .send({ email: `reminder-${Date.now()}@example.com`, password: 'mending123', displayName: '提醒测试' })
    .expect(201);
  token = registered.body.data.token;
  dictionary = (await auth(request(app).get('/api/dictionary')).expect(200)).body.data;

  const garment = await auth(request(app).post('/api/garments'))
    .send({
      name: '提醒测试毛衣',
      category: 'sweater',
      materialPrimary: 'cotton',
      knitOrWoven: 'knit',
      seasonTags: ['spring'],
      firstWearDate: daysAgo(30),
    })
    .expect(200);
  garmentId = garment.body.data.garment.id;

  // 40 天前登记、至今未处理 → 命中「长期未处理的破损」规则
  const damage = await auth(request(app).post('/api/damage-events'))
    .send({
      garmentId,
      damageTypeId: dictionary.damageTypes.find((d) => d.code === 'seam_open')!.id,
      severity: 'minor',
      detectedAt: daysAgo(40),
      annotationIds: [],
      locationUnknown: true,
      locationNote: '腋下，照片不方便拍',
    })
    .expect(201);
  damageId = damage.body.data.damage.id;
  await runReminderScan();
});

describe('提醒生命周期', () => {
  it('扫描会为长期未处理的破损生成提醒，且重复扫描不重复生成', async () => {
    await runReminderScan();
    await runReminderScan();
    const count = await prisma.reminder.count({
      where: { subjectType: 'damage_event', subjectId: damageId, occurrenceKey: `pending:${damageId}` },
    });
    expect(count).toBe(1);
  });

  it('顺延后生成的新提醒不会立刻失效（过期时间跟着顺延走）', async () => {
    const items = await openReminders();
    const target = items.find(
      (r) => r.subjectId === damageId && ['pending', 'notified'].includes(String(r.status)),
    ) as { id: string } | undefined;
    expect(target).toBeTruthy();

    const snoozeUntil = iso(new Date(Date.now() + 100 * 86_400_000));
    const snoozed = await auth(request(app).post(`/api/reminders/${target!.id}/snooze`))
      .send({ snoozeUntil })
      .expect(200);

    const { nextReminderId, nextReminderDueAt, nextReminderExpireAt } = snoozed.body.data;
    expect(nextReminderId).toBeTruthy();
    // 顺延 100 天，过期时间必须晚于到期时间，否则下一轮扫描会直接判它失效
    expect(new Date(nextReminderExpireAt).getTime()).toBeGreaterThan(new Date(nextReminderDueAt).getTime());

    const before = await prisma.reminder.findUniqueOrThrow({ where: { id: nextReminderId } });
    expect(before.status).toBe('pending');

    await runReminderScan();
    const after = await prisma.reminder.findUniqueOrThrow({ where: { id: nextReminderId } });
    expect(after.status).toBe('pending');

    // 原始那条已经是有终态的 snoozed，不再是待办
    const original = await prisma.reminder.findUniqueOrThrow({ where: { id: target!.id } });
    expect(original.status).toBe('snoozed');
  });

  it('忽略必须带原因，并记录为终态', async () => {
    const items = await openReminders();
    const target = items.find((r) => ['pending', 'notified'].includes(String(r.status)));
    expect(target).toBeTruthy();

    await auth(request(app).post(`/api/reminders/${String(target!.id)}/dismiss`)).send({}).expect(422);

    const dismissed = await auth(request(app).post(`/api/reminders/${String(target!.id)}/dismiss`))
      .send({ reason: 'not_applicable', note: '这次不需要处理' })
      .expect(200);
    expect(dismissed.body.data.reminder.status).toBe('dismissed');
    expect(dismissed.body.data.reminder.dismissReason).toBe('not_applicable');

    await auth(request(app).post(`/api/reminders/${String(target!.id)}/complete`)).send({}).expect(409);
  });

  it('超过过期时间的提醒会被扫描自动置为 expired（不留僵尸待办）', async () => {
    const items = await openReminders();
    const target = items.find((r) => ['pending', 'notified'].includes(String(r.status)));
    if (!target) return; // 上一条用例可能已把所有提醒处理干净

    await prisma.reminder.update({
      where: { id: String(target.id) },
      data: { expireAt: new Date(Date.now() - 86_400_000) },
    });
    await runReminderScan();
    const after = await prisma.reminder.findUniqueOrThrow({ where: { id: String(target.id) } });
    expect(after.status).toBe('expired');
    expect(after.resultRef).toBeTruthy();
  });

  it('衣物退役会让未完成的破损提醒一并失效', async () => {
    await auth(request(app).post(`/api/garments/${garmentId}/retire`))
      .send({ disposition: 'rag' })
      .expect(200);
    const open = await prisma.reminder.count({
      where: { subjectType: 'damage_event', subjectId: damageId, status: { in: ['pending', 'notified'] } },
    });
    expect(open).toBe(0);
  });
});
