import axios, { type AxiosInstance } from 'axios';

export interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
  meta?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const TOKEN_KEY = 'gml.token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/**
 * 照片地址统一出口。
 *
 * <img src> 无法携带 Authorization 头，而图片接口要求鉴权，
 * 所以必须通过 query 传 token（后端 auth 中间件支持 ?token=）。
 * 分享页则用分享 token 走 ?share=。
 */
export function photoFileUrl(photoId: string, variant: 'file' | 'thumb' = 'file'): string {
  const token = getToken();
  const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
  return `/api/photos/${photoId}/${variant}${suffix}`;
}

export function sharePhotoFileUrl(photoId: string, shareToken: string, variant: 'file' | 'thumb' = 'file'): string {
  return `/api/photos/${photoId}/${variant}?share=${encodeURIComponent(shareToken)}`;
}

export const http: AxiosInstance = axios.create({ baseURL: '/api', timeout: 60_000 });

http.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

http.interceptors.response.use(
  (response) => response,
  (error) => {
    const payload = error?.response?.data;
    if (payload?.error) {
      const apiError = new ApiError(
        payload.error.code ?? 'UNKNOWN',
        payload.error.message ?? '请求失败',
        error.response.status,
        payload.error.details,
      );
      if (apiError.code === 'AUTH_REQUIRED') {
        setToken('');
        if (!location.pathname.startsWith('/login') && !location.pathname.startsWith('/share')) {
          location.href = '/login';
        }
      }
      return Promise.reject(apiError);
    }
    if (error?.code === 'ERR_NETWORK') {
      return Promise.reject(new ApiError('OFFLINE', '网络不可用，操作已排队，联网后会自动同步', 0));
    }
    return Promise.reject(new ApiError('UNKNOWN', error?.message ?? '请求失败', error?.response?.status ?? 0));
  },
);

/** 统一解包 { ok, data } 信封 */
export async function request<T>(
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  url: string,
  options: { params?: Record<string, unknown>; data?: unknown; form?: FormData } = {},
): Promise<T> {
  const response = await http.request<ApiEnvelope<T>>({
    method,
    url,
    params: options.params,
    data: options.form ?? options.data,
    headers: options.form ? { 'content-type': 'multipart/form-data' } : undefined,
  });
  return response.data.data;
}

export const api = {
  get: <T>(url: string, params?: Record<string, unknown>) => request<T>('get', url, { params }),
  post: <T>(url: string, data?: unknown) => request<T>('post', url, { data }),
  put: <T>(url: string, data?: unknown) => request<T>('put', url, { data }),
  patch: <T>(url: string, data?: unknown) => request<T>('patch', url, { data }),
  del: <T>(url: string) => request<T>('delete', url),
  upload: <T>(url: string, form: FormData) => request<T>('post', url, { form }),
};

export function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    const details = Array.isArray(error.details) ? error.details : [];
    if (details.length > 0) {
      const first = details[0] as { message?: string; path?: string };
      return first.message ? `${first.message}${first.path ? `（${first.path}）` : ''}` : error.message;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : '操作失败';
}
