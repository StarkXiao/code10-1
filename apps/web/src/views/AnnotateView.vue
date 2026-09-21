<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  BATCH_POINT_MAX,
  PHOTO_VIEW_LABEL,
  applyProjection,
  generatePointsInRect,
  geometryAnchor,
  type BatchPointMode,
  type PhotoView,
  type Point,
} from '@gml/shared';
import { damageApi, photoApi, wardrobeApi } from '../api';
import { messageOf } from '../api/client';
import PhotoAnnotator, {
  type AnnotatorTool,
  type BatchPreview,
  type DraftAnnotation,
  type FocusRequest,
  type GhostAnnotation,
} from '../components/PhotoAnnotator.vue';
import PartPicker from '../components/PartPicker.vue';
import EmptyState from '../components/EmptyState.vue';
import { useViewLink } from '../composables/useViewLink';
import type { DamageListItem, DictionaryResponse, GarmentPhotoRow, PhotoAnnotationRow } from '../types';

const route = useRoute();
const router = useRouter();
const garmentId = String(route.params.id);

const photos = ref<GarmentPhotoRow[]>([]);
/** 每张照片已加载的标记缓存：多视角联动要同时读两张照片上的标记 */
const annotationsByPhoto = ref<Record<string, PhotoAnnotationRow[]>>({});
const annotations = ref<PhotoAnnotationRow[]>([]);
const drafts = ref<DraftAnnotation[]>([]);
const currentPhotoId = ref(String(route.query.photoId ?? ''));
const tool = ref<AnnotatorTool>('point');
const selectedId = ref<string | null>(null);
const pendingPartId = ref<string | null>(null);
const dict = ref<DictionaryResponse | null>(null);
const damages = ref<DamageListItem[]>([]);
const busy = ref(false);
const history = ref<DraftAnnotation[][]>([]);
const future = ref<DraftAnnotation[][]>([]);
const annotatorRef = ref<InstanceType<typeof PhotoAnnotator> | null>(null);

/** 多视角联动开关；关闭后切换视角只换图，不做对齐 */
const linkEnabled = ref(true);
/** 切换视角时从源照片带来的上下文 */
const linkContext = ref<{
  sourcePhotoId: string;
  projection: ReturnType<ReturnType<typeof useViewLink>['resolveProjection']>;
  ghosts: GhostAnnotation[];
  focus: FocusRequest | null;
  alignedAnnotationId: string | null;
  reason: string;
} | null>(null);

const {
  calibrating,
  calibrationState,
  beginCalibration,
  markTargetPhase,
  recordCalibrationClick,
  cancelCalibration,
  resolveProjection,
  pairCount,
  clearCalibration,
} = useViewLink(garmentId);

/** 框选批量生成的配置面板 */
const batchPanel = reactive({
  visible: false,
  rect: { x: 0, y: 0, w: 0, h: 0 } as { x: number; y: number; w: number; h: number },
  mode: 'stagger' as BatchPointMode,
  cols: 5,
  rows: 5,
  count: 20,
  jitter: 0,
});
const batchPreview = ref<BatchPreview | null>(null);

const currentPhoto = computed(() => photos.value.find((p) => p.id === currentPhotoId.value) ?? null);
const pendingPartName = computed(() => dict.value?.partsFlat.find((p) => p.id === pendingPartId.value)?.name ?? '');
const selectedAnnotation = computed(() => annotations.value.find((a) => a.id === selectedId.value) ?? null);
const ghosts = computed<GhostAnnotation[]>(() => (linkEnabled.value ? (linkContext.value?.ghosts ?? []) : []));
/** 校准模式下：源照片上已点的起点给个标记，避免忘记点过哪 */
const calibrationPoints = computed<Point[]>(() => {
  const state = calibrationState.value;
  if (state && state.phase === 'source' && state.sourcePhotoId === currentPhotoId.value) {
    return [state.sourcePoint];
  }
  return [];
});

function recomputeBatchPreview(): void {
  if (!batchPanel.visible) {
    batchPreview.value = null;
    return;
  }
  const points = generatePointsInRect(batchPanel.rect, {
    mode: batchPanel.mode,
    cols: batchPanel.cols,
    rows: batchPanel.rows,
    count: batchPanel.count,
    jitter: batchPanel.jitter / 100,
    // 固定种子：拖动滑块时同参数预览保持稳定
    seed: 20260920,
  });
  batchPreview.value = { rect: batchPanel.rect, points };
}

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
    // 列表接口已带每张照片的标记，先填缓存，联动对齐在切换前就能用
    for (const photo of photoData.photos) {
      if (photo.annotations) annotationsByPhoto.value[photo.id] = photo.annotations;
    }
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
  const data = await photoApi.annotations(currentPhotoId.value);
  annotations.value = data.annotations;
  annotationsByPhoto.value[currentPhotoId.value] = data.annotations;
}

/** 找当前选中标记在目标照片上的"同一部位"标记：优先破损事件相同，其次部位相同 */
function findCounterpart(
  sourceAnnotation: PhotoAnnotationRow,
  targetRows: PhotoAnnotationRow[],
): PhotoAnnotationRow | null {
  if (sourceAnnotation.damageEventId) {
    const sameDamage = targetRows.find((a) => a.damageEventId === sourceAnnotation.damageEventId);
    if (sameDamage) return sameDamage;
  }
  if (sourceAnnotation.partId) {
    const samePart = targetRows.find((a) => a.partId === sourceAnnotation.partId);
    if (samePart) return samePart;
  }
  return null;
}

/**
 * 切换视角的核心：算好"源照片标记 → 目标照片"的投影与鬼影，
 * 目标照片标记加载完后再决定聚焦到哪里（对齐同一部位）。
 */
async function switchPhoto(id: string): Promise<void> {
  if (id === currentPhotoId.value) return;

  // 校准模式切换照片不丢草稿、不打断校准流程
  if (!calibrating.value && drafts.value.length > 0) {
    try {
      await ElMessageBox.confirm('切换照片会丢弃当前未保存的标记，继续？', '提示', { type: 'warning' });
    } catch {
      return;
    }
  }

  const sourceId = currentPhotoId.value;
  const sourcePhoto = currentPhoto.value;
  const targetPhoto = photos.value.find((p) => p.id === id);
  const sourceRows = sourceId ? (annotationsByPhoto.value[sourceId] ?? []) : [];
  // selectedId 在下面会被清空，先取出源照片上被选中的标记
  const selectedSource = sourceRows.find((a) => a.id === selectedId.value) ?? null;
  // 校准备注：源照片已点起点、正在切往目标照片
  const wasCalibrating =
    calibrating.value && calibrationState.value?.phase === 'source' && calibrationState.value.sourcePhotoId === sourceId;

  const previousId = currentPhotoId.value;
  currentPhotoId.value = id;
  drafts.value = [];
  history.value = [];
  future.value = [];
  selectedId.value = null;
  linkContext.value = null;
  if (wasCalibrating) markTargetPhase();
  await loadAnnotations();
  const targetRows = annotationsByPhoto.value[id] ?? [];

  // ---- 校准模式：在目标照片点第二下即可完成配对，先不做联动对齐 ----
  if (wasCalibrating && previousId) {
    ElMessage.info('已切到目标视角，请在同一位置点一下完成校准');
    return;
  }

  if (!linkEnabled.value || !sourcePhoto || !targetPhoto || sourceRows.length === 0) return;

  // 1. 选中标记在目标照片上已有"同一部位"标记 → 直接选它并聚焦
  if (selectedSource) {
    const counterpart = findCounterpart(selectedSource, targetRows);
    if (counterpart) {
      const anchor = geometryAnchor(counterpart);
      selectedId.value = counterpart.id;
      linkContext.value = {
        sourcePhotoId: sourceId,
        projection: { projection: null, autoPairs: 0, manualPairs: 0, rmseWarn: false },
        ghosts: [],
        focus: anchor ? { nonce: Date.now(), norm: anchor, zoom: 1.8 } : null,
        alignedAnnotationId: counterpart.id,
        reason: counterpart.damageEventId === selectedSource.damageEventId ? '同一破损事件' : '同一部位',
      };
      ElMessage.success(`已对齐到目标视角上「${counterpart.part?.name ?? counterpart.damageEvent?.damageType?.name ?? '同一部位'}」的标记`);
      return;
    }
  }

  // 2. 同名点拟合投影（已有同部位标记 / 手动校准点 / 标准构图恒等兜底）
  const result = resolveProjection({
    sourcePhotoId: sourcePhoto.id,
    targetPhotoId: targetPhoto.id,
    sourceView: sourcePhoto.view,
    targetView: targetPhoto.view,
    paired: !!sourcePhoto.pairedPhotoId && sourcePhoto.pairedPhotoId === targetPhoto.id,
    sourceAnnotations: sourceRows,
    targetAnnotations: targetRows,
  });
  if (!result.projection) {
    ElMessage.info('这两个视角还没有对齐依据：可先用「视角校准」在两图各点一个同一位置');
    return;
  }

  // 投影源照片上的标记：落在目标照片范围内的显示为鬼影
  const ghostsList: GhostAnnotation[] = [];
  let activePoint: Point | null = null;
  for (const row of sourceRows) {
    const anchor = geometryAnchor(row);
    if (!anchor) continue;
    const projected = applyProjection(result.projection, anchor);
    if (projected.x < -0.05 || projected.x > 1.05 || projected.y < -0.05 || projected.y > 1.05) continue;
    const isActive = selectedSource ? row.id === selectedSource.id : false;
    ghostsList.push({ id: row.id, point: projected, active: isActive });
    if (isActive) activePoint = projected;
  }

  let focus: FocusRequest | null = null;
  if (activePoint) {
    focus = { nonce: Date.now(), norm: activePoint, zoom: 1.8 };
  } else if (ghostsList.length > 0 && !selectedSource) {
    // 没选中具体标记时，把视角带到鬼影最密集的区域中心
    const center = ghostsList.reduce(
      (acc, ghost) => ({ x: acc.x + ghost.point.x, y: acc.y + ghost.point.y }),
      { x: 0, y: 0 },
    );
    focus = { nonce: Date.now(), norm: { x: center.x / ghostsList.length, y: center.y / ghostsList.length }, zoom: 1.4 };
  }

  linkContext.value = {
    sourcePhotoId: sourceId,
    projection: result,
    ghosts: ghostsList,
    focus,
    alignedAnnotationId: null,
    reason: '',
  };

  if (result.rmseWarn) {
    ElMessage.warning('校准点之间偏差较大（可能有点点歪），可用「视角校准」补/清后重试');
  }
}

function onCalibrateClick(norm: Point): void {
  const { completed, count } = recordCalibrationClick(currentPhotoId.value, norm);
  if (completed) {
    ElMessage.success(`视角校准完成（这对视角已累计 ${count} 个同名点），之后切换视角会按它对齐`);
    tool.value = 'point';
    return;
  }
  ElMessage.info('已记下这个位置，请切换到另一张视角照片，在同一位置再点一下');
}

/** 工具栏：进入/退出视角校准 */
function toggleCalibrate(): void {
  if (calibrating.value) {
    cancelCalibration();
    tool.value = 'point';
    ElMessage.info('已退出视角校准');
  } else {
    beginCalibration();
    tool.value = 'calibrate';
    selectedId.value = null;
    ElMessage.info('视角校准：先在当前照片点一个明显位置（如领口中心），再切到另一张照片点同一处');
  }
}

/** 清除当前两张照片之间的手动校准点 */
async function clearCurrentCalibration(): Promise<void> {
  const other = photos.value.find((p) => p.id !== currentPhotoId.value);
  if (!other) {
    ElMessage.info('至少需要两张照片才能校准');
    return;
  }
  const count = pairCount(currentPhotoId.value, other.id);
  if (count === 0) {
    ElMessage.info('当前视角之间还没有手动校准点');
    return;
  }
  try {
    await ElMessageBox.confirm(`将清除这两张照片之间的 ${count} 个手动校准点，继续？`, '清除校准', {
      type: 'warning',
    });
  } catch {
    return;
  }
  clearCalibration(currentPhotoId.value, other.id);
  ElMessage.success('已清除手动校准点');
}

function onBatchRect(rect: { x: number; y: number; w: number; h: number }): void {
  batchPanel.rect = rect;
  batchPanel.visible = true;
  batchPanel.mode = 'stagger';
  recomputeBatchPreview();
}

function closeBatchPanel(): void {
  batchPanel.visible = false;
  recomputeBatchPreview();
}

/** 确认批量生成：预览点全部转成草稿点位（与单点位工具产出同构，走同一个保存接口） */
function acceptBatch(): void {
  const points = batchPreview.value?.points ?? [];
  if (points.length === 0) {
    ElMessage.warning('区域太小或参数为 0，没有可生成的点');
    return;
  }
  snapshot();
  const now = Date.now();
  points.forEach((point, index) => {
    drafts.value.push({
      localId: `draft-${now}-${index}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'point',
      geometry: { x: point.x, y: point.y },
      partId: pendingPartId.value,
      label: '',
      color: '#9ca3af',
    });
  });
  ElMessage.success(`已生成 ${points.length} 个点位草稿，确认后点「保存」写入`);
  closeBatchPanel();
  tool.value = 'point';
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
    if (annotationsByPhoto.value[currentPhotoId.value]) {
      annotationsByPhoto.value[currentPhotoId.value] = annotations.value;
    }
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
      <el-card shadow="never" style="margin-bottom: 12px" class="annotator-card">
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
            <el-radio-button label="batch">框选批量</el-radio-button>
          </el-radio-group>
          <el-button
            size="small"
            :type="calibrating ? 'warning' : 'default'"
            plain
            @click="toggleCalibrate"
          >
            {{ calibrating ? '退出校准' : '视角校准' }}
          </el-button>
          <el-tooltip content="清除这两张照片之间手动点的校准同名点（自动配对的同部位标记不受影响）" placement="top">
            <el-button size="small" @click="clearCurrentCalibration">清除校准</el-button>
          </el-tooltip>
          <el-divider direction="vertical" />
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

        <div class="link-bar">
          <el-switch v-model="linkEnabled" size="small" inline-prompt active-text="多视角联动" inactive-text="" />
          <span class="muted">
            <template v-if="linkContext?.alignedAnnotationId">
              已自动对齐到目标视角上<em>{{ linkContext.reason }}</em>的标记
            </template>
            <template v-else-if="linkContext && linkContext.ghosts.length > 0">
              已按 {{ linkContext.projection.autoPairs > 0 ? `${linkContext.projection.autoPairs} 个同部位标记` : '' }}
              {{ linkContext.projection.autoPairs > 0 && linkContext.projection.manualPairs > 0 ? '＋' : '' }}
              {{ linkContext.projection.manualPairs > 0 ? `${linkContext.projection.manualPairs} 个手动校准点` : '' }}
              {{ linkContext.projection.autoPairs === 0 && linkContext.projection.manualPairs === 0 ? '标准构图（坐标直接沿用）' : '' }}
              投影 {{ linkContext.ghosts.length }} 个标记，<span style="color: #60a5fa">蓝色虚圈</span>为另一视角的同一部位
            </template>
            <template v-else-if="linkEnabled">切换视角时自动对齐同一部位；先点选一个标记再切换，定位更准</template>
          </span>
        </div>

        <PhotoAnnotator
          ref="annotatorRef"
          :photo="currentPhoto"
          :annotations="annotations"
          :drafts="drafts"
          :selected-id="selectedId"
          :tool="tool"
          :pending-part-name="pendingPartName"
          :ghosts="ghosts"
          :batch-preview="batchPreview"
          :calibration-points="calibrationPoints"
          :focus-request="linkContext?.focus ?? null"
          @create-draft="createDraft"
          @batch-rect="onBatchRect"
          @calibrate-click="onCalibrateClick"
          @update-geometry="updateGeometry"
          @commit-geometry="commitGeometry"
          @select="(id) => (selectedId = id)"
          @notify="(message) => ElMessage.warning(message)"
        />

        <!-- 框选区域批量布点配置 -->
        <el-card v-if="batchPanel.visible" shadow="always" class="batch-panel">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center">
              <span>在框选区域内批量生成点位</span>
              <el-button link type="info" @click="closeBatchPanel">收起</el-button>
            </div>
          </template>
          <el-radio-group v-model="batchPanel.mode" size="small" @change="recomputeBatchPreview" style="margin-bottom: 10px">
            <el-radio-button label="stagger">交错点阵</el-radio-button>
            <el-radio-button label="grid">规则网格</el-radio-button>
            <el-radio-button label="random">随机散布</el-radio-button>
          </el-radio-group>

          <div v-if="batchPanel.mode !== 'random'" class="batch-row">
            <span>列数 {{ batchPanel.cols }}</span>
            <el-slider v-model="batchPanel.cols" :min="1" :max="10" :step="1" style="flex: 1; margin: 0 12px" @input="recomputeBatchPreview" />
            <span>行数 {{ batchPanel.rows }}</span>
            <el-slider v-model="batchPanel.rows" :min="1" :max="10" :step="1" style="flex: 1; margin: 0 12px" @input="recomputeBatchPreview" />
          </div>
          <div v-else class="batch-row">
            <span>点数 {{ batchPanel.count }}</span>
            <el-slider v-model="batchPanel.count" :min="1" :max="BATCH_POINT_MAX" :step="1" style="flex: 1; margin: 0 12px" @input="recomputeBatchPreview" />
          </div>
          <div v-if="batchPanel.mode !== 'random'" class="batch-row">
            <span>随机抖动 {{ batchPanel.jitter }}%</span>
            <el-slider v-model="batchPanel.jitter" :min="0" :max="40" :step="5" style="flex: 1; margin: 0 12px" @input="recomputeBatchPreview" />
          </div>

          <div class="muted" style="margin: 6px 0 10px">
            将生成 <strong style="color: #b45309">{{ batchPreview?.points.length ?? 0 }}</strong> 个点位（最多 {{ BATCH_POINT_MAX }} 个），
            自动带上当前部位「{{ pendingPartName || '未选部位' }}」；生成后仍是草稿，可微调后再统一保存。
          </div>
          <div>
            <el-button size="small" @click="closeBatchPanel">取消</el-button>
            <el-button size="small" type="primary" @click="acceptBatch">生成点位草稿</el-button>
          </div>
        </el-card>
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
