/** 日期口径统一在这里：数据库存 UTC 零点，展示与提醒按用户时区算"本地日期"。 */
import { DAYS_PER_MONTH } from '@gml/shared';

export function parseDateOnly(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  if (!match) return new Date(value);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

export function formatDateOnly(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 指定时区的"今天"（UTC 零点表示），避免跨零点漏提醒 */
export function todayInTimezone(timezone: string, now = new Date()): Date {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** 两个日期相差的月数（小数），用于月均频率 */
export function monthsSpan(from: Date, to: Date): number {
  const months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  const dayFraction = (to.getUTCDate() - from.getUTCDate()) / DAYS_PER_MONTH;
  return Math.max(months + dayFraction, 0);
}

export function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function dayKey(date: Date): string {
  return formatDateOnly(date);
}
