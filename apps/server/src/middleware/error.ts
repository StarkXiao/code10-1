import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import { HttpError, zodIssues } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { toHttpErrorFromPrisma } from '../lib/prisma-errors.js';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    ok: false,
    error: { code: 'NOT_FOUND', message: `接口不存在：${req.method} ${req.path}` },
    meta: { requestId: req.ctx?.requestId },
  });
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  let status = 500;
  let code = 'INTERNAL';
  let message = '服务器内部错误';
  let details: unknown;

  if (error instanceof HttpError) {
    status = error.status;
    code = error.code;
    message = error.message;
    details = error.details;
  } else if (error instanceof ZodError) {
    status = 422;
    code = 'VALIDATION_FAILED';
    message = '提交的数据不合法';
    details = zodIssues(error);
  } else if (error instanceof MulterError) {
    status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 422;
    code = error.code === 'LIMIT_FILE_SIZE' ? 'UPLOAD_TOO_LARGE' : 'VALIDATION_FAILED';
    message = error.code === 'LIMIT_FILE_SIZE' ? '图片超过大小上限' : `上传失败：${error.message}`;
  } else if (error instanceof Error) {
    // Prisma 的并发/约束错误要翻译成明确的 4xx，而不是笼统的 500
    const mapped = toHttpErrorFromPrisma(error);
    if (mapped) {
      status = mapped.status;
      code = mapped.code;
      message = mapped.message;
      details = mapped.details;
      logger.warn({ err: error, requestId: req.ctx?.requestId }, 'prisma error mapped');
    } else {
      logger.error({ err: error, requestId: req.ctx?.requestId }, 'unhandled error');
    }
  }

  res.status(status).json({
    ok: false,
    error: { code, message, details },
    meta: { requestId: req.ctx?.requestId },
  });
}
