import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card, Row, Col, Table, Tag, Tabs, Button, Space, Statistic, message,
  Progress, InputNumber, Empty,
} from 'antd';
import {
  WarningOutlined, FireOutlined, ClockCircleOutlined, ShopOutlined,
  TrophyOutlined, ReloadOutlined, RiseOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import StatCard from '../../components/StatCard';
import api from '../../config/api';
import { formatCurrency, getErrorMessage } from '../../utils/helpers';

const URG_COLORS = { critical: 'red', warning: 'orange', info: 'blue' };
const GRADE_COLORS = { A: 'green', B: 'blue', C: 'gold', D: 'orange', F: 'red' };
const ABC_COLORS = { A: 'red', B: 'orange', C: 'blue' };

function ExpiryTab() {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/alerts/expiry', { params: { days, page_size: 200 } });
      setRows(r.data?.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, [days]);
  useEffect(() => { fetch(); }, [fetch]);

  const cols = [
    { title: 'Item', dataIndex: 'item_name', render: (v, r) => <span><strong>{r.item_code}</strong> {v}</span> },
    { title: 'Batch', dataIndex: 'batch_number', width: 140 },
    { title: 'Available', dataIndex: 'available_qty', width: 100, align: 'right', render: (v) => v?.toLocaleString() },
    { title: 'Expiry', dataIndex: 'expiry_date', width: 110 },
    {
      title: 'Days Left', dataIndex: 'days_left', width: 110,
      render: (v, r) => <Tag color={URG_COLORS[r.urgency]}>{v} days</Tag>,
      sorter: (a, b) => a.days_left - b.days_left,
      defaultSortOrder: 'ascend',
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <span>Show batches expiring within</span>
        <InputNumber min={1} max={365} value={days} onChange={setDays} addonAfter="days" />
        <Button icon={<ReloadOutlined />} onClick={fetch}>Refresh</Button>
      </Space>
      <Card><Table rowKey="batch_id" loading={loading} dataSource={rows} columns={cols} size="small" pagination={{ pageSize: 30 }} /></Card>
    </div>
  );
}

function ExpiredTab() {
  const [data, setData] = useState({ data: [], total: 0, write_off_value_estimate: 0 });
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/alerts/expired', { params: { page_size: 200 } });
      setData(r.data || { data: [], total: 0, write_off_value_estimate: 0 });
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { fetch(); }, [fetch]);

  const cols = [
    { title: 'Item', dataIndex: 'item_name', render: (v, r) => <span><strong>{r.item_code}</strong> {v}</span> },
    { title: 'Batch', dataIndex: 'batch_number', width: 140 },
    { title: 'Available', dataIndex: 'available_qty', width: 100, align: 'right' },
    { title: 'Stock Value', dataIndex: 'stock_value', width: 130, align: 'right', render: (v) => formatCurrency(v) },
    { title: 'Expired On', dataIndex: 'expiry_date', width: 110 },
    { title: 'Days Expired', dataIndex: 'days_expired', width: 120, render: (v) => <Tag color="red">{v} days ago</Tag> },
  ];

  return (
    <div>
      <Card style={{ marginBottom: 16, borderLeft: '4px solid #ff4d4f' }}>
        <Row gutter={16}>
          <Col span={12}><Statistic title="Expired Batches in Stock" value={data.total} valueStyle={{ color: '#ff4d4f' }} /></Col>
          <Col span={12}><Statistic title="Estimated Write-off Value" value={data.write_off_value_estimate} prefix="₹" precision={2} valueStyle={{ color: '#ff4d4f' }} /></Col>
        </Row>
      </Card>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={fetch}>Refresh</Button>
      </Space>
      <Card><Table rowKey="batch_id" loading={loading} dataSource={data.data} columns={cols} size="small" pagination={{ pageSize: 30 }} /></Card>
    </div>
  );
}

function ReorderTab() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/alerts/reorder', { params: { page_size: 500 } });
      setRows(r.data?.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { fetch(); }, [fetch]);

  const cols = [
    { title: 'Item', dataIndex: 'item_name', render: (v, r) => <span><strong>{r.item_code}</strong> {v}</span> },
    { title: 'Current', dataIndex: 'current_stock', width: 100, align: 'right', render: (v) => <strong>{v?.toLocaleString()}</strong> },
    { title: 'Reorder Lvl', dataIndex: 'reorder_level', width: 110, align: 'right' },
    { title: 'Safety', dataIndex: 'safety_stock', width: 90, align: 'right' },
    { title: 'Shortage', dataIndex: 'shortage', width: 100, align: 'right', render: (v) => <Tag color="orange">{v?.toLocaleString()}</Tag> },
    { title: 'Suggested Qty', dataIndex: 'suggested_qty', width: 130, align: 'right', render: (v) => <Tag color="blue">{v?.toLocaleString()}</Tag> },
    { title: 'Lead Time', dataIndex: 'lead_time_days', width: 100, render: (v) => `${v}d` },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={fetch}>Refresh</Button>
        {/* BUG-FIN-155: use react-router navigate so we don't blow away SPA history. */}
        <Button type="primary" icon={<ShopOutlined />} onClick={() => navigate('/mrp')}>Open MRP for procurement plan</Button>
      </Space>
      <Card><Table rowKey="item_id" loading={loading} dataSource={rows} columns={cols} size="small" pagination={{ pageSize: 50 }} /></Card>
    </div>
  );
}

function LowStockTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/alerts/low-stock');
      setRows(r.data?.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { fetch(); }, [fetch]);

  const cols = [
    { title: 'Item', dataIndex: 'item_name', render: (v, r) => <span><strong>{r.item_code}</strong> {v}</span> },
    {
      title: 'Status', dataIndex: 'stockout', width: 110,
      render: (v) => v ? <Tag color="red">STOCKOUT</Tag> : <Tag color="orange">Below Safety</Tag>,
    },
    { title: 'Current', dataIndex: 'current_stock', width: 100, align: 'right', render: (v) => <strong>{v?.toLocaleString()}</strong> },
    { title: 'Safety Stock', dataIndex: 'safety_stock', width: 110, align: 'right' },
    { title: 'Shortfall', dataIndex: 'shortfall', width: 100, align: 'right' },
  ];

  return (
    <Card>
      <Space style={{ marginBottom: 16 }}><Button icon={<ReloadOutlined />} onClick={fetch}>Refresh</Button></Space>
      <Table rowKey="item_id" loading={loading} dataSource={rows} columns={cols} size="small" pagination={{ pageSize: 50 }} />
    </Card>
  );
}

function ABCTab() {
  const [days, setDays] = useState(90);
  const [data, setData] = useState({ data: [], totals: { A: 0, B: 0, C: 0, total_value: 0 } });
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/alerts/abc-analysis', { params: { days } });
      setData(r.data || { data: [], totals: {} });
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, [days]);
  useEffect(() => { fetch(); }, [fetch]);

  const cols = [
    { title: 'Item', dataIndex: 'item_name', render: (v, r) => <span><strong>{r.item_code}</strong> {v}</span> },
    { title: 'Class', dataIndex: 'abc_class', width: 80, render: (v) => <Tag color={ABC_COLORS[v]} style={{ fontWeight: 700 }}>{v}</Tag>, filters: [{ text: 'A', value: 'A' }, { text: 'B', value: 'B' }, { text: 'C', value: 'C' }], onFilter: (v, r) => r.abc_class === v },
    { title: 'Qty Consumed', dataIndex: 'qty_consumed', width: 130, align: 'right', render: (v) => v?.toLocaleString() },
    { title: 'Value', dataIndex: 'value', width: 130, align: 'right', render: (v) => formatCurrency(v) },
    { title: '% of Total', dataIndex: 'value_pct', width: 110, align: 'right', render: (v) => `${v?.toFixed(2)}%` },
    { title: 'Cumulative %', dataIndex: 'cumulative_pct', width: 130, align: 'right', render: (v) => <Progress percent={v?.toFixed(1)} size="small" showInfo={false} /> },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <span>Lookback period:</span>
        <InputNumber min={7} max={730} value={days} onChange={setDays} addonAfter="days" />
        <Button icon={<ReloadOutlined />} onClick={fetch} loading={loading}>Recompute</Button>
      </Space>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}><StatCard title="Class A (top 80% value)" value={data.totals?.A || 0} valueStyle={{ color: '#ff4d4f' }} /></Col>
        <Col span={6}><StatCard title="Class B (next 15%)" value={data.totals?.B || 0} valueStyle={{ color: '#fa8c16' }} /></Col>
        <Col span={6}><StatCard title="Class C (last 5%)" value={data.totals?.C || 0} valueStyle={{ color: '#1890ff' }} /></Col>
        <Col span={6}><Card><Statistic title="Total Consumption Value" value={data.totals?.total_value || 0} prefix="₹" precision={2} /></Card></Col>
      </Row>
      <Card><Table rowKey="item_id" loading={loading} dataSource={data.data} columns={cols} size="small" pagination={{ pageSize: 50 }} /></Card>
    </div>
  );
}

function VendorScorecardTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [recomputing, setRecomputing] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/alerts/vendor-scorecards');
      setRows(r.data?.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { fetch(); }, [fetch]);

  const recompute = async () => {
    setRecomputing(true);
    try {
      const r = await api.post('/alerts/vendor-scorecards/recompute', {});
      message.success(`Recomputed ${r.data?.vendors_computed || 0} vendor scorecards`);
      fetch();
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setRecomputing(false); }
  };

  const cols = [
    { title: 'Vendor', dataIndex: 'vendor_name', render: (v, r) => <span><strong>{r.vendor_code}</strong> {v}</span> },
    { title: 'Period', key: 'p', width: 200, render: (_, r) => `${r.period_start} → ${r.period_end}` },
    { title: 'Orders', dataIndex: 'total_orders', width: 80, align: 'right' },
    { title: 'On-Time %', dataIndex: 'delivery_score', width: 110, align: 'right', render: (v) => `${v?.toFixed(1)}%` },
    { title: 'Quality %', dataIndex: 'quality_score', width: 110, align: 'right', render: (v) => `${v?.toFixed(1)}%` },
    { title: 'Price %', dataIndex: 'price_score', width: 110, align: 'right', render: (v) => `${v?.toFixed(1)}%` },
    { title: 'Overall', dataIndex: 'overall_score', width: 100, align: 'right', render: (v) => <strong>{v?.toFixed(1)}%</strong> },
    { title: 'Grade', dataIndex: 'grade', width: 80, render: (v) => <Tag color={GRADE_COLORS[v]} style={{ fontWeight: 700, fontSize: 14 }}>{v}</Tag> },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={fetch}>Refresh</Button>
        <Button type="primary" icon={<TrophyOutlined />} onClick={recompute} loading={recomputing}>Recompute All Scorecards</Button>
      </Space>
      {rows.length === 0 ? (
        <Empty description="No scorecards yet. Click 'Recompute All Scorecards' to build them from PO/GRN history." />
      ) : (
        <Card><Table rowKey="vendor_id" loading={loading} dataSource={rows} columns={cols} size="small" pagination={{ pageSize: 30 }} /></Card>
      )}
    </div>
  );
}

export default function AlertsDashboard() {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/alerts/summary');
      setSummary(r.data);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  return (
    <div>
      <PageHeader
        title="Alerts & Insights"
        subtitle="Expiry, reorder, ABC analysis, vendor performance — all in one place"
        extra={<Button icon={<ReloadOutlined />} onClick={fetchSummary} loading={loading}>Refresh KPIs</Button>}
      />

      {summary && (
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col xs={12} md={4}>
            <StatCard
              title="Expired in Stock"
              value={summary.expired_in_stock}
              icon={<FireOutlined />}
              valueStyle={{ color: '#ff4d4f' }}
            />
          </Col>
          <Col xs={12} md={4}>
            <StatCard
              title="Expiring (30d)"
              value={summary.expiring_30d}
              icon={<WarningOutlined />}
              valueStyle={{ color: '#fa8c16' }}
            />
          </Col>
          <Col xs={12} md={4}>
            <StatCard
              title="Expiring (31-90d)"
              value={summary.expiring_31_90d}
              icon={<ClockCircleOutlined />}
              valueStyle={{ color: '#faad14' }}
            />
          </Col>
          <Col xs={12} md={4}>
            <StatCard
              title="Below Reorder"
              value={summary.items_below_reorder}
              icon={<RiseOutlined />}
              valueStyle={{ color: '#fa541c' }}
            />
          </Col>
          <Col xs={12} md={4}>
            <StatCard
              title="Below Safety Stock"
              value={summary.items_below_safety_stock}
              icon={<WarningOutlined />}
              valueStyle={{ color: '#ff4d4f' }}
            />
          </Col>
          <Col xs={12} md={4}>
            <Card>
              <div style={{ fontSize: 13, color: '#888' }}>As of</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 8 }}>{summary.as_of}</div>
            </Card>
          </Col>
        </Row>
      )}

      <Tabs
        defaultActiveKey="expiring"
        items={[
          { key: 'expiring', label: <span><ClockCircleOutlined /> Expiring Soon</span>, children: <ExpiryTab /> },
          { key: 'expired', label: <span><FireOutlined /> Expired (Quarantine)</span>, children: <ExpiredTab /> },
          { key: 'reorder', label: <span><RiseOutlined /> Reorder</span>, children: <ReorderTab /> },
          { key: 'low', label: <span><WarningOutlined /> Low Stock</span>, children: <LowStockTab /> },
          { key: 'abc', label: <span><RiseOutlined /> ABC Analysis</span>, children: <ABCTab /> },
          { key: 'vendor', label: <span><TrophyOutlined /> Vendor Scorecard</span>, children: <VendorScorecardTab /> },
        ]}
      />
    </div>
  );
}
