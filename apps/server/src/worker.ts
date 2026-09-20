/** 单独跑定时任务的进程：多实例部署时用它，避免每个 HTTP 进程都扫一遍提醒 */
import cron from 'node-cron';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { refreshHealthScores, runReminderScan } from './services/rules/engine.js';

async function main() {
  const schedule = cron.validate(env.cronSchedule) ? env.cronSchedule : '0 * * * *';
  if (schedule !== env.cronSchedule) {
    logger.warn({ configured: env.cronSchedule }, 'CRON_SCHEDULE 非法，worker 已回退为每小时一次');
  }
  logger.info({ cron: schedule }, 'worker started');
  cron.schedule(schedule, () => {
    void runReminderScan().then((r) => logger.info(r, 'scan done')).catch((e) => logger.error({ err: e }, 'scan failed'));
  });
  cron.schedule('15 3 * * *', () => {
    void refreshHealthScores().then((c) => logger.info({ count: c }, 'health refreshed')).catch(() => undefined);
  });
  await runReminderScan();
  process.on('SIGINT', () => void prisma.$disconnect().then(() => process.exit(0)));
  process.on('SIGTERM', () => void prisma.$disconnect().then(() => process.exit(0)));
}

main().catch((error) => {
  logger.error({ err: error }, 'worker failed');
  process.exit(1);
});
