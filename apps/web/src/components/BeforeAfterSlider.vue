<script setup lang="ts">
import { computed, ref } from 'vue';
import { photoFileUrl } from '../api/client';

const props = defineProps<{
  beforePhotoId: string | null;
  afterPhotoId: string | null;
  beforeLabel?: string;
  afterLabel?: string;
  aspectMismatch?: boolean;
  hint?: string | null;
}>();

const position = ref(50);
const mode = ref<'slider' | 'side'>('slider');
const dragging = ref(false);
const wrapRef = ref<HTMLDivElement | null>(null);

function url(id: string | null): string {
  if (!id) return '';
  return photoFileUrl(id);
}

const beforeUrl = computed(() => url(props.beforePhotoId));
const afterUrl = computed(() => url(props.afterPhotoId));

function onMove(event: PointerEvent): void {
  if (!dragging.value || !wrapRef.value) return;
  const rect = wrapRef.value.getBoundingClientRect();
  const ratio = ((event.clientX - rect.left) / rect.width) * 100;
  position.value = Math.min(100, Math.max(0, Math.round(ratio)));
}
</script>

<template>
  <div>
    <div class="toolbar">
      <el-radio-group v-model="mode" size="small">
        <el-radio-button label="slider">滑杆对比</el-radio-button>
        <el-radio-button label="side">并排对比</el-radio-button>
      </el-radio-group>
      <span v-if="!beforePhotoId || !afterPhotoId" class="muted">
        还没有配对的前后照片：先上传一张「修补前」和一张「修补后」，并把它们绑定到这次修补。
      </span>
    </div>

    <el-alert v-if="aspectMismatch" type="warning" :closable="false" :title="hint ?? '两张照片比例差异较大，对比时请注意'" style="margin-bottom: 8px" />

    <div v-if="mode === 'slider'" ref="wrapRef" class="ba-wrap" @pointermove="onMove" @pointerup="dragging = false" @pointerleave="dragging = false">
      <img v-if="beforeUrl" :src="beforeUrl" class="ba-img" alt="修补前" />
      <div v-if="afterUrl" class="ba-after" :style="{ width: `${position}%` }">
        <img :src="afterUrl" class="ba-img ba-img-inside" alt="修补后" />
      </div>
      <div v-if="beforeUrl && afterUrl" class="ba-handle" :style="{ left: `${position}%` }" @pointerdown="dragging = true" />
      <div class="ba-tag ba-tag-left">{{ beforeLabel ?? '修补前' }}</div>
      <div class="ba-tag ba-tag-right">{{ afterLabel ?? '修补后' }}</div>
    </div>

    <div v-else style="display: flex; gap: 12px; flex-wrap: wrap">
      <div style="flex: 1; min-width: 240px">
        <img v-if="beforeUrl" :src="beforeUrl" style="width: 100%; border-radius: 6px" alt="修补前" />
        <div class="muted">{{ beforeLabel ?? '修补前' }}</div>
      </div>
      <div style="flex: 1; min-width: 240px">
        <img v-if="afterUrl" :src="afterUrl" style="width: 100%; border-radius: 6px" alt="修补后" />
        <div class="muted">{{ afterLabel ?? '修补后' }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ba-wrap {
  position: relative;
  width: 100%;
  background: #111827;
  border-radius: 8px;
  overflow: hidden;
  user-select: none;
  touch-action: none;
}
.ba-img {
  display: block;
  width: 100%;
}
.ba-after {
  position: absolute;
  inset: 0 auto 0 0;
  overflow: hidden;
}
.ba-img-inside {
  width: 100%;
  max-width: none;
}
.ba-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 3px;
  background: #fff;
  cursor: ew-resize;
  transform: translateX(-1px);
}
.ba-tag {
  position: absolute;
  bottom: 8px;
  padding: 2px 8px;
  border-radius: 9999px;
  background: rgba(17, 24, 39, 0.7);
  color: #fff;
  font-size: 12px;
}
.ba-tag-left {
  left: 8px;
}
.ba-tag-right {
  right: 8px;
}
</style>
