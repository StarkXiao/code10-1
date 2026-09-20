<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ElMessage } from 'element-plus';
import { GARMENT_STATUS_LABEL, type GarmentStatus } from '@gml/shared';
import { garmentApi, reminderApi, wardrobeApi, wearApi } from '../api';
import { messageOf } from '../api/client';
import EmptyState from '../components/EmptyState.vue';

const router = useRouter();
const queryClient = useQueryClient();
const quickGarmentId = ref('');
const busy = ref(false);

const overviewQuery = useQuery({ queryKey: ['wardrobe', 'overview'], queryFn: wardrobeApi.overview });
const reminderQuery = useQuery({
  queryKey: ['reminders', 'today'],
  queryFn: () => reminderApi.list({ scope: 'today', limit: 20 }),
});
const garmentQuery = useQuery({
  queryKey: ['garments', 'active-for-quick'],
  queryFn: () => garmentApi.list({ pageSize: 100, sort: 'recent' }),
});

const overview = computed(() => overviewQuery.data.value?.overview);
const todos = computed(() => overviewQuery.data.value?.todos);
const reminders = computed(() => reminderQuery.data.value?.items ?? []);
const garments = computed(() => garmentQuery.data.value?.items ?? []);

async function quickWear(): Promise<void> {
  if (!quickGarmentId.value) return;
  busy.value = true;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const result = await wearApi.create({ garmentId: quickGarmentId.value, wornOn: today, session: 'full_day' });
    ElMessage.success(result.duplicate ? '今天已经记过一次了' : '已记录今天穿着');
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['wardrobe'] }),
      queryClient.invalidateQueries({ queryKey: ['garments'] }),
    ]);
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}

async function runScan(): Promise<void> {
  busy.value = true;
  try {
    const result = await reminderApi.scan();
    ElMessage.success(`扫描完成：新增 ${result.created} 条，推送 ${result.notified} 条，失效 ${result.expired} 条`);
    await queryClient.invalidateQueries();
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}

async function completeReminder(id: string): Promise<void> {
  try {
    await reminderApi.complete(id, {});
    ElMessage.success('已标记完成');
    await queryClient.invalidateQueries({ queryKey: ['reminders'] });
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

function openReminder(reminder: { actionKind: string; actionPayload: Record<string, unknown> | null; subjectId: string; id: string }): void {
  const payload = reminder.actionPayload ?? {};
  if (reminder.actionKind === 'open_review_form' && payload.repairId) {
    void router.push({ name: 'review', params: { id: String(payload.repairId) } });
    return;
  }
  if (reminder.actionKind === 'open_repair_rework' && payload.damageEventId) {
    void router.push({ name: 'repair-new', params: { id: String(payload.damageEventId) } });
    return;
  }
  if (reminder.actionKind === 'open_inventory') {
    void router.push({ name: 'fabric' });
    return;
  }
  if (payload.garmentId) {
    void router.push({ name: 'garment-detail', params: { id: String(payload.garmentId) } });
    return;
  }
  void router.push({ name: 'reminders' });
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">衣橱总览</h1>
        <div class="page-subtitle">
          {{ overviewQuery.data.value?.wardrobe.name ?? '我的衣橱' }} · 待办优先，先处理会烂得更厉害的那件
        </div>
      </div>
      <div style="display: flex; gap: 8px; flex-wrap: wrap">
        <el-button :loading="busy" @click="runScan">立刻检查提醒</el-button>
        <el-button type="primary" @click="router.push({ name: 'garment-new' })">建档</el-button>
      </div>
    </div>

    <el-card shadow="never" style="margin-bottom: 12px">
      <div class="stat-row">
        <div class="stat-block">
          <div class="stat-value">{{ overview?.garmentCount ?? 0 }}</div>
          <div class="stat-label">衣物总数</div>
        </div>
        <div class="stat-block">
          <div class="stat-value" style="color: #f56c6c">{{ overview?.needsRepairCount ?? 0 }}</div>
          <div class="stat-label">待修</div>
        </div>
        <div class="stat-block">
          <div class="stat-value" style="color: #e6a23c">{{ overview?.observingCount ?? 0 }}</div>
          <div class="stat-label">观察期</div>
        </div>
        <div class="stat-block">
          <div class="stat-value">{{ overview?.totalWearCount ?? 0 }}</div>
          <div class="stat-label">累计穿着</div>
        </div>
        <div class="stat-block">
          <div class="stat-value">{{ overview?.totalRepairCount ?? 0 }}</div>
          <div class="stat-label">累计修补</div>
        </div>
        <div class="stat-block">
          <div class="stat-value">{{ ((overview?.recurrenceRate ?? 0) * 100).toFixed(0) }}%</div>
          <div class="stat-label">复修率</div>
        </div>
        <div class="stat-block">
          <div class="stat-value">{{ overview?.averageLifespanDays ?? '—' }}</div>
          <div class="stat-label">平均修补寿命（天）</div>
        </div>
        <div class="stat-block">
          <div class="stat-value">{{ overview?.lifetimeCostPerWear ?? '—' }}</div>
          <div class="stat-label">整体每穿成本（元）</div>
        </div>
      </div>
      <div v-if="(overview?.censoredLifespanCount ?? 0) > 0" class="muted" style="margin-top: 8px">
        另有 {{ overview?.censoredLifespanCount }} 次修补至今未复发（右删失），不计入平均寿命，只记为"至少撑了这么久"。
      </div>
    </el-card>

    <el-row :gutter="12">
      <el-col :xs="24" :md="14">
        <el-card shadow="never">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center">
              <span>今日待办（{{ reminders.length }}）</span>
              <el-button link type="primary" @click="router.push({ name: 'reminders' })">全部提醒</el-button>
            </div>
          </template>
          <EmptyState v-if="reminders.length === 0" title="今天没有待办" description="该修的修了，该检查的检查了。">
            <el-button size="small" @click="router.push({ name: 'garments' })">去看看衣物</el-button>
          </EmptyState>
          <div v-else style="display: grid; gap: 10px">
            <el-card v-for="reminder in reminders" :key="reminder.id" shadow="hover" body-style="padding:12px">
              <div style="display: flex; justify-content: space-between; gap: 8px">
                <div>
                  <div style="font-weight: 600">{{ reminder.title }}</div>
                  <div class="muted" style="margin-top: 4px">{{ reminder.body }}</div>
                  <div class="muted" style="margin-top: 6px; font-size: 12px">为什么提醒你：{{ reminder.reason }}</div>
                </div>
                <el-tag :type="reminder.isOverdue ? 'danger' : 'warning'" size="small">
                  {{ reminder.isOverdue ? '已逾期' : '今天' }}
                </el-tag>
              </div>
              <div class="card-actions">
                <el-button size="small" type="primary" @click="openReminder(reminder)">去处理</el-button>
                <el-button size="small" @click="completeReminder(reminder.id)">标记完成</el-button>
                <el-button size="small" link @click="router.push({ name: 'reminders' })">稍后 / 忽略</el-button>
              </div>
            </el-card>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :md="10">
        <el-card shadow="never">
          <template #header>一键打点</template>
          <el-select v-model="quickGarmentId" filterable placeholder="今天穿了哪件？" style="width: 100%">
            <el-option v-for="item in garments" :key="item.id" :value="item.id" :label="`${item.name}（${item.code}）`" />
          </el-select>
          <el-button type="primary" style="width: 100%; margin-top: 8px" :loading="busy" :disabled="!quickGarmentId" @click="quickWear">
            今天穿了
          </el-button>
          <div class="muted" style="margin-top: 6px">同一天重复点不会重复计数；断网时先排队，联网自动同步。</div>
        </el-card>

        <el-card shadow="never" style="margin-top: 12px">
          <template #header>需要关注</template>
          <EmptyState v-if="(overviewQuery.data.value?.needingAttention.length ?? 0) === 0" title="没有需要处理的衣物" />
          <div v-else style="display: grid; gap: 8px">
            <div
              v-for="item in overviewQuery.data.value?.needingAttention ?? []"
              :key="item.id"
              style="display: flex; justify-content: space-between; align-items: center; cursor: pointer"
              @click="router.push({ name: 'garment-detail', params: { id: item.id } })"
            >
              <span>{{ item.name }} <span class="muted mono">{{ item.code }}</span></span>
              <el-tag size="small" type="warning">
                {{ GARMENT_STATUS_LABEL[item.status as GarmentStatus] }}
              </el-tag>
            </div>
          </div>
        </el-card>

        <el-card shadow="never" style="margin-top: 12px">
          <template #header>待清理的小尾巴</template>
          <div class="muted">
            未关联的草稿标记：{{ todos?.orphanAnnotations ?? 0 }} 个<br />
            低库存布料：{{ todos?.inventoryAlerts ?? 0 }} 种<br />
            未来 7 天提醒：{{ todos?.upcoming ?? 0 }} 条
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>
