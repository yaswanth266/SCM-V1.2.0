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
import RoleSwitcher from '../components/RoleSwitcher';

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
const _ADMIN_ONLY_PARENT_KEYS = new Set(['settings']);

// Top-level menus that field staff / field_supervisor should never see —
// these are master-data setup pages aimed at procurement / store
// managers. Field users have indent.create + consumption + inventory.view
// (stock_balance) and that's the full scope of what they need on the
// menu. The DB still grants them masters.view (items) for *referential*
// reads (e.g. picking an item in the indent form), but the menu entry
// itself stays hidden so they don't navigate into a near-empty admin
// area.
const _FIELD_HIDE_PARENT_KEYS = new Set([
  'masters',
  'procurement',
  'warehouse',
  'accounts',
  'assets',
  'reports',
  'healthcare',
  'approvals', // field_staff has no approve perm; field_supervisor sees via launcher tile (kept by manager check below)
]);

// Field-user role codes — when a user holds ONLY these (and nothing
// manager-grade or admin), the parent-key restriction above kicks in.
const _FIELD_ROLE_CODES = new Set([
  'field_staff',
  'field_supervisor',
  'field_user',
  'field_operator',
  'nurse',
  'pharmacy_assistant',
  'site_user',
]);

// Child menu keys that require admin / super_admin regardless of any
// module-level "view" grant on a non-admin role. Hyphenated form matches
// MENU_CONFIG keys exactly (earlier code used underscores by mistake, so
// the gate never fired). Includes Settings sub-pages, workflow config,
// and the System reports tab.
const _ADMIN_ONLY_CHILD_KEYS = new Set([
  'settings-users',
  'settings-roles',
  'settings-system',
  'approvals-workflow-config',
  'reports-system',
  // Masters config that drives RBAC / item-attribute schema — admin-only.
  'masters-users',
  'masters-user-groups',
  'masters-organization-structure',
  'masters-item-attributes',
  'masters-specs',
]);

// Child menu keys that should be visible only to manager-grade roles or
// admins. Field staff with module-level `view` permission should still
// see the entry point of a module (e.g. Inventory → Stock Balance) but
// not sub-pages that drive operational changes (transfer, audit,
// replenishment) or expose financial/historical detail (ledger).
// Add new keys here when reports show field-staff users seeing
// manager-only sub-pages.
const _MANAGER_ONLY_CHILD_KEYS = new Set([
  // Inventory: field staff can access Stock Balance and Stock Ledger (scoped to their warehouses).
  'inventory-stock-transfer',
  'inventory-stock-audit',
  'inventory-replenishment',
  // Warehouse: field staff sees gate entry only (intake), not the
  // downstream operational pages.
  'warehouse-quality-inspection',
  'warehouse-putaway',
  'warehouse-purchase-returns',
  // Procurement: field staff can raise material requests; quotations
  // and POs are manager-grade.
  'procurement-quotations',
  'procurement-purchase-orders',
  // Accounts: full module is manager-grade. Children below + the
  // module-level perm check handle visibility.
  'accounts-invoices',
  'accounts-payments',
  'accounts-ledger',
  'accounts-credit-notes',
  // Approvals: pending list is fine; workflow config is admin-only
  // (already in _ADMIN_ONLY_CHILD_KEYS).
  // Masters: field staff sees Items + Warehouses (read). Brands,
  // Categories, Vendors, UOM, Price Lists are master-data setup —
  // manager-grade.
  'masters-categories',
  'masters-brands',
  'masters-features',
  'masters-vendors',
  'masters-vendor-material-mapping',
  'masters-user-material-mapping',
  'masters-uom',
  'masters-packaging',
  'masters-price-lists',
]);

const _MANAGER_ROLE_CODES = new Set([
  'super_admin',
  'admin',
  'procurement_manager',
  'store_manager',
  'warehouse_manager',
  'inventory_manager',
  'accounts_manager',
  'finance_manager',
  'compliance_manager',
  'project_manager',
  'manager',
  'pharmacy_manager',
  'qa_manager',
]);

const _isAdminUser = (hasPermission) => {
  // hasPermission in authStore short-circuits to true for super_admin / admin
  // role codes, so any privileged check (e.g. a synthetic module that no
  // regular role grants) returns true ONLY for admins. Use a sentinel.
  return hasPermission('__admin_only__', 'manage');
};

const _isManagerUser = (user, hasPermission) => {
  if (_isAdminUser(hasPermission)) return true;
  const codes = (user?.roles || []).map((r) => (r?.code || r?.role_code || '').toLowerCase());
  return codes.some((c) => _MANAGER_ROLE_CODES.has(c));
};

// True only if the user holds at least one field-role and NO manager /
// admin role. Field_supervisor counts as a field role but if they also
// hold (e.g.) warehouse_manager elsewhere, manager access wins.
const _isFieldOnlyUser = (user, hasPermission) => {
  if (_isAdminUser(hasPermission)) return false;
  if (_isManagerUser(user, hasPermission)) return false;
  const codes = (user?.roles || []).map((r) => (r?.code || r?.role_code || '').toLowerCase());
  return codes.length > 0 && codes.every((c) => _FIELD_ROLE_CODES.has(c));
};

const buildMenuItems = (config, hasPermission, user) => {
  const adminUser = _isAdminUser(hasPermission);
  const managerUser = _isManagerUser(user, hasPermission);
  const fieldOnlyUser = _isFieldOnlyUser(user, hasPermission);
  return config
    .filter((item) => {
      // Top-level admin-only items hidden from non-admin users entirely.
      if (_ADMIN_ONLY_PARENT_KEYS.has(item.key) && !adminUser) {
        return false;
      }
      // Field-only users get a stripped menu: Dashboard, Indent,
      // Consumption, Inventory (Stock Balance), LMS. Everything else
      // (Masters, Procurement, Warehouse ops, Logistics, Accounts,
      // Reports, etc.) is hidden because they have no operational use
      // for it. Approvals tile stays visible only for those holding
      // the Approve permission (handled by hasPermission below).
      if (fieldOnlyUser && _FIELD_HIDE_PARENT_KEYS.has(item.key)) {
        // approvals exception: field_supervisor needs to approve indents
        // at level 1 — keep the parent visible if they have the approve
        // permission.
        if (item.key === 'approvals' && hasPermission('approvals', 'approve')) {
          // fall through to permission check
        } else {
          return false;
        }
      }
      // Explicit override on the menu node.
      if (item.module) {
        return hasPermission(item.module, item.action || 'view');
      }
      const mod = item.key; // menu key matches module name (dashboard, masters, procurement, etc.)
      return hasPermission(mod, 'view');
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
            // Admin-only children: hidden from non-admin users.
            if (_ADMIN_ONLY_CHILD_KEYS.has(child.key)) {
              return adminUser;
            }
            // Manager-only children: hidden from field/operator users.
            if (_MANAGER_ONLY_CHILD_KEYS.has(child.key)) {
              return managerUser;
            }
            // Child can declare its own module/action override.
            if (child.module) {
              return hasPermission(child.module, child.action || 'view');
            }
            // Default: inherit parent module + child action (if any).
            return hasPermission(item.key, child.action || 'view');
          })
          .map((child) => ({ key: child.key, label: child.label }));
        if (filteredChildren.length === 0) {
          // Hide the parent entirely if all children were filtered out.
          return null;
        }
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
  return tabs.filter((t) => {
    // Per-tab role hide rule (e.g. Indent → Board hidden from field roles).
    if (Array.isArray(t.hideForRoles) && t.hideForRoles.some((r) => userRoleSet.has(r))) {
      return false;
    }
    if (!useServerKeys) return true;
    const parts = (t.path || '').split('/').filter(Boolean);
    if (parts.length < 2) return true;
    const derivedKey = `${parts[0]}-${parts[1]}`;
    if (derivedKey === 'masters-packaging' && (allowedSet.has('masters') || allowedSet.has('masters-items') || allowedSet.has('masters-uom'))) {
      return true;
    }
    if (derivedKey === 'masters-vendor-material-mapping' && (allowedSet.has('masters') || allowedSet.has('masters-vendors') || allowedSet.has('masters-items'))) {
      return true;
    }
    if (derivedKey === 'masters-user-material-mapping' && (allowedSet.has('masters') || allowedSet.has('settings-users') || allowedSet.has('masters-items'))) {
      return true;
    }
    if (derivedKey === 'masters-users' && allowedSet.has('settings-users')) {
      return true;
    }
    if (
      derivedKey === 'masters-organization-structure'
      && (allowedSet.has('settings-users') || allowedSet.has('masters-user-groups'))
    ) {
      return true;
    }
    // Personal / not-in-MENU_CONFIG paths always show.
    if (!_ALL_MENU_CHILD_KEYS.has(derivedKey)) return true;
    return allowedSet.has(derivedKey);
  });
};

const MainLayout = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, hasPermission } = useAuthStore();
  const allowedKeys = useAuthStore((s) => s.allowedKeys);
  const setSidebar = useAuthStore((s) => s.setSidebar);
  const { collapsed, toggleSidebar, notifications, unreadCount, markAllRead } =
    useAppStore();

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

  const notificationContent = (
    <div className="notification-dropdown">
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
      {notifications.length > 0 ? (
        <List
          dataSource={notifications.slice(0, 10)}
          renderItem={(item) => (
            <div
              className="notification-item"
              style={{
                background: item.read ? 'transparent' : '#e6f7ff',
              }}
            >
              <div className="notification-item-title">{item.title}</div>
              {item.description && (
                <div className="notification-item-desc">
                  {item.description}
                </div>
              )}
              {item.created_at && (
                <div className="notification-item-time">
                  {formatDateTime(item.created_at)}
                </div>
              )}
            </div>
          )}
        />
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No notifications"
          style={{ padding: 24 }}
        />
      )}
    </div>
  );

  const userName =
    user?.full_name || user?.username || 'User';

  const isLauncher = location.pathname === '/launcher';
  // Learning Center renders full-bleed like the launcher — no sider, no topbar
  const isLms = location.pathname.startsWith('/lms');
  const _rawModule = (isLauncher || isLms) ? null : moduleForPath(location.pathname);
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
  const showTopnav = inModule && currentModule.tabs.length > 1;
  const activeTab = currentModule
    ? activeTabForPath(currentModule, location.pathname)
    : null;

  // Hide the legacy left sidebar whenever we have a recognized module —
  // module-aware top nav (or a single-page module like Dashboard) replaces it.
  const hideSidebar = isLauncher || isLms || inModule;

  const layoutClass = [
    (isLauncher || isLms) ? 'bavya-launcher-mode' : '',
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
            <RoleSwitcher />
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
                const isActive = activeTab && t.path === activeTab.path;
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
