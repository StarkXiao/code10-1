import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __gmlPrisma: PrismaClient | undefined;
}

export const prisma =
  globalThis.__gmlPrisma ??
  new PrismaClient({
    // 默认不自己打日志：业务错误由 error 中间件统一记录，
    // 而并发重试（唯一键撞车 → 重算编号）属于预期内的分支，不该刷满日志。
    log: process.env.PRISMA_LOG === 'true' ? ['query', 'warn', 'error'] : [],
  });

if (process.env.NODE_ENV !== 'production') {
  globalThis.__gmlPrisma = prisma;
}

export type Tx = PrismaClient;
