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

// ---------------------------------------------------------------- 多视角联动

/**
 * 能参与跨视角对齐的标记：几何形状取锚点，配对键（部位 / 破损事件）在行顶层。
 * 前端 PhotoAnnotationRow 与后端返回结构一致，可直接传入。
 */
export interface AnchorSource {
  kind: string;
  geometry: unknown;
  partId?: string | null;
  damageEventId?: string | null;
}

/**
 * 取一个标记的"锚点"（归一化坐标）：
 * 点位取自身、矩形取中心、折线取各顶点重心。
 * 跨视角对齐与同名点拟合都基于这个锚点，保证不同 kind 的标记也能参与校准。
 */
export function geometryAnchor(annotation: AnchorSource): Point | null {
  const geometry = annotation.geometry as Record<string, unknown>;
  if (annotation.kind === 'polyline') {
    const points = (geometry.points as Point[] | undefined) ?? [];
    if (points.length === 0) return null;
    const sum = points.reduce(
      (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
      { x: 0, y: 0 },
    );
    return { x: sum.x / points.length, y: sum.y / points.length };
  }
  const x = typeof geometry.x === 'number' ? geometry.x : NaN;
  const y = typeof geometry.y === 'number' ? geometry.y : NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (annotation.kind === 'rect') {
    const w = typeof geometry.w === 'number' ? geometry.w : 0;
    const h = typeof geometry.h === 'number' ? geometry.h : 0;
    return { x: x + w / 2, y: y + h / 2 };
  }
  return { x, y };
}

/** 二维仿射变换：q = M · p + t（x/y 均为 0~1 的归一化值） */
export interface Projection {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
  /** 拟合残差（归一化单位的 RMSE），0 表示精确（恒等 / 1 对平移 / 2 对相似） */
  rmse: number;
  /** 参与拟合的同名点对数 */
  pairCount: number;
}

export function applyProjection(projection: Projection, point: Point): Point {
  return {
    x: projection.a * point.x + projection.c * point.y + projection.tx,
    y: projection.b * point.x + projection.d * point.y + projection.ty,
  };
}

/** 恒等投影（正/背面等构图一致的视角间兜底） */
export function identityProjection(pairCount = 0): Projection {
  return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0, rmse: 0, pairCount };
}

export interface AnchorPair {
  source: Point;
  target: Point;
}

/** 解 3 元一次正规方程 AᵀA·x = Aᵀb（高斯消元），奇异时返回 null */
function solve3(matrix: number[][], vector: number[]): number[] | null {
  const a = [
    [matrix[0][0], matrix[0][1], matrix[0][2]],
    [matrix[1][0], matrix[1][1], matrix[1][2]],
    [matrix[2][0], matrix[2][1], matrix[2][2]],
  ];
  const b = [...vector];
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-10) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue;
      const factor = a[row][col] / a[col][col];
      for (let k = col; k < 3; k += 1) a[row][k] -= factor * a[col][k];
      b[row] -= factor * b[col];
    }
  }
  return [b[0] / a[0][0], b[1] / a[1][1], b[2] / a[2][2]];
}

/**
 * 由同名点对拟合 source → target 的投影：
 * - 1 对：只能确定平移；
 * - 2 对：精确相似变换（等比缩放 + 旋转 + 平移），两张照片整体缩放/转动能表达；
 * - ≥3 对：最小二乘仿射变换（容许构图差异，正/背面翻转也能拟合），并给出 RMSE。
 * 点对重合退化、出现非有限值时返回 null。
 */
export function fitProjection(pairs: AnchorPair[]): Projection | null {
  const valid = pairs.filter(
    (pair) =>
      Number.isFinite(pair.source.x) &&
      Number.isFinite(pair.source.y) &&
      Number.isFinite(pair.target.x) &&
      Number.isFinite(pair.target.y),
  );
  if (valid.length === 0) return null;

  if (valid.length === 1) {
    return {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      tx: valid[0].target.x - valid[0].source.x,
      ty: valid[0].target.y - valid[0].source.y,
      rmse: 0,
      pairCount: 1,
    };
  }

  if (valid.length === 2) {
    const [p1, p2] = valid;
    const ds = { x: p2.source.x - p1.source.x, y: p2.source.y - p1.source.y };
    const dt = { x: p2.target.x - p1.target.x, y: p2.target.y - p1.target.y };
    const sourceLength = Math.hypot(ds.x, ds.y);
    if (sourceLength < 1e-6) return null;
    const scale = Math.hypot(dt.x, dt.y) / sourceLength;
    const angle = Math.atan2(dt.y, dt.x) - Math.atan2(ds.y, ds.x);
    const cos = Math.cos(angle) * scale;
    const sin = Math.sin(angle) * scale;
    return {
      a: cos,
      b: sin,
      c: -sin,
      d: cos,
      tx: p1.target.x - cos * p1.source.x + sin * p1.source.y,
      ty: p1.target.y - sin * p1.source.x - cos * p1.source.y,
      rmse: 0,
      pairCount: 2,
    };
  }

  // 最小二乘仿射：q_x = a·x + c·y + tx，q_y = b·x + d·y + ty
  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const atbX = [0, 0, 0];
  const atbY = [0, 0, 0];
  for (const pair of valid) {
    const row = [pair.source.x, pair.source.y, 1];
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) ata[i][j] += row[i] * row[j];
      atbX[i] += row[i] * pair.target.x;
      atbY[i] += row[i] * pair.target.y;
    }
  }
  const xParams = solve3(ata, atbX);
  const yParams = solve3(ata, atbY);
  if (!xParams || !yParams) return null;

  const projection: Projection = {
    a: xParams[0],
    b: yParams[0],
    c: xParams[1],
    d: yParams[1],
    tx: xParams[2],
    ty: yParams[2],
    rmse: 0,
    pairCount: valid.length,
  };
  let squaredError = 0;
  for (const pair of valid) {
    const projected = applyProjection(projection, pair.source);
    squaredError += (projected.x - pair.target.x) ** 2 + (projected.y - pair.target.y) ** 2;
  }
  projection.rmse = Math.sqrt(squaredError / valid.length);
  return projection;
}

/**
 * 从两张照片的标记中提取同名点对（跨视角自动校准的依据）：
 * 先按部位（partId）配对，再按破损事件（damageEventId）补充分部位标记，
 * 并按坐标去重——同一处可能同时存在矩形和点位两种标记。
 */
export function collectAnchorPairs(source: AnchorSource[], target: AnchorSource[]): AnchorPair[] {
  const pairs: AnchorPair[] = [];
  const seen = new Set<string>();
  for (const keyKind of ['partId', 'damageEventId'] as const) {
    const sourceMap = new Map<string, Point>();
    const targetMap = new Map<string, Point>();
    for (const annotation of source) {
      const key = annotation[keyKind];
      const anchor = geometryAnchor(annotation);
      if (key && anchor && !sourceMap.has(key)) sourceMap.set(key, anchor);
    }
    for (const annotation of target) {
      const key = annotation[keyKind];
      const anchor = geometryAnchor(annotation);
      if (key && anchor && !targetMap.has(key)) targetMap.set(key, anchor);
    }
    for (const [key, sourcePoint] of sourceMap) {
      const targetPoint = targetMap.get(key);
      if (!targetPoint) continue;
      const dedupeKey = [sourcePoint.x, sourcePoint.y, targetPoint.x, targetPoint.y]
        .map((v) => roundCoord(v))
        .join('|');
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      pairs.push({ source: sourcePoint, target: targetPoint });
    }
  }
  return pairs;
}

/**
 * 构图一致的标准视角组：同一套摆拍方式下归一化坐标可直接沿用（恒等投影）。
 * 修补前/后照片、pairedPhotoId 显式配对的照片也走恒等投影。
 * 洗标/吊牌/特写不属于衣身视角，不做默认对齐。
 */
export const IDENTITY_VIEW_GROUPS: ReadonlyArray<readonly string[]> = [
  ['front', 'back'],
  ['left', 'right'],
  ['top', 'bottom'],
  ['before', 'after'],
];

export function viewsShareLayout(viewA: string, viewB: string): boolean {
  if (viewA === viewB) return true;
  return IDENTITY_VIEW_GROUPS.some((group) => group.includes(viewA) && group.includes(viewB));
}

// ---------------------------------------------------------------- 框选区域批量布点

export type BatchPointMode = 'grid' | 'stagger' | 'random';

export interface BatchPointOptions {
  mode: BatchPointMode;
  /** grid/stagger 的列数与行数 */
  cols?: number;
  rows?: number;
  /** random 模式的点数 */
  count?: number;
  /** 抖动比例（0~0.5），相对相邻点间距，给规则点阵加入随机偏移 */
  jitter?: number;
  /** 随机种子：传入后结果可复现（测试 / 预览与最终生成一致），不传则每次随机 */
  seed?: number;
}

/** 批量布点上限，与后端 annotationBatchSchema 的 50 条/批保持一致 */
export const BATCH_POINT_MAX = 50;

/** 可复现的伪随机数生成（mulberry32） */
function createRng(seed?: number): () => number {
  let state = seed ?? Math.floor(Math.random() * 0xffffffff);
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 在归一化矩形内批量生成点位（用于起球 / 磨薄这类"一片区域"的标记）。
 * - grid：行列等间距点阵；
 * - stagger：交错排列（奇数行错开半格），同样点数下覆盖更均匀；
 * - random：区域内均匀随机散布。
 * 结果钳制在矩形内、按 4 位小数去重，点过密时自然减少数量，最多 50 个。
 */
export function generatePointsInRect(
  rect: { x: number; y: number; w: number; h: number },
  options: BatchPointOptions,
): Point[] {
  const width = Math.max(0, rect.w);
  const height = Math.max(0, rect.h);
  if (width <= 0 || height <= 0) return [];

  const rng = createRng(options.seed);
  const jitter = Math.min(0.5, Math.max(0, options.jitter ?? 0));
  const points: Point[] = [];

  const addJittered = (centerX: number, centerY: number, stepX: number, stepY: number): void => {
    const x = centerX + (jitter > 0 ? (rng() - 0.5) * jitter * stepX : 0);
    const y = centerY + (jitter > 0 ? (rng() - 0.5) * jitter * stepY : 0);
    points.push({
      x: roundCoord(Math.min(rect.x + width, Math.max(rect.x, x))),
      y: roundCoord(Math.min(rect.y + height, Math.max(rect.y, y))),
    });
  };

  if (options.mode === 'random') {
    const target = Math.min(BATCH_POINT_MAX, Math.max(1, Math.floor(options.count ?? 20)));
    for (let i = 0; i < target; i += 1) {
      points.push({
        x: roundCoord(rect.x + rng() * width),
        y: roundCoord(rect.y + rng() * height),
      });
    }
  } else {
    const cols = Math.min(25, Math.max(1, Math.floor(options.cols ?? 5)));
    const rows = Math.min(25, Math.max(1, Math.floor(options.rows ?? 5)));
    const stepX = width / cols;
    const stepY = height / rows;
    for (let row = 0; row < rows; row += 1) {
      const offsetX = options.mode === 'stagger' && row % 2 === 1 ? stepX / 2 : 0;
      for (let col = 0; col < cols; col += 1) {
        const centerX = rect.x + stepX * (col + 0.5) + offsetX;
        if (centerX > rect.x + width + 1e-9) continue;
        addJittered(centerX, rect.y + stepY * (row + 0.5), stepX, stepY);
      }
    }
  }

  const deduped = new Map<string, Point>();
  for (const point of points) deduped.set(`${point.x}|${point.y}`, point);
  return [...deduped.values()].slice(0, BATCH_POINT_MAX);
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
