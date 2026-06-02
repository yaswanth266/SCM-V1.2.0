/**
 * vendorAuthStore.js — Zustand store for Supplier (material vendor) Portal sessions.
 *
 * Mirrors carrierAuthStore.js exactly.  Uses separate localStorage keys
 * (`vendor_token`, `vendor_user`) so supplier and transporter sessions are
 * completely independent.
 */
import { create } from 'zustand';
import vendorApi from '../config/vendorApi';

const TOKEN_KEY = 'vendor_token';
const USER_KEY = 'vendor_user';

function _persist(token, user) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
  if (user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(USER_KEY);
  }
}

function _loadFromStorage() {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const raw = localStorage.getItem(USER_KEY);
    const user = raw ? JSON.parse(raw) : null;
    return { token: token || null, user };
  } catch {
    return { token: null, user: null };
  }
}

const { token: initToken, user: initUser } = _loadFromStorage();

const useVendorAuthStore = create((set, get) => ({
  token: initToken,
  user: initUser,
  loading: false,
  error: null,

  /**
   * Login with supplier credentials.
   * Returns { success: true } or { success: false, error: '...' }.
   */
  login: async (username, password) => {
    set({ loading: true, error: null });
    try {
      const res = await vendorApi.post('/vendor-auth/login', { username, password });
      const { access_token, user } = res.data;
      _persist(access_token, user);
      set({ token: access_token, user, loading: false });
      return { success: true };
    } catch (err) {
      const msg =
        err?.response?.data?.detail ||
        err?.response?.data?.message ||
        'Login failed. Please check your credentials.';
      set({ error: msg, loading: false });
      return { success: false, error: msg };
    }
  },

  logout: async () => {
    try {
      await vendorApi.post('/vendor-auth/logout');
    } catch {
      // Ignore errors on logout — always clear client side
    }
    _persist(null, null);
    set({ token: null, user: null });
  },

  refreshUser: async () => {
    try {
      const res = await vendorApi.get('/vendor-auth/me');
      const user = res.data;
      _persist(get().token, user);
      set({ user });
      return user;
    } catch {
      return null;
    }
  },

  changePassword: async (currentPassword, newPassword) => {
    const res = await vendorApi.post('/vendor-auth/change-password', {
      current_password: currentPassword,
      new_password: newPassword,
    });
    // After password change, re-fetch user so must_change_password flag updates
    await get().refreshUser();
    return res.data;
  },
}));

export default useVendorAuthStore;
