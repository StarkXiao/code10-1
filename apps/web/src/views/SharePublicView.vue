<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  DAMAGE_STATUS_LABEL,
  GARMENT_CATEGORY_LABEL,
  KNIT_OR_WOVEN_LABEL,
  MATERIAL_PRIMARY_LABEL,
  REPAIR_STATUS_LABEL,
  SEASON_LABEL,
  SEVERITY_LABEL,
  VERDICT_LABEL,
  type DamageStatus,
  type GarmentCategory,
  type KnitOrWoven,
  type MaterialPrimary,
  type RepairStatus,
  type Season,
  type Severity,
  type Verdict,
} from '@gml/shared';
import { shareApi } from '../api';
import { sharePhotoFileUrl } from '../api/client';
import EmptyState from '../components/EmptyState.vue';

const route = useRoute();
const token = String(route.params.token);
const meta = ref<{
  wardrobeName: string;
  scope: string;
  garments: Array<{ id: string; code: string; name: string }>;
  expiresAt: string;
} | null>(null);
const garmentId = ref('');
const detail = ref<Record<string, unknown> | null>(null);
const error = ref('');

const garment = computed(() => detail.value?.garment as Record<string, string> | undefined);
const photos = computed(
  () =>
    (detail.value?.photos as Array<{
      id: string;
      view: string;
      annotations: Array<{ id: string; part?: { name: string } | null }>;
    }>) ?? [],
);
const damages = computed(() => (detail.value?.damages as Array<Record<string, unknown>>) ?? []);
const seasons = computed(() => {
  const tags = garment.value?.seasonTags;
  return Array.isArray(tags) ? tags.map((s) => SEASON_LABEL[s as Season]).join('/') : '';
});

/* 分享接口返回的是宽泛结构，这里统一收口成模板可用的纯字符串，避免在模板里写类型断言 */
function damageTypeName(row: Record<string, unknown>): string {
  return (row.damageType as { name?: string } | undefined)?.name ?? '—';
}

function partName(row: Record<string, unknown>): string {
  return (row.part as { name?: string } | null)?.name ?? '未标部位';
}

function repairsOf(row: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(row.repairs) ? (row.repairs as Array<Record<string, unknown>>) : [];
}

function stitchName(row: Record<string, unknown>): string {
  return (row.stitch as { name?: string } | undefined)?.name ?? '—';
}

function verdictOf(row: Record<string, unknown>): string {
  const reviews = Array.isArray(row.reviews) ? (row.reviews as Array<{ verdict?: string }>) : [];
  if (reviews.length === 0) return '未复检';
  return VERDICT_LABEL[reviews[0].verdict as Verdict] ?? '—';
}

onMounted(async () => {
  try {
    meta.value = await shareApi.publicData(token);
    if (meta.value.garments.length > 0) {
      garmentId.value = meta.value.garments[0].id;
      await loadGarment();
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '分享链接不可用';
  }
});

async function loadGarment(): Promise<void> {
  detail.value = await shareApi.publicGarment(token, garmentId.value);
}

function photoUrl(id: string): string {
  return sharePhotoFileUrl(id, token);
}
</script>

<template>
  <div class="page">
    <el-alert
      v-if="error"
      type="error"
      :closable="false"
      :title="error"
      description="链接可能已过期或被撤销，请向衣橱主人重新索取。"
    />

    <template v-else-if="meta">
      <div class="page-header">
        <div>
          <h1 class="page-title">{{ meta.wardrobeName }} · 只读档案</h1>
          <div class="page-subtitle">
            只读视图，不含成本与收纳位置等隐私字段 · 有效期至 {{ meta.expiresAt.slice(0, 16).replace('T', ' ') }}
          </div>
        </div>
      </div>

      <el-select v-model="garmentId" style="width: 320px; margin-bottom: 12px" @change="loadGarment">
        <el-option v-for="item in meta.garments" :key="item.id" :value="item.id" :label="`${item.name}（${item.code}）`" />
      </el-select>

      <template v-if="garment">
        <el-card shadow="never" style="margin-bottom: 12px">
          <div style="font-weight: 600; font-size: 18px">
            {{ garment.name }} <span class="muted mono">{{ garment.code }}</span>
          </div>
          <div class="muted" style="margin-top: 4px">
            {{ GARMENT_CATEGORY_LABEL[garment.category as GarmentCategory] }} ·
            {{ MATERIAL_PRIMARY_LABEL[garment.materialPrimary as MaterialPrimary] }}（{{ KNIT_OR_WOVEN_LABEL[garment.knitOrWoven as KnitOrWoven] }}）·
            {{ seasons }}
          </div>
          <div v-if="garment.careNote" class="muted">洗护：{{ garment.careNote }}</div>
        </el-card>

        <el-card shadow="never" style="margin-bottom: 12px">
          <template #header>照片与标记位置</template>
          <EmptyState v-if="photos.length === 0" title="没有照片" />
          <div v-else style="display: flex; gap: 12px; flex-wrap: wrap">
            <div v-for="photo in photos" :key="photo.id" style="width: 240px">
              <img :src="photoUrl(photo.id)" style="width: 100%; border-radius: 6px" alt="衣物照片" />
              <div class="muted">
                {{ photo.view }} · {{ photo.annotations.length }} 个标记
                <span v-for="annotation in photo.annotations" :key="annotation.id">
                  <span v-if="annotation.part"> · {{ annotation.part.name }}</span>
                </span>
              </div>
            </div>
          </div>
        </el-card>

        <el-card shadow="never">
          <template #header>破损与修补史</template>
          <EmptyState v-if="damages.length === 0" title="没有破损记录" />
          <div v-else style="display: grid; gap: 12px">
            <el-card v-for="damage in damages" :key="String(damage.id)" shadow="never" body-style="padding: 12px">
              <div style="font-weight: 600">
                {{ damageTypeName(damage) }} ·
                {{ SEVERITY_LABEL[damage.severity as Severity] }} ·
                {{ DAMAGE_STATUS_LABEL[damage.status as DamageStatus] }}
              </div>
              <div class="muted">
                {{ String(damage.detectedAt).slice(0, 10) }} ·
                {{ partName(damage) }}
                <span v-if="damage.recurrenceOf"> · 复发第 {{ damage.recurrenceIndex }} 次</span>
              </div>
              <el-table :data="repairsOf(damage)" size="small" style="margin-top: 8px">
                <el-table-column label="轮次" width="70">
                  <template #default="{ row }">第 {{ row.round }} 轮</template>
                </el-table-column>
                <el-table-column label="针法" width="130">
                  <template #default="{ row }">{{ stitchName(row) }}</template>
                </el-table-column>
                <el-table-column label="完成" width="110">
                  <template #default="{ row }">{{ String(row.finishedAt).slice(0, 10) }}</template>
                </el-table-column>
                <el-table-column label="状态" width="110">
                  <template #default="{ row }">{{ REPAIR_STATUS_LABEL[row.status as RepairStatus] }}</template>
                </el-table-column>
                <el-table-column label="复检">
                  <template #default="{ row }">
                    {{ verdictOf(row) }}
                  </template>
                </el-table-column>
              </el-table>
            </el-card>
          </div>
        </el-card>
      </template>
    </template>
  </div>
</template>
