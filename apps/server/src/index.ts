import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { ensureUploadDirs } from './services/image.js';
import { startScheduler } from './jobs/scheduler.js';

async function main() {
  await ensureUploadDirs();
  const app = createApp();

  const server = app.listen(env.port, () => {
    logger.info(
      { port: env.port, env: env.nodeEnv, cron: env.cronEnabled, uploadDir: env.uploadDir },
      `衣物修补日志服务已启动：http://localhost:${env.port}`,
    );
  });

  startScheduler();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error({ err: error }, 'failed to start server');
  process.exit(1);
});
