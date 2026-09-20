/**
 * 提醒规则引擎（项目文档 12.4）。
 *
 * 三条铁律：
 *   1. 幂等：同一 (subjectType, subjectId, occurrenceKey) 只会存在一条提醒；
 *   2. 收敛：每条提醒都有 expire_at，超时自动转 expired，不留僵尸待办；
 *   3. 可执行：每条提醒带 actionKind + actionPayload，点击直达预填表单。
 */
import type { Prisma } from '@prisma/client';
import {
  DAMAGE_TERMINAL_STATUSES,
  seasonOfMonth,
  type DamageStatus,
  type ReminderActionKind,
  type ReminderSubjectType,
} from '@gml/shared';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { addDays, dayKey, monthKey, todayInTimezone } from '../../lib/date.js';
import { notify } from '../notify.js';
import { publishToUser } from '../sse.js';
import { BUILTIN_RULES } from './builtin.js';
import { computeAllGarmentStats, computeHealth, loadDataset } from '../stats.js';

export interface CreateReminderInput {
  wardrobeId: string;
  userId: string;
  ruleId?: string | null;
  subjectType: ReminderSubjectType;
  subjectId: string;
  title: string;
  body: string;
  reason: string;
  actionKind: ReminderActionKind;
  actionPayload?: Record<string, unknown> | null;
  dueAt: Date;
  expireAt: Date;
  occurrenceKey: string;
  priority?: 'low' | 'normal' | 'high';
  channel?: 'inapp' | 'inapp_email' | 'inapp_webhook';
  /** 是否立即推送到用户面前（false = 先进待办队列，等到 due 再推） */
  notifyNow?: boolean;
  email?: string;
}

export async function ensureBuiltinRules(wardrobeId: string): Promise<void> {
  for (const rule of BUILTIN_RULES) {
    await prisma.reminderRule.upsert({
      where: { wardrobeId_code: { wardrobeId, code: rule.code } },
      create: {
        wardrobeId,
        code: rule.code,
        name: rule.name,
        triggerKind: rule.triggerKind,
        params: rule.params as Prisma.InputJsonValue,
        scopeFilter: rule.scopeFilter as Prisma.InputJsonValue,
        scheduleCron: rule.scheduleCron,
        channel: rule.channel,
        priority: rule.priority,
        isEnabled: true,
        isBuiltin: true,
      },
      update: {}, // 已存在就不动用户的改动
    });
  }
}

export async function createReminderIfAbsent(
  input: CreateReminderInput,
): Promise<{ created: boolean; reminderId?: string }> {
  const existing = await prisma.reminder.findUnique({
    where: {
      subjectType_subjectId_occurrenceKey: {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        occurrenceKey: input.occurrenceKey,
      },
    },
  });
  if (existing) return { created: false, reminderId: existing.id };

  const reminder = await prisma.reminder.create({
    data: {
      wardrobeId: input.wardrobeId,
      userId: input.userId,
      ruleId: input.ruleId ?? null,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      title: input.title,
      body: input.body,
      reason: input.reason,
      actionKind: input.actionKind,
      actionPayload: (input.actionPayload ?? undefined) as Prisma.InputJsonValue | undefined,
      dueAt: input.dueAt,
      expireAt: input.expireAt,
      occurrenceKey: input.occurrenceKey,
      priority: input.priority ?? 'normal',
      status: input.notifyNow ? 'notified' : 'pending',
      notifiedAt: input.notifyNow ? new Date() : null,
    },
  });

  if (input.notifyNow) {
    await pushReminder(reminder.id, input.channel ?? 'inapp', input.email);
  }
  return { created: true, reminderId: reminder.id };
}

async function pushReminder(
  reminderId: string,
  channel: string,
  email?: string,
): Promise<void> {
  const reminder = await prisma.reminder.findUnique({ where: { id: reminderId } });
  if (!reminder) return;
  await notify({
    userId: reminder.userId,
    email,
    title: reminder.title,
    body: reminder.body,
    reason: reminder.reason,
    reminderId: reminder.id,
    actionKind: reminder.actionKind,
    actionPayload: reminder.actionPayload as Record<string, unknown> | null,
    channel,
  });
}

/** 把待办提醒推给用户（到期扫描与提前提醒都走这里） */
export async function markNotified(reminderId: string): Promise<void> {
  const reminder = await prisma.reminder.update({
    where: { id: reminderId },
    data: { status: 'notified', notifiedAt: new Date() },
  });
  publishToUser(reminder.userId, {
    type: 'reminder.updated',
    payload: { reminderId: reminder.id, status: reminder.status },
  });
}

export interface ScanResult {
  scannedWardrobes: number;
  created: number;
  notified: number;
  expired: number;
  skipped: number;
}

/** 每小时扫描：生成新提醒 → 到期推送 → 超时失效 */
export async function runReminderScan(options: { now?: Date } = {}): Promise<ScanResult> {
  const now = options.now ?? new Date();
  const result: ScanResult = { scannedWardrobes: 0, created: 0, notified: 0, expired: 0, skipped: 0 };

  const wardrobes = await prisma.wardrobe.findMany({
    include: {
      owner: { select: { id: true, email: true, timezone: true } },
      members: { include: { user: { select: { id: true, email: true, timezone: true } } } },
      reminderRules: { where: { isEnabled: true } },
    },
  });

  for (const wardrobe of wardrobes) {
    result.scannedWardrobes += 1;
    const owner = wardrobe.owner;
    const today = todayInTimezone(owner.timezone, now);
    const rules = new Map(wardrobe.reminderRules.map((r) => [r.code ?? r.triggerKind, r]));
    const ctx = {
      wardrobeId: wardrobe.id,
      ownerId: owner.id,
      ownerEmail: owner.email,
      today,
      now,
      refresh: (created: boolean) => {
        if (created) result.created += 1;
        else result.skipped += 1;
      },
    };

    // 单条规则出错（数据异常、某个字段缺失）不该让整轮扫描中断：
    // 否则一个坏规则会让所有人的提醒都停摆。
    const guarded = async (label: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        logger.error({ err: error, wardrobeId: wardrobe.id, rule: label }, 'reminder rule failed');
      }
    };

    await guarded('pending_and_expire', () => scanPendingAndExpire(wardrobe.id, now, result));

    const builtinSteps: Array<[string, (ruleId: string, ctx: ScanCtx) => Promise<void>]> = [
      ['R1_repair_followup', scanRepairFollowup],
      ['R2_observation_due', scanObservationDue],
      ['R3_wear_threshold', scanWearThreshold],
      ['R4_wash_cycle', scanWashCycle],
      ['R5_season_switch', scanSeasonSwitch],
      ['R6_pending_damage', scanLongPending],
      ['R7_inventory_low', scanInventoryLow],
      ['R8_lifecycle_review', scanLifecycleReview],
    ];
    for (const [code, run] of builtinSteps) {
      const rule = rules.get(code);
      if (rule) await guarded(code, () => run(rule.id, ctx));
    }

    for (const rule of wardrobe.reminderRules) {
      if (rule.code && rule.code.startsWith('R')) continue;
      if (rule.triggerKind === 'custom') {
        await guarded(`custom:${rule.id}`, () => scanCustomRule(rule.id, ctx));
      }
    }
  }

  return result;
}

interface ScanCtx {
  wardrobeId: string;
  ownerId: string;
  ownerEmail: string;
  today: Date;
  now: Date;
  refresh: (created: boolean) => void;
}

/** 到期推送 + 超时失效：保证没有僵尸待办 */
async function scanPendingAndExpire(wardrobeId: string, now: Date, result: ScanResult): Promise<void> {
  const due = await prisma.reminder.findMany({
    where: {
      wardrobeId,
      status: 'pending',
      dueAt: { lte: now },
      expireAt: { gt: now },
    },
  });
  for (const reminder of due) {
    await markNotified(reminder.id);
    result.notified += 1;
  }

  const expired = await prisma.reminder.updateMany({
    where: { wardrobeId, status: { in: ['pending', 'notified'] }, expireAt: { lte: now } },
    data: {
      status: 'expired',
      handledAt: now,
      resultRef: { expiredReason: '超时未处理，自动失效' } as Prisma.InputJsonValue,
    },
  });
  result.expired += expired.count;
}

async function scanRepairFollowup(ruleId: string, ctx: ScanCtx): Promise<void> {
  const repairs = await prisma.repair.findMany({
    where: {
      status: 'observing',
      damageEvent: { garment: { wardrobeId: ctx.wardrobeId, deletedAt: null } },
    },
    include: {
      damageEvent: {
        include: { garment: { select: { id: true, name: true, code: true } } },
      },
    },
  });

  for (const repair of repairs) {
    const partName = repair.damageEvent.partId ? await partLabel(repair.damageEvent.partId) : null;
    const created = await createReminderIfAbsent({
      wardrobeId: ctx.wardrobeId,
      userId: ctx.ownerId,
      ruleId,
      subjectType: 'repair',
      subjectId: repair.id,
      title: `复检：${repair.damageEvent.garment.name}${partName ? ` 的 ${partName}` : ''}`,
      body: `第 ${repair.round} 轮修补已完成 ${dayKey(repair.observationUntil)} 天观察期，请检查修补处是否还牢固，并填写复检结论。`,
      reason: `命中规则「修补后复检」：${repair.damageEvent.code} 于 ${dayKey(repair.finishedAt)} 修补完成，观察期至 ${dayKey(repair.observationUntil)}。`,
      actionKind: 'open_review_form',
      actionPayload: { repairId: repair.id, garmentId: repair.damageEvent.garment.id },
      dueAt: repair.observationUntil,
      expireAt: addDays(repair.observationUntil, 30),
      occurrenceKey: `followup:repair:${repair.id}`,
      priority: 'high',
      notifyNow: repair.observationUntil.getTime() <= ctx.now.getTime(),
      email: ctx.ownerEmail,
    });
    ctx.refresh(created.created);
  }
}

/** 提前 N 天把提醒推到待办列表（不新建重复提醒） */
async function scanObservationDue(ruleId: string, ctx: ScanCtx): Promise<void> {
  const rule = await prisma.reminderRule.findUnique({ where: { id: ruleId } });
  const advanceDays = Number((rule?.params as Record<string, unknown> | null)?.advanceNoticeDays ?? 2);
  const horizon = addDays(ctx.now, advanceDays);

  const pending = await prisma.reminder.findMany({
    where: {
      wardrobeId: ctx.wardrobeId,
      status: 'pending',
      subjectType: 'repair',
      dueAt: { lte: horizon, gt: ctx.now },
    },
  });
  for (const reminder of pending) {
    await markNotified(reminder.id);
  }
}

async function scanWearThreshold(ruleId: string, ctx: ScanCtx): Promise<void> {
  const repairs = await prisma.repair.findMany({
    where: {
      status: 'observing',
      damageEvent: { garment: { wardrobeId: ctx.wardrobeId, deletedAt: null } },
    },
    include: { damageEvent: { include: { garment: true } } },
  });
  if (repairs.length === 0) return;

  const garmentIds = [...new Set(repairs.map((r) => r.damageEvent.garmentId))];
  const since = new Date(ctx.today.getTime() - 30 * 86_400_000);
  const wears = await prisma.wearLog.groupBy({
    by: ['garmentId'],
    where: { garmentId: { in: garmentIds }, wornOn: { gte: since } },
    _count: { _all: true },
  });
  const wearMap = new Map(wears.map((w) => [w.garmentId, w._count._all]));

  for (const repair of repairs) {
    const count = wearMap.get(repair.damageEvent.garmentId) ?? 0;
    if (count < 8) continue;
    const created = await createReminderIfAbsent({
      wardrobeId: ctx.wardrobeId,
      userId: ctx.ownerId,
      ruleId,
      subjectType: 'repair',
      subjectId: repair.id,
      title: `高频穿着加检：${repair.damageEvent.garment.name}`,
      body: `最近 30 天这件衣服穿了 ${count} 次，修补处还在观察期，建议提前检查一次。`,
      reason: `命中规则「高频穿着加检」：近 30 天穿着 ${count} 次 ≥ 8 次，且存在未复检的修补。`,
      actionKind: 'open_review_form',
      actionPayload: { repairId: repair.id, garmentId: repair.damageEvent.garmentId },
      dueAt: ctx.today,
      expireAt: addDays(ctx.today, 21),
      occurrenceKey: `wearethreshold:repair:${repair.id}:${monthKey(ctx.today)}`,
      notifyNow: true,
      email: ctx.ownerEmail,
    });
    ctx.refresh(created.created);
  }
}

async function scanWashCycle(ruleId: string, ctx: ScanCtx): Promise<void> {
  const garments = await prisma.garment.findMany({
    where: { wardrobeId: ctx.wardrobeId, deletedAt: null, status: { not: 'retired' }, wearsSinceWash: { gt: 0 } },
  });
  const careRules = await prisma.careRule.findMany();
  const materials = await prisma.material.findMany();
  const thresholdByMaterial = new Map(careRules.map((r) => [r.materialCode, r.wearCountBeforeWash]));
  const adviceByMaterial = new Map(materials.map((m) => [m.code, m.washAdvice]));

  for (const garment of garments) {
    const threshold = thresholdByMaterial.get(garment.materialPrimary) ?? 3;
    if (garment.wearsSinceWash < threshold) continue;
    const cycle = Math.floor(garment.wearsSinceWash / threshold);
    const washAdvice = adviceByMaterial.get(garment.materialPrimary);
    const created = await createReminderIfAbsent({
      wardrobeId: ctx.wardrobeId,
      userId: ctx.ownerId,
      ruleId,
      subjectType: 'garment',
      subjectId: garment.id,
      title: `该洗了：${garment.name}`,
      body: `自上次清洗后已穿着 ${garment.wearsSinceWash} 次（建议周期 ${threshold} 次）。洗护建议：${washAdvice ?? '按洗标处理'}。洗完记得点一下「已清洗」，计数器会归零。`,
      reason: `命中规则「洗护周期提醒」：${garment.name} 自上次清洗后穿着 ${garment.wearsSinceWash} 次 ≥ 建议的 ${threshold} 次。`,
      actionKind: 'open_garment',
      actionPayload: { garmentId: garment.id },
      dueAt: ctx.today,
      expireAt: addDays(ctx.today, 14),
      occurrenceKey: `wash:${garment.id}:${cycle}`,
      priority: 'low',
      notifyNow: true,
      email: ctx.ownerEmail,
    });
    ctx.refresh(created.created);
  }
}

async function scanSeasonSwitch(ruleId: string, ctx: ScanCtx): Promise<void> {
  const month = ctx.today.getUTCMonth() + 1;
  if (month !== 3 && month !== 11) return;
  const season = seasonOfMonth(month);
  const targetSeason = month === 3 ? 'winter' : 'summer';
  const garments = await prisma.garment.findMany({
    where: {
      wardrobeId: ctx.wardrobeId,
      deletedAt: null,
      status: { not: 'retired' },
    },
    select: { id: true, seasonTags: true },
  });
  const affected = garments.filter((g) => {
    const tags = Array.isArray(g.seasonTags) ? (g.seasonTags as string[]) : [];
    return tags.includes(targetSeason) || tags.includes('all');
  });
  if (affected.length === 0) return;

  const created = await createReminderIfAbsent({
    wardrobeId: ctx.wardrobeId,
    userId: ctx.ownerId,
    ruleId,
    subjectType: 'wardrobe',
    subjectId: ctx.wardrobeId,
    title: `换季检查（${month} 月）`,
    body: `有 ${affected.length} 件${targetSeason === 'winter' ? '冬装' : '夏装'}需要过季处理：检查有无新破损、按材质清洁、记录收纳位置。`,
    reason: `命中规则「换季检查」：当前为 ${month} 月（${season}），该月需要处理上一季衣物的收纳与检查。`,
    actionKind: 'open_garment',
    actionPayload: { seasonFilter: targetSeason, listUrl: `/garments?season=${targetSeason}` },
    dueAt: ctx.today,
    expireAt: addDays(ctx.today, 45),
    occurrenceKey: `season:${ctx.today.getUTCFullYear()}-${String(month).padStart(2, '0')}`,
    priority: 'normal',
    notifyNow: true,
    email: ctx.ownerEmail,
  });
  ctx.refresh(created.created);
}

async function scanLongPending(ruleId: string, ctx: ScanCtx): Promise<void> {
  const threshold = addDays(ctx.today, -30);
  const damages = await prisma.damageEvent.findMany({
    where: {
      status: 'pending',
      detectedAt: { lte: threshold },
      garment: { wardrobeId: ctx.wardrobeId, deletedAt: null, status: { not: 'retired' } },
    },
    include: { garment: { select: { id: true, name: true } } },
  });
  for (const damage of damages) {
    const created = await createReminderIfAbsent({
      wardrobeId: ctx.wardrobeId,
      userId: ctx.ownerId,
      ruleId,
      subjectType: 'damage_event',
      subjectId: damage.id,
      title: `这件还修吗：${damage.garment.name}`,
      body: `${damage.code} 从 ${dayKey(damage.detectedAt)} 记到现在还没处理。可以现在排期修补，也可以直接登记退役/处置。`,
      reason: '命中规则「长期未处理的破损」：破损登记超过 30 天仍处于待修状态。',
      actionKind: 'open_repair_rework',
      actionPayload: { damageEventId: damage.id, garmentId: damage.garment.id },
      dueAt: ctx.today,
      expireAt: addDays(ctx.today, 30),
      occurrenceKey: `pending:${damage.id}`,
      notifyNow: true,
      email: ctx.ownerEmail,
    });
    ctx.refresh(created.created);
  }
}

async function scanInventoryLow(ruleId: string, ctx: ScanCtx): Promise<void> {
  const inventories = await prisma.fabricInventory.findMany({
    where: { fabricSource: { wardrobeId: ctx.wardrobeId, isActive: true } },
    include: { fabricSource: { select: { name: true, id: true } } },
  });
  for (const inventory of inventories) {
    if (inventory.remainingAmount > inventory.lowStockThreshold) continue;
    const created = await createReminderIfAbsent({
      wardrobeId: ctx.wardrobeId,
      userId: ctx.ownerId,
      ruleId,
      subjectType: 'fabric_inventory',
      subjectId: inventory.id,
      title: `补丁布快用完了：${inventory.fabricSource.name}`,
      body: `剩余 ${inventory.remainingAmount} ${unitLabel(inventory.unit)}，已低于阈值 ${inventory.lowStockThreshold}。补货后点「已补货」，库存会重新计入。`,
      reason: '命中规则「耗材低库存」：余量低于设定的低库存阈值。',
      actionKind: 'open_inventory',
      actionPayload: { inventoryId: inventory.id, fabricSourceId: inventory.fabricSource.id },
      dueAt: ctx.today,
      expireAt: addDays(ctx.today, 60),
      occurrenceKey: `invlow:${inventory.id}:${monthKey(ctx.today)}`,
      priority: 'low',
      notifyNow: true,
      email: ctx.ownerEmail,
    });
    ctx.refresh(created.created);
  }
}

async function scanLifecycleReview(ruleId: string, ctx: ScanCtx): Promise<void> {
  const garments = await prisma.garment.findMany({
    where: { wardrobeId: ctx.wardrobeId, deletedAt: null, status: { not: 'retired' } },
  });
  // 一次性取回这些衣物的修补记录，避免在循环里逐件查库（N+1）
  const garmentIds = garments.map((g) => g.id);
  const repairs = garmentIds.length
    ? await prisma.repair.findMany({
        where: { status: { not: 'superseded' }, damageEvent: { garmentId: { in: garmentIds } } },
        select: { damageEvent: { select: { garmentId: true } } },
      })
    : [];
  const repairCountByGarment = new Map<string, number>();
  for (const repair of repairs) {
    const garmentId = repair.damageEvent.garmentId;
    repairCountByGarment.set(garmentId, (repairCountByGarment.get(garmentId) ?? 0) + 1);
  }

  for (const garment of garments) {
    const repairCount = repairCountByGarment.get(garment.id) ?? 0;
    const start = garment.firstWearDate ?? garment.createdAt;
    const served = Math.round((ctx.today.getTime() - start.getTime()) / 86_400_000);
    if (served < 1095 && repairCount < 3) continue;

    const created = await createReminderIfAbsent({
      wardrobeId: ctx.wardrobeId,
      userId: ctx.ownerId,
      ruleId,
      subjectType: 'garment',
      subjectId: garment.id,
      title: `评估一下：${garment.name}`,
      body: `已服役 ${served} 天、累计修补 ${repairCount} 次。可以看看健康分与每穿成本，再决定继续穿、预防加固还是退役处置。`,
      reason: '命中规则「服役评估」：服役满 3 年或累计修补满 3 次。',
      actionKind: 'open_report',
      actionPayload: { garmentId: garment.id },
      dueAt: ctx.today,
      expireAt: addDays(ctx.today, 90),
      occurrenceKey: `lifecycle:${garment.id}:${ctx.today.getUTCFullYear()}`,
      priority: 'low',
      notifyNow: true,
      email: ctx.ownerEmail,
    });
    ctx.refresh(created.created);
  }
}

async function scanCustomRule(ruleId: string, ctx: ScanCtx): Promise<void> {
  const rule = await prisma.reminderRule.findUnique({ where: { id: ruleId } });
  if (!rule) return;
  const params = (rule.params ?? {}) as Record<string, unknown>;
  if (params.mode !== 'periodic' || !Array.isArray(params.months)) return;
  const month = ctx.today.getUTCMonth() + 1;
  const months = params.months.map(Number);
  if (!months.includes(month)) return;

  const created = await createReminderIfAbsent({
    wardrobeId: ctx.wardrobeId,
    userId: ctx.ownerId,
    ruleId,
    subjectType: 'wardrobe',
    subjectId: ctx.wardrobeId,
    title: rule.name,
    body: String(params.message ?? '按自定义规则进行定期检查。'),
    reason: `命中自定义规则「${rule.name}」（${months.join('、')} 月触发）。`,
    actionKind: 'open_report',
    actionPayload: { scopeFilter: rule.scopeFilter },
    dueAt: ctx.today,
    expireAt: addDays(ctx.today, 60),
    occurrenceKey: `custom:${rule.id}:${monthKey(ctx.today)}`,
    notifyNow: true,
    email: ctx.ownerEmail,
  });
  ctx.refresh(created.created);
}

async function partLabel(partId: string): Promise<string | null> {
  const part = await prisma.part.findUnique({ where: { id: partId }, select: { name: true } });
  return part?.name ?? null;
}

function unitLabel(unit: string): string {
  return unit === 'cm2' ? 'cm²' : unit === 'cm' ? 'cm' : '片';
}

/** 事件驱动提醒（复发预警），在破损登记时调用 */
export async function notifyRecurrence(
  wardrobeId: string,
  userId: string,
  damageId: string,
  garmentId: string,
  garmentName: string,
  partName: string | null,
  email: string,
): Promise<void> {
  const rule = await prisma.reminderRule.findUnique({
    where: { wardrobeId_code: { wardrobeId, code: 'R9_recurrence_warning' } },
  });
  await createReminderIfAbsent({
    wardrobeId,
    userId,
    ruleId: rule?.id ?? null,
    subjectType: 'damage_event',
    subjectId: damageId,
    title: `同一位置又破了：${garmentName}${partName ? ` 的 ${partName}` : ''}`,
    body: '这次是复发。建议对比上一次的针法与布料，考虑换针法或加一层预防性加固；复检时留意是否再次复发。',
    reason: '命中规则「复发预警」：同一衣物、同一部位的同类破损再次发生。',
    actionKind: 'open_garment',
    actionPayload: { garmentId, damageEventId: damageId },
    dueAt: new Date(),
    expireAt: addDays(new Date(), 30),
    occurrenceKey: `recurrence:${damageId}`,
    notifyNow: true,
    email,
  });
}

export async function closeRemindersFor(
  subjectType: ReminderSubjectType,
  subjectId: string,
  resultRef: Record<string, unknown>,
): Promise<number> {
  const closed = await prisma.reminder.updateMany({
    where: { subjectType, subjectId, status: { in: ['pending', 'notified'] } },
    data: { status: 'done', handledAt: new Date(), resultRef: resultRef as Prisma.InputJsonValue },
  });
  return closed.count;
}

export async function expireRemindersFor(subjectType: ReminderSubjectType, subjectId: string, reason: string) {
  await prisma.reminder.updateMany({
    where: { subjectType, subjectId, status: { in: ['pending', 'notified'] } },
    data: { status: 'expired', handledAt: new Date(), resultRef: { expiredReason: reason } as Prisma.InputJsonValue },
  });
}

/** 每日预聚合：刷新健康分缓存（报告页与列表排序用） */
export async function refreshHealthScores(): Promise<number> {
  const wardrobes = await prisma.wardrobe.findMany({ select: { id: true } });
  let updated = 0;
  for (const wardrobe of wardrobes) {
    const dataset = await loadDataset(wardrobe.id, { includeRetired: true });
    const stats = computeAllGarmentStats(dataset);
    for (const [garmentId, garmentStats] of stats) {
      const health = computeHealth(garmentStats);
      await prisma.garment.update({ where: { id: garmentId }, data: { healthScore: health.score } });
      updated += 1;
    }
    logger.debug({ wardrobeId: wardrobe.id, garments: stats.size }, 'health scores refreshed');
  }
  return updated;
}
