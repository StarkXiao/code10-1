import type { Request } from 'express';
import { env } from '../config/env.js';

/**
 * 解析"对外可访问的来源"。
 *
 * 优先用显式配置的 WEB_ORIGIN；没配就按请求来源推断。
 * 之前这里写死默认 http://localhost:5173，导致单端口部署（Express 同时托管前端）
 * 生成的分享链接指向开发端口，别人根本打不开。
 */
export function resolvePublicOrigin(req: Request): string {
  if (env.webOrigin) return env.webOrigin.replace(/\/+$/u, '');

  const originHeader = req.get('origin');
  if (originHeader) return originHeader.replace(/\/+$/u, '');

  const referer = req.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      /* referer 不合法就退回 Host */
    }
  }

  const host = req.get('host');
  if (host) return `${req.protocol}://${host}`;
  return `http://localhost:${env.port}`;
}
