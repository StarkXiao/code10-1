import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { authApi } from '../api';
import { ApiError, getToken, setToken } from '../api/client';
import type { User, Wardrobe } from '../types';

export const useSessionStore = defineStore('session', () => {
  const user = ref<User | null>(null);
  const wardrobe = ref<Wardrobe | null>(null);
  const ready = ref(false);
  const loading = ref(false);
  const error = ref('');

  const isLoggedIn = computed(() => !!getToken() && !!user.value);

  async function bootstrap(): Promise<void> {
    if (ready.value) return;
    if (!getToken()) {
      ready.value = true;
      return;
    }
    loading.value = true;
    try {
      const data = await authApi.me();
      user.value = data.user;
      wardrobe.value = data.wardrobe;
    } catch (caught) {
      if (caught instanceof ApiError && caught.code !== 'AUTH_REQUIRED') error.value = caught.message;
      setToken('');
    } finally {
      loading.value = false;
      ready.value = true;
    }
  }

  async function login(email: string, password: string): Promise<void> {
    const data = await authApi.login({ email, password });
    setToken(data.token);
    user.value = data.user;
    wardrobe.value = data.wardrobe;
    ready.value = true;
  }

  async function register(email: string, password: string, displayName: string): Promise<void> {
    const data = await authApi.register({ email, password, displayName });
    setToken(data.token);
    user.value = data.user;
    wardrobe.value = data.wardrobe;
    ready.value = true;
  }

  function logout(): void {
    setToken('');
    user.value = null;
    wardrobe.value = null;
    ready.value = false;
  }

  return { user, wardrobe, ready, loading, error, isLoggedIn, bootstrap, login, register, logout };
});
