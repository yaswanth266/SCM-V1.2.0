import axios from 'axios';

const BASE_URL =
  (import.meta.env && import.meta.env.VITE_API_BASE_URL) || '/api/v1';

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
      if (window.location.pathname.startsWith('/carrier')) {
        window.location.replace('/login');
      }
    }
    return Promise.reject(err);
  },
);

export default carrierApi;
