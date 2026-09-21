/**
 * 多视角联动（项目文档 11.2）。
 *
 * 切换视角时如何把"同一个部位"在两张照片间对齐，依据按优先级取自：
 *   1. 两张照片上已有的同名标记（同 partId / 同 damageEventId）——标记越用越准；
 *   2. 用户在"视角校准"模式下手动点的同名点对——存在本机 localStorage（坐标与设备无关）；
 *   3. 构图一致的标准视角组（正/背、左/右、上/下、修补前后、pairedPhotoId）——恒等投影兜底。
 *
 * 手动校准不进数据库：校准点本质是"这两张摆拍图之间怎么换算"，换个人、换次摆拍就不成立，
 * 存在本机即可，也避免给证据型数据加一张需要同步/合并的表。
 */
import { computed, ref } from 'vue';
import {
  collectAnchorPairs,
  fitProjection,
  identityProjection,
  viewsShareLayout,
  type AnchorPair,
  type AnchorSource,
  type Projection,
} from '@gml/shared';

const STORAGE_PREFIX = 'gml:view-calibration:v1:';
/** 校准残差超过该阈值（约占图幅 8%）视为点歪了，给出警告而非静默采用 */
export const CALIBRATION_RMSE_WARN = 0.08;

type StoredPair = { source: { x: number; y: number }; target: { x: number; y: number } };

function storageKey(garmentId: string, photoA: string, photoB: string): string {
  return `${STORAGE_PREFIX}${garmentId}:${[photoA, photoB].sort().join('__')}`;
}

function readStored(garmentId: string, photoA: string, photoB: string): StoredPair[] {
  try {
    const raw = window.localStorage.getItem(storageKey(garmentId, photoA, photoB));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (pair): pair is StoredPair =>
        !!pair &&
        typeof pair.source?.x === 'number' &&
        typeof pair.source?.y === 'number' &&
        typeof pair.target?.x === 'number' &&
        typeof pair.target?.y === 'number',
    );
  } catch {
    return [];
  }
}

function writeStored(garmentId: string, photoA: string, photoB: string, pairs: StoredPair[]): void {
  try {
    window.localStorage.setItem(storageKey(garmentId, photoA, photoB), JSON.stringify(pairs.slice(-20)));
  } catch {
    // localStorage 不可用（隐私模式/配额）时校准仅本次会话有效
  }
}

/** A→B 与 B→A 的点对互为反向；存储统一按照片 ID 排序，读取时再按切换方向还原 */
function orientPair(pair: StoredPair, sourceFirst: boolean): AnchorPair {
  return sourceFirst ? { source: pair.source, target: pair.target } : { source: pair.target, target: pair.source };
}

export function useViewLink(garmentId: string) {
  function pairCount(photoA: string, photoB: string): number {
    return readStored(garmentId, photoA, photoB).length;
  }

  function addCalibrationPair(photoA: string, photoB: string, pointA: { x: number; y: number }, pointB: { x: number; y: number }): number {
    // 存储顺序统一成"ID 较小的照片 → ID 较大的照片"，与 storageKey 的排序一致
    const [pointSource, pointTarget] = photoA < photoB ? [pointA, pointB] : [pointB, pointA];
    const pairs = readStored(garmentId, photoA, photoB);
    pairs.push({ source: pointSource, target: pointTarget });
    writeStored(garmentId, photoA, photoB, pairs);
    return pairs.length;
  }

  function clearCalibration(photoA: string, photoB: string): void {
    try {
      window.localStorage.removeItem(storageKey(garmentId, photoA, photoB));
    } catch {
      // 忽略
    }
  }

  /**
   * 校准流程的两阶段状态：
   * - null：未在校准；
   * - { phase: 'source', ... }：已在源照片点了第一下，等用户切到目标照片；
   * - 切换照片后转成 phase: 'target'，在目标照片点第二下即完成一对。
   */
  const calibrationState = ref<
    | { phase: 'source' | 'target'; sourcePhotoId: string; sourcePoint: { x: number; y: number } }
    | null
  >(null);

  const calibrating = computed(() => calibrationState.value !== null);

  /** 进入校准模式并清空未完成的起点 */
  function beginCalibration(): void {
    calibrationState.value = null;
  }

  function cancelCalibration(): void {
    calibrationState.value = null;
  }

  /**
   * 画布在某张照片上被点击（校准工具）。
   * - 源照片点击：记下起点；
   * - 已切到目标照片后点击：与起点配成一对落盘，状态清空。
   * 同一张照片上重复点击只覆盖起点。
   */
  function recordCalibrationClick(
    photoId: string,
    point: { x: number; y: number },
  ): { completed: boolean; count: number } {
    const state = calibrationState.value;
    if (!state || state.phase === 'source' || state.sourcePhotoId === photoId) {
      calibrationState.value = { phase: 'source', sourcePhotoId: photoId, sourcePoint: point };
      return { completed: false, count: 0 };
    }
    const count = addCalibrationPair(state.sourcePhotoId, photoId, state.sourcePoint, point);
    calibrationState.value = null;
    return { completed: true, count };
  }

  /** 切换照片后：源阶段进入目标阶段 */
  function markTargetPhase(): void {
    if (calibrationState.value?.phase === 'source') {
      calibrationState.value = { ...calibrationState.value, phase: 'target' };
    }
  }

  /**
   * 解析 source 照片 → target 照片的投影。
   * 返回投影、点对数量/来源与残差警告；没有任何依据时 projection 为 null。
   */
  function resolveProjection(input: {
    sourcePhotoId: string;
    targetPhotoId: string;
    sourceView: string;
    targetView: string;
    paired?: boolean;
    sourceAnnotations: AnchorSource[];
    targetAnnotations: AnchorSource[];
  }): { projection: Projection | null; autoPairs: number; manualPairs: number; rmseWarn: boolean } {
    // 1. 已有同名标记自动配点（collectAnchorPairs 的入参方向就是切换方向）
    const autoPairs = collectAnchorPairs(input.sourceAnnotations, input.targetAnnotations);

    // 2. 手动校准点（存储按照片 ID 排序，读取时按切换方向还原）
    const sourceFirst = input.sourcePhotoId < input.targetPhotoId;
    const stored = readStored(garmentId, input.sourcePhotoId, input.targetPhotoId).map((pair) =>
      orientPair(pair, sourceFirst),
    );

    const pairs = [...autoPairs, ...stored];
    if (pairs.length > 0) {
      const projection = fitProjection(pairs);
      if (projection) {
        return {
          projection,
          autoPairs: autoPairs.length,
          manualPairs: stored.length,
          rmseWarn: projection.pairCount >= 3 && projection.rmse > CALIBRATION_RMSE_WARN,
        };
      }
    }

    // 3. 标准构图视角组 / 显式配对照片：恒等投影
    if (input.paired || viewsShareLayout(input.sourceView, input.targetView)) {
      return { projection: identityProjection(0), autoPairs: 0, manualPairs: stored.length, rmseWarn: false };
    }
    return { projection: null, autoPairs: 0, manualPairs: stored.length, rmseWarn: false };
  }

  return {
    calibrating,
    calibrationState,
    beginCalibration,
    markTargetPhase,
    recordCalibrationClick,
    cancelCalibration,
    resolveProjection,
    pairCount,
    clearCalibration,
  };
}
