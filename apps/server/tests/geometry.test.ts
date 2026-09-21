import { describe, expect, it } from 'vitest';
import {
  applyProjection,
  applyZoomPan,
  collectAnchorPairs,
  fitProjection,
  fitTransform,
  generatePointsInRect,
  geometryAnchor,
  hitTest,
  identityProjection,
  normalizedToViewport,
  roundCoord,
  toNormalized,
  toPixel,
  viewportToNormalized,
  viewsShareLayout,
} from '@gml/shared';

describe('照片标记坐标（项目文档 11.1）', () => {
  it('归一化坐标钳制在 [0,1] 且保留 4 位小数', () => {
    expect(roundCoord(1.4)).toBe(1);
    expect(roundCoord(-0.3)).toBe(0);
    // 4 位小数、四舍五入（JS 浮点下 0.41235 × 10^4 略大于半数，会进位到 0.4124）
    expect(roundCoord(0.41235)).toBe(0.4124);
    expect(roundCoord(0.66719)).toBe(0.6672);
  });

  it('像素与归一化互转可往返', () => {
    const size = { width: 1600, height: 1200 };
    const norm = toNormalized({ x: 660, y: 800 }, size);
    expect(norm.x).toBeCloseTo(0.4125, 4);
    expect(norm.y).toBeCloseTo(0.6667, 4);
    const pixel = toPixel(norm, size);
    expect(Math.abs(pixel.x - 660)).toBeLessThan(1);
    expect(Math.abs(pixel.y - 800)).toBeLessThan(1);
  });

  it('contain 变换保持比例并居中', () => {
    const transform = fitTransform({ width: 1600, height: 1200 }, { width: 800, height: 600 });
    expect(transform.scale).toBe(0.5);
    expect(transform.offsetX).toBe(0);
    expect(transform.offsetY).toBe(0);
  });

  it('容器坐标换算在缩放后依然准确（换设备不错位）', () => {
    const image = { width: 1600, height: 1200 };
    const viewport = { width: 800, height: 600 };
    const base = fitTransform(image, viewport);

    const atZoom1 = viewportToNormalized({ x: 400, y: 300 }, base, viewport, 1);
    expect(atZoom1.x).toBeCloseTo(0.5, 3);
    expect(atZoom1.y).toBeCloseTo(0.5, 3);

    // 缩放必须围绕视口中心：放大 2 倍后，视口中心仍然是同一个归一化点
    const atZoom2 = viewportToNormalized({ x: 400, y: 300 }, base, viewport, 2);
    expect(atZoom2.x).toBeCloseTo(0.5, 3);
    expect(atZoom2.y).toBeCloseTo(0.5, 3);

    // 放大后视口左上角对应图片的 0.25（图片被放大到 1600 宽，中心对齐）
    const topLeft = viewportToNormalized({ x: 0, y: 0 }, base, viewport, 2);
    expect(topLeft.x).toBeCloseTo(0.25, 3);
    expect(topLeft.y).toBeCloseTo(0.25, 3);
  });

  it('缩放后的绘制变换与反算互为逆运算', () => {
    const image = { width: 1600, height: 1200 };
    const viewport = { width: 800, height: 600 };
    const transform = applyZoomPan(fitTransform(image, viewport), viewport, 2.5, { x: 30, y: -20 });

    const point = { x: 0.37, y: 0.62 };
    const screen = normalizedToViewport(point, transform);
    const back = viewportToNormalized(screen, fitTransform(image, viewport), viewport, 2.5, { x: 30, y: -20 });
    expect(back.x).toBeCloseTo(point.x, 4);
    expect(back.y).toBeCloseTo(point.y, 4);
  });

  it('命中检测能选中点位与矩形', () => {
    const image = { width: 1000, height: 1000 };
    const annotations = [
      { kind: 'point', geometry: { x: 0.2, y: 0.2 } },
      { kind: 'rect', geometry: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } },
    ];
    expect(hitTest({ x: 0.2, y: 0.2 }, annotations, image, 1)).toBe(0);
    expect(hitTest({ x: 0.6, y: 0.6 }, annotations, image, 1)).toBe(1);
    expect(hitTest({ x: 0.9, y: 0.1 }, annotations, image, 1)).toBeNull();
  });

  it('非正方形照片上的命中容差按各自维度计算（竖图不会误命中）', () => {
    // 800×1600 的竖图：0.05 的 y 差相当于 80 像素，远超 14 像素容差，不应命中
    const tall = { width: 800, height: 1600 };
    const annotations = [{ kind: 'point', geometry: { x: 0.5, y: 0.5 } }];
    expect(hitTest({ x: 0.5, y: 0.55 }, annotations, tall, 1, 14)).toBeNull();
    // 同样的 0.05 在横图上只有 30 像素……仍大于容差，同样不命中；
    // 贴近时（0.008 ≈ 13 像素）应该命中
    expect(hitTest({ x: 0.5, y: 0.508 }, annotations, tall, 1, 14)).toBe(0);
    const wide = { width: 1600, height: 800 };
    expect(hitTest({ x: 0.5, y: 0.508 }, annotations, wide, 1, 14)).toBe(0);
    expect(hitTest({ x: 0.5, y: 0.55 }, annotations, wide, 1, 14)).toBeNull();
  });
});

describe('多视角联动：标记锚点', () => {
  it('点位取自身、矩形取中心、折线取顶点重心', () => {
    expect(geometryAnchor({ kind: 'point', geometry: { x: 0.2, y: 0.3 } })).toEqual({ x: 0.2, y: 0.3 });
    const rectAnchor = geometryAnchor({ kind: 'rect', geometry: { x: 0.4, y: 0.4, w: 0.2, h: 0.4 } });
    expect(rectAnchor!.x).toBeCloseTo(0.5, 10);
    expect(rectAnchor!.y).toBeCloseTo(0.6, 10);
    const polylineAnchor = geometryAnchor({
      kind: 'polyline',
      geometry: { points: [{ x: 0, y: 0 }, { x: 0.2, y: 0.4 }, { x: 0.4, y: 0.2 }] },
    });
    expect(polylineAnchor!.x).toBeCloseTo(0.2, 10);
    expect(polylineAnchor!.y).toBeCloseTo(0.2, 10);
  });

  it('几何数据非法时返回 null 而不是抛出', () => {
    expect(geometryAnchor({ kind: 'point', geometry: {} })).toBeNull();
    expect(geometryAnchor({ kind: 'polyline', geometry: { points: [] } })).toBeNull();
  });
});

describe('多视角联动：同名点投影拟合', () => {
  it('一对同名点只确定平移', () => {
    const projection = fitProjection([{ source: { x: 0.3, y: 0.3 }, target: { x: 0.6, y: 0.5 } }]);
    expect(projection).not.toBeNull();
    const same = applyProjection(projection!, { x: 0.3, y: 0.3 });
    expect(same.x).toBeCloseTo(0.6, 10);
    expect(same.y).toBeCloseTo(0.5, 10);
    const moved = applyProjection(projection!, { x: 0.9, y: 0.1 });
    expect(moved.x).toBeCloseTo(1.2, 10);
    expect(moved.y).toBeCloseTo(0.3, 10);
    expect(projection!.pairCount).toBe(1);
  });

  it('两对同名点拟合精确相似变换（缩放 + 旋转 + 平移）', () => {
    // source 两个点 (0,0)、(1,0)；target 旋转 90° 并放大 0.5：(x,y) → (0.5-0.5y, 0.5x)
    const projection = fitProjection([
      { source: { x: 0, y: 0 }, target: { x: 0.5, y: 0 } },
      { source: { x: 1, y: 0 }, target: { x: 0.5, y: 0.5 } },
    ]);
    expect(projection).not.toBeNull();
    const result = applyProjection(projection!, { x: 0, y: 1 });
    expect(result.x).toBeCloseTo(0, 6);
    expect(result.y).toBeCloseTo(0, 6);
    expect(projection!.rmse).toBe(0);
  });

  it('重合的两个同名点无法确定方向，返回 null', () => {
    expect(
      fitProjection([
        { source: { x: 0.5, y: 0.5 }, target: { x: 0.2, y: 0.2 } },
        { source: { x: 0.5, y: 0.5 }, target: { x: 0.8, y: 0.8 } },
      ]),
    ).toBeNull();
  });

  it('三对以上同名点做最小二乘仿射，带噪点也能近似并给出 RMSE', () => {
    // 真实映射：x' = 0.8x + 0.1y + 0.05，y' = -0.2x + 0.9y + 0.1
    const transform = (p: { x: number; y: number }) => ({
      x: 0.8 * p.x + 0.1 * p.y + 0.05,
      y: -0.2 * p.x + 0.9 * p.y + 0.1,
    });
    const sources = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.2 },
      { x: 0.2, y: 0.8 },
      { x: 0.75, y: 0.85 },
    ];
    const pairs = sources.map((source) => {
      const target = transform(source);
      // 最后一对加一点噪声（4 对里有 1 对带噪，参数会被轻微拉动，用 1 位小数容差）
      return { source, target: source === sources[3] ? { x: target.x + 0.01, y: target.y - 0.01 } : target };
    });
    const projection = fitProjection(pairs);
    expect(projection).not.toBeNull();
    expect(projection!.a).toBeCloseTo(0.8, 1);
    expect(projection!.b).toBeCloseTo(-0.2, 1);
    expect(projection!.c).toBeCloseTo(0.1, 1);
    expect(projection!.d).toBeCloseTo(0.9, 1);
    expect(projection!.tx).toBeCloseTo(0.05, 2);
    expect(projection!.ty).toBeCloseTo(0.1, 2);
    expect(projection!.rmse).toBeGreaterThan(0);
    expect(projection!.rmse).toBeLessThan(0.02);
  });

  it('空点对返回 null', () => {
    expect(fitProjection([])).toBeNull();
  });

  it('恒等投影直接沿用归一化坐标', () => {
    const projection = identityProjection();
    expect(applyProjection(projection, { x: 0.37, y: 0.62 })).toEqual({ x: 0.37, y: 0.62 });
  });

  it('标准视角组（正/背、左/右、上/下、修补前后）共享构图，特写不参与', () => {
    expect(viewsShareLayout('front', 'back')).toBe(true);
    expect(viewsShareLayout('left', 'right')).toBe(true);
    expect(viewsShareLayout('before', 'after')).toBe(true);
    expect(viewsShareLayout('front', 'detail')).toBe(false);
    expect(viewsShareLayout('care_label', 'tag')).toBe(false);
  });
});

describe('多视角联动：同名点对提取', () => {
  it('按部位配对，再按破损事件补充，并按坐标去重', () => {
    const source = [
      { kind: 'point', geometry: { x: 0.2, y: 0.2 }, partId: 'elbow-r', damageEventId: 'd1' },
      { kind: 'rect', geometry: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, partId: null, damageEventId: 'd1' },
      { kind: 'point', geometry: { x: 0.8, y: 0.8 }, partId: null, damageEventId: null },
    ];
    const target = [
      { kind: 'point', geometry: { x: 0.3, y: 0.25 }, partId: 'elbow-r', damageEventId: 'd1' },
      { kind: 'point', geometry: { x: 0.5, y: 0.5 }, partId: null, damageEventId: 'd9' },
    ];
    const pairs = collectAnchorPairs(source, target);
    // 第一对来自 partId；d1 的矩形中心 (0.2,0.2) 与点位 (0.2,0.2) 同源、目标同为 (0.3,0.25)，去重后只剩一对
    expect(pairs).toHaveLength(1);
    expect(pairs[0].source).toEqual({ x: 0.2, y: 0.2 });
    expect(pairs[0].target).toEqual({ x: 0.3, y: 0.25 });
  });

  it('无部位标记时按破损事件配对（矩形取中心）', () => {
    const pairs = collectAnchorPairs(
      [{ kind: 'rect', geometry: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, partId: null, damageEventId: 'd1' }],
      [{ kind: 'point', geometry: { x: 0.7, y: 0.7 }, partId: null, damageEventId: 'd1' }],
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].source).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe('框选区域批量布点', () => {
  it('grid 模式生成 cols×rows 个点且全部落在矩形内', () => {
    const points = generatePointsInRect({ x: 0.2, y: 0.2, w: 0.6, h: 0.4 }, { mode: 'grid', cols: 4, rows: 3 });
    expect(points).toHaveLength(12);
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(0.2);
      expect(point.x).toBeLessThanOrEqual(0.8);
      expect(point.y).toBeGreaterThanOrEqual(0.2);
      expect(point.y).toBeLessThanOrEqual(0.6);
    }
    // 首末点位于网格中心
    expect(points[0].x).toBeCloseTo(0.275, 3);
    expect(points[0].y).toBeCloseTo(0.2667, 3);
  });

  it('stagger 模式奇数行错开半格', () => {
    const points = generatePointsInRect({ x: 0, y: 0, w: 1, h: 1 }, { mode: 'stagger', cols: 2, rows: 2 });
    expect(points).toHaveLength(4);
    const firstRow = points.slice(0, 2).map((p) => p.x);
    const secondRow = points.slice(2).map((p) => p.x);
    expect(Math.abs(firstRow[0] - 0.25)).toBeLessThan(0.01);
    expect(Math.abs(firstRow[1] - 0.75)).toBeLessThan(0.01);
    // 第二行整体错开半格：0.5 与正好落在右边界的 1.0
    expect(Math.abs(secondRow[0] - 0.5)).toBeLessThan(0.01);
    expect(Math.abs(secondRow[1] - 1.0)).toBeLessThan(0.01);
  });

  it('random 模式数量受控、同一种子结果可复现', () => {
    const rect = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
    const a = generatePointsInRect(rect, { mode: 'random', count: 15, seed: 42 });
    const b = generatePointsInRect(rect, { mode: 'random', count: 15, seed: 42 });
    const c = generatePointsInRect(rect, { mode: 'random', count: 15, seed: 7 });
    expect(a).toHaveLength(15);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const point of a) {
      expect(point.x).toBeGreaterThanOrEqual(0.1);
      expect(point.x).toBeLessThanOrEqual(0.6);
    }
  });

  it('jitter 不会让点跑出矩形', () => {
    const points = generatePointsInRect(
      { x: 0, y: 0, w: 1, h: 1 },
      { mode: 'grid', cols: 3, rows: 3, jitter: 0.5, seed: 1 },
    );
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(1);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(1);
    }
  });

  it('退化矩形返回空数组，数量上限为 50 且按坐标去重', () => {
    expect(generatePointsInRect({ x: 0, y: 0, w: 0, h: 1 }, { mode: 'grid', cols: 4, rows: 4 })).toEqual([]);
    const many = generatePointsInRect({ x: 0, y: 0, w: 1, h: 1 }, { mode: 'grid', cols: 20, rows: 20 });
    expect(many.length).toBeLessThanOrEqual(50);
    const tiny = generatePointsInRect({ x: 0.5, y: 0.5, w: 0.00001, h: 0.00001 }, {
      mode: 'grid',
      cols: 3,
      rows: 3,
    });
    // 极小矩形内网格点四舍五入后去重为 1 个
    expect(tiny).toHaveLength(1);
  });
});
