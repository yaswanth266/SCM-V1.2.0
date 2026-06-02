import React, { Suspense, lazy, Component, useEffect, useState } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { Spin, Result, Button } from 'antd';
import useAuthStore from './store/authStore';
import useCarrierAuthStore from './store/carrierAuthStore';
import useVendorAuthStore from './store/vendorAuthStore';
import { MODULE_NAVS } from './utils/moduleNavs';

/* Layouts */
import AuthLayout from './layouts/AuthLayout';
import MainLayout from './layouts/MainLayout';

/* Eagerly loaded pages */
import Login from './pages/Login';

/* ROUTE-2 fix: ErrorBoundary resets on route change via key prop.
   Wrapping component passes location.pathname as key so the boundary
   remounts (and clears its error state) on every navigation. */
class ErrorBoundaryInner extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 48 }}>
          <Result
            status="error"
            title="Something went wrong"
            subTitle={this.state.error?.message || 'An unexpected error occurred'}
            extra={
              <Button type="primary" onClick={() => this.setState({ hasError: false, error: null })}>
                Try Again
              </Button>
            }
          />
        </div>
      );
    }
    return this.props.children;
  }
}

function ErrorBoundary({ children }) {
  const location = useLocation();
  return <ErrorBoundaryInner key={location.pathname}>{children}</ErrorBoundaryInner>;
}

/* Lazy loaded pages */
const Dashboard = lazy(() => import('./pages/Dashboard'));
const AppLauncher = lazy(() => import('./pages/AppLauncher'));

/* Masters */
const Items = lazy(() => import('./pages/masters/Items'));
const ItemForm = lazy(() => import('./pages/masters/ItemForm'));
const Categories = lazy(() => import('./pages/masters/Categories'));
const Vendors = lazy(() => import('./pages/masters/Vendors'));
const VendorMaterialMapping = lazy(() => import('./pages/masters/VendorMaterialMapping'));
const UserMaterialMapping = lazy(() => import('./pages/masters/UserMaterialMapping'));
const VendorForm = lazy(() => import('./pages/masters/VendorForm'));
const Warehouses = lazy(() => import('./pages/masters/Warehouses'));
const WarehouseForm = lazy(() => import('./pages/masters/WarehouseForm'));
const UOM = lazy(() => import('./pages/masters/UOM'));
const PackagingHierarchy = lazy(() => import('./pages/masters/PackagingHierarchy'));
const PriceLists = lazy(() => import('./pages/masters/PriceLists'));
const Brands = lazy(() => import('./pages/masters/Brands'));
const Features = lazy(() => import('./pages/masters/Features'));
const ItemTypes = lazy(() => import('./pages/masters/ItemTypes'));
const ItemAttributes = lazy(() => import('./pages/masters/ItemAttributes'));
const CategoryAttributeMapping = lazy(() => import('./pages/masters/CategoryAttributeMapping'));
const Specs = lazy(() => import('./pages/masters/Specs'));
const UserGroups = lazy(() => import('./pages/masters/UserGroups'));
const OrganizationStructure = lazy(() => import('./pages/masters/OrganizationStructure'));
const Lms = lazy(() => import('./pages/lms/Lms'));

/* Procurement */
const MaterialRequests = lazy(() => import('./pages/procurement/MaterialRequests'));
const MaterialRequestsKanban = lazy(() => import('./pages/procurement/MaterialRequestsKanban'));
const MaterialRequestForm = lazy(() => import('./pages/procurement/MaterialRequestForm'));
const DemandPool = lazy(() => import('./pages/procurement/DemandPool'));
const Quotations = lazy(() => import('./pages/procurement/Quotations'));
const QuotationForm = lazy(() => import('./pages/procurement/QuotationForm'));
const PurchaseOrders = lazy(() => import('./pages/procurement/PurchaseOrders'));
const PurchaseOrderForm = lazy(() => import('./pages/procurement/PurchaseOrderForm'));
const QuotationComparison = lazy(() => import('./pages/procurement/QuotationComparison'));

/* Warehouse */
const GRN = lazy(() => import('./pages/warehouse/GRN'));
const GRNForm = lazy(() => import('./pages/warehouse/GRNForm'));
const QualityInspection = lazy(() => import('./pages/warehouse/QualityInspection'));
const QualityInspectionForm = lazy(() => import('./pages/warehouse/QualityInspectionForm'));
const QCOutward = lazy(() => import('./pages/warehouse/QCOutward'));
const Putaway = lazy(() => import('./pages/warehouse/Putaway'));
const FloorPlan = lazy(() => import('./pages/warehouse/FloorPlan'));
const FloorPlan3D = lazy(() => import('./pages/warehouse/FloorPlan3D'));
const PutawayForm = lazy(() => import('./pages/warehouse/PutawayForm'));
const GateEntry = lazy(() => import('./pages/logistics/GateEntry'));
const GateEntryForm = lazy(() => import('./pages/logistics/GateEntryForm'));
const PurchaseReturns = lazy(() => import('./pages/warehouse/PurchaseReturns'));
const PurchaseReturnForm = lazy(() => import('./pages/warehouse/PurchaseReturnForm'));
const MaterialIssues = lazy(() => import('./pages/warehouse/MaterialIssues'));
const MaterialIssueForm = lazy(() => import('./pages/warehouse/MaterialIssueForm'));
const Picklist = lazy(() => import('./pages/warehouse/Picklist'));
const OutwardLabelling = lazy(() => import('./pages/warehouse/OutwardLabelling'));
const StockSegregation = lazy(() => import('./pages/warehouse/StockSegregation'));
const MaterialInward = lazy(() => import('./pages/warehouse/MaterialInward'));
const Dispatch = lazy(() => import('./pages/warehouse/Dispatch'));
const DispatchForm = lazy(() => import('./pages/warehouse/DispatchForm'));
const AcknowledgeDelivery = lazy(() => import('./pages/warehouse/AcknowledgeDelivery'));


/* Healthcare SCM */
const Healthcare = lazy(() => import('./pages/Healthcare'));

/* Inventory */
const StockBalance = lazy(() => import('./pages/inventory/StockBalance'));
const StockLedger = lazy(() => import('./pages/inventory/StockLedger'));
const StockTransfer = lazy(() => import('./pages/inventory/StockTransfer'));
const StockTransferForm = lazy(() => import('./pages/inventory/StockTransferForm'));
const StockAudit = lazy(() => import('./pages/inventory/StockAudit'));
const StockAuditForm = lazy(() => import('./pages/inventory/StockAuditForm'));
const Replenishment = lazy(() => import('./pages/inventory/Replenishment'));



/* Indent */
const Indents = lazy(() => import('./pages/indent/Indents'));
const IndentsKanban = lazy(() => import('./pages/indent/IndentsKanban'));
const IndentForm = lazy(() => import('./pages/indent/IndentForm'));
const IndentAcknowledgement = lazy(() => import('./pages/indent/Acknowledgement'));

/* Consumption */
const ConsumptionEntry = lazy(() => import('./pages/consumption/ConsumptionEntry'));
const ConsumptionEntryForm = lazy(() => import('./pages/consumption/ConsumptionEntryForm'));
const ConsumptionReports = lazy(() => import('./pages/consumption/ConsumptionReports'));

/* Approvals */
const PendingApprovals = lazy(() => import('./pages/approvals/PendingApprovals'));
const WorkflowConfig = lazy(() => import('./pages/approvals/WorkflowConfig'));
const SlaBreaches = lazy(() => import('./pages/approvals/SlaBreaches'));
const BusinessRules = lazy(() => import('./pages/automation/BusinessRules'));

/* Accounts */
const Invoices = lazy(() => import('./pages/accounts/Invoices'));
const InvoiceForm = lazy(() => import('./pages/accounts/InvoiceForm'));
const Payments = lazy(() => import('./pages/accounts/Payments'));
const PaymentForm = lazy(() => import('./pages/accounts/PaymentForm'));
const Ledger = lazy(() => import('./pages/accounts/Ledger'));
const CreditNotes = lazy(() => import('./pages/accounts/CreditNotes'));
const CreditNoteForm = lazy(() => import('./pages/accounts/CreditNoteForm'));
const ChartOfAccountsPage = lazy(() => import('./pages/accounts/ChartOfAccounts'));
const AccountMappingsPage = lazy(() => import('./pages/accounts/AccountMappings'));
const FinancialReportsPage = lazy(() => import('./pages/accounts/FinancialReports'));
const ComplianceDashboard = lazy(() => import('./pages/compliance/ComplianceDashboard'));
const DocumentsPage = lazy(() => import('./pages/documents/Documents'));
const MRPDashboard = lazy(() => import('./pages/mrp/MRPDashboard'));
const AlertsDashboard = lazy(() => import('./pages/alerts/AlertsDashboard'));
const ReportBuilder = lazy(() => import('./pages/reports/ReportBuilder'));

/* Assets */
const AssetRegister = lazy(() => import('./pages/assets/AssetRegister'));
const AssetForm = lazy(() => import('./pages/assets/AssetForm'));
const AssetMovement = lazy(() => import('./pages/assets/AssetMovement'));
const AssetMovementForm = lazy(() => import('./pages/assets/AssetMovementForm'));

/* Reports */
const ReportsDashboard = lazy(() => import('./pages/reports/ReportsDashboard'));
const InventoryReports = lazy(() => import('./pages/reports/InventoryReports'));
const ProcurementReports = lazy(() => import('./pages/reports/ProcurementReports'));
const ConsumptionReportPage = lazy(() => import('./pages/reports/ConsumptionReportPage'));
const SalesReports = lazy(() => import('./pages/reports/SalesReports'));
const AccountsReports = lazy(() => import('./pages/reports/AccountsReports'));

const SystemReports = lazy(() => import('./pages/reports/SystemReports'));

/* Logistics */
const LogisticsDashboard = lazy(() => import('./pages/logistics/LogisticsDashboard'));
const LogisticsMaster = lazy(() => import('./pages/logistics/LogisticsMaster'));
const LogisticsDispatch = lazy(() => import('./pages/logistics/LogisticsDispatch'));
const LogisticsRfq = lazy(() => import('./pages/logistics/LogisticsRfq'));
const LogisticsSO = lazy(() => import('./pages/logistics/LogisticsSO'));

/* Carrier Portal (transporter self-service) */
const CarrierPortal = lazy(() => import('./pages/carrier/CarrierPortal'));

/* Supplier Portal (material vendor self-service) */
const SupplierPortal = lazy(() => import('./pages/supplier/SupplierPortal'));

/* Settings */
const Users = lazy(() => import('./pages/settings/Users'));
const UserForm = lazy(() => import('./pages/settings/UserForm'));
const Roles = lazy(() => import('./pages/settings/Roles'));
const RoleForm = lazy(() => import('./pages/settings/RoleForm'));
const SystemSettings = lazy(() => import('./pages/settings/SystemSettings'));
const Profile = lazy(() => import('./pages/settings/Profile'));
const ChangePassword = lazy(() => import('./pages/settings/ChangePassword'));
const Delegations = lazy(() => import('./pages/settings/Delegations'));
const ApiKeys = lazy(() => import('./pages/settings/ApiKeys'));


/* Loading fallback */
const PageLoader = () => (
  <div
    style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      height: '60vh',
    }}
  >
    <Spin size="large" tip="Loading..." />
  </div>
);

/* Protected Route Wrapper.
   BUG-AUTH-095/120 fix: previously the gate read only `token`. If a stale
   token survived in localStorage but the user object was cleared (e.g.
   logout was interrupted), the app would happily render the protected
   layout and trigger 401s. Require BOTH token and user to be present
   before rendering, and treat the missing-user case as a redirect to
   login. */
const ProtectedRoute = () => {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  if (!token || !user) {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
};

/* Carrier-only route guard. Carrier sessions are completely separate from
   the employee session — their token lives in localStorage under
   `carrier_token` (see carrierAuthStore). */
const CarrierProtectedRoute = ({ children }) => {
  const token = useCarrierAuthStore((s) => s.token);
  const user = useCarrierAuthStore((s) => s.user);
  if (!token || !user) {
    return <Navigate to="/login/transporter" replace />;
  }
  return children;
};

/* Supplier (material vendor) portal route guard. Completely separate from
   both employee and carrier sessions — token lives in `vendor_token`. */
const VendorProtectedRoute = ({ children }) => {
  const token = useVendorAuthStore((s) => s.token);
  const user = useVendorAuthStore((s) => s.user);
  if (!token || !user) {
    return <Navigate to="/login/vendor" replace />;
  }
  return children;
};

/* Permission-guarded route — redirects to launcher if user lacks the required module.
   Accepts string OR array of acceptable modules (any one grants access).
   CR_08/09: warehouse_manager needs to see POs while issuing material — pass
   `module={['procurement','warehouse']}` on shared screens.
   BUG-AUTH-121 fix: preserve the deep-link path in `state.from` so the
   downstream redirect target (launcher / login) can return the user to the
   originally requested URL after they pick a permitted module.
   BUG-AUTH-096/124 fix: accept an explicit `action` prop so `/new` create
   forms can require module + 'create' rather than just module + 'view'.
   The default remains 'view' for backwards compatibility. */
const PermissionRoute = ({ module, action = 'view', children }) => {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const location = useLocation();
  const modules = Array.isArray(module) ? module : [module];
  if (!modules.some((m) => hasPermission(m, action))) {
    // BUG-FE-101: previously always redirected to /launcher. If the user
    // landed on the launcher itself (or any descendant) without permission
    // we'd ping-pong. Render the AccessDenied result instead so the user
    // sees a stable page.
    if (location.pathname === '/launcher') {
      return (
        <Result
          status="403"
          title="Access denied"
          subTitle="You don't have permission to access this page."
        />
      );
    }
    return <Navigate to="/launcher" replace state={{ from: location }} />;
  }
  return children;
};

/* RBAC-FE: per-page key gate. Mirrors PermissionRoute but reads the
   server-driven allowed-keys whitelist (GET /me/sidebar) via
   useAuthStore.hasKey. super_admin/admin short-circuit to true inside
   hasKey itself. Used for leak-prone routes (PO, GRN, invoices, etc.)
   so users can't reach pages they have no sidebar entry for by typing
   the URL directly. */
const KeyRoute = ({ requiredKey, children }) => {
  const hasKey = useAuthStore((s) => s.hasKey);
  const location = useLocation();
  const keys = Array.isArray(requiredKey) ? requiredKey : [requiredKey];
  const matched = keys.some((k) => hasKey(k));
  if (!matched) {
    if (location.pathname === '/launcher') {
      return (
        <Result
          status="403"
          title="Access denied"
          subTitle="You don't have permission to access this page."
        />
      );
    }
    return <Navigate to="/launcher" replace state={{ from: location }} />;
  }
  return children;
};

const RedirectToLogisticsDispatch = () => {
  const { id } = useParams();
  return <Navigate to={`/logistics/dispatch-orders/${id}`} replace />;
};

const RedirectToLogisticsAcknowledge = () => {
  const { id } = useParams();
  return <Navigate to={`/logistics/dispatch-orders/${id}/acknowledge`} replace />;
};

const ModuleIndexRedirect = ({ moduleId, fallback }) => {
  const allowedKeys = useAuthStore((s) => s.allowedKeys);
  const nav = MODULE_NAVS[moduleId];
  const allowedSet = new Set(Array.isArray(allowedKeys) ? allowedKeys : []);

  if (nav && allowedSet.size > 0) {
    const tab = nav.tabs.find((t) => {
      const parts = (t.path || '').split('/').filter(Boolean);
      if (parts.length < 2) return false;
      return allowedSet.has(`${parts[0]}-${parts[1]}`);
    });
    if (tab) return <Navigate to={tab.path} replace />;
  }

  return <Navigate to={fallback} replace />;
};

/* Placeholder for pages not yet implemented */
const PlaceholderPage = ({ title }) => (
  <div style={{ padding: 24 }}>
    <h2>{title}</h2>
    <p style={{ color: 'rgba(0,0,0,0.45)' }}>This page is under development.</p>
  </div>
);

/* BUG-FE-106: lazyPlaceholder factory was dead code — removed. */

// BUG-FE-104: normalize a trailing slash on non-root paths so `/masters/items/`
// resolves to `/masters/items` instead of falling into the catch-all 404.
const TrailingSlashNormalizer = () => {
  const location = useLocation();
  if (location.pathname.length > 1 && location.pathname.endsWith('/')) {
    const target = location.pathname.replace(/\/+$/, '') + (location.search || '') + (location.hash || '');
    return <Navigate to={target} replace />;
  }
  return null;
};

const App = () => {
  return (
    <ErrorBoundary>
    <Suspense fallback={<PageLoader />}>
      <TrailingSlashNormalizer />
      <Routes>
        {/* Auth Routes — both / and /login render the Login form when
            unauthenticated, so the bare-domain URL stays clean instead of
            redirecting to /login on every visit. The `/` route is also
            below in the unauth fallback (line 496) but registering it here
            inside AuthLayout makes the form render with the proper layout. */}
        <Route element={<AuthLayout />}>
          <Route path="/login" element={<Login />} />
          <Route path="/login/transporter" element={<Login />} />
          <Route path="/login/vendor" element={<Login />} />
          <Route path="/" element={<Login />} />
        </Route>

        {/* Carrier portal — completely separate from employee session */}
        <Route
          path="/carrier"
          element={
            <CarrierProtectedRoute>
              <CarrierPortal />
            </CarrierProtectedRoute>
          }
        />

        {/* Supplier portal — material vendors, completely separate session */}
        <Route
          path="/supplier"
          element={
            <VendorProtectedRoute>
              <SupplierPortal />
            </VendorProtectedRoute>
          }
        />

        {/* Protected Routes */}
        <Route element={<ProtectedRoute />}>
          <Route element={<MainLayout />}>
            {/* Launcher (Bavya home) */}
            <Route path="/launcher" element={<AppLauncher />} />
            {/* LMS — accessible to every authenticated user */}
            <Route path="/lms" element={<Lms />} />
            {/* Dashboard — gate behind dashboard permission so vendors etc. don't see ops KPIs */}
            <Route path="/dashboard" element={<PermissionRoute module="dashboard"><Dashboard /></PermissionRoute>} />

            {/* Masters — guarded by 'masters' permission */}
            <Route path="/masters" element={<ModuleIndexRedirect moduleId="masters" fallback="/masters/items" />} />
            <Route path="/masters/items" element={<KeyRoute requiredKey="masters-items"><Items /></KeyRoute>} />
            <Route path="/masters/items/new" element={<KeyRoute requiredKey="masters-items"><ItemForm /></KeyRoute>} />
            <Route path="/masters/items/:id" element={<KeyRoute requiredKey="masters-items"><ItemForm /></KeyRoute>} />
            <Route path="/masters/categories" element={<KeyRoute requiredKey="masters-categories"><Categories /></KeyRoute>} />
            <Route path="/masters/vendors" element={<KeyRoute requiredKey="masters-vendors"><Vendors /></KeyRoute>} />
            <Route path="/masters/vendor-material-mapping" element={<KeyRoute requiredKey="masters-vendor-material-mapping"><VendorMaterialMapping /></KeyRoute>} />
            <Route path="/masters/user-material-mapping" element={<KeyRoute requiredKey="masters-user-material-mapping"><UserMaterialMapping /></KeyRoute>} />
            <Route path="/masters/vendors/new" element={<KeyRoute requiredKey="masters-vendors"><VendorForm /></KeyRoute>} />
            <Route path="/masters/vendors/:id" element={<KeyRoute requiredKey="masters-vendors"><VendorForm /></KeyRoute>} />
            <Route path="/masters/warehouses" element={<KeyRoute requiredKey="masters-warehouses"><Warehouses /></KeyRoute>} />
            <Route path="/masters/warehouses/new" element={<KeyRoute requiredKey="masters-warehouses"><WarehouseForm /></KeyRoute>} />
            <Route path="/masters/warehouses/:id" element={<KeyRoute requiredKey="masters-warehouses"><WarehouseForm /></KeyRoute>} />
            <Route path="/masters/uom" element={<KeyRoute requiredKey="masters-uom"><UOM /></KeyRoute>} />
            <Route path="/masters/packaging" element={<KeyRoute requiredKey="masters-packaging"><PackagingHierarchy /></KeyRoute>} />
            <Route path="/masters/price-lists" element={<KeyRoute requiredKey="masters-price-lists"><PriceLists /></KeyRoute>} />
            <Route path="/masters/brands" element={<KeyRoute requiredKey="masters-brands"><Brands /></KeyRoute>} />
            <Route path="/masters/features" element={<KeyRoute requiredKey="masters-features"><Features /></KeyRoute>} />
            <Route path="/masters/item-types" element={<KeyRoute requiredKey="masters-item-types"><ItemTypes /></KeyRoute>} />
            <Route path="/masters/item-attributes" element={<KeyRoute requiredKey="masters-item-attributes"><ItemAttributes /></KeyRoute>} />
            <Route path="/masters/category-attribute-mapping" element={<KeyRoute requiredKey="masters-attribute-mapping"><CategoryAttributeMapping /></KeyRoute>} />
            <Route path="/masters/specs" element={<KeyRoute requiredKey="masters-specs"><Specs /></KeyRoute>} />
            <Route path="/masters/users" element={<KeyRoute requiredKey="masters-users"><Users /></KeyRoute>} />
            <Route path="/masters/user-groups" element={<KeyRoute requiredKey="masters-user-groups"><UserGroups /></KeyRoute>} />
            <Route path="/masters/organization-structure" element={<KeyRoute requiredKey="masters-organization-structure"><OrganizationStructure /></KeyRoute>} />

            {/* Procurement — guarded by 'procurement' permission */}
            <Route path="/procurement" element={<Navigate to="/procurement/material-requests" replace />} />
            <Route path="/procurement/material-requests" element={<KeyRoute requiredKey="procurement-material-requests"><MaterialRequests /></KeyRoute>} />
            <Route path="/procurement/material-requests/kanban" element={<PermissionRoute module="procurement"><MaterialRequestsKanban /></PermissionRoute>} />
            <Route path="/procurement/material-requests/new" element={<PermissionRoute module="procurement"><MaterialRequestForm /></PermissionRoute>} />
            <Route path="/procurement/material-requests/create" element={<Navigate to="/procurement/material-requests/new" replace />} />
            <Route path="/procurement/material-requests/:id" element={<PermissionRoute module="procurement"><MaterialRequestForm /></PermissionRoute>} />
            <Route path="/procurement/demand-pool" element={<PermissionRoute module="procurement"><DemandPool /></PermissionRoute>} />
            <Route path="/procurement/quotations" element={<KeyRoute requiredKey="procurement-quotations"><Quotations /></KeyRoute>} />
            <Route path="/procurement/quotations/new" element={<PermissionRoute module="procurement"><QuotationForm /></PermissionRoute>} />
            <Route path="/procurement/quotations/:id" element={<PermissionRoute module="procurement"><QuotationForm /></PermissionRoute>} />
            <Route path="/procurement/purchase-orders" element={<KeyRoute requiredKey="procurement-purchase-orders"><PurchaseOrders /></KeyRoute>} />
            <Route path="/procurement/purchase-orders/new" element={<KeyRoute requiredKey="procurement-purchase-orders"><PurchaseOrderForm /></KeyRoute>} />
            <Route path="/procurement/purchase-orders/create" element={<Navigate to="/procurement/purchase-orders/new" replace />} />
            <Route path="/procurement/purchase-orders/:id" element={<KeyRoute requiredKey="procurement-purchase-orders"><PurchaseOrderForm /></KeyRoute>} />
            <Route path="/procurement/quotation-comparison" element={<KeyRoute requiredKey="procurement-quotation-comparison"><QuotationComparison /></KeyRoute>} />

            {/* Warehouse — guarded by 'warehouse' permission */}
            <Route path="/warehouse" element={<ModuleIndexRedirect moduleId="warehouse" fallback="/warehouse/grn" />} />
            <Route path="/warehouse/grn" element={<KeyRoute requiredKey="warehouse-grn"><GRN /></KeyRoute>} />
            <Route path="/warehouse/grn/new" element={<PermissionRoute module="warehouse"><GRNForm /></PermissionRoute>} />
            <Route path="/warehouse/grn/create" element={<Navigate to="/warehouse/grn/new" replace />} />
            <Route path="/warehouse/grn/:id" element={<PermissionRoute module="warehouse"><GRNForm /></PermissionRoute>} />
            <Route path="/warehouse/quality-inspection" element={<KeyRoute requiredKey="warehouse-quality-inspection"><QualityInspection /></KeyRoute>} />
            <Route path="/warehouse/quality-inspection/new" element={<PermissionRoute module="warehouse"><QualityInspectionForm /></PermissionRoute>} />
            <Route path="/warehouse/quality-inspection/:id" element={<PermissionRoute module="warehouse"><QualityInspectionForm /></PermissionRoute>} />
            <Route path="/warehouse/putaway" element={<KeyRoute requiredKey="warehouse-putaway"><Putaway /></KeyRoute>} />
            <Route path="/warehouse/putaway/new" element={<PermissionRoute module="warehouse"><PutawayForm /></PermissionRoute>} />
            <Route path="/warehouse/putaway/:id" element={<PermissionRoute module="warehouse"><PutawayForm /></PermissionRoute>} />
            <Route path="/warehouse/floor-plan" element={<KeyRoute requiredKey="warehouse-floor-plan"><FloorPlan /></KeyRoute>} />
            <Route path="/warehouse/floor-plan-3d" element={<KeyRoute requiredKey="warehouse-floor-plan"><FloorPlan3D /></KeyRoute>} />
            <Route path="/warehouse/purchase-returns" element={<KeyRoute requiredKey="warehouse-purchase-returns"><PurchaseReturns /></KeyRoute>} />
            <Route path="/warehouse/purchase-returns/new" element={<PermissionRoute module="warehouse"><PurchaseReturnForm /></PermissionRoute>} />
            <Route path="/warehouse/purchase-returns/:id" element={<PermissionRoute module="warehouse"><PurchaseReturnForm /></PermissionRoute>} />
            <Route path="/warehouse/material-issues" element={<KeyRoute requiredKey="warehouse-material-issues"><MaterialIssues /></KeyRoute>} />
            <Route path="/warehouse/material-issues/new" element={<PermissionRoute module="warehouse"><MaterialIssueForm /></PermissionRoute>} />
            <Route path="/warehouse/material-issues/:id" element={<PermissionRoute module="warehouse"><MaterialIssueForm /></PermissionRoute>} />
            <Route path="/warehouse/picklist" element={<KeyRoute requiredKey="warehouse-picklist"><Picklist /></KeyRoute>} />
            <Route path="/warehouse/qc-outward" element={<KeyRoute requiredKey="warehouse-qc-outward"><QCOutward /></KeyRoute>} />
            <Route path="/warehouse/outward-labelling" element={<KeyRoute requiredKey="warehouse-outward-labelling"><OutwardLabelling /></KeyRoute>} />
            <Route path="/warehouse/stock-segregation" element={<KeyRoute requiredKey="warehouse-stock-segregation"><StockSegregation /></KeyRoute>} />
            <Route path="/warehouse/material-inward" element={<KeyRoute requiredKey="warehouse-material-inward"><MaterialInward /></KeyRoute>} />
            
            {/* Outward Dispatch - Unified under Logistics */}
            <Route path="/logistics/dispatch-orders" element={<KeyRoute requiredKey="warehouse-dispatch"><Dispatch /></KeyRoute>} />
            <Route path="/logistics/dispatch-orders/new" element={<PermissionRoute module="logistics"><DispatchForm /></PermissionRoute>} />
            <Route path="/logistics/dispatch-orders/:id" element={<PermissionRoute module="logistics"><DispatchForm /></PermissionRoute>} />
            <Route path="/logistics/dispatch-orders/:id/acknowledge" element={<PermissionRoute module="logistics"><AcknowledgeDelivery /></PermissionRoute>} />

            {/* Legacy redirects to unify pipeline routing */}
            <Route path="/warehouse/dispatch" element={<Navigate to="/logistics/dispatch-orders" replace />} />
            <Route path="/warehouse/dispatch/new" element={<Navigate to="/logistics/dispatch-orders/new" replace />} />
            <Route path="/warehouse/dispatch/:id" element={<RedirectToLogisticsDispatch />} />
            <Route path="/warehouse/dispatch/:id/acknowledge" element={<RedirectToLogisticsAcknowledge />} />


            {/* Inventory — guarded by 'inventory' permission */}
            <Route path="/inventory" element={<Navigate to="/inventory/stock-balance" replace />} />
            <Route path="/inventory/stock" element={<Navigate to="/inventory/stock-balance" replace />} />
            <Route path="/inventory/stock-balance" element={<KeyRoute requiredKey="inventory-stock-balance"><StockBalance /></KeyRoute>} />
            <Route path="/inventory/stock-ledger" element={<KeyRoute requiredKey="inventory-stock-ledger"><StockLedger /></KeyRoute>} />
            <Route path="/inventory/stock-transfer" element={<KeyRoute requiredKey="inventory-stock-transfer"><StockTransfer /></KeyRoute>} />
            <Route path="/inventory/stock-transfer/new" element={<PermissionRoute module="inventory"><StockTransferForm /></PermissionRoute>} />
            <Route path="/inventory/stock-transfer/:id" element={<PermissionRoute module="inventory"><StockTransferForm /></PermissionRoute>} />
            <Route path="/inventory/stock-audit" element={<KeyRoute requiredKey="inventory-stock-audit"><StockAudit /></KeyRoute>} />
            <Route path="/inventory/stock-audit/new" element={<PermissionRoute module="inventory"><StockAuditForm /></PermissionRoute>} />
            <Route path="/inventory/stock-audit/:id" element={<PermissionRoute module="inventory"><StockAuditForm /></PermissionRoute>} />
            <Route path="/inventory/replenishment" element={<KeyRoute requiredKey="inventory-replenishment"><Replenishment /></KeyRoute>} />



            {/* Indent — guarded by 'indent' permission */}
            <Route path="/indent/indents" element={<KeyRoute requiredKey="indent-indents"><Indents /></KeyRoute>} />
            <Route path="/indent/indents/kanban" element={<PermissionRoute module="indent"><IndentsKanban /></PermissionRoute>} />
            <Route path="/indent/indents/new" element={<PermissionRoute module="indent"><IndentForm /></PermissionRoute>} />
            <Route path="/indent/indents/create" element={<Navigate to="/indent/indents/new" replace />} />
            <Route path="/indent/indents/:id" element={<PermissionRoute module="indent"><IndentForm /></PermissionRoute>} />
            <Route path="/indent/acknowledgement" element={<KeyRoute requiredKey="indent-acknowledgement"><IndentAcknowledgement /></KeyRoute>} />

            {/* Consumption — guarded by 'consumption' permission */}
            <Route path="/consumption/entry" element={<KeyRoute requiredKey="consumption-entry"><ConsumptionEntry /></KeyRoute>} />
            <Route path="/consumption/entry/new" element={<PermissionRoute module="consumption"><ConsumptionEntryForm /></PermissionRoute>} />
            <Route path="/consumption/entry/:id" element={<PermissionRoute module="consumption"><ConsumptionEntryForm /></PermissionRoute>} />
            <Route path="/consumption/reports" element={<PermissionRoute module="consumption"><ConsumptionReports /></PermissionRoute>} />

            {/* Approvals — guarded by 'approvals' permission */}
            <Route path="/approvals" element={<Navigate to="/approvals/pending" replace />} />
            <Route path="/approvals/pending" element={<KeyRoute requiredKey="approvals-pending"><PendingApprovals /></KeyRoute>} />
            <Route path="/approvals/workflow-config" element={<KeyRoute requiredKey="approvals-workflow-config"><WorkflowConfig /></KeyRoute>} />
            <Route path="/approvals/sla-breaches" element={<PermissionRoute module="approvals"><SlaBreaches /></PermissionRoute>} />
            <Route path="/approvals/business-rules" element={<PermissionRoute module="approvals"><BusinessRules /></PermissionRoute>} />

            {/* Accounts — guarded by 'accounts' permission */}
            <Route path="/accounts" element={<Navigate to="/accounts/coa" replace />} />
            <Route path="/accounts/coa" element={<PermissionRoute module="accounts"><ChartOfAccountsPage /></PermissionRoute>} />
            <Route path="/accounts/mappings" element={<PermissionRoute module="accounts"><AccountMappingsPage /></PermissionRoute>} />
            <Route path="/accounts/reports" element={<PermissionRoute module="accounts"><FinancialReportsPage /></PermissionRoute>} />
            <Route path="/accounts/invoices" element={<KeyRoute requiredKey="accounts-invoices"><Invoices /></KeyRoute>} />
            <Route path="/accounts/invoices/new" element={<PermissionRoute module="accounts"><InvoiceForm /></PermissionRoute>} />
            <Route path="/accounts/invoices/:id" element={<PermissionRoute module="accounts"><InvoiceForm /></PermissionRoute>} />
            <Route path="/accounts/payments" element={<KeyRoute requiredKey="accounts-payments"><Payments /></KeyRoute>} />
            <Route path="/accounts/payments/new" element={<PermissionRoute module="accounts"><PaymentForm /></PermissionRoute>} />
            <Route path="/accounts/payments/:id" element={<PermissionRoute module="accounts"><PaymentForm /></PermissionRoute>} />
            <Route path="/accounts/ledger" element={<KeyRoute requiredKey="accounts-ledger"><Ledger /></KeyRoute>} />
            <Route path="/accounts/credit-notes" element={<KeyRoute requiredKey="accounts-credit-notes"><CreditNotes /></KeyRoute>} />
            <Route path="/accounts/credit-notes/new" element={<PermissionRoute module="accounts"><CreditNoteForm /></PermissionRoute>} />
            <Route path="/accounts/credit-notes/:id" element={<PermissionRoute module="accounts"><CreditNoteForm /></PermissionRoute>} />

            {/* Assets — guarded by 'assets' permission */}
            <Route path="/assets/register" element={<PermissionRoute module="assets"><AssetRegister /></PermissionRoute>} />
            <Route path="/assets/register/new" element={<PermissionRoute module="assets"><AssetForm /></PermissionRoute>} />
            <Route path="/assets/register/:id" element={<PermissionRoute module="assets"><AssetForm /></PermissionRoute>} />
            <Route path="/assets/movement" element={<PermissionRoute module="assets"><AssetMovement /></PermissionRoute>} />
            <Route path="/assets/movement/new" element={<PermissionRoute module="assets"><AssetMovementForm /></PermissionRoute>} />
            <Route path="/assets/movement/:id" element={<PermissionRoute module="assets"><AssetMovementForm /></PermissionRoute>} />

            {/* Healthcare SCM — guarded by 'healthcare' permission */}
            <Route path="/healthcare" element={<PermissionRoute module="healthcare"><Healthcare /></PermissionRoute>} />

            {/* Healthcare Compliance — Wave 7 */}
            <Route path="/compliance" element={<PermissionRoute module="healthcare"><ComplianceDashboard /></PermissionRoute>} />

            {/* Document Management — Wave 8 */}
            <Route path="/documents" element={<PermissionRoute module="settings"><DocumentsPage /></PermissionRoute>} />

            {/* Demand Planning + MRP — Wave 9 */}
            <Route path="/mrp" element={<PermissionRoute module="procurement"><MRPDashboard /></PermissionRoute>} />

            {/* Alerts & Insights — closes audit gaps G-04/05/06/08 */}
            <Route path="/alerts" element={<PermissionRoute module={['inventory','warehouse','procurement']}><AlertsDashboard /></PermissionRoute>} />

            {/* Report Builder — Wave 10 */}
            <Route path="/reports/builder" element={<PermissionRoute module="reports"><ReportBuilder /></PermissionRoute>} />

            {/* Reports — guarded by 'reports' permission */}
            <Route path="/reports" element={<PermissionRoute module="reports"><ReportsDashboard /></PermissionRoute>} />
            <Route path="/reports/inventory" element={<PermissionRoute module="reports"><InventoryReports /></PermissionRoute>} />
            <Route path="/reports/procurement" element={<PermissionRoute module="reports"><ProcurementReports /></PermissionRoute>} />
            <Route path="/reports/consumption" element={<PermissionRoute module="reports"><ConsumptionReportPage /></PermissionRoute>} />
            <Route path="/reports/sales" element={<PermissionRoute module="reports"><SalesReports /></PermissionRoute>} />
            <Route path="/reports/accounts" element={<PermissionRoute module="reports"><AccountsReports /></PermissionRoute>} />

            <Route path="/reports/system" element={<PermissionRoute module="reports"><SystemReports /></PermissionRoute>} />

            {/* Logistics Module */}
            <Route path="/logistics" element={<Navigate to="/logistics/dashboard" replace />} />
            <Route path="/logistics/dashboard" element={<KeyRoute requiredKey="logistics-dashboard"><LogisticsDashboard /></KeyRoute>} />
            <Route path="/logistics/master" element={<KeyRoute requiredKey="logistics-master"><LogisticsMaster /></KeyRoute>} />
            <Route path="/logistics/dispatch" element={<KeyRoute requiredKey="logistics-dispatch"><LogisticsDispatch /></KeyRoute>} />
            <Route path="/logistics/rfq" element={<KeyRoute requiredKey="logistics-rfq"><LogisticsRfq /></KeyRoute>} />
            <Route path="/logistics/so" element={<KeyRoute requiredKey="logistics-so"><LogisticsSO /></KeyRoute>} />
            <Route path="/logistics/so-gating" element={<KeyRoute requiredKey={['logistics-so', 'logistics-so-gating']}><LogisticsSO /></KeyRoute>} />
            <Route path="/logistics/so-acknowledge" element={<KeyRoute requiredKey={['logistics-so', 'logistics-so-acknowledge']}><AcknowledgeDelivery /></KeyRoute>} />
            <Route path="/logistics/so-alerts" element={<KeyRoute requiredKey={['logistics-so', 'logistics-so-alerts']}><LogisticsSO /></KeyRoute>} />
            <Route path="/logistics/gate-entry" element={<KeyRoute requiredKey="logistics-gate-entry"><GateEntry /></KeyRoute>} />
            <Route path="/logistics/gate-entry/new" element={<PermissionRoute module="logistics"><GateEntryForm /></PermissionRoute>} />
            <Route path="/logistics/gate-entry/:id" element={<PermissionRoute module="logistics"><GateEntryForm /></PermissionRoute>} />


            {/* Settings (gated by 'settings' permission; profile/change-password/delegations always allowed) */}
            <Route path="/settings" element={<Navigate to="/settings/profile" replace />} />
            <Route path="/settings/delegations" element={<Delegations />} />
            <Route path="/settings/users" element={<KeyRoute requiredKey="settings-users"><Users /></KeyRoute>} />
            <Route path="/settings/users/new" element={<PermissionRoute module="settings"><UserForm /></PermissionRoute>} />
            <Route path="/settings/users/:id" element={<PermissionRoute module="settings"><UserForm /></PermissionRoute>} />
            <Route path="/settings/roles" element={<KeyRoute requiredKey="settings-roles"><Roles /></KeyRoute>} />
            <Route path="/settings/roles/new" element={<PermissionRoute module="settings"><RoleForm /></PermissionRoute>} />
            <Route path="/settings/roles/:id" element={<PermissionRoute module="settings"><RoleForm /></PermissionRoute>} />
            <Route path="/settings/system" element={<KeyRoute requiredKey="settings-system"><SystemSettings /></KeyRoute>} />
            <Route path="/settings/api-keys" element={<PermissionRoute module="settings"><ApiKeys /></PermissionRoute>} />
            <Route path="/settings/profile" element={<Profile />} />
            <Route path="/settings/change-password" element={<ChangePassword />} />

            {/* Catch-all redirect.
                BUG-AUTH-125 fix: this route lives INSIDE ProtectedRoute so
                anonymous clients hitting an unknown URL get bounced to
                /login by the auth wrapper before this Navigate runs. The
                /launcher target is therefore guaranteed to be reached only
                by authenticated sessions. */}
            <Route path="*" element={<Navigate to="/launcher" replace />} />
          </Route>
        </Route>

        {/* Root redirect: removed — / now renders the Login form (above)
            so the bare-domain URL stays clean for unauthenticated users.
            Authenticated users landing on / are redirected to /launcher
            by the Login component itself (Login.jsx:51-54 effect on
            existing token). */}
      </Routes>
    </Suspense>
    </ErrorBoundary>
  );
};

export default App;
