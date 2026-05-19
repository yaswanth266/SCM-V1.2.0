import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Modal,
  Divider, Typography, Tooltip, Tag, Badge, Alert,
} from 'antd';
import {
  PlusOutlined, EyeOutlined, CheckOutlined, ExperimentOutlined,
  CloseCircleOutlined, FileSearchOutlined, WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import useAuthStore from '../../store/authStore';
import {
  formatDate, formatNumber, getErrorMessage, formatDateForAPI, formatDateTime,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const QI_RESULT_OPTIONS = [
  { label: 'Accepted', value: 'accepted' },
  { label: 'Rejected', value: 'rejected' },
  { label: 'Hold', value: 'hold' },
];

const QI_STATUSES = [
  { label: 'Draft', value: 'draft' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const RESULT_FILTER_OPTIONS = [
  { label: 'Pass', value: 'pass' },
  { label: 'Fail', value: 'fail' },
  { label: 'Partial', value: 'partial' },
];

const INSPECTION_TYPES = [
  { label: 'Full Inspection', value: 'full' },
  { label: 'Sample Inspection', value: 'sample' },
  { label: 'Visual Inspection', value: 'visual' },
  { label: 'Measurement Based', value: 'measurement' },
];

const resultColors = {
  accepted: '#52c41a',
  pass: '#52c41a',
  rejected: '#f5222d',
  fail: '#f5222d',
  hold: '#fa8c16',
  partial: '#fa8c16',
};

// QI is the quality_inspectors lane — separate from the warehouse manager
// who received the goods (segregation of duties). Show the Complete /
// Cancel action buttons only for users who actually run QI.
const _canRunQI = (userRoleCodes) => {
  const codes = new Set(userRoleCodes || []);
  return codes.has('quality_inspector')
    || codes.has('super_admin')
    || codes.has('admin');
};

const QualityInspection = () => {
  const user = useAuthStore((s) => s.user);
  const userRoleCodes = (user?.roles || []).map(
    (r) => (r?.code || r?.role_code || '').toLowerCase()
  );
  const canRunQI = _canRunQI(userRoleCodes);
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [viewData, setViewData] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterResult, setFilterResult] = useState(undefined);
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterDateRange, setFilterDateRange] = useState(null);

  // Drawer state
  const [qiItems, setQiItems] = useState([]);
  const [grnOptions, setGrnOptions] = useState([]);
  const [selectedGRN, setSelectedGRN] = useState(null);
  const [loadingGRN, setLoadingGRN] = useState(false);
  const [overallResult, setOverallResult] = useState(null);

  // --- Lookups ---
  const loadGRNOptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/warehouse/grn', {
        params: { page_size: 50, search, status: 'draft,pending_qi,qi_in_progress' },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setGrnOptions(
        items.map((grn) => ({
          label: `${grn.grn_number} - ${grn.vendor_name || 'Unknown Vendor'} (${formatDate(grn.grn_date)})`,
          value: grn.id,
          grn,
        }))
      );
    } catch {
      // silent
    }
  }, []);

  // --- Fetch QIs ---
  const fetchQIs = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterResult) qp.overall_result = filterResult;
      if (filterStatus) qp.status = filterStatus;
      if (filterDateRange && filterDateRange[0]) {
        qp.date_from = formatDateForAPI(filterDateRange[0]);
        qp.date_to = formatDateForAPI(filterDateRange[1]);
      }
      return await api.get('/warehouse/quality-inspections', { params: qp });
    },
    [filterResult, filterStatus, filterDateRange]
  );

  // --- GRN Selection ---
  const handleGRNSelect = async (grnId) => {
    if (!grnId) {
      setSelectedGRN(null);
      setQiItems([]);
      return;
    }
    setLoadingGRN(true);
    try {
      const res = await api.get(`/warehouse/grn/${grnId}`);
      const grnData = res.data;
      setSelectedGRN(grnData);

      const items = (grnData.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        grn_item_id: item.id,
        item_id: item.item_id,
        item_name: item.item_name || '',
        item_code: item.item_code || '',
        batch_number: item.batch_number || '',
        received_qty: item.received_qty || 0,
        inspected_qty: item.received_qty || 0,
        accepted_qty: item.received_qty || 0,
        rejected_qty: 0,
        hold_qty: 0,
        result: 'accepted',
        rejection_reason: '',
        remarks: '',
      }));
      setQiItems(items);
      calculateOverallResult(items);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoadingGRN(false);
    }
  };

  // --- Item Updates ---
  const updateQiItem = (key, field, value) => {
    setQiItems((prev) => {
      const updated = prev.map((item) => {
        if (item.key !== key) return item;
        const newItem = { ...item, [field]: value };

        // Auto-calculate accepted = inspected - rejected - hold
        if (field === 'inspected_qty' || field === 'rejected_qty' || field === 'hold_qty') {
          const inspected = field === 'inspected_qty' ? (value || 0) : (newItem.inspected_qty || 0);
          const rejected = field === 'rejected_qty' ? (value || 0) : (newItem.rejected_qty || 0);
          const hold = field === 'hold_qty' ? (value || 0) : (newItem.hold_qty || 0);
          newItem.accepted_qty = Math.max(0, inspected - rejected - hold);
        }

        // Auto-set result based on quantities
        if (field === 'rejected_qty' || field === 'hold_qty' || field === 'inspected_qty') {
          if (newItem.rejected_qty > 0 && newItem.accepted_qty === 0) {
            newItem.result = 'rejected';
          } else if (newItem.hold_qty > 0) {
            newItem.result = 'hold';
          } else if (newItem.rejected_qty > 0) {
            newItem.result = 'accepted'; // partial, but some accepted
          } else {
            newItem.result = 'accepted';
          }
        }

        return newItem;
      });
      calculateOverallResult(updated);
      return updated;
    });
  };

  const calculateOverallResult = (items) => {
    if (!items || items.length === 0) {
      setOverallResult(null);
      return;
    }
    const allAccepted = items.every((i) => i.result === 'accepted');
    const allRejected = items.every((i) => i.result === 'rejected');
    const hasHold = items.some((i) => i.result === 'hold');

    if (allAccepted) {
      setOverallResult('pass');
    } else if (allRejected) {
      setOverallResult('fail');
    } else {
      setOverallResult('partial');
    }
  };

  // --- Open Drawer ---
  const handleAdd = () => {
    form.resetFields();
    form.setFieldsValue({
      inspection_date: dayjs(),
      inspection_type: 'full',
    });
    setQiItems([]);
    setSelectedGRN(null);
    setOverallResult(null);
    loadGRNOptions();
    setDrawerOpen(true);
  };

  // --- View Detail ---
  const handleView = async (record) => {
    setViewLoading(true);
    setViewModalOpen(true);
    try {
      const res = await api.get(`/warehouse/quality-inspections/${record.id}`);
      setViewData(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
      setViewModalOpen(false);
    } finally {
      setViewLoading(false);
    }
  };

  // --- Submit ---
  const handleSubmit = async (submitAction = 'draft') => {
    try {
      const values = await form.validateFields();
      if (qiItems.length === 0) {
        message.error('No items to inspect. Please select a GRN.');
        return;
      }
      setSubmitting(true);

      let status = 'draft';
      if (submitAction === 'start') status = 'in_progress';
      if (submitAction === 'complete') status = 'completed';

      const payload = {
        ...values,
        grn_id: values.grn_id,
        inspection_date: formatDateForAPI(values.inspection_date),
        inspection_type: values.inspection_type,
        overall_result: overallResult,
        status,
        remarks: values.remarks,
        items: qiItems.map((item) => ({
          grn_item_id: item.grn_item_id,
          item_id: item.item_id,
          inspected_qty: item.inspected_qty,
          accepted_qty: item.accepted_qty,
          rejected_qty: item.rejected_qty,
          hold_qty: item.hold_qty,
          result: item.result,
          rejection_reason: item.rejection_reason,
          remarks: item.remarks,
        })),
      };

      await api.post('/warehouse/quality-inspections', payload);
      message.success('Quality Inspection created successfully');

      if (submitAction === 'complete') {
        message.info('Putaway will be auto-generated for accepted items.');
      }

      setDrawerOpen(false);
      form.resetFields();
      setQiItems([]);
      setSelectedGRN(null);
      setOverallResult(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // --- Actions ---
  const handleCompleteQI = async (id) => {
    try {
      await api.put(`/warehouse/quality-inspections/${id}/complete`);
      message.success('Quality Inspection completed. Redirecting to Putaway...', 2);
      setRefreshKey((k) => k + 1);
      setTimeout(() => navigate('/warehouse/putaway'), 1200);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleCancelQI = async (id) => {
    try {
      await api.put(`/warehouse/quality-inspections/${id}/cancel`);
      message.success('Quality Inspection cancelled');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- QI Items Columns (Drawer) ---
  const qiItemColumns = [
    { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item', dataIndex: 'item_name', width: 180, ellipsis: true,
      render: (v, r) => (
        <Tooltip title={`${r.item_code || ''} - ${v}`}>
          <Text ellipsis style={{ maxWidth: 160 }}>{v}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Batch', dataIndex: 'batch_number', width: 90,
      render: (v) => v || '-',
    },
    {
      title: 'Received', dataIndex: 'received_qty', width: 80, align: 'center',
      render: (v) => <Text type="secondary">{formatNumber(v)}</Text>,
    },
    {
      title: 'Inspected', dataIndex: 'inspected_qty', width: 90,
      render: (val, record) => (
        <InputNumber
          min={0}
          max={record.received_qty}
          value={val}
          onChange={(v) => updateQiItem(record.key, 'inspected_qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'Accepted', dataIndex: 'accepted_qty', width: 85, align: 'center',
      render: (v) => <Text style={{ color: '#52c41a', fontWeight: 600 }}>{formatNumber(v)}</Text>,
    },
    {
      title: 'Rejected', dataIndex: 'rejected_qty', width: 85,
      render: (val, record) => (
        <InputNumber
          min={0}
          max={record.inspected_qty}
          value={val}
          onChange={(v) => updateQiItem(record.key, 'rejected_qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
          status={val > 0 ? 'error' : undefined}
        />
      ),
    },
    {
      title: 'Hold', dataIndex: 'hold_qty', width: 80,
      render: (val, record) => (
        <InputNumber
          min={0}
          max={record.inspected_qty - (record.rejected_qty || 0)}
          value={val}
          onChange={(v) => updateQiItem(record.key, 'hold_qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
          status={val > 0 ? 'warning' : undefined}
        />
      ),
    },
    {
      title: 'Result', dataIndex: 'result', width: 120,
      render: (val, record) => (
        <Select
          value={val}
          onChange={(v) => updateQiItem(record.key, 'result', v)}
          options={QI_RESULT_OPTIONS}
          size="small"
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Rejection Reason', dataIndex: 'rejection_reason', width: 160,
      render: (val, record) => (
        <Input
          value={val}
          onChange={(e) => updateQiItem(record.key, 'rejection_reason', e.target.value)}
          size="small"
          placeholder={record.result === 'rejected' ? 'Reason required...' : 'Optional'}
          disabled={record.result === 'accepted'}
        />
      ),
    },
    {
      title: 'Remarks', dataIndex: 'remarks', width: 140,
      render: (val, record) => (
        <Input
          value={val}
          onChange={(e) => updateQiItem(record.key, 'remarks', e.target.value)}
          size="small"
          placeholder="Remarks"
        />
      ),
    },
  ];

  // --- View Detail Columns ---
  const viewItemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
    { title: 'Item', dataIndex: 'item_name', width: 180, ellipsis: true },
    { title: 'Batch', dataIndex: 'batch_number', width: 90, render: (v) => v || '-' },
    { title: 'Inspected', dataIndex: 'inspected_qty', width: 90, align: 'right', render: (v) => formatNumber(v) },
    {
      title: 'Accepted', dataIndex: 'accepted_qty', width: 90, align: 'right',
      render: (v) => <Text style={{ color: '#52c41a', fontWeight: 600 }}>{formatNumber(v)}</Text>,
    },
    {
      title: 'Rejected', dataIndex: 'rejected_qty', width: 90, align: 'right',
      render: (v) => <Text style={{ color: v > 0 ? '#f5222d' : undefined, fontWeight: v > 0 ? 600 : 400 }}>{formatNumber(v)}</Text>,
    },
    {
      title: 'Hold', dataIndex: 'hold_qty', width: 80, align: 'right',
      render: (v) => <Text style={{ color: v > 0 ? '#fa8c16' : undefined, fontWeight: v > 0 ? 600 : 400 }}>{formatNumber(v)}</Text>,
    },
    {
      title: 'Result', dataIndex: 'result', width: 110,
      render: (v) => {
        const color = resultColors[v] || '#8c8c8c';
        const label = v ? v.charAt(0).toUpperCase() + v.slice(1) : '-';
        return <Tag style={{ color: '#fff', backgroundColor: color, borderColor: color }}>{label}</Tag>;
      },
    },
    { title: 'Rejection Reason', dataIndex: 'rejection_reason', width: 180, render: (v) => v || '-' },
    { title: 'Remarks', dataIndex: 'remarks', width: 150, render: (v) => v || '-' },
  ];

  // --- Main Table Columns ---
  const columns = [
    {
      title: 'QI Number',
      dataIndex: 'qi_number',
      key: 'qi_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => handleView(record)}>{text}</a>,
    },
    {
      title: 'GRN Reference',
      dataIndex: 'grn_number',
      key: 'grn_number',
      width: 150,
      render: (v) => v || '-',
    },
    {
      title: 'Inspection Date',
      dataIndex: 'inspection_date',
      key: 'inspection_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Inspection Type',
      dataIndex: 'inspection_type',
      key: 'inspection_type',
      width: 140,
      render: (v) => {
        const typeMap = { full: 'Full', sample: 'Sample', visual: 'Visual', measurement: 'Measurement' };
        return <Tag>{typeMap[v] || v || '-'}</Tag>;
      },
    },
    {
      title: 'Overall Result',
      dataIndex: 'overall_result',
      key: 'overall_result',
      width: 120,
      render: (v) => {
        if (!v) return <Tag color="default">Pending</Tag>;
        const color = resultColors[v] || '#8c8c8c';
        const label = v === 'pass' ? 'Pass' : v === 'fail' ? 'Fail' : 'Partial';
        return <Tag style={{ color: '#fff', backgroundColor: color, borderColor: color }}>{label}</Tag>;
      },
    },
    {
      title: 'Inspected By',
      dataIndex: 'inspected_by_name',
      key: 'inspected_by',
      width: 140,
      render: (v, r) => v || r.inspected_by || '-',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View Detail">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(record)} />
          </Tooltip>
          {canRunQI && (record.status === 'draft' || record.status === 'in_progress') && (
            <Tooltip title="Complete Inspection">
              <Popconfirm
                title="Complete this Quality Inspection? This will trigger putaway generation for accepted items."
                onConfirm={() => handleCompleteQI(record.id)}
              >
                <Button type="link" size="small" icon={<CheckOutlined />} style={{ color: '#52c41a' }} />
              </Popconfirm>
            </Tooltip>
          )}
          {canRunQI && record.status === 'draft' && (
            <Tooltip title="Cancel">
              <Popconfirm title="Cancel this Quality Inspection?" onConfirm={() => handleCancelQI(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<CloseCircleOutlined />} />
              </Popconfirm>
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  // --- Filter Toolbar ---
  const toolbar = (
    <Space style={{ marginLeft: 12 }} wrap>
      <Select
        placeholder="Result"
        allowClear
        style={{ width: 120 }}
        value={filterResult}
        onChange={(v) => { setFilterResult(v); setRefreshKey((k) => k + 1); }}
        options={RESULT_FILTER_OPTIONS}
      />
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 140 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={QI_STATUSES}
      />
      <DatePicker.RangePicker
        value={filterDateRange}
        onChange={(dates) => { setFilterDateRange(dates); setRefreshKey((k) => k + 1); }}
        format={DATE_FORMAT}
        style={{ width: 240 }}
        placeholder={['From Date', 'To Date']}
      />
    </Space>
  );

  // --- Overall Result Display ---
  const getOverallResultDisplay = () => {
    if (!overallResult) return null;
    const config = {
      pass: { color: '#52c41a', bg: '#f6ffed', border: '#b7eb8f', label: 'PASS - All items accepted', icon: <CheckOutlined /> },
      fail: { color: '#f5222d', bg: '#fff2f0', border: '#ffccc7', label: 'FAIL - All items rejected', icon: <CloseCircleOutlined /> },
      partial: { color: '#fa8c16', bg: '#fffbe6', border: '#ffe58f', label: 'PARTIAL - Mixed results', icon: <WarningOutlined /> },
    };
    const c = config[overallResult];
    return (
      <Alert
        message={<Text strong style={{ color: c.color }}>{c.label}</Text>}
        type={overallResult === 'pass' ? 'success' : overallResult === 'fail' ? 'error' : 'warning'}
        showIcon
        icon={c.icon}
        style={{ marginBottom: 16 }}
      />
    );
  };

  return (
    <div>
      <PageHeader title="Quality Inspection" subtitle="Manage inbound quality inspections">
        <Space>
          {canRunQI && (
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              Create QI
            </Button>
          )}
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchQIs}
        rowKey="id"
        searchPlaceholder="Search by QI number, GRN number..."
        exportFileName="quality_inspections"
        toolbar={toolbar}
        scroll={{ x: 1200 }}
      />

      {/* --- Create Drawer --- */}
      <Drawer
        title="Create Quality Inspection"
        width={1100}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          form.resetFields();
          setQiItems([]);
          setSelectedGRN(null);
          setOverallResult(null);
        }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); form.resetFields(); setQiItems([]); setSelectedGRN(null); }}>
              Cancel
            </Button>
            <Button onClick={() => handleSubmit('draft')} loading={submitting}>
              Save as Draft
            </Button>
            <Button onClick={() => handleSubmit('start')} loading={submitting}>
              Start Inspection
            </Button>
            <Button
              type="primary"
              icon={<CheckOutlined />}
              onClick={() => handleSubmit('complete')}
              loading={submitting}
            >
              Complete &amp; Generate Putaway
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={10}>
              <Form.Item name="grn_id" label="Select GRN" rules={[{ required: true, message: 'Please select a GRN' }]}>
                <Select
                  options={grnOptions}
                  placeholder="Search and select GRN..."
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  onChange={handleGRNSelect}
                  onSearch={(v) => loadGRNOptions(v)}
                  loading={loadingGRN}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="inspection_date" label="Inspection Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="inspection_type" label="Inspection Type" rules={[{ required: true, message: 'Required' }]}>
                <Select options={INSPECTION_TYPES} placeholder="Select type" />
              </Form.Item>
            </Col>
          </Row>

          {/* GRN Summary */}
          {selectedGRN && (
            <Card size="small" style={{ background: '#f9f9f9', marginBottom: 16 }}>
              <Descriptions size="small" column={4}>
                <Descriptions.Item label="GRN Number">{selectedGRN.grn_number}</Descriptions.Item>
                <Descriptions.Item label="Vendor">{selectedGRN.vendor_name || '-'}</Descriptions.Item>
                <Descriptions.Item label="GRN Date">{formatDate(selectedGRN.grn_date)}</Descriptions.Item>
                <Descriptions.Item label="Total Qty">{formatNumber(selectedGRN.total_qty)}</Descriptions.Item>
              </Descriptions>
            </Card>
          )}

          <Form.Item name="remarks" label="Remarks">
            <TextArea rows={2} placeholder="General inspection remarks..." />
          </Form.Item>
        </Form>

        {/* Overall Result */}
        {getOverallResultDisplay()}

        {/* Items Table */}
        {qiItems.length > 0 && (
          <>
            <Divider orientation="left">
              <Space>
                <ExperimentOutlined />
                Inspection Items
                <Badge count={qiItems.length} style={{ backgroundColor: '#eb2f96' }} />
              </Space>
            </Divider>
            <Table
              dataSource={qiItems}
              columns={qiItemColumns}
              rowKey="key"
              pagination={false}
              size="small"
              scroll={{ x: 1400 }}
              loading={loadingGRN}
            />

            {/* Summary Stats */}
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
              <div style={{ width: 380 }}>
                <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <Col span={14}><Text>Total Inspected:</Text></Col>
                  <Col span={10} style={{ textAlign: 'right' }}>
                    <Text strong>{formatNumber(qiItems.reduce((s, i) => s + (i.inspected_qty || 0), 0))}</Text>
                  </Col>
                </Row>
                <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <Col span={14}><Text>Total Accepted:</Text></Col>
                  <Col span={10} style={{ textAlign: 'right' }}>
                    <Text style={{ color: '#52c41a', fontWeight: 600 }}>
                      {formatNumber(qiItems.reduce((s, i) => s + (i.accepted_qty || 0), 0))}
                    </Text>
                  </Col>
                </Row>
                <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <Col span={14}><Text>Total Rejected:</Text></Col>
                  <Col span={10} style={{ textAlign: 'right' }}>
                    <Text style={{ color: '#f5222d', fontWeight: 600 }}>
                      {formatNumber(qiItems.reduce((s, i) => s + (i.rejected_qty || 0), 0))}
                    </Text>
                  </Col>
                </Row>
                <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <Col span={14}><Text>Total On Hold:</Text></Col>
                  <Col span={10} style={{ textAlign: 'right' }}>
                    <Text style={{ color: '#fa8c16', fontWeight: 600 }}>
                      {formatNumber(qiItems.reduce((s, i) => s + (i.hold_qty || 0), 0))}
                    </Text>
                  </Col>
                </Row>
                <Row style={{ padding: '8px 0', background: '#fafafa', borderRadius: 4, marginTop: 4 }}>
                  <Col span={14}><Text strong style={{ fontSize: 15 }}>Overall Result:</Text></Col>
                  <Col span={10} style={{ textAlign: 'right' }}>
                    {overallResult ? (
                      <Tag
                        style={{
                          color: '#fff',
                          backgroundColor: resultColors[overallResult] || '#8c8c8c',
                          borderColor: resultColors[overallResult] || '#8c8c8c',
                          fontSize: 14,
                          padding: '2px 12px',
                        }}
                      >
                        {overallResult.toUpperCase()}
                      </Tag>
                    ) : (
                      <Text type="secondary">-</Text>
                    )}
                  </Col>
                </Row>
              </div>
            </div>
          </>
        )}
      </Drawer>

      {/* --- View Detail Modal --- */}
      <Modal
        title={viewData ? `Quality Inspection: ${viewData.qi_number}` : 'QI Detail'}
        open={viewModalOpen}
        onCancel={() => { setViewModalOpen(false); setViewData(null); }}
        footer={
          viewData && (
            <Space>
              {canRunQI && (viewData.status === 'draft' || viewData.status === 'in_progress') && (
                <Popconfirm
                  title="Complete this QI? Putaway will be auto-generated."
                  onConfirm={async () => { await handleCompleteQI(viewData.id); setViewModalOpen(false); }}
                >
                  <Button type="primary" icon={<CheckOutlined />}>Complete &amp; Generate Putaway</Button>
                </Popconfirm>
              )}
              <Button onClick={() => { setViewModalOpen(false); setViewData(null); }}>Close</Button>
            </Space>
          )
        }
        width={1000}
        loading={viewLoading}
      >
        {viewData && (
          <>
            <Descriptions bordered size="small" column={3} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="QI Number">{viewData.qi_number}</Descriptions.Item>
              <Descriptions.Item label="Status"><StatusTag status={viewData.status} /></Descriptions.Item>
              <Descriptions.Item label="Overall Result">
                {viewData.overall_result ? (
                  <Tag
                    style={{
                      color: '#fff',
                      backgroundColor: resultColors[viewData.overall_result] || '#8c8c8c',
                      borderColor: resultColors[viewData.overall_result] || '#8c8c8c',
                    }}
                  >
                    {viewData.overall_result.toUpperCase()}
                  </Tag>
                ) : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="GRN Reference">{viewData.grn_number || '-'}</Descriptions.Item>
              <Descriptions.Item label="Inspection Date">{formatDate(viewData.inspection_date)}</Descriptions.Item>
              <Descriptions.Item label="Inspection Type">
                <Tag>{viewData.inspection_type || '-'}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Inspected By">{viewData.inspected_by_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Created At">{formatDateTime(viewData.created_at)}</Descriptions.Item>
              <Descriptions.Item label="Completed At">{viewData.completed_at ? formatDateTime(viewData.completed_at) : '-'}</Descriptions.Item>
            </Descriptions>

            {viewData.remarks && (
              <Alert message={`Remarks: ${viewData.remarks}`} type="info" style={{ marginBottom: 16 }} />
            )}

            <Divider orientation="left">Inspection Items</Divider>
            <Table
              dataSource={viewData.items || []}
              columns={viewItemColumns}
              rowKey="id"
              pagination={false}
              size="small"
              scroll={{ x: 1100 }}
              rowClassName={(record) => {
                if (record.result === 'rejected') return 'row-rejected';
                if (record.result === 'hold') return 'row-hold';
                return '';
              }}
            />
          </>
        )}
      </Modal>
    </div>
  );
};

export default QualityInspection;

