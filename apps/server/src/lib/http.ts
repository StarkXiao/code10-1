import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { HttpError, zodIssues } from './errors.js';

export interface ResponseMeta {
  requestId?: string;
  [key: string]: unknown;
}

export function ok<T>(req: Request, res: Response, data: T, meta: ResponseMeta = {}): void {
  res.json({ ok: true, data, meta: { requestId: req.ctx?.requestId, ...meta } });
}

export function created<T>(req: Request, res: Response, data: T, meta: ResponseMeta = {}): void {
  res.status(201).json({ ok: true, data, meta: { requestId: req.ctx?.requestId, ...meta } });
}

/** 统一异步错误捕获：Express 4 不会自动接住 async 抛出的异常 */
export function handler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError('VALIDATION_FAILED', '提交的数据不合法', zodIssues(result.error));
  }
  return result.data;
}

export function parseQuery<S extends ZodTypeAny>(schema: S, query: unknown): z.infer<S> {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw new HttpError('VALIDATION_FAILED', '查询参数不合法', zodIssues(result.error));
  }
  return result.data;
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ZodError) {
    return new HttpError('VALIDATION_FAILED', '提交的数据不合法', zodIssues(error));
  }
  return new HttpError('INTERNAL', '服务器内部错误');
}
