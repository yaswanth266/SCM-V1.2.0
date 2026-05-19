import React, { useState, useCallback } from 'react';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Modal,
  Divider, Typography, Tooltip, Tag, Badge, Alert,
} from 'antd';
import {
  PlusOutlined, EyeOutlined, CheckOutlined, ExperimentOutlined,
  CloseCircleOutlined, WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatDate, formatNumber, getErrorMessage, formatDateForAPI, formatDateTime,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

// Outward QC inspection_type discriminator value sent to backend
// (backend column is `inspection_type` String(50); incoming|outgoing).
const OUTWARD_DISCRIMINATOR = 'outgoing';

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

const resultColors = {
  accepted: '#52c41a',
  pass: '#52c41a',
  rejected: '#f5222d',
  fail: '#f5222d',
  hold: '#fa8c16',
  partial: '#fa8c16',
};

const QCOutward = () => {
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
  const [sourceOptions, setSourceOptions] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
  const [loadingSource, setLoadingSource] = useState(false);
  const [overallResult, setOverallResult] = useState(null);

  // --- Lookups: outward references material issues / picking orders ---
  // We surface Material Issues as the source for outward QC. If the project
  // exposes picking orders later, swap the endpoint here.
  const loadSourceOptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/warehouse/material-issues', {
        params: { page_size: 50, search },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setSourceOptions(
        items.map((mi) => ({
          label: `${mi.mi_number || mi.issue_number || `MI-${mi.id}`} - ${mi.indent_number || mi.reference_number || ''} (${formatDate(mi.issue_date || mi.created_at)})`,
          value: mi.id,
          source: mi,
        }))
      );
    } catch {
      // silent
    }
  }, []);

  // --- Fetch QIs (outward only) ---
  const fetchQIs = useCallback(
    async (params) => {
      const qp = { ...params, inspection_type: OUTWARD_DISCRIMINATOR };
      if (filterResult) qp.overall_result = filterResult;
      if (filterStatus) qp.status = filterStatus;
      if (filterDateRange && filterDateRange[0]) {
        qp.date_from = formatDateForAPI(filterDateRange[0]);
        qp.date_to = formatDateForAPI(filterDateRange[1]);
      }
      // Backend now filters on inspection_type (Wave 3 fix). Trust the response total.
      return await api.get('/warehouse/quality-inspections', { params: qp });
    },
    [filterResult, filterStatus, filterDateRange]
  );

  // --- Source Selection ---
  const handleSourceSelect = async (sourceId) => {
    if (!sourceId) {
      setSelectedSource(null);
      setQiItems([]);
      return;
    }
    setLoadingSource(true);
    try {
      const res = await api.get(`/warehouse/material-issues/${sourceId}`);
      const sourceData = res.data;
      setSelectedSource(sourceData);

      const items = (sourceData.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        // Reuse grn_item_id slot for the outward source line id — backend
        // QualityInspectionItem schema requires it. For outward inspections
        // this stores the material-issue line id; backend treats it as an
        // opaque reference for outward records.
        grn_item_id: item.id,
        item_id: item.item_id,
        item_name: item.item_name || '',
        item_code: item.item_code || '',
        batch_number: item.batch_number || '',
        physical_qty: item.issued_qty || item.quantity || 0,
        inspected_qty: item.issued_qty || item.quantity || 0,
        accepted_qty: item.issued_qty || item.quantity || 0,
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
      setLoadingSource(false);
    }
  };

  // --- Item Updates ---
  const updateQiItem = (key, field, value) => {
    setQiItems((prev) => {
      const updated = prev.map((item) => {
        if (item.key !== key) return item;
        const newItem = { ...item, [field]: value };

        if (field === 'inspected_qty' || field === 'rejected_qty' || field === 'hold_qty') {
          const inspected = field === 'inspected_qty' ? (value || 0) : (newItem.inspected_qty || 0);
          const rejected = field === 'rejected_qty' ? (value || 0) : (newItem.rejected_qty || 0);
          const hold = field === 'hold_qty' ? (value || 0) : (newItem.hold_qty || 0);
          newItem.accepted_qty = Math.max(0, inspected - rejected - hold);
        }

        if (field === 'rejected_qty' || field === 'hold_qty' || field === 'inspected_qty') {
          if (newItem.rejected_qty > 0 && newItem.accepted_qty === 0) {
            newItem.result = 'rejected';
          } else if (newItem.hold_qty > 0) {
            newItem.result = 'hold';
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

    if (allAccepted) {
      setOverallResult('pass');
    } else if (allRejected) {
      setOverallResult('fail');
    } else {
      setOverallResult('partial');
    }
  };

  const handleAdd = () => {
    form.resetFields();
    form.setFieldsValue({
      inspection_date: dayjs(),
    });
    setQiItems([]);
    setSelectedSource(null);
    setOverallResult(null);
    loadSourceOptions();
    setDrawerOpen(true);
  };

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

  const handleSubmit = async (submitAction = 'draft') => {
    try {
      const values = await form.validateFields();
      if (qiItems.length === 0) {
        message.error('No items to inspect. Please select a source document.');
        return;
      }
      setSubmitting(true);

      let status = 'draft';
      if (submitAction === 'start') status = 'in_progress';
      if (submitAction === 'complete') status = 'completed';

      const payload = {
        // grn_id is required by the backend schema. For outward inspections
        // we reuse this slot to point at the source material-issue id; the
        // backend column is a generic FK that the outward flow treats as the
        // "source document" reference.
        grn_id: values.source_id,
        inspection_date: formatDateForAPI(values.inspection_date),
        inspection_type: OUTWARD_DISCRIMINATOR,
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
      message.success('Outward QC created successfully');

      setDrawerOpen(false);
      form.resetFields();
      setQiItems([]);
      setSelectedSource(null);
      setOverallResult(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCompleteQI = async (id) => {
    try {
      await api.put(`/warehouse/quality-inspections/${id}/complete`);
      message.success('Outward QC completed');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleCancelQI = async (id) => {
    try {
      await api.put(`/warehouse/quality-inspections/${id}/cancel`);
      message.success('Outward QC cancelled');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

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
      title: 'Physical Qty', dataIndex: 'physical_qty', width: 100, align: 'center',
      render: (v) => <Text type="secondary">{formatNumber(v)}</Text>,
    },
    {
      title: 'Inspected', dataIndex: 'inspected_qty', width: 90,
      render: (val, record) => (
        <InputNumber
          min={0}
          max={record.physical_qty}
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

  const columns = [
    {
      title: 'QC Number',
      dataIndex: 'qi_number',
      key: 'qi_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => handleView(record)}>{text}</a>,
    },
    {
      title: 'Source Reference',
      dataIndex: 'source_reference',
      key: 'source_reference',
      width: 160,
      render: (v, r) => v || r.mi_number || r.grn_number || '-',
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
      title: 'Type',
      dataIndex: 'inspection_type',
      key: 'inspection_type',
      width: 110,
      render: () => <Tag color="orange">Outward</Tag>,
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
          {(record.status === 'draft' || record.status === 'in_progress') && (
            <Tooltip title="Complete Inspection">
              <Popconfirm
                title="Complete this Outward QC?"
                onConfirm={() => handleCompleteQI(record.id)}
              >
                <Button type="link" size="small" icon={<CheckOutlined />} style={{ color: '#52c41a' }} />
              </Popconfirm>
            </Tooltip>
          )}
          {record.status === 'draft' && (
            <Tooltip title="Cancel">
              <Popconfirm title="Cancel this Outward QC?" onConfirm={() => handleCancelQI(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<CloseCircleOutlined />} />
              </Popconfirm>
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

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

  const getOverallResultDisplay = () => {
    if (!overallResult) return null;
    const config = {
      pass: { color: '#52c41a', label: 'PASS - All items accepted', icon: <CheckOutlined /> },
      fail: { color: '#f5222d', label: 'FAIL - All items rejected', icon: <CloseCircleOutlined /> },
      partial: { color: '#fa8c16', label: 'PARTIAL - Mixed results', icon: <WarningOutlined /> },
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
      <PageHeader title="QC Outward" subtitle="Pre-dispatch quality check vs physical stock">
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            New QC
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchQIs}
        rowKey="id"
        searchPlaceholder="Search by QC number, source ref..."
        exportFileName="qc_outward"
        toolbar={toolbar}
        scroll={{ x: 1200 }}
      />

      <Drawer
        title="New Outward QC"
        width={1100}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          form.resetFields();
          setQiItems([]);
          setSelectedSource(null);
          setOverallResult(null);
        }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); form.resetFields(); setQiItems([]); setSelectedSource(null); }}>
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
              Complete Outward QC
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" requiredMark="optional">
          <Row gutter={16}>
            <Col span={14}>
              <Form.Item name="source_id" label="Source Document (Material Issue / Picking Order)" rules={[{ required: true, message: 'Please select a source document' }]}>
                <Select
                  options={sourceOptions}
                  placeholder="Search and select source..."
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  onChange={handleSourceSelect}
                  onSearch={(v) => loadSourceOptions(v)}
                  loading={loadingSource}
                />
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item name="inspection_date" label="Inspection Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
          </Row>

          {selectedSource && (
            <Card size="small" style={{ background: '#f9f9f9', marginBottom: 16 }}>
              <Descriptions size="small" column={4}>
                <Descriptions.Item label="MI Number">{selectedSource.mi_number || selectedSource.issue_number || '-'}</Descriptions.Item>
                <Descriptions.Item label="Indent Ref">{selectedSource.indent_number || selectedSource.reference_number || '-'}</Descriptions.Item>
                <Descriptions.Item label="Issue Date">{formatDate(selectedSource.issue_date || selectedSource.created_at)}</Descriptions.Item>
                <Descriptions.Item label="Total Qty">{formatNumber(selectedSource.total_qty || (selectedSource.items || []).reduce((s, i) => s + (i.issued_qty || i.quantity || 0), 0))}</Descriptions.Item>
              </Descriptions>
            </Card>
          )}

          <Form.Item name="remarks" label="Remarks">
            <TextArea rows={2} placeholder="General outward QC remarks..." />
          </Form.Item>
        </Form>

        {getOverallResultDisplay()}

        {qiItems.length > 0 && (
          <>
            <Divider orientation="left">
              <Space>
                <ExperimentOutlined />
                Outward QC Items
                <Badge count={qiItems.length} style={{ backgroundColor: '#fa8c16' }} />
              </Space>
            </Divider>
            <Table
              dataSource={qiItems}
              columns={qiItemColumns}
              rowKey="key"
              pagination={false}
              size="small"
              scroll={{ x: 1400 }}
              loading={loadingSource}
            />

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

      <Modal
        title={viewData ? `Outward QC: ${viewData.qi_number}` : 'QC Detail'}
        open={viewModalOpen}
        onCancel={() => { setViewModalOpen(false); setViewData(null); }}
        footer={
          viewData && (
            <Space>
              {(viewData.status === 'draft' || viewData.status === 'in_progress') && (
                <Popconfirm
                  title="Complete this Outward QC?"
                  onConfirm={async () => { await handleCompleteQI(viewData.id); setViewModalOpen(false); }}
                >
                  <Button type="primary" icon={<CheckOutlined />}>Complete</Button>
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
              <Descriptions.Item label="QC Number">{viewData.qi_number}</Descriptions.Item>
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
              <Descriptions.Item label="Source Reference">{viewData.source_reference || viewData.mi_number || viewData.grn_number || '-'}</Descriptions.Item>
              <Descriptions.Item label="Inspection Date">{formatDate(viewData.inspection_date)}</Descriptions.Item>
              <Descriptions.Item label="Inspection Type">
                <Tag color="orange">Outward</Tag>
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

export default QCOutward;

