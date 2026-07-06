// Module-aware top navigation — each route prefix maps to a module with
// Order matters: longest prefix first when matching.
export const MODULE_NAVS = {
  warehouse: {
    label: 'Warehouse',
    matchPrefix: '/warehouse',
    color: '#F09000',
    tabs: [
      { label: 'Dashboard', path: '/warehouse/dashboard' },
      {
        label: 'Masters',
        children: [
          { label: 'Warehouses', path: '/warehouse/masters/warehouses' },
          { label: 'Floor Plan', path: '/warehouse/masters/floor-plan' },
          { label: '3D View', path: '/warehouse/masters/floor-plan-3d' }
        ]
      },
      {
        label: 'Transactions',
        children: [
          { label: 'Material Inward', path: '/warehouse/material-inward' },
          { label: 'Gate Entry', path: '/warehouse/gate-entry' },
          { label: 'GRN', path: '/warehouse/grn' },
          { label: 'Quality Inspection', path: '/warehouse/quality-inspection' },
          { label: 'Putaway', path: '/warehouse/putaway' },
          { label: 'Material Issues', path: '/warehouse/material-issues' },
          { label: 'AP 104 DP / Consumables', path: '/warehouse/material-issues/ap104-consumables' },
          { label: 'AP 104 DP Install', path: '/warehouse/material-issues/ap104-install' },
          { label: 'Purchase Returns', path: '/warehouse/purchase-returns' }
        ]
      },
      { label: 'Reports', path: '/warehouse/reports' },
      { label: 'Notifications', path: '/warehouse/notifications' }
    ]
  },
  inventory: {
    label: 'Inventory',
    matchPrefix: '/inventory',
    color: '#900078',
    tabs: [
      { label: 'Dashboard', path: '/inventory/dashboard' },
      {
        label: 'Masters',
        children: [
          { label: 'Items', path: '/inventory/masters/items' },
          { label: 'Packaging', path: '/inventory/masters/packaging' },
          { label: 'Categories', path: '/inventory/masters/categories' },
          { label: 'Features', path: '/inventory/masters/features' },
          { label: 'User Mapping', path: '/inventory/masters/user-material-mapping' },
          { label: 'UOM', path: '/inventory/masters/uom' },
          { label: 'Brands', path: '/inventory/masters/brands' },
          { label: 'Item Classes', path: '/inventory/masters/item-types' },
          { label: 'Item Sub Classes', path: '/inventory/masters/item-sub-classes' },
          { label: 'Attributes', path: '/inventory/masters/item-attributes' },
          { label: 'Attribute Mapping', path: '/inventory/masters/category-attribute-mapping' },
          { label: 'Specs', path: '/inventory/masters/specs' },
          { label: 'BOM', path: '/inventory/masters/boms' },
          { label: 'Price Lists', path: '/inventory/masters/price-lists' },
          { label: 'AP 104 DP / Consumables', path: '/inventory/masters/ap104-consumables' },
          { label: 'AP 104 DP Install', path: '/inventory/masters/ap104-install' },
          { label: 'Vehicles', path: '/inventory/masters/vehicles' }
        ]

      },
      {
        label: 'Transactions',
        children: [
          { label: 'Stock Balance', path: '/inventory/stock-balance' },
          { label: 'Stock Ledger', path: '/inventory/stock-ledger' },
          { label: 'Stock Transfer', path: '/inventory/stock-transfer' },
          { label: 'Stock Audit', path: '/inventory/stock-audit' },
          { label: 'Replenishment', path: '/inventory/replenishment' }
        ]
      },
      { label: 'Reports', path: '/inventory/reports' },
      { label: 'Notifications', path: '/inventory/notifications' }
    ]
  },
  procurement: {
    label: 'Procurement',
    matchPrefix: '/procurement',
    color: '#D80048',
    tabs: [
      { label: 'Dashboard', path: '/procurement/dashboard' },
      {
        label: 'Masters',
        children: [
          { label: 'Vendors', path: '/procurement/masters/vendors' },
          { label: 'Vendor Mapping', path: '/procurement/masters/vendor-material-mapping' }
        ]
      },
      {
        label: 'Transactions',
        children: [
          { label: 'Demand Pool', path: '/procurement/demand-pool' },
          { label: 'MR List', path: '/procurement/material-requests' },
          { label: 'MR Board', path: '/procurement/material-requests/kanban' },
          { label: 'RFQs', path: '/procurement/quotations' },
          { label: 'Compare RFQs', path: '/procurement/quotation-comparison' },
          { label: 'Purchase Orders', path: '/procurement/purchase-orders' }
        ]
      },
      { label: 'Reports', path: '/procurement/reports' },
      { label: 'Notifications', path: '/procurement/notifications' }
    ]
  },
  indent: {
    label: 'Indent',
    matchPrefix: '/indent',
    color: '#481890',
    tabs: [
      { label: 'Dashboard', path: '/indent/dashboard' },
      {
        label: 'Transactions',
        children: [
          { label: 'List', path: '/indent/indents' },
          { label: 'Board', path: '/indent/indents/kanban', hideForRoles: ['field_staff', 'field_supervisor'] },
          { label: 'AP 104 DP / Consumables', path: '/indent/ap104-consumables' },
          { label: 'AP 104 DP Install', path: '/indent/ap104-install' },
          { label: 'Acknowledgement', path: '/indent/acknowledgement' }
        ]

      },
      { label: 'Reports', path: '/indent/reports' },
      { label: 'Notifications', path: '/indent/notifications' }
    ]
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
      { label: 'Consignments', path: '/logistics/consignments' },
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
      { label: 'Pending', path: '/approvals/pending' },
      {
        label: 'SLA Breaches', path: '/approvals/sla-breaches',
        hideForRoles: ['field_staff', 'field_supervisor', 'project_manager',
          'warehouse_manager', 'warehouse_operator', 'store_keeper',
          'purchase_manager', 'purchase_officer']
      },
      {
        label: 'Workflow Config', path: '/approvals/workflow-config',
        hideForRoles: ['field_staff', 'field_supervisor', 'project_manager',
          'warehouse_manager', 'warehouse_operator', 'store_keeper',
          'purchase_manager', 'purchase_officer']
      },
      {
        label: 'Business Rules', path: '/approvals/business-rules',
        hideForRoles: ['field_staff', 'field_supervisor', 'project_manager',
          'warehouse_manager', 'warehouse_operator', 'store_keeper',
          'purchase_manager', 'purchase_officer']
      },
    ],
  },
  accounts: {
    label: 'Accounts',
    matchPrefix: '/accounts',
    color: '#F09000',
    tabs: [
      { label: 'Chart of Accounts', path: '/accounts/coa' },
      { label: 'Account Mappings', path: '/accounts/mappings' },
      { label: 'Invoices', path: '/accounts/invoices' },
      { label: 'Payments', path: '/accounts/payments' },
      { label: 'Credit Notes', path: '/accounts/credit-notes' },
      { label: 'Ledger', path: '/accounts/ledger' },
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
      { label: 'Asset - Spare Mapping', path: '/assets/spare-mapping' },
    ],
  },
  settings: {
    label: 'Settings',
    matchPrefix: '/settings',
    color: '#7A6D66',
    tabs: [
      { label: 'Profile', path: '/settings/profile' },
      { label: 'Change Password', path: '/settings/change-password' },
      { label: 'Delegations', path: '/settings/delegations' },
      { label: 'Users', path: '/settings/users' },
      { label: 'Roles', path: '/settings/roles' },
      { label: 'System Settings', path: '/settings/system' },
      { label: 'API Keys', path: '/settings/api-keys' },
      {
        label: 'Masters',
        children: [
          { label: 'User Groups', path: '/settings/masters/user-groups' },
          { label: 'Org Structure', path: '/settings/masters/organization-structure' },
          { label: 'HR Sync', path: '/settings/masters/organization-structure/hr-sync' }
        ]
      },
      {
        label: 'Reports',
        children: [
          { label: 'Report Builder', path: '/settings/reports-v2' },
          { label: 'System Reports', path: '/settings/reports/system' }
        ]
      }
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
      { label: 'Documents', path: '/documents' },
      { label: 'Templates', path: '/documents?tab=tpl' },
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
  if (!mod || !Array.isArray(mod.tabs)) return null;
  const flatTabs = [];
  const collect = (list) => {
    for (const t of list) {
      if (t.path) flatTabs.push(t);
      if (Array.isArray(t.children)) collect(t.children);
    }
  };
  collect(mod.tabs);

  if (flatTabs.length === 0) return null;

  // Prefer the longest tab path that is a prefix of the current path
  const sorted = [...flatTabs].sort((a, b) => (b.path || '').length - (a.path || '').length);
  return sorted.find((t) => pathname.startsWith(t.path)) || flatTabs[0];
}
