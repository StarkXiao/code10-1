<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  GARMENT_CATEGORIES,
  GARMENT_CATEGORY_LABEL,
  KNIT_OR_WOVEN,
  KNIT_OR_WOVEN_LABEL,
  MATERIAL_PRIMARIES,
  MATERIAL_PRIMARY_LABEL,
  SEASONS,
  SEASON_LABEL,
  type GarmentCategory,
  type KnitOrWoven,
  type MaterialPrimary,
  type Season,
} from '@gml/shared';
import { garmentApi, wardrobeApi } from '../api';
import { messageOf } from '../api/client';
import PhotoUploader from '../components/PhotoUploader.vue';

const router = useRouter();
const step = ref(0);
const busy = ref(false);
const createdId = ref('');

const form = reactive({
  name: '',
  category: 'sweater' as GarmentCategory,
  brand: '',
  sizeLabel: '',
  materialPrimary: 'wool' as MaterialPrimary,
  knitOrWoven: 'knit' as KnitOrWoven,
  seasonTags: ['autumn', 'winter'] as Season[],
  color: '',
  purchaseDate: '',
  purchasePrice: undefined as number | undefined,
  careNote: '',
  storageLocation: '',
  firstWearDate: '',
  note: '',
  materialComposition: [] as Array<{ fiber: string; pct: number }>,
  careWashTemp: undefined as number | undefined,
  careMachineWash: undefined as boolean | undefined,
  careDryCleanOnly: undefined as boolean | undefined,
});

const careAdvice = ref<{ washAdvice: string; dryAdvice: string; typicalWeakPoints: string[] } | null>(null);

async function loadAdvice(): Promise<void> {
  try {
    const dict = await wardrobeApi.dictionary();
    const material = dict.materials.find((m) => m.code === form.materialPrimary);
    careAdvice.value = material ?? null;
  } catch {
    careAdvice.value = null;
  }
}

void loadAdvice();

async function submit(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('请填写衣物名称');
    return;
  }
  if (form.seasonTags.length === 0) {
    ElMessage.warning('至少选择一个季节');
    return;
  }
  busy.value = true;
  try {
    const data = await garmentApi.create({
      ...form,
      brand: form.brand || null,
      sizeLabel: form.sizeLabel || null,
      color: form.color || null,
      careNote: form.careNote || null,
      storageLocation: form.storageLocation || null,
      purchaseDate: form.purchaseDate || null,
      firstWearDate: form.firstWearDate || null,
      purchasePrice: form.purchasePrice ?? null,
      careWashTemp: form.careWashTemp ?? null,
      careMachineWash: form.careMachineWash ?? null,
      careDryCleanOnly: form.careDryCleanOnly ?? null,
      materialComposition: form.materialComposition.length ? form.materialComposition : null,
    });
    createdId.value = data.garment.id;
    ElMessage.success(`已建档，编号 ${data.garment.code}`);
    step.value = 2;
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">新建衣物档案</h1>
        <div class="page-subtitle">建档只需要一次，之后每次破损都会挂在这份档案下</div>
      </div>
      <el-button link @click="router.back()">返回</el-button>
    </div>

    <el-steps :active="step" finish-status="success" style="margin-bottom: 16px">
      <el-step title="基本信息" />
      <el-step title="材质与季节" />
      <el-step title="拍照片" />
    </el-steps>

    <el-card v-if="step === 0" shadow="never">
      <el-form label-width="100px">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="例如：灰色羊毛衫" maxlength="60" />
        </el-form-item>
        <el-form-item label="品类" required>
          <el-select v-model="form.category" style="width: 200px">
            <el-option v-for="item in GARMENT_CATEGORIES" :key="item" :value="item" :label="GARMENT_CATEGORY_LABEL[item]" />
          </el-select>
        </el-form-item>
        <el-form-item label="品牌 / 尺码">
          <el-input v-model="form.brand" placeholder="品牌（可空）" style="width: 200px" />
          <el-input v-model="form.sizeLabel" placeholder="尺码标签原样，如 170/92A" style="width: 220px; margin-left: 8px" />
        </el-form-item>
        <el-form-item label="颜色">
          <el-input v-model="form.color" placeholder="如 深灰（补线时用来对色）" style="width: 200px" />
        </el-form-item>
        <el-form-item label="购入信息">
          <el-date-picker v-model="form.purchaseDate" type="date" value-format="YYYY-MM-DD" placeholder="购入日期" style="width: 180px" />
          <el-input-number v-model="form.purchasePrice" :min="0" :precision="2" placeholder="价格" style="width: 160px; margin-left: 8px" />
          <span class="muted" style="margin-left: 8px">用于算每穿成本</span>
        </el-form-item>
        <el-form-item label="首次穿着">
          <el-date-picker v-model="form.firstWearDate" type="date" value-format="YYYY-MM-DD" placeholder="不填则从第一次打点算起" style="width: 240px" />
        </el-form-item>
        <el-form-item label="收纳位置">
          <el-input v-model="form.storageLocation" placeholder="如 主卧衣柜第二层" style="width: 260px" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="step = 1">下一步</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card v-else-if="step === 1" shadow="never">
      <el-form label-width="100px">
        <el-form-item label="主材质" required>
          <el-select v-model="form.materialPrimary" style="width: 200px" @change="loadAdvice">
            <el-option v-for="item in MATERIAL_PRIMARIES" :key="item" :value="item" :label="MATERIAL_PRIMARY_LABEL[item]" />
          </el-select>
          <el-select v-model="form.knitOrWoven" style="width: 160px; margin-left: 8px">
            <el-option v-for="item in KNIT_OR_WOVEN" :key="item" :value="item" :label="KNIT_OR_WOVEN_LABEL[item]" />
          </el-select>
          <span class="muted" style="margin-left: 8px">针织 vs 梭织直接决定能用哪些针法</span>
        </el-form-item>
        <el-form-item label="成分表">
          <div style="width: 100%">
            <div v-for="(row, index) in form.materialComposition" :key="index" style="display: flex; gap: 8px; margin-bottom: 6px">
              <el-input v-model="row.fiber" placeholder="纤维名，如 羊毛" style="width: 160px" />
              <el-input-number v-model="row.pct" :min="0" :max="100" style="width: 140px" />
              <el-button link type="danger" @click="form.materialComposition.splice(index, 1)">删除</el-button>
            </div>
            <el-button size="small" @click="form.materialComposition.push({ fiber: '', pct: 100 })">添加成分</el-button>
            <div class="field-hint">按洗标填写，用来判断"这种混纺在哪个部位最容易出问题"</div>
          </div>
        </el-form-item>
        <el-form-item label="适合季节" required>
          <el-checkbox-group v-model="form.seasonTags">
            <el-checkbox v-for="item in SEASONS" :key="item" :value="item">{{ SEASON_LABEL[item] }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="洗护">
          <el-input-number v-model="form.careWashTemp" :min="0" :max="95" placeholder="水温上限" style="width: 140px" />
          <el-checkbox v-model="form.careMachineWash" style="margin-left: 12px">可机洗</el-checkbox>
          <el-checkbox v-model="form.careDryCleanOnly" style="margin-left: 12px">仅干洗</el-checkbox>
        </el-form-item>
        <el-form-item label="洗标原文">
          <el-input v-model="form.careNote" type="textarea" :rows="2" maxlength="300" placeholder="照抄洗标，之后提醒里会带上这句" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" maxlength="1000" />
        </el-form-item>
      </el-form>

      <el-alert v-if="careAdvice" type="info" :closable="false" style="margin-bottom: 12px">
        <template #title>这件材质的护理要点（来自内置材质库）</template>
        <div>清洗：{{ careAdvice.washAdvice }}</div>
        <div>晾晒：{{ careAdvice.dryAdvice }}</div>
        <div>典型薄弱部位：{{ careAdvice.typicalWeakPoints.join('、') || '—' }}</div>
      </el-alert>

      <div style="display: flex; gap: 8px">
        <el-button @click="step = 0">上一步</el-button>
        <el-button type="primary" :loading="busy" @click="submit">创建档案</el-button>
      </div>
    </el-card>

    <el-card v-else shadow="never">
      <el-result icon="success" title="档案已创建" sub-title="建议先拍 3 张照片：正面、背面、洗标，之后标位置才有的可标" >
        <template #extra>
          <div style="max-width: 420px; margin: 0 auto">
            <PhotoUploader v-if="createdId" :garment-id="createdId" default-view="front" />
          </div>
          <div style="margin-top: 16px; display: flex; gap: 8px; justify-content: center">
            <el-button @click="router.push({ name: 'garments' })">稍后再拍</el-button>
            <el-button type="primary" @click="router.push({ name: 'garment-detail', params: { id: createdId } })">
              进入档案
            </el-button>
          </div>
        </template>
      </el-result>
    </el-card>
  </div>
</template>
