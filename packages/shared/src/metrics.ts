/**
 * 指标口径（项目文档 13.1 / 13.3）。
 * 前后端共用这一份实现，避免"图表一套算法、接口另一套算法"。
 */
import {
  type WearFrequencyBand,
  type WearSession,
  WEAR_SESSION_WEIGHT,
  type Season,
} from './enums.js';

export const MS_PER_DAY = 86_400_000;
export const DAYS_PER_MONTH = 30.44;

export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function startOfDay(value: Date | string): Date {
  const d = toDate(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** 两个日期之间的整天数（含边界修正，永不为负） */
export function daysBetween(from: Date | string, to: Date | string): number {
  const a = startOfDay(from).getTime();
  const b = startOfDay(to).getTime();
  return Math.max(0, Math.round((b - a) / MS_PER_DAY));
}

export function monthsBetween(from: Date | string, to: Date | string): number {
  const a = toDate(from);
  const b = toDate(to);
  const months =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  const dayFraction = (b.getUTCDate() - a.getUTCDate()) / DAYS_PER_MONTH;
  return Math.max((months + dayFraction) / 1, 0);
}

/** 服役天数：首次穿着到今天的自然日跨度（含当天） */
export function serviceDays(firstWearDate: Date | string | null | undefined, today = new Date()): number {
  const start = firstWearDate ? firstWearDate : today;
  return daysBetween(start, today) + 1;
}

export function weightedWearCount(logs: Array<{ session: WearSession }>): number {
  return round2(logs.reduce((sum, log) => sum + (WEAR_SESSION_WEIGHT[log.session] ?? 0.7), 0));
}

/** 月均穿着频次 = 穿着次数 ÷ max(服役月数, 1) */
export function wearFrequencyPerMonth(
  wearCount: number,
  firstWearDate: Date | string | null | undefined,
  today = new Date(),
): number {
  const months = Math.max(monthsBetween(firstWearDate ? firstWearDate : today, today), 1);
  return round2(wearCount / months);
}

export function frequencyBand(perMonth: number): WearFrequencyBand {
  if (perMonth >= 8) return 'high';
  if (perMonth >= 3) return 'medium';
  if (perMonth >= 1) return 'low';
  return 'occasional';
}

export interface CostBreakdown {
  purchasePrice?: number | null;
  repairCost?: number | null;
  materialCost?: number | null;
  residualValue?: number | null;
  wearCount: number;
}

/** 每穿成本 = (购入价 + 修补费 + 耗材估值 − 残值) ÷ 穿着次数 */
export function costPerWear(input: CostBreakdown): number | null {
  if (!input.wearCount || input.wearCount <= 0) return null;
  const total =
    num(input.purchasePrice) + num(input.repairCost) + num(input.materialCost) - num(input.residualValue);
  return round2(Math.max(total, 0) / input.wearCount);
}

export function annualizedCost(costPerWearValue: number | null, perMonth: number): number | null {
  if (costPerWearValue === null) return null;
  return round2(costPerWearValue * perMonth * 12);
}

export interface LifespanInput {
  finishedAt: Date | string;
  /** 下一次同部位同类型破损的发现日期；null 表示尚未复发 */
  nextDamageDetectedAt?: Date | string | null;
  /** 该区间内的穿着次数（可选，用于"按穿着次数"口径） */
  wearsInRange?: number | null;
  today?: Date;
}

export interface LifespanResult {
  days: number;
  censored: boolean;
  wears: number | null;
}

/**
 * 修补寿命。未复发时为右删失，只能记为 "≥ N 天"，
 * 统计平均值时必须单独列示（项目文档 13.1）。
 */
export function repairLifespan(input: LifespanInput): LifespanResult {
  const today = input.today ?? new Date();
  const censored = !input.nextDamageDetectedAt;
  const end = input.nextDamageDetectedAt ?? today;
  return {
    days: daysBetween(input.finishedAt, end),
    censored,
    wears: input.wearsInRange ?? null,
  };
}

/** 复修率 = 复发次数 ÷ 已修补破损事件数 */
export function recurrenceRate(recurrenceCount: number, repairedEventCount: number): number {
  if (repairedEventCount <= 0) return 0;
  return round4(recurrenceCount / repairedEventCount);
}

export interface HealthScoreInput {
  openDamageCount: number;
  repairCount: number;
  serviceDays: number;
  perMonth: number;
}

export interface HealthScoreFactor {
  key: 'damage' | 'repair' | 'service' | 'wear';
  label: string;
  ratio: number;
  weight: number;
  penalty: number;
  detail: string;
}

export interface HealthScoreResult {
  score: number;
  level: 'good' | 'attention' | 'concern' | 'retire';
  advice: string;
  factors: HealthScoreFactor[];
}

const HEALTH_LEVELS: Array<{ min: number; level: HealthScoreResult['level']; advice: string }> = [
  { min: 85, level: 'good', advice: '状态良好，正常穿着，按季检查即可。' },
  { min: 65, level: 'attention', advice: '注意：对高频磨损部位做预防性加固（肘部/膝部/袖口贴衬）。' },
  { min: 40, level: 'concern', advice: '需要关注：优先修补，减少高强度穿着场景。' },
  { min: 0, level: 'retire', advice: '建议评估退役：考虑改抹布 / 捐赠 / 改制 / 回收。' },
];

/** 健康分 = 100 − Σ(分项权重 × 归一化分项值)，见项目文档 13.3 */
export function healthScore(input: HealthScoreInput): HealthScoreResult {
  const damageRatio = clamp01(input.openDamageCount / 3);
  const repairRatio = clamp01(input.repairCount / 5);
  const serviceRatio = clamp01(input.serviceDays / 1825);
  const wearRatio = wearIntensityRatio(input.perMonth);

  const factors: HealthScoreFactor[] = [
    {
      key: 'damage',
      label: '破损密度',
      ratio: round4(damageRatio),
      weight: 25,
      penalty: round2(damageRatio * 25),
      detail: `未终结破损 ${input.openDamageCount} 个（满分阈值 3 个）`,
    },
    {
      key: 'repair',
      label: '修补密度',
      ratio: round4(repairRatio),
      weight: 25,
      penalty: round2(repairRatio * 25),
      detail: `累计修补 ${input.repairCount} 次（满分阈值 5 次）`,
    },
    {
      key: 'service',
      label: '服役时长',
      ratio: round4(serviceRatio),
      weight: 25,
      penalty: round2(serviceRatio * 25),
      detail: `已服役 ${input.serviceDays} 天（满分阈值 1825 天）`,
    },
    {
      key: 'wear',
      label: '穿着强度',
      ratio: round4(wearRatio),
      weight: 25,
      penalty: round2(wearRatio * 25),
      detail: `月均穿着 ${input.perMonth} 次`,
    },
  ];

  const score = Math.max(0, Math.min(100, Math.round(100 - factors.reduce((s, f) => s + f.penalty, 0))));
  const level = HEALTH_LEVELS.find((l) => score >= l.min)!;
  return { score, level: level.level, advice: level.advice, factors };
}

function wearIntensityRatio(perMonth: number): number {
  if (perMonth >= 8) return 1;
  if (perMonth >= 3) return 0.6;
  if (perMonth >= 1) return 0.3;
  return 0.1;
}

/** 由月份推断季节（北半球），用于穿着记录的 season_snapshot */
export function seasonOfMonth(month1to12: number): Season {
  if (month1to12 >= 3 && month1to12 <= 5) return 'spring';
  if (month1to12 >= 6 && month1to12 <= 8) return 'summer';
  if (month1to12 >= 9 && month1to12 <= 11) return 'autumn';
  return 'winter';
}

export function num(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 内部使用：对外统一由 geometry.ts 导出 clamp01，避免 index 重复导出 */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 加权平均（按权重列，权重全为 0 时退化为算术平均） */
export function weightedAverage(items: Array<{ value: number; weight: number }>): number | null {
  const totalWeight = items.reduce((s, i) => s + i.weight, 0);
  if (items.length === 0) return null;
  if (totalWeight <= 0) {
    return round2(items.reduce((s, i) => s + i.value, 0) / items.length);
  }
  return round2(items.reduce((s, i) => s + i.value * i.weight, 0) / totalWeight);
}

/**
 * 右删失样本的聚合：只对非删失样本取平均，
 * 并把删失样本单独报出来（禁止混算）。
 */
export function summarizeLifespans(samples: LifespanResult[]): {
  averageDays: number | null;
  censoredCount: number;
  observedCount: number;
  minObservedDays: number | null;
} {
  const observed = samples.filter((s) => !s.censored);
  const averageDays = observed.length
    ? round2(observed.reduce((sum, s) => sum + s.days, 0) / observed.length)
    : null;
  return {
    averageDays,
    censoredCount: samples.length - observed.length,
    observedCount: observed.length,
    minObservedDays: observed.length ? Math.min(...observed.map((s) => s.days)) : null,
  };
}
