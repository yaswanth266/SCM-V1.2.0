import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Spin, message } from 'antd';
import {
  ShoppingCartOutlined,
  InboxOutlined,
  CarOutlined,
  BarChartOutlined,
  HeartOutlined,
  AppstoreOutlined,
  FilterOutlined,
  PlusOutlined,
  RightOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import api from '../config/api';
import useAuthStore from '../store/authStore';
import {
  formatCurrency,
  formatNumber,
  formatDateTime,
  getErrorMessage,
} from '../utils/helpers';

const todayDateLine = () => {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const d = new Date();
  return `${days[d.getDay()]} · ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
};

const initials = (name) =>
  (name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();

const ACTIVITY_COLORS = ['#D80048', '#2E7D52', '#481890', '#F09000', '#900078'];

const Dashboard = () => {
  const navigate = useNavigate();
  const { hasPermission, user } = useAuthStore();
  // RBAC: hide KPI tiles whose drill-through path the role can't reach.
  // Without this every role sees pending-MR / pending-approvals counts even
  // when they have no access to those modules — leaks cross-module data.
  const hasKey = useAuthStore((s) => s.hasKey);
  const [stats, setStats] = useState({});
  const [activities, setActivities] = useState([]);
  const [alerts, setAlerts] = useState({ low_stock: [], expiring_items: [], overdue_pos: [] });
  const [loading, setLoading] = useState(true);
  // Approved indents waiting to be issued. Shown on the dashboard for
  // warehouse / store-keeper roles so they can skip the menu hunt
  // (Warehouse → Material Issue → Create → pick indent) and start the issue
  // directly from here.
  const [pendingIssue, setPendingIssue] = useState([]);
  const _activeRole =
    user?.role ||
    (Array.isArray(user?.roles) ? user.roles[0]?.code : null) ||
    user?.user_type;

  // Derive the dashboard "persona". Backend's stats.scope wins for field
  // users (it stays 'self'); everything else is decided client-side from the
  // user's active role so each persona sees a focused screen instead of the
  // operations-wide one.
  const _personaForRole = (r) => {
    if (!r) return 'ops';
    if (['field_staff'].includes(r)) return 'self';
    if (['field_supervisor', 'project_manager'].includes(r)) return 'approver';
    if (['warehouse_manager', 'warehouse_operator', 'store_keeper', 'quality_inspector'].includes(r)) return 'warehouse';
    if (['purchase_manager', 'purchase_officer'].includes(r)) return 'procurement';
    if (['accounts_manager', 'accounts_officer'].includes(r)) return 'accounts';
    if (['viewer'].includes(r)) return 'viewer';
    if (['super_admin', 'admin'].includes(r)) return 'ops';
    return 'ops';
  };
  const persona = _personaForRole(_activeRole);
  // RBAC: gate persona-driven cards by allowed_keys so a quality_inspector
  // mapped onto persona='warehouse' (which they aren't, but defense-in-depth)
  // doesn't see "Indents Pending Issuance" linking to /warehouse/material-issues
  // when warehouse-material-issues isn't in their allowed_keys.
  const showPendingIssuance = (persona === 'warehouse' || persona === 'ops')
    && hasKey('warehouse-material-issues');
  const showMrPoTrend = (persona === 'procurement' || persona === 'ops')
    && (hasKey('procurement-material-requests') || hasKey('procurement-purchase-orders'));
  const showUrgent = (persona === 'warehouse' || persona === 'procurement' || persona === 'ops')
    && (hasKey('warehouse-grn') || hasKey('warehouse-material-issues')
        || hasKey('procurement-purchase-orders') || hasKey('inventory-stock-balance'));

  const fetchAll = async () => {
    setLoading(true);
    const calls = [
      api.get('/dashboard/stats'),
      api.get('/dashboard/recent-activities', { params: { limit: 8 } }),
      api.get('/dashboard/alerts'),
    ];
    if (showPendingIssuance) {
      // Pull the next batch of approved indents — backend returns the user's
      // own warehouse-scoped list so the operator only sees what THEY would
      // be expected to issue from.
      calls.push(
        api.get('/indent/indents', {
          params: { status: 'approved', page_size: 8 },
        }),
      );
    }
    const settled = await Promise.allSettled(calls);
    const [s, a, al, pi] = settled;
    if (s.status === 'fulfilled') setStats(s.value.data || {});
    if (a.status === 'fulfilled') {
      // BUG-FIN-123: prefer the explicit array on top-level shapes; fall
      // back through pagination wrappers but never accept the raw object
      // itself as the list (that's where stale "data" objects leaked in).
      const d = a.value.data;
      let list = [];
      if (Array.isArray(d)) list = d;
      else if (Array.isArray(d?.results)) list = d.results;
      else if (Array.isArray(d?.items)) list = d.items;
      else if (Array.isArray(d?.activities)) list = d.activities;
      else if (Array.isArray(d?.data)) list = d.data;
      setActivities(list.slice(0, 8));
    }
    if (al.status === 'fulfilled') {
      const d = al.value.data || {};
      setAlerts({
        low_stock: d.low_stock || d.low_stock_items || [],
        expiring_items: d.expiring_items || [],
        overdue_pos: d.overdue_pos || [],
      });
    }
    if (pi && pi.status === 'fulfilled') {
      const d = pi.value.data || {};
      const rows = d.items || d.results || d.data || [];
      setPendingIssue(Array.isArray(rows) ? rows : []);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchAll();
    // BUG-FIN-122: pause the 5-min polling when the tab is hidden so we
    // don't keep hammering the backend for a screen no-one is looking at.
    // Resume + immediately refresh on visibility change.
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      fetchAll();
    }, 5 * 60 * 1000);
    const onVis = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        fetchAll();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVis);
    }
    return () => {
      clearInterval(t);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVis);
      }
    };
  }, []);

  // KPI definitions — keys here match what the live /dashboard/stats returns
  const get = (...keys) => {
    for (const k of keys) {
      if (stats[k] != null) return stats[k];
    }
    return null;
  };
  // Render — for missing keys instead of "0" or "₹0.00" so the user can tell
  // "no data yet" from "actually zero".
  const fmtNum = (v) => (v == null ? '—' : formatNumber(v));
  const fmtMoney = (v) => (v == null ? '—' : formatCurrency(v));
  // Field-only users get a dashboard built around their own indent
  // pipeline. The backend signals this with `scope: "self"` on /stats.
  const isSelfScope = stats.scope === 'self' || persona === 'self';
  const _kpisSelf = [
    {
      lbl: 'My Indents',
      val: fmtNum(get('my_indents_total')),
      delta: 'all time',
      icon: <HeartOutlined />,
      color: '#481890',
      onClick: () => navigate('/indent/indents'),
    },
    {
      lbl: 'Pending Approval',
      val: fmtNum(get('my_indents_pending_approval')),
      delta: 'awaiting approver',
      icon: <AppstoreOutlined />,
      color: '#F09000',
      onClick: () => navigate('/indent/indents'),
    },
    {
      lbl: 'Approved',
      val: fmtNum(get('my_indents_approved')),
      delta: 'cleared, awaiting issue',
      icon: <ShoppingCartOutlined />,
      color: '#2E7D52',
      onClick: () => navigate('/indent/indents'),
    },
    {
      lbl: 'Fulfilled',
      val: fmtNum(get('my_indents_fulfilled')),
      delta: 'delivered',
      icon: <InboxOutlined />,
      color: '#2E7D52',
      onClick: () => navigate('/indent/indents'),
    },
    {
      lbl: 'Rejected',
      val: fmtNum(get('my_indents_rejected')),
      delta: 'declined by approver',
      icon: <BarChartOutlined />,
      color: '#D80048',
      onClick: () => navigate('/indent/indents'),
    },
    {
      lbl: 'Draft',
      val: fmtNum(get('my_indents_draft')),
      delta: 'not yet submitted',
      icon: <CarOutlined />,
      color: '#900078',
      onClick: () => navigate('/indent/indents'),
    },
    {
      lbl: 'Book Consumption',
      val: fmtNum(get('my_consumption_count', 'consumption_today', 0)) || '+',
      delta: 'record stock used today',
      icon: <InboxOutlined />,
      color: '#1677ff',
      onClick: () => navigate('/consumption/entry'),
      requiredKey: 'consumption-entry',
    },
  ];
  const _kpisOps = [
    {
      lbl: 'Pending Material Requests',
      val: fmtNum(get('pending_material_requests', 'open_material_requests', 'open_mrs')),
      delta: 'awaiting action',
      icon: <ShoppingCartOutlined />,
      color: '#D80048',
      onClick: () => navigate('/procurement/material-requests'),
      requiredKey: 'procurement-material-requests',
    },
    {
      lbl: 'Pending Approvals',
      val: fmtNum(get('pending_approvals', 'pending_approvals_count')),
      delta: 'in your inbox',
      icon: <AppstoreOutlined />,
      color: '#900078',
      onClick: () => navigate('/approvals/pending'),
      requiredKey: 'approvals-pending',
    },
    {
      lbl: 'Pending Indents',
      val: fmtNum(get('pending_indents')),
      delta: 'open across projects',
      icon: <HeartOutlined />,
      color: '#2E7D52',
      onClick: () => navigate('/indent/indents'),
      requiredKey: 'indent-indents',
    },
    {
      lbl: 'Low-Stock SKUs',
      val: fmtNum(
        get('low_stock_items', 'low_stock_count') ?? alerts.low_stock.length,
      ),
      delta: 'below reorder level',
      icon: <BarChartOutlined />,
      color: '#F09000',
      onClick: () => navigate('/inventory/replenishment'),
      requiredKey: 'inventory-replenishment',
    },
    {
      lbl: 'Stock Value',
      val: fmtMoney(get('total_stock_value', 'stock_value', 'inventory_value')),
      delta: 'across all warehouses',
      icon: <InboxOutlined />,
      color: '#481890',
      onClick: () => navigate('/inventory/stock-balance'),
      requiredKey: 'inventory-stock-balance',
    },
    {
      lbl: 'Total Items',
      val: fmtNum(get('total_active_items', 'total_items')),
      delta: 'active in catalogue',
      icon: <CarOutlined />,
      color: '#D80048',
      onClick: () => navigate('/masters/items'),
      requiredKey: 'masters-items',
    },
  ];


  // Per-persona KPI sets. Each KPI links to the page where the operator
  // would actually do something about that number — no "click and explore".
  // Approvers don't raise documents, so every KPI for them MUST land in the
  // Approvals inbox — not on /indent/indents (which they don't have menu
  // access to and would 403/404 on direct nav). Linking out of bounds was
  // the BUG-DASH-001 dead-link.
  const _kpisApprover = [
    { lbl: 'Pending Approvals', val: fmtNum(get('pending_approvals', 'pending_approvals_count')), delta: 'in your inbox', icon: <AppstoreOutlined />, color: '#F09000', onClick: () => navigate('/approvals/pending?status=pending'), requiredKey: 'approvals-pending' },
    { lbl: 'Approved (today)',  val: fmtNum(get('approved_today')),  delta: 'cleared by you',     icon: <HeartOutlined />,   color: '#2E7D52', onClick: () => navigate('/approvals/pending?status=approved'), requiredKey: 'approvals-pending' },
    { lbl: 'Rejected (today)',  val: fmtNum(get('rejected_today')),  delta: 'declined by you',    icon: <BarChartOutlined />, color: '#D80048', onClick: () => navigate('/approvals/pending?status=rejected'), requiredKey: 'approvals-pending' },
    { lbl: 'On Hold',           val: fmtNum(get('on_hold_today')),   delta: 'awaiting clarification', icon: <ShoppingCartOutlined />, color: '#481890', onClick: () => navigate('/approvals/pending?status=on_hold'), requiredKey: 'approvals-pending' },
  ];
  const _kpisWarehouse = [
    // Warehouse roles no longer have an Indents menu entry — clicking the
    // KPI lands them on Material Issues (which is where issuance happens)
    // rather than 404'ing on /indent/indents.
    { lbl: 'Indents to Issue',   val: fmtNum(get('approved_indents_count') ?? pendingIssue.length), delta: 'awaiting issuance', icon: <ShoppingCartOutlined />, color: '#481890', onClick: () => navigate('/warehouse/material-issues'), requiredKey: 'warehouse-material-issues' },
    { lbl: 'GRNs Pending Putaway', val: fmtNum(get('grns_pending_putaway')), delta: 'received, not yet binned', icon: <InboxOutlined />, color: '#900078', onClick: () => navigate('/warehouse/putaway'), requiredKey: 'warehouse-putaway' },
    { lbl: 'Low-Stock SKUs',     val: fmtNum(get('low_stock_items', 'low_stock_count') ?? alerts.low_stock.length), delta: 'below reorder',  icon: <BarChartOutlined />, color: '#F09000', onClick: () => navigate('/inventory/replenishment'), requiredKey: 'inventory-replenishment' },
    { lbl: 'Expiring Soon',      val: fmtNum(get('expiring_count') ?? alerts.expiring_items.length), delta: 'within 90 days', icon: <CarOutlined />, color: '#D80048', onClick: () => navigate('/inventory/stock-balance'), requiredKey: 'inventory-stock-balance' },
    { lbl: 'Stock Value',        val: fmtMoney(get('total_stock_value', 'stock_value')), delta: 'on hand', icon: <HeartOutlined />, color: '#2E7D52', onClick: () => navigate('/inventory/stock-balance'), requiredKey: 'inventory-stock-balance' },
  ];
  const _kpisProcurement = [
    { lbl: 'Pending Material Requests', val: fmtNum(get('pending_material_requests', 'open_mrs')), delta: 'awaiting action', icon: <ShoppingCartOutlined />, color: '#D80048', onClick: () => navigate('/procurement/material-requests'), requiredKey: 'procurement-material-requests' },
    { lbl: 'Open Quotations',     val: fmtNum(get('open_quotations')), delta: 'awaiting comparison',  icon: <HeartOutlined />,   color: '#481890', onClick: () => navigate('/procurement/quotations'), requiredKey: 'procurement-quotations' },
    { lbl: 'POs Awaiting Confirm',val: fmtNum(get('pending_pos', 'pos_awaiting_confirm')), delta: 'sent to vendor', icon: <BarChartOutlined />, color: '#F09000', onClick: () => navigate('/procurement/purchase-orders'), requiredKey: 'procurement-purchase-orders' },
    { lbl: 'Overdue POs',         val: fmtNum(alerts.overdue_pos.length), delta: 'past expected date', icon: <CarOutlined />, color: '#D80048', onClick: () => navigate('/procurement/purchase-orders'), requiredKey: 'procurement-purchase-orders' },
    { lbl: 'PO Spend (mo)',       val: fmtMoney(get('po_spend_month')), delta: 'this month', icon: <InboxOutlined />, color: '#2E7D52', onClick: () => navigate('/reports/procurement'), requiredKey: 'reports-procurement' },
  ];
  const _kpisAccounts = [
    { lbl: 'Invoices Pending',    val: fmtNum(get('invoices_pending')),    delta: 'awaiting payment',     icon: <ShoppingCartOutlined />, color: '#D80048', onClick: () => navigate('/accounts/invoices'), requiredKey: 'accounts-invoices' },
    { lbl: 'Payments (today)',    val: fmtMoney(get('payments_today')),    delta: 'released today',       icon: <HeartOutlined />,    color: '#2E7D52', onClick: () => navigate('/accounts/payments'), requiredKey: 'accounts-payments' },
    { lbl: 'Credit Notes Pending',val: fmtNum(get('credit_notes_pending')),delta: 'awaiting approval',    icon: <AppstoreOutlined />, color: '#F09000', onClick: () => navigate('/accounts/credit-notes'), requiredKey: 'accounts-credit-notes' },
    { lbl: 'AP Outstanding',      val: fmtMoney(get('ap_outstanding')),    delta: 'across vendors',       icon: <InboxOutlined />,    color: '#481890', onClick: () => navigate('/accounts/ledger'), requiredKey: 'accounts-ledger' },
  ];
  const _kpisViewer = [
    // Viewer persona only has dashboard + reports — every KPI must land on
    // a reports page or the stock-balance page (their only inventory access).
    { lbl: 'Pending Indents',     val: fmtNum(get('pending_indents')),     delta: 'open',               icon: <HeartOutlined />,    color: '#2E7D52', onClick: () => navigate('/reports/inventory'), requiredKey: 'reports-inventory' },
    { lbl: 'Stock Value',         val: fmtMoney(get('total_stock_value')), delta: 'on hand',            icon: <InboxOutlined />,    color: '#481890', onClick: () => navigate('/reports/inventory'), requiredKey: 'reports-inventory' },
    { lbl: 'PO Spend (mo)',       val: fmtMoney(get('po_spend_month')),    delta: 'this month',         icon: <BarChartOutlined />, color: '#F09000', onClick: () => navigate('/reports/procurement'), requiredKey: 'reports-procurement' },
  ];
  const kpis = (() => {
    switch (persona) {
      case 'self': return _kpisSelf;
      case 'approver': return _kpisApprover;
      case 'warehouse': return _kpisWarehouse;
      case 'procurement': return _kpisProcurement;
      case 'accounts': return _kpisAccounts;
      case 'viewer': return _kpisViewer;
      default: return _kpisOps;
    }
  })()
  // RBAC: drop KPI tiles whose drill-through key isn't in this user's
  // allowed_keys whitelist. super_admin/admin pass via hasKey short-circuit.
  // Tiles without a requiredKey (field/self bucket) are always shown.
  .filter((t) => !t.requiredKey || hasKey(t.requiredKey));

  // Quick-action buttons — surface the most common create flows so users
  // don't have to navigate two clicks deep. Each button is permission-gated.
  const quickActions = [
    {
      label: 'New Indent',
      desc: 'Raise a field indent',
      perm: 'indent',
      action: 'create',
      color: '#481890',
      onClick: () => navigate('/indent/indents/new'),
    },
    {
      label: 'New Material Request',
      desc: 'Procurement request',
      perm: 'procurement',
      action: 'create',
      key: 'procurement-material-requests',
      color: '#D80048',
      onClick: () => navigate('/procurement/material-requests/new'),
    },
    {
      label: 'Book Consumption',
      desc: 'Log issue / usage',
      perm: 'consumption',
      action: 'create',
      key: 'consumption-entry',
      color: '#D80048',
      onClick: () => navigate('/consumption/entry/new'),
    },
    {
      label: 'New Purchase Order',
      desc: 'Issue PO to vendor',
      perm: 'procurement',
      action: 'create',
      key: 'procurement-purchase-orders',
      color: '#F09000',
      onClick: () => navigate('/procurement/purchase-orders'),
    },
    {
      label: 'Receive GRN',
      desc: 'Goods receipt',
      perm: 'warehouse',
      action: 'create',
      key: 'warehouse-grn',
      color: '#2E7D52',
      onClick: () => navigate('/warehouse/grn'),
    },
    {
      label: 'Issue Materials',
      desc: 'Pick approved indent → issue',
      perm: 'warehouse',
      action: 'create',
      key: 'warehouse-material-issues',
      color: '#481890',
      onClick: () => navigate('/warehouse/material-issues'),
      // Force-show for warehouse roles even if perm gate is fuzzy.
      _forceShow: showPendingIssuance,
    },
    {
      label: 'Stock Transfer',
      desc: 'Move stock between WHs',
      perm: 'inventory',
      action: 'create',
      key: 'inventory-stock-transfer',
      color: '#900078',
      onClick: () => navigate('/inventory/stock-transfer'),
    },
    // Hide tiles whose target route the user lacks the sidebar key for.
    // Without this gate, field_staff sees "Receive GRN" and clicks land on
    // /launcher (KeyRoute redirect) — confusing "back to home" behavior.
  ].filter((a) => (a._forceShow || hasPermission(a.perm, a.action))
    && (!a.key || hasKey(a.key))
    // Approver persona (field_supervisor / project_manager) is a reviewer,
    // not a raiser. Suppress every create-tile so their dashboard stays
    // focused on what they actually do — review the inbox.
    && !(persona === 'approver'));

  // Trend bars — only render when backend exposes a real trend array. The
  // earlier "synthesize 4 zeros + 1 bar" fallback was visually misleading.
  const trend = Array.isArray(stats.mr_po_trend) ? stats.mr_po_trend : null;
  const maxBar = trend ? Math.max(...trend.flatMap((b) => [b.reqs, b.pos]), 1) : 1;

  // Urgent list — combine low-stock + overdue POs into one feed.
  const urgent = [
    ...alerts.low_stock.slice(0, 3).map((it) => ({
      ref: it.item_code || it.code || `ITM-${it.item_id || ''}`,
      title: it.item_name || it.name || 'Low stock item',
      meta: `Available ${formatNumber(it.available_qty || 0)} · Reorder at ${formatNumber(it.reorder_level || 0)}`,
      tag: 'LOW STOCK',
      tagClass: 'warn',
      onClick: () => navigate('/inventory/stock-balance'),
    })),
    ...alerts.overdue_pos.slice(0, 3).map((po) => ({
      ref: po.po_number || po.reference || `PO-${po.id}`,
      title: po.vendor_name || po.title || 'Overdue PO',
      meta: `Expected ${po.expected_date || '—'} · ${formatCurrency(po.amount || 0)}`,
      tag: 'OVERDUE',
      tagClass: 'danger',
      onClick: () => navigate(`/procurement/purchase-orders/${po.id}`),
    })),
    ...alerts.expiring_items.slice(0, 3).map((ex) => ({
      ref: ex.item_code || `BATCH-${ex.batch_id}`,
      title: ex.item_name || 'Expiring item',
      meta: `Expires ${ex.expiry_date || '—'} · qty ${formatNumber(ex.qty || 0)}`,
      tag: 'EXPIRING',
      tagClass: 'warn',
      onClick: () => navigate('/inventory/stock-balance'),
    })),
  ];

  return (
    <div className="bavya-dash">
      {(() => {
        const personaTitle = {
          self: 'My Snapshot',
          approver: 'Approvals Inbox',
          warehouse: 'Warehouse Snapshot',
          procurement: 'Procurement Snapshot',
          accounts: 'Accounts Snapshot',
          viewer: 'Read-Only Snapshot',
          ops: 'Operations Snapshot',
        }[persona] || 'Operations Snapshot';
        const personaCta = {
          self:        { label: 'Raise Indent',      to: '/indent/indents/new' },
          approver:    { label: 'Open Approvals',    to: '/approvals/pending' },
          warehouse:   { label: 'Issue Materials',   to: '/warehouse/material-issues' },
          procurement: { label: 'New Material Request', to: '/procurement/material-requests/new' },
          accounts:    { label: 'New Invoice',       to: '/accounts/invoices' },
          viewer:      null,
          ops:         { label: 'New Request',       to: '/procurement/material-requests/new' },
        }[persona];
        return (
          <div className="bavya-dash-hdr">
            <div className="left">
              <div className="eyebrow">{todayDateLine()}</div>
              <h2>{personaTitle}</h2>
            </div>
            <div className="actions">
              <button className="bv-btn ghost" onClick={fetchAll} disabled={loading}>
                <ReloadOutlined /> Refresh
              </button>
              {personaCta && (
                <button className="bv-btn primary" onClick={() => navigate(personaCta.to)}>
                  <PlusOutlined /> {personaCta.label}
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
          <Spin size="large" />
        </div>
      ) : (
        <>
          {quickActions.length > 0 && (
            <div className="bavya-quickactions">
              {quickActions.map((a) => (
                <button
                  key={a.label}
                  className="bavya-quick-btn"
                  style={{ '--qa-color': a.color }}
                  onClick={a.onClick}
                >
                  <span className="bavya-quick-plus">
                    <PlusOutlined />
                  </span>
                  <span className="bavya-quick-text">
                    <span className="lbl">{a.label}</span>
                    <span className="desc">{a.desc}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {showPendingIssuance && pendingIssue.length > 0 && (
            <div className="bavya-card" style={{ marginBottom: 16 }}>
              <div className="bavya-card-hdr">
                <div>
                  <h3>Indents Pending Issuance</h3>
                  <div className="sub">
                    Approved — open one-click to issue with items pre-loaded
                  </div>
                </div>
                <button
                  className="bv-btn ghost sm"
                  onClick={() => navigate('/warehouse/material-issues')}
                >
                  View all <RightOutlined />
                </button>
              </div>
              <div className="bavya-urgent">
                {pendingIssue.map((ind) => {
                  const itemCount =
                    (ind.items?.length) || ind.item_count || 0;
                  return (
                    <div
                      className="bavya-urgent-row"
                      key={ind.id}
                      onClick={() =>
                        navigate(
                          `/warehouse/material-issues?indent_id=${ind.id}`,
                        )
                      }
                    >
                      <span className="bavya-tag" style={{ background: '#481890', color: '#fff' }}>
                        APPROVED
                      </span>
                      <div className="t">
                        <div className="title">
                          {ind.indent_number}
                          {ind.indent_type === 'urgent' && (
                            <span style={{ marginLeft: 8, color: '#D80048', fontWeight: 700 }}>
                              · URGENT
                            </span>
                          )}
                        </div>
                        <div className="meta">
                          {ind.warehouse_name || '—'} · {ind.raised_by_name || ''} · {itemCount} item{itemCount === 1 ? '' : 's'}
                          {ind.required_date && ` · need by ${formatDateTime(ind.required_date).split(' ')[0]}`}
                        </div>
                      </div>
                      <div className="ref">{ind.indent_number}</div>
                      <button
                        className="bv-btn primary sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(
                            `/warehouse/material-issues?indent_id=${ind.id}`,
                          );
                        }}
                      >
                        Issue <RightOutlined />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="bavya-kpigrid">
            {kpis.map((k) => (
              <div
                key={k.lbl}
                className="bavya-kpi"
                style={{ '--kpi-color': k.color }}
                onClick={k.onClick}
                role="button"
              >
                <div className="lbl">{k.lbl}</div>
                <div className="val">{k.val}</div>
                <div className="delta">{k.delta}</div>
                <div className="ico">{k.icon}</div>
              </div>
            ))}
          </div>

          <div className="bavya-dashrow">
            {showMrPoTrend && (
            <div className="bavya-card">
              <div className="bavya-card-hdr">
                <div>
                  <h3>Material Requests vs. Purchase Orders</h3>
                  <div className="sub">Monthly trend</div>
                </div>
                {trend && (
                  <div className="legend">
                    <span><span className="sw" style={{ background: '#D80048' }} />Requests</span>
                    <span><span className="sw" style={{ background: '#F09000' }} />POs</span>
                  </div>
                )}
              </div>
              <div className="bavya-card-body">
                {trend ? (
                  <>
                    <div className="bavya-bars">
                      {trend.map((b) => (
                        <div className="bar-col" key={b.m}>
                          <div className="bars">
                            <div
                              className="bar"
                              style={{ background: '#D80048', height: `${(b.reqs / maxBar) * 100}%` }}
                              title={`${b.reqs} MRs`}
                            />
                            <div
                              className="bar"
                              style={{ background: '#F09000', height: `${(b.pos / maxBar) * 100}%` }}
                              title={`${b.pos} POs`}
                            />
                          </div>
                          <div className="lbl">{b.m}</div>
                        </div>
                      ))}
                    </div>
                    <div className="bavya-bars-summary">
                      {trend.map((b) => (
                        <div key={b.m}>
                          <div className="num">{b.reqs}</div>
                          <div className="lbl">{b.m} · {b.pos} POs</div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="bavya-activity-empty" style={{ padding: 32 }}>
                    Trend data will appear once the backend exposes
                    <code style={{ margin: '0 4px' }}>mr_po_trend</code>
                    in <code>/dashboard/stats</code>.
                  </div>
                )}
              </div>
            </div>
            )}

            <div className="bavya-card">
              <div className="bavya-card-hdr">
                <div>
                  <h3>{isSelfScope ? 'My Recent Activity' : 'Activity'}</h3>
                  <div className="sub">
                    {isSelfScope ? 'Your last actions' : 'Across all modules'}
                  </div>
                </div>
              </div>
              <div className="bavya-activity">
                {activities.length === 0 && (
                  <div className="bavya-activity-empty">No recent activity to show.</div>
                )}
                {activities.map((a, i) => {
                  const who = a.user_name || a.user || a.created_by_name || 'System';
                  const when = a.created_at || a.timestamp || a.time;
                  const what =
                    a.description || a.message || a.title || a.action || 'logged a change';
                  const color = ACTIVITY_COLORS[i % ACTIVITY_COLORS.length];
                  return (
                    <div className="bavya-activity-item" key={i}>
                      <div className="dot" style={{ background: color }}>
                        {initials(who)}
                      </div>
                      <div className="body">
                        <div className="title">
                          <b>{who}</b> {what}
                        </div>
                        <div className="meta">{when ? formatDateTime(when) : ''}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {showUrgent && (
          <div className="bavya-card">
            <div className="bavya-card-hdr">
              <div>
                <h3>Urgent items needing attention</h3>
                <div className="sub">Auto-surfaced from stock-outs, overdue POs, and expiry watch</div>
              </div>
            </div>
            <div className="bavya-urgent">
              {urgent.length === 0 && (
                <div className="bavya-activity-empty" style={{ padding: 24 }}>
                  No urgent items right now. Nice.
                </div>
              )}
              {urgent.map((r, i) => (
                <div className="bavya-urgent-row" key={i} onClick={r.onClick}>
                  <span className={`bavya-tag ${r.tagClass}`}>{r.tag}</span>
                  <div className="t">
                    <div className="title">{r.title}</div>
                    <div className="meta">{r.meta}</div>
                  </div>
                  <div className="ref">{r.ref}</div>
                  <button className="bv-btn ghost sm">
                    Review <RightOutlined />
                  </button>
                </div>
              ))}
            </div>
          </div>
          )}
        </>
      )}
    </div>
  );
};

export default Dashboard;
