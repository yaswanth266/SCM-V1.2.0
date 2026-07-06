import React, { Suspense, lazy, Component, useEffect, useState } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation, useParams } from 'react-router-dom';
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
const AppLauncher = lazy(() => import('./pages/AppLauncher'));

/* Modular SCM Redesign Additions */
const IndentDashboard = lazy(() => import('./pages/indent/IndentDashboard'));
const IndentReports = lazy(() => import('./pages/indent/IndentReports'));
const IndentNotifications = lazy(() => import('./pages/indent/IndentNotifications'));

const InventoryDashboard = lazy(() => import('./pages/inventory/InventoryDashboard'));
const InventoryNotifications = lazy(() => import('./pages/inventory/InventoryNotifications'));

const WarehouseDashboard = lazy(() => import('./pages/warehouse/WarehouseDashboard'));
const WarehouseReports = lazy(() => import('./pages/warehouse/WarehouseReports'));
const WarehouseNotifications = lazy(() => import('./pages/warehouse/WarehouseNotifications'));

const ProcurementDashboard = lazy(() => import('./pages/procurement/ProcurementDashboard'));
const ProcurementNotifications = lazy(() => import('./pages/procurement/ProcurementNotifications'));

/* Masters */
const Items = lazy(() => import('./pages/inventory/masters/Items'));
const ItemForm = lazy(() => import('./pages/inventory/masters/ItemForm'));
const ItemDetail = lazy(() => import('./pages/inventory/masters/ItemDetail'));
const Categories = lazy(() => import('./pages/inventory/masters/Categories'));
const Vendors = lazy(() => import('./pages/procurement/masters/Vendors'));
const VendorMaterialMapping = lazy(() => import('./pages/procurement/masters/VendorMaterialMapping'));
const UserMaterialMapping = lazy(() => import('./pages/inventory/masters/UserMaterialMapping'));
const VendorForm = lazy(() => import('./pages/procurement/masters/VendorForm'));
const VendorDetail = lazy(() => import('./pages/procurement/masters/VendorDetail'));
const Warehouses = lazy(() => import('./pages/warehouse/masters/Warehouses'));
const WarehouseForm = lazy(() => import('./pages/warehouse/masters/WarehouseForm'));
const WarehouseDetail = lazy(() => import('./pages/warehouse/masters/WarehouseDetail'));
const UOM = lazy(() => import('./pages/inventory/masters/UOM'));
const PackagingHierarchy = lazy(() => import('./pages/inventory/masters/PackagingHierarchy'));
const PriceLists = lazy(() => import('./pages/inventory/masters/PriceLists'));
const PriceListForm = lazy(() => import('./pages/inventory/masters/PriceListForm'));
const Brands = lazy(() => import('./pages/inventory/masters/Brands'));
const Features = lazy(() => import('./pages/inventory/masters/Features'));
const ItemTypes = lazy(() => import('./pages/inventory/masters/ItemTypes'));
const ItemSubClasses = lazy(() => import('./pages/inventory/masters/ItemSubClasses'));
const ItemAttributes = lazy(() => import('./pages/inventory/masters/ItemAttributes'));
const CategoryAttributeMapping = lazy(() => import('./pages/inventory/masters/CategoryAttributeMapping'));
const Specs = lazy(() => import('./pages/inventory/masters/Specs'));
const UserGroups = lazy(() => import('./pages/settings/masters/UserGroups'));
const OrganizationStructure = lazy(() => import('./pages/settings/masters/OrganizationStructure'));
const HRSyncDashboard = lazy(() => import('./pages/settings/masters/HRSyncDashboard'));
const BOMs = lazy(() => import('./pages/inventory/masters/BOMs'));
const BOMForm = lazy(() => import('./pages/inventory/masters/BOMForm'));
const Vehicles = lazy(() => import('./pages/inventory/masters/Vehicles'));
const ProjectIndentTemplateForm = lazy(() => import('./pages/inventory/masters/ProjectIndentTemplateForm'));
const ProjectIndentTemplateList = lazy(() => import('./pages/inventory/masters/ProjectIndentTemplateList'));

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
const PurchaseOrderDetail = lazy(() => import('./pages/procurement/PurchaseOrderDetail'));
const QuotationComparison = lazy(() => import('./pages/procurement/QuotationComparison'));

/* Warehouse */
const GRN = lazy(() => import('./pages/warehouse/GRN'));
const GRNForm = lazy(() => import('./pages/warehouse/GRNForm'));
const QualityInspection = lazy(() => import('./pages/warehouse/QualityInspection'));
const QualityInspectionForm = lazy(() => import('./pages/warehouse/QualityInspectionForm'));
const QCOutward = lazy(() => import('./pages/warehouse/QCOutward'));
const QCOutwardForm = lazy(() => import('./pages/warehouse/QCOutwardForm'));
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
const TemplateMaterialIssueList = lazy(() => import('./pages/warehouse/TemplateMaterialIssueList'));
const Picklist = lazy(() => import('./pages/warehouse/Picklist'));
const PicklistForm = lazy(() => import('./pages/warehouse/PicklistForm'));
const OutwardLabelling = lazy(() => import('./pages/warehouse/OutwardLabelling'));
const StockSegregation = lazy(() => import('./pages/warehouse/StockSegregation'));
const MaterialInward = lazy(() => import('./pages/warehouse/MaterialInward'));
const MaterialInwardForm = lazy(() => import('./pages/warehouse/MaterialInwardForm'));
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
const AcknowledgementForm = lazy(() => import('./pages/indent/AcknowledgementForm'));
const TemplateIndentList = lazy(() => import('./pages/indent/TemplateIndentList'));
const TemplateIndentForm = lazy(() => import('./pages/indent/TemplateIndentForm'));


/* Consumption */
const ConsumptionEntry = lazy(() => import('./pages/consumption/ConsumptionEntry'));
const ConsumptionEntryForm = lazy(() => import('./pages/consumption/ConsumptionEntryForm'));
const ConsumptionReports = lazy(() => import('./pages/consumption/ConsumptionReports'));

/* Approvals */
const PendingApprovals = lazy(() => import('./pages/approvals/PendingApprovals'));
const WorkflowConfig = lazy(() => import('./pages/approvals/WorkflowConfig'));
const WorkflowConfigForm = lazy(() => import('./pages/approvals/WorkflowConfigForm'));
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
const ReportBuilder = lazy(() => import('./pages/settings/reports/ReportBuilder'));

/* Assets */
const AssetRegister = lazy(() => import('./pages/assets/AssetRegister'));
const AssetForm = lazy(() => import('./pages/assets/AssetForm'));
const AssetMovement = lazy(() => import('./pages/assets/AssetMovement'));
const AssetMovementForm = lazy(() => import('./pages/assets/AssetMovementForm'));
const AssetSpareMapping = lazy(() => import('./pages/assets/AssetSpareMapping'));

/* Reports */
const InventoryReports = lazy(() => import('./pages/inventory/reports/InventoryReports'));
const ProcurementReports = lazy(() => import('./pages/procurement/reports/ProcurementReports'));
const ConsumptionReportPage = lazy(() => import('./pages/consumption/reports/ConsumptionReportPage'));
const AccountsReports = lazy(() => import('./pages/accounts/reports/AccountsReports'));
const SystemReports = lazy(() => import('./pages/settings/reports/SystemReports'));

/* Logistics */
const LogisticsDashboard = lazy(() => import('./pages/logistics/LogisticsDashboard'));
const LogisticsMaster = lazy(() => import('./pages/logistics/LogisticsMaster'));
const LogisticsDispatch = lazy(() => import('./pages/logistics/LogisticsDispatch'));
const LogisticsRfq = lazy(() => import('./pages/logistics/LogisticsRfq'));
const LogisticsSO = lazy(() => import('./pages/logistics/LogisticsSO'));
const LogisticsConsignment = lazy(() => import('./pages/logistics/LogisticsConsignment'));

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
    <Spin size="large" tip="Loading...">
      <div />
    </Spin>
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

const RedirectToItemDetail = () => {
  const { id } = useParams();
  return <Navigate to={`/inventory/masters/items/${id}`} replace />;
};

const RedirectToItemEdit = () => {
  const { id } = useParams();
  return <Navigate to={`/inventory/masters/items/${id}/edit`} replace />;
};

const RedirectToVendorDetail = () => {
  const { id } = useParams();
  return <Navigate to={`/procurement/masters/vendors/${id}`} replace />;
};

const RedirectToVendorEdit = () => {
  const { id } = useParams();
  return <Navigate to={`/procurement/masters/vendors/${id}/edit`} replace />;
};

const RedirectToWarehouseDetail = () => {
  const { id } = useParams();
  return <Navigate to={`/warehouse/masters/warehouses/${id}`} replace />;
};

const RedirectToWarehouseEdit = () => {
  const { id } = useParams();
  return <Navigate to={`/warehouse/masters/warehouses/${id}/edit`} replace />;
};

const RedirectToPriceListEdit = () => {
  const { id } = useParams();
  return <Navigate to={`/inventory/masters/price-lists/${id}/edit`} replace />;
};

const RedirectToBOMEdit = () => {
  const { id } = useParams();
  return <Navigate to={`/inventory/masters/boms/${id}/edit`} replace />;
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
            <Route path="/warehouse" element={<ModuleIndexRedirect moduleId="warehouse" fallback="/warehouse/dashboard" />} />
            <Route path="/warehouse/dashboard" element={<PermissionRoute module="warehouse"><WarehouseDashboard /></PermissionRoute>} />
            <Route path="/warehouse/masters/warehouses" element={<KeyRoute requiredKey="warehouse-masters-warehouses"><Warehouses /></KeyRoute>} />
            <Route path="/warehouse/masters/warehouses/new" element={<KeyRoute requiredKey="warehouse-masters-warehouses"><WarehouseForm /></KeyRoute>} />
            <Route path="/warehouse/masters/warehouses/:id" element={<KeyRoute requiredKey="warehouse-masters-warehouses"><WarehouseDetail /></KeyRoute>} />
            <Route path="/warehouse/masters/warehouses/:id/edit" element={<KeyRoute requiredKey="warehouse-masters-warehouses"><WarehouseForm /></KeyRoute>} />
            <Route path="/warehouse/masters/floor-plan" element={<KeyRoute requiredKey="warehouse-masters-floor-plan"><FloorPlan /></KeyRoute>} />
            <Route path="/warehouse/masters/floor-plan-3d" element={<KeyRoute requiredKey="warehouse-masters-floor-plan-3d"><FloorPlan3D /></KeyRoute>} />
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
            <Route path="/warehouse/floor-plan" element={<Navigate to="/warehouse/masters/floor-plan" replace />} />
            <Route path="/warehouse/floor-plan-3d" element={<Navigate to="/warehouse/masters/floor-plan-3d" replace />} />
            <Route path="/warehouse/purchase-returns" element={<KeyRoute requiredKey="warehouse-purchase-returns"><PurchaseReturns /></KeyRoute>} />
            <Route path="/warehouse/purchase-returns/new" element={<PermissionRoute module="warehouse"><PurchaseReturnForm /></PermissionRoute>} />
            <Route path="/warehouse/purchase-returns/:id" element={<PermissionRoute module="warehouse"><PurchaseReturnForm /></PermissionRoute>} />
            <Route path="/warehouse/material-issues" element={<KeyRoute requiredKey="warehouse-material-issues"><MaterialIssues /></KeyRoute>} />
            <Route path="/warehouse/material-issues/new" element={<PermissionRoute module="warehouse"><MaterialIssueForm /></PermissionRoute>} />
            <Route path="/warehouse/material-issues/:id" element={<PermissionRoute module="warehouse"><MaterialIssueForm /></PermissionRoute>} />
            <Route path="/warehouse/material-issues/ap104-consumables" element={<KeyRoute requiredKey="warehouse-material-issues-ap104-consumables"><TemplateMaterialIssueList templateType="consumables" title="AP 104 DP / Consumables Issues" /></KeyRoute>} />
            <Route path="/warehouse/material-issues/ap104-consumables/new" element={<PermissionRoute module="warehouse"><MaterialIssueForm templateType="consumables" title="Create AP 104 DP / Consumables Material Issue" /></PermissionRoute>} />
            <Route path="/warehouse/material-issues/ap104-consumables/:id" element={<PermissionRoute module="warehouse"><MaterialIssueForm templateType="consumables" title="AP 104 DP / Consumables Material Issue" /></PermissionRoute>} />
            <Route path="/warehouse/material-issues/ap104-install" element={<KeyRoute requiredKey="warehouse-material-issues-ap104-install"><TemplateMaterialIssueList templateType="install" title="AP 104 DP Install Issues" /></KeyRoute>} />
            <Route path="/warehouse/material-issues/ap104-install/new" element={<PermissionRoute module="warehouse"><MaterialIssueForm templateType="install" title="Create AP 104 DP Install Material Issue" /></PermissionRoute>} />
            <Route path="/warehouse/material-issues/ap104-install/:id" element={<PermissionRoute module="warehouse"><MaterialIssueForm templateType="install" title="AP 104 DP Install Material Issue" /></PermissionRoute>} />
            <Route path="/warehouse/picklist" element={<KeyRoute requiredKey="warehouse-picklist"><Picklist /></KeyRoute>} />
            <Route path="/warehouse/picklist/new" element={<KeyRoute requiredKey="warehouse-picklist"><PicklistForm /></KeyRoute>} />
            <Route path="/warehouse/qc-outward" element={<KeyRoute requiredKey="warehouse-qc-outward"><QCOutward /></KeyRoute>} />
            <Route path="/warehouse/qc-outward/new" element={<PermissionRoute module="warehouse"><QCOutwardForm /></PermissionRoute>} />
            <Route path="/warehouse/qc-outward/:id" element={<PermissionRoute module="warehouse"><QCOutwardForm /></PermissionRoute>} />
            <Route path="/warehouse/outward-labelling" element={<KeyRoute requiredKey="warehouse-outward-labelling"><OutwardLabelling /></KeyRoute>} />
            <Route path="/warehouse/stock-segregation" element={<KeyRoute requiredKey="warehouse-stock-segregation"><StockSegregation /></KeyRoute>} />
            <Route path="/warehouse/material-inward" element={<KeyRoute requiredKey="warehouse-material-inward"><MaterialInward /></KeyRoute>} />
            <Route path="/warehouse/material-inward/new" element={<PermissionRoute module="warehouse"><MaterialInwardForm /></PermissionRoute>} />
            <Route path="/warehouse/material-inward/:id" element={<PermissionRoute module="warehouse"><MaterialInwardForm /></PermissionRoute>} />
            <Route path="/warehouse/gate-entry" element={<KeyRoute requiredKey="warehouse-gate-entry"><GateEntry /></KeyRoute>} />
            <Route path="/warehouse/gate-entry/new" element={<PermissionRoute module="warehouse"><GateEntryForm /></PermissionRoute>} />
            <Route path="/warehouse/gate-entry/:id" element={<PermissionRoute module="warehouse"><GateEntryForm /></PermissionRoute>} />
            <Route path="/warehouse/reports" element={<PermissionRoute module="warehouse"><WarehouseReports /></PermissionRoute>} />
            <Route path="/warehouse/notifications" element={<PermissionRoute module="warehouse"><WarehouseNotifications /></PermissionRoute>} />

            {/* Procurement — guarded by 'procurement' permission */}
            <Route path="/procurement" element={<ModuleIndexRedirect moduleId="procurement" fallback="/procurement/dashboard" />} />
            <Route path="/procurement/dashboard" element={<PermissionRoute module="procurement"><ProcurementDashboard /></PermissionRoute>} />
            <Route path="/procurement/masters/vendors" element={<KeyRoute requiredKey="procurement-masters-vendors"><Vendors /></KeyRoute>} />
            <Route path="/procurement/masters/vendors/new" element={<KeyRoute requiredKey="procurement-masters-vendors"><VendorForm /></KeyRoute>} />
            <Route path="/procurement/masters/vendors/:id" element={<KeyRoute requiredKey="procurement-masters-vendors"><VendorDetail /></KeyRoute>} />
            <Route path="/procurement/masters/vendors/:id/edit" element={<KeyRoute requiredKey="procurement-masters-vendors"><VendorForm /></KeyRoute>} />
            <Route path="/procurement/masters/vendor-material-mapping" element={<KeyRoute requiredKey="procurement-masters-vendor-material-mapping"><VendorMaterialMapping /></KeyRoute>} />
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
            <Route path="/procurement/purchase-orders/:id" element={<KeyRoute requiredKey="procurement-purchase-orders"><PurchaseOrderDetail /></KeyRoute>} />
            <Route path="/procurement/purchase-orders/:id/edit" element={<KeyRoute requiredKey="procurement-purchase-orders"><PurchaseOrderForm /></KeyRoute>} />
            <Route path="/procurement/quotation-comparison" element={<KeyRoute requiredKey="procurement-quotation-comparison"><QuotationComparison /></KeyRoute>} />
            <Route path="/procurement/reports" element={<PermissionRoute module="procurement"><ProcurementReports /></PermissionRoute>} />
            <Route path="/procurement/notifications" element={<PermissionRoute module="procurement"><ProcurementNotifications /></PermissionRoute>} />

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
            <Route path="/inventory" element={<ModuleIndexRedirect moduleId="inventory" fallback="/inventory/dashboard" />} />
            <Route path="/inventory/dashboard" element={<PermissionRoute module="inventory"><InventoryDashboard /></PermissionRoute>} />
            <Route path="/inventory/masters/items" element={<KeyRoute requiredKey="inventory-masters-items"><Items /></KeyRoute>} />
            <Route path="/inventory/masters/items/new" element={<KeyRoute requiredKey="inventory-masters-items"><ItemForm /></KeyRoute>} />
            <Route path="/inventory/masters/items/:id" element={<KeyRoute requiredKey="inventory-masters-items"><ItemDetail /></KeyRoute>} />
            <Route path="/inventory/masters/items/:id/edit" element={<KeyRoute requiredKey="inventory-masters-items"><ItemForm /></KeyRoute>} />
            <Route path="/inventory/masters/categories" element={<KeyRoute requiredKey="inventory-masters-categories"><Categories /></KeyRoute>} />
            <Route path="/inventory/masters/packaging" element={<KeyRoute requiredKey="inventory-masters-packaging"><PackagingHierarchy /></KeyRoute>} />
            <Route path="/inventory/masters/user-material-mapping" element={<KeyRoute requiredKey="inventory-masters-user-material-mapping"><UserMaterialMapping /></KeyRoute>} />
            <Route path="/inventory/masters/uom" element={<KeyRoute requiredKey="inventory-masters-uom"><UOM /></KeyRoute>} />
            <Route path="/inventory/masters/brands" element={<KeyRoute requiredKey="inventory-masters-brands"><Brands /></KeyRoute>} />
            <Route path="/inventory/masters/features" element={<KeyRoute requiredKey="inventory-masters-features"><Features /></KeyRoute>} />
            <Route path="/inventory/masters/item-types" element={<KeyRoute requiredKey="inventory-masters-item-types"><ItemTypes /></KeyRoute>} />
            <Route path="/inventory/masters/item-sub-classes" element={<KeyRoute requiredKey="inventory-masters-item-types"><ItemSubClasses /></KeyRoute>} />
            <Route path="/inventory/masters/item-attributes" element={<KeyRoute requiredKey="inventory-masters-item-attributes"><ItemAttributes /></KeyRoute>} />
            <Route path="/inventory/masters/category-attribute-mapping" element={<KeyRoute requiredKey="inventory-masters-category-attribute-mapping"><CategoryAttributeMapping /></KeyRoute>} />
            <Route path="/inventory/masters/specs" element={<KeyRoute requiredKey="inventory-masters-specs"><Specs /></KeyRoute>} />
            <Route path="/inventory/masters/boms" element={<KeyRoute requiredKey="inventory-masters-boms"><BOMs /></KeyRoute>} />
            <Route path="/inventory/masters/boms/new" element={<KeyRoute requiredKey="inventory-masters-boms"><BOMForm /></KeyRoute>} />
            <Route path="/inventory/masters/boms/:id/edit" element={<KeyRoute requiredKey="inventory-masters-boms"><BOMForm /></KeyRoute>} />
            <Route path="/inventory/masters/ap104-consumables" element={<KeyRoute requiredKey="inventory-masters-ap104-consumables"><ProjectIndentTemplateList templateType="consumables" title="AP 104 DP / Consumables Master" /></KeyRoute>} />
            <Route path="/inventory/masters/ap104-consumables/new" element={<KeyRoute requiredKey="inventory-masters-ap104-consumables"><ProjectIndentTemplateForm templateType="consumables" title="AP 104 DP / Consumables Master" /></KeyRoute>} />
            <Route path="/inventory/masters/ap104-consumables/edit/:projectId" element={<KeyRoute requiredKey="inventory-masters-ap104-consumables"><ProjectIndentTemplateForm templateType="consumables" title="AP 104 DP / Consumables Master" /></KeyRoute>} />
            <Route path="/inventory/masters/ap104-install" element={<KeyRoute requiredKey="inventory-masters-ap104-install"><ProjectIndentTemplateList templateType="install" title="AP 104 DP Install Master" /></KeyRoute>} />
            <Route path="/inventory/masters/ap104-install/new" element={<KeyRoute requiredKey="inventory-masters-ap104-install"><ProjectIndentTemplateForm templateType="install" title="AP 104 DP Install Master" /></KeyRoute>} />
            <Route path="/inventory/masters/ap104-install/edit/:projectId" element={<KeyRoute requiredKey="inventory-masters-ap104-install"><ProjectIndentTemplateForm templateType="install" title="AP 104 DP Install Master" /></KeyRoute>} />
            <Route path="/inventory/masters/vehicles" element={<KeyRoute requiredKey="inventory-masters-items"><Vehicles /></KeyRoute>} />
            <Route path="/inventory/masters/price-lists" element={<KeyRoute requiredKey="inventory-masters-price-lists"><PriceLists /></KeyRoute>} />

            <Route path="/inventory/masters/price-lists/new" element={<KeyRoute requiredKey="inventory-masters-price-lists"><PriceListForm /></KeyRoute>} />
            <Route path="/inventory/masters/price-lists/:id/edit" element={<KeyRoute requiredKey="inventory-masters-price-lists"><PriceListForm /></KeyRoute>} />
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
            <Route path="/inventory/reports" element={<PermissionRoute module="inventory"><InventoryReports /></PermissionRoute>} />
            <Route path="/inventory/notifications" element={<PermissionRoute module="inventory"><InventoryNotifications /></PermissionRoute>} />

            {/* Indent — guarded by 'indent' permission */}
            <Route path="/indent" element={<ModuleIndexRedirect moduleId="indent" fallback="/indent/dashboard" />} />
            <Route path="/indent/dashboard" element={<PermissionRoute module="indent"><IndentDashboard /></PermissionRoute>} />
            <Route path="/indent/indents" element={<KeyRoute requiredKey="indent-indents"><Indents /></KeyRoute>} />
            <Route path="/indent/indents/kanban" element={<PermissionRoute module="indent"><IndentsKanban /></PermissionRoute>} />
            <Route path="/indent/indents/new" element={<PermissionRoute module="indent"><IndentForm /></PermissionRoute>} />
            <Route path="/indent/indents/create" element={<Navigate to="/indent/indents/new" replace />} />
            <Route path="/indent/indents/:id" element={<PermissionRoute module="indent"><IndentForm /></PermissionRoute>} />
            <Route path="/indent/ap104-consumables" element={<KeyRoute requiredKey="indent-ap104-consumables"><TemplateIndentList templateType="consumables" title="AP 104 DP / Consumables Indents" /></KeyRoute>} />
            <Route path="/indent/ap104-consumables/new" element={<PermissionRoute module="indent"><TemplateIndentForm templateType="consumables" title="Create AP 104 DP / Consumables Indent" /></PermissionRoute>} />
            <Route path="/indent/ap104-consumables/:id" element={<PermissionRoute module="indent"><TemplateIndentForm templateType="consumables" title="AP 104 DP / Consumables Indent" /></PermissionRoute>} />
            <Route path="/indent/ap104-install" element={<KeyRoute requiredKey="indent-ap104-install"><TemplateIndentList templateType="install" title="AP 104 DP Install Indents" /></KeyRoute>} />
            <Route path="/indent/ap104-install/new" element={<PermissionRoute module="indent"><TemplateIndentForm templateType="install" title="Create AP 104 DP Install Indent" /></PermissionRoute>} />
            <Route path="/indent/ap104-install/:id" element={<PermissionRoute module="indent"><TemplateIndentForm templateType="install" title="AP 104 DP Install Indent" /></PermissionRoute>} />

            <Route path="/indent/acknowledgement" element={<KeyRoute requiredKey="indent-acknowledgement"><IndentAcknowledgement /></KeyRoute>} />
            <Route path="/indent/acknowledgement/new" element={<KeyRoute requiredKey="indent-acknowledgement"><AcknowledgementForm /></KeyRoute>} />
            <Route path="/indent/reports" element={<PermissionRoute module="indent"><IndentReports /></PermissionRoute>} />
            <Route path="/indent/notifications" element={<PermissionRoute module="indent"><IndentNotifications /></PermissionRoute>} />

            {/* Consumption — guarded by 'consumption' permission */}
            <Route path="/consumption" element={<ModuleIndexRedirect moduleId="consumption" fallback="/consumption/entry" />} />
            <Route path="/consumption/entry" element={<KeyRoute requiredKey="consumption-entry"><ConsumptionEntry /></KeyRoute>} />
            <Route path="/consumption/entry/new" element={<PermissionRoute module="consumption"><ConsumptionEntryForm /></PermissionRoute>} />
            <Route path="/consumption/entry/:id" element={<PermissionRoute module="consumption"><ConsumptionEntryForm /></PermissionRoute>} />
            <Route path="/consumption/reports" element={<PermissionRoute module="consumption"><ConsumptionReports /></PermissionRoute>} />

            {/* Approvals — guarded by 'approvals' permission */}
            <Route path="/approvals" element={<Navigate to="/approvals/pending" replace />} />
            <Route path="/approvals/pending" element={<KeyRoute requiredKey="approvals-pending"><PendingApprovals /></KeyRoute>} />
            <Route path="/approvals/workflow-config" element={<KeyRoute requiredKey="approvals-workflow-config"><WorkflowConfig /></KeyRoute>} />
            <Route path="/approvals/workflow-config/new" element={<KeyRoute requiredKey="approvals-workflow-config"><WorkflowConfigForm /></KeyRoute>} />
            <Route path="/approvals/workflow-config/:id/edit" element={<KeyRoute requiredKey="approvals-workflow-config"><WorkflowConfigForm /></KeyRoute>} />
            <Route path="/approvals/sla-breaches" element={<PermissionRoute module="approvals"><SlaBreaches /></PermissionRoute>} />
            <Route path="/approvals/business-rules" element={<PermissionRoute module="approvals"><BusinessRules /></PermissionRoute>} />

            {/* Accounts — guarded by 'accounts' permission */}
            <Route path="/accounts" element={<ModuleIndexRedirect moduleId="accounts" fallback="/accounts/coa" />} />
            <Route path="/accounts/coa" element={<PermissionRoute module="accounts"><ChartOfAccountsPage /></PermissionRoute>} />
            <Route path="/accounts/mappings" element={<PermissionRoute module="accounts"><AccountMappingsPage /></PermissionRoute>} />
            <Route path="/accounts/reports" element={<PermissionRoute module="accounts"><AccountsReports /></PermissionRoute>} />
            <Route path="/accounts/financial-reports" element={<PermissionRoute module="accounts"><FinancialReportsPage /></PermissionRoute>} />
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
            <Route path="/assets/spare-mapping" element={<PermissionRoute module="assets"><AssetSpareMapping /></PermissionRoute>} />

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

            {/* Legacy redirects for reports */}
            <Route path="/reports/inventory" element={<Navigate to="/inventory/reports" replace />} />
            <Route path="/reports/procurement" element={<Navigate to="/procurement/reports" replace />} />
            <Route path="/reports/consumption" element={<Navigate to="/consumption/reports" replace />} />
            <Route path="/reports/accounts" element={<Navigate to="/accounts/reports" replace />} />
            <Route path="/reports/system" element={<Navigate to="/settings/reports/system" replace />} />
            <Route path="/reports/builder" element={<Navigate to="/settings/reports-v2" replace />} />
            <Route path="/reports" element={<Navigate to="/launcher" replace />} />

            {/* Legacy redirects for masters */}
            <Route path="/masters/items" element={<Navigate to="/inventory/masters/items" replace />} />
            <Route path="/masters/items/new" element={<Navigate to="/inventory/masters/items/new" replace />} />
            <Route path="/masters/items/:id" element={<RedirectToItemDetail />} />
            <Route path="/masters/items/:id/edit" element={<RedirectToItemEdit />} />
            <Route path="/masters/categories" element={<Navigate to="/inventory/masters/categories" replace />} />
            <Route path="/masters/vendors" element={<Navigate to="/procurement/masters/vendors" replace />} />
            <Route path="/masters/vendor-material-mapping" element={<Navigate to="/procurement/masters/vendor-material-mapping" replace />} />
            <Route path="/masters/user-material-mapping" element={<Navigate to="/inventory/masters/user-material-mapping" replace />} />
            <Route path="/masters/vendors/new" element={<Navigate to="/procurement/masters/vendors/new" replace />} />
            <Route path="/masters/vendors/:id" element={<RedirectToVendorDetail />} />
            <Route path="/masters/vendors/:id/edit" element={<RedirectToVendorEdit />} />
            <Route path="/masters/warehouses" element={<Navigate to="/warehouse/masters/warehouses" replace />} />
            <Route path="/masters/warehouses/new" element={<Navigate to="/warehouse/masters/warehouses/new" replace />} />
            <Route path="/masters/warehouses/:id" element={<RedirectToWarehouseDetail />} />
            <Route path="/masters/warehouses/:id/edit" element={<RedirectToWarehouseEdit />} />
            <Route path="/masters/uom" element={<Navigate to="/inventory/masters/uom" replace />} />
            <Route path="/masters/packaging" element={<Navigate to="/inventory/masters/packaging" replace />} />
            <Route path="/masters/price-lists" element={<Navigate to="/inventory/masters/price-lists" replace />} />
            <Route path="/masters/price-lists/new" element={<Navigate to="/inventory/masters/price-lists/new" replace />} />
            <Route path="/masters/price-lists/:id/edit" element={<RedirectToPriceListEdit />} />
            <Route path="/masters/brands" element={<Navigate to="/inventory/masters/brands" replace />} />
            <Route path="/masters/features" element={<Navigate to="/inventory/masters/features" replace />} />
            <Route path="/masters/item-types" element={<Navigate to="/inventory/masters/item-types" replace />} />
            <Route path="/masters/item-attributes" element={<Navigate to="/inventory/masters/item-attributes" replace />} />
            <Route path="/masters/category-attribute-mapping" element={<Navigate to="/inventory/masters/category-attribute-mapping" replace />} />
            <Route path="/masters/specs" element={<Navigate to="/inventory/masters/specs" replace />} />
            <Route path="/masters/users" element={<Navigate to="/settings/users" replace />} />
            <Route path="/masters/user-groups" element={<Navigate to="/settings/masters/user-groups" replace />} />
            <Route path="/masters/organization-structure" element={<Navigate to="/settings/masters/organization-structure" replace />} />
            <Route path="/masters/organization-structure/hr-sync" element={<Navigate to="/settings/masters/organization-structure/hr-sync" replace />} />
            <Route path="/masters/boms" element={<Navigate to="/inventory/masters/boms" replace />} />
            <Route path="/masters/boms/new" element={<Navigate to="/inventory/masters/boms/new" replace />} />
            <Route path="/masters/boms/:id/edit" element={<RedirectToBOMEdit />} />
            <Route path="/masters" element={<Navigate to="/launcher" replace />} />

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
            <Route path="/logistics/consignments" element={<KeyRoute requiredKey="logistics-consignments"><LogisticsConsignment /></KeyRoute>} />


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
            <Route path="/settings/masters/user-groups" element={<KeyRoute requiredKey="settings-masters-user-groups"><UserGroups /></KeyRoute>} />
            <Route path="/settings/masters/organization-structure" element={<KeyRoute requiredKey="settings-masters-organization-structure"><OrganizationStructure /></KeyRoute>} />
            <Route path="/settings/masters/organization-structure/hr-sync" element={<KeyRoute requiredKey="settings-masters-organization-structure"><HRSyncDashboard /></KeyRoute>} />
            <Route path="/settings/reports-v2" element={<KeyRoute requiredKey="settings-reports-v2"><ReportBuilder /></KeyRoute>} />
            <Route path="/settings/reports/system" element={<KeyRoute requiredKey="settings-reports-system"><SystemReports /></KeyRoute>} />

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
