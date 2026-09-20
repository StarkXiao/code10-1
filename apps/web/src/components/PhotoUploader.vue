<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { PHOTO_VIEW_LABEL, PHOTO_VIEWS, type PhotoView } from '@gml/shared';
import { photoApi } from '../api';
import { messageOf } from '../api/client';
import type { GarmentPhotoRow } from '../types';

const props = defineProps<{
  garmentId: string;
  defaultView?: PhotoView;
}>();

const emit = defineEmits<{ (e: 'uploaded', photo: GarmentPhotoRow): void }>();

const view = ref<PhotoView>(props.defaultView ?? 'front');
const busy = ref(false);

const MAX_EDGE = 2048;

/** 上传前先在浏览器压缩：省流量、减少服务端压力，也让标记精度对应的像素更可控 */
async function compress(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 2 * 1024 * 1024) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/u, '.jpg'), { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

async function upload(options: { file: File }): Promise<void> {
  busy.value = true;
  try {
    const compressed = await compress(options.file);
    const form = new FormData();
    form.append('file', compressed, compressed.name);
    form.append('view', view.value);
    const data = await photoApi.upload(props.garmentId, form);
    emit('uploaded', data.photo);
    ElMessage.success(`已上传「${PHOTO_VIEW_LABEL[view.value]}」`);
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div>
    <el-select v-model="view" size="small" style="width: 180px; margin-bottom: 8px">
      <el-option v-for="item in PHOTO_VIEWS" :key="item" :value="item" :label="PHOTO_VIEW_LABEL[item]" />
    </el-select>
    <el-upload
      :show-file-list="false"
      :http-request="upload"
      accept="image/*"
      :disabled="busy"
      drag
    >
      <div style="padding: 12px">
        <el-icon><upload-filled /></el-icon>
        <div>点击或拖拽上传照片（自动压缩到长边 2048）</div>
        <div class="muted">JPEG / PNG / WebP；HEIC 建议先在相册里导出为 JPEG</div>
      </div>
    </el-upload>
    <div v-if="busy" class="muted" style="margin-top: 6px">上传中…</div>
  </div>
</template>

<script lang="ts">
import { UploadFilled } from '@element-plus/icons-vue';
export default { components: { UploadFilled } };
</script>
