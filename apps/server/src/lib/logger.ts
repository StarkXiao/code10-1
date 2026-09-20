import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.nodeEnv === 'test' ? 'silent' : process.env.LOG_LEVEL ?? 'info',
  base: undefined,
});
