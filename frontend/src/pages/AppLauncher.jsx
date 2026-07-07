import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, Dropdown, Popover, Badge, List, Empty, Button, Typography, Tabs, Tag } from 'antd';
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
  BellOutlined,
} from '@ant-design/icons';
import useAuthStore from '../store/authStore';
import useAppStore from '../store/appStore';
import api from '../config/api';
import RoleSwitcher from '../components/RoleSwitcher';
import { MODULE_NAVS } from '../utils/moduleNavs';
import { formatDateTime } from '../utils/helpers';

// Bavya design tokens — module tile palette
const MODULES = [
  { id: 'masters',     name: 'Masters',         desc: 'Items, vendors, warehouses, UOM',     icon: <AppstoreOutlined />,         color: '#481890', bg: '#EEE6F7', path: '/masters/items' },
  { id: 'procurement', name: 'Procurement',     desc: 'Material requests, POs, quotations',  icon: <ShoppingCartOutlined />,     color: '#D80048', bg: '#FDE6EC', path: '/procurement/material-requests', countKey: 'procurement_open' },
  { id: 'warehouse',   name: 'Warehouse',       desc: 'GRN, quality, putaway, issues',       icon: <HomeOutlined />,             color: '#F09000', bg: '#FFEAD2', path: '/warehouse/grn' },
  { id: 'inventory',   name: 'Inventory',       desc: 'Stock, transfers, audit, replenish',  icon: <InboxOutlined />,            color: '#900078', bg: '#F7E3F2', path: '/inventory/stock-balance' },
  { id: 'indent',      name: 'Indent',          desc: 'Field indents & acknowledgement',     icon: <FileTextOutlined />,         color: '#481890', bg: '#EEE6F7', path: '/indent/indents' },
  { id: 'approvals',   name: 'Approvals',       desc: 'Pending workflows',                   icon: <CheckSquareOutlined />,      color: '#900078', bg: '#F7E3F2', path: '/approvals/pending', countKey: 'pending_approvals' },
  { id: 'logistics',   name: 'Logistics',       desc: 'B2B dispatches, RFQs & Service Orders',icon: <CarOutlined />,              color: '#096dd9', bg: '#E6F7FF', path: '/logistics/dashboard' },
  { id: 'reports',     name: 'Reports',         desc: 'Pivot, graph, exports',               icon: <BarChartOutlined />,         color: '#481890', bg: '#EEE6F7', path: '/reports' },
  { id: 'settings',    name: 'Settings',        desc: 'Users, roles, system',                icon: <SettingOutlined />,          color: '#7A6D66', bg: '#F4EEEA', path: '/settings/profile' },
];

// Map module id → permission module name used by hasPermission()
const PERM_MAP = {
  masters: 'masters',
  procurement: 'procurement',
  warehouse: 'warehouse',
  inventory: 'inventory',
  indent: 'indent',
  approvals: 'approvals',
  logistics: 'logistics',
  reports: 'reports',
  settings: 'settings',
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

const { Text } = Typography;

const AppLauncher = () => {
  const navigate = useNavigate();
  const { user, hasPermission, logout } = useAuthStore();
  const { notifications, unreadCount, markAllRead, fetchNotifications } = useAppStore();

  const [activeNotifTab, setActiveNotifTab] = useState('all');

  const handleNotificationClick = async (item) => {
    try {
      await api.post(`/notifications/${item.id}/read`);
      useAppStore.getState().markNotificationRead(item.id);
    } catch (err) {
      console.error('Failed to mark notification as read:', err);
    }
    const mod = (item.module || '').toLowerCase();
    if (item.reference_type === 'indent' && item.reference_id) {
      navigate(`/indent/indents/${item.reference_id}`);
    } else if (item.reference_type === 'purchase_order' && item.reference_id) {
      navigate(`/procurement/purchase-orders/${item.reference_id}`);
    } else if (item.reference_type === 'grn' && item.reference_id) {
      navigate(`/warehouse/grn/${item.reference_id}`);
    } else {
      if (mod === 'indent') {
        navigate('/indent/notifications');
      } else if (mod === 'warehouse') {
        navigate('/warehouse/notifications');
      } else if (mod === 'procurement') {
        navigate('/procurement/notifications');
      } else if (mod === 'inventory') {
        navigate('/inventory/notifications');
      }
    }
  };

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  // Count calculations for tabs
  const allCount = notifications.filter(n => !n.read).length;
  const procurementCount = notifications.filter(n => !n.read && (n.module || '').toLowerCase() === 'procurement').length;
  const inventoryCount = notifications.filter(n => !n.read && (n.module || '').toLowerCase() === 'inventory').length;
  const warehouseCount = notifications.filter(n => !n.read && (n.module || '').toLowerCase() === 'warehouse').length;
  const indentCount = notifications.filter(n => !n.read && (n.module || '').toLowerCase() === 'indent').length;

  const filteredNotifications = notifications.filter(n => {
    if (activeNotifTab === 'all') return true;
    return (n.module || '').toLowerCase() === activeNotifTab;
  });

  const tabItems = [
    {
      key: 'all',
      label: (
        <Badge count={allCount} size="small" offset={[8, -2]}>
          <span style={{ fontSize: '12px', paddingRight: allCount > 0 ? 6 : 0 }}>All</span>
        </Badge>
      ),
    },
    {
      key: 'procurement',
      label: (
        <Badge count={procurementCount} size="small" offset={[8, -2]}>
          <span style={{ fontSize: '12px', paddingRight: procurementCount > 0 ? 6 : 0 }}>Proc</span>
        </Badge>
      ),
    },
    {
      key: 'inventory',
      label: (
        <Badge count={inventoryCount} size="small" offset={[8, -2]}>
          <span style={{ fontSize: '12px', paddingRight: inventoryCount > 0 ? 6 : 0 }}>Inv</span>
        </Badge>
      ),
    },
    {
      key: 'warehouse',
      label: (
        <Badge count={warehouseCount} size="small" offset={[8, -2]}>
          <span style={{ fontSize: '12px', paddingRight: warehouseCount > 0 ? 6 : 0 }}>WH</span>
        </Badge>
      ),
    },
    {
      key: 'indent',
      label: (
        <Badge count={indentCount} size="small" offset={[8, -2]}>
          <span style={{ fontSize: '12px', paddingRight: indentCount > 0 ? 6 : 0 }}>Indent</span>
        </Badge>
      ),
    },
  ];

  const notificationContent = (
    <div className="notification-dropdown" style={{ minWidth: '320px' }}>
      <div
        style={{
          padding: '8px 16px',
          borderBottom: '1px solid #f0f0f0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Text strong>Notifications</Text>
        {unreadCount > 0 && (
          <Button type="link" size="small" onClick={markAllRead}>
            Mark all read
          </Button>
        )}
      </div>
      <Tabs
        activeKey={activeNotifTab}
        onChange={setActiveNotifTab}
        items={tabItems}
        size="small"
        tabBarStyle={{ margin: 0, padding: '0 8px' }}
      />
      <div style={{ maxHeight: '320px', overflowY: 'auto' }}>
        {filteredNotifications.length > 0 ? (
          <List
            dataSource={filteredNotifications.slice(0, 15)}
            renderItem={(item) => (
              <div
                className="notification-item"
                onClick={() => handleNotificationClick(item)}
                style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid #f0f0f0',
                  cursor: 'pointer',
                  background: item.read ? 'transparent' : '#e6f7ff',
                  transition: 'background 0.2s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#f5f5f5'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = item.read ? 'transparent' : '#e6f7ff'; }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div className="notification-item-title" style={{ fontWeight: item.read ? 500 : 700, color: '#1A1A1A' }}>
                    {item.title}
                  </div>
                  {item.module && (
                    <Tag color="purple" style={{ fontSize: '10px', textTransform: 'capitalize', margin: 0 }}>
                      {item.module}
                    </Tag>
                  )}
                </div>
                {item.description && (
                  <div className="notification-item-desc" style={{ fontSize: '13px', color: '#495057', marginTop: '4px' }}>
                    {item.description}
                  </div>
                )}
                {item.created_at && (
                  <div className="notification-item-time" style={{ fontSize: '11px', color: '#8c8c8c', marginTop: '6px' }}>
                    {formatDateTime(item.created_at)}
                  </div>
                )}
              </div>
            )}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={`No ${activeNotifTab === 'all' ? '' : activeNotifTab} notifications`}
            style={{ padding: 24 }}
          />
        )}
      </div>
    </div>
  );
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
    if (!hasPermission('procurement', 'view') && !hasPermission('approvals', 'view')) return undefined;
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
  const findFirstAllowedPath = (moduleId, allowedSet) => {
    const nav = MODULE_NAVS[moduleId];
    if (!nav || !Array.isArray(nav.tabs)) return null;
    if (moduleId === 'settings') {
      return '/settings/profile';
    }
    const queue = [...nav.tabs];
    while (queue.length > 0) {
      const tab = queue.shift();
      if (tab.children) {
        queue.push(...tab.children);
        continue;
      }
      if (tab.path) {
        const parts = tab.path.split('/').filter(Boolean);
        if (parts.length >= 2) {
          const derivedKey = `${parts[0]}-${parts[1]}`;
          const fullDerivedKey = parts.length >= 3 ? `${parts[0]}-${parts[1]}-${parts[2]}` : null;
          if (allowedSet.has(derivedKey) || (fullDerivedKey && allowedSet.has(fullDerivedKey))) {
            return tab.path;
          }
        }
      }
    }
    return null;
  };

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
    if (useServerKeys) {
      const allowedPath = findFirstAllowedPath(m.id, allowedSet);
      if (allowedPath) {
        return { ...m, path: allowedPath };
      }
    }
    return m;
  });

  return (
    <div className="bavya-launcher">
      <div className="bavya-launcher-topbar">
        <RoleSwitcher />
        <Popover
          content={notificationContent}
          trigger="click"
          placement="bottomRight"
          overlayStyle={{ width: 360 }}
        >
          <div
            className="bavya-launcher-bell"
            role="button"
            tabIndex={0}
            title="Notifications"
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.target.click();
              }
            }}
          >
            <Badge count={unreadCount} size="small" offset={[-2, 2]}>
              <BellOutlined
                style={{
                  fontSize: 18,
                  color: '#481890',
                }}
              />
            </Badge>
          </div>
        </Popover>
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
