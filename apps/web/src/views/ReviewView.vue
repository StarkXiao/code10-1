<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  NEXT_ACTION_LABEL,
  NEXT_ACTIONS,
  VERDICT_LABEL,
  VERDICTS,
  type NextAction,
  type Verdict,
} from '@gml/shared';
import { repairApi } from '../api';
import { ApiError, messageOf } from '../api/client';
import type { RepairDetail } from '../types';

const route = useRoute();
const router = useRouter();
const queryClient = useQueryClient();
const repairId = String(route.params.id);
const data = ref<RepairDetail | null>(null);
const busy = ref(false);

const form = ref({
  reviewedAt: new Date().toISOString().slice(0, 10),
  verdict: 'good' as Verdict,
  wornSince: undefined as number | undefined,
  reoccurred: false,
  verdictNote: '',
  nextAction: 'close' as NextAction,
});

const repair = computed(() => data.value?.repair);
const isFailed = computed(() => form.value.verdict === 'failed');
const daysSinceRepair = computed(() => {
  if (!repair.value) return 0;
  return Math.max(
    0,
    Math.round((Date.now() - new Date(repair.value.finishedAt).getTime()) / 86_400_000),
  );
});

onMounted(async () => {
  try {
    data.value = await repairApi.detail(repairId);
    if (data.value.repair.change?.visibleFromOutside) form.value.verdict = 'fair';
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
});

async function submit(): Promise<void> {
  if (isFailed.value && form.value.nextAction === 'close') {
    ElMessage.warning('复检不合格时不能直接闭环，请选择返工或评估退役');
    return;
  }
  busy.value = true;
  try {
    const payload = {
      reviewedAt: form.value.reviewedAt,
      verdict: form.value.verdict,
      wornSince: form.value.wornSince ?? null,
      reoccurred: form.value.reoccurred,
      verdictNote: form.value.verdictNote || null,
      nextAction: form.value.nextAction,
    };
    let result: { repairStatus: string; damageStatus: string; reminderCreated?: { kind: string } | null };
    try {
      result = (await repairApi.review(repairId, { ...payload, confirmEarly: false })) as typeof result;
    } catch (error) {
      // 观察期还没到：服务端要求显式确认，确认后带 confirmEarly 再提交一次
      if (error instanceof ApiError && error.code === 'OBSERVATION_NOT_FINISHED') {
        await ElMessageBox.confirm(`${error.message}。确定现在就要复检吗？`, '提前复检', {
          type: 'warning',
          confirmButtonText: '仍然提交',
          cancelButtonText: '再等等',
        });
        result = (await repairApi.review(repairId, { ...payload, confirmEarly: true })) as typeof result;
      } else {
        throw error;
      }
    }

    ElMessage.success(
      `复检已提交：修补 ${result.repairStatus} / 破损 ${result.damageStatus}` +
        (result.reminderCreated ? '，已生成后续提醒' : ''),
    );
    // 复检会同时改修补、破损、衣物与提醒的状态，缓存必须一起失效，
    // 否则跳回档案页看到的还是 15 秒前的旧数据。
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['garment'] }),
      queryClient.invalidateQueries({ queryKey: ['garments'] }),
      queryClient.invalidateQueries({ queryKey: ['reminders'] }),
      queryClient.invalidateQueries({ queryKey: ['wardrobe'] }),
    ]);
    await router.push({ name: 'garment-detail', params: { id: repair.value!.damageEvent.garmentId } });
  } catch (error) {
    // 用户在确认框里点了"再等等"：ElMessageBox 以 'cancel' 拒绝，不算错误
    const cancelled = error === 'cancel' || error === 'close';
    if (!cancelled) ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <el-skeleton v-if="!repair" :rows="4" animated />
    <template v-else>
      <div class="page-header">
        <div>
          <h1 class="page-title">修补复检</h1>
          <div class="page-subtitle">
            {{ repair.damageEvent.garment.name }} · 第 {{ repair.round }} 轮 · {{ repair.stitch.name }} ·
            完成于 {{ repair.finishedAt.slice(0, 10) }}（已 {{ daysSinceRepair }} 天，观察期至 {{ repair.observationUntil.slice(0, 10) }}）
          </div>
        </div>
        <el-button link @click="router.back()">返回</el-button>
      </div>

      <el-card shadow="never">
        <el-alert
          type="info"
          :closable="false"
          style="margin-bottom: 12px"
          title="复检的意义"
          description="这一步让闭环合上：结论只有「通过」或「转退役」，不合格必须回到返工或退役，不会悬在半空。"
        />
        <el-form label-width="130px">
          <el-form-item label="复检日期" required>
            <el-date-picker v-model="form.reviewedAt" type="date" value-format="YYYY-MM-DD" style="width: 200px" />
          </el-form-item>
          <el-form-item label="结论" required>
            <el-radio-group v-model="form.verdict">
              <el-radio-button v-for="item in VERDICTS" :key="item" :label="item">{{ VERDICT_LABEL[item] }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="复检时穿着次数">
            <el-input-number v-model="form.wornSince" :min="0" style="width: 160px" />
            <span class="muted" style="margin-left: 8px">不填则按档案里的穿着记录自动统计</span>
          </el-form-item>
          <el-form-item label="同一位置又坏了">
            <el-switch v-model="form.reoccurred" />
            <span class="muted" style="margin-left: 8px">如果又破了，建议先去档案页登记一条新破损并关联复发</span>
          </el-form-item>
          <el-form-item label="复检说明">
            <el-input v-model="form.verdictNote" type="textarea" :rows="3" maxlength="1000" placeholder="例：织补处平整，拉扯也没有松动；边缘略紧" />
          </el-form-item>
          <el-form-item label="下一步" required>
            <el-radio-group v-model="form.nextAction">
              <el-radio-button v-for="item in NEXT_ACTIONS" :key="item" :label="item" :disabled="isFailed && item === 'close'">
                {{ NEXT_ACTION_LABEL[item] }}
              </el-radio-button>
            </el-radio-group>
            <div class="field-hint">
              闭环结束：本次破损收口，进入长期统计；继续观察：30 天后再提醒一次；
              返工重修：生成返工任务，保留这一轮的记录；评估退役：转入处置流程。
            </div>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="busy" @click="submit">提交复检</el-button>
            <el-button @click="router.push({ name: 'repair-detail', params: { id: repairId } })">看看修补详情</el-button>
          </el-form-item>
        </el-form>
      </el-card>
    </template>
  </div>
</template>
