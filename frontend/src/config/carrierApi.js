import axios from 'axios';

const IS_UAT = String(import.meta.env.VITE_UAT || '').toLowerCase() === 'true' || 
               String(import.meta.env.VITE_UAT || '').toLowerCase() === '1' ||
               String(import.meta.env.VITE_UAT || '').toLowerCase() === 'yes' ||
               String(import.meta.env.VITE_UAT || '').toLowerCase() === 'on';
const UAT_PREFIX = IS_UAT ? '/uat' : '';
const BASE_URL =
  (import.meta.env && import.meta.env.VITE_API_BASE_URL) || `${UAT_PREFIX}/api/v1`;

const carrierApi = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
});

carrierApi.interceptors.request.use((config) => {
  const token = localStorage.getItem('carrier_token');
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

carrierApi.interceptors.response.use(
  (resp) => resp,
  (err) => {
    if (err?.response?.status === 401) {
      try {
        localStorage.removeItem('carrier_token');
        localStorage.removeItem('carrier_user');
      } catch {
        /* ignore */
      }
      // Bounce to login if we're inside the carrier portal
      const IS_UAT = String(import.meta.env.VITE_UAT || '').toLowerCase() === 'true' || 
                     String(import.meta.env.VITE_UAT || '').toLowerCase() === '1' ||
                     String(import.meta.env.VITE_UAT || '').toLowerCase() === 'yes' ||
                     String(import.meta.env.VITE_UAT || '').toLowerCase() === 'on';
      const uatPrefix = IS_UAT ? '/uat' : '';
      if (window.location.pathname.startsWith(`${uatPrefix}/carrier`)) {
        window.location.replace(`${uatPrefix}/login`);
      }
    }
    return Promise.reject(err);
  },
);

export default carrierApi;
