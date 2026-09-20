<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import * as echarts from 'echarts';
import {
  MATERIAL_PRIMARY_LABEL,
  SEASON_LABEL,
  WEAR_FREQUENCY_BAND_LABEL,
  type MaterialPrimary,
  type Season,
  type WearFrequencyBand,
} from '@gml/shared';
import { analyticsApi } from '../api';
import { messageOf } from '../api/client';
import InsightList from '../components/InsightList.vue';
import EmptyState from '../components/EmptyState.vue';
import type {
  AnalyticsOverview,
  ByFrequencyResponse,
  ByMaterialResponse,
  BySeasonResponse,
  HealthDistributionResponse,
  StitchEffectivenessResponse,
} from '../types';

const router = useRouter();
const dimension = ref<'material' | 'season' | 'frequency'>('material');
const overview = ref<AnalyticsOverview | null>(null);
const byMaterial = ref<ByMaterialResponse | null>(null);
const bySeason = ref<BySeasonResponse | null>(null);
const byFrequency = ref<ByFrequencyResponse | null>(null);
const stitches = ref<StitchEffectivenessResponse | null>(null);
const health = ref<HealthDistributionResponse | null>(null);
const chartRef = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

const currentInsights = computed(() => {
  if (dimension.value === 'material') return byMaterial.value?.insights ?? [];
  if (dimension.value === 'season') return bySeason.value?.insights ?? [];
  return byFrequency.value?.insights ?? [];
});

onMounted(async () => {
  try {
    const [ov, material, season, frequency, stitch, healthData] = await Promise.all([
      analyticsApi.overview(),
      analyticsApi.byMaterial(),
      analyticsApi.bySeason(),
      analyticsApi.byFrequency(),
      analyticsApi.stitchEffectiveness(),
      analyticsApi.healthDistribution(),
    ]);
    overview.value = ov;
    byMaterial.value = material;
    bySeason.value = season;
    byFrequency.value = frequency;
    stitches.value = stitch;
    health.value = healthData;
    renderChart();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
});

watch(dimension, renderChart);

function handleResize(): void {
  chart?.resize();
}

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
  chart?.dispose();
  chart = null;
});

onMounted(() => window.addEventListener('resize', handleResize));

function renderChart(): void {
  if (!chartRef.value) return;
  chart ??= echarts.init(chartRef.value);

  let labels: string[] = [];
  let lifespan: Array<number | null> = [];
  let observed: number[] = [];
  let censored: number[] = [];
  let cost: Array<number | null> = [];

  if (dimension.value === 'material') {
    const rows = byMaterial.value?.rows ?? [];
    labels = rows.map((r) => MATERIAL_PRIMARY_LABEL[r.materialPrimary as MaterialPrimary] ?? r.materialPrimary);
    lifespan = rows.map((r) => r.averageLifespanDays);
    observed = rows.map((r) => r.observedLifespanCount);
    censored = rows.map((r) => r.censoredLifespanCount);
    cost = rows.map((r) => r.averageCostPerWear);
  } else if (dimension.value === 'season') {
    const rows = bySeason.value?.rows ?? [];
    labels = rows.map((r) => SEASON_LABEL[r.season as Season] ?? r.season);
    lifespan = rows.map((r) => r.wearCountPerDamage);
    observed = rows.map((r) => r.damageCount);
    censored = rows.map(() => 0);
    cost = rows.map(() => null);
  } else {
    const rows = byFrequency.value?.rows ?? [];
    labels = rows.map((r) => WEAR_FREQUENCY_BAND_LABEL[r.band as WearFrequencyBand] ?? r.band);
    lifespan = rows.map((r) => r.averageLifespanDays);
    observed = rows.map((r) => r.observedLifespanCount);
    censored = rows.map((r) => r.censoredLifespanCount);
    cost = rows.map((r) => r.averageCostPerWear);
  }

  const title =
    dimension.value === 'material'
      ? '各材质的平均修补寿命（天，仅统计已复发样本）'
      : dimension.value === 'season'
        ? '各季节每多少次穿着出现一次破损（越高越耐用）'
        : '各穿着频率档的平均修补寿命（天）';

  chart.setOption({
    title: { text: title, textStyle: { fontSize: 14 } },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const list = params as Array<{ dataIndex: number; value: number | null; seriesName: string }>;
        const index = list[0]?.dataIndex ?? 0;
        return [
          `<b>${labels[index] ?? ''}</b>`,
          `${title}：${lifespan[index] ?? '—'}`,
          `已复发样本：${observed[index] ?? 0}`,
          `未复发（右删失）：${censored[index] ?? 0}`,
          cost[index] !== null ? `每穿成本：${cost[index]} 元` : '',
        ]
          .filter(Boolean)
          .join('<br/>');
      },
    },
    grid: { left: 48, right: 24, top: 60, bottom: 60 },
    xAxis: { type: 'category', data: labels, axisLabel: { interval: 0, rotate: labels.length > 5 ? 20 : 0 } },
    yAxis: { type: 'value' },
    series: [
      {
        name: '平均修补寿命',
        type: 'bar',
        data: lifespan,
        itemStyle: { color: '#c2410c' },
        label: { show: true, position: 'top', formatter: (p: { value: number | null }) => (p.value === null ? '—' : String(p.value)) },
      },
      {
        name: '未复发（右删失）',
        type: 'bar',
        stack: 'samples',
        data: censored.map((value) => value * 0),
        itemStyle: { color: 'transparent' },
        tooltip: { show: false },
      },
    ],
  });
  chart.resize();
}

function exportCurrent(): void {
  const dataset = dimension.value === 'material' ? 'garments' : dimension.value === 'season' ? 'wears' : 'repairs';
  window.open(`/api/export/wardrobe.csv?dataset=${dataset}&token=${encodeURIComponent(localStorage.getItem('gml.token') ?? '')}`, '_blank');
}

function openGarment(row: { garmentId: string }): void {
  void router.push({ name: 'garment-detail', params: { id: row.garmentId } });
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">长期使用报告</h1>
        <div class="page-subtitle">
          按材质 / 季节 / 穿着频率回答三个问题：哪类布料最容易坏、哪一季最费衣服、多穿到底划不划算
        </div>
      </div>
      <el-button @click="exportCurrent">导出当前维度 CSV</el-button>
    </div>

    <el-card v-if="overview" shadow="never" style="margin-bottom: 12px">
      <div class="stat-row">
        <div class="stat-block">
          <div class="stat-value">{{ overview.overview.garmentCount }}</div>
          <div class="stat-label">衣物（在用 {{ overview.overview.activeCount }} / 退役 {{ overview.overview.retiredCount }}）</div>
        </div>
        <div class="stat-block">
          <div class="stat-value">{{ overview.overview.totalWearCount }}</div>
          <div class="stat-label">累计穿着</div>
        </div>
        <div class="stat-block">
          <div class="stat-value">{{ overview.overview.totalRepairCount }}</div>
          <div class="stat-label">累计修补</div>
        </div>
        <div class="stat-block">
          <div class="stat-value">{{ (overview.overview.recurrenceRate * 100).toFixed(0) }}%</div>
          <div class="stat-label">复修率</div>
        </div>
        <div class="stat-block">
          <div class="stat-value">{{ overview.overview.averageLifespanDays ?? '—' }}</div>
          <div class="stat-label">平均修补寿命（天）</div>
        </div>
        <div class="stat-block">
          <div class="stat-value">{{ overview.overview.censoredLifespanCount }}</div>
          <div class="stat-label">未复发样本（右删失）</div>
        </div>
        <div class="stat-block">
          <div class="stat-value">{{ overview.overview.lifetimeCostPerWear ?? '—' }}</div>
          <div class="stat-label">整体每穿成本</div>
        </div>
      </div>
    </el-card>

    <el-card shadow="never" style="margin-bottom: 12px">
      <template #header>
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px">
          <span>维度</span>
          <el-radio-group v-model="dimension" size="small">
            <el-radio-button label="material">按材质</el-radio-button>
            <el-radio-button label="season">按季节</el-radio-button>
            <el-radio-button label="frequency">按穿着频率</el-radio-button>
          </el-radio-group>
        </div>
      </template>
      <div ref="chartRef" style="width: 100%; height: 320px" />
    </el-card>

    <el-card shadow="never" style="margin-bottom: 12px">
      <template #header>数据说了什么</template>
      <InsightList :insights="currentInsights" />
    </el-card>

    <el-row :gutter="12">
      <el-col :xs="24" :md="12">
        <el-card shadow="never">
          <template #header>针法效果榜（针法 × 材质）</template>
          <EmptyState v-if="!(stitches?.rows.length)" title="还没有复发样本" description="等第一次复发后，这里会告诉你哪种针法在哪种布料上更耐用。" />
          <el-table v-else :data="stitches.rows" size="small" max-height="360">
            <el-table-column prop="stitchCode" label="针法" width="130" />
            <el-table-column label="材质" width="100">
              <template #default="{ row }">{{ MATERIAL_PRIMARY_LABEL[row.materialPrimary as MaterialPrimary] ?? row.materialPrimary }}</template>
            </el-table-column>
            <el-table-column label="平均寿命(天)" width="120">
              <template #default="{ row }">{{ row.averageLifespanDays ?? '—' }}</template>
            </el-table-column>
            <el-table-column label="已复发" width="80" prop="observedCount" />
            <el-table-column label="未复发" width="80" prop="censoredCount" />
          </el-table>
        </el-card>
      </el-col>

      <el-col :xs="24" :md="12">
        <el-card shadow="never">
          <template #header>健康分分布</template>
          <div v-if="health" class="stat-row" style="margin-bottom: 12px">
            <div class="stat-block">
              <div class="stat-value" style="color: #67c23a">{{ health.levels.good ?? 0 }}</div>
              <div class="stat-label">状态良好</div>
            </div>
            <div class="stat-block">
              <div class="stat-value" style="color: #e6a23c">{{ health.levels.attention ?? 0 }}</div>
              <div class="stat-label">注意</div>
            </div>
            <div class="stat-block">
              <div class="stat-value" style="color: #f56c6c">{{ health.levels.concern ?? 0 }}</div>
              <div class="stat-label">需要关注</div>
            </div>
            <div class="stat-block">
              <div class="stat-value" style="color: #909399">{{ health.levels.retire ?? 0 }}</div>
              <div class="stat-label">建议评估退役</div>
            </div>
          </div>
          <el-table v-if="health?.items.length" :data="health.items" size="small" max-height="280" @row-click="openGarment">
            <el-table-column prop="name" label="衣物" />
            <el-table-column prop="score" label="健康分" width="90" />
            <el-table-column label="穿着" width="80" prop="wearCount" />
            <el-table-column label="修补" width="80" prop="repairCount" />
            <el-table-column label="每穿成本" width="100">
              <template #default="{ row }">{{ row.costPerWear ?? '—' }}</template>
            </el-table-column>
          </el-table>
          <EmptyState v-else title="还没有衣物" />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>
