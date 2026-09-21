/**
 * 照片标记坐标换算（项目文档 11.1）。
 * 纯函数，前后端共用：前端渲染时算像素，后端校验与导出时算像素。
 */
export const COORD_PRECISION = 4;

export interface Point {
  x: number;
  y: number;
}

export interface RectGeometry extends Point {
  w: number;
  h: number;
}

export interface PolylineGeometry {
  points: Point[];
}

export interface ImageSize {
  width: number;
  height: number;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function roundCoord(value: number): number {
  const factor = 10 ** COORD_PRECISION;
  return Math.round(clamp01(value) * factor) / factor;
}

/** 归一化 → 像素 */
export function toPixel(point: Point, size: ImageSize): Point {
  return { x: point.x * size.width, y: point.y * size.height };
}

/** 像素 → 归一化（写入前一律做钳制与精度处理） */
export function toNormalized(point: Point, size: ImageSize): Point {
  if (!size.width || !size.height) return { x: 0, y: 0 };
  return { x: roundCoord(point.x / size.width), y: roundCoord(point.y / size.height) };
}

/**
 * 计算图片在容器内的显示变换：contain 适配 + 居中。
 * 标记渲染与命中检测都基于这个变换，避免"看得见的点"和"算出的点"错位。
 */
export function fitTransform(image: ImageSize, viewport: ImageSize) {
  if (!image.width || !image.height || !viewport.width || !viewport.height) {
    return { scale: 1, offsetX: 0, offsetY: 0, drawWidth: 0, drawHeight: 0 };
  }
  const scale = Math.min(viewport.width / image.width, viewport.height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  return {
    scale,
    offsetX: (viewport.width - drawWidth) / 2,
    offsetY: (viewport.height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  };
}

/**
 * 在基础 contain 适配之上叠加缩放与平移。
 *
 * 关键：缩放要围绕**视口中心**进行（而不是围绕左上角），
 * 否则放大后画面会整体往右下跑，用户看到的中心内容直接移出视口。
 */
export function applyZoomPan(
  base: ReturnType<typeof fitTransform>,
  viewport: ImageSize,
  zoom = 1,
  pan: Point = { x: 0, y: 0 },
) {
  const drawWidth = base.drawWidth * zoom;
  const drawHeight = base.drawHeight * zoom;
  return {
    scale: base.scale * zoom,
    drawWidth,
    drawHeight,
    offsetX: (viewport.width - drawWidth) / 2 + pan.x,
    offsetY: (viewport.height - drawHeight) / 2 + pan.y,
  };
}

export type EffectiveTransform = ReturnType<typeof applyZoomPan>;

/** 归一化图片坐标 → 容器坐标（与 viewportToNormalized 互逆） */
export function normalizedToViewport(point: Point, transform: EffectiveTransform): Point {
  return {
    x: transform.offsetX + point.x * transform.drawWidth,
    y: transform.offsetY + point.y * transform.drawHeight,
  };
}

/** 容器坐标 → 归一化图片坐标（考虑缩放与平移） */
export function viewportToNormalized(
  client: Point,
  base: ReturnType<typeof fitTransform>,
  viewport: ImageSize,
  zoom = 1,
  pan: Point = { x: 0, y: 0 },
): Point {
  const transform = applyZoomPan(base, viewport, zoom, pan);
  if (!transform.drawWidth || !transform.drawHeight) return { x: 0, y: 0 };
  const x = (client.x - transform.offsetX) / transform.drawWidth;
  const y = (client.y - transform.offsetY) / transform.drawHeight;
  return { x: roundCoord(x), y: roundCoord(y) };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 在框选矩形内生成均匀网格点（批量点位工具）。
 *
 * 点落在各自网格单元的中心而不是边界上，避免贴边的点被下一次框选重复命中；
 * 坐标统一做钳制与精度处理。rows/cols 非法或矩形退化时返回空数组（由调用方提示）。
 */
export function gridPointsInRect(rect: RectGeometry, rows: number, cols: number): Point[] {
  const r = Math.floor(rows);
  const c = Math.floor(cols);
  if (!Number.isFinite(r) || !Number.isFinite(c) || r < 1 || c < 1 || r > 20 || c > 20) return [];
  if (!(rect.w > 0) || !(rect.h > 0)) return [];
  const points: Point[] = [];
  for (let row = 0; row < r; row += 1) {
    for (let col = 0; col < c; col += 1) {
      points.push({
        x: roundCoord(rect.x + (rect.w * (col + 0.5)) / c),
        y: roundCoord(rect.y + (rect.h * (row + 0.5)) / r),
      });
    }
  }
  return points;
}

/**
 * 计算"把某个归一化点移到视口中心"所需的平移量（多视角联动对齐用）。
 *
 * 推导：applyZoomPan 中 offsetX = (viewport.width - drawWidth)/2 + pan.x，
 * 要让 normalizedToViewport(point) 恰好等于视口中心，解出 pan = draw × (0.5 - point)。
 * 返回值的合法性（别把照片拖没）由调用方的 clampPan 保证。
 */
export function panForFocus(
  point: Point,
  base: ReturnType<typeof fitTransform>,
  viewport: ImageSize,
  zoom = 1,
): Point {
  return {
    x: base.drawWidth * zoom * (0.5 - point.x),
    y: base.drawHeight * zoom * (0.5 - point.y),
  };
}

/** 命中检测：返回命中的标记索引（从后往前，后画的优先） */
export function hitTest(
  point: Point,
  annotations: Array<{ kind: string; geometry: unknown }>,
  image: ImageSize,
  zoom: number,
  tolerancePx = 12,
): number | null {
  // 归一化坐标下 x/y 的"1 个单位"对应不同像素数（照片多半不是正方形），
  // 所以两个方向要各算各的容差，否则竖图上的纵向命中范围会被放大好几倍。
  const zoomFactor = 1 / Math.max(zoom, 0.0001);
  const toleranceX = (tolerancePx / Math.max(image.width, 1)) * zoomFactor;
  const toleranceY = (tolerancePx / Math.max(image.height, 1)) * zoomFactor;
  for (let i = annotations.length - 1; i >= 0; i -= 1) {
    const ann = annotations[i];
    const geometry = ann.geometry as Record<string, unknown>;
    if (ann.kind === 'point' || ann.kind === 'rect') {
      const g = geometry as unknown as RectGeometry;
      const w = ann.kind === 'rect' ? (g.w ?? 0) : 0;
      const h = ann.kind === 'rect' ? (g.h ?? 0) : 0;
      if (
        point.x >= g.x - toleranceX &&
        point.x <= g.x + w + toleranceX &&
        point.y >= g.y - toleranceY &&
        point.y <= g.y + h + toleranceY
      ) {
        return i;
      }
    } else if (ann.kind === 'polyline') {
      const points = (geometry as unknown as PolylineGeometry).points ?? [];
      for (const p of points) {
        if (Math.abs(point.x - p.x) <= toleranceX * 2 && Math.abs(point.y - p.y) <= toleranceY * 2) return i;
      }
    }
  }
  return null;
}
