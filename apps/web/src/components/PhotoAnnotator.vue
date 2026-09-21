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

export type AnnotatorTool = 'point' | 'rect' | 'polyline' | 'batch' | 'calibrate';

export interface DraftAnnotation {
  localId: string;
  kind: 'point' | 'rect' | 'polyline';
  geometry: { x?: number; y?: number; w?: number; h?: number; points?: Point[] };
  partId: string | null;
  label: string;
  color: string;
}

/** 跨视角联动时，从另一张照片投影过来的"鬼影"标记 */
export interface GhostAnnotation {
  id: string;
  point: Point;
  active: boolean;
}

/** 框选批量布点的预览点（在配置面板参数变化时实时预览） */
export interface BatchPreview {
  rect: { x: number; y: number; w: number; h: number };
  points: Point[];
}

/** 请求画布把某个归一化坐标居中并放大（切换视角联动对齐时由父组件发出） */
export interface FocusRequest {
  nonce: number;
  norm: Point;
  zoom?: number;
}

const props = defineProps<{
  photo: { id: string; width: number; height: number } | null;
  annotations: PhotoAnnotationRow[];
  drafts: DraftAnnotation[];
  selectedId: string | null;
  tool: AnnotatorTool;
  pendingPartName?: string;
  maxHeight?: number;
  /** 切换视角后从源照片投影过来的标记位置，虚线圆显示在画布上 */
  ghosts?: GhostAnnotation[];
  /** 框选批量布点的实时预览（矩形 + 将要生成的点） */
  batchPreview?: BatchPreview | null;
  /** 视角校准模式下已落在本张照片上的校准点 */
  calibrationPoints?: Point[];
  /** 请求聚焦到某点（带动画），nonce 变化即触发 */
  focusRequest?: FocusRequest | null;
}>();

const emit = defineEmits<{
  (e: 'create-draft', payload: { kind: DraftAnnotation['kind']; geometry: DraftAnnotation['geometry'] }): void;
  /** 框选结束：把归一化矩形交给父组件弹批量配置 */
  (e: 'batch-rect', rect: { x: number; y: number; w: number; h: number }): void;
  /** 校准模式下点击画布 */
  (e: 'calibrate-click', norm: Point): void;
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
  target: 'none' | 'saved' | 'draft' | 'new-rect' | 'new-batch' | 'pan';
  id?: string;
  startNorm?: Point;
  startGeometry?: DraftAnnotation['geometry'];
  panStart?: Point;
  pointerStart?: Point;
}>({ target: 'none' });

const polylineDraft = ref<Point[]>([]);
const hoveredId = ref<string | null>(null);
/** 框选过程中的临时矩形（rect 工具画矩形、batch 工具圈批量区域共用） */
const marqueeRect = ref<{ x: number; y: number; w: number; h: number } | null>(null);

let focusAnimationFrame = 0;

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

  // 多视角联动：另一张照片投影过来的标记（鬼影）。只显示位置提示，不可直接编辑
  for (const ghost of props.ghosts ?? []) {
    const pixel = normToCanvas(ghost.point);
    if (pixel.x < -20 || pixel.x > cssWidth + 20 || pixel.y < -20 || pixel.y > cssHeight + 20) continue;
    ctx.save();
    ctx.strokeStyle = ghost.active ? '#34d399' : '#60a5fa';
    ctx.lineWidth = ghost.active ? 2.5 : 1.5;
    ctx.setLineDash([4, 4]);
    ctx.globalAlpha = ghost.active ? 0.95 : 0.55;
    ctx.beginPath();
    ctx.arc(pixel.x, pixel.y, ghost.active ? 11 : 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = ghost.active ? 0.35 : 0.2;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(pixel.x, pixel.y, ghost.active ? 5 : 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 视角校准点：本张照片上已确认的同名点
  for (const point of props.calibrationPoints ?? []) {
    const pixel = normToCanvas(point);
    ctx.save();
    ctx.strokeStyle = '#c084fc';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pixel.x, pixel.y, 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pixel.x - 13, pixel.y);
    ctx.lineTo(pixel.x + 13, pixel.y);
    ctx.moveTo(pixel.x, pixel.y - 13);
    ctx.lineTo(pixel.x, pixel.y + 13);
    ctx.stroke();
    ctx.restore();
  }

  // 框选批量布点：配置面板预览的矩形与待生成点
  const preview = props.batchPreview;
  if (preview) {
    drawMarquee(ctx, preview.rect, '#f59e0b');
    for (const point of preview.points) {
      const pixel = normToCanvas(point);
      ctx.save();
      ctx.fillStyle = '#f59e0b';
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc(pixel.x, pixel.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // 正在拖的框选矩形（rect / batch 工具共用橡皮筋反馈）
  if (marqueeRect.value) {
    drawMarquee(ctx, marqueeRect.value, props.tool === 'batch' ? '#f59e0b' : '#9ca3af');
  }

  ctx.restore();
}

/** 框选矩形：半透明填充 + 虚线描边 */
function drawMarquee(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; w: number; h: number }, color: string): void {
  const a = normToCanvas({ x: rect.x, y: rect.y });
  const b = normToCanvas({ x: rect.x + rect.w, y: rect.y + rect.h });
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.12;
  ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  ctx.restore();
}

/** 以动画方式把归一化坐标居中并缩放到目标倍率（多视角联动对齐同一部位） */
function focusOnNorm(target: Point, targetZoom = 1.8): void {
  cancelAnimationFrame(focusAnimationFrame);
  const startZoom = zoom.value;
  const startPan = { ...pan.value };
  // 目标点在视口居中所需的 pan：pan = 视口中心 - 目标点在 base 变换下的位置 × zoom
  const base = baseTransform.value;
  const goalPan = {
    x: viewportSize.value.width / 2 - (base.offsetX + target.x * base.drawWidth) * targetZoom,
    y: viewportSize.value.height / 2 - (base.offsetY + target.y * base.drawHeight) * targetZoom,
  };
  const duration = 280;
  const startTime = performance.now();
  const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const step = (now: number): void => {
    const t = Math.min(1, (now - startTime) / duration);
    const k = ease(t);
    zoom.value = Math.round((startZoom + (targetZoom - startZoom) * k) * 100) / 100;
    pan.value = {
      x: startPan.x + (goalPan.x - startPan.x) * k,
      y: startPan.y + (goalPan.y - startPan.y) * k,
    };
    draw();
    if (t < 1) focusAnimationFrame = requestAnimationFrame(step);
    else pan.value = clampPan(pan.value);
  };
  focusAnimationFrame = requestAnimationFrame(step);
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

  // 视角校准：点一下就上报，不选标记、不画矩形
  if (props.tool === 'calibrate') {
    emit('calibrate-click', norm);
    draw();
    return;
  }

  // 框选批量：在空白处拖出一个矩形区域，松手交给父组件弹配置
  if (props.tool === 'batch') {
    dragging.value = { target: 'new-batch', startNorm: norm };
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
    // 校准/框选工具下光标不做标记悬停高亮，避免误导
    if (props.tool === 'calibrate' || props.tool === 'batch') {
      if (hoveredId.value !== null) {
        hoveredId.value = null;
        draw();
      }
      return;
    }
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

  if (dragging.value.target === 'new-rect' || dragging.value.target === 'new-batch') {
    const rect = {
      x: Math.min(start.x, norm.x),
      y: Math.min(start.y, norm.y),
      w: Math.abs(norm.x - start.x),
      h: Math.abs(norm.y - start.y),
    };
    dragging.value.startGeometry = rect;
    marqueeRect.value = rect;
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
  if (
    (dragging.value.target === 'new-rect' || dragging.value.target === 'new-batch') &&
    dragging.value.startGeometry
  ) {
    const geometry = dragging.value.startGeometry as { x: number; y: number; w: number; h: number };
    marqueeRect.value = null;
    if ((geometry.w ?? 0) > 0.01 && (geometry.h ?? 0) > 0.01) {
      if (dragging.value.target === 'new-batch') emit('batch-rect', geometry);
      else emit('create-draft', { kind: 'rect', geometry });
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
  cancelAnimationFrame(focusAnimationFrame);
});

watch(() => props.photo?.id, () => void loadImage());
watch(
  () => [props.annotations, props.drafts, props.selectedId, props.tool, props.ghosts, props.batchPreview, props.calibrationPoints],
  draw,
  { deep: true },
);
watch(zoom, draw);

// 切走框选类工具时丢弃没画完的橡皮筋矩形，避免残留在画布上
watch(
  () => props.tool,
  (toolValue, previous) => {
    if (toolValue !== previous && (dragging.value.target === 'new-rect' || dragging.value.target === 'new-batch')) {
      dragging.value = { target: 'none' };
      marqueeRect.value = null;
    }
  },
);

// 父组件请求聚焦（切换视角联动）：nonce 变化时播放一次居中动画
watch(
  () => props.focusRequest?.nonce,
  (nonce) => {
    if (nonce && props.focusRequest) focusOnNorm(props.focusRequest.norm, props.focusRequest.zoom ?? 1.8);
  },
);

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
  focusOnNorm,
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
        :style="{
          cursor:
            tool === 'point' || tool === 'batch' || tool === 'calibrate'
              ? 'crosshair'
              : tool === 'rect'
                ? 'cell'
                : 'default',
        }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @wheel="onWheel"
        @dblclick="finishPolyline"
      />
    </div>
    <div class="muted" style="margin-top: 6px">
      <span v-if="tool === 'batch'" style="color: #b45309">框选批量：在图上拖出区域后松开，即可在区域内批量生成点位。 ·</span>
      <span v-else-if="tool === 'calibrate'" style="color: #7e22ce">视角校准：在两张照片上各点一下同一个位置，切换视角就会自动对齐。 ·</span>
      <span v-if="pendingPartName">当前部位：{{ pendingPartName }} ·</span>
      缩放 {{ Math.round(zoom * 100) }}% · Shift+拖动平移 · 方向键微调选中标记 · 回车结束折线
      <span v-if="!imageReady" style="color: #e6a23c"> · 图片加载中</span>
    </div>
  </div>
</template>
