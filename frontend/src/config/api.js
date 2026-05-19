import axios from 'axios';

// BUG-FE-116: prefer VITE_API_BASE_URL when provided so deploys to
// non-default mounts (or remote API hosts) don't have to patch source.
const API_BASE_URL = (import.meta?.env?.VITE_API_BASE_URL) || '/api/v1';
const API_TIMEOUT_MS = Number(import.meta?.env?.VITE_API_TIMEOUT_MS || 30000);

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
  },
});

// BUG-FE-122: surface a per-request correlation id to the backend so a 5xx
// in the access log can be matched to the exact UI action that produced it.
const _genRequestId = () => {
  try {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  } catch { /* ignore */ }
  // Fallback: short random.
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

// BUG-FE-119: pre-import antd message so the refresh-failure toast doesn't
// race against a strict-mode unmount during the dynamic import.
let _antdMessage = null;
import('antd').then((m) => { _antdMessage = m.message; }).catch(() => { /* offline ok */ });

api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    if (!config.headers['X-Request-Id']) {
      config.headers['X-Request-Id'] = _genRequestId();
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Token refresh logic to prevent session loss mid-operation
let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach((prom) => {
    if (error) prom.reject(error);
    else prom.resolve(token);
  });
  failedQueue = [];
};

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // M5 fix: network errors have no config — bail early
    if (!originalRequest) return Promise.reject(error);

    // BUG-FE-121: single auto-retry on ECONNABORTED (axios timeout). This
    // covers transient mobile-network blips on idempotent GETs without
    // doubling up on POST/PUT writes.
    const isTimeout = error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '');
    const method = (originalRequest.method || 'get').toLowerCase();
    if (isTimeout && method === 'get' && !originalRequest._timeoutRetry) {
      originalRequest._timeoutRetry = true;
      return api(originalRequest);
    }

    // M6 fix: never retry the refresh endpoint itself (prevents recursive loop)
    if (originalRequest.url?.includes('/auth/refresh-token')) return Promise.reject(error);

    if (error.response?.status === 401 && !originalRequest._retry) {
      // If already refreshing, queue this request
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((token) => {
          // BUG-FE-117: mark queued retries so a follow-up 401 doesn't loop
          // back through the refresh path.
          originalRequest._retry = true;
          originalRequest.headers['Authorization'] = `Bearer ${token}`;
          return api(originalRequest);
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const refreshToken = localStorage.getItem('refreshToken');
        if (!refreshToken) throw new Error('No refresh token');

        // BUG-FE-118: use a bare axios call (no interceptors) but reuse the
        // configured baseURL so mocks and proxies still apply.
        const res = await axios.create({ baseURL: api.defaults.baseURL })
          .post('/auth/refresh-token', { refresh_token: refreshToken });
        const newToken = res.data.access_token;

        localStorage.setItem('token', newToken);
        if (res.data.refresh_token) {
          localStorage.setItem('refreshToken', res.data.refresh_token);
        }

        // BUG-FE-120: do NOT mutate api.defaults.headers.common with a token
        // that may be rotated again — the request interceptor reads from
        // localStorage on every call so the new token is picked up
        // automatically, with no risk of a stale default leaking after
        // logout.
        window.dispatchEvent(new Event('auth-token-refreshed'));
        processQueue(null, newToken);

        // BUG-AUTH-025 fix: when the access token is refreshed, the user's
        // role / permission claims in localStorage may be stale (admin
        // changed their role since the original login). Fire-and-forget
        // a /auth/me lookup so the cached `user` and `permissions` are
        // updated; failures here are non-fatal (the original request is
        // still retried below).
        try {
          const meRes = await axios.get('/api/v1/auth/me', {
            headers: { Authorization: `Bearer ${newToken}` },
          });
          if (meRes?.data) {
            const u = meRes.data;
            const perms = u.permissions || [];
            try {
              localStorage.setItem('user', JSON.stringify(u));
              localStorage.setItem('permissions', JSON.stringify(perms));
              window.dispatchEvent(new Event('auth-user-refreshed'));
            } catch {
              /* localStorage write may fail in quota cases */
            }
          }
        } catch {
          /* /me failures are tolerated; refresh still succeeds */
        }

        originalRequest.headers['Authorization'] = `Bearer ${newToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        localStorage.removeItem('token');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('user');
        localStorage.removeItem('permissions');
        if (window.location.pathname !== '/login') {
          // BUG-FE-119: prefer the pre-imported reference so an unmount race
          // during strict-mode doesn't suppress the warning toast.
          try {
            (_antdMessage || (await import('antd')).message)
              .warning('Session expired, please log in again');
          } catch { /* best-effort */ }
          window.location.href = '/login';
        }
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default api;
