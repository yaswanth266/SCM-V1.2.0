export const STATUS_COLORS = {
  draft: '#8c8c8c',
  pending: '#fa8c16',
  pending_approval: '#fa8c16',
  approved: '#52c41a',
  rejected: '#f5222d',
  in_progress: '#eb2f96',
  completed: '#52c41a',
  cancelled: '#8c8c8c',
  active: '#52c41a',
  inactive: '#8c8c8c',
  open: '#eb2f96',
  closed: '#8c8c8c',
  partial: '#fa8c16',
  received: '#52c41a',
  dispatched: '#eb2f96',
  delivered: '#52c41a',
  returned: '#fa541c',
  on_hold: '#faad14',
  in_transit: '#eb2f96',
  inspecting: '#722ed1',
  accepted: '#52c41a',
  failed: '#f5222d',
  short: '#fa8c16',
  excess: '#fa541c',
  damaged: '#f5222d',
  paid: '#52c41a',
  unpaid: '#f5222d',
  partially_paid: '#fa8c16',
  overdue: '#f5222d',
  partially_ordered: '#fa8c16',
  ordered: '#eb2f96',
  partially_received: '#fa8c16',
  expired: '#8c8c8c',
  confirmed: '#eb2f96',
  picking: '#722ed1',
  picked: '#52c41a',
  packing: '#fa8c16',
  packed: '#52c41a',
  wave_assigned: '#eb2f96',
  loading: '#fa8c16',
  loaded: '#52c41a',
  skipped: '#8c8c8c',
  released: '#eb2f96',
  // Priority levels
  low: '#52c41a',
  normal: '#8c8c8c',
  medium: '#fa8c16',
  high: '#fa541c',
  critical: '#f5222d',
  // Document / invoice types
  purchase: '#1677ff',
  sales: '#52c41a',
  // Indent types
  internal: '#722ed1',
  emergency: '#f5222d',
  replenishment: '#fa8c16',
  routine: '#52c41a',
};

export const STATUS_LABELS = {
  draft: 'Draft',
  pending: 'Pending',
  pending_approval: 'Pending Approval',
  approved: 'Approved',
  rejected: 'Rejected',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  active: 'Active',
  inactive: 'Inactive',
  open: 'Open',
  closed: 'Closed',
  partial: 'Partial',
  received: 'Received',
  dispatched: 'Dispatched',
  delivered: 'Delivered',
  returned: 'Returned',
  on_hold: 'On Hold',
  in_transit: 'In Transit',
  inspecting: 'Inspecting',
  accepted: 'Accepted',
  failed: 'Failed',
  short: 'Short',
  excess: 'Excess',
  damaged: 'Damaged',
  paid: 'Paid',
  unpaid: 'Unpaid',
  partially_paid: 'Partially Paid',
  overdue: 'Overdue',
  partially_ordered: 'Partially Ordered',
  ordered: 'Ordered',
  partially_received: 'Partially Received',
  expired: 'Expired',
  confirmed: 'Confirmed',
  picking: 'Picking',
  picked: 'Picked',
  packing: 'Packing',
  packed: 'Packed',
  wave_assigned: 'Wave Assigned',
  loading: 'Loading',
  loaded: 'Loaded',
  skipped: 'Skipped',
  released: 'Released',
  // Priority levels
  low: 'Low',
  normal: 'Normal',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
  // Document / invoice types
  purchase: 'Purchase',
  sales: 'Sales',
  // Indent types
  internal: 'Internal',
  emergency: 'Emergency',
  replenishment: 'Replenishment',
  routine: 'Routine',
};

export const MODULES = {
  DASHBOARD: 'dashboard',
  MASTERS: 'masters',
  PROCUREMENT: 'procurement',
  WAREHOUSE: 'warehouse',
  INVENTORY: 'inventory',
  INDENT: 'indent',
  CONSUMPTION: 'consumption',
  APPROVALS: 'approvals',
  ACCOUNTS: 'accounts',
  ASSETS: 'assets',
  REPORTS: 'reports',
  SETTINGS: 'settings',
};

export const ACTIONS = {
  VIEW: 'view',
  CREATE: 'create',
  EDIT: 'edit',
  DELETE: 'delete',
  APPROVE: 'approve',
  EXPORT: 'export',
  PRINT: 'print',
};

export const TAX_TYPES = [
  { label: 'CGST', value: 'cgst' },
  { label: 'SGST', value: 'sgst' },
  { label: 'IGST', value: 'igst' },
  { label: 'Exempt', value: 'exempt' },
];

export const TAX_RATES = [0, 5, 12, 18, 28];

export const ITEM_OWNERSHIP = [
  { label: 'Owned', value: 'owned' },
  { label: 'Consignment', value: 'consignment' },
  { label: 'Third Party', value: 'third_party' },
];

export const BARCODE_TYPES = [
  { label: 'IT', value: 'IT' },
  { label: 'HR', value: 'HR' },
  { label: 'OP (Operations)', value: 'OP' },
  { label: 'ADM (Administration)', value: 'ADM' },
  { label: 'FA (Finance & Accounts)', value: 'FA' },
  { label: 'FL (Facilities)', value: 'FL' },
];

export const PICKING_STRATEGIES = [
  { label: 'FIFO (First In First Out)', value: 'FIFO' },
  { label: 'LIFO (Last In First Out)', value: 'LIFO' },
  { label: 'FEFO (First Expiry First Out)', value: 'FEFO' },
];

export const PAYMENT_MODES = [
  { label: 'Bank Transfer', value: 'bank_transfer' },
  { label: 'Cheque', value: 'cheque' },
  { label: 'Cash', value: 'cash' },
  { label: 'Credit Card', value: 'credit_card' },
  { label: 'UPI', value: 'upi' },
  { label: 'DD', value: 'dd' },
];

export const ASSET_CATEGORIES = [
  { label: 'IT Equipment', value: 'it' },
  { label: 'Medical Equipment', value: 'medical' },
  { label: 'Fixed Assets', value: 'fixed' },
  { label: 'Furniture', value: 'furniture' },
  { label: 'Vehicles', value: 'vehicles' },
  { label: 'Machinery', value: 'machinery' },
];

export const MOVEMENT_TYPES = [
  { label: 'Transfer', value: 'transfer' },
  { label: 'Assign', value: 'assign' },
  { label: 'Return', value: 'return' },
  { label: 'Maintenance', value: 'maintenance' },
  { label: 'Dispose', value: 'dispose' },
];

export const DATE_FORMAT = 'DD/MM/YYYY';
export const DATETIME_FORMAT = 'DD/MM/YYYY HH:mm';
export const API_DATE_FORMAT = 'YYYY-MM-DD';

export const MENU_CONFIG = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    icon: 'DashboardOutlined',
    path: '/dashboard',
  },
  {
    key: 'masters',
    label: 'Masters',
    icon: 'DatabaseOutlined',
    children: [
      { key: 'masters-items', label: 'Items', path: '/masters/items' },
      { key: 'masters-categories', label: 'Categories', path: '/masters/categories' },
      { key: 'masters-brands', label: 'Brands', path: '/masters/brands' },
      { key: 'masters-features', label: 'Features', path: '/masters/features' },
      { key: 'masters-item-types', label: 'Item Types', path: '/masters/item-types' },
      { key: 'masters-item-attributes', label: 'Attributes', path: '/masters/item-attributes' },
      { key: 'masters-attribute-mapping', label: 'Attribute Mapping', path: '/masters/category-attribute-mapping' },
      { key: 'masters-specs', label: 'Specs', path: '/masters/specs' },
      { key: 'masters-vendors', label: 'Vendors', path: '/masters/vendors' },
      { key: 'masters-vendor-material-mapping', label: 'Vendor Material Mapping', path: '/masters/vendor-material-mapping' },
      { key: 'masters-user-material-mapping', label: 'User Material Mapping', path: '/masters/user-material-mapping' },
      { key: 'masters-warehouses', label: 'Warehouses', path: '/masters/warehouses' },
      { key: 'masters-uom', label: 'UOM', path: '/masters/uom' },
      { key: 'masters-packaging', label: 'Packaging', path: '/masters/packaging' },
      { key: 'masters-price-lists', label: 'Price Lists', path: '/masters/price-lists' },
      { key: 'masters-users', label: 'Users', path: '/masters/users' },
      { key: 'masters-user-groups', label: 'User Groups', path: '/masters/user-groups' },
      { key: 'masters-organization-structure', label: 'Org Structure', path: '/masters/organization-structure' },
    ],
  },
  {
    key: 'procurement',
    label: 'Procurement',
    icon: 'ShoppingCartOutlined',
    children: [
      { key: 'procurement-material-requests', label: 'Material Requests', path: '/procurement/material-requests' },
      { key: 'procurement-quotations', label: 'RFQs', path: '/procurement/quotations' },
      { key: 'procurement-purchase-orders', label: 'Purchase Orders', path: '/procurement/purchase-orders' },
    ],
  },
  {
    key: 'warehouse',
    label: 'Warehouse',
    icon: 'HomeOutlined',
    children: [
      { key: 'warehouse-material-inward', label: 'Material Inward', path: '/warehouse/material-inward' },
      { key: 'warehouse-gate-entry', label: 'Gate Entry', path: '/warehouse/gate-entry' },
      { key: 'warehouse-grn', label: 'GRN', path: '/warehouse/grn' },
      { key: 'warehouse-quality-inspection', label: 'Quality Inspection', path: '/warehouse/quality-inspection' },
      { key: 'warehouse-putaway', label: 'Putaway', path: '/warehouse/putaway' },
      { key: 'warehouse-purchase-returns', label: 'Purchase Returns', path: '/warehouse/purchase-returns' },
      { key: 'warehouse-material-issues', label: 'Material Issues', path: '/warehouse/material-issues' },
    ],
  },
  {
    key: 'logistics',
    label: 'Logistics',
    icon: 'CarOutlined',
    children: [
      { key: 'logistics-dashboard', label: 'Overview', path: '/logistics/dashboard' },
      { key: 'logistics-master', label: 'Master Data', path: '/logistics/master' },
      { key: 'logistics-dispatch', label: 'Dispatch Plans', path: '/logistics/dispatch' },
      { key: 'logistics-rfq', label: 'RFQ Bidding', path: '/logistics/rfq' },
      { key: 'logistics-so', label: 'Service Orders', path: '/logistics/so' },
    ],
  },
  {
    key: 'inventory',
    label: 'Inventory',
    icon: 'AppstoreOutlined',
    children: [
      { key: 'inventory-stock-balance', label: 'Stock Balance', path: '/inventory/stock-balance' },
      { key: 'inventory-stock-ledger', label: 'Stock Ledger', path: '/inventory/stock-ledger' },
      { key: 'inventory-stock-transfer', label: 'Stock Transfer', path: '/inventory/stock-transfer' },
      { key: 'inventory-stock-audit', label: 'Stock Audit', path: '/inventory/stock-audit' },
      { key: 'inventory-replenishment', label: 'Replenishment', path: '/inventory/replenishment' },
    ],
  },
  {
    key: 'indent',
    label: 'Indent',
    icon: 'FileTextOutlined',
    children: [
      { key: 'indent-indents', label: 'Indents', path: '/indent/indents' },
      { key: 'indent-acknowledgement', label: 'Acknowledgement', path: '/indent/acknowledgement' },
    ],
  },
  {
    key: 'consumption',
    label: 'Consumption',
    icon: 'PieChartOutlined',
    children: [
      { key: 'consumption-entry', label: 'Consumption Entry', path: '/consumption/entry' },
      { key: 'consumption-reports', label: 'Consumption Reports', path: '/consumption/reports' },
    ],
  },
  {
    key: 'approvals',
    label: 'Approvals',
    icon: 'CheckCircleOutlined',
    children: [
      { key: 'approvals-pending', label: 'Pending Approvals', path: '/approvals/pending' },
      { key: 'approvals-workflow-config', label: 'Workflow Config', path: '/approvals/workflow-config' },
    ],
  },
  {
    key: 'accounts',
    label: 'Accounts',
    icon: 'DollarOutlined',
    children: [
      { key: 'accounts-invoices', label: 'Invoices', path: '/accounts/invoices' },
      { key: 'accounts-payments', label: 'Payments', path: '/accounts/payments' },
      { key: 'accounts-ledger', label: 'Ledger', path: '/accounts/ledger' },
      { key: 'accounts-credit-notes', label: 'Credit Notes', path: '/accounts/credit-notes' },
    ],
  },
  {
    key: 'assets',
    label: 'Assets',
    icon: 'ToolOutlined',
    children: [
      { key: 'assets-register', label: 'Asset Register', path: '/assets/register' },
      { key: 'assets-movement', label: 'Asset Movement', path: '/assets/movement' },
    ],
  },
  {
    key: 'healthcare',
    label: 'Healthcare SCM',
    icon: 'MedicineBoxOutlined',
    children: [
      { key: 'healthcare-dashboard', label: 'Healthcare Dashboard', path: '/healthcare' },
    ],
  },
  {
    key: 'reports',
    label: 'Reports',
    icon: 'BarChartOutlined',
    children: [
      { key: 'reports-inventory', label: 'Inventory', path: '/reports/inventory' },
      { key: 'reports-procurement', label: 'Procurement', path: '/reports/procurement' },
      { key: 'reports-consumption', label: 'Consumption', path: '/reports/consumption' },
      { key: 'reports-accounts', label: 'Accounts', path: '/reports/accounts' },
      { key: 'reports-system', label: 'System', path: '/reports/system' },
    ],
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: 'SettingOutlined',
    children: [
      { key: 'settings-users', label: 'Users', path: '/settings/users' },
      { key: 'settings-roles', label: 'Roles & Permissions', path: '/settings/roles' },
      { key: 'settings-system', label: 'System Settings', path: '/settings/system' },
    ],
  },
];
