#!/usr/bin/env node
/** 手动跑一次提醒扫描（等价于界面上的"立刻检查"） */
import { prisma } from '../src/lib/prisma.js';
import { runReminderScan } from '../src/services/rules/engine.js';
import { logger } from '../src/lib/logger.js';

const result = await runReminderScan();
logger.info(result, 'reminder scan finished');
console.log(JSON.stringify(result, null, 2));
await prisma.$disconnect();
