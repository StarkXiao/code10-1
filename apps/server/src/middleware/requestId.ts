import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.header('x-request-id') ?? randomUUID()).slice(0, 64);
  res.locals.requestId = id;
  res.setHeader('x-request-id', id);
  req.ctx = {
    requestId: id,
    userId: '',
    wardrobeId: '',
    email: '',
    timezone: 'Asia/Shanghai',
  };
  next();
}
