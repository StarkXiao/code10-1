import type { Prisma } from '@prisma/client';
import type { ActivityAction } from '@gml/shared';
import { prisma } from './prisma.js';
import { logger } from './logger.js';

type ActivityClient = Prisma.TransactionClient | typeof prisma;

export async function logActivity(input: {
  wardrobeId: string;
  actorId: string;
  entityType: string;
  entityId: string;
  action: ActivityAction;
  diff?: unknown;
  requestId?: string;
}, client: ActivityClient = prisma): Promise<void> {
  try {
    await client.activityLog.create({
      data: {
        wardrobeId: input.wardrobeId,
        actorId: input.actorId,
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        diff: (input.diff ?? undefined) as Prisma.InputJsonValue | undefined,
        requestId: input.requestId,
      },
    });
  } catch (error) {
    // 审计日志写失败不应该让"已经成功的业务操作"变成 500：
    // 记录一条告警即可，业务结果照常返回。
    logger.warn(
      { err: error, entityType: input.entityType, entityId: input.entityId, action: input.action },
      'activity log failed',
    );
  }
}
