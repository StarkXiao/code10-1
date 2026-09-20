import cron from 'node-cron';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { runReminderScan, refreshHealthScores } from '../services/rules/engine.js';

let started = false;

/** 每小时扫描提醒；每天凌晨刷新健康分。启动时先跑一次，保证打开即有数据。 */
export function startScheduler(): void {
  if (started || !env.cronEnabled) return;
  started = true;

  // 配置写错时不要让整个服务起不来：退回每小时一次并留下告警
  const schedule = cron.validate(env.cronSchedule) ? env.cronSchedule : '0 * * * *';
  if (schedule !== env.cronSchedule) {
    logger.warn({ configured: env.cronSchedule }, 'CRON_SCHEDULE 不是合法的 cron 表达式，已回退为每小时一次');
  }

  cron.schedule(schedule, () => {
    void runReminderScan()
      .then((result) => {
        if (result.created || result.notified || result.expired) {
          logger.info(result, 'reminder scan finished');
        }
      })
      .catch((error) => logger.error({ err: error }, 'reminder scan failed'));
  });

  cron.schedule('15 3 * * *', () => {
    void refreshHealthScores()
      .then((count) => logger.info({ count }, 'health scores refreshed'))
      .catch((error) => logger.error({ err: error }, 'health refresh failed'));
  });

  void runReminderScan()
    .then((result) => logger.info(result, 'initial reminder scan finished'))
    .catch((error) => logger.error({ err: error }, 'initial reminder scan failed'));

  logger.info({ cron: schedule }, 'scheduler started');
}
