import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface QueuedOperation {
  id: string;
  kind: 'wear-log';
  payload: Record<string, unknown>;
  createdAt: number;
}

const STORAGE_KEY = 'gml.offlineQueue';

function load(): QueuedOperation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as QueuedOperation[]) : [];
  } catch {
    return [];
  }
}

/**
 * 离线队列（项目文档 F22）：
 * 断网时把"穿着打点"这类高频操作先落到本地，恢复网络后按 clientOpId 幂等同步，
 * 保证同一件衣服同一天不会被记两次。
 */
export const useOfflineQueueStore = defineStore('offlineQueue', () => {
  const queue = ref<QueuedOperation[]>(load());
  const syncing = ref(false);
  const lastSyncAt = ref<number | null>(null);
  const lastError = ref('');

  function persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue.value));
  }

  function enqueue(payload: Record<string, unknown>): QueuedOperation {
    const op: QueuedOperation = {
      id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'wear-log',
      payload,
      createdAt: Date.now(),
    };
    queue.value.push(op);
    persist();
    return op;
  }

  function remove(ids: string[]): void {
    queue.value = queue.value.filter((op) => !ids.includes(op.id));
    persist();
  }

  return { queue, syncing, lastSyncAt, lastError, enqueue, remove, persist };
});
