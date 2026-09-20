<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { PHOTO_VIEW_LABEL, type PhotoView } from '@gml/shared';
import { damageApi, photoApi, wardrobeApi } from '../api';
import { messageOf } from '../api/client';
import PhotoAnnotator, { type DraftAnnotation } from '../components/PhotoAnnotator.vue';
import PartPicker from '../components/PartPicker.vue';
import EmptyState from '../components/EmptyState.vue';
import type { DamageListItem, DictionaryResponse, GarmentPhotoRow, PhotoAnnotationRow } from '../types';

const route = useRoute();
const router = useRouter();
const garmentId = String(route.params.id);

const photos = ref<GarmentPhotoRow[]>([]);
const annotations = ref<PhotoAnnotationRow[]>([]);
const drafts = ref<DraftAnnotation[]>([]);
const currentPhotoId = ref(String(route.query.photoId ?? ''));
const tool = ref<'point' | 'rect' | 'polyline'>('point');
const selectedId = ref<string | null>(null);
const pendingPartId = ref<string | null>(null);
const dict = ref<DictionaryResponse | null>(null);
const damages = ref<DamageListItem[]>([]);
const busy = ref(false);
const history = ref<DraftAnnotation[][]>([]);
const future = ref<DraftAnnotation[][]>([]);
const annotatorRef = ref<InstanceType<typeof PhotoAnnotator> | null>(null);

const currentPhoto = computed(() => photos.value.find((p) => p.id === currentPhotoId.value) ?? null);
const pendingPartName = computed(() => dict.value?.partsFlat.find((p) => p.id === pendingPartId.value)?.name ?? '');
const selectedAnnotation = computed(() => annotations.value.find((a) => a.id === selectedId.value) ?? null);

onMounted(async () => {
  try {
    const [photoData, dictData, damageData] = await Promise.all([
      photoApi.list(garmentId),
      wardrobeApi.dictionary(),
      damageApi.list({ garmentId }),
    ]);
    photos.value = photoData.photos;
    dict.value = dictData;
    damages.value = damageData.items;
    currentPhotoId.value = currentPhotoId.value || photos.value[0]?.id || '';
    await loadAnnotations();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
});

async function loadAnnotations(): Promise<void> {
  if (!currentPhotoId.value) {
    annotations.value = [];
    return;
  }
  annotations.value = (await photoApi.annotations(currentPhotoId.value)).annotations;
}

async function switchPhoto(id: string): Promise<void> {
  if (drafts.value.length > 0) {
    try {
      await ElMessageBox.confirm('切换照片会丢弃当前未保存的标记，继续？', '提示', { type: 'warning' });
    } catch {
      return;
    }
  }
  currentPhotoId.value = id;
  drafts.value = [];
  selectedId.value = null;
  history.value = [];
  future.value = [];
  await loadAnnotations();
}

function snapshot(): void {
  history.value.push(JSON.parse(JSON.stringify(drafts.value)) as DraftAnnotation[]);
  future.value = [];
}

function createDraft(payload: { kind: DraftAnnotation['kind']; geometry: DraftAnnotation['geometry'] }): void {
  snapshot();
  const draft: DraftAnnotation = {
    localId: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind: payload.kind,
    geometry: payload.geometry,
    partId: pendingPartId.value,
    label: '',
    color: '#9ca3af',
  };
  drafts.value.push(draft);
  selectedId.value = draft.localId;
}

function updateGeometry(payload: { source: 'saved' | 'draft'; id: string; geometry: DraftAnnotation['geometry'] }): void {
  if (payload.source === 'draft') {
    const draft = drafts.value.find((d) => d.localId === payload.id);
    if (draft) draft.geometry = payload.geometry;
    return;
  }
  const annotation = annotations.value.find((a) => a.id === payload.id);
  if (!annotation) return;
  annotation.geometry = payload.geometry as PhotoAnnotationRow['geometry'];
  // 拖动过程中只更新本地预览；落库在 commitGeometry（松手时）执行
}

/** 拖动结束才提交，避免一次拖动发出几十个 PATCH 请求 */
async function commitGeometry(payload: { id: string }): Promise<void> {
  const annotation = annotations.value.find((a) => a.id === payload.id);
  if (!annotation) return;
  try {
    await photoApi.updateAnnotation(annotation.id, { kind: annotation.kind, geometry: annotation.geometry });
  } catch (error) {
    ElMessage.error(messageOf(error));
    await loadAnnotations();
  }
}

function undo(): void {
  const previous = history.value.pop();
  if (!previous) return;
  future.value.push(JSON.parse(JSON.stringify(drafts.value)) as DraftAnnotation[]);
  drafts.value = previous;
}

function redo(): void {
  const next = future.value.pop();
  if (!next) return;
  history.value.push(JSON.parse(JSON.stringify(drafts.value)) as DraftAnnotation[]);
  drafts.value = next;
}

async function removeSelected(): Promise<void> {
  const id = selectedId.value;
  if (!id) return;
  const draftIndex = drafts.value.findIndex((d) => d.localId === id);
  if (draftIndex >= 0) {
    snapshot();
    drafts.value.splice(draftIndex, 1);
    selectedId.value = null;
    return;
  }
  const annotation = annotations.value.find((a) => a.id === id);
  if (!annotation) return;
  try {
    const result = await photoApi.deleteAnnotation(annotation.id);
    ElMessage.success(result.unfrozen ? '该标记已被冻结为证据，已改为解绑' : '已删除标记');
    selectedId.value = null;
    await loadAnnotations();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function save(): Promise<void> {
  if (drafts.value.length === 0) {
    ElMessage.info('没有新的标记需要保存');
    return;
  }
  busy.value = true;
  try {
    const result = await photoApi.createAnnotations(
      currentPhotoId.value,
      drafts.value.map((draft) => ({
        kind: draft.kind,
        geometry: draft.geometry,
        partId: draft.partId,
        label: draft.label || null,
      })),
    );
    ElMessage.success(`已保存 ${result.annotations.length} 个标记，其中 ${result.draftCount} 个待关联破损事件`);
    drafts.value = [];
    history.value = [];
    future.value = [];
    await loadAnnotations();
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}

async function linkToDamage(damageId: string): Promise<void> {
  const id = selectedId.value;
  if (!id) {
    ElMessage.warning('请先在画布上点选一个标记');
    return;
  }
  if (drafts.value.some((d) => d.localId === id)) {
    ElMessage.warning('请先保存这个标记，再关联破损事件');
    return;
  }
  try {
    await photoApi.linkAnnotation(id, { damageEventId: damageId, partId: pendingPartId.value ?? undefined });
    ElMessage.success('已关联到破损事件，该标记被冻结为证据');
    await loadAnnotations();
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}

async function applyPart(): Promise<void> {
  const id = selectedId.value;
  if (!id || !pendingPartId.value) {
    ElMessage.warning('请先选择部位并点选一个标记');
    return;
  }
  const draft = drafts.value.find((d) => d.localId === id);
  if (draft) {
    draft.partId = pendingPartId.value;
    ElMessage.success('已更新草稿标记的部位');
    return;
  }
  try {
    await photoApi.updateAnnotation(id, { partId: pendingPartId.value });
    await loadAnnotations();
    ElMessage.success('已更新部位');
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="page-title">照片标记</h1>
        <div class="page-subtitle">点一下就记住"破在哪里"；坐标归一化保存，换设备也不会错位</div>
      </div>
      <el-button link @click="router.push({ name: 'garment-detail', params: { id: garmentId } })">返回档案</el-button>
    </div>

    <EmptyState v-if="photos.length === 0" title="这件衣物还没有照片" description="先回档案页上传一张照片，再回来标位置。">
      <el-button type="primary" @click="router.push({ name: 'garment-detail', params: { id: garmentId } })">去上传</el-button>
    </EmptyState>

    <template v-else>
      <el-card shadow="never" style="margin-bottom: 12px">
        <div class="toolbar">
          <el-radio-group :model-value="currentPhotoId" size="small" @change="(value: unknown) => switchPhoto(String(value))">
            <el-radio-button v-for="photo in photos" :key="photo.id" :label="photo.id">
              {{ PHOTO_VIEW_LABEL[photo.view as PhotoView] }}
            </el-radio-button>
          </el-radio-group>
          <el-divider direction="vertical" />
          <el-radio-group v-model="tool" size="small">
            <el-radio-button label="point">点位</el-radio-button>
            <el-radio-button label="rect">矩形</el-radio-button>
            <el-radio-button label="polyline">折线（缝合线）</el-radio-button>
          </el-radio-group>
          <el-button size="small" @click="annotatorRef?.zoomOut()">缩小</el-button>
          <el-button size="small" @click="annotatorRef?.zoomIn()">放大</el-button>
          <el-button size="small" @click="annotatorRef?.resetView()">重置视角</el-button>
          <el-button size="small" :disabled="history.length === 0" @click="undo">撤销</el-button>
          <el-button size="small" :disabled="future.length === 0" @click="redo">重做</el-button>
          <el-button v-if="tool === 'polyline'" size="small" type="warning" plain @click="annotatorRef?.finishPolyline()">
            结束折线
          </el-button>
          <el-button size="small" type="danger" plain :disabled="!selectedId" @click="removeSelected">删除选中</el-button>
          <el-button size="small" type="primary" :loading="busy" :disabled="drafts.length === 0" @click="save">
            保存 {{ drafts.length }} 个新标记
          </el-button>
        </div>

        <PhotoAnnotator
          ref="annotatorRef"
          :photo="currentPhoto"
          :annotations="annotations"
          :drafts="drafts"
          :selected-id="selectedId"
          :tool="tool"
          :pending-part-name="pendingPartName"
          @create-draft="createDraft"
          @update-geometry="updateGeometry"
          @commit-geometry="commitGeometry"
          @select="(id) => (selectedId = id)"
          @notify="(message) => ElMessage.warning(message)"
        />
      </el-card>

      <el-row :gutter="12">
        <el-col :xs="24" :md="8">
          <el-card shadow="never">
            <template #header>部位</template>
            <PartPicker v-if="dict" v-model="pendingPartId" :parts="dict.partsFlat" />
            <el-button size="small" type="primary" style="margin-top: 8px" :disabled="!selectedId" @click="applyPart">
              应用到选中的标记
            </el-button>
            <div class="field-hint">新建标记之前先选部位，新画的标记会自动带上它。</div>
          </el-card>
        </el-col>

        <el-col :xs="24" :md="8">
          <el-card shadow="never">
            <template #header>关联破损事件</template>
            <div v-if="selectedAnnotation" class="muted" style="margin-bottom: 8px">
              当前选中：
              <span class="mono">{{ selectedAnnotation.id.slice(-6) }}</span>
              · {{ selectedAnnotation.status === 'draft' ? '未关联' : '已关联' }}
            </div>
            <div v-else class="muted" style="margin-bottom: 8px">先在画布上点选一个已保存的标记</div>
            <el-select
              placeholder="选择要关联的破损事件"
              style="width: 100%"
              @change="(value: unknown) => linkToDamage(String(value))"
            >
              <el-option
                v-for="damage in damages"
                :key="damage.id"
                :value="damage.id"
                :label="`${damage.code} · ${damage.damageType.name}${damage.part ? ' · ' + damage.part.name : ''}`"
              />
            </el-select>
            <div class="field-hint">关联后标记会被冻结为当时的证据，之后编辑档案不会改变它。</div>
          </el-card>
        </el-col>

        <el-col :xs="24" :md="8">
          <el-card shadow="never">
            <template #header>标记清单（{{ annotations.length + drafts.length }}）</template>
            <div style="max-height: 320px; overflow: auto">
              <div
                v-for="draft in drafts"
                :key="draft.localId"
                style="padding: 6px 4px; border-bottom: 1px dashed #ebeef5; cursor: pointer"
                @click="selectedId = draft.localId"
              >
                <el-tag size="small" type="info">未保存</el-tag>
                {{ dict?.partsFlat.find((p) => p.id === draft.partId)?.name ?? '未选部位' }}
              </div>
              <div
                v-for="annotation in annotations"
                :key="annotation.id"
                style="padding: 6px 4px; border-bottom: 1px solid #f2f3f5; cursor: pointer"
                @click="selectedId = annotation.id"
              >
                <el-tag size="small" :type="annotation.status === 'linked' ? 'success' : 'warning'">
                  {{ annotation.status === 'linked' ? '已关联' : '待关联' }}
                </el-tag>
                {{ annotation.part?.name ?? '未选部位' }}
                <span v-if="annotation.damageEvent" class="muted"> · {{ annotation.damageEvent.damageType?.name }}</span>
              </div>
            </div>
          </el-card>
        </el-col>
      </el-row>
    </template>
  </div>
</template>
