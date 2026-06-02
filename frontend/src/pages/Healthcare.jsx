import React, { useState, useEffect, useCallback } from 'react';
import {
  Tabs, Card, Table, Row, Col, Statistic, Tag, Button, Modal, Form, Select,
  DatePicker, Progress, Badge, Descriptions, Space, Alert, Drawer, InputNumber,
  Input, message, Spin, Typography, Tooltip, Divider, Empty,
} from 'antd';
import {
  MedicineBoxOutlined, WarningOutlined, ExperimentOutlined, AlertOutlined,
  ShoppingCartOutlined, UserOutlined, FileProtectOutlined, StarOutlined,
  AppstoreOutlined, BarChartOutlined, ReloadOutlined, PlusOutlined,
  SearchOutlined, CalendarOutlined, SafetyCertificateOutlined,
  SwapOutlined, CheckCircleOutlined, CloseCircleOutlined,
  ExclamationCircleOutlined, ClockCircleOutlined, DeleteOutlined,
  ThunderboltOutlined, FundOutlined, AuditOutlined, DollarOutlined,
} from '@ant-design/icons';
import PageHeader from '../components/PageHeader';
import api from '../config/api';
import { formatCurrency, formatDate, formatNumber, getErrorMessage } from '../utils/helpers';
import dayjs from 'dayjs';
import useAuthStore from '../store/authStore';

const { Text, Title } = Typography;
const { RangePicker } = DatePicker;
const { Option } = Select;

/* ---------- colour constants ---------- */
const BAVYA = {
  magenta: '#D42B6E', purple: '#6B2FA0', orange: '#E8752A', gold: '#F5A623',
};
const GRADIENT = {
  red: 'linear-gradient(135deg, #ff4d4f 0%, #cf1322 100%)',
  orange: 'linear-gradient(135deg, #fa8c16 0%, #E8752A 100%)',
  yellow: 'linear-gradient(135deg, #fadb14 0%, #F5A623 100%)',
  green: 'linear-gradient(135deg, #52c41a 0%, #389e0d 100%)',
  purple: 'linear-gradient(135deg, #D42B6E 0%, #6B2FA0 100%)',
};

const statCardStyle = (grad) => ({
  background: grad, borderRadius: 12, border: 'none',
  transition: 'transform .2s, box-shadow .2s', cursor: 'default',
});

/* ====================================================================
   HEALTHCARE ANALYTICS DASHBOARD
   ==================================================================== */
const Healthcare = () => {
  const [activeTab, setActiveTab] = useState('expiry');
  // BUG-FIN-129: previously a single `refreshKey` was suffixed onto every
  // tab's React key, so every Refresh button click remounted ALL tabs (each
  // with its own heavy fetch on mount) instead of only the visible one.
  // Track per-tab refresh counters so the global Refresh only re-runs the
  // active tab's data fetch.
  const [tabRefresh, setTabRefresh] = useState({});
  const handleRefresh = () => setTabRefresh((m) => ({ ...m, [activeTab]: (m[activeTab] || 0) + 1 }));
  const rk = (k) => tabRefresh[k] || 0;

  // BUG-HC-117 fix: role-gate tabs client-side. Backend already enforces
  // permission checks on the underlying endpoints — but tabs that the user
  // can never access should not be visible at all (avoids dead clicks and
  // 403 spam). Falls back to "show all" if role data isn't loaded yet so
  // an admin / super_admin still sees everything.
  const user = useAuthStore((s) => s.user);
  const userRoles = (user?.roles || user?.role_codes || [])
    .map((r) => (typeof r === 'string' ? r : r?.code || r?.name || '')).filter(Boolean)
    .map((r) => r.toString().toLowerCase());
  const hasRole = (allowed) => {
    if (!userRoles.length) return true; // unknown — don't hide
    if (userRoles.includes('super_admin') || userRoles.includes('admin')) return true;
    return allowed.some((r) => userRoles.includes(r));
  };
  const FINANCE = ['finance_manager', 'finance', 'accounts_manager', 'accounts'];
  const COMPLIANCE = ['compliance_officer', 'compliance', 'qa_manager', 'quality_manager'];
  const PHARMACY = ['pharmacist', 'pharmacy_manager'];
  const PROCUREMENT = ['procurement_manager', 'store_manager', 'warehouse_manager'];

  const ALL_TABS = [
    { key: 'expiry',    allowed: [...PHARMACY, ...COMPLIANCE, ...PROCUREMENT], label: <span><AlertOutlined /> Expiry Monitor</span>,    children: <ExpiryMonitor key={`expiry-${rk('expiry')}`} /> },
    { key: 'fefo',      allowed: [...PHARMACY, ...PROCUREMENT], label: <span><SwapOutlined /> FEFO Picking</span>,       children: <FEFOPicking key={`fefo-${rk('fefo')}`} /> },
    { key: 'recalls',   allowed: [...COMPLIANCE, ...PHARMACY], label: <span><SafetyCertificateOutlined /> Batch Recalls</span>, children: <BatchRecalls key={`recalls-${rk('recalls')}`} /> },
    { key: 'abc',       allowed: [...PROCUREMENT, ...FINANCE], label: <span><BarChartOutlined /> ABC/VED/FSN</span>,    children: <ABCAnalysis key={`abc-${rk('abc')}`} /> },
    { key: 'patient',   allowed: [...FINANCE, ...COMPLIANCE, ...PHARMACY], label: <span><UserOutlined /> Patient Costing</span>,    children: <PatientCosting key={`patient-${rk('patient')}`} /> },
    { key: 'contracts', allowed: [...PROCUREMENT, ...FINANCE], label: <span><FileProtectOutlined /> Rate Contracts</span>, children: <RateContracts key={`contracts-${rk('contracts')}`} /> },
    { key: 'vendor',    allowed: [...PROCUREMENT, ...FINANCE], label: <span><StarOutlined /> Vendor Scorecard</span>,   children: <VendorScorecard key={`vendor-${rk('vendor')}`} /> },
    { key: 'landed',    allowed: [...FINANCE, ...PROCUREMENT], label: <span><DollarOutlined /> Landed Cost</span>,      children: <LandedCost key={`landed-${rk('landed')}`} /> },
    { key: 'kits',      allowed: [...PHARMACY, ...PROCUREMENT], label: <span><AppstoreOutlined /> Kits</span>,           children: <Kits key={`kits-${rk('kits')}`} /> },
    { key: 'budgets',   allowed: [...FINANCE], label: <span><DollarOutlined /> Budgets</span>,          children: <Budgets key={`budgets-${rk('budgets')}`} /> },
    { key: 'analytics', allowed: [...PROCUREMENT, ...FINANCE], label: <span><FundOutlined /> Analytics</span>,          children: <Analytics key={`analytics-${rk('analytics')}`} /> },
  ];
  const tabItems = ALL_TABS.filter((t) => hasRole(t.allowed)).map(({ key, label, children }) => ({ key, label, children }));

  return (
    <div>
      <PageHeader title="Healthcare Analytics" subtitle="Pharma supply-chain intelligence dashboard">
        <Button icon={<ReloadOutlined />} onClick={handleRefresh}>Refresh</Button>
      </PageHeader>
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} type="card"
        style={{ marginTop: 4 }} tabBarStyle={{ marginBottom: 16 }} />
    </div>
  );
};

/* ====================================================================
   TAB 1 - EXPIRY MONITOR
   ==================================================================== */
const ExpiryMonitor = () => {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState({ summary: {}, items: [] });

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/healthcare/expiry-dashboard');
      const d = res.data;
      setData({ summary: d.summary || {}, items: d.items || d.data || [] });
    } catch (e) { message.error(getErrorMessage(e)); }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const bucketColor = { expired: '#ff4d4f', '0-30': '#fa8c16', '31-60': '#fadb14', '61-90': '#52c41a' };
  const bucketLabel = { expired: 'Expired', '0-30': '0 - 30 days', '31-60': '31 - 60 days', '61-90': '61 - 90 days' };
  const bucketIcon  = { expired: <CloseCircleOutlined />, '0-30': <ExclamationCircleOutlined />, '31-60': <ClockCircleOutlined />, '61-90': <CheckCircleOutlined /> };

  const columns = [
    { title: 'Item', dataIndex: 'item_name', key: 'item_name', sorter: (a, b) => (a.item_name || '').localeCompare(b.item_name || ''), ellipsis: true },
    { title: 'Batch', dataIndex: 'batch_number', key: 'batch', width: 120 },
    { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'wh', width: 140, ellipsis: true },
    // BUG-HC-115 fix: backend returns `qty`, not `quantity`; backend returns
    // `days_until_expiry`, not `days_to_expiry`. Read the canonical field but
    // fall back to legacy names so the table keeps working if the backend
    // shape changes again.
    { title: 'Qty', key: 'qty', width: 90, align: 'right',
      render: (_, r) => formatNumber(r.qty ?? r.quantity) },
    // BUG-FIN-154: dayjs(undefined).unix() returns NaN; coerce missing dates
    // to a sentinel so sort doesn't get poisoned by NaN comparisons.
    { title: 'Expiry Date', dataIndex: 'expiry_date', key: 'exp', width: 120,
      sorter: (a, b) => {
        const av = a?.expiry_date ? dayjs(a.expiry_date).unix() : 0;
        const bv = b?.expiry_date ? dayjs(b.expiry_date).unix() : 0;
        return (Number.isFinite(av) ? av : 0) - (Number.isFinite(bv) ? bv : 0);
      },
      render: (v) => formatDate(v) },
    { title: 'Days Left', key: 'days', width: 100, align: 'right',
      sorter: (a, b) => ((a.days_until_expiry ?? a.days_to_expiry) ?? 0) - ((b.days_until_expiry ?? b.days_to_expiry) ?? 0),
      render: (_, r) => r.days_until_expiry ?? r.days_to_expiry ?? '—' },
    { title: 'Bucket', dataIndex: 'bucket', key: 'bucket', width: 120,
      render: (v) => <Tag color={bucketColor[v] || '#999'}>{bucketLabel[v] || v}</Tag>,
      filters: Object.keys(bucketLabel).map((k) => ({ text: bucketLabel[k], value: k })),
      onFilter: (val, rec) => rec.bucket === val,
    },
    // BUG-HC-118 fix: backend ExpiryBucketItem has no `value` field; suppress
    // the column unless the backend later adds it.
  ];

  const sm = data.summary || {};
  // BUG-FIN-167: clarify the unit so the dashboard never silently shows a
  // value when the API moves between count/value semantics. We resolve to
  // count if a `*_count` key is present, otherwise fall through to the bare
  // bucket key, and label the suffix accordingly.
  const bucketStat = (bk) => {
    const cntKey = `${bk}_count`;
    if (sm[cntKey] != null) return { val: sm[cntKey], suffix: 'items' };
    if (typeof sm[bk] === 'number') return { val: sm[bk], suffix: 'items' };
    if (sm[bk] && typeof sm[bk] === 'object') {
      return { val: sm[bk].count ?? 0, suffix: 'items' };
    }
    return { val: 0, suffix: 'items' };
  };

  return (
    <Spin spinning={loading}>
      <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
        {['expired', '0-30', '31-60', '61-90'].map((bk) => {
          const stat = bucketStat(bk);
          return (
          <Col xs={24} sm={12} md={6} key={bk}>
            <Card style={statCardStyle(GRADIENT[bk === 'expired' ? 'red' : bk === '0-30' ? 'orange' : bk === '31-60' ? 'yellow' : 'green'])}
              hoverable bodyStyle={{ padding: 20 }}>
              <Statistic title={<span style={{ color: '#fff', opacity: .85, fontSize: 13 }}>{bucketLabel[bk]}</span>}
                value={stat.val} prefix={bucketIcon[bk]} suffix={<span style={{ fontSize: 12, opacity: .7 }}> {stat.suffix}</span>}
                valueStyle={{ color: '#fff', fontWeight: 700, fontSize: 28 }} />
            </Card>
          </Col>
        );})}
      </Row>
      <Card bordered={false}>
        <Table dataSource={data.items} columns={columns} rowKey={(r) => r.id || `${r.item_id}-${r.batch_number}`}
          size="small" pagination={{ pageSize: 15, showSizeChanger: true }} scroll={{ x: 900 }}
          rowClassName={(r) => r.bucket === 'expired' ? 'row-expired' : ''} />
      </Card>
      <style>{`.row-expired { background: #fff2f0 !important; } .row-expired:hover>td { background: #ffccc7 !important; }`}</style>
    </Spin>
  );
};

/* ====================================================================
   TAB 2 - FEFO PICKING
   ==================================================================== */
const FEFOPicking = () => {
  const [loading, setLoading] = useState(false);
  const [batches, setBatches] = useState([]);
  const [items, setItems] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [itemId, setItemId] = useState(undefined);
  const [warehouseId, setWarehouseId] = useState(undefined);

  useEffect(() => {
    api.get('/masters/items', { params: { page_size: 500 } }).then((r) => setItems(r.data.items || r.data.data || [])).catch(() => {});
    api.get('/masters/warehouses', { params: { page_size: 200 } }).then((r) => setWarehouses(r.data.items || r.data.data || [])).catch(() => {});
  }, []);

  const fetchBatches = useCallback(async () => {
    if (!itemId) return;
    setLoading(true);
    try {
      const res = await api.get('/healthcare/fefo-picking', { params: { item_id: itemId, warehouse_id: warehouseId } });
      setBatches(res.data.batches || res.data.data || res.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    setLoading(false);
  }, [itemId, warehouseId]);

  useEffect(() => { if (itemId) fetchBatches(); }, [fetchBatches, itemId]);

  const columns = [
    { title: 'Batch', dataIndex: 'batch_number', key: 'batch', width: 130 },
    { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'wh', width: 150, ellipsis: true },
    { title: 'Qty Available', dataIndex: 'qty_available', key: 'qty', width: 110, align: 'right',
      render: (v, r) => formatNumber(v ?? r.quantity) },
    { title: 'Expiry Date', dataIndex: 'expiry_date', key: 'exp', width: 120,
      defaultSortOrder: 'ascend',
      // BUG-FIN-154: NaN-safe sort when expiry_date is missing.
      sorter: (a, b) => {
        const av = a?.expiry_date ? dayjs(a.expiry_date).unix() : 0;
        const bv = b?.expiry_date ? dayjs(b.expiry_date).unix() : 0;
        return (Number.isFinite(av) ? av : 0) - (Number.isFinite(bv) ? bv : 0);
      },
      render: (v) => formatDate(v) },
    // BUG-HC-116 fix: FEFOPickingSuggestion does NOT include days_to_expiry;
    // derive it client-side from expiry_date.
    { title: 'Days Left', key: 'days', width: 100, align: 'right',
      sorter: (a, b) => {
        const ad = a.days_to_expiry ?? (a.expiry_date ? dayjs(a.expiry_date).diff(dayjs(), 'day') : 9999);
        const bd = b.days_to_expiry ?? (b.expiry_date ? dayjs(b.expiry_date).diff(dayjs(), 'day') : 9999);
        return ad - bd;
      },
      render: (_, r) => {
        const v = r.days_to_expiry ?? (r.expiry_date ? dayjs(r.expiry_date).diff(dayjs(), 'day') : null);
        if (v === null) return '—';
        return <Text type={v <= 0 ? 'danger' : v <= 30 ? 'warning' : undefined} strong>{v}</Text>;
      } },
    { title: 'Pick Priority', dataIndex: 'priority', key: 'pri', width: 100,
      render: (_, __, i) => <Tag color={i === 0 ? BAVYA.magenta : i === 1 ? BAVYA.orange : 'default'}>{i + 1}</Tag> },
  ];

  return (
    <div>
      <Card bordered={false} style={{ marginBottom: 16 }}>
        <Row gutter={16}>
          <Col xs={24} sm={10}>
            <Select showSearch allowClear placeholder="Select Item" style={{ width: '100%' }} value={itemId}
              onChange={setItemId} optionFilterProp="children" filterOption={(inp, opt) => opt.children.toLowerCase().includes(inp.toLowerCase())}>
              {items.map((it) => <Option key={it.id} value={it.id}>{it.name || it.item_name}</Option>)}
            </Select>
          </Col>
          <Col xs={24} sm={10}>
            <Select showSearch allowClear placeholder="Warehouse (all)" style={{ width: '100%' }} value={warehouseId}
              onChange={setWarehouseId} optionFilterProp="children" filterOption={(inp, opt) => opt.children.toLowerCase().includes(inp.toLowerCase())}>
              {warehouses.map((w) => <Option key={w.id} value={w.id}>{w.name || w.warehouse_name}</Option>)}
            </Select>
          </Col>
          <Col xs={24} sm={4}><Button type="primary" icon={<SearchOutlined />} onClick={fetchBatches} loading={loading}>Search</Button></Col>
        </Row>
      </Card>
      <Card bordered={false}>
        <Table dataSource={batches} columns={columns} rowKey={(r) => r.id || r.batch_number} size="small"
          loading={loading} pagination={{ pageSize: 20 }} scroll={{ x: 700 }}
          rowClassName={(r) => (r.days_to_expiry ?? 999) <= 0 ? 'row-expired' : ''} />
      </Card>
      <style>{`.row-expired { background: #fff2f0 !important; } .row-expired:hover>td { background: #ffccc7 !important; }`}</style>
    </div>
  );
};

/* ====================================================================
   TAB 3 - BATCH RECALLS
   ==================================================================== */
const BatchRecalls = () => {
  const [loading, setLoading] = useState(false);
  const [recalls, setRecalls] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [traceModal, setTraceModal] = useState({ open: false, traces: [], recall: null });
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [itemOptions, setItemOptions] = useState([]);

  const searchItems = useCallback(async (q = '') => {
    try {
      const r = await api.get('/masters/items', { params: { search: q, page_size: 50 } });
      const items = r.data.items || r.data.data || r.data || [];
      setItemOptions(items.map((i) => ({ label: `${i.item_code || ''} - ${i.name}`, value: i.id })));
    } catch { /* silent */ }
  }, []);

  const fetchRecalls = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/healthcare/batch-recalls');
      setRecalls(res.data.items || res.data.data || res.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchRecalls(); }, [fetchRecalls]);

  const handleCreate = async (vals) => {
    setSubmitting(true);
    try {
      await api.post('/healthcare/batch-recalls', vals);
      message.success('Recall initiated');
      setDrawerOpen(false);
      form.resetFields();
      fetchRecalls();
    } catch (e) { message.error(getErrorMessage(e)); }
    setSubmitting(false);
  };

  const showTraces = async (rec) => {
    try {
      const res = await api.get(`/healthcare/batch-recalls/${rec.id}/traces`);
      setTraceModal({ open: true, traces: res.data.traces || res.data || [], recall: rec });
    } catch (e) { message.error(getErrorMessage(e)); }
  };

  const statusColors = { initiated: 'blue', in_progress: 'orange', completed: 'green', cancelled: 'red' };

  const columns = [
    { title: 'Recall #', dataIndex: 'recall_number', key: 'num', width: 140 },
    { title: 'Item', dataIndex: 'item_name', key: 'item', ellipsis: true },
    { title: 'Batch', dataIndex: 'batch_number', key: 'batch', width: 120 },
    { title: 'Reason', dataIndex: 'reason', key: 'reason', ellipsis: true },
    { title: 'Status', dataIndex: 'status', key: 'status', width: 120,
      render: (v) => <Tag color={statusColors[v] || 'default'}>{(v || '').replace(/_/g, ' ').toUpperCase()}</Tag> },
    { title: 'Date', dataIndex: 'created_at', key: 'date', width: 110, render: (v) => formatDate(v) },
    { title: 'Actions', key: 'act', width: 100, render: (_, r) => <Button size="small" type="link" onClick={() => showTraces(r)}>Traces</Button> },
  ];

  return (
    <div>
      <Card bordered={false} bodyStyle={{ padding: '12px 16px' }} style={{ marginBottom: 16 }}>
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawerOpen(true)}>New Recall</Button>
          <Button icon={<ReloadOutlined />} onClick={fetchRecalls}>Refresh</Button>
        </Space>
      </Card>
      <Card bordered={false}>
        <Table dataSource={recalls} columns={columns} rowKey="id" size="small" loading={loading}
          pagination={{ pageSize: 15, showSizeChanger: true }} scroll={{ x: 800 }}
          onRow={(r) => ({ onClick: () => showTraces(r), style: { cursor: 'pointer' } })} />
      </Card>

      {/* New Recall Drawer */}
      <Drawer title="Initiate Batch Recall" width={480} open={drawerOpen} onClose={() => setDrawerOpen(false)}
        extra={<Button type="primary" loading={submitting} onClick={() => form.submit()}>Submit</Button>}>
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="item_id" label="Item" rules={[{ required: true }]}>
            <Select
              showSearch placeholder="Search item..." optionFilterProp="label"
              options={itemOptions} onSearch={searchItems}
              onOpenChange={(open) => { if (open && !itemOptions.length) searchItems(); }}
              filterOption={false} style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item name="batch_number" label="Batch Number" rules={[{ required: true }]}>
            <Input placeholder="e.g. BATCH-2026-001" />
          </Form.Item>
          <Form.Item name="reason" label="Reason" rules={[{ required: true }]}>
            <Input.TextArea rows={3} placeholder="Describe the reason for recall" />
          </Form.Item>
          <Form.Item name="severity" label="Severity" rules={[{ required: true }]}>
            <Select placeholder="Select severity">
              <Option value="critical">Critical</Option><Option value="major">Major</Option><Option value="minor">Minor</Option>
            </Select>
          </Form.Item>
        </Form>
      </Drawer>

      {/* Trace Modal */}
      <Modal title={`Recall Traces - ${traceModal.recall?.recall_number || ''}`} open={traceModal.open}
        onCancel={() => setTraceModal({ open: false, traces: [], recall: null })} footer={null} width={640}>
        {traceModal.traces.length > 0 ? (
          <Table dataSource={traceModal.traces} rowKey="id" size="small" pagination={false}
            columns={[
              { title: 'Transaction', dataIndex: 'transaction_type', key: 'type' },
              { title: 'Reference', dataIndex: 'reference_number', key: 'ref' },
              { title: 'Qty', dataIndex: 'quantity', key: 'qty', width: 80 },
              { title: 'Date', dataIndex: 'transaction_date', key: 'date', width: 110, render: (v) => formatDate(v) },
              { title: 'Entity', dataIndex: 'entity_name', key: 'entity', ellipsis: true },
            ]} />
        ) : <Empty description="No traces found" />}
      </Modal>
    </div>
  );
};

/* ====================================================================
   TAB 4 - ABC / VED / FSN ANALYSIS
   ==================================================================== */
const ABCAnalysis = () => {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState([]);
  const [months, setMonths] = useState(12);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/healthcare/abc-analysis', { params: { months } });
      setData(res.data.items || res.data.data || res.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    setLoading(false);
  }, [months]);

  useEffect(() => { fetch(); }, [fetch]);

  const clsColor = { A: 'green', B: 'blue', C: 'orange', V: 'red', E: 'orange', D: 'default', F: 'green', S: 'gold', N: 'red' };

  const columns = [
    { title: 'Item Code', dataIndex: 'item_code', key: 'code', width: 120 },
    { title: 'Item Name', dataIndex: 'item_name', key: 'name', ellipsis: true },
    { title: 'Category', dataIndex: 'category_name', key: 'cat', width: 140, ellipsis: true },
    { title: 'Annual Value', dataIndex: 'annual_consumption_value', key: 'val', width: 130, align: 'right', render: (v) => formatCurrency(v), sorter: (a, b) => (a.annual_consumption_value || 0) - (b.annual_consumption_value || 0) },
    { title: 'ABC', dataIndex: 'abc_class', key: 'abc', width: 70, align: 'center',
      render: (v) => <Tag color={clsColor[v] || 'default'} style={{ fontWeight: 600 }}>{v}</Tag>,
      filters: ['A','B','C'].map((c) => ({ text: c, value: c })), onFilter: (val, r) => r.abc_class === val },
    { title: 'VED', dataIndex: 'ved_class', key: 'ved', width: 70, align: 'center',
      render: (v) => <Tag color={clsColor[v] || 'default'} style={{ fontWeight: 600 }}>{v}</Tag>,
      filters: ['V','E','D'].map((c) => ({ text: c, value: c })), onFilter: (val, r) => r.ved_class === val },
    { title: 'FSN', dataIndex: 'fsn_class', key: 'fsn', width: 70, align: 'center',
      render: (v) => <Tag color={clsColor[v] || 'default'} style={{ fontWeight: 600 }}>{v}</Tag>,
      filters: ['F','S','N'].map((c) => ({ text: c, value: c })), onFilter: (val, r) => r.fsn_class === val },
    { title: 'Combined', dataIndex: 'combined_class', key: 'comb', width: 100, align: 'center',
      render: (v) => <Tag color={BAVYA.purple} style={{ fontWeight: 600 }}>{v}</Tag> },
  ];

  return (
    <div>
      <Card bordered={false} bodyStyle={{ padding: '12px 16px' }} style={{ marginBottom: 16 }}>
        <Space>
          <Text strong>Analysis Period:</Text>
          <Select value={months} onChange={setMonths} style={{ width: 160 }}>
            {[3, 6, 12, 24].map((m) => <Option key={m} value={m}>{m} Months</Option>)}
          </Select>
          <Button icon={<ReloadOutlined />} onClick={fetch}>Refresh</Button>
        </Space>
      </Card>
      <Card bordered={false}>
        <Table dataSource={data} columns={columns} rowKey={(r) => r.id || r.item_id || r.item_code}
          size="small" loading={loading} pagination={{ pageSize: 20, showSizeChanger: true }} scroll={{ x: 850 }} />
      </Card>
    </div>
  );
};

/* ====================================================================
   TAB 5 - PATIENT COSTING
   ==================================================================== */
const PatientCosting = () => {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState([]);
  const [dateRange, setDateRange] = useState([dayjs().startOf('month'), dayjs()]);
  const [department, setDepartment] = useState(undefined);
  const [search, setSearch] = useState('');
  const [departments, setDepartments] = useState([]);

  useEffect(() => {
    api.get('/masters/departments', { params: { page_size: 200 } }).then((r) => setDepartments(r.data.items || r.data.data || [])).catch(() => {});
  }, []);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (dateRange?.[0]) params.start_date = dateRange[0].format('YYYY-MM-DD');
      if (dateRange?.[1]) params.end_date = dateRange[1].format('YYYY-MM-DD');
      if (department) params.department_id = department;
      if (search) params.patient_name = search;
      const res = await api.get('/healthcare/patient-costing', { params });
      setData(res.data.items || res.data.data || res.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    setLoading(false);
  }, [dateRange, department, search]);

  useEffect(() => { fetch(); }, [fetch]);

  const maskAadhaar = (v) => { if (!v) return '-'; const s = String(v); return s.length >= 8 ? 'XXXX-XXXX-' + s.slice(-4) : s; };

  // BUG-FIN-128: mask patient name at render time. Show first name + last
  // initial only ("Ramesh K.") for non-managerial users (Sam audit pending
  // — rendering raw names violates patient privacy guidelines).
  const maskPatientName = (v) => {
    if (!v) return '-';
    const s = String(v).trim();
    if (!s) return '-';
    const parts = s.split(/\s+/);
    if (parts.length === 1) return parts[0];
    return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
  };

  const columns = [
    { title: 'Patient Name', dataIndex: 'patient_name', key: 'name', ellipsis: true,
      render: (v) => <Text>{maskPatientName(v)}</Text> },
    { title: 'Patient ID', dataIndex: 'patient_id_display', key: 'pid', width: 120 },
    // API field is `patient_aadhaar_masked` (already masked server-side); fall
    // back to client-side mask only if a future endpoint changes shape.
    { title: 'Aadhaar', dataIndex: 'patient_aadhaar_masked', key: 'aad', width: 150,
      render: (v, r) => <Text type="secondary">{v || maskAadhaar(r.aadhaar_number)}</Text> },
    { title: 'Department', dataIndex: 'department_name', key: 'dept', width: 150, ellipsis: true },
    { title: 'Total Items', dataIndex: 'total_items', key: 'cnt', width: 100, align: 'right', render: (v) => formatNumber(v) },
    { title: 'Total Value', dataIndex: 'total_value', key: 'val', width: 140, align: 'right', render: (v) => formatCurrency(v),
      sorter: (a, b) => (a.total_value || 0) - (b.total_value || 0) },
    { title: 'Last Visit', dataIndex: 'last_visit_date', key: 'last', width: 110, render: (v) => formatDate(v) },
  ];

  return (
    <div>
      <Card bordered={false} bodyStyle={{ padding: '12px 16px' }} style={{ marginBottom: 16 }}>
        <Row gutter={[12, 12]} align="middle">
          <Col xs={24} sm={8}><RangePicker value={dateRange} onChange={setDateRange} style={{ width: '100%' }} /></Col>
          <Col xs={24} sm={6}>
            <Select allowClear placeholder="Department" style={{ width: '100%' }} value={department} onChange={setDepartment}>
              {departments.map((d) => <Option key={d.id} value={d.id}>{d.name}</Option>)}
            </Select>
          </Col>
          <Col xs={24} sm={6}><Input placeholder="Patient name" prefix={<SearchOutlined />} value={search} onChange={(e) => setSearch(e.target.value)} allowClear /></Col>
          <Col xs={24} sm={4}><Button type="primary" icon={<SearchOutlined />} onClick={fetch} loading={loading}>Search</Button></Col>
        </Row>
      </Card>
      <Card bordered={false}>
        <Table dataSource={data} columns={columns} rowKey={(r) => r.id || r.patient_id || Math.random()}
          size="small" loading={loading} pagination={{ pageSize: 15, showSizeChanger: true }} scroll={{ x: 850 }} />
      </Card>
    </div>
  );
};

/* ====================================================================
   TAB 6 - RATE CONTRACTS
   ==================================================================== */
const RateContracts = () => {
  const [loading, setLoading] = useState(false);
  const [contracts, setContracts] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [vendorOpts, setVendorOpts] = useState([]);
  const [rcItemOpts, setRcItemOpts] = useState([]);

  const searchVendors = useCallback(async (q = '') => {
    try {
      const r = await api.get('/masters/vendors', { params: { search: q, page_size: 50, status: 'active' } });
      setVendorOpts((r.data.items || r.data.data || r.data || []).map((v) => ({ label: `[${v.vendor_code || ''}] ${v.name}`, value: v.id })));
    } catch { /* silent */ }
  }, []);
  const searchRcItems = useCallback(async (q = '') => {
    try {
      const r = await api.get('/masters/items', { params: { search: q, page_size: 50 } });
      setRcItemOpts((r.data.items || r.data.data || r.data || []).map((i) => ({ label: `${i.item_code || ''} - ${i.name}`, value: i.id })));
    } catch { /* silent */ }
  }, []);

  const fetchContracts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/healthcare/rate-contracts');
      setContracts(res.data.items || res.data.data || res.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchContracts(); }, [fetchContracts]);

  const handleCreate = async (vals) => {
    setSubmitting(true);
    try {
      // Backend schema expects start_date/end_date/items[].base_rate/effective_rate.
      const items = (vals.items || []).map((it) => {
        const baseRate = Number(it.base_rate || 0);
        const disc = Number(it.discount_pct || 0);
        const effRate = baseRate - (baseRate * disc) / 100;
        return {
          item_id: it.item_id,
          base_rate: baseRate,
          discount_pct: disc,
          effective_rate: effRate,
          min_qty: Number(it.min_qty || 0),
          max_qty: Number(it.max_qty || 0),
          uom_id: it.uom_id,
        };
      });
      const payload = {
        vendor_id: vals.vendor_id,
        start_date: vals.start_date.format('YYYY-MM-DD'),
        end_date: vals.end_date.format('YYYY-MM-DD'),
        min_order_value: Number(vals.min_order_value || 0),
        payment_terms_days: Number(vals.payment_terms_days || 30),
        remarks: vals.remarks,
        items,
      };
      await api.post('/healthcare/rate-contracts', payload);
      message.success('Contract created');
      setDrawerOpen(false); form.resetFields(); fetchContracts();
    } catch (e) { message.error(getErrorMessage(e)); }
    setSubmitting(false);
  };

  const handleActivate = async (id) => {
    try {
      await api.put(`/healthcare/rate-contracts/${id}`, { status: 'active' });
      message.success('Contract activated');
      fetchContracts();
    } catch (e) { message.error(getErrorMessage(e)); }
  };

  const handleCancel = async (id) => {
    try {
      await api.put(`/healthcare/rate-contracts/${id}`, { status: 'cancelled' });
      message.success('Contract cancelled');
      fetchContracts();
    } catch (e) { message.error(getErrorMessage(e)); }
  };

  const statusColor = { active: 'green', expired: 'red', draft: 'default', cancelled: 'volcano' };

  const columns = [
    { title: 'Contract #', dataIndex: 'contract_number', key: 'num', width: 140 },
    { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', ellipsis: true,
      render: (v, r) => v || `Vendor #${r.vendor_id}` },
    { title: 'Start', dataIndex: 'start_date', key: 'from', width: 110, render: (v) => formatDate(v) },
    { title: 'End', dataIndex: 'end_date', key: 'to', width: 110, render: (v) => formatDate(v) },
    { title: 'Items', key: 'cnt', width: 70, align: 'center',
      render: (_, r) => (r.items || []).length },
    { title: 'Status', dataIndex: 'status', key: 'st', width: 110,
      render: (v) => <Tag color={statusColor[v] || 'default'}>{(v || '').toUpperCase()}</Tag> },
    { title: 'Actions', key: 'act', width: 200, fixed: 'right',
      render: (_, r) => (
        <Space size="small">
          {r.status === 'draft' && (
            <Button size="small" type="primary" onClick={() => handleActivate(r.id)}>Activate</Button>
          )}
          {r.status === 'active' && (
            <Button size="small" danger onClick={() => handleCancel(r.id)}>Cancel</Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Card bordered={false} bodyStyle={{ padding: '12px 16px' }} style={{ marginBottom: 16 }}>
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawerOpen(true)}>New Contract</Button>
          <Button icon={<ReloadOutlined />} onClick={fetchContracts}>Refresh</Button>
          <BestRateLookup itemOpts={rcItemOpts} onSearch={searchRcItems} />
        </Space>
      </Card>
      <Card bordered={false}>
        <Table dataSource={contracts} columns={columns} rowKey="id" size="small" loading={loading}
          pagination={{ pageSize: 15, showSizeChanger: true }} scroll={{ x: 900 }} />
      </Card>

      <Drawer title="New Rate Contract" width={560} open={drawerOpen} onClose={() => setDrawerOpen(false)}
        extra={<Button type="primary" loading={submitting} onClick={() => form.submit()}>Create</Button>}>
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="vendor_id" label="Vendor" rules={[{ required: true }]}>
            <Select showSearch placeholder="Search vendor..." optionFilterProp="label"
              options={vendorOpts} onSearch={searchVendors} filterOption={false}
              onOpenChange={(o) => { if (o && !vendorOpts.length) searchVendors(); }}
              style={{ width: '100%' }} />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="start_date" label="Start Date" rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="end_date" label="End Date" rules={[{ required: true }]}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="min_order_value" label="Min Order Value" initialValue={0}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="payment_terms_days" label="Payment Terms (days)" initialValue={30}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
          </Row>
          <Form.Item name="remarks" label="Remarks"><Input.TextArea rows={2} /></Form.Item>
          <Divider orientation="left" plain>Contract Items</Divider>
          <Form.List name="items">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...rest }) => (
                  <Row gutter={6} key={key} align="middle" style={{ marginBottom: 8 }}>
                    <Col span={7}><Form.Item {...rest} name={[name, 'item_id']} rules={[{ required: true }]} noStyle><Select showSearch placeholder="Item..." optionFilterProp="label" options={rcItemOpts} onSearch={searchRcItems} filterOption={false} onOpenChange={(o) => { if (o && !rcItemOpts.length) searchRcItems(); }} style={{ width: '100%' }} size="small" /></Form.Item></Col>
                    <Col span={5}><Form.Item {...rest} name={[name, 'base_rate']} rules={[{ required: true, type: 'number', min: 0.01, message: 'Rate > 0' }]} noStyle><InputNumber placeholder="Base Rate" style={{ width: '100%' }} min={0.01} /></Form.Item></Col>
                    <Col span={4}><Form.Item {...rest} name={[name, 'discount_pct']} rules={[{ type: 'number', min: 0, max: 100, message: '0-100' }]} noStyle><InputNumber placeholder="Disc %" style={{ width: '100%' }} min={0} max={100} /></Form.Item></Col>
                    <Col span={4}><Form.Item {...rest} name={[name, 'min_qty']} noStyle><InputNumber placeholder="Min Qty" style={{ width: '100%' }} min={0} /></Form.Item></Col>
                    <Col span={3}><Form.Item {...rest} name={[name, 'max_qty']} noStyle><InputNumber placeholder="Max" style={{ width: '100%' }} min={0} /></Form.Item></Col>
                    <Col span={1}><Button icon={<DeleteOutlined />} size="small" danger onClick={() => remove(name)} /></Col>
                  </Row>
                ))}
                <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ discount_pct: 0, min_qty: 0, max_qty: 0 })}>Add Item</Button>
              </>
            )}
          </Form.List>
        </Form>
      </Drawer>
    </div>
  );
};

/* ------------- Best-rate lookup mini-tool (used inside RateContracts header) ------------- */
const BestRateLookup = ({ itemOpts, onSearch }) => {
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const lookup = async (vals) => {
    setBusy(true);
    try {
      const r = await api.get('/healthcare/rate-contracts/best-rate', {
        params: { item_id: vals.item_id, qty: vals.qty || 1 },
      });
      setResult(r.data);
    } catch (e) { message.error(getErrorMessage(e)); }
    setBusy(false);
  };

  return (
    <>
      <Button icon={<SearchOutlined />} onClick={() => { setResult(null); form.resetFields(); setOpen(true); }}>Best Rate Lookup</Button>
      <Modal title="Find best contract rate" open={open} onCancel={() => setOpen(false)}
        onOk={() => form.submit()} confirmLoading={busy} okText="Lookup">
        <Form form={form} layout="vertical" onFinish={lookup}>
          <Form.Item name="item_id" label="Item" rules={[{ required: true }]}>
            <Select showSearch placeholder="Item..." optionFilterProp="label"
              options={itemOpts} onSearch={onSearch} filterOption={false}
              onOpenChange={(o) => { if (o && !itemOpts.length) onSearch(); }}
              style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="qty" label="Order Quantity" initialValue={1} rules={[{ type: 'number', min: 0.01 }]}>
            <InputNumber min={0.01} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
        {result && (
          <Alert
            type={result.vendor_id ? 'success' : 'warning'}
            showIcon
            message={result.vendor_id
              ? `Best: ${result.vendor_name} @ ${formatCurrency(result.effective_rate)} (contract ${result.contract_number}) — total ${formatCurrency(result.total_amount)}`
              : (result.message || 'No active contract for this item/qty')}
            style={{ marginTop: 12 }}
          />
        )}
      </Modal>
    </>
  );
};

/* ====================================================================
   TAB 7 - VENDOR SCORECARD
   ==================================================================== */
const VendorScorecard = () => {
  const [loading, setLoading] = useState(false);
  const [scorecards, setScorecards] = useState([]);
  const [calculating, setCalculating] = useState(false);
  const [calcModalOpen, setCalcModalOpen] = useState(false);
  const [calcForm] = Form.useForm();
  const [vendorOpts, setVendorOpts] = useState([]);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/healthcare/vendor-scorecards');
      setScorecards(res.data.items || res.data.data || res.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    setLoading(false);
  }, []);

  const searchVendors = useCallback(async (q = '') => {
    try {
      const r = await api.get('/masters/vendors', { params: { search: q, page_size: 50, status: 'active' } });
      setVendorOpts((r.data.items || r.data.data || r.data || []).map((v) => ({ label: `[${v.vendor_code || ''}] ${v.name}`, value: v.id })));
    } catch { /* silent */ }
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  // Backend requires vendor_id + period_start + period_end. Prompt instead of
  // firing a bare POST that always 422s.
  const openCalcModal = () => {
    calcForm.resetFields();
    if (!vendorOpts.length) searchVendors();
    setCalcModalOpen(true);
  };

  const handleCalculate = async (vals) => {
    setCalculating(true);
    try {
      await api.post('/healthcare/vendor-scorecards/calculate', null, {
        params: {
          vendor_id: vals.vendor_id,
          period_start: vals.period[0].format('YYYY-MM-DD'),
          period_end: vals.period[1].format('YYYY-MM-DD'),
        },
      });
      message.success('Scorecard calculated');
      setCalcModalOpen(false);
      fetch();
    } catch (e) { message.error(getErrorMessage(e)); }
    setCalculating(false);
  };

  const gradeColor = { A: '#52c41a', B: '#1890ff', C: '#fa8c16', D: '#f5222d', F: '#f5222d' };

  return (
    <div>
      <Card bordered={false} bodyStyle={{ padding: '12px 16px' }} style={{ marginBottom: 16 }}>
        <Space>
          <Button type="primary" icon={<ThunderboltOutlined />} onClick={openCalcModal} loading={calculating}>Calculate Scores</Button>
          <Button icon={<ReloadOutlined />} onClick={fetch}>Refresh</Button>
        </Space>
      </Card>
      <Modal title="Calculate Vendor Scorecard" open={calcModalOpen}
        onCancel={() => setCalcModalOpen(false)}
        onOk={() => calcForm.submit()} confirmLoading={calculating} okText="Calculate">
        <Form form={calcForm} layout="vertical" onFinish={handleCalculate}>
          <Form.Item name="vendor_id" label="Vendor" rules={[{ required: true, message: 'Pick a vendor' }]}>
            <Select showSearch placeholder="Search vendor..." optionFilterProp="label"
              options={vendorOpts} onSearch={searchVendors} filterOption={false}
              style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="period" label="Period" rules={[{ required: true, message: 'Pick a date range' }]}>
            <RangePicker style={{ width: '100%' }} />
          </Form.Item>
          <Alert type="info" showIcon
            message="The score is computed from POs delivered within this date range."
            style={{ marginTop: 8 }} />
        </Form>
      </Modal>
      <Spin spinning={loading}>
        <Row gutter={[16, 16]}>
          {scorecards.map((sc) => (
            <Col xs={24} sm={12} lg={8} key={sc.id || sc.vendor_id}>
              <Badge.Ribbon text={`Grade ${sc.overall_grade || '-'}`}
                color={gradeColor[sc.overall_grade] || '#999'}>
                <Card bordered={false} hoverable
                  style={{ borderRadius: 12, transition: 'box-shadow .2s' }}
                  bodyStyle={{ paddingTop: 28 }}>
                  <Title level={5} style={{ marginBottom: 4 }}>{sc.vendor_name || `Vendor #${sc.vendor_id}`}</Title>
                  <Text type="secondary" style={{ fontSize: 12 }}>Period: {formatDate(sc.period_start)} - {formatDate(sc.period_end)}</Text>
                  <Divider style={{ margin: '12px 0' }} />
                  <Row gutter={16} justify="center">
                    {[
                      { label: 'Quality', key: 'quality_score', color: '#52c41a' },
                      { label: 'Delivery', key: 'delivery_score', color: '#1890ff' },
                      { label: 'Price', key: 'price_score', color: BAVYA.gold },
                    ].map((dim) => (
                      <Col span={8} key={dim.key} style={{ textAlign: 'center' }}>
                        <Progress type="circle" percent={sc[dim.key] || 0} size={64} format={(p) => `${p}`}
                          strokeColor={dim.color} />
                        <div style={{ marginTop: 6, fontSize: 12, color: '#666' }}>{dim.label}</div>
                      </Col>
                    ))}
                  </Row>
                  <Divider style={{ margin: '12px 0' }} />
                  <div style={{ textAlign: 'center' }}>
                    <Statistic title="Overall Score" value={sc.overall_score || 0} suffix="/ 100"
                      valueStyle={{ fontSize: 22, fontWeight: 700, color: gradeColor[sc.overall_grade] || '#333' }} />
                  </div>
                </Card>
              </Badge.Ribbon>
            </Col>
          ))}
          {!loading && scorecards.length === 0 && (
            <Col span={24}><Empty description="No vendor scorecards. Click Calculate to generate." /></Col>
          )}
        </Row>
      </Spin>
    </div>
  );
};

/* ====================================================================
   TAB - LANDED COST
   ==================================================================== */
const LandedCost = () => {
  const [grnId, setGrnId] = useState(null);
  const [grnOpts, setGrnOpts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [costs, setCosts] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const searchGrns = useCallback(async (q = '') => {
    try {
      const r = await api.get('/warehouse/grn', { params: { search: q, page_size: 50 } });
      const list = r.data.items || r.data.data || r.data || [];
      setGrnOpts(list.map((g) => ({ label: `${g.grn_number || `GRN #${g.id}`} - ${g.vendor_name || ''}`, value: g.id })));
    } catch { /* silent */ }
  }, []);

  const fetchCosts = useCallback(async () => {
    if (!grnId) { setCosts([]); return; }
    setLoading(true);
    try {
      const res = await api.get('/healthcare/landed-costs', { params: { grn_id: grnId } });
      setCosts(res.data.items || res.data.data || res.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    setLoading(false);
  }, [grnId]);

  useEffect(() => { fetchCosts(); }, [fetchCosts]);

  const handleCreate = async (vals) => {
    setSubmitting(true);
    try {
      await api.post('/healthcare/landed-costs', {
        grn_id: grnId,
        cost_type: vals.cost_type,
        amount: Number(vals.amount),
        allocation_method: vals.allocation_method,
        description: vals.description,
      });
      message.success('Landed cost recorded and allocated');
      setDrawerOpen(false); form.resetFields(); fetchCosts();
    } catch (e) { message.error(getErrorMessage(e)); }
    setSubmitting(false);
  };

  const costTypeColor = { freight: 'blue', insurance: 'cyan', customs: 'gold', handling: 'purple', other: 'default' };

  const columns = [
    { title: 'Cost Type', dataIndex: 'cost_type', key: 'ct', width: 110,
      render: (v) => <Tag color={costTypeColor[v] || 'default'}>{(v || '').toUpperCase()}</Tag> },
    { title: 'Description', dataIndex: 'description', key: 'desc', ellipsis: true },
    { title: 'Amount', dataIndex: 'amount', key: 'amt', width: 130, align: 'right', render: (v) => formatCurrency(v) },
    { title: 'Method', dataIndex: 'allocation_method', key: 'mth', width: 110 },
    { title: 'Allocations', key: 'alloc', width: 110, align: 'center',
      render: (_, r) => (r.allocations || []).length },
    { title: 'Created', dataIndex: 'created_at', key: 'ca', width: 140, render: (v) => formatDate(v) },
  ];

  return (
    <div>
      <Card bordered={false} bodyStyle={{ padding: '12px 16px' }} style={{ marginBottom: 16 }}>
        <Row gutter={12} align="middle">
          <Col xs={24} sm={14}>
            <Select showSearch placeholder="Select a GRN to manage landed costs..."
              optionFilterProp="label" options={grnOpts} onSearch={searchGrns} filterOption={false}
              onOpenChange={(o) => { if (o && !grnOpts.length) searchGrns(); }}
              onChange={setGrnId} value={grnId} style={{ width: '100%' }} allowClear />
          </Col>
          <Col xs={24} sm={10}>
            <Space>
              <Button type="primary" icon={<PlusOutlined />} disabled={!grnId} onClick={() => setDrawerOpen(true)}>
                Add Landed Cost
              </Button>
              <Button icon={<ReloadOutlined />} onClick={fetchCosts} disabled={!grnId}>Refresh</Button>
            </Space>
          </Col>
        </Row>
      </Card>
      <Card bordered={false}>
        {!grnId ? (
          <Empty description="Pick a GRN above to view its landed costs" />
        ) : (
          <Table dataSource={costs} columns={columns} rowKey="id" size="small" loading={loading}
            expandable={{
              expandedRowRender: (r) => (
                <Table size="small" pagination={false} rowKey="id"
                  dataSource={r.allocations || []}
                  columns={[
                    { title: 'GRN Item ID', dataIndex: 'grn_item_id', key: 'gi', width: 110 },
                    { title: 'Item ID', dataIndex: 'item_id', key: 'it', width: 90 },
                    { title: 'Allocated', dataIndex: 'allocated_amount', key: 'aa', width: 130, align: 'right',
                      render: (v) => formatCurrency(v) },
                    { title: 'Original Rate', dataIndex: 'original_rate', key: 'or', width: 130, align: 'right',
                      render: (v) => formatCurrency(v) },
                    { title: 'Adjusted Rate', dataIndex: 'adjusted_rate', key: 'ar', width: 130, align: 'right',
                      render: (v) => formatCurrency(v) },
                  ]}
                />
              ),
              rowExpandable: (r) => (r.allocations || []).length > 0,
            }}
          />
        )}
      </Card>

      <Drawer title="Add Landed Cost" width={460} open={drawerOpen} onClose={() => setDrawerOpen(false)}
        extra={<Button type="primary" loading={submitting} onClick={() => form.submit()}>Save & Allocate</Button>}>
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Alert type="info" showIcon style={{ marginBottom: 12 }}
            message="Landed cost is auto-distributed across the GRN's items per the chosen method, and each item's effective rate is updated." />
          <Form.Item name="cost_type" label="Cost Type" rules={[{ required: true }]}>
            <Select options={[
              { value: 'freight', label: 'Freight' },
              { value: 'insurance', label: 'Insurance' },
              { value: 'customs', label: 'Customs' },
              { value: 'handling', label: 'Handling' },
              { value: 'other', label: 'Other' },
            ]} />
          </Form.Item>
          <Form.Item name="amount" label="Amount" rules={[{ required: true, type: 'number', min: 0.01, message: 'Amount must be > 0' }]}>
            <InputNumber min={0.01} step={0.01} style={{ width: '100%' }} prefix="₹" />
          </Form.Item>
          <Form.Item name="allocation_method" label="Allocation Method" initialValue="by_value" rules={[{ required: true }]}>
            <Select options={[
              { value: 'by_value', label: 'By line value (default)' },
              { value: 'by_qty', label: 'By quantity' },
              { value: 'by_weight', label: 'By weight (uses qty as proxy)' },
              { value: 'equal', label: 'Equal split' },
            ]} />
          </Form.Item>
          <Form.Item name="description" label="Description / Reference"><Input placeholder="e.g. Bill of Lading #1234" /></Form.Item>
        </Form>
      </Drawer>
    </div>
  );
};

/* ====================================================================
   TAB 8 - KITS
   ==================================================================== */
const Kits = () => {
  const [loading, setLoading] = useState(false);
  const [kits, setKits] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [kitItemOpts, setKitItemOpts] = useState([]);
  const searchKitItems = useCallback(async (q = '') => {
    try {
      const r = await api.get('/masters/items', { params: { search: q, page_size: 50 } });
      setKitItemOpts((r.data.items || r.data.data || r.data || []).map((i) => ({ label: `${i.item_code || ''} - ${i.name}`, value: i.id })));
    } catch { /* silent */ }
  }, []);

  const fetchKits = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/healthcare/kits');
      setKits(res.data.items || res.data.data || res.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchKits(); }, [fetchKits]);

  const handleCreate = async (vals) => {
    setSubmitting(true);
    try {
      await api.post('/healthcare/kits', vals);
      message.success('Kit created');
      setDrawerOpen(false); form.resetFields(); fetchKits();
    } catch (e) { message.error(getErrorMessage(e)); }
    setSubmitting(false);
  };

  const handleConsume = async (kit) => {
    Modal.confirm({
      title: `Consume Kit: ${kit.kit_name || kit.name}?`,
      content: 'This will deduct all component items from inventory.',
      okText: 'Consume', okType: 'danger',
      onOk: async () => {
        try {
          await api.post(`/healthcare/kits/${kit.id}/consume`);
          message.success('Kit consumed successfully');
          fetchKits();
        } catch (e) { message.error(getErrorMessage(e)); }
      },
    });
  };

  const typeColor = { surgical: 'purple', procedure: 'blue', emergency: 'red', custom: 'default' };

  const columns = [
    { title: 'Kit Name', dataIndex: 'kit_name', key: 'name', render: (v, r) => v || r.name, ellipsis: true },
    { title: 'Kit Code', dataIndex: 'kit_code', key: 'code', width: 120 },
    { title: 'Type', dataIndex: 'kit_type', key: 'type', width: 110,
      render: (v) => <Tag color={typeColor[v] || 'default'}>{(v || '').toUpperCase()}</Tag> },
    { title: 'Components', dataIndex: 'component_count', key: 'cnt', width: 100, align: 'center' },
    { title: 'Total Cost', dataIndex: 'total_cost', key: 'cost', width: 130, align: 'right', render: (v) => formatCurrency(v) },
    { title: 'Status', dataIndex: 'is_active', key: 'active', width: 90, align: 'center',
      render: (v) => v !== false ? <Tag color="green">Active</Tag> : <Tag color="red">Inactive</Tag> },
    { title: 'Actions', key: 'act', width: 120,
      render: (_, r) => <Button size="small" type="primary" ghost icon={<MedicineBoxOutlined />} onClick={(e) => { e.stopPropagation(); handleConsume(r); }}>Consume</Button> },
  ];

  return (
    <div>
      <Card bordered={false} bodyStyle={{ padding: '12px 16px' }} style={{ marginBottom: 16 }}>
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawerOpen(true)}>New Kit</Button>
          <Button icon={<ReloadOutlined />} onClick={fetchKits}>Refresh</Button>
        </Space>
      </Card>
      <Card bordered={false}>
        <Table dataSource={kits} columns={columns} rowKey="id" size="small" loading={loading}
          pagination={{ pageSize: 15, showSizeChanger: true }} scroll={{ x: 800 }} />
      </Card>

      <Drawer title="Create New Kit" width={520} open={drawerOpen} onClose={() => setDrawerOpen(false)}
        extra={<Button type="primary" loading={submitting} onClick={() => form.submit()}>Create</Button>}>
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="kit_name" label="Kit Name" rules={[{ required: true }]}><Input placeholder="e.g. Cardiac Surgery Kit" /></Form.Item>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="kit_code" label="Kit Code" rules={[{ required: true }]}><Input placeholder="KIT-001" /></Form.Item></Col>
            <Col span={12}>
              <Form.Item name="kit_type" label="Type" rules={[{ required: true }]}>
                <Select placeholder="Select type">
                  <Option value="surgical">Surgical</Option><Option value="procedure">Procedure</Option>
                  <Option value="emergency">Emergency</Option><Option value="custom">Custom</Option>
                </Select>
              </Form.Item>
            </Col>
          </Row>
          <Divider orientation="left" plain>Components</Divider>
          <Form.List name="components">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...rest }) => (
                  <Row gutter={8} key={key} align="middle" style={{ marginBottom: 8 }}>
                    <Col span={10}><Form.Item {...rest} name={[name, 'item_id']} rules={[{ required: true }]} noStyle><Select showSearch placeholder="Item..." optionFilterProp="label" options={kitItemOpts} onSearch={searchKitItems} filterOption={false} onOpenChange={(o) => { if (o && !kitItemOpts.length) searchKitItems(); }} style={{ width: '100%' }} size="small" /></Form.Item></Col>
                    <Col span={10}><Form.Item {...rest} name={[name, 'quantity']} rules={[{ required: true }]} noStyle><InputNumber placeholder="Qty" style={{ width: '100%' }} min={1} /></Form.Item></Col>
                    <Col span={4}><Button icon={<DeleteOutlined />} size="small" danger onClick={() => remove(name)} /></Col>
                  </Row>
                ))}
                <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add()}>Add Component</Button>
              </>
            )}
          </Form.List>
        </Form>
      </Drawer>
    </div>
  );
};

/* ====================================================================
   TAB 9 - BUDGETS
   ==================================================================== */
const Budgets = () => {
  const [loading, setLoading] = useState(false);
  const [budgets, setBudgets] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const fetchBudgets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/healthcare/budgets');
      setBudgets(res.data.items || res.data.data || res.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchBudgets(); }, [fetchBudgets]);

  const handleCreate = async (vals) => {
    setSubmitting(true);
    try {
      await api.post('/healthcare/budgets', vals);
      message.success('Budget created');
      setDrawerOpen(false); form.resetFields(); fetchBudgets();
    } catch (e) { message.error(getErrorMessage(e)); }
    setSubmitting(false);
  };

  const statusColor = { active: 'green', exhausted: 'red', frozen: 'blue', draft: 'default' };

  const columns = [
    { title: 'Department', dataIndex: 'department_name', key: 'dept', ellipsis: true },
    { title: 'Fiscal Year', dataIndex: 'fiscal_year', key: 'fy', width: 110 },
    { title: 'Budget', dataIndex: 'budget_amount', key: 'budget', width: 140, align: 'right', render: (v) => formatCurrency(v) },
    { title: 'Consumed', dataIndex: 'consumed_amount', key: 'consumed', width: 140, align: 'right', render: (v) => formatCurrency(v) },
    { title: 'Remaining', dataIndex: 'remaining_amount', key: 'remaining', width: 140, align: 'right',
      render: (v) => <Text type={v < 0 ? 'danger' : undefined}>{formatCurrency(v)}</Text> },
    { title: 'Utilization', dataIndex: 'utilization_pct', key: 'util', width: 160,
      render: (v) => <Progress percent={Math.round(v || 0)} size="small" status={v > 90 ? 'exception' : v > 70 ? 'active' : 'normal'}
        strokeColor={v > 90 ? '#f5222d' : v > 70 ? BAVYA.orange : '#52c41a'} /> },
    { title: 'Status', dataIndex: 'status', key: 'st', width: 100,
      render: (v) => <Tag color={statusColor[v] || 'default'}>{(v || '').toUpperCase()}</Tag> },
  ];

  return (
    <div>
      <Card bordered={false} bodyStyle={{ padding: '12px 16px' }} style={{ marginBottom: 16 }}>
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawerOpen(true)}>New Budget</Button>
          <Button icon={<ReloadOutlined />} onClick={fetchBudgets}>Refresh</Button>
        </Space>
      </Card>
      <Card bordered={false}>
        <Table dataSource={budgets} columns={columns} rowKey="id" size="small" loading={loading}
          pagination={{ pageSize: 15, showSizeChanger: true }} scroll={{ x: 900 }} />
      </Card>

      <Drawer title="Create Budget" width={420} open={drawerOpen} onClose={() => setDrawerOpen(false)}
        extra={<Button type="primary" loading={submitting} onClick={() => form.submit()}>Create</Button>}>
        <Form form={form} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="department" label="Department" rules={[{ required: true }]}>
            <Input style={{ width: '100%' }} placeholder="e.g. Pharmacy, Emergency, Surgery" />
          </Form.Item>
          <Form.Item name="fiscal_year" label="Fiscal Year" rules={[{ required: true }]}>
            <Input placeholder="e.g. 2026-27" />
          </Form.Item>
          <Form.Item name="budget_amount" label="Budget Amount" rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} min={0} placeholder="0.00" formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
};

/* ====================================================================
   TAB 10 - ANALYTICS (ATP, Aging, Cycle Time, Transfer Suggestions)
   ==================================================================== */
const Analytics = () => {
  const [atpData, setAtpData] = useState([]);
  const [agingData, setAgingData] = useState([]);
  const [cycleData, setCycleData] = useState([]);
  const [transferData, setTransferData] = useState([]);
  const [loading, setLoading] = useState({ atp: false, aging: false, cycle: false, transfer: false });

  const fetchAll = useCallback(async () => {
    setLoading({ atp: true, aging: true, cycle: true, transfer: true });
    const safe = async (fn) => { try { return await fn(); } catch { return { data: {} }; } };
    const [atp, aging, cycle, transfer] = await Promise.all([
      safe(() => api.get('/healthcare/analytics/atp')),
      safe(() => api.get('/healthcare/analytics/inventory-aging')),
      safe(() => api.get('/healthcare/analytics/procurement-cycle')),
      safe(() => api.get('/healthcare/analytics/transfer-suggestions')),
    ]);
    setAtpData(atp.data.items || atp.data.data || atp.data || []);
    setAgingData(aging.data.items || aging.data.data || aging.data || []);
    setCycleData(cycle.data.items || cycle.data.data || cycle.data || []);
    setTransferData(transfer.data.items || transfer.data.data || transfer.data || []);
    setLoading({ atp: false, aging: false, cycle: false, transfer: false });
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleCreateTransfer = async (row) => {
    try {
      await api.post('/healthcare/analytics/transfer-suggestions/create', {
        item_id: row.item_id, from_warehouse_id: row.from_warehouse_id,
        to_warehouse_id: row.to_warehouse_id, quantity: row.suggested_qty,
      });
      message.success('Transfer request created');
      fetchAll();
    } catch (e) { message.error(getErrorMessage(e)); }
  };

  const atpCols = [
    { title: 'Item', dataIndex: 'item_name', key: 'name', ellipsis: true },
    { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'wh', width: 150, ellipsis: true },
    { title: 'Stock Qty', dataIndex: 'stock_qty', key: 'stock', width: 100, align: 'right', render: (v) => formatNumber(v) },
    { title: 'Transit', dataIndex: 'transit_qty', key: 'commit', width: 100, align: 'right', render: (v) => <Text type="warning">{formatNumber(v)}</Text> },
    { title: 'Available (ATP)', dataIndex: 'available_qty', key: 'atp', width: 120, align: 'right',
      render: (v) => <Text strong type={v <= 0 ? 'danger' : 'success'}>{formatNumber(v)}</Text> },
  ];

  const agingCols = [
    { title: 'Item', dataIndex: 'item_name', key: 'name', ellipsis: true },
    { title: '0-30 days', dataIndex: 'bucket_0_30', key: 'b1', width: 100, align: 'right', render: (v) => formatNumber(v) },
    { title: '31-60 days', dataIndex: 'bucket_31_60', key: 'b2', width: 100, align: 'right', render: (v) => formatNumber(v) },
    { title: '61-90 days', dataIndex: 'bucket_61_90', key: 'b3', width: 100, align: 'right', render: (v) => formatNumber(v) },
    { title: '91-180 days', dataIndex: 'bucket_91_180', key: 'b4', width: 110, align: 'right', render: (v) => formatNumber(v) },
    { title: '180+ days', dataIndex: 'bucket_180_plus', key: 'b5', width: 100, align: 'right',
      render: (v) => <Text type={v > 0 ? 'danger' : undefined}>{formatNumber(v)}</Text> },
    { title: 'Total Value', dataIndex: 'total_value', key: 'val', width: 130, align: 'right', render: (v) => formatCurrency(v) },
  ];

  const cycleCols = [
    { title: 'Item Category', dataIndex: 'category_name', key: 'cat', ellipsis: true },
    { title: 'Avg PR to PO (days)', dataIndex: 'avg_pr_to_po_days', key: 'prpo', width: 150, align: 'right' },
    { title: 'Avg PO to GRN (days)', dataIndex: 'avg_po_to_grn_days', key: 'pogrn', width: 160, align: 'right' },
    { title: 'Avg Total (days)', dataIndex: 'avg_total_days', key: 'total', width: 140, align: 'right',
      render: (v) => <Text strong>{v}</Text> },
    { title: 'Order Count', dataIndex: 'order_count', key: 'cnt', width: 110, align: 'right' },
  ];

  const transferCols = [
    { title: 'Item', dataIndex: 'item_name', key: 'name', ellipsis: true },
    { title: 'From Warehouse', dataIndex: 'from_warehouse_name', key: 'from', width: 150, ellipsis: true },
    { title: 'To Warehouse', dataIndex: 'to_warehouse_name', key: 'to', width: 150, ellipsis: true },
    { title: 'Suggested Qty', dataIndex: 'suggested_qty', key: 'qty', width: 120, align: 'right', render: (v) => formatNumber(v) },
    { title: 'Reason', dataIndex: 'reason', key: 'reason', width: 140, ellipsis: true },
    { title: 'Action', key: 'act', width: 130,
      render: (_, r) => <Button size="small" type="primary" icon={<SwapOutlined />} onClick={() => handleCreateTransfer(r)}>Transfer</Button> },
  ];

  const sectionStyle = { marginBottom: 24 };
  const headStyle = { background: 'linear-gradient(135deg, #D42B6E11 0%, #6B2FA011 100%)', borderRadius: '12px 12px 0 0' };

  return (
    <div>
      <Card bordered={false} bodyStyle={{ padding: '12px 16px' }} style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={fetchAll}>Refresh All Analytics</Button>
      </Card>

      <Card title={<span><ThunderboltOutlined style={{ color: BAVYA.magenta, marginRight: 8 }} />Available to Promise (ATP)</span>}
        bordered={false} style={sectionStyle} headStyle={headStyle}>
        <Table dataSource={atpData} columns={atpCols} rowKey={(r) => r.id || `${r.item_id}-${r.warehouse_id}`}
          size="small" loading={loading.atp} pagination={{ pageSize: 10 }} scroll={{ x: 650 }} />
      </Card>

      <Card title={<span><ClockCircleOutlined style={{ color: BAVYA.orange, marginRight: 8 }} />Inventory Aging</span>}
        bordered={false} style={sectionStyle} headStyle={headStyle}>
        <Table dataSource={agingData} columns={agingCols} rowKey={(r) => r.id || r.item_id}
          size="small" loading={loading.aging} pagination={{ pageSize: 10 }} scroll={{ x: 800 }} />
      </Card>

      <Card title={<span><AuditOutlined style={{ color: BAVYA.purple, marginRight: 8 }} />Procurement Cycle Time</span>}
        bordered={false} style={sectionStyle} headStyle={headStyle}>
        <Table dataSource={cycleData} columns={cycleCols} rowKey={(r) => r.id || r.category_name}
          size="small" loading={loading.cycle} pagination={{ pageSize: 10 }} scroll={{ x: 700 }} />
      </Card>

      <Card title={<span><SwapOutlined style={{ color: BAVYA.gold, marginRight: 8 }} />Transfer Suggestions</span>}
        bordered={false} style={sectionStyle} headStyle={headStyle}>
        <Table dataSource={transferData} columns={transferCols} rowKey={(r) => r.id || `${r.item_id}-${r.from_warehouse_id}-${r.to_warehouse_id}`}
          size="small" loading={loading.transfer} pagination={{ pageSize: 10 }} scroll={{ x: 850 }} />
      </Card>
    </div>
  );
};

export default Healthcare;
