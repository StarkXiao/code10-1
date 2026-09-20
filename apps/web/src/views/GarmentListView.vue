<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  GARMENT_CATEGORY_LABEL,
  GARMENT_STATUS_LABEL,
  GARMENT_STATUSES,
  MATERIAL_PRIMARY_LABEL,
  MATERIAL_PRIMARIES,
  SEASON_LABEL,
  SEASONS,
  WEAR_FREQUENCY_BAND_LABEL,
  WEAR_FREQUENCY_BANDS,
  type GarmentCategory,
  type GarmentStatus,
  type MaterialPrimary,
  type Season,
  type WearFrequencyBand,
} from '@gml/shared';
import { garmentApi } from '../api';
import { photoFileUrl } from '../api/client';
import EmptyState from '../components/EmptyState.vue';

const router = useRouter();

const filters = reactive({
  q: '',
  status: '' as GarmentStatus | '',
  material: '' as MaterialPrimary | '',
  season: '' as Season | '',
  frequencyBand: '' as WearFrequencyBand | '',
  includeRetired: false,
  sort: 'recent' as 'recent' | 'health' | 'wear' | 'cost' | 'code',
  page: 1,
  pageSize: 12,
});

const queryKey = computed(() => ['garments', { ...filters }]);
const listQuery = useQuery({
  queryKey,
  queryFn: () =>
    garmentApi.list({
      ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== '' && value !== false)),
      // 筛选"已退役"时自动带上退役数据，否则永远查不到结果
      includeRetired: filters.includeRetired || filters.status === 'retired',
    }),
});

const items = computed(() => listQuery.data.value?.items ?? []);

// 改筛选条件就回到第一页，否则会停在一个"筛选后并不存在"的页码上，看到空白列表
watch(
  () => [
    filters.q,
    filters.status,
    filters.material,
    filters.season,
    filters.frequencyBand,
    filters.sort,
    filters.includeRetired,
  ],
  () => {
    filters.page = 1;
  },
);

function reset(): void {
  filters.q = '';
  filters.status = '';
  filters.material = '';
  filters.season = '';
  filters.frequencyBand = '';
  filters.includeRetired = false;
  filters.sort = 'recent';
  filters.page = 1;
}

function statusType(status: string): 'success' | 'warning' | 'danger' | 'info' | 'primary' {
  if (status === 'active') return 'success';
  if (status === 'retired') return 'info';
  if (status === 'observing') return 'warning';
  return 'danger';
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">衣物档案</h1>
        <div class="page-subtitle">共 {{ listQuery.data.value?.total ?? 0 }} 件 · 可按材质、季节、穿着频率筛选</div>
      </div>
      <el-button type="primary" @click="router.push({ name: 'garment-new' })">新建衣物</el-button>
    </div>

    <el-card shadow="never" style="margin-bottom: 12px">
      <el-form inline>
        <el-form-item label="搜索">
          <el-input v-model="filters.q" placeholder="名称 / 编号 / 品牌" clearable style="width: 180px" @change="filters.page = 1" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable placeholder="全部" style="width: 130px">
            <el-option v-for="item in GARMENT_STATUSES" :key="item" :value="item" :label="GARMENT_STATUS_LABEL[item]" />
          </el-select>
        </el-form-item>
        <el-form-item label="材质">
          <el-select v-model="filters.material" clearable placeholder="全部" style="width: 130px">
            <el-option v-for="item in MATERIAL_PRIMARIES" :key="item" :value="item" :label="MATERIAL_PRIMARY_LABEL[item]" />
          </el-select>
        </el-form-item>
        <el-form-item label="季节">
          <el-select v-model="filters.season" clearable placeholder="全部" style="width: 120px">
            <el-option v-for="item in SEASONS" :key="item" :value="item" :label="SEASON_LABEL[item]" />
          </el-select>
        </el-form-item>
        <el-form-item label="穿着频率">
          <el-select v-model="filters.frequencyBand" clearable placeholder="全部" style="width: 170px">
            <el-option v-for="item in WEAR_FREQUENCY_BANDS" :key="item" :value="item" :label="WEAR_FREQUENCY_BAND_LABEL[item]" />
          </el-select>
        </el-form-item>
        <el-form-item label="排序">
          <el-select v-model="filters.sort" style="width: 140px">
            <el-option value="recent" label="最近更新" />
            <el-option value="health" label="健康分升序" />
            <el-option value="wear" label="穿着次数" />
            <el-option value="cost" label="每穿成本" />
            <el-option value="code" label="编号" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="filters.includeRetired">含已退役</el-checkbox>
        </el-form-item>
        <el-form-item>
          <el-button @click="reset">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-skeleton v-if="listQuery.isLoading.value" :rows="4" animated />

    <el-alert v-else-if="listQuery.isError.value" type="error" :closable="false" title="加载失败">
      {{ (listQuery.error.value as Error)?.message }}
    </el-alert>

    <EmptyState
      v-else-if="items.length === 0"
      title="还没有衣物档案"
      description="建一件衣服，拍几张照片，之后每次破了都能落在同一份档案里。"
    >
      <el-button type="primary" @click="router.push({ name: 'garment-new' })">开始建档</el-button>
    </EmptyState>

    <div v-else class="grid-cards">
      <el-card v-for="item in items" :key="item.id" shadow="hover" body-style="padding:0" style="cursor: pointer" @click="router.push({ name: 'garment-detail', params: { id: item.id } })">
        <div style="height: 150px; background: #f2f3f5; display: flex; align-items: center; justify-content: center; overflow: hidden">
          <img
            v-if="item.thumbPhotoId"
            :src="photoFileUrl(item.thumbPhotoId, 'thumb')"
            style="width: 100%; height: 100%; object-fit: cover"
            :alt="item.name"
          />
          <span v-else class="muted">暂无照片</span>
        </div>
        <div style="padding: 12px">
          <div style="display: flex; justify-content: space-between; gap: 6px; align-items: center">
            <span style="font-weight: 600">{{ item.name }}</span>
            <el-tag size="small" :type="statusType(item.status)">{{ item.statusLabel }}</el-tag>
          </div>
          <div class="muted mono" style="margin-top: 2px">{{ item.code }}</div>
          <div class="muted" style="margin-top: 6px">
            {{ GARMENT_CATEGORY_LABEL[item.category as GarmentCategory] }} ·
            {{ MATERIAL_PRIMARY_LABEL[item.materialPrimary as MaterialPrimary] }} ·
            {{ item.seasonTags.map((s) => SEASON_LABEL[s as Season]).join('/') }}
          </div>
          <div class="stat-row" style="margin-top: 10px; gap: 12px">
            <div class="stat-block">
              <div class="stat-value" style="font-size: 16px">{{ item.wearCount }}</div>
              <div class="stat-label">穿着</div>
            </div>
            <div class="stat-block">
              <div class="stat-value" style="font-size: 16px">{{ item.repairCount }}</div>
              <div class="stat-label">修补</div>
            </div>
            <div class="stat-block">
              <div class="stat-value" style="font-size: 16px">{{ item.healthScore }}</div>
              <div class="stat-label">健康分</div>
            </div>
            <div class="stat-block">
              <div class="stat-value" style="font-size: 16px">{{ item.costPerWear ?? '—' }}</div>
              <div class="stat-label">每穿成本</div>
            </div>
          </div>
          <div class="muted" style="margin-top: 6px">
            {{ WEAR_FREQUENCY_BAND_LABEL[item.frequencyBand as WearFrequencyBand] }} · 月均 {{ item.perMonth }} 次
            <span v-if="item.openDamageCount > 0" style="color: #f56c6c"> · {{ item.openDamageCount }} 个未处理破损</span>
          </div>
        </div>
      </el-card>
    </div>

    <el-pagination
      v-if="(listQuery.data.value?.totalPages ?? 1) > 1"
      v-model:current-page="filters.page"
      :page-size="filters.pageSize"
      :total="listQuery.data.value?.total ?? 0"
      layout="prev, pager, next"
      style="margin-top: 16px; justify-content: center"
    />
  </div>
</template>
