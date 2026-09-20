<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { messageOf } from '../api/client';
import { useSessionStore } from '../stores/session';

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const tab = ref<'login' | 'register'>('login');
const busy = ref(false);
const form = reactive({ email: '', password: '', displayName: '' });

async function submit(): Promise<void> {
  if (!form.email || !form.password) {
    ElMessage.warning('请填写邮箱和密码');
    return;
  }
  if (tab.value === 'register' && !form.displayName) {
    ElMessage.warning('请填写你的称呼');
    return;
  }
  busy.value = true;
  try {
    if (tab.value === 'login') await session.login(form.email, form.password);
    else await session.register(form.email, form.password, form.displayName);
    ElMessage.success('欢迎回来');
    await router.push(String(route.query.redirect ?? '/'));
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div style="min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px">
    <el-card style="width: 100%; max-width: 420px">
      <div style="text-align: center; margin-bottom: 16px">
        <div style="font-size: 20px; font-weight: 600">衣物修补日志</div>
        <div class="muted" style="margin-top: 6px">
          记下破损在照片上的位置、用了什么针法、补丁布从哪来，穿起来有什么变化
        </div>
      </div>

      <el-tabs v-model="tab" stretch>
        <el-tab-pane label="登录" name="login" />
        <el-tab-pane label="注册" name="register" />
      </el-tabs>

      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item v-if="tab === 'register'" label="称呼">
          <el-input v-model="form.displayName" placeholder="例如：小李" maxlength="40" />
        </el-form-item>
        <el-form-item label="邮箱">
          <el-input v-model="form.email" type="email" placeholder="you@example.com" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
        <el-button type="primary" style="width: 100%" :loading="busy" @click="submit">
          {{ tab === 'login' ? '登录' : '注册并创建衣橱' }}
        </el-button>
      </el-form>

      <div class="muted" style="margin-top: 14px; line-height: 1.7">
        注册后会生成你自己的衣橱，并写入内置字典（10 种针法 / 9 类破损 / 11 类材质 / 45 个部位），
        这些都是真实可用的知识库，不含任何示例数据。
      </div>
    </el-card>
  </div>
</template>
