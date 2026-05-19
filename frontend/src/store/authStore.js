import { create } from 'zustand';
import api from '../config/api';

// AUTH-1 fix: corrupted localStorage must not crash the entire app
const safeParse = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
};

// BUG-FE-107: decode JWT exp claim so the client can refresh proactively
// instead of waiting for a 401. Returns ms-epoch or null.
const decodeJwtExp = (token) => {
  try {
    const seg = token.split('.')[1];
    if (!seg) return null;
    const json = JSON.parse(
      atob(seg.replace(/-/g, '+').replace(/_/g, '/'))
    );
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
};

const useAuthStore = create((set, get) => ({
  user: safeParse('user', null),
  token: localStorage.getItem('token') || null,
  // BUG-FE-107: track expiry so callers can short-circuit requests when the
  // JWT is already past its exp claim.
  tokenExpiresAt: decodeJwtExp(localStorage.getItem('token') || ''),
  permissions: safeParse('permissions', []),
  // Task 7: server-driven sidebar + active-role tracking. These are
  // populated lazily on layout mount via GET /me/sidebar; we don't try to
  // hydrate from localStorage because the canonical source is the server.
  activeRoleId: null,
  activeRoleCode: null,
  // RBAC-FE: persisted whitelist of MENU_CONFIG keys (top-level +
  // `parent-child`) the server says the active role is allowed to see.
  // Hydrated from localStorage so reloads don't briefly deny access while
  // /me/sidebar is in flight; refreshed on login + on app boot.
  allowedKeys: safeParse('allowedKeys', []),
  loading: false,

  isTokenExpired: () => {
    const exp = get().tokenExpiresAt;
    if (!exp) return false;
    return Date.now() >= exp;
  },

  login: async (username, password, remember, extra = {}) => {
    set({ loading: true });
    try {
      // BUG-FE-159: forward optional login_type ("employee" | "vendor") so the
      // backend can decline the wrong tab if both worlds share usernames.
      const body = { username, password, ...(extra.login_type ? { login_type: extra.login_type } : {}) };
      const response = await api.post('/auth/login', body);
      const { access_token, refresh_token, user } = response.data;
      const permissions = response.data.permissions || user?.permissions || [];
      localStorage.setItem('token', access_token);
      if (refresh_token) localStorage.setItem('refreshToken', refresh_token);
      const userData = user || {};
      // BUG-FE-110: prefer first+last as the display name; only fall back to
      // username when the user has neither part filled out. Previously the
      // chain concatenated both first+last+username when first/last were
      // missing, surfacing the username inside what looks like a full name.
      const fullParts = [userData.first_name, userData.last_name].filter(Boolean);
      userData.full_name = userData.full_name
        || (fullParts.length ? fullParts.join(' ') : userData.username);
      localStorage.setItem('user', JSON.stringify(userData));
      localStorage.setItem('permissions', JSON.stringify(permissions));
      // BUG-FE-113: only mutate remember_* keys when the caller passed an
      // explicit boolean. `undefined` (older callers) must NOT silently clear
      // the user's previous "Remember me" choice.
      if (remember === true) {
        localStorage.setItem('remember_user', username);
        // BUG-FE-156: opt-in flag the Login form checks before pre-filling
        localStorage.setItem('remember_user_enabled', '1');
      } else if (remember === false) {
        localStorage.removeItem('remember_user');
        localStorage.removeItem('remember_user_enabled');
      }
      set({
        user: userData,
        token: access_token,
        tokenExpiresAt: decodeJwtExp(access_token),
        permissions: permissions || [],
        loading: false,
      });
      // RBAC-FE: pull the server-driven allowed-keys whitelist immediately
      // after login so KeyRoute guards are accurate on the first navigation.
      // Failure here is non-fatal — fetchAllowedKeys falls back to [] and
      // super_admin/admin still short-circuit through hasKey.
      try { await get().fetchAllowedKeys(); } catch { /* non-fatal */ }
      return { success: true };
    } catch (error) {
      // BUG-FE-112: clear any stale token/permissions from a previous session
      // when a new login attempt fails — otherwise the rejected attempt
      // leaves the previous user's permissions cached client-side.
      try {
        localStorage.removeItem('token');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('user');
        localStorage.removeItem('permissions');
      } catch { /* ignore quota / privacy errors */ }
      set({ user: null, token: null, tokenExpiresAt: null, permissions: [], loading: false,
            activeRoleId: null, activeRoleCode: null, allowedKeys: [] });
      // BUG-AUTH-180 fix: surface the actual reason on rate-limit (429) and
      // network errors. Previously every non-detail response squashed to the
      // generic "check your credentials" message — confusing when the user
      // was actually being throttled or hit a network error.
      const status = error.response?.status;
      const data = error.response?.data || {};
      const detail = data.detail;
      let msg;
      if (status === 429) {
        msg = data.error || 'Too many login attempts. Please wait a minute and try again.';
      } else if (status === 423) {
        msg = 'Account temporarily locked after repeated failed attempts. Try again in 15 minutes.';
      } else if (!error.response) {
        msg = 'Cannot reach the server. Check your network and try again.';
      } else if (typeof detail === 'string') {
        msg = detail;
      } else if (Array.isArray(detail)) {
        msg = detail.map((d) => d.msg || JSON.stringify(d)).join(', ');
      } else {
        msg = 'Login failed. Please check your credentials.';
      }
      return { success: false, error: msg };
    }
  },

  logout: async () => {
    // BUG-AUTH-140 fix: call the backend /auth/logout so an ActivityLog row
    // is written (audit trail). Failure to reach the backend must NOT block
    // local logout — we still clear tokens.
    try {
      await api.post('/auth/logout');
    } catch {
      /* network/auth error is fine; proceed with local cleanup */
    }
    localStorage.removeItem('token');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    localStorage.removeItem('permissions');
    // RBAC-FE: drop the cached allowed-keys whitelist so the next session
    // starts deny-by-default until /me/sidebar responds.
    localStorage.removeItem('allowedKeys');
    // BUG-AUTH-027 fix: clear the "Remember me" pre-fill on explicit logout
    // so the next sign-in screen on a shared workstation does not surface
    // the previous user's username. The Login form's opt-in flag is also
    // cleared so the autofill does not silently re-enable.
    localStorage.removeItem('remember_user');
    localStorage.removeItem('remember_user_enabled');
    // BUG-FE-108: drop the stale-bundle reload guard so the next session can
    // detect a fresh stale-bundle event without thinking it already reloaded.
    try { sessionStorage.removeItem('staleBundleReloaded'); } catch { /* ignore */ }
    // BUG-FE-114: also reset the `loading` flag so a logout that happened
    // mid-login does not leave the spinner state stuck on.
    set({ user: null, token: null, tokenExpiresAt: null, permissions: [], loading: false,
          activeRoleId: null, activeRoleCode: null, allowedKeys: [] });
  },

  hasPermission: (module, action) => {
    const { permissions, user } = get();
    // BUG-AUTH-122 fix: previously this matched admin via the role NAME
    // ("Admin", "Super Admin"). That is privesc — anyone could create a
    // role named "Admin" with no permissions and gain global access. Match
    // strictly by role.code (the canonical machine identifier).
    const roles = user?.roles || [];
    const roleCodes = roles
      .map((r) => (typeof r === 'string' ? r : r.code))
      .filter(Boolean);
    if (roleCodes.includes('super_admin') || roleCodes.includes('admin')) return true;
    if (!permissions || permissions.length === 0) return false;
    // Permissions are strings like "module.action.resource"
    return permissions.some((p) => {
      if (typeof p === 'string') {
        const parts = p.split('.');
        const pMod = parts[0];
        const pAct = parts[1];
        return (pMod === module || pMod === '*') && (!action || pAct === action || pAct === '*');
      }
      return p.module === module && (!action || p.actions?.includes(action));
    });
  },

  hasModuleAccess: (module) => {
    return get().hasPermission(module, 'view');
  },

  // RBAC-FE: per-page key gate. Mirrors hasPermission's super_admin/admin
  // bypass (matched strictly by role.code per BUG-AUTH-122) but checks the
  // server-driven allowed-keys whitelist instead of the legacy
  // module.action permission strings. Anything not on the whitelist is
  // denied — so callers must guarantee /me/sidebar has been fetched at
  // least once after login (or rely on the hydrated localStorage copy).
  hasKey: (key) => {
    const { allowedKeys, user } = get();
    const roles = user?.roles || [];
    const roleCodes = roles
      .map((r) => (typeof r === 'string' ? r : r.code))
      .filter(Boolean);
    if (roleCodes.includes('super_admin') || roleCodes.includes('admin')) return true;
    if (!key) return false;
    return Array.isArray(allowedKeys) && allowedKeys.includes(key);
  },

  // RBAC-FE: refresh the allowed-keys whitelist from /me/sidebar and
  // persist to localStorage. Called on login and on app boot. On 4xx we
  // fall back to an empty array (deny-by-default for non-admins).
  fetchAllowedKeys: async () => {
    try {
      const resp = await api.get('/me/sidebar');
      const data = resp.data || {};
      const keys = Array.isArray(data.allowed_keys) ? data.allowed_keys : [];
      try { localStorage.setItem('allowedKeys', JSON.stringify(keys)); } catch { /* quota */ }
      set({
        activeRoleId: data.active_role_id ?? null,
        activeRoleCode: data.active_role_code ?? null,
        allowedKeys: keys,
      });
      return keys;
    } catch (err) {
      const status = err?.response?.status;
      if (status && status >= 400 && status < 500) {
        try { localStorage.setItem('allowedKeys', JSON.stringify([])); } catch { /* quota */ }
        set({ allowedKeys: [] });
      }
      return [];
    }
  },

  updateProfile: (userData) => {
    localStorage.setItem('user', JSON.stringify(userData));
    set({ user: userData });
  },

  // Task 7: write the server-driven sidebar policy back into the store
  // so MainLayout + RoleSwitcher can read from a single source of truth.
  // The server returns the active role + a flat allowed-keys whitelist; the
  // Layout filters its existing MENU_CONFIG tree against that list.
  setSidebar: (resp) => {
    const keys = resp.allowed_keys || [];
    // RBAC-FE: persist so KeyRoute survives reloads without an API roundtrip.
    try { localStorage.setItem('allowedKeys', JSON.stringify(keys)); } catch { /* quota */ }
    set({
      activeRoleId: resp.active_role_id,
      activeRoleCode: resp.active_role_code,
      allowedKeys: keys,
    });
  },

  // Sync token from localStorage when the refresh interceptor updates it.
  // BUG-FE-115: also pick up user/permissions changes — a refresh response
  // that updates the cached user (e.g. role rotation) was previously dropped
  // because this only synced the token field.
  _syncFromStorage: () => {
    const token = localStorage.getItem('token');
    const user = safeParse('user', null);
    const permissions = safeParse('permissions', []);
    const cur = get();
    const next = {};
    if (token !== cur.token) {
      next.token = token;
      next.tokenExpiresAt = token ? decodeJwtExp(token) : null;
    }
    if (JSON.stringify(user) !== JSON.stringify(cur.user)) {
      next.user = user;
    }
    if (JSON.stringify(permissions) !== JSON.stringify(cur.permissions)) {
      next.permissions = permissions || [];
    }
    if (Object.keys(next).length > 0) {
      set(next);
    }
  },
}));

// Listen for storage changes from the token refresh interceptor (same-tab
// custom event) so Zustand stays in sync without circular imports.
window.addEventListener('auth-token-refreshed', () => {
  useAuthStore.getState()._syncFromStorage();
});

// BUG-FE-111: cross-tab logout sync. When another tab clears the token from
// localStorage (e.g. via logout) the `storage` event fires here. Reflect the
// new state so this tab also drops the token instead of leaving the user
// session ghosted.
window.addEventListener('storage', (e) => {
  if (e.key === 'token') {
    const token = e.newValue;
    if (!token) {
      // Logged out elsewhere — clear state in this tab too.
      try { localStorage.removeItem('allowedKeys'); } catch { /* ignore */ }
      useAuthStore.setState({ user: null, token: null, permissions: [],
        activeRoleId: null, activeRoleCode: null, allowedKeys: [] });
    } else {
      useAuthStore.getState()._syncFromStorage();
    }
  }
});

export default useAuthStore;
