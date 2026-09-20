import { describe, expect, it } from 'vitest';
import {
  applyZoomPan,
  fitTransform,
  hitTest,
  normalizedToViewport,
  roundCoord,
  toNormalized,
  toPixel,
  viewportToNormalized,
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
