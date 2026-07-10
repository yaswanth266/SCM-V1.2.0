import React, { useState, useMemo, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { moduleForPath, activeTabForPath } from '../utils/moduleNavs';
import {
  Layout,
  Menu,
  Avatar,
  Dropdown,
  Badge,
  Breadcrumb,
  Popover,
  List,
  Typography,
  Button,
  Empty,
  Input,
  Tabs,
  Tag,
} from 'antd';
import {
  DashboardOutlined,
  DatabaseOutlined,
  ShoppingCartOutlined,
  HomeOutlined,
  ExportOutlined,
  AppstoreOutlined,
  CarOutlined,
  FileTextOutlined,
  PieChartOutlined,
  CheckCircleOutlined,
  DollarOutlined,
  ToolOutlined,
  BarChartOutlined,
  SettingOutlined,
  BellOutlined,
  UserOutlined,
  LogoutOutlined,
  LockOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MedicineBoxOutlined,
} from '@ant-design/icons';
import useAuthStore from '../store/authStore';
import useAppStore from '../store/appStore';
import { MENU_CONFIG } from '../utils/constants';
import { getInitials, formatDateTime } from '../utils/helpers';
import { fetchSidebar } from '../api/sidebar';


const { Header, Sider, Content } = Layout;
const { Text } = Typography;

const iconMap = {
  DashboardOutlined: <DashboardOutlined />,
  DatabaseOutlined: <DatabaseOutlined />,
  ShoppingCartOutlined: <ShoppingCartOutlined />,
  HomeOutlined: <HomeOutlined />,
  ExportOutlined: <ExportOutlined />,
  AppstoreOutlined: <AppstoreOutlined />,
  CarOutlined: <CarOutlined />,
  FileTextOutlined: <FileTextOutlined />,
  PieChartOutlined: <PieChartOutlined />,
  CheckCircleOutlined: <CheckCircleOutlined />,
  DollarOutlined: <DollarOutlined />,
  ToolOutlined: <ToolOutlined />,
  BarChartOutlined: <BarChartOutlined />,
  SettingOutlined: <SettingOutlined />,
  MedicineBoxOutlined: <MedicineBoxOutlined />,
};

// BUG-AUTH-128/129 fix: previously buildMenuItems only filtered top-level
// modules. The Settings parent has children (Users, Roles, System) that all
// share the `settings` module key but require strictly admin access — the
// old code showed those submenu items to anyone with `settings.view`. We
// now filter children using either an explicit child.module/child.action
// override or, for known privileged children, a role-based gate.
// Top-level menus that should be visible only to admin / super_admin codes.
const buildMenuItems = (config, hasPermission) => {
  return config
    .filter((item) => {
      if (item.module) {
        return hasPermission(item.module, item.action || 'view');
      }
      return hasPermission(item.key, 'view');
    })
    .map((item) => {
      const menuItem = {
        key: item.key,
        icon: iconMap[item.icon] || null,
        label: item.label,
      };
      if (item.children && item.children.length > 0) {
        const filteredChildren = item.children
          .filter((child) => {
            if (child.module) {
              return hasPermission(child.module, child.action || 'view');
            }
            return hasPermission(item.key, child.action || 'view');
          })
          .map((child) => ({ key: child.key, label: child.label }));
        if (filteredChildren.length === 0) return null;
        menuItem.children = filteredChildren;
      }
      return menuItem;
    })
    .filter(Boolean);
};

const buildPathMap = (config) => {
  const map = {};
  config.forEach((item) => {
    if (item.path) {
      map[item.key] = item.path;
    }
    if (item.children) {
      item.children.forEach((child) => {
        if (child.path) {
          map[child.key] = child.path;
        }
      });
    }
  });
  return map;
};

const buildKeyFromPath = (config, pathname) => {
  // BUG-FE-091: previously startsWith short-circuited based on iteration
  // order — `/masters` and `/masters/items` could both match and the last
  // wrote-wins. Pick the LONGEST prefix match for deterministic behaviour.
  let selectedKey = '';
  let openKey = '';
  let bestLen = -1;
  config.forEach((item) => {
    if (item.path && pathname.startsWith(item.path) && item.path.length > bestLen) {
      selectedKey = item.key;
      openKey = '';
      bestLen = item.path.length;
    }
    if (item.children) {
      item.children.forEach((child) => {
        if (child.path && pathname.startsWith(child.path) && child.path.length > bestLen) {
          selectedKey = child.key;
          openKey = item.key;
          bestLen = child.path.length;
        }
      });
    }
  });
  return { selectedKey, openKey };
};

const buildBreadcrumb = (config, pathname) => {
  // BUG-FE-090: previously parent was pushed twice when both the parent's
  // path and a child's path matched startsWith. Build by precedence: prefer a
  // child match, otherwise parent-only.
  for (const item of config) {
    if (item.children) {
      for (const child of item.children) {
        if (child.path && pathname.startsWith(child.path)) {
          return [{ title: item.label }, { title: child.label }];
        }
      }
    }
    if (item.path && pathname === item.path) {
      return [{ title: item.label }];
    }
  }
  // Fallback: longest-prefix parent match (e.g. /masters with no child path)
  for (const item of config) {
    if (item.path && pathname.startsWith(item.path)) {
      return [{ title: item.label }];
    }
  }
  return [{ title: 'Home' }];
};

// Task 7 (revised 2026-05-01): server returns a flat allowed-keys whitelist;
// we keep the existing MENU_CONFIG visual tree (matches scm.bhspl.in look)
// and just hide nodes whose key isn't in the whitelist. A parent stays
// visible iff at least one of its allowed children survives.
const buildMenuFromAllowedKeys = (config, allowedSet) =>
  config
    .filter((item) => allowedSet.has(item.key))
    .map((item) => {
      const menuItem = {
        key: item.key,
        icon: iconMap[item.icon] || null,
        label: item.label,
      };
      if (item.children && item.children.length > 0) {
        const filteredChildren = item.children
          .filter((c) => allowedSet.has(c.key))
          .map((c) => ({ key: c.key, label: c.label }));
        if (filteredChildren.length === 0) return null;
        menuItem.children = filteredChildren;
      }
      return menuItem;
    })
    .filter(Boolean);

// 2026-05-03: when a user is *inside* a module (e.g. /settings/users), the
// MainLayout swaps the left sidebar for a top-nav row of tabs sourced from
// `moduleNavs.MODULE_NAVS[mod].tabs`. Those tabs are HARDCODED — independent
// of the sidebar's allowedKeys filter — so admin (whose sidebar correctly
// hides settings-system) still saw the "System Settings" tab in the top-nav
// and could click it, landing on a 403 page. Filter the tabs against the
// same allowedKeys whitelist used by the sidebar.
//
// Path-to-key derivation: split on '/', drop empties, take first 2 segments,
// join with '-'. /settings/system -> 'settings-system'. /reports/inventory ->
// 'reports-inventory'. Tabs whose derived key isn't in MENU_CONFIG (personal
// pages like /settings/profile, /settings/change-password) pass through
// untouched.
const _ALL_MENU_CHILD_KEYS = (() => {
  const s = new Set();
  for (const item of MENU_CONFIG) {
    if (item.children) for (const c of item.children) s.add(c.key);
  }
  return s;
})();

const filterModuleTabs = (tabs, allowedSet, useServerKeys, userRoleCodes = []) => {
  const userRoleSet = new Set(userRoleCodes);
  return tabs
    .map((t) => {
      // If the tab has children, filter them first
      if (t.children && t.children.length > 0) {
        const filteredChildren = filterModuleTabs(t.children, allowedSet, useServerKeys, userRoleCodes);
        if (filteredChildren.length === 0) {
          return null; // Hide parent if no children allowed
        }
        return { ...t, children: filteredChildren };
      }

      // Per-tab role hide rule (e.g. Indent → Board hidden from field roles).
      if (!useServerKeys && Array.isArray(t.hideForRoles) && t.hideForRoles.some((r) => userRoleSet.has(r))) {
        return null;
      }
      if (!useServerKeys) return t;
      const parts = (t.path || '').split('/').filter(Boolean);
      if (parts.length < 2) return t;
      const derivedKey = `${parts[0]}-${parts[1]}`;

      const PUBLIC_BYPASS_KEYS = new Set([
        'settings-profile',
        'settings-change-password',
      ]);
      if (PUBLIC_BYPASS_KEYS.has(derivedKey)) return t;

      // Handle 3-level paths (e.g. /inventory/masters/items -> inventory-masters-items)
      if (parts.length >= 3) {
        const fullDerivedKey = `${parts[0]}-${parts[1]}-${parts[2]}`;
        if (allowedSet.has(fullDerivedKey)) {
          return t;
        }
        // Legacy/Special fallback for 3-level paths
        const legacyKey = `${parts[1]}-${parts[2]}`;
        if (allowedSet.has(legacyKey)) {
          return t;
        }
        if (
          legacyKey === 'masters-organization-structure' &&
          (allowedSet.has('settings-users') || allowedSet.has('masters-user-groups'))
        ) {
          return t;
        }
        if (parts[2] === 'kanban' && allowedSet.has(`${parts[0]}-${parts[1]}`)) {
          return t;
        }
        return null; // Do NOT fall back to checking parent key like 'inventory-masters'
      }

      // Handle 2-level paths (e.g. /inventory/stock-balance -> inventory-stock-balance)
      if (derivedKey === 'masters-packaging' && (allowedSet.has('masters') || allowedSet.has('masters-items') || allowedSet.has('masters-uom'))) {
        return t;
      }
      if (derivedKey === 'masters-boms' && (allowedSet.has('masters') || allowedSet.has('masters-items'))) {
        return t;
      }
      if (derivedKey === 'masters-vendor-material-mapping' && (allowedSet.has('masters') || allowedSet.has('masters-vendors') || allowedSet.has('masters-items'))) {
        return t;
      }
      if (derivedKey === 'masters-user-material-mapping' && (allowedSet.has('masters') || allowedSet.has('settings-users') || allowedSet.has('masters-items'))) {
        return t;
      }
      if (derivedKey === 'masters-users' && allowedSet.has('settings-users')) {
        return t;
      }

      // Modularized keys support
      if (allowedSet.has(derivedKey)) {
        return t;
      }

      // Legacy master/reports key fallback
      if (parts[1] === 'masters') {
        const legacyKey = `masters-${parts[2]}`;
        if (allowedSet.has(legacyKey) || allowedSet.has(`${parts[0]}-masters`)) {
          return t;
        }
      }
      if (parts[1] === 'reports') {
        const legacyKey = `reports-${parts[0]}`;
        if (allowedSet.has(legacyKey) || allowedSet.has(`${parts[0]}-reports`)) {
          return t;
        }
      }

      return null;
    })
    .filter(Boolean);
};

const MainLayout = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, hasPermission } = useAuthStore();
  const allowedKeys = useAuthStore((s) => s.allowedKeys);
  const setSidebar = useAuthStore((s) => s.setSidebar);
  const { collapsed, toggleSidebar, notifications, unreadCount, markAllRead, fetchNotifications } =
    useAppStore();

  const [activeNotifTab, setActiveNotifTab] = useState('all');

  const handleNotificationClick = async (item) => {
    try {
      await api.post(`/notifications/${item.id}/read`);
      // Update store state
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

  // Task 7: hydrate the server-driven sidebar on mount. If the call fails
  // (offline, backend not yet on Task 6, etc.) we silently fall back to
  // the legacy client-built menu — sidebarItems stays empty and the
  // useServerMenu flag below picks the fallback path.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    fetchSidebar()
      .then((resp) => {
        if (!cancelled) setSidebar(resp);
      })
      .catch(() => {
        /* fallback to client-built menu — non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id, setSidebar]);

  useEffect(() => {
    if (!user?.id) return;
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30_000);
    return () => clearInterval(interval);
  }, [user?.id, fetchNotifications]);

  const useServerMenu = allowedKeys && allowedKeys.length > 0;
  const allowedSet = useMemo(
    () => new Set(allowedKeys || []),
    [allowedKeys]
  );

  const menuItems = useMemo(
    () =>
      useServerMenu
        ? buildMenuFromAllowedKeys(MENU_CONFIG, allowedSet)
        : buildMenuItems(MENU_CONFIG, hasPermission, user),
    [useServerMenu, allowedSet, user, hasPermission]
  );
  // Path map is always derived from MENU_CONFIG since paths are static and
  // the server only filters visibility, not URLs. Same map works for both
  // server and fallback menu sources.
  const pathMap = useMemo(() => buildPathMap(MENU_CONFIG), []);

  const { selectedKey, openKey } = useMemo(
    () => buildKeyFromPath(MENU_CONFIG, location.pathname),
    [location.pathname]
  );

  const [openKeys, setOpenKeys] = useState(openKey ? [openKey] : []);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Auto-collapse sidebar on mobile when navigating OR when the viewport
  // shrinks under the breakpoint (BUG-FE-089: previously only the route-
  // change effect handled this, leaving the sidebar open on real-time
  // resize from desktop -> mobile).
  useEffect(() => {
    if (isMobile && !collapsed) {
      toggleSidebar();
    }
  }, [location.pathname, isMobile]);

  const breadcrumbItems = useMemo(
    () => buildBreadcrumb(MENU_CONFIG, location.pathname),
    [location.pathname]
  );

  const handleMenuClick = ({ key }) => {
    const path = pathMap[key];
    if (path) {
      navigate(path);
    }
  };

  const handleOpenChange = (keys) => {
    setOpenKeys(keys);
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  // BUG-AUTH-130 fix: hide / disable Change Password for deactivated cached
  // sessions. Backend will 403 the action regardless, but the menu used to
  // surface the option without explanation.
  const isAccountActive = user?.is_active !== false;
  const userMenuItems = {
    items: [
      {
        key: 'profile',
        icon: <UserOutlined />,
        label: 'Profile',
        onClick: () => navigate('/settings/profile'),
      },
      {
        key: 'change-password',
        icon: <LockOutlined />,
        label: 'Change Password',
        disabled: !isAccountActive,
        onClick: () => {
          if (!isAccountActive) return;
          navigate('/settings/change-password');
        },
      },
      { type: 'divider' },
      {
        key: 'logout',
        icon: <LogoutOutlined />,
        label: 'Logout',
        danger: true,
        onClick: handleLogout,
      },
    ],
  };

  // Count calculations for tabs
  const allCount = notifications.filter(n => !n.read).length;
  const procurementCount = notifications.filter(n => !n.read && (n.module || '').toLowerCase() === 'procurement').length;
  const inventoryCount = notifications.filter(n => !n.read && (n.module || '').toLowerCase() === 'inventory').length;
  const warehouseCount = notifications.filter(n => !n.read && (n.module || '').toLowerCase() === 'warehouse').length;
  const indentCount = notifications.filter(n => !n.read && (n.module || '').toLowerCase() === 'indent').length;

  const filteredNotifications = useMemo(() => {
    if (activeNotifTab === 'all') return notifications;
    return notifications.filter(n => (n.module || '').toLowerCase() === activeNotifTab);
  }, [notifications, activeNotifTab]);

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

  const userName =
    user?.full_name || user?.username || 'User';

  const isLauncher = location.pathname === '/launcher';
  const _rawModule = isLauncher ? null : moduleForPath(location.pathname);
  // 2026-05-03: filter topnav tabs by the same server-driven allowedKeys
  // whitelist the sidebar uses, so admin (and every other role) only sees
  // tabs they're authorized to open. Without this, admin's topnav showed
  // "System Settings" / "Reports → System" because tabs were hardcoded.
  const userRoleCodesForTabs = useMemo(
    () => (user?.roles || []).map((r) => (r?.code || r?.role_code || '').toLowerCase()),
    [user],
  );
  const currentModule = useMemo(() => {
    if (!_rawModule) return null;
    const filteredTabs = filterModuleTabs(
      _rawModule.tabs || [], allowedSet, useServerMenu, userRoleCodesForTabs,
    );
    return { ..._rawModule, tabs: filteredTabs };
  }, [_rawModule, allowedSet, useServerMenu, userRoleCodesForTabs]);
  const inModule = !!currentModule;
  const showTopnav = inModule && currentModule.tabs.length >= 1;
  const activeTab = currentModule
    ? activeTabForPath(currentModule, location.pathname)
    : null;

  // Hide the legacy left sidebar whenever we have a recognized module —
  // module-aware top nav (or a single-page module like Dashboard) replaces it.
  const hideSidebar = isLauncher || inModule;

  const layoutClass = [
    isLauncher ? 'bavya-launcher-mode' : '',
    showTopnav ? 'bavya-topnav-mode' : '',
    hideSidebar ? 'bavya-no-sider' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Layout
      style={{ minHeight: '100vh' }}
      className={layoutClass}
    >
      {/* Mobile sidebar overlay */}
      {isMobile && !collapsed && !hideSidebar && (
        <div className="sidebar-overlay" onClick={toggleSidebar} />
      )}
      {/* Sider only mounts when there's no recognized module — saves render
         cost AND avoids the stranded margin gutter the perm-hidden Sider
         would otherwise leave behind. */}
      {!hideSidebar && (
        <Sider
          className={`erp-sider ${isMobile ? 'erp-sider--mobile' : ''}`}
          trigger={null}
          collapsible
          collapsed={isMobile ? true : collapsed}
          collapsedWidth={isMobile ? 0 : 80}
          width={256}
          breakpoint="lg"
          onBreakpoint={(broken) => {
            // BUG-FE-093: also un-collapse when the viewport widens past the
            // breakpoint, otherwise the sidebar stays collapsed forever after
            // a single shrink event.
            if (broken && !collapsed) {
              toggleSidebar();
            } else if (!broken && collapsed) {
              toggleSidebar();
            }
          }}
          style={isMobile ? {
            width: collapsed ? 0 : 256,
            minWidth: collapsed ? 0 : 256,
            maxWidth: collapsed ? 0 : 256,
            flex: `0 0 ${collapsed ? 0 : 256}px`,
          } : undefined}
        >
          <div className={`sider-logo ${collapsed ? 'sider-logo-collapsed' : ''}`}>
            {collapsed
              ? <h1>SCM</h1>
              : <img src="/bavya-lockup.png" alt="Bavya SCM" style={{ height: 44, objectFit: 'contain' }} />
            }
          </div>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[selectedKey]}
            openKeys={collapsed ? [] : openKeys}
            onOpenChange={handleOpenChange}
            onClick={handleMenuClick}
            items={menuItems}
          />
        </Sider>
      )}
      <Layout
        style={{
          marginLeft: hideSidebar ? 0 : (isMobile ? 0 : (collapsed ? 80 : 256)),
          transition: 'margin-left 0.2s',
        }}
      >
        <Header className="erp-header">
          <div className="erp-header-left">
            <span
              className="trigger-btn"
              onClick={toggleSidebar}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') toggleSidebar();
              }}
            >
              {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            </span>
            <span
              className="bavya-mark"
              onClick={() => navigate('/launcher')}
              role="button"
              style={{ cursor: 'pointer' }}
              title="Bavya SCM — home"
            >
              <img src="/bavya-mark.png" alt="Bavya" />
              <span className="wm">
                <b>BAVYA</b>
                <span>SCM</span>
              </span>
            </span>
            {!isMobile && <Breadcrumb className="erp-breadcrumb" items={breadcrumbItems} />}
          </div>
          <div className="erp-header-right">

            <Popover
              content={notificationContent}
              trigger="click"
              placement="bottomRight"
              overlayStyle={{ width: isMobile ? 300 : 360 }}
            >
              <Badge count={unreadCount} size="small">
                <BellOutlined
                  style={{
                    fontSize: 18,
                    cursor: 'pointer',
                    color: 'rgba(255,255,255,0.92)',
                  }}
                />
              </Badge>
            </Popover>
            <Dropdown menu={userMenuItems} trigger={['click']} placement="bottomRight">
              <div
                style={{
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <Avatar
                  size={36}
                  style={{ backgroundColor: '#eb2f96' }}
                  icon={<UserOutlined />}
                >
                  {getInitials(userName)}
                </Avatar>
                {!isMobile && !collapsed && (
                  <span
                    style={{
                      maxWidth: 120,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontWeight: 500,
                      color: 'rgba(255,255,255,0.92)',
                    }}
                  >
                    {userName}
                  </span>
                )}
              </div>
            </Dropdown>
          </div>
        </Header>
        {showTopnav && (
          <div
            className="bavya-topnav"
            style={{ '--mod-color': currentModule.color }}
          >
            <div className="bavya-topnav-modlabel">
              {currentModule.label}
            </div>
            <div className="bavya-topnav-tabs">
              {currentModule.tabs.map((t) => {
                const isChildActive = t.children && t.children.some((c) => location.pathname.startsWith(c.path));
                const isActive = (activeTab && t.path === activeTab.path) || isChildActive;
                if (t.children && t.children.length > 0) {
                  const menu = {
                    items: t.children.map((c) => ({
                      key: c.path,
                      label: c.label,
                      onClick: () => navigate(c.path),
                    })),
                  };
                  return (
                    <Dropdown key={t.label} menu={menu} trigger={['click', 'hover']}>
                      <button className={isActive ? 'active' : ''}>
                        {t.label} <span style={{ fontSize: '9px', marginLeft: '4px' }}>▼</span>
                      </button>
                    </Dropdown>
                  );
                }
                return (
                  <button
                    key={t.path}
                    className={isActive ? 'active' : ''}
                    onClick={() => navigate(t.path)}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <Content className="erp-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
};

export default MainLayout;
