/**
 * vendorApi.js — Axios instance for the Supplier Portal.
 *
 * Mirrors carrierApi.js exactly but uses a separate localStorage key
 * (`vendor_token`) so supplier and transporter sessions cannot bleed into
 * each other.  All requests from SupplierPortal.jsx go through this instance.
 */
import axios from 'axios';

const IS_UAT = String(import.meta.env.VITE_UAT || '').toLowerCase() === 'true' || 
               String(import.meta.env.VITE_UAT || '').toLowerCase() === '1' ||
               String(import.meta.env.VITE_UAT || '').toLowerCase() === 'yes' ||
               String(import.meta.env.VITE_UAT || '').toLowerCase() === 'on';
const UAT_PREFIX = IS_UAT ? '/uat' : '';
const BASE = import.meta.env.VITE_API_URL || `${UAT_PREFIX}/api/v1`;

const vendorApi = axios.create({
  baseURL: BASE,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30000,
});

/* Attach Bearer token from vendor localStorage key */
vendorApi.interceptors.request.use((config) => {
  const token = localStorage.getItem('vendor_token');
  const isPublicEndpoint = config.url && (
    config.url.includes('/vendor-auth/login') ||
    config.url.includes('/vendor-auth/refresh-token')
  );
  if (token && !isPublicEndpoint) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/* On 401 — clear vendor session and bounce to login */
vendorApi.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err?.response?.status === 401) {
      localStorage.removeItem('vendor_token');
      localStorage.removeItem('vendor_user');
      // Only redirect if we're currently on the /supplier path
      const IS_UAT = String(import.meta.env.VITE_UAT || '').toLowerCase() === 'true' || 
                     String(import.meta.env.VITE_UAT || '').toLowerCase() === '1' ||
                     String(import.meta.env.VITE_UAT || '').toLowerCase() === 'yes' ||
                     String(import.meta.env.VITE_UAT || '').toLowerCase() === 'on';
      const uatPrefix = IS_UAT ? '/uat' : '';
      if (window.location.pathname.startsWith(`${uatPrefix}/supplier`)) {
        window.location.href = `${uatPrefix}/login`;
      }
    }
    return Promise.reject(err);
  },
);

export default vendorApi;
