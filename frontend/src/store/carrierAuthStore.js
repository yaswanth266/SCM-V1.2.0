import { create } from 'zustand';
import carrierApi from '../config/carrierApi';

const safeParse = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
};

const useCarrierAuthStore = create((set, get) => ({
  user: safeParse('carrier_user', null),
  token: localStorage.getItem('carrier_token') || null,
  loading: false,

  login: async (username, password) => {
    set({ loading: true });
    try {
      const resp = await carrierApi.post('/carrier-auth/login', { username, password });
      const { access_token, user } = resp.data || {};
      localStorage.setItem('carrier_token', access_token);
      localStorage.setItem('carrier_user', JSON.stringify(user || {}));
      set({ token: access_token, user: user || {}, loading: false });
      return { success: true };
    } catch (err) {
      set({ loading: false });
      const status = err?.response?.status;
      const detail = err?.response?.data?.detail;
      let msg;
      if (status === 429) msg = 'Too many login attempts. Try again later.';
      else if (!err.response) msg = 'Cannot reach the server. Check your network.';
      else if (typeof detail === 'string') msg = detail;
      else msg = 'Login failed. Please check your credentials.';
      return { success: false, error: msg };
    }
  },

  logout: async () => {
    try {
      await carrierApi.post('/carrier-auth/logout');
    } catch {
      /* ignore */
    }
    localStorage.removeItem('carrier_token');
    localStorage.removeItem('carrier_user');
    set({ token: null, user: null, loading: false });
  },

  refreshMe: async () => {
    try {
      const r = await carrierApi.get('/carrier-auth/me');
      localStorage.setItem('carrier_user', JSON.stringify(r.data));
      set({ user: r.data });
    } catch {
      /* ignore */
    }
  },
}));

export default useCarrierAuthStore;
