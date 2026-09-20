/** 测试环境隔离：独立数据库文件 + 独立上传目录，绝不碰开发数据 */
import { resolve } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = `file:${resolve(import.meta.dirname, '../data/test.db')}`;
process.env.UPLOAD_DIR = resolve(import.meta.dirname, '../data/test-uploads');
process.env.JWT_SECRET = 'test-secret';
process.env.CRON_ENABLED = 'false';
process.env.TZ = 'Asia/Shanghai';
process.env.LOG_LEVEL = 'silent';
