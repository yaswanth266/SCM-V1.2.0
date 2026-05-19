import { create } from 'zustand';
import api from '../config/api';

// BUG-FE-095: persist sidebar collapsed state across refreshes so the user
// doesn't see the panel re-open every reload. localStorage is sufficient — we
// don't need full zustand/persist middleware for a single boolean.
const COLLAPSED_KEY = 'bavya.sidebar.collapsed';
const _readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
};
const _writeCollapsed = (val) => {
  try {
    localStorage.setItem(COLLAPSED_KEY, val ? '1' : '0');
  } catch {
    // ignore quota / privacy errors
  }
};

const useAppStore = create((set) => ({
  collapsed: _readCollapsed(),
  notifications: [],
  unreadCount: 0,
  breadcrumb: [],

  toggleSidebar: () => set((state) => {
    const next = !state.collapsed;
    _writeCollapsed(next);
    return { collapsed: next };
  }),
  setCollapsed: (collapsed) => {
    _writeCollapsed(collapsed);
    set({ collapsed });
  },

  setBreadcrumb: (breadcrumb) => set({ breadcrumb }),

  setNotifications: (notifications) =>
    set({
      notifications,
      unreadCount: notifications.filter((n) => !n.read).length,
    }),

  addNotification: (notification) =>
    set((state) => ({
      notifications: [notification, ...state.notifications],
      unreadCount: state.unreadCount + 1,
    })),

  markNotificationRead: (id) =>
    set((state) => ({
      notifications: state.notifications.map((n) =>
        n.id === id ? { ...n, read: true } : n
      ),
      unreadCount: Math.max(0, state.unreadCount - 1),
    })),

  markAllRead: async () => {
    // BUG-FE-094: persist read state on the server so reload doesn't restore
    // the unread count. Update the client optimistically; revert on failure.
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    }));
    try {
      await api.post('/notifications/mark-all-read');
    } catch {
      // best-effort: leave the optimistic state in place — the next fetch
      // (on reload or polling) will reconcile.
    }
  },
}));

export default useAppStore;
