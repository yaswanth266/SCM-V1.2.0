// Module-aware top navigation — each route prefix maps to a module with
// horizontal tabs that replace the legacy left sidebar.
// Order matters: longest prefix first when matching.

export const MODULE_NAVS = {
  masters: {
    label: 'Masters',
    matchPrefix: '/masters',
    color: '#481890',
    tabs: [
      { label: 'Items',         path: '/masters/items' },
      { label: 'Packaging',     path: '/masters/packaging' },
      { label: 'Categories',    path: '/masters/categories' },
      { label: 'Vendors',       path: '/masters/vendors' },
      { label: 'Vendor Mapping', path: '/masters/vendor-material-mapping' },
      { label: 'User Mapping',  path: '/masters/user-material-mapping' },
      { label: 'Warehouses',    path: '/masters/warehouses' },
      { label: 'UOM',           path: '/masters/uom' },
      { label: 'Brands',        path: '/masters/brands' },
      { label: 'Features',      path: '/masters/features' },
      { label: 'Item Types',    path: '/masters/item-types' },
      { label: 'Attributes',    path: '/masters/item-attributes' },
      { label: 'Attribute Mapping', path: '/masters/category-attribute-mapping' },
      { label: 'Specs',         path: '/masters/specs' },
      { label: 'Users',         path: '/masters/users' },
      { label: 'User Groups',   path: '/masters/user-groups' },
      { label: 'Org Structure', path: '/masters/organization-structure' },
      { label: 'Price Lists',   path: '/masters/price-lists' },
    ],
  },
  procurement: {
    label: 'Procurement',
    matchPrefix: '/procurement',
    color: '#D80048',
    tabs: [
      { label: 'Demand Pool',       path: '/procurement/demand-pool' },
      { label: 'MR List',           path: '/procurement/material-requests' },
      { label: 'MR Board',          path: '/procurement/material-requests/kanban' },
      { label: 'RFQs',              path: '/procurement/quotations' },
      { label: 'Compare RFQs',      path: '/procurement/quotation-comparison' },
      { label: 'Purchase Orders',   path: '/procurement/purchase-orders' },
    ],
  },
  warehouse: {
    label: 'Warehouse',
    matchPrefix: '/warehouse',
    color: '#F09000',
    tabs: [
      { label: 'Floor Plan',          path: '/warehouse/floor-plan' },
      { label: '3D View',             path: '/warehouse/floor-plan-3d' },
      { label: 'Material Inward',     path: '/warehouse/material-inward' },
      { label: 'GRN',                 path: '/warehouse/grn' },
      { label: 'Quality Inspection',  path: '/warehouse/quality-inspection' },
      { label: 'Putaway',             path: '/warehouse/putaway' },
      { label: 'Material Issues',     path: '/warehouse/material-issues' },
      { label: 'Purchase Returns',    path: '/warehouse/purchase-returns' },
    ],
  },
  logistics: {
    label: 'Logistics',
    matchPrefix: '/logistics',
    color: '#096dd9',
    tabs: [
      { label: 'Overview', path: '/logistics/dashboard' },
      { label: 'Master Data', path: '/logistics/master' },
      { label: 'Dispatch Plans', path: '/logistics/dispatch' },
      { label: 'RFQ Bidding', path: '/logistics/rfq' },
      { label: 'Service Orders', path: '/logistics/so' },
      { label: 'Gating Checkpoints', path: '/logistics/so-gating' },
      { label: 'Acknowledge Delivery', path: '/logistics/so-acknowledge' },
    ],
  },
  inventory: {
    label: 'Inventory',
    matchPrefix: '/inventory',
    color: '#900078',
    tabs: [
      { label: 'Stock Balance',   path: '/inventory/stock-balance' },
      { label: 'Stock Ledger',    path: '/inventory/stock-ledger' },
      { label: 'Stock Transfer',  path: '/inventory/stock-transfer' },
      { label: 'Stock Audit',     path: '/inventory/stock-audit' },
      { label: 'Replenishment',   path: '/inventory/replenishment' },
    ],
  },

  indent: {
    label: 'Indent',
    matchPrefix: '/indent',
    color: '#481890',
    tabs: [
      { label: 'List',            path: '/indent/indents' },
      { label: 'Board',           path: '/indent/indents/kanban',
        hideForRoles: ['field_staff', 'field_supervisor'] },
      { label: 'Acknowledgement', path: '/indent/acknowledgement' },
    ],
  },
  consumption: {
    label: 'Consumption',
    matchPrefix: '/consumption',
    color: '#D80048',
    tabs: [
      { label: 'Entries', path: '/consumption/entry' },
      { label: 'Reports', path: '/consumption/reports' },
    ],
  },
  approvals: {
    label: 'Approvals',
    matchPrefix: '/approvals',
    color: '#900078',
    tabs: [
      { label: 'Pending',         path: '/approvals/pending' },
      { label: 'SLA Breaches',    path: '/approvals/sla-breaches',
        hideForRoles: ['field_staff', 'field_supervisor', 'project_manager',
                       'warehouse_manager', 'warehouse_operator', 'store_keeper',
                       'purchase_manager', 'purchase_officer'] },
      { label: 'Workflow Config', path: '/approvals/workflow-config',
        hideForRoles: ['field_staff', 'field_supervisor', 'project_manager',
                       'warehouse_manager', 'warehouse_operator', 'store_keeper',
                       'purchase_manager', 'purchase_officer'] },
      { label: 'Business Rules',  path: '/approvals/business-rules',
        hideForRoles: ['field_staff', 'field_supervisor', 'project_manager',
                       'warehouse_manager', 'warehouse_operator', 'store_keeper',
                       'purchase_manager', 'purchase_officer'] },
    ],
  },
  accounts: {
    label: 'Accounts',
    matchPrefix: '/accounts',
    color: '#F09000',
    tabs: [
      { label: 'Chart of Accounts', path: '/accounts/coa' },
      { label: 'Account Mappings',  path: '/accounts/mappings' },
      { label: 'Invoices',          path: '/accounts/invoices' },
      { label: 'Payments',          path: '/accounts/payments' },
      { label: 'Credit Notes',      path: '/accounts/credit-notes' },
      { label: 'Ledger',            path: '/accounts/ledger' },
      { label: 'Financial Reports', path: '/accounts/reports' },
    ],
  },
  assets: {
    label: 'Assets',
    matchPrefix: '/assets',
    color: '#481890',
    tabs: [
      { label: 'Asset Register', path: '/assets/register' },
      { label: 'Asset Movement', path: '/assets/movement' },
    ],
  },
  reports: {
    label: 'Reports',
    matchPrefix: '/reports',
    color: '#481890',
    tabs: [
      { label: 'Builder',     path: '/reports/builder' },
      { label: 'Inventory',   path: '/reports/inventory' },
      { label: 'Procurement', path: '/reports/procurement' },
      { label: 'Consumption', path: '/reports/consumption' },
    ],
  },
  settings: {
    label: 'Settings',
    matchPrefix: '/settings',
    color: '#7A6D66',
    tabs: [
      { label: 'Profile',         path: '/settings/profile' },
      { label: 'Change Password', path: '/settings/change-password' },
      { label: 'Delegations',     path: '/settings/delegations' },
      { label: 'Users',           path: '/settings/users' },
      { label: 'Roles',           path: '/settings/roles' },
      { label: 'System Settings', path: '/settings/system' },
      { label: 'API Keys',        path: '/settings/api-keys' },
    ],
  },
  healthcare: {
    label: 'Healthcare SCM',
    matchPrefix: '/healthcare',
    color: '#D80048',
    tabs: [
      { label: 'Healthcare Dashboard', path: '/healthcare' },
    ],
  },
  compliance: {
    label: 'Compliance',
    matchPrefix: '/compliance',
    color: '#D80048',
    tabs: [
      { label: 'Dashboard', path: '/compliance' },
    ],
  },
  documents: {
    label: 'Documents',
    matchPrefix: '/documents',
    color: '#481890',
    tabs: [
      { label: 'Documents',        path: '/documents' },
      { label: 'Templates',        path: '/documents?tab=tpl' },
      { label: 'Transition Rules', path: '/documents?tab=rules' },
    ],
  },
  mrp: {
    label: 'MRP',
    matchPrefix: '/mrp',
    color: '#900078',
    tabs: [
      { label: 'Dashboard', path: '/mrp' },
    ],
  },
  alerts: {
    label: 'Alerts',
    matchPrefix: '/alerts',
    color: '#D80048',
    tabs: [
      { label: 'Dashboard', path: '/alerts' },
    ],
  },
  dashboard: {
    label: 'Dashboard',
    matchPrefix: '/dashboard',
    color: '#D80048',
    tabs: [
      { label: 'Overview', path: '/dashboard' },
    ],
  },
};

const MODULE_LIST = Object.values(MODULE_NAVS).sort(
  (a, b) => b.matchPrefix.length - a.matchPrefix.length,
);

export function moduleForPath(pathname) {
  // Strict prefix match — `/inventory` must NOT match `/inventory-anything`.
  return (
    MODULE_LIST.find(
      (m) => pathname === m.matchPrefix || pathname.startsWith(m.matchPrefix + '/'),
    ) || null
  );
}

export function activeTabForPath(mod, pathname) {
  if (!mod) return null;
  // Prefer the longest tab path that is a prefix of the current path
  const sorted = [...mod.tabs].sort((a, b) => b.path.length - a.path.length);
  return sorted.find((t) => pathname.startsWith(t.path)) || mod.tabs[0];
}
