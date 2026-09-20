<script setup lang="ts">
import type { Insight } from '../types';
defineProps<{ insights: Insight[] }>();
</script>

<template>
  <div v-if="insights.length" style="display: grid; gap: 8px">
    <el-alert
      v-for="(insight, index) in insights"
      :key="index"
      :type="insight.confident ? 'success' : 'info'"
      :closable="false"
      show-icon
      :title="insight.text"
      :description="`样本量 n=${insight.sampleSize}${insight.confident ? '' : '（样本不足，仅供参考）'}`"
    />
  </div>
  <el-empty v-else description="数据还不够，先积累一些修补与穿着记录吧" />
</template>
