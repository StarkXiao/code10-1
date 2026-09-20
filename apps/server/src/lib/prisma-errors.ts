import { Prisma } from '@prisma/client';
import { HttpError, type ErrorCode } from './errors.js';

/** Prisma 已知错误码（只列我们真正会遇到的） */
const PRISMA_CODES = {
  UNIQUE_VIOLATION: 'P2002',
  FOREIGN_KEY_VIOLATION: 'P2003',
  RECORD_NOT_FOUND: 'P2025',
  REQUIRED_RELATION_VIOLATION: 'P2014',
  DB_UNREACHABLE: 'P1001',
  DB_TIMEOUT: 'P1002',
} as const;

function codeOf(error: unknown): string | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code;
  return null;
}

/** 唯一约束冲突（并发重复写入、编号撞车等） */
export function isUniqueViolation(error: unknown, target?: string): boolean {
  if (codeOf(error) !== PRISMA_CODES.UNIQUE_VIOLATION) return false;
  if (!target) return true;
  const meta = (error as Prisma.PrismaClientKnownRequestError).meta as { target?: unknown } | undefined;
  const raw = Array.isArray(meta?.target) ? meta.target.join(',') : String(meta?.target ?? '');
  return raw.includes(target);
}

export function isRecordNotFound(error: unknown): boolean {
  return codeOf(error) === PRISMA_CODES.RECORD_NOT_FOUND;
}

/**
 * 把 Prisma 的底层错误翻译成明确的 HTTP 错误。
 *
 * 没有这层映射时，并发写入（两个标签页同时建档、同一天重复打点）会直接冒成 500，
 * 用户看到的是"服务器内部错误"，而实际上是可预期的冲突。
 */
export function toHttpErrorFromPrisma(error: unknown): HttpError | null {
  const code = codeOf(error);
  if (!code) return null;
  const meta = (error as Prisma.PrismaClientKnownRequestError).meta as
    | { target?: unknown; modelName?: string; field_name?: string }
    | undefined;
  const target = Array.isArray(meta?.target) ? meta.target.join(',') : String(meta?.target ?? '');

  const map: Partial<Record<string, { code: ErrorCode; message: string }>> = {
    [PRISMA_CODES.UNIQUE_VIOLATION]: {
      code: 'CONFLICT',
      message: target.includes('code')
        ? '编号刚刚被占用，请重试一次'
        : '这条记录已经存在（可能是重复提交），请刷新后确认',
    },
    [PRISMA_CODES.FOREIGN_KEY_VIOLATION]: { code: 'CONFLICT', message: '关联的数据不存在或已被删除' },
    [PRISMA_CODES.RECORD_NOT_FOUND]: { code: 'NOT_FOUND', message: '记录不存在或已被删除' },
    [PRISMA_CODES.REQUIRED_RELATION_VIOLATION]: { code: 'CONFLICT', message: '存在关联数据，无法完成该操作' },
    [PRISMA_CODES.DB_UNREACHABLE]: { code: 'INTERNAL', message: '数据库暂时不可用，请稍后重试' },
    [PRISMA_CODES.DB_TIMEOUT]: { code: 'INTERNAL', message: '数据库响应超时，请稍后重试' },
  };

  const mapped = map[code];
  return mapped ? new HttpError(mapped.code, mapped.message, { prismaCode: code, target }) : null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 唯一键撞车时自动重试。
 * 典型场景：两处代码同时生成「衣物编号」「破损编号」「修补轮次」，
 * 这类自动生成的标识不该让用户看到冲突提示，重算一次即可。
 */
export async function withUniqueRetry<T>(run: () => Promise<T>, attempts = 5): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      lastError = error;
      await sleep(15 * attempt);
    }
  }
  throw lastError;
}
