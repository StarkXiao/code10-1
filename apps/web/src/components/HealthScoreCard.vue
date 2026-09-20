<script setup lang="ts">
import { computed } from 'vue';
import type { HealthScore } from '../types';

const props = defineProps<{ health: HealthScore | null; compact?: boolean }>();

const color = computed(() => {
  const score = props.health?.score ?? 0;
  if (score >= 85) return '#67c23a';
  if (score >= 65) return '#e6a23c';
  if (score >= 40) return '#f56c6c';
  return '#909399';
});

const levelLabel = computed(
  () =>
    ({ good: '状态良好', attention: '注意', concern: '需要关注', retire: '建议评估退役' })[
      props.health?.level ?? 'good'
    ],
);
</script>

<template>
  <el-card shadow="never">
    <div style="display: flex; align-items: center; gap: 16px">
      <el-progress type="circle" :percentage="health?.score ?? 0" :width="compact ? 72 : 96" :color="color" />
      <div>
        <div style="font-weight: 600">健康分 {{ health?.score ?? '—' }} · {{ levelLabel }}</div>
        <div class="muted" style="margin-top: 4px">{{ health?.advice ?? '暂无评估' }}</div>
      </div>
    </div>
    <el-collapse v-if="health && !compact" style="margin-top: 12px">
      <el-collapse-item title="评分构成（可自行复算）">
        <el-table :data="health.factors" size="small">
          <el-table-column prop="label" label="分项" width="100" />
          <el-table-column label="归一值" width="90">
            <template #default="{ row }">{{ (row.ratio * 100).toFixed(0) }}%</template>
          </el-table-column>
          <el-table-column prop="weight" label="权重" width="70" />
          <el-table-column label="扣分" width="70">
            <template #default="{ row }">-{{ row.penalty }}</template>
          </el-table-column>
          <el-table-column prop="detail" label="依据" />
        </el-table>
      </el-collapse-item>
    </el-collapse>
  </el-card>
</template>
