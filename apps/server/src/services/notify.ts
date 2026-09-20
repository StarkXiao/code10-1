import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { publishToUser } from './sse.js';

let transporter: nodemailer.Transporter | null = null;

function mailer(): nodemailer.Transporter | null {
  if (!env.smtpUrl) return null;
  transporter ??= nodemailer.createTransport(env.smtpUrl);
  return transporter;
}

export interface NotifyPayload {
  userId: string;
  email?: string;
  title: string;
  body: string;
  reason: string;
  reminderId: string;
  actionKind: string;
  actionPayload?: Record<string, unknown> | null;
  channel: string;
}

/**
 * 通知渠道适配器（项目文档 12.5）：
 *   - 站内提醒写入 reminders 表，由列表接口呈现；
 *   - SSE 实时推送默认开启；
 *   - 邮件 / webhook 仅在配置后启用，未配置即静默跳过。
 */
export async function notify(payload: NotifyPayload): Promise<{ sse: boolean; email: boolean; webhook: boolean }> {
  const result = { sse: false, email: false, webhook: false };

  publishToUser(payload.userId, {
    type: 'reminder.created',
    payload: {
      reminderId: payload.reminderId,
      title: payload.title,
      body: payload.body,
      actionKind: payload.actionKind,
      actionPayload: payload.actionPayload ?? null,
    },
  });
  result.sse = true;

  if (payload.channel === 'inapp_email' || payload.channel === 'inapp_webhook') {
    const target = mailer();
    if (target && payload.email) {
      try {
        await target.sendMail({
          from: env.mailFrom,
          to: payload.email,
          subject: `【衣物修补日志】${payload.title}`,
          text: `${payload.body}\n\n触发原因：${payload.reason}\n\n打开应用处理这条提醒。`,
        });
        result.email = true;
      } catch (error) {
        logger.warn({ err: error }, 'email notify failed');
      }
    }
  }

  if (payload.channel === 'inapp_webhook' && env.webhookUrl) {
    try {
      await fetch(env.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: payload.title,
          body: payload.body,
          reason: payload.reason,
          reminderId: payload.reminderId,
          actionKind: payload.actionKind,
        }),
      });
      result.webhook = true;
    } catch (error) {
      logger.warn({ err: error }, 'webhook notify failed');
    }
  }

  return result;
}
