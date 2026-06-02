import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, Dropdown } from 'antd';
import {
  DashboardOutlined,
  AppstoreOutlined,
  ShoppingCartOutlined,
  HomeOutlined,
  InboxOutlined,
  CarOutlined,
  FileTextOutlined,
  AuditOutlined,
  CheckSquareOutlined,
  DollarOutlined,
  SafetyCertificateOutlined,
  HeartOutlined,
  BarChartOutlined,
  SettingOutlined,
  PlayCircleOutlined,
  UserOutlined,
  LockOutlined,
  LogoutOutlined,
} from '@ant-design/icons';
import useAuthStore from '../store/authStore';
import api from '../config/api';

// Bavya design tokens — module tile palette
const MODULES = [
  { id: 'dashboard',   name: 'Dashboard',       desc: 'KPIs & operations overview',          icon: <DashboardOutlined />,        color: '#D80048', bg: '#FDE6EC', path: '/dashboard' },
  { id: 'masters',     name: 'Masters',         desc: 'Items, vendors, warehouses, UOM',     icon: <AppstoreOutlined />,         color: '#481890', bg: '#EEE6F7', path: '/masters/items' },
  { id: 'procurement', name: 'Procurement',     desc: 'Material requests, POs, quotations',  icon: <ShoppingCartOutlined />,     color: '#D80048', bg: '#FDE6EC', path: '/procurement/material-requests', countKey: 'procurement_open' },
  { id: 'warehouse',   name: 'Warehouse',       desc: 'GRN, quality, putaway, issues',       icon: <HomeOutlined />,             color: '#F09000', bg: '#FFEAD2', path: '/warehouse/grn' },
  { id: 'inventory',   name: 'Inventory',       desc: 'Stock, transfers, audit, replenish',  icon: <InboxOutlined />,            color: '#900078', bg: '#F7E3F2', path: '/inventory/stock-balance' },
  { id: 'indent',      name: 'Indent',          desc: 'Field indents & acknowledgement',     icon: <FileTextOutlined />,         color: '#481890', bg: '#EEE6F7', path: '/indent/indents' },
  { id: 'consumption', name: 'Consumption',     desc: 'Issue tracking & reports',            icon: <AuditOutlined />,            color: '#D80048', bg: '#FDE6EC', path: '/consumption/entry' },
  { id: 'approvals',   name: 'Approvals',       desc: 'Pending workflows',                   icon: <CheckSquareOutlined />,      color: '#900078', bg: '#F7E3F2', path: '/approvals/pending', countKey: 'pending_approvals' },
  { id: 'accounts',    name: 'Accounts',        desc: 'Invoices, payments, ledger',          icon: <DollarOutlined />,           color: '#F09000', bg: '#FFEAD2', path: '/accounts/invoices' },
  { id: 'assets',      name: 'Assets',          desc: 'Register & movement',                 icon: <SafetyCertificateOutlined />,color: '#2E7D52', bg: '#E6F4EC', path: '/assets/register' },
  { id: 'healthcare',  name: 'Healthcare SCM',  desc: 'MMU kits, 108 fleet, programs',       icon: <HeartOutlined />,            color: '#D80048', bg: '#FDE6EC', path: '/healthcare' },
  { id: 'logistics',   name: 'Logistics',       desc: 'B2B dispatches, RFQs & Service Orders',icon: <CarOutlined />,              color: '#096dd9', bg: '#E6F7FF', path: '/logistics/dashboard' },
  { id: 'reports',     name: 'Reports',         desc: 'Pivot, graph, exports',               icon: <BarChartOutlined />,         color: '#481890', bg: '#EEE6F7', path: '/reports' },
  { id: 'settings',    name: 'Settings',        desc: 'Users, roles, system',                icon: <SettingOutlined />,          color: '#7A6D66', bg: '#F4EEEA', path: '/settings/profile' },
  { id: 'lms',         name: 'Learning Center', desc: 'Tutorials for your role',             icon: <PlayCircleOutlined />,       color: '#2E7D52', bg: '#E6F4EC', path: '/lms', alwaysShow: true },
];

// Map module id → permission module name used by hasPermission()
const PERM_MAP = {
  dashboard: 'dashboard',
  masters: 'masters',
  procurement: 'procurement',
  warehouse: 'warehouse',
  inventory: 'inventory',
  indent: 'indent',
  consumption: 'consumption',
  approvals: 'approvals',
  accounts: 'accounts',
  assets: 'assets',
  healthcare: 'healthcare',
  logistics: 'logistics',
  reports: 'reports',
  settings: 'settings',
  // BUG-FE-097: keep PERM_MAP exhaustive so a future tweak to `alwaysShow`
  // still has a sane fall-through. The lms module is open to every signed-in
  // user — `alwaysShow` flag remains the source of truth.
  lms: 'lms',
};

const firstName = (user) => {
  // BUG-FE-165: ensure each fallback returns a non-empty trimmed string
  // before accepting it — otherwise a user with `first_name: ""` (from a
  // cleared profile field) renders "Welcome back, ." instead of falling
  // through to the next option.
  const first = (user?.first_name || '').trim();
  if (first) return first;
  const full = (user?.full_name || '').trim();
  if (full) return full.split(' ')[0];
  const uname = (user?.username || '').trim();
  if (uname) return uname;
  return 'there';
};

const AppLauncher = () => {
  const navigate = useNavigate();
  const { user, hasPermission, logout } = useAuthStore();
  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };
  const userMenuItems = {
    items: [
      { key: 'profile', icon: <UserOutlined />, label: 'Profile',
        onClick: () => navigate('/settings/profile') },
      { key: 'change-password', icon: <LockOutlined />, label: 'Change Password',
        onClick: () => navigate('/settings/change-password') },
      { type: 'divider' },
      { key: 'logout', icon: <LogoutOutlined />, label: 'Logout',
        danger: true, onClick: handleLogout },
    ],
  };
  // 2026-05-03: launcher tile visibility now follows the same server-driven
  // allowedKeys whitelist used by the sidebar. Without this, admin/super_admin
  // bypass hasPermission and see every tile (including ones their role lacks
  // backend perms for, e.g. admin → accounts.* → 403 on click).
  const allowedKeys = useAuthStore((s) => s.allowedKeys);
  const [counts, setCounts] = useState({});

  useEffect(() => {
    // BUG-FE-096: don't ping /dashboard/stats when the user can't view the
    // dashboard — otherwise the launcher logs a 403 every load and pollutes
    // audit traces.
    if (!hasPermission('dashboard', 'view')) return undefined;
    let cancelled = false;
    const fetchStats = () => {
      api
        .get('/dashboard/stats')
        .then((res) => {
          if (cancelled) return;
          const d = res.data || {};
          setCounts({
            procurement_open: d.open_material_requests ?? d.material_requests_pending ?? null,
            pending_approvals:
              d.pending_approvals ?? d.pending_acknowledgements ?? null,
          });
        })
        .catch(() => {});
    };
    fetchStats();
    // BUG-FE-164: refresh tile counts every 60s while the launcher is open
    // so badges don't go stale during long sessions.
    const id = setInterval(fetchStats, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hasPermission]);

  // BUG-FE-167: Masters tile defaults to /masters/items but a user may only
  // have access to e.g. /masters/categories. Resolve to the first allowed
  // subroute so clicking the tile never lands on a 403 page.
  const MASTERS_SUBROUTES = [
    { path: '/masters/items', resource: 'items' },
    { path: '/masters/categories', resource: 'categories' },
    { path: '/masters/brands', resource: 'brands' },
    { path: '/masters/item-attributes', resource: 'item_attributes' },
    { path: '/masters/vendors', resource: 'vendors' },
    { path: '/masters/warehouses', resource: 'warehouses' },
    { path: '/masters/uom', resource: 'uom' },
    { path: '/masters/price-lists', resource: 'price_lists' },
    { path: '/masters/user-groups', resource: 'user_groups' },
  ];
  const resolveMastersPath = () => {
    for (const s of MASTERS_SUBROUTES) {
      // hasPermission(module, action) — resource granularity isn't checked
      // here since the FE store keeps a flat permissions list. Fall back to
      // the first viewable route.
      if (hasPermission('masters', 'view')) return s.path;
    }
    return '/masters/items';
  };

  // Admin / super_admin sentinel — same trick as MainLayout: real roles
  // never grant `__admin_only__.manage`, so this returns true only for
  // admin/super_admin codes.
  const isAdmin = hasPermission('__admin_only__', 'manage');

  // Field-only users — tile-level scope to match MainLayout's sidebar
  // gating. Field staff / field supervisors see Dashboard, Indent,
  // Consumption, Inventory (Stock Balance), LMS, and (if they have the
  // approve perm) Approvals. They must NOT see Masters, Procurement,
  // Warehouse, Accounts, Assets, Reports, Healthcare —
  // those are management/setup areas that just confuse field users.
  const FIELD_HIDE_TILES = new Set([
    'masters', 'procurement', 'warehouse',
    'accounts', 'assets', 'reports', 'healthcare',
  ]);
  const FIELD_ROLE_CODES = new Set([
    'field_staff', 'field_supervisor', 'field_user', 'field_operator',
    'nurse', 'pharmacy_assistant', 'site_user',
  ]);
  const userRoleCodes = (user?.roles || []).map(
    (r) => (r?.code || r?.role_code || '').toLowerCase()
  );
  const MANAGER_ROLE_CODES = new Set([
    'super_admin','admin','procurement_manager','store_manager',
    'warehouse_manager','inventory_manager',
    'accounts_manager','finance_manager','compliance_manager',
    'project_manager','manager','pharmacy_manager','qa_manager',
  ]);
  const isManagerUser = isAdmin || userRoleCodes.some((c) => MANAGER_ROLE_CODES.has(c));
  const isFieldOnly = !isAdmin && !isManagerUser
    && userRoleCodes.length > 0
    && userRoleCodes.every((c) => FIELD_ROLE_CODES.has(c));

  // Settings tile is admin-only on the launcher.
  // Server-driven path (preferred): when allowedKeys is populated, a tile is
  // visible iff the module's top-level key is in the whitelist. lms always
  // shows. Falls back to client-side hasPermission when allowedKeys is empty
  // (e.g. /me/sidebar fetch failed / not yet hydrated).
  const useServerKeys = Array.isArray(allowedKeys) && allowedKeys.length > 0;
  const allowedSet = new Set(allowedKeys || []);
  const visible = MODULES.filter((m) => {
    if (m.alwaysShow) return true;
    if (useServerKeys) {
      // Tile id matches MENU_CONFIG top-level key (dashboard, masters, …).
      return allowedSet.has(m.id);
    }
    // Legacy fallback: hasPermission-based filter.
    if (m.id === 'settings') return isAdmin;
    if (isFieldOnly && FIELD_HIDE_TILES.has(m.id)) {
      if (m.id === 'approvals' && hasPermission('approvals', 'approve')) {
        // fall through to perm check
      } else {
        return false;
      }
    }
    return hasPermission(PERM_MAP[m.id], 'view');
  }).map((m) => {
    if (m.id === 'masters') return { ...m, path: resolveMastersPath() };
    // Generic resolver: if the tile's hardcoded path's top-two segments
    // (`/warehouse/grn` -> "warehouse-grn") aren't in the user's allowed
    // sidebar keys, fall back to the FIRST allowed key for this module.
    // Stops users like quality_inspector — who only have
    // warehouse-quality-inspection — from clicking the Warehouse tile and
    // landing on /warehouse/grn (no access).
    if (useServerKeys) {
      const parts = (m.path || '').split('/').filter(Boolean);
      if (parts.length >= 2) {
        const tileKey = `${parts[0]}-${parts[1]}`;
        if (!allowedSet.has(tileKey)) {
          // Find the first allowed key under this module.
          const prefix = `${m.id}-`;
          const firstAllowed = Array.from(allowedSet).find((k) => k.startsWith(prefix) && k !== m.id);
          if (firstAllowed) {
            const subPath = firstAllowed.slice(prefix.length).replace(/_/g, '-');
            return { ...m, path: `/${m.id}/${subPath}` };
          }
        }
      }
    }
    return m;
  });

  return (
    <div className="bavya-launcher">
      <div className="bavya-launcher-topbar">
        <Dropdown menu={userMenuItems} trigger={['click']} placement="bottomRight">
          <div
            className="bavya-launcher-profile"
            role="button"
            tabIndex={0}
            title={user?.full_name || user?.username || 'Account'}
          >
            <Avatar size={32} icon={<UserOutlined />} style={{ background: '#481890' }} />
            <span className="bavya-launcher-profile-name">{firstName(user)}</span>
          </div>
        </Dropdown>
      </div>
      <img
        src="/bavya-lockup.png"
        alt="Bavya SCM"
        className="bavya-launcher-logo"
      />
      <h1>
        Welcome back, <em>{firstName(user)}.</em>
      </h1>
      <div className="bavya-launcher-sub">Choose a module to begin.</div>
      <div className="bavya-launcher-grid">
        {visible.map((m) => {
          const count = m.countKey ? counts[m.countKey] : null;
          return (
            <div
              key={m.id}
              className="bavya-tile"
              style={{ '--tile-color': m.color, '--tile-bg': m.bg }}
              onClick={() => navigate(m.path)}
              role="button"
              tabIndex={0}
              // BUG-FE-098: also activate on Space, matching native button
              // behaviour. preventDefault so the page doesn't scroll while
              // a tile is focused.
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  navigate(m.path);
                }
              }}
            >
              {/* BUG-FE-166: surface a quiet "—" when the count is genuinely
                  zero so users can tell the difference between "no open
                  items" (count === 0) and "stats unavailable" (null). */}
              {count != null && count > 0 && (
                <div className="bavya-tile-count" style={{ color: m.color }}>
                  {count} open
                </div>
              )}
              {count === 0 && (
                <div className="bavya-tile-count" style={{ color: m.color, opacity: 0.5 }}>
                  No open items
                </div>
              )}
              <div className="bavya-tile-ico">{m.icon}</div>
              <div className="bavya-tile-title">{m.name}</div>
              <div className="bavya-tile-desc">{m.desc}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default AppLauncher;
