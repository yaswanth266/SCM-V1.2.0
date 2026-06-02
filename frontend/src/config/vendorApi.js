/**
 * vendorApi.js — Axios instance for the Supplier Portal.
 *
 * Mirrors carrierApi.js exactly but uses a separate localStorage key
 * (`vendor_token`) so supplier and transporter sessions cannot bleed into
 * each other.  All requests from SupplierPortal.jsx go through this instance.
 */
import axios from 'axios';

const BASE = import.meta.env.VITE_API_URL || '/api/v1';

const vendorApi = axios.create({
  baseURL: BASE,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30000,
});

/* Attach Bearer token from vendor localStorage key */
vendorApi.interceptors.request.use((config) => {
  const token = localStorage.getItem('vendor_token');
  if (token) {
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
      if (window.location.pathname.startsWith('/supplier')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  },
);

export default vendorApi;
