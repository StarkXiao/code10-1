import { onMounted, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import { wearApi } from '../api';
import { ApiError, messageOf } from '../api/client';
import { useOfflineQueueStore } from '../stores/offlineQueue';
import { useSessionStore } from '../stores/session';

/** 联网且已登录时，把离线队列同步给后端（幂等：clientOpId） */
export function useOfflineSync(): void {
  const offline = useOfflineQueueStore();
  const session = useSessionStore();
  let timer: number | undefined;

  async function sync(): Promise<void> {
    if (offline.syncing || offline.queue.length === 0) return;
    if (!navigator.onLine || !session.user) return;
    offline.syncing = true;
    const done: string[] = [];
    const rejected: string[] = [];
    try {
      for (const op of offline.queue) {
        try {
          await wearApi.create({ ...op.payload, clientOpId: op.id });
          done.push(op.id);
        } catch (error) {
          // 断网：保留在队列里，等下次同步
          if (error instanceof ApiError && error.code === 'OFFLINE') break;
          // 业务错误（衣物已退役、日期非法等）：再重试一万次也不会成功，
          // 直接丢弃并告诉用户，否则队列会永远卡住、角标永远消不掉。
          offline.lastError = messageOf(error);
          rejected.push(messageOf(error));
          done.push(op.id);
        }
      }
      if (done.length > 0) offline.remove(done);
      if (rejected.length > 0) {
        ElMessage({
          type: 'warning',
          duration: 8000,
          message: `有 ${rejected.length} 条离线记录无法同步（已跳过）：${rejected[0]}`,
        });
      }
      offline.lastSyncAt = Date.now();
    } finally {
      offline.syncing = false;
    }
  }

  onMounted(() => {
    void sync();
    window.addEventListener('online', sync);
    timer = window.setInterval(sync, 30_000);
  });

  onUnmounted(() => {
    window.removeEventListener('online', sync);
    if (timer) window.clearInterval(timer);
  });
}
