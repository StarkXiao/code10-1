<script setup lang="ts">
/**
 * 照片标记编辑器（项目文档 10.2 / 11 章）。
 *
 * 关键点：坐标全部以归一化值（0~1）存储与回传，渲染时才乘以显示尺寸，
 * 因此换设备、换分辨率、图片被压缩都不会错位。换算逻辑复用 @gml/shared/geometry，
 * 与后端校验用的是同一份代码。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  applyZoomPan,
  fitTransform,
  hitTest,
  normalizedToViewport,
  viewportToNormalized,
  type Point,
} from '@gml/shared';
import { photoFileUrl } from '../api/client';
import type { PhotoAnnotationRow } from '../types';

export interface DraftAnnotation {
  localId: string;
  kind: 'point' | 'rect' | 'polyline';
  geometry: { x?: number; y?: number; w?: number; h?: number; points?: Point[] };
  partId: string | null;
  label: string;
  color: string;
}

const props = defineProps<{
  photo: { id: string; width: number; height: number } | null;
  annotations: PhotoAnnotationRow[];
  drafts: DraftAnnotation[];
  selectedId: string | null;
  tool: 'point' | 'rect' | 'polyline';
  pendingPartName?: string;
  maxHeight?: number;
}>();

const emit = defineEmits<{
  (e: 'create-draft', payload: { kind: DraftAnnotation['kind']; geometry: DraftAnnotation['geometry'] }): void;
  (e: 'update-geometry', payload: { source: 'saved' | 'draft'; id: string; geometry: DraftAnnotation['geometry'] }): void;
  /** 拖动结束才提交服务端：拖动过程只改本地预览，避免每移动一像素发一次请求 */
  (e: 'commit-geometry', payload: { id: string }): void;
  (e: 'select', id: string | null): void;
  (e: 'notify', message: string): void;
}>();

const wrapRef = ref<HTMLDivElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const containerSize = ref({ width: 800, height: 600 });
const zoom = ref(1);
const pan = ref<Point>({ x: 0, y: 0 });
const imageBitmap = ref<ImageBitmap | null>(null);
const imageReady = ref(false);

const dragging = ref<{
  target: 'none' | 'saved' | 'draft' | 'new-rect' | 'pan';
  id?: string;
  startNorm?: Point;
  startGeometry?: DraftAnnotation['geometry'];
  panStart?: Point;
  pointerStart?: Point;
}>({ target: 'none' });

const polylineDraft = ref<Point[]>([]);
const hoveredId = ref<string | null>(null);

const canvasHeight = computed(() => props.maxHeight ?? 520);
const imageSize = computed(() => ({ width: props.photo?.width ?? 1, height: props.photo?.height ?? 1 }));
const viewportSize = computed(() => ({ width: containerSize.value.width, height: canvasHeight.value }));
/** contain 适配（未缩放） */
const baseTransform = computed(() => fitTransform(imageSize.value, viewportSize.value));
/** 叠加缩放与平移后的实际绘制变换（缩放围绕视口中心） */
const drawTransform = computed(() =>
  applyZoomPan(baseTransform.value, viewportSize.value, zoom.value, pan.value),
);

/** 触摸双指缩放用的活动指针表 */
const activePointers = new Map<number, Point>();
let pinchStartDistance = 0;
let pinchStartZoom = 1;

function toCanvasPoint(event: PointerEvent): Point {
  const rect = canvasRef.value!.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function toNorm(event: PointerEvent): Point {
  const point = toCanvasPoint(event);
  return viewportToNormalized(point, baseTransform.value, viewportSize.value, zoom.value, pan.value);
}

function normToCanvas(point: Point): Point {
  return normalizedToViewport(point, drawTransform.value);
}

/** 限制平移范围，避免把照片拖到看不见的地方 */
function clampPan(next: Point): Point {
  const t = drawTransform.value;
  const slack = 80;
  const maxX = Math.max(slack, (t.drawWidth - viewportSize.value.width) / 2 + slack);
  const maxY = Math.max(slack, (t.drawHeight - viewportSize.value.height) / 2 + slack);
  return {
    x: Math.min(maxX, Math.max(-maxX, next.x)),
    y: Math.min(maxY, Math.max(-maxY, next.y)),
  };
}

function draw(): void {
  const canvas = canvasRef.value;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssWidth = containerSize.value.width;
  const cssHeight = canvasHeight.value;
  if (canvas.width !== cssWidth * dpr || canvas.height !== cssHeight * dpr) {
    canvas.width = cssWidth * dpr;
    canvas.height = cssHeight * dpr;
  }
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  if (imageBitmap.value && props.photo) {
    const t = drawTransform.value;
    ctx.drawImage(imageBitmap.value, t.offsetX, t.offsetY, t.drawWidth, t.drawHeight);
  } else {
    ctx.fillStyle = '#9ca3af';
    ctx.font = '14px sans-serif';
    ctx.fillText('照片加载中…', 20, 32);
  }

  const radiusScale = drawTransform.value.drawWidth;

  for (const annotation of props.annotations) {
    drawAnnotation(
      ctx,
      annotation.id,
      annotation.kind,
      annotation.geometry,
      annotation.color || (annotation.repairId ? '#1d4ed8' : '#e8590c'),
      annotation.status === 'draft',
      annotation.radius ?? 0.012,
      radiusScale,
      props.selectedId === annotation.id,
      hoveredId.value === annotation.id,
      annotation.damageEvent?.code ?? null,
    );
  }

  for (const draft of props.drafts) {
    drawAnnotation(
      ctx,
      draft.localId,
      draft.kind,
      draft.geometry,
      '#9ca3af',
      true,
      undefined,
      radiusScale,
      props.selectedId === draft.localId,
      false,
      null,
    );
  }

  if (polylineDraft.value.length > 0) {
    ctx.save();
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    polylineDraft.value.forEach((point, index) => {
      const pixel = normToCanvas(point);
      if (index === 0) ctx.moveTo(pixel.x, pixel.y);
      else ctx.lineTo(pixel.x, pixel.y);
    });
    ctx.stroke();
    ctx.restore();
    for (const point of polylineDraft.value) {
      const pixel = normToCanvas(point);
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.arc(pixel.x, pixel.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  id: string,
  kind: string,
  geometry: DraftAnnotation['geometry'],
  color: string,
  dashed: boolean,
  radiusNorm: number | undefined,
  radiusScale: number,
  selected: boolean,
  hovered: boolean,
  badge: string | null,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = selected ? 3 : 2;
  if (dashed) ctx.setLineDash([6, 4]);

  if (kind === 'point') {
    const pixel = normToCanvas({ x: geometry.x ?? 0, y: geometry.y ?? 0 });
    const radius = Math.max(6, (radiusNorm ?? 0.012) * radiusScale);
    ctx.beginPath();
    ctx.arc(pixel.x, pixel.y, radius, 0, Math.PI * 2);
    ctx.globalAlpha = 0.28;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(pixel.x, pixel.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pixel.x, pixel.y, 3, 0, Math.PI * 2);
    ctx.fill();
    if (badge) {
      ctx.font = '11px sans-serif';
      const text = badge.replace(/^.*-D/u, 'D');
      ctx.fillStyle = '#fff';
      ctx.globalAlpha = 0.9;
      ctx.fillText(text, pixel.x + radius + 4, pixel.y - 4);
      ctx.globalAlpha = 1;
    }
  } else if (kind === 'rect') {
    const a = normToCanvas({ x: geometry.x ?? 0, y: geometry.y ?? 0 });
    const b = normToCanvas({ x: (geometry.x ?? 0) + (geometry.w ?? 0), y: (geometry.y ?? 0) + (geometry.h ?? 0) });
    ctx.globalAlpha = 0.18;
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.globalAlpha = 1;
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  } else if (kind === 'polyline') {
    const points = geometry.points ?? [];
    ctx.beginPath();
    points.forEach((point, index) => {
      const pixel = normToCanvas(point);
      if (index === 0) ctx.moveTo(pixel.x, pixel.y);
      else ctx.lineTo(pixel.x, pixel.y);
    });
    ctx.stroke();
    for (const point of points) {
      const pixel = normToCanvas(point);
      ctx.beginPath();
      ctx.arc(pixel.x, pixel.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (selected || hovered) {
    ctx.setLineDash([]);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    const pixel = normToCanvas({ x: geometry.x ?? geometry.points?.[0]?.x ?? 0, y: geometry.y ?? geometry.points?.[0]?.y ?? 0 });
    ctx.beginPath();
    ctx.arc(pixel.x, pixel.y, 14, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  void id;
}

function onPointerDown(event: PointerEvent): void {
  if (!props.photo) return;
  canvasRef.value?.setPointerCapture(event.pointerId);
  const norm = toNorm(event);
  const pixel = toCanvasPoint(event);

  // 触摸双指缩放：第一根手指先记录，第二根落下时进入缩放模式
  activePointers.set(event.pointerId, pixel);
  if (activePointers.size === 2) {
    const [a, b] = [...activePointers.values()];
    pinchStartDistance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    pinchStartZoom = zoom.value;
    dragging.value = { target: 'none' };
    return;
  }

  // 中键 / 双指 / 按住空格 → 平移
  if (event.button === 1 || event.shiftKey) {
    dragging.value = { target: 'pan', panStart: { ...pan.value }, pointerStart: pixel };
    return;
  }

  if (props.tool === 'polyline') {
    polylineDraft.value.push(norm);
    draw();
    return;
  }

  const candidates = props.annotations.map((a) => ({ kind: a.kind, geometry: a.geometry }));
  const hitIndex = hitTest(norm, candidates, { width: props.photo.width, height: props.photo.height }, zoom.value, 14);
  if (hitIndex !== null) {
    const target = props.annotations[hitIndex];
    emit('select', target.id);
    dragging.value = {
      target: 'saved',
      id: target.id,
      startNorm: norm,
      startGeometry: target.geometry as DraftAnnotation['geometry'],
    };
    return;
  }

  const draftIndex = hitTest(
    norm,
    props.drafts.map((d) => ({ kind: d.kind, geometry: d.geometry })),
    { width: props.photo.width, height: props.photo.height },
    zoom.value,
    14,
  );
  if (draftIndex !== null) {
    const target = props.drafts[draftIndex];
    emit('select', target.localId);
    dragging.value = { target: 'draft', id: target.localId, startNorm: norm, startGeometry: target.geometry };
    return;
  }

  if (props.tool === 'point') {
    emit('create-draft', { kind: 'point', geometry: { x: norm.x, y: norm.y } });
    return;
  }

  if (props.tool === 'rect') {
    dragging.value = { target: 'new-rect', startNorm: norm };
  } else {
    emit('select', null);
  }
}

function onPointerMove(event: PointerEvent): void {
  if (!props.photo) return;
  const norm = toNorm(event);

  if (activePointers.has(event.pointerId)) activePointers.set(event.pointerId, toCanvasPoint(event));
  if (activePointers.size >= 2) {
    const [a, b] = [...activePointers.values()];
    const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const next = Math.min(4, Math.max(1, (pinchStartZoom * distance) / pinchStartDistance));
    zoom.value = Math.round(next * 100) / 100;
    draw();
    return;
  }

  if (dragging.value.target === 'none') {
    const index = hitTest(
      norm,
      props.annotations.map((a) => ({ kind: a.kind, geometry: a.geometry })),
      { width: props.photo.width, height: props.photo.height },
      zoom.value,
      14,
    );
    const nextHovered = index === null ? null : props.annotations[index].id;
    if (nextHovered !== hoveredId.value) {
      hoveredId.value = nextHovered;
      draw();
    }
    return;
  }

  if (dragging.value.target === 'pan') {
    const pixel = toCanvasPoint(event);
    pan.value = clampPan({
      x: (dragging.value.panStart?.x ?? 0) + (pixel.x - (dragging.value.pointerStart?.x ?? 0)),
      y: (dragging.value.panStart?.y ?? 0) + (pixel.y - (dragging.value.pointerStart?.y ?? 0)),
    });
    draw();
    return;
  }

  const start = dragging.value.startNorm!;
  const geometry = dragging.value.startGeometry;

  if (dragging.value.target === 'new-rect') {
    const rect = {
      x: Math.min(start.x, norm.x),
      y: Math.min(start.y, norm.y),
      w: Math.abs(norm.x - start.x),
      h: Math.abs(norm.y - start.y),
    };
    dragging.value.startGeometry = rect;
    draw();
    return;
  }

  if (!geometry) return;
  const dx = norm.x - start.x;
  const dy = norm.y - start.y;
  let next: DraftAnnotation['geometry'];
  if (geometry.points) {
    next = { points: geometry.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  } else if (geometry.w !== undefined) {
    next = { x: (geometry.x ?? 0) + dx, y: (geometry.y ?? 0) + dy, w: geometry.w, h: geometry.h };
  } else {
    next = { x: (geometry.x ?? 0) + dx, y: (geometry.y ?? 0) + dy };
  }
  emit('update-geometry', {
    source: dragging.value.target === 'saved' ? 'saved' : 'draft',
    id: dragging.value.id!,
    geometry: next,
  });
}

function onPointerUp(event?: PointerEvent): void {
  if (event) activePointers.delete(event.pointerId);
  if (activePointers.size < 2) pinchStartDistance = 0;
  if (dragging.value.target === 'new-rect' && dragging.value.startGeometry) {
    const geometry = dragging.value.startGeometry;
    if ((geometry.w ?? 0) > 0.01 && (geometry.h ?? 0) > 0.01) {
      emit('create-draft', { kind: 'rect', geometry });
    }
  }
  // 已保存的标记：拖动结束才落库
  if (dragging.value.target === 'saved' && dragging.value.id) {
    emit('commit-geometry', { id: dragging.value.id });
  }
  dragging.value = { target: 'none' };
}

function finishPolyline(): void {
  // 双击结束折线时，双击本身会多打一个点，这里去掉相邻的重复点
  const cleaned = polylineDraft.value.filter((point, index, list) => {
    if (index === 0) return true;
    const previous = list[index - 1];
    return Math.hypot(point.x - previous.x, point.y - previous.y) > 0.005;
  });
  if (cleaned.length >= 2) {
    emit('create-draft', { kind: 'polyline', geometry: { points: cleaned } });
  }
  polylineDraft.value = [];
  draw();
}

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  const next = Math.min(4, Math.max(1, zoom.value * (event.deltaY < 0 ? 1.12 : 0.89)));
  zoom.value = Math.round(next * 100) / 100;
  pan.value = clampPan(pan.value);
  draw();
}

function nudge(dx: number, dy: number): void {
  const id = props.selectedId;
  if (!id) return;
  const saved = props.annotations.find((a) => a.id === id);
  const draft = props.drafts.find((d) => d.localId === id);
  const geometry = saved?.geometry ?? draft?.geometry;
  if (!geometry) return;
  const shift = 0.002;
  const moved = geometry.points
    ? { points: geometry.points.map((p) => ({ x: p.x + dx * shift, y: p.y + dy * shift })) }
    : { ...(geometry as Record<string, number>), x: (geometry.x ?? 0) + dx * shift, y: (geometry.y ?? 0) + dy * shift };
  emit('update-geometry', { source: saved ? 'saved' : 'draft', id, geometry: moved });
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  if (['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
  const map: Record<string, [number, number]> = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
  };
  if (map[event.key]) {
    event.preventDefault();
    const [dx, dy] = map[event.key];
    nudge(event.shiftKey ? dx * 5 : dx, event.shiftKey ? dy * 5 : dy);
  }
  if (event.key === 'Enter') finishPolyline();
  if (event.key === 'Escape') {
    polylineDraft.value = [];
    draw();
  }
}

function resize(): void {
  const width = wrapRef.value?.clientWidth ?? 800;
  containerSize.value = { width, height: canvasHeight.value };
  draw();
}

async function loadImage(): Promise<void> {
  imageReady.value = false;
  if (!props.photo) return;
  try {
    const response = await fetch(photoFileUrl(props.photo.id));
    const blob = await response.blob();
    imageBitmap.value = await createImageBitmap(blob);
    imageReady.value = true;
  } catch {
    emit('notify', '照片加载失败，请刷新重试');
  }
  draw();
}

let observer: ResizeObserver | null = null;

onMounted(() => {
  resize();
  observer = new ResizeObserver(resize);
  if (wrapRef.value) observer.observe(wrapRef.value);
  window.addEventListener('keydown', onKeydown);
  void loadImage();
});

onUnmounted(() => {
  observer?.disconnect();
  window.removeEventListener('keydown', onKeydown);
});

watch(() => props.photo?.id, () => void loadImage());
watch(() => [props.annotations, props.drafts, props.selectedId, props.tool], draw, { deep: true });
watch(zoom, draw);

defineExpose({
  zoomIn: () => {
    zoom.value = Math.min(4, Math.round((zoom.value + 0.25) * 100) / 100);
    pan.value = clampPan(pan.value);
  },
  zoomOut: () => {
    zoom.value = Math.max(1, Math.round((zoom.value - 0.25) * 100) / 100);
    pan.value = clampPan(pan.value);
  },
  resetView: () => {
    zoom.value = 1;
    pan.value = { x: 0, y: 0 };
  },
  currentZoom: zoom,
  finishPolyline,
});
</script>

<template>
  <div>
    <div ref="wrapRef" class="annotation-canvas-wrap">
      <canvas
        ref="canvasRef"
        tabindex="0"
        :style="{ cursor: tool === 'point' ? 'crosshair' : tool === 'rect' ? 'cell' : 'default' }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @wheel="onWheel"
        @dblclick="finishPolyline"
      />
    </div>
    <div class="muted" style="margin-top: 6px">
      <span v-if="pendingPartName">当前部位：{{ pendingPartName }} ·</span>
      缩放 {{ Math.round(zoom * 100) }}% · Shift+拖动平移 · 方向键微调选中标记 · 回车结束折线
      <span v-if="!imageReady" style="color: #e6a23c"> · 图片加载中</span>
    </div>
  </div>
</template>
