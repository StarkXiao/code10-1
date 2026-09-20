<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import {
  FABRIC_KINDS,
  FABRIC_KIND_LABEL,
  INVENTORY_UNITS,
  INVENTORY_UNIT_LABEL,
  MATERIAL_PRIMARIES,
  MATERIAL_PRIMARY_LABEL,
  type FabricKind,
  type InventoryUnit,
  type MaterialPrimary,
} from '@gml/shared';
import { fabricApi } from '../api';
import { messageOf } from '../api/client';
import EmptyState from '../components/EmptyState.vue';
import type { FabricSourceItem } from '../types';

const items = ref<FabricSourceItem[]>([]);
const busy = ref(false);
const createVisible = ref(false);
const restockVisible = ref(false);
const restockTarget = ref<FabricSourceItem | null>(null);
const usageTarget = ref<{ source: FabricSourceItem; usages: Array<Record<string, unknown>>; effectiveness: Record<string, unknown> } | null>(null);

const form = reactive({
  name: '',
  kind: 'purchased_patch' as FabricKind,
  materialPrimary: 'cotton' as MaterialPrimary,
  color: '',
  compositionNote: '',
  price: undefined as number | undefined,
  purchaseLocation: '',
  unit: 'cm2' as InventoryUnit,
  initialAmount: 100,
  lowStockThreshold: 15,
});
const restockForm = reactive({ amount: 50, note: '' });

const lowStockCount = computed(() => items.value.filter((item) => item.inventory?.isLow).length);

onMounted(load);

async function load(): Promise<void> {
  try {
    items.value = (await fabricApi.list()).items;
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function create(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('请填写来源名称');
    return;
  }
  busy.value = true;
  try {
    await fabricApi.create({
      name: form.name,
      kind: form.kind,
      materialPrimary: form.materialPrimary,
      color: form.color || null,
      compositionNote: form.compositionNote || null,
      price: form.price ?? null,
      purchaseLocation: form.purchaseLocation || null,
      inventory: { unit: form.unit, initialAmount: form.initialAmount, lowStockThreshold: form.lowStockThreshold },
    });
    ElMessage.success('已登记布料来源与库存');
    createVisible.value = false;
    form.name = '';
    await load();
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}

function openRestock(item: FabricSourceItem): void {
  restockTarget.value = item;
  restockForm.amount = Math.max(1, Math.round(item.inventory!.initialAmount / 2));
  restockForm.note = '';
  restockVisible.value = true;
}

async function restock(): Promise<void> {
  if (!restockTarget.value) return;
  busy.value = true;
  try {
    await fabricApi.restock(restockTarget.value.id, restockForm.amount, restockForm.note || undefined);
    ElMessage.success('已补货，低库存提醒会自动关闭');
    restockVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}

async function showUsage(item: FabricSourceItem): Promise<void> {
  try {
    const data = await fabricApi.usage(item.id);
    usageTarget.value = { source: item, usages: data.usages, effectiveness: data.effectiveness };
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

function usageGarmentName(row: Record<string, unknown>): string {
  return (row.garment as { name?: string } | undefined)?.name ?? '—';
}

function usageVerdict(row: Record<string, unknown>): string {
  return (row.verdict as string | null) ?? '未复检';
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">布料来源与库存</h1>
        <div class="page-subtitle">
          补丁布从哪来、还剩多少、救了哪几件衣服 —— 这块布也要有档案
          <span v-if="lowStockCount" style="color: #e6a23c"> · {{ lowStockCount }} 种低于库存阈值</span>
        </div>
      </div>
      <el-button type="primary" @click="createVisible = true">登记布料来源</el-button>
    </div>

    <EmptyState v-if="items.length === 0" title="还没有登记布料来源" description="可以从「原衣余料」「同款旧衣拆解」「市售补丁布」开始。">
      <el-button type="primary" @click="createVisible = true">登记第一个来源</el-button>
    </EmptyState>

    <div v-else class="grid-cards">
      <el-card v-for="item in items" :key="item.id" shadow="hover">
        <div style="display: flex; justify-content: space-between; align-items: center">
          <span style="font-weight: 600">{{ item.name }}</span>
          <el-tag size="small" :type="item.inventory?.isLow ? 'danger' : 'success'">
            {{ item.inventory?.isLow ? '库存偏低' : '可用' }}
          </el-tag>
        </div>
        <div class="muted" style="margin-top: 4px">
          {{ FABRIC_KIND_LABEL[item.kind as FabricKind] }} ·
          {{ MATERIAL_PRIMARY_LABEL[item.materialPrimary as MaterialPrimary] }}
          <span v-if="item.color"> · {{ item.color }}</span>
        </div>
        <div v-if="item.donorGarment" class="muted">来自：{{ item.donorGarment.name }}（{{ item.donorGarment.code }}）</div>

        <div v-if="item.inventory" style="margin-top: 10px">
          <el-progress
            :percentage="Math.min(100, Math.round((item.inventory.remainingAmount / Math.max(item.inventory.initialAmount, 1)) * 100))"
            :status="item.inventory.isLow ? 'exception' : 'success'"
          />
          <div class="muted">
            剩余 {{ item.inventory.remainingAmount }}{{ item.inventory.unit }} / 初始 {{ item.inventory.initialAmount }}{{ item.inventory.unit }} ·
            已用 {{ Math.round(item.inventory.consumed * 10) / 10 }}{{ item.inventory.unit }} ·
            已补 {{ Math.round(item.inventory.restocked * 10) / 10 }}{{ item.inventory.unit }}
          </div>
        </div>
        <div v-else class="muted" style="margin-top: 10px">未登记库存</div>

        <div class="muted" style="margin-top: 6px">已用于 {{ item.usageCount }} 次修补</div>
        <div class="card-actions">
          <el-button v-if="item.inventory" size="small" @click="openRestock(item)">补货</el-button>
          <el-button size="small" @click="showUsage(item)">使用效果</el-button>
        </div>
      </el-card>
    </div>

    <el-dialog v-model="createVisible" title="登记布料来源" width="520px">
      <el-form label-width="110px">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="例如：旧灰色羊毛袜拆的线" />
        </el-form-item>
        <el-form-item label="来源类型" required>
          <el-select v-model="form.kind" style="width: 100%">
            <el-option v-for="item in FABRIC_KINDS" :key="item" :value="item" :label="FABRIC_KIND_LABEL[item]" />
          </el-select>
        </el-form-item>
        <el-form-item label="材质" required>
          <el-select v-model="form.materialPrimary" style="width: 100%">
            <el-option v-for="item in MATERIAL_PRIMARIES" :key="item" :value="item" :label="MATERIAL_PRIMARY_LABEL[item]" />
          </el-select>
        </el-form-item>
        <el-form-item label="颜色 / 备注">
          <el-input v-model="form.color" placeholder="颜色" style="width: 140px" />
          <el-input v-model="form.compositionNote" placeholder="成分或说明" style="width: 220px; margin-left: 8px" />
        </el-form-item>
        <el-form-item label="采购信息">
          <el-input-number v-model="form.price" :min="0" :precision="2" placeholder="价格" style="width: 150px" />
          <el-input v-model="form.purchaseLocation" placeholder="购买地点" style="width: 220px; margin-left: 8px" />
        </el-form-item>
        <el-form-item label="初始库存">
          <el-input-number v-model="form.initialAmount" :min="0.1" :precision="1" style="width: 150px" />
          <el-select v-model="form.unit" style="width: 130px; margin-left: 8px">
            <el-option v-for="item in INVENTORY_UNITS" :key="item" :value="item" :label="INVENTORY_UNIT_LABEL[item]" />
          </el-select>
        </el-form-item>
        <el-form-item label="低库存阈值">
          <el-input-number v-model="form.lowStockThreshold" :min="0" :precision="1" style="width: 150px" />
          <span class="muted" style="margin-left: 8px">低于这个值会提醒补货</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="create">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="restockVisible" :title="`补货：${restockTarget?.name ?? ''}`" width="420px">
      <el-form label-width="80px">
        <el-form-item label="数量">
          <el-input-number v-model="restockForm.amount" :min="0.1" :precision="1" style="width: 160px" />
          <span class="muted" style="margin-left: 8px">{{ restockTarget?.inventory?.unit }}</span>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="restockForm.note" placeholder="例如：网上买的同色补丁布" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="restockVisible = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="restock">确认补货</el-button>
      </template>
    </el-dialog>

    <el-dialog :model-value="!!usageTarget" title="这块布的使用效果" width="620px" @close="usageTarget = null">
      <template v-if="usageTarget">
        <el-descriptions :column="2" size="small" border style="margin-bottom: 12px">
          <el-descriptions-item label="样本数">{{ usageTarget.effectiveness.sampleCount ?? 0 }}</el-descriptions-item>
          <el-descriptions-item label="平均修补寿命">
            {{ usageTarget.effectiveness.averageLifespanDays ?? '—' }} 天
          </el-descriptions-item>
          <el-descriptions-item label="未复发（右删失）">{{ usageTarget.effectiveness.censoredCount ?? 0 }}</el-descriptions-item>
          <el-descriptions-item label="已复发样本">{{ usageTarget.effectiveness.observedCount ?? 0 }}</el-descriptions-item>
        </el-descriptions>
        <el-table :data="usageTarget.usages" size="small" max-height="320">
          <el-table-column label="衣物">
            <template #default="{ row }">{{ usageGarmentName(row) }}</template>
          </el-table-column>
          <el-table-column label="针法" prop="stitch" width="120" />
          <el-table-column label="用量" width="100">
            <template #default="{ row }">{{ row.amount }}{{ row.unit }}</template>
          </el-table-column>
          <el-table-column label="完成日期" width="120">
            <template #default="{ row }">{{ String(row.finishedAt).slice(0, 10) }}</template>
          </el-table-column>
          <el-table-column label="复检" width="100">
            <template #default="{ row }">{{ usageVerdict(row) }}</template>
          </el-table-column>
        </el-table>
      </template>
    </el-dialog>
  </div>
</template>
