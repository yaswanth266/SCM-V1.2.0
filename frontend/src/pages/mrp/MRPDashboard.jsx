import React, { useEffect, useState, useCallback } from 'react';
import {
  Card, Row, Col, Button, Table, Tag, Space, Modal, Form, Select, InputNumber, Drawer, Statistic, message, Popconfirm, Switch, Input, Tabs, Tooltip,
} from 'antd';
import {
  PlusOutlined, ReloadOutlined, ThunderboltOutlined, EyeOutlined, ShopOutlined, LineChartOutlined, ApartmentOutlined,
  RiseOutlined, CheckCircleOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import StatCard from '../../components/StatCard';
import api from '../../config/api';
import { formatCurrency, getErrorMessage } from '../../utils/helpers';

const METHOD_LABELS = {
  moving_average: 'Moving Average',
  weighted_average: 'Weighted Average',
  seasonal: '7-day Seasonal',
};

const STATUS_COLORS = { draft: 'default', computed: 'blue', po_generated: 'green', closed: 'gold' };

function RunsTab({ onView, onCompute }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/mrp/runs', { params: { page, page_size: 25 } });
      setRows(r.data?.data || r.data?.items || []);
      setTotal(r.data?.total || (r.data?.data || []).length);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, [page]);

  useEffect(() => { fetch(); }, [fetch]);

  const cols = [
    { title: '#', dataIndex: 'run_number', width: 140 },
    { title: 'Date', dataIndex: 'run_date', width: 160, render: (v) => v?.replace('T', ' ').slice(0, 16) },
    { title: 'Method', dataIndex: 'method', width: 160, render: (v) => <Tag>{METHOD_LABELS[v] || v}</Tag> },
    { title: 'Horizon', dataIndex: 'horizon_days', width: 90, render: (v) => `${v}d` },
    { title: 'History', dataIndex: 'history_days', width: 90, render: (v) => `${v}d` },
    { title: 'Items', dataIndex: 'total_items', width: 80 },
    { title: 'Need Reorder', dataIndex: 'items_needing_reorder', width: 130, render: (v) => v > 0 ? <Tag color="orange">{v}</Tag> : <Tag>0</Tag> },
    { title: 'Suggested ₹', dataIndex: 'total_suggested_value', width: 140, render: (v) => formatCurrency(v) },
    { title: 'Status', dataIndex: 'status', width: 130, render: (v) => <Tag color={STATUS_COLORS[v] || 'default'}>{v}</Tag> },
    {
      title: 'Actions', key: 'x', width: 120,
      render: (_, row) => <Button size="small" icon={<EyeOutlined />} onClick={() => onView(row.id)}>Open</Button>,
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={fetch}>Refresh</Button>
        <Button type="primary" icon={<ThunderboltOutlined />} onClick={onCompute}>Compute New MRP Run</Button>
      </Space>
      <Card>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={rows}
          columns={cols}
          size="small"
          pagination={{ current: page, total, pageSize: 25, onChange: setPage, showSizeChanger: false }}
        />
      </Card>
    </div>
  );
}

function ForecastPreviewTab() {
  const [items, setItems] = useState([]);
  const [itemId, setItemId] = useState(undefined);
  const [method, setMethod] = useState('moving_average');
  const [horizon, setHorizon] = useState(30);
  const [history, setHistory] = useState(90);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchItems = useCallback(async () => {
    try {
      const r = await api.get('/masters/items', { params: { page: 1, page_size: 200 } });
      setItems(r.data?.data || r.data?.items || []);
    } catch (e) { /* silent */ }
  }, []);
  useEffect(() => { fetchItems(); }, [fetchItems]);

  const compute = async () => {
    if (!itemId) { message.warning('Choose an item first'); return; }
    setLoading(true);
    try {
      const r = await api.get(`/mrp/forecast/preview/${itemId}`, {
        params: { method, horizon_days: horizon, history_days: history },
      });
      setData(r.data);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  };

  return (
    <Row gutter={16}>
      <Col span={8}>
        <Card title="Forecast Inputs">
          <Form layout="vertical">
            <Form.Item label="Item">
              <Select
                showSearch
                optionFilterProp="label"
                value={itemId}
                onChange={setItemId}
                options={items.map((i) => ({ value: i.id, label: `${i.item_code} — ${i.name}` }))}
              />
            </Form.Item>
            <Form.Item label="Method">
              <Select value={method} onChange={setMethod}
                options={Object.entries(METHOD_LABELS).map(([v, l]) => ({ value: v, label: l }))} />
            </Form.Item>
            <Form.Item label="Horizon (days)">
              <InputNumber value={horizon} onChange={setHorizon} min={1} max={365} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="History window (days)">
              <InputNumber value={history} onChange={setHistory} min={7} max={730} style={{ width: '100%' }} />
            </Form.Item>
            <Button type="primary" icon={<RiseOutlined />} onClick={compute} loading={loading}>Compute Forecast</Button>
          </Form>
        </Card>
      </Col>
      <Col span={16}>
        <Card title={data ? `${data.item_code} — ${data.item_name}` : 'Result'}>
          {!data ? <p style={{ color: '#888' }}>Choose an item and click "Compute Forecast"</p> : (
            <>
              <Row gutter={16} style={{ marginBottom: 16 }}>
                <Col span={6}><Statistic title="History Total" value={data.history_total} precision={2} /></Col>
                <Col span={6}><Statistic title="Avg / day" value={data.history_avg_per_day} precision={2} /></Col>
                <Col span={6}><Statistic title="Forecast Qty" value={data.forecast_qty} precision={2} valueStyle={{ color: '#1890ff' }} /></Col>
                <Col span={6}>
                  <Statistic
                    title="Confidence"
                    value={data.confidence_pct}
                    suffix="%"
                    valueStyle={{ color: data.confidence_pct >= 60 ? '#52c41a' : data.confidence_pct >= 30 ? '#fa8c16' : '#ff4d4f' }}
                  />
                </Col>
              </Row>
              <p style={{ marginTop: 16 }}>
                <strong>Last 30 days of consumption (sparkline):</strong>
                <br />
                <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{(data.history || []).slice(-30).map((v) => v.toFixed(1)).join(' · ')}</code>
              </p>
            </>
          )}
        </Card>
      </Col>
    </Row>
  );
}

export default function MRPDashboard() {
  const [computeOpen, setComputeOpen] = useState(false);
  const [computing, setComputing] = useState(false);
  const [computeForm] = Form.useForm();
  const [warehouses, setWarehouses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [runDetail, setRunDetail] = useState(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    api.get('/masters/warehouses?page=1&page_size=100').then((r) => setWarehouses(r.data?.data || r.data?.items || [])).catch(() => {});
    api.get('/masters/item-categories?page=1&page_size=100').then((r) => setCategories(r.data?.data || r.data?.items || [])).catch(() => {});
  }, []);

  const handleCompute = async () => {
    try {
      const v = await computeForm.validateFields();
      setComputing(true);
      const r = await api.post('/mrp/runs/compute', v);
      message.success(`Run ${r.data.run_number} computed: ${r.data.items_needing_reorder} items need reorder`);
      setComputeOpen(false);
      computeForm.resetFields();
      openRun(r.data.id);
    } catch (e) {
      if (e?.errorFields) return;
      message.error(getErrorMessage(e));
    } finally { setComputing(false); }
  };

  const openRun = async (runId) => {
    try {
      const r = await api.get(`/mrp/runs/${runId}`);
      setActiveRun(runId);
      setRunDetail(r.data);
    } catch (e) { message.error(getErrorMessage(e)); }
  };

  // BUG-FIN-151: avoid re-fetching the whole run on every toggle. Optimistically
  // patch the local item state and only refetch on failure to keep large runs
  // (1000+ rows) responsive when the user is bulk-checking lines.
  const patchLocalItem = (mriId, patch) => {
    setRunDetail((prev) => {
      if (!prev || !Array.isArray(prev.items)) return prev;
      return {
        ...prev,
        items: prev.items.map((it) => (it.id === mriId ? { ...it, ...patch } : it)),
      };
    });
  };

  const toggleSelected = async (mri) => {
    const next = !mri.selected;
    patchLocalItem(mri.id, { selected: next });
    try {
      await api.put(`/mrp/runs/${activeRun}/items/${mri.id}`, { selected: next });
    } catch (e) {
      patchLocalItem(mri.id, { selected: mri.selected });
      message.error(getErrorMessage(e));
    }
  };

  const updateQty = async (mri, qty) => {
    const prev = mri.suggested_qty;
    patchLocalItem(mri.id, { suggested_qty: qty });
    try {
      await api.put(`/mrp/runs/${activeRun}/items/${mri.id}`, { suggested_qty: qty });
    } catch (e) {
      patchLocalItem(mri.id, { suggested_qty: prev });
      message.error(getErrorMessage(e));
    }
  };

  const generatePOs = async () => {
    setGenerating(true);
    try {
      const r = await api.post(`/mrp/runs/${activeRun}/convert-to-pos`);
      const d = r.data;
      Modal.success({
        title: `${d.created} draft PO(s) created`,
        content: (
          <div>
            <p>{d.created} purchase order(s) generated, grouped by vendor.</p>
            {d.skipped_no_vendor > 0 && <p>Skipped {d.skipped_no_vendor} item(s) with no suggested vendor.</p>}
            {d.skipped_already_generated > 0 && <p>Skipped {d.skipped_already_generated} item(s) already converted.</p>}
            <ul>
              {(d.vendors || []).map((v) => <li key={v.po_id}>PO #{v.po_number} — {v.lines} line(s) @ {formatCurrency(v.total)}</li>)}
            </ul>
          </div>
        ),
      });
      openRun(activeRun);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setGenerating(false); }
  };

  const itemCols = [
    {
      title: 'Sel', dataIndex: 'selected', width: 60,
      render: (v, row) => <Switch checked={v} size="small" onChange={() => toggleSelected(row)} disabled={!!row.generated_po_id} />,
    },
    { title: 'Item', dataIndex: 'item_name', render: (v, r) => <span><strong>{r.item_code}</strong> {v}</span> },
    { title: 'Stock', dataIndex: 'current_stock', width: 90, align: 'right' },
    { title: 'On-Order', dataIndex: 'on_order_qty', width: 100, align: 'right' },
    { title: 'Forecast', dataIndex: 'forecast_qty', width: 110, align: 'right', render: (v) => <strong>{v?.toFixed(1)}</strong> },
    { title: 'Safety', dataIndex: 'safety_stock', width: 90, align: 'right' },
    { title: 'Net Req', dataIndex: 'net_required', width: 100, align: 'right' },
    {
      title: 'Suggest Qty', dataIndex: 'suggested_qty', width: 130, align: 'right',
      render: (v, row) => row.generated_po_id ?
        <Tag color="green">{v?.toFixed(1)}</Tag> :
        <InputNumber size="small" value={v} onChange={(nv) => updateQty(row, nv)} min={0} step={0.1} style={{ width: 100 }} />,
    },
    { title: 'Vendor', dataIndex: 'suggested_vendor_name', render: (v) => v || <Tag color="orange">none</Tag> },
    { title: 'Rate ₹', dataIndex: 'suggested_rate', width: 110, align: 'right', render: (v) => formatCurrency(v) },
    { title: 'Lead', dataIndex: 'lead_time_days', width: 70, render: (v) => `${v}d` },
    {
      title: 'Conf', dataIndex: 'confidence_pct', width: 80,
      render: (v) => <Tag color={v >= 60 ? 'green' : v >= 30 ? 'orange' : 'red'}>{v?.toFixed(0)}%</Tag>,
    },
    {
      title: 'PO', dataIndex: 'generated_po_id', width: 80,
      render: (v) => v ? <Tag color="green" icon={<CheckCircleOutlined />}>#{v}</Tag> : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Demand Planning + MRP"
        subtitle="Forecast demand, compute net requirements, and auto-generate draft purchase orders"
      />
      <Tabs
        defaultActiveKey="runs"
        items={[
          { key: 'runs', label: <span><ApartmentOutlined /> MRP Runs</span>, children: <RunsTab onView={openRun} onCompute={() => setComputeOpen(true)} /> },
          { key: 'forecast', label: <span><LineChartOutlined /> Forecast Preview</span>, children: <ForecastPreviewTab /> },
        ]}
      />

      <Modal
        title="Compute New MRP Run"
        open={computeOpen}
        onCancel={() => setComputeOpen(false)}
        onOk={handleCompute}
        confirmLoading={computing}
        okText="Compute"
      >
        <Form form={computeForm} layout="vertical" initialValues={{ method: 'moving_average', horizon_days: 30, history_days: 90 }}>
          <Form.Item name="method" label="Forecast Method" rules={[{ required: true }]}>
            <Select options={Object.entries(METHOD_LABELS).map(([v, l]) => ({ value: v, label: l }))} />
          </Form.Item>
          <Form.Item name="horizon_days" label={<Tooltip title="How many days ahead to forecast">Horizon (days)</Tooltip>} rules={[{ required: true }]}>
            <InputNumber min={1} max={365} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="history_days" label={<Tooltip title="How many days of history to base the forecast on">History Window (days)</Tooltip>} rules={[{ required: true }]}>
            <InputNumber min={7} max={730} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="warehouse_id" label="Warehouse (optional)">
            <Select allowClear options={warehouses.map((w) => ({ value: w.id, label: w.name }))} />
          </Form.Item>
          <Form.Item name="item_category_id" label="Item Category (optional)">
            <Select allowClear options={categories.map((c) => ({ value: c.id, label: c.name }))} />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={runDetail ? `MRP Run ${runDetail.run_number}` : 'MRP Run'}
        open={!!runDetail}
        onClose={() => { setActiveRun(null); setRunDetail(null); }}
        width="92%"
      >
        {runDetail && (
          <>
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={4}><StatCard title="Total Items" value={runDetail.total_items} icon={<ApartmentOutlined />} /></Col>
              <Col span={4}>
                <StatCard
                  title="Need Reorder"
                  value={runDetail.items_needing_reorder}
                  valueStyle={{ color: runDetail.items_needing_reorder > 0 ? '#fa8c16' : '#52c41a' }}
                />
              </Col>
              <Col span={4}>
                <Card>
                  <Statistic title="Suggested Spend" value={runDetail.total_suggested_value} prefix="₹" precision={2} />
                </Card>
              </Col>
              <Col span={4}><Card><Statistic title="Method" value={METHOD_LABELS[runDetail.method] || runDetail.method} /></Card></Col>
              <Col span={4}><Card><Statistic title="Horizon" value={`${runDetail.horizon_days} days`} /></Card></Col>
              <Col span={4}>
                <Card>
                  <Statistic title="Status" value={runDetail.status} valueStyle={{ color: runDetail.status === 'po_generated' ? '#52c41a' : '#1890ff' }} />
                </Card>
              </Col>
            </Row>
            <Space style={{ marginBottom: 16 }}>
              <Button icon={<ReloadOutlined />} onClick={() => openRun(activeRun)}>Refresh</Button>
              {runDetail.status !== 'closed' && (
                <Popconfirm
                  title="Generate draft POs?"
                  description="One PO will be created per vendor for the selected items."
                  onConfirm={generatePOs}
                >
                  <Button type="primary" icon={<ShopOutlined />} loading={generating}>Generate Draft POs</Button>
                </Popconfirm>
              )}
            </Space>
            <Card>
              <Table
                rowKey="id"
                dataSource={runDetail.items}
                columns={itemCols}
                size="small"
                pagination={{ pageSize: 50 }}
                scroll={{ x: 1500 }}
              />
            </Card>
          </>
        )}
      </Drawer>
    </div>
  );
}
