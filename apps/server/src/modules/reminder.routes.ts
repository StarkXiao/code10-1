import { Router } from 'express';
import { z } from 'zod';
import {
  REMINDER_STATUSES,
  reminderActionSchema,
  reminderCompleteSchema,
  reminderDismissSchema,
  reminderRuleSchema,
  reminderRuleUpdateSchema,
  reminderSnoozeSchema,
} from '@gml/shared';
import { HttpError } from '../lib/errors.js';
import { created, handler, ok, parseBody, parseQuery } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';
import { logActivity } from '../lib/activity.js';
import { parseDateOnly } from '../lib/date.js';
import { requireAuth } from '../middleware/auth.js';
import { runReminderScan } from '../services/rules/engine.js';
import { performReview } from '../services/review.js';
import { subscribe } from '../services/sse.js';

export const reminderRouter = Router();
reminderRouter.use(requireAuth);

reminderRouter.get(
  '/',
  handler(async (req, res) => {
    const query = parseQuery(
      z.object({
        scope: z.enum(['all', 'today', 'overdue', 'upcoming', 'done', 'expired']).default('today'),
        status: z.enum(REMINDER_STATUSES).optional(),
        subjectType: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
      }),
      req.query,
    );
    const now = new Date();
    const endOfToday = new Date(now.getTime() + 86_400_000);
    const horizon = new Date(now.getTime() + 7 * 86_400_000);

    const scopeWhere =
      query.scope === 'overdue'
        ? { status: { in: ['pending', 'notified'] as string[] }, dueAt: { lt: now } }
        : query.scope === 'today'
          ? { status: { in: ['pending', 'notified'] as string[] }, dueAt: { lt: endOfToday } }
          : query.scope === 'upcoming'
            ? { status: { in: ['pending', 'notified'] as string[] }, dueAt: { gte: endOfToday, lte: horizon } }
            : query.scope === 'done'
              ? { status: { in: ['done', 'dismissed', 'snoozed'] as string[] } }
              : query.scope === 'expired'
                ? { status: 'expired' }
                : {};

    const reminders = await prisma.reminder.findMany({
      where: {
        wardrobeId: req.ctx.wardrobeId,
        ...scopeWhere,
        ...(query.status ? { status: query.status } : {}),
        ...(query.subjectType ? { subjectType: query.subjectType } : {}),
      },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
      take: query.limit,
    });
    ok(req, res, {
      items: reminders.map((r) => ({ ...r, isMine: r.userId === req.ctx.userId, isOverdue: r.dueAt < now })),
      serverTime: now,
    });
  }),
);

reminderRouter.get(
  '/summary',
  handler(async (req, res) => {
    const now = new Date();
    const endOfToday = new Date(now.getTime() + 86_400_000);
    const [overdue, today, upcoming, done] = await Promise.all([
      prisma.reminder.count({
        where: { wardrobeId: req.ctx.wardrobeId, status: { in: ['pending', 'notified'] }, dueAt: { lt: now } },
      }),
      prisma.reminder.count({
        where: {
          wardrobeId: req.ctx.wardrobeId,
          status: { in: ['pending', 'notified'] },
          dueAt: { gte: now, lt: endOfToday },
        },
      }),
      prisma.reminder.count({
        where: {
          wardrobeId: req.ctx.wardrobeId,
          status: { in: ['pending', 'notified'] },
          dueAt: { gte: endOfToday },
        },
      }),
      prisma.reminder.count({ where: { wardrobeId: req.ctx.wardrobeId, status: 'done' } }),
    ]);
    ok(req, res, { overdue, today, upcoming, done, badge: overdue + today });
  }),
);

reminderRouter.post(
  '/:id/complete',
  handler(async (req, res) => {
    const reminder = await findReminderOrThrow(req.params.id, req.ctx.wardrobeId);
    assertOpen(reminder.status);
    const body = parseBody(reminderCompleteSchema, req.body ?? {});
    const updated = await prisma.reminder.update({
      where: { id: reminder.id },
      data: {
        status: 'done',
        handledAt: new Date(),
        handledBy: req.ctx.userId,
        resultRef: { ...(body.resultRef ?? {}), note: body.note ?? null } as never,
      },
    });
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'reminder',
      entityId: reminder.id,
      action: 'status_change',
      diff: { to: 'done' },
      requestId: req.ctx.requestId,
    });
    ok(req, res, { reminder: updated });
  }),
);

reminderRouter.post(
  '/:id/snooze',
  handler(async (req, res) => {
    const reminder = await findReminderOrThrow(req.params.id, req.ctx.wardrobeId);
    assertOpen(reminder.status);
    const body = parseBody(reminderSnoozeSchema, req.body);
    const snoozeUntil = parseDateOnly(body.snoozeUntil);
    if (snoozeUntil.getTime() <= Date.now()) {
      throw new HttpError('VALIDATION_FAILED', '顺延时间必须晚于现在');
    }
    const updated = await prisma.reminder.update({
      where: { id: reminder.id },
      data: {
        status: 'snoozed',
        snoozeUntil,
        handledAt: new Date(),
        handledBy: req.ctx.userId,
        resultRef: { note: body.note ?? null } as never,
      },
    });
    // 顺延 = 生成下一轮（用新的 occurrenceKey），保证这条提醒有终态、下一轮又会重新出现。
    // 过期时间必须跟着顺延时间走，否则新提醒会被下一次扫描立刻判成「超时失效」。
    const nextExpireAt = new Date(Math.max(reminder.expireAt.getTime(), snoozeUntil.getTime() + 30 * 86_400_000));
    const next = await prisma.reminder.upsert({
      where: {
        subjectType_subjectId_occurrenceKey: {
          subjectType: reminder.subjectType,
          subjectId: reminder.subjectId,
          occurrenceKey: `${reminder.occurrenceKey}:snooze:${body.snoozeUntil}`,
        },
      },
      create: {
        wardrobeId: reminder.wardrobeId,
        userId: reminder.userId,
        ruleId: reminder.ruleId,
        subjectType: reminder.subjectType,
        subjectId: reminder.subjectId,
        title: reminder.title,
        body: reminder.body,
        reason: `${reminder.reason}（由 ${reminder.id} 顺延而来）`,
        actionKind: reminder.actionKind,
        actionPayload: reminder.actionPayload as never,
        dueAt: snoozeUntil,
        expireAt: nextExpireAt,
        status: 'pending',
        occurrenceKey: `${reminder.occurrenceKey}:snooze:${body.snoozeUntil}`,
        priority: reminder.priority,
      },
      update: {},
    });
    ok(req, res, {
      reminder: updated,
      nextReminderId: next.id,
      nextReminderDueAt: next.dueAt,
      nextReminderExpireAt: next.expireAt,
    });
  }),
);

reminderRouter.post(
  '/:id/dismiss',
  handler(async (req, res) => {
    const reminder = await findReminderOrThrow(req.params.id, req.ctx.wardrobeId);
    assertOpen(reminder.status);
    const body = parseBody(reminderDismissSchema, req.body);
    const updated = await prisma.reminder.update({
      where: { id: reminder.id },
      data: {
        status: 'dismissed',
        handledAt: new Date(),
        handledBy: req.ctx.userId,
        dismissReason: body.reason,
        dismissNote: body.note ?? null,
      },
    });
    await logActivity({
      wardrobeId: req.ctx.wardrobeId,
      actorId: req.ctx.userId,
      entityType: 'reminder',
      entityId: reminder.id,
      action: 'status_change',
      diff: { to: 'dismissed', reason: body.reason },
      requestId: req.ctx.requestId,
    });
    ok(req, res, { reminder: updated });
  }),
);

/** 一键执行：提醒不是"消息"，而是可以直接把事做完的入口 */
reminderRouter.post(
  '/:id/action',
  handler(async (req, res) => {
    const reminder = await findReminderOrThrow(req.params.id, req.ctx.wardrobeId);
    assertOpen(reminder.status);
    const body = parseBody(reminderActionSchema, req.body ?? {});

    if (body.review) {
      if (reminder.subjectType !== 'repair') {
        throw new HttpError('VALIDATION_FAILED', '这条提醒不是复检类提醒，无法直接提交复检结论');
      }
      const outcome = await performReview({
        repairId: reminder.subjectId,
        wardrobeId: req.ctx.wardrobeId,
        userId: req.ctx.userId,
        email: req.ctx.email,
        requestId: req.ctx.requestId,
        input: body.review,
        sourceReminderId: reminder.id,
      });
      created(req, res, { outcome, reminderId: reminder.id });
      return;
    }

    const updated = await prisma.reminder.update({
      where: { id: reminder.id },
      data: {
        status: body.note ? 'done' : 'notified',
        handledAt: body.note ? new Date() : null,
        handledBy: body.note ? req.ctx.userId : null,
        resultRef: body.note ? ({ note: body.note } as never) : undefined,
      },
    });
    ok(req, res, {
      reminder: updated,
      target: { actionKind: reminder.actionKind, actionPayload: reminder.actionPayload },
    });
  }),
);

export const reminderRuleRouter = Router();
reminderRuleRouter.use(requireAuth);

reminderRuleRouter.get(
  '/',
  handler(async (req, res) => {
    const rules = await prisma.reminderRule.findMany({
      where: { wardrobeId: req.ctx.wardrobeId },
      orderBy: [{ isBuiltin: 'desc' }, { createdAt: 'asc' }],
      include: { _count: { select: { reminders: true } } },
    });
    const stats = await prisma.reminder.groupBy({
      by: ['ruleId', 'status'],
      where: { wardrobeId: req.ctx.wardrobeId },
      _count: { _all: true },
    });
    ok(req, res, {
      rules: rules.map((rule) => ({
        ...rule,
        reminderCount: rule._count.reminders,
        byStatus: Object.fromEntries(
          stats.filter((s) => s.ruleId === rule.id).map((s) => [s.status, s._count._all]),
        ),
      })),
    });
  }),
);

reminderRuleRouter.post(
  '/',
  handler(async (req, res) => {
    const body = parseBody(reminderRuleSchema, req.body);
    const rule = await prisma.reminderRule.create({
      data: {
        wardrobeId: req.ctx.wardrobeId,
        code: null,
        name: body.name,
        triggerKind: body.triggerKind,
        params: body.params as never,
        scopeFilter: body.scopeFilter as never,
        scheduleCron: body.scheduleCron,
        channel: body.channel,
        priority: body.priority,
        isEnabled: body.isEnabled,
        isBuiltin: false,
      },
    });
    created(req, res, { rule });
  }),
);

reminderRuleRouter.patch(
  '/:id',
  handler(async (req, res) => {
    const rule = await prisma.reminderRule.findFirst({
      where: { id: req.params.id, wardrobeId: req.ctx.wardrobeId },
    });
    if (!rule) throw new HttpError('NOT_FOUND', '提醒规则不存在');
    const body = parseBody(reminderRuleUpdateSchema, req.body);
    const updated = await prisma.reminderRule.update({
      where: { id: rule.id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.triggerKind ? { triggerKind: body.triggerKind } : {}),
        ...(body.params ? { params: body.params as never } : {}),
        ...(body.scopeFilter ? { scopeFilter: body.scopeFilter as never } : {}),
        ...(body.scheduleCron ? { scheduleCron: body.scheduleCron } : {}),
        ...(body.channel ? { channel: body.channel } : {}),
        ...(body.priority ? { priority: body.priority } : {}),
        ...(body.isEnabled !== undefined ? { isEnabled: body.isEnabled } : {}),
      },
    });
    ok(req, res, { rule: updated });
  }),
);

reminderRuleRouter.delete(
  '/:id',
  handler(async (req, res) => {
    const rule = await prisma.reminderRule.findFirst({
      where: { id: req.params.id, wardrobeId: req.ctx.wardrobeId },
    });
    if (!rule) throw new HttpError('NOT_FOUND', '提醒规则不存在');
    if (rule.isBuiltin) {
      const updated = await prisma.reminderRule.update({ where: { id: rule.id }, data: { isEnabled: false } });
      ok(req, res, { rule: updated, disabled: true, note: '内置规则不能删除，已改为停用；历史提醒保留' });
      return;
    }
    await prisma.reminderRule.delete({ where: { id: rule.id } });
    ok(req, res, { deleted: true });
  }),
);

reminderRuleRouter.post(
  '/run-now',
  handler(async (req, res) => {
    const result = await runReminderScan();
    ok(req, res, result);
  }),
);

export const eventsRouter = Router();

/** SSE：提醒实时推送（断线自动重连，前端有轮询兜底） */
eventsRouter.get(
  '/',
  requireAuth,
  handler(async (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders?.();
    res.write(`event: ping\ndata: {"connectedAt":"${new Date().toISOString()}"}\n\n`);

    const unsubscribe = subscribe(req.ctx.userId, res);
    const heartbeat = setInterval(() => {
      res.write('event: ping\ndata: {"t":1}\n\n');
    }, 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }),
);

async function findReminderOrThrow(id: string, wardrobeId: string) {
  const reminder = await prisma.reminder.findFirst({ where: { id, wardrobeId } });
  if (!reminder) throw new HttpError('NOT_FOUND', '提醒不存在');
  return reminder;
}

function assertOpen(status: string): void {
  if (!['pending', 'notified'].includes(status)) {
    throw new HttpError('REMINDER_ALREADY_HANDLED', '这条提醒已经处理过了');
  }
}
