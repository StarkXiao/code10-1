/**
 * 长期使用分析（项目文档 13.2 / 13.4）。
 * 三个维度：材质 / 季节 / 穿着频率，外加"针法效果榜"。
 * 所有结论句都带样本量 n；n < 3 时显式提示样本不足。
 */
import {
  seasonOfMonth,
  summarizeLifespans,
  weightedAverage,
  type WearFrequencyBand,
  type Season,
} from '@gml/shared';
import { prisma } from '../lib/prisma.js';
import {
  computeAllGarmentStats,
  computeHealth,
  loadDataset,
  round2,
  type Dataset,
  type GarmentStats,
} from './stats.js';

export interface Insight {
  text: string;
  sampleSize: number;
  confident: boolean;
}

function insight(text: string, sampleSize: number): Insight {
  return { text: sampleSize < 3 ? `${text}（样本不足，仅供参考）` : text, sampleSize, confident: sampleSize >= 3 };
}

export interface MaterialRow {
  materialPrimary: string;
  garmentCount: number;
  wearCount: number;
  repairCount: number;
  recurrenceRate: number;
  averageLifespanDays: number | null;
  censoredLifespanCount: number;
  observedLifespanCount: number;
  averageCostPerWear: number | null;
  topDamageTypes: Array<{ key: string; count: number }>;
  topParts: Array<{ key: string; count: number }>;
}

export async function byMaterial(wardrobeId: string, today = new Date()) {
  const dataset = await loadDataset(wardrobeId);
  const stats = computeAllGarmentStats(dataset, today);
  return aggregateByMaterial(dataset, stats);
}

export function aggregateByMaterial(dataset: Dataset, stats: Map<string, GarmentStats>) {
  const groups = new Map<string, GarmentStats[]>();
  for (const garment of dataset.garments) {
    const key = garment.materialPrimary;
    const list = groups.get(key) ?? [];
    list.push(stats.get(garment.id)!);
    groups.set(key, list);
  }

  const rows: MaterialRow[] = [];
  for (const [materialPrimary, list] of groups) {
    const samples = list.flatMap((s) => s.lifespanSamples);
    const lifespan = summarizeLifespans(samples);
    const damageTypeCounts = mergeCounts(list.map((s) => s.typeDamageCounts));
    const partCounts = mergeCounts(list.map((s) => s.partDamageCounts));
    rows.push({
      materialPrimary,
      garmentCount: list.length,
      wearCount: list.reduce((sum, s) => sum + s.wearCount, 0),
      repairCount: list.reduce((sum, s) => sum + s.repairCount, 0),
      recurrenceRate: weightedAverage(
        list.map((s) => ({ value: s.recurrenceRate, weight: s.repairedEventCount })),
      ) ?? 0,
      averageLifespanDays: lifespan.averageDays,
      censoredLifespanCount: lifespan.censoredCount,
      observedLifespanCount: lifespan.observedCount,
      averageCostPerWear:
        weightedAverage(
          list.filter((s) => s.costPerWear !== null).map((s) => ({ value: s.costPerWear!, weight: s.wearCount })),
        ) ?? null,
      topDamageTypes: topN(damageTypeCounts, 3),
      topParts: topN(partCounts, 3),
    });
  }
  rows.sort((a, b) => b.garmentCount - a.garmentCount);

  const insights: Insight[] = [];
  const withLifespan = rows.filter((r) => r.averageLifespanDays !== null && r.observedLifespanCount > 0);
  if (withLifespan.length > 0) {
    const worst = withLifespan.reduce((a, b) => (a.averageLifespanDays! <= b.averageLifespanDays! ? a : b));
    insights.push(
      insight(
        `${labelOfMaterial(worst.materialPrimary)}的修补寿命最短：平均 ${worst.averageLifespanDays} 天，复修率 ${(worst.recurrenceRate * 100).toFixed(0)}%。`,
        worst.observedLifespanCount,
      ),
    );
  }
  const withCensored = rows.filter((r) => r.censoredLifespanCount > 0);
  if (withCensored.length > 0) {
    const total = withCensored.reduce((sum, r) => sum + r.censoredLifespanCount, 0);
    insights.push(
      insight(`还有 ${total} 次修补尚未复发（右删失样本），暂不计入平均寿命，只记为"至少撑了这么久"。`, total),
    );
  }
  const topPart = rows.flatMap((r) => r.topParts.map((p) => ({ ...p, material: r.materialPrimary })))[0];
  if (topPart) {
    insights.push(
      insight(`最常出问题的部位是 ${topPart.key}（${topPart.count} 次），优先在这里做预防性加固。`, topPart.count),
    );
  }

  return { rows, insights };
}

export async function bySeason(wardrobeId: string, today = new Date()) {
  const dataset = await loadDataset(wardrobeId);
  const stats = computeAllGarmentStats(dataset, today);
  return aggregateBySeason(dataset, stats);
}

export function aggregateBySeason(dataset: Dataset, stats: Map<string, GarmentStats>) {
  const seasons: Season[] = ['spring', 'summer', 'autumn', 'winter'];
  const wearBySeason = new Map<string, number>(seasons.map((s) => [s, 0]));
  for (const wear of dataset.wears) {
    wearBySeason.set(wear.seasonSnapshot, (wearBySeason.get(wear.seasonSnapshot) ?? 0) + 1);
  }
  const damageBySeason = new Map<string, number>(seasons.map((s) => [s, 0]));
  for (const damage of dataset.damages) {
    const season = seasonOfMonth(damage.detectedAt.getUTCMonth() + 1);
    damageBySeason.set(season, (damageBySeason.get(season) ?? 0) + 1);
  }

  const rows = seasons.map((season) => {
    const wearCount = wearBySeason.get(season) ?? 0;
    const damageCount = damageBySeason.get(season) ?? 0;
    const garmentCount = dataset.garments.filter((g) =>
      (Array.isArray(g.seasonTags) ? (g.seasonTags as string[]) : []).includes(season),
    ).length;
    return {
      season,
      garmentCount,
      wearCount,
      damageCount,
      /** 每 N 次穿着出现一次破损，越小越容易坏 */
      wearCountPerDamage: damageCount > 0 ? round2(wearCount / damageCount) : null,
      wearShare: dataset.wears.length > 0 ? round2(wearCount / dataset.wears.length) : 0,
    };
  });

  const insights: Insight[] = [];
  const ranked = rows.filter((r) => r.wearCountPerDamage !== null).sort(
    (a, b) => (a.wearCountPerDamage ?? 0) - (b.wearCountPerDamage ?? 0),
  );
  if (ranked.length > 0) {
    const worst = ranked[0];
    insights.push(
      insight(
        `${labelOfSeason(worst.season)}最容易出问题：平均每 ${worst.wearCountPerDamage} 次穿着就有一次破损（该季共 ${worst.wearCount} 次穿着、${worst.damageCount} 次破损）。`,
        worst.damageCount,
      ),
    );
  }
  const mostWorn = [...rows].sort((a, b) => b.wearCount - a.wearCount)[0];
  if (mostWorn && mostWorn.wearCount > 0) {
    insights.push(
      insight(
        `${labelOfSeason(mostWorn.season)}是穿着主力季，占全部穿着的 ${(mostWorn.wearShare * 100).toFixed(0)}%。`,
        mostWorn.wearCount,
      ),
    );
  }
  const statValues = [...stats.values()];
  const unused = statValues.filter((s) => s.wearCount === 0).length;
  if (unused > 0) {
    insights.push(insight(`有 ${unused} 件衣物在档案里但一次都没穿过，可以考虑处置。`, unused));
  }
  return { rows, insights };
}

export async function byFrequency(wardrobeId: string, today = new Date()) {
  const dataset = await loadDataset(wardrobeId);
  const stats = computeAllGarmentStats(dataset, today);
  return aggregateByFrequency(dataset, stats);
}

export function aggregateByFrequency(dataset: Dataset, stats: Map<string, GarmentStats>) {
  const bands: WearFrequencyBand[] = ['high', 'medium', 'low', 'occasional'];
  const rows = bands.map((band) => {
    const list = [...stats.values()].filter((s) => s.frequencyBand === band);
    const samples = list.flatMap((s) => s.lifespanSamples);
    const lifespan = summarizeLifespans(samples);
    const costSamples = list.filter((s) => s.costPerWear !== null);
    const wearInBand = list.reduce((sum, s) => sum + s.wearCount, 0);
    return {
      band,
      garmentCount: list.length,
      wearCount: wearInBand,
      wearShare: dataset.wears.length > 0 ? round2(wearInBand / dataset.wears.length) : 0,
      averageRepairCount: list.length
        ? round2(list.reduce((sum, s) => sum + s.repairCount, 0) / list.length)
        : 0,
      averageLifespanDays: lifespan.averageDays,
      observedLifespanCount: lifespan.observedCount,
      censoredLifespanCount: lifespan.censoredCount,
      averageCostPerWear:
        weightedAverage(costSamples.map((s) => ({ value: s.costPerWear!, weight: Math.max(s.wearCount, 1) }))) ??
        null,
      averageHealthScore: list.length
        ? Math.round(list.reduce((sum, s) => sum + computeHealth(s).score, 0) / list.length)
        : null,
      garmentIds: list.map((s) => s.garmentId),
    };
  });

  const insights: Insight[] = [];
  const high = rows.find((r) => r.band === 'high');
  const low = rows.find((r) => r.band === 'low');
  if (high && high.garmentCount > 0 && low && low.garmentCount > 0) {
    insights.push(
      insight(
        `高频组平均修补 ${high.averageRepairCount} 次，低频组 ${low.averageRepairCount} 次——穿得多确实更容易坏，但高频组的每穿成本更低（${high.averageCostPerWear ?? '-'} vs ${low.averageCostPerWear ?? '-'}）。`,
        high.garmentCount,
      ),
    );
  } else if (high && high.garmentCount > 0) {
    insights.push(
      insight(
        `高频组共 ${high.garmentCount} 件，平均修补 ${high.averageRepairCount} 次，平均每穿成本 ${high.averageCostPerWear ?? '-'}。`,
        high.garmentCount,
      ),
    );
  }
  const lowUse = rows.find((r) => r.band === 'occasional');
  if (lowUse && lowUse.garmentCount > 0) {
    insights.push(
      insight(`有 ${lowUse.garmentCount} 件属于"偶发穿着"，长期占着衣柜但每穿成本最高，值得优先处置。`, lowUse.garmentCount),
    );
  }
  return { rows, insights };
}

export async function stitchEffectiveness(wardrobeId: string, today = new Date()) {
  const dataset = await loadDataset(wardrobeId);
  const stats = computeAllGarmentStats(dataset, today);
  const samples = [...stats.values()].flatMap((s) => s.lifespanSamples);
  const stitchRows = await prisma.stitch.findMany();
  const garmentRows = dataset.garments;

  const groups = new Map<string, typeof samples>();
  for (const sample of samples) {
    const garment = garmentRows.find((g) => g.id === sample.garmentId);
    const stitch = stitchRows.find((s) => s.id === sample.stitchCode);
    const key = `${stitch?.code ?? sample.stitchCode}|${garment?.materialPrimary ?? sample.materialPrimary}`;
    const list = groups.get(key) ?? [];
    list.push(sample);
    groups.set(key, list);
  }

  const rows = [...groups.entries()].map(([key, list]) => {
    const [stitchCode, materialPrimary] = key.split('|');
    const lifespan = summarizeLifespans(list);
    return {
      stitchCode,
      materialPrimary,
      sampleCount: list.length,
      observedCount: lifespan.observedCount,
      censoredCount: lifespan.censoredCount,
      averageLifespanDays: lifespan.averageDays,
      minObservedDays: lifespan.minObservedDays,
    };
  });
  rows.sort((a, b) => (b.averageLifespanDays ?? -1) - (a.averageLifespanDays ?? -1));

  const insights: Insight[] = [];
  const best = rows.find((r) => r.observedCount >= 3);
  if (best && best.averageLifespanDays !== null) {
    insights.push(
      insight(
        `目前表现最好的组合是「${labelOfStitch(best.stitchCode)} + ${labelOfMaterial(best.materialPrimary)}」：平均 ${best.averageLifespanDays} 天后才复发。`,
        best.observedCount,
      ),
    );
  }
  if (rows.length === 0) {
    insights.push(insight('还没有复发样本，等第一次复发后这里会出现针法效果对比。', 0));
  }
  return { rows, insights };
}

export async function healthDistribution(wardrobeId: string, today = new Date()) {
  const dataset = await loadDataset(wardrobeId);
  const stats = computeAllGarmentStats(dataset, today);
  const levels = { good: 0, attention: 0, concern: 0, retire: 0 } as Record<string, number>;
  const items = dataset.garments.map((garment) => {
    const garmentStats = stats.get(garment.id)!;
    const health = computeHealth(garmentStats);
    levels[health.level] += 1;
    return {
      garmentId: garment.id,
      code: garment.code,
      name: garment.name,
      materialPrimary: garment.materialPrimary,
      score: health.score,
      level: health.level,
      advice: health.advice,
      wearCount: garmentStats.wearCount,
      repairCount: garmentStats.repairCount,
      costPerWear: garmentStats.costPerWear,
      frequencyBand: garmentStats.frequencyBand,
      serviceDays: garmentStats.serviceDays,
    };
  });
  items.sort((a, b) => a.score - b.score);
  return { levels, items };
}

export interface GarmentDetailAnalytics {
  stats: GarmentStats;
  health: ReturnType<typeof computeHealth>;
  lifespan: ReturnType<typeof summarizeLifespans>;
}

export async function garmentAnalytics(garmentId: string): Promise<GarmentDetailAnalytics | null> {
  const garment = await prisma.garment.findFirst({ where: { id: garmentId, deletedAt: null } });
  if (!garment) return null;
  const dataset = await loadDataset(garment.wardrobeId, { includeRetired: true });
  const stats = computeAllGarmentStats(dataset);
  const garmentStats = stats.get(garmentId);
  if (!garmentStats) return null;
  return {
    stats: garmentStats,
    health: computeHealth(garmentStats),
    lifespan: summarizeLifespans(garmentStats.lifespanSamples),
  };
}

function mergeCounts(list: Array<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const counts of list) {
    for (const [key, value] of Object.entries(counts)) out[key] = (out[key] ?? 0) + value;
  }
  return out;
}

function topN(counts: Record<string, number>, n: number): Array<{ key: string; count: number }> {
  return Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

const MATERIAL_LABELS: Record<string, string> = {
  cotton: '棉', wool: '羊毛', cashmere: '羊绒', linen: '亚麻', silk: '真丝',
  polyester: '涤纶', nylon: '锦纶', denim: '牛仔', leather: '皮革', blend: '混纺', other: '其他',
};

const SEASON_LABELS: Record<string, string> = {
  spring: '春季', summer: '夏季', autumn: '秋季', winter: '冬季', all: '四季',
};

const STITCH_LABELS: Record<string, string> = {
  invisible_stitch: '藏针缝', backstitch: '回针缝', running_stitch: '平针缝', overcast: '锁边缝',
  darning_hand: '手工织补', darning_machine: '机器织补', patch_applique: '贴布补丁',
  fusible: '熨烫贴合补', serging: '机器锁边', part_replacement: '换件替换',
};

export function labelOfMaterial(code: string): string {
  return MATERIAL_LABELS[code] ?? code;
}

export function labelOfSeason(code: string): string {
  return SEASON_LABELS[code] ?? code;
}

export function labelOfStitch(code: string): string {
  return STITCH_LABELS[code] ?? code;
}
