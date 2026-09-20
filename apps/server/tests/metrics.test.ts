import { describe, expect, it } from 'vitest';
import {
  costPerWear,
  daysBetween,
  frequencyBand,
  healthScore,
  recurrenceRate,
  repairLifespan,
  serviceDays,
  summarizeLifespans,
  wearFrequencyPerMonth,
  weightedWearCount,
} from '@gml/shared';

describe('统计口径（项目文档 13.1 / 13.3）', () => {
  it('天数按自然日计算，不受时分秒影响', () => {
    expect(daysBetween('2026-01-01T23:30:00Z', '2026-01-02T00:10:00Z')).toBe(1);
    expect(daysBetween('2026-01-02', '2026-01-01')).toBe(0);
  });

  it('服役天数含当天', () => {
    expect(serviceDays('2026-01-01', new Date('2026-01-01T12:00:00Z'))).toBe(1);
    expect(serviceDays('2026-01-01', new Date('2026-01-31T12:00:00Z'))).toBe(31);
  });

  it('加权穿着次数按时长档加权', () => {
    expect(
      weightedWearCount([{ session: 'full_day' }, { session: 'half_day' }, { session: 'brief' }]),
    ).toBeCloseTo(1.9, 4);
  });

  it('月均频率 = 次数 ÷ 服役月数，且分档符合阈值', () => {
    // 25 天里穿了 8 次 → 约 9.7 次/月 → 高频
    const perMonth = wearFrequencyPerMonth(8, '2026-08-15', new Date('2026-09-09T00:00:00Z'));
    expect(perMonth).toBeGreaterThanOrEqual(8);
    expect(frequencyBand(perMonth)).toBe('high');
    expect(frequencyBand(4)).toBe('medium');
    expect(frequencyBand(1.5)).toBe('low');
    expect(frequencyBand(0.2)).toBe('occasional');
  });

  it('每穿成本 = (购入价 + 修补费 + 耗材 − 残值) ÷ 穿着次数', () => {
    expect(costPerWear({ purchasePrice: 480, repairCost: 5, materialCost: 0, wearCount: 8 })).toBeCloseTo(60.63, 2);
    expect(costPerWear({ purchasePrice: 100, wearCount: 0 })).toBeNull();
  });

  it('修补寿命：复发即为观测样本，未复发为右删失且不混算平均', () => {
    const observed = repairLifespan({ finishedAt: '2026-01-01', nextDamageDetectedAt: '2026-03-01' });
    expect(observed.days).toBe(59);
    expect(observed.censored).toBe(false);

    const censored = repairLifespan({ finishedAt: '2026-01-01', today: new Date('2026-02-01T00:00:00Z') });
    expect(censored.censored).toBe(true);
    expect(censored.days).toBe(31);

    const summary = summarizeLifespans([observed, censored, { ...observed, days: 100 }]);
    expect(summary.observedCount).toBe(2);
    expect(summary.censoredCount).toBe(1);
    // 只对非删失样本取平均：(59 + 100) / 2
    expect(summary.averageDays).toBe(79.5);
  });

  it('复修率 = 复发次数 ÷ 已修补事件数', () => {
    expect(recurrenceRate(1, 2)).toBe(0.5);
    expect(recurrenceRate(1, 0)).toBe(0);
  });

  it('健康分四个分项各占 25 分，且分档建议正确', () => {
    const fresh = healthScore({ openDamageCount: 0, repairCount: 0, serviceDays: 10, perMonth: 0.5 });
    expect(fresh.score).toBe(100 - 0 - 0 - 0 - Math.round(0.1 * 25));
    expect(fresh.factors).toHaveLength(4);

    const worn = healthScore({ openDamageCount: 3, repairCount: 5, serviceDays: 1825, perMonth: 10 });
    expect(worn.score).toBe(0);
    expect(worn.level).toBe('retire');

    const mid = healthScore({ openDamageCount: 1, repairCount: 1, serviceDays: 300, perMonth: 4 });
    expect(mid.score).toBeGreaterThan(40);
    expect(mid.score).toBeLessThan(85);
    expect(mid.factors.map((f) => f.key)).toEqual(['damage', 'repair', 'service', 'wear']);
  });
});
