import React, { useEffect, useState, useCallback } from 'react';
import {
  Card, Row, Col, Tabs, Table, Tag, Button, Space, Statistic, Alert, message, Modal, Form, InputNumber, Input, Select,
} from 'antd';
import {
  SafetyCertificateOutlined, ExperimentOutlined, FireOutlined, AuditOutlined,
  WarningOutlined, ReloadOutlined, ThunderboltOutlined, MedicineBoxOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import StatCard from '../../components/StatCard';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const SEVERITY_COLORS = { info: 'blue', warning: 'orange', error: 'red', critical: 'magenta' };
const STATUS_COLORS = { compliant: 'green', expiring_soon: 'orange', expired: 'red', not_required: 'default' };

function VendorTab() {
  const [filter, setFilter] = useState('expired');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/compliance/vendors-by-license-status', { params: { status: filter } });
      setRows(r.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { fetch(); }, [fetch]);

  const refreshStatus = async () => {
    try {
      const r = await api.post('/compliance/vendors/refresh-status');
      message.success(`Refreshed ${r.data.updated} vendors`);
      fetch();
    } catch (e) { message.error(getErrorMessage(e)); }
  };

  const cols = [
    { title: 'Code', dataIndex: 'vendor_code', width: 120 },
    { title: 'Vendor', dataIndex: 'name' },
    { title: 'DL Number', dataIndex: 'drug_license_number' },
    { title: 'State', dataIndex: 'drug_license_state', width: 120 },
    { title: 'DL Expiry', dataIndex: 'drug_license_expiry', width: 120 },
    {
      title: 'Days Left', dataIndex: 'days_left', width: 110,
      render: (v) => v == null ? '—' : <Tag color={v < 0 ? 'red' : v <= 30 ? 'orange' : 'green'}>{v < 0 ? `${Math.abs(v)} ago` : `${v} days`}</Tag>,
    },
    {
      title: 'Status', dataIndex: 'vendor_compliance_status', width: 130,
      render: (s) => <Tag color={STATUS_COLORS[s] || 'default'}>{s || '—'}</Tag>,
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Select value={filter} onChange={setFilter} style={{ width: 200 }}>
          <Select.Option value="expired">Expired</Select.Option>
          <Select.Option value="expiring_soon">Expiring within 30 days</Select.Option>
          <Select.Option value="compliant">Compliant</Select.Option>
          <Select.Option value="no_license">No License</Select.Option>
        </Select>
        <Button icon={<ReloadOutlined />} onClick={fetch}>Refresh List</Button>
        <Button type="primary" icon={<ThunderboltOutlined />} onClick={refreshStatus}>
          Recompute All Statuses
        </Button>
      </Space>
      <Card>
        <Table rowKey="id" loading={loading} dataSource={rows} columns={cols} pagination={{ pageSize: 30 }} size="small" />
      </Card>
    </div>
  );
}

function PrescriptionTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scheduleFilter, setScheduleFilter] = useState(undefined);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/compliance/prescription-records', {
        params: { drug_schedule: scheduleFilter, page: 1, page_size: 100 },
      });
      setRows(r.data?.data || r.data?.items || r.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, [scheduleFilter]);

  useEffect(() => { fetch(); }, [fetch]);

  const cols = [
    { title: 'Date', dataIndex: 'dispensed_at', width: 160, render: (v) => v?.replace('T', ' ').slice(0, 16) },
    { title: 'Item', dataIndex: 'item_name', render: (v, r) => <span><strong>{r.item_code}</strong> — {v}</span> },
    { title: 'Schedule', dataIndex: 'drug_schedule', width: 100, render: (v) => v ? <Tag color="red">{v}</Tag> : '—' },
    { title: 'Qty', dataIndex: 'qty_dispensed', width: 100 },
    { title: 'Prescriber', dataIndex: 'prescriber_name' },
    { title: 'License #', dataIndex: 'prescriber_license' },
    { title: 'Patient', dataIndex: 'patient_name' },
    { title: 'Source', dataIndex: 'source_type', width: 140, render: (v, r) => <span>{v} #{r.source_id}</span> },
    { title: 'Retain Until', dataIndex: 'retention_until', width: 120 },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Select allowClear placeholder="All Schedules" value={scheduleFilter} onChange={setScheduleFilter} style={{ width: 180 }}>
          <Select.Option value="H1">H1</Select.Option>
          <Select.Option value="X">X</Select.Option>
          <Select.Option value="H">H</Select.Option>
        </Select>
        <Button icon={<ReloadOutlined />} onClick={fetch}>Refresh</Button>
      </Space>
      <Card>
        <Table rowKey="id" loading={loading} dataSource={rows} columns={cols} size="small" pagination={{ pageSize: 30 }} />
      </Card>
    </div>
  );
}

function ColdChainTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [logModal, setLogModal] = useState(false);
  const [logging, setLogging] = useState(false);
  const [form] = Form.useForm();

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/compliance/cold-chain/breaches', { params: { page: 1, page_size: 100, days: 30 } });
      setRows(r.data?.data || r.data?.items || r.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const submitLog = async () => {
    try {
      const values = await form.validateFields();
      setLogging(true);
      const r = await api.post('/compliance/cold-chain/log', values);
      if (r.data?.is_breach) {
        message.warning(`Logged — BREACH detected (${r.data.severity})`);
      } else {
        message.success('Reading logged — within range');
      }
      setLogModal(false);
      form.resetFields();
      fetch();
    } catch (e) {
      if (e?.errorFields) return;
      message.error(getErrorMessage(e));
    } finally { setLogging(false); }
  };

  const cols = [
    { title: 'Time', dataIndex: 'reading_at', width: 160, render: (v) => v?.replace('T', ' ').slice(0, 16) },
    { title: 'Batch', dataIndex: 'batch_number', width: 140 },
    { title: 'Item', dataIndex: 'item_name', render: (v, r) => <span><strong>{r.item_code}</strong> {v}</span> },
    { title: 'Temp °C', dataIndex: 'temperature_c', width: 100, render: (v) => <strong>{v}</strong> },
    { title: 'Humidity %', dataIndex: 'humidity_pct', width: 110 },
    {
      title: 'Severity', dataIndex: 'severity', width: 110,
      render: (v) => <Tag color={SEVERITY_COLORS[v] || 'default'}>{v?.toUpperCase()}</Tag>,
    },
    { title: 'Notes', dataIndex: 'notes' },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={fetch}>Refresh</Button>
        <Button type="primary" icon={<FireOutlined />} onClick={() => setLogModal(true)}>Log Reading</Button>
      </Space>
      <Alert
        type="info"
        showIcon
        message="Only breaches in the last 30 days are shown. All readings are persisted; query the API for the full log."
        style={{ marginBottom: 16 }}
      />
      <Card>
        <Table rowKey="id" loading={loading} dataSource={rows} columns={cols} size="small" pagination={{ pageSize: 30 }} />
      </Card>
      <Modal
        title="Log Cold Chain Reading"
        open={logModal}
        onCancel={() => setLogModal(false)}
        onOk={submitLog}
        confirmLoading={logging}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="batch_id" label="Batch ID" rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="temperature_c" label="Temperature (°C)" rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} step={0.1} />
          </Form.Item>
          <Form.Item name="humidity_pct" label="Humidity (%)">
            <InputNumber style={{ width: '100%' }} step={0.1} />
          </Form.Item>
          <Form.Item name="warehouse_id" label="Warehouse ID">
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="notes" label="Notes">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

function AuditTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [severity, setSeverity] = useState(undefined);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/compliance/audits', { params: { page: 1, page_size: 100, days: 30, severity } });
      setRows(r.data?.data || r.data?.items || r.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, [severity]);

  useEffect(() => { fetch(); }, [fetch]);

  const cols = [
    { title: 'Time', dataIndex: 'created_at', width: 160, render: (v) => v?.replace('T', ' ').slice(0, 16) },
    { title: 'Event', dataIndex: 'event_type' },
    {
      title: 'Severity', dataIndex: 'severity', width: 110,
      render: (v) => <Tag color={SEVERITY_COLORS[v] || 'default'}>{v?.toUpperCase()}</Tag>,
    },
    { title: 'Vendor', dataIndex: 'vendor_id', width: 100 },
    { title: 'Item', dataIndex: 'item_id', width: 100 },
    { title: 'Source', key: 's', render: (_, r) => r.source_type ? `${r.source_type} #${r.source_id}` : '—' },
    {
      title: 'Payload', dataIndex: 'payload',
      ellipsis: true,
      render: (v) => v ? <code style={{ fontSize: 11 }}>{v.slice(0, 80)}</code> : null,
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Select allowClear placeholder="All Severities" value={severity} onChange={setSeverity} style={{ width: 180 }}>
          <Select.Option value="info">Info</Select.Option>
          <Select.Option value="warning">Warning</Select.Option>
          <Select.Option value="error">Error</Select.Option>
          <Select.Option value="critical">Critical</Select.Option>
        </Select>
        <Button icon={<ReloadOutlined />} onClick={fetch}>Refresh</Button>
      </Space>
      <Card>
        <Table rowKey="id" loading={loading} dataSource={rows} columns={cols} size="small" pagination={{ pageSize: 50 }} />
      </Card>
    </div>
  );
}

export default function ComplianceDashboard() {
  const [kpis, setKpis] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchKpis = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/compliance/dashboard');
      setKpis(r.data);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchKpis(); }, [fetchKpis]);

  return (
    <div>
      <PageHeader
        title="Healthcare Compliance"
        subtitle="Drug license, Schedule H1/X dispensing, cold-chain breaches, and audit trail"
        extra={<Button icon={<ReloadOutlined />} onClick={fetchKpis} loading={loading}>Refresh KPIs</Button>}
      />

      {kpis && (
        <>
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={24} sm={12} md={6}>
              <StatCard
                title="Vendors with Expired DL"
                value={kpis.vendors?.expired_dl || 0}
                icon={<SafetyCertificateOutlined />}
                valueStyle={{ color: '#ff4d4f' }}
              />
            </Col>
            <Col xs={24} sm={12} md={6}>
              <StatCard
                title="Expiring within 30 days"
                value={kpis.vendors?.expiring_dl_30d || 0}
                icon={<WarningOutlined />}
                valueStyle={{ color: '#fa8c16' }}
              />
            </Col>
            <Col xs={24} sm={12} md={6}>
              <StatCard
                title="Cold Chain Breaches (24h)"
                value={kpis.events_recent?.cold_chain_breaches_24h || 0}
                icon={<FireOutlined />}
                valueStyle={{ color: '#ff4d4f' }}
              />
            </Col>
            <Col xs={24} sm={12} md={6}>
              <StatCard
                title="H1 Dispenses This Month"
                value={kpis.events_recent?.h1_dispenses_this_month || 0}
                icon={<MedicineBoxOutlined />}
              />
            </Col>
          </Row>

          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={12} md={6}>
              <Card><Statistic title="Total Vendors" value={kpis.vendors?.total || 0} /></Card>
            </Col>
            <Col xs={12} md={6}>
              <Card><Statistic title="No DL on Record" value={kpis.vendors?.no_dl || 0} /></Card>
            </Col>
            <Col xs={12} md={6}>
              <Card><Statistic title="H1 / Narcotic Items" value={kpis.items?.h1_or_narcotic || 0} /></Card>
            </Col>
            <Col xs={12} md={6}>
              <Card><Statistic title="Cold-Chain Items" value={kpis.items?.cold_chain || 0} /></Card>
            </Col>
          </Row>

          <Row gutter={16} style={{ marginBottom: 24 }}>
            <Col xs={12} md={8}>
              <Card><Statistic title="Critical Audits (7d)" value={kpis.events_recent?.critical_audits_7d || 0} valueStyle={{ color: '#ff4d4f' }} /></Card>
            </Col>
            <Col xs={12} md={8}>
              <Card><Statistic title="Expired Batches" value={kpis.batches?.expired || 0} valueStyle={{ color: '#ff4d4f' }} /></Card>
            </Col>
            <Col xs={12} md={8}>
              <Card><Statistic title="Batches near expiry (90d)" value={kpis.batches?.near_expiry_90d || 0} valueStyle={{ color: '#fa8c16' }} /></Card>
            </Col>
          </Row>
        </>
      )}

      <Tabs
        defaultActiveKey="vendors"
        items={[
          { key: 'vendors', label: <span><SafetyCertificateOutlined /> Vendor Licenses</span>, children: <VendorTab /> },
          { key: 'rx', label: <span><MedicineBoxOutlined /> Prescription Records</span>, children: <PrescriptionTab /> },
          { key: 'cc', label: <span><FireOutlined /> Cold Chain</span>, children: <ColdChainTab /> },
          { key: 'audit', label: <span><AuditOutlined /> Audit Log</span>, children: <AuditTab /> },
        ]}
      />
    </div>
  );
}
