import React, { useState, useCallback } from 'react';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Tabs,
  Divider, Typography, Tooltip, Tag, Spin,
} from 'antd';
import {
  PlusOutlined, EditOutlined, EyeOutlined, ArrowLeftOutlined,
  SendOutlined, CloseCircleOutlined, CheckCircleOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import AttachmentUploader, { uploadStagedAttachments } from '../../components/AttachmentUploader';
import {
  formatDate, formatNumber, getErrorMessage, formatDateForAPI,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const REQUIREMENT_TYPES = [
  { label: 'Material Dispatch', value: 'material_dispatch' },
  { label: 'Inter-Warehouse', value: 'inter_warehouse' },
  { label: 'Vendor Delivery', value: 'vendor_delivery' },
  { label: 'Customer Shipment', value: 'customer_shipment' },
];

const VEHICLE_TYPES = [
  { label: 'Mini Truck', value: 'mini_truck' },
  { label: 'LCV', value: 'lcv' },
  { label: 'Truck (10T)', value: 'truck_10t' },
  { label: 'Truck (20T)', value: 'truck_20t' },
  { label: 'Trailer', value: 'trailer' },
  { label: 'Container', value: 'container' },
  { label: 'Tempo', value: 'tempo' },
  { label: 'Courier', value: 'courier' },
];

const PRIORITIES = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Critical', value: 'critical' },
];

const PRIORITY_COLORS = {
  low: 'blue',
  medium: 'gold',
  high: 'orange',
  critical: 'red',
};

const STATUS_FLOW = ['draft', 'open', 'in_progress', 'closed'];

const TransportRequirements = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterType, setFilterType] = useState(undefined);
  const [filterPriority, setFilterPriority] = useState(undefined);

  const [detailRecord, setDetailRecord] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState('info');
  const [linkedQuotations, setLinkedQuotations] = useState([]);
  const [tabLoading, setTabLoading] = useState(false);

  const [warehouses, setWarehouses] = useState([]);
  // CR_01/17: staged attachments uploaded after the TR is created
  const [stagedAttachments, setStagedAttachments] = useState([]);

  const loadLookups = useCallback(async () => {
    try {
      const [whRes] = await Promise.allSettled([
        api.get('/masters/warehouses', { params: { page_size: 200 } }),
      ]);
      if (whRes.status === 'fulfilled') {
        const w = whRes.value.data;
        setWarehouses((w.items || w.data || w || []).map((i) => ({
          label: i.name || i.warehouse_name, value: i.id,
        })));
      }
    } catch { /* silent */ }
  }, []);

  const fetchData = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterType) qp.requirement_type = filterType;
      if (filterPriority) qp.priority = filterPriority;
      return await api.get('/logistics/transport-requirements', { params: qp });
    },
    [filterStatus, filterType, filterPriority]
  );

  const handleAdd = () => {
    setEditingRecord(null);
    form.resetFields();
    form.setFieldsValue({
      requirement_type: 'material_dispatch',
      priority: 'medium',
      expected_dispatch_date: dayjs().add(2, 'day'),
    });
    loadLookups();
    setDrawerOpen(true);
  };

  const handleEdit = async (record) => {
    setEditingRecord(record);
    loadLookups();
    try {
      const res = await api.get(`/logistics/transport-requirements/${record.id}`);
      const data = res.data;
      form.setFieldsValue({
        ...data,
        expected_dispatch_date: data.expected_dispatch_date ? dayjs(data.expected_dispatch_date) : null,
        expected_delivery_date: data.expected_delivery_date ? dayjs(data.expected_delivery_date) : null,
        dispatch_warehouse_id: data.dispatch_warehouse_id,
      });
    } catch (err) {
      message.error(getErrorMessage(err));
      return;
    }
    setDrawerOpen(true);
  };

  const handleSubmit = async (submitNow = false) => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload = {
        ...values,
        expected_dispatch_date: formatDateForAPI(values.expected_dispatch_date),
        expected_delivery_date: formatDateForAPI(values.expected_delivery_date),
        status: submitNow ? 'open' : 'draft',
      };
      let trId = editingRecord?.id;
      if (editingRecord) {
        await api.put(`/logistics/transport-requirements/${editingRecord.id}`, payload);
        message.success(submitNow ? 'Requirement submitted' : 'Requirement updated');
      } else {
        const r = await api.post('/logistics/transport-requirements', payload);
        trId = r.data?.id || r.data?.data?.id;
        message.success(submitNow ? 'Requirement created and submitted' : 'Requirement created as draft');
      }
      // CR_01/17 — upload any staged attachments now that we have an id
      if (trId && stagedAttachments.length > 0) {
        await uploadStagedAttachments('transport_requirement', trId, stagedAttachments);
        setStagedAttachments([]);
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingRecord(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAction = async (id, action) => {
    try {
      await api.put(`/logistics/transport-requirements/${id}/${action}`);
      message.success(`Requirement ${action === 'submit' ? 'submitted' : action === 'close' ? 'closed' : 'cancelled'}`);
      setRefreshKey((k) => k + 1);
      if (detailRecord && detailRecord.id === id) {
        const newStatus = action === 'submit' ? 'open' : action === 'close' ? 'closed' : 'cancelled';
        setDetailRecord((prev) => ({ ...prev, status: newStatus }));
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleView = async (record) => {
    setDetailLoading(true);
    setDetailRecord(null);
    setDetailTab('info');
    setLinkedQuotations([]);
    try {
      const res = await api.get(`/logistics/transport-requirements/${record.id}`);
      setDetailRecord(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const fetchLinkedQuotations = async () => {
    if (!detailRecord) return;
    setTabLoading(true);
    try {
      const res = await api.get(`/logistics/transport-requirements/${detailRecord.id}/quotations`, { params: { page_size: 100 } });
      setLinkedQuotations(res.data.items || res.data.data || res.data || []);
    } catch { /* silent */ }
    finally { setTabLoading(false); }
  };

  const columns = [
    {
      title: 'Requirement #',
      dataIndex: 'requirement_number',
      key: 'requirement_number',
      width: 160,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => handleView(record)}>{text}</a>,
    },
    {
      title: 'Type',
      dataIndex: 'requirement_type',
      key: 'requirement_type',
      width: 150,
      render: (v) => {
        const found = REQUIREMENT_TYPES.find((t) => t.value === v);
        return <Tag>{found ? found.label : (v || '-')}</Tag>;
      },
    },
    {
      title: 'Dispatch Location',
      dataIndex: 'dispatch_location',
      key: 'dispatch_location',
      width: 160,
      render: (v, r) => v || r.dispatch_warehouse_name || '-',
    },
    {
      title: 'Destination',
      dataIndex: 'destination',
      key: 'destination',
      width: 160,
      render: (v, r) => v || r.destination_warehouse_name || '-',
    },
    {
      title: 'Material Description',
      dataIndex: 'material_description',
      key: 'material_description',
      width: 200,
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: 'Vehicle Type',
      dataIndex: 'vehicle_type_required',
      key: 'vehicle_type_required',
      width: 130,
      render: (v) => {
        const found = VEHICLE_TYPES.find((t) => t.value === v);
        return found ? found.label : (v || '-');
      },
    },
    {
      title: 'Dispatch Date',
      dataIndex: 'expected_dispatch_date',
      key: 'expected_dispatch_date',
      width: 130,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Priority',
      dataIndex: 'priority',
      key: 'priority',
      width: 100,
      render: (v) => <Tag color={PRIORITY_COLORS[v] || 'default'}>{(v || '').charAt(0).toUpperCase() + (v || '').slice(1)}</Tag>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(record)} />
          {record.status === 'draft' && (
            <>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
              <Tooltip title="Submit">
                <Button type="link" size="small" icon={<SendOutlined />} onClick={() => handleAction(record.id, 'submit')} />
              </Tooltip>
            </>
          )}
          {record.status === 'open' && (
            <Tooltip title="Close">
              <Popconfirm title="Close this requirement?" onConfirm={() => handleAction(record.id, 'close')}>
                <Button type="link" size="small" icon={<CheckCircleOutlined />} />
              </Popconfirm>
            </Tooltip>
          )}
          {['draft', 'open'].includes(record.status) && (
            <Popconfirm title="Cancel this requirement?" onConfirm={() => handleAction(record.id, 'cancel')} okButtonProps={{ danger: true }}>
              <Button type="link" size="small" danger icon={<CloseCircleOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 150 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Draft', value: 'draft' },
          { label: 'Open', value: 'open' },
          { label: 'In Progress', value: 'in_progress' },
          { label: 'Closed', value: 'closed' },
          { label: 'Cancelled', value: 'cancelled' },
        ]}
      />
      <Select
        placeholder="Type"
        allowClear
        style={{ width: 160 }}
        value={filterType}
        onChange={(v) => { setFilterType(v); setRefreshKey((k) => k + 1); }}
        options={REQUIREMENT_TYPES}
      />
      <Select
        placeholder="Priority"
        allowClear
        style={{ width: 120 }}
        value={filterPriority}
        onChange={(v) => { setFilterPriority(v); setRefreshKey((k) => k + 1); }}
        options={PRIORITIES}
      />
    </Space>
  );

  // DETAIL VIEW
  if (detailLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (detailRecord) {
    const statusIdx = STATUS_FLOW.indexOf(detailRecord.status);
    return (
      <div>
        <PageHeader title={detailRecord.requirement_number} subtitle="Transport Requirement Detail">
          <Space>
            {detailRecord.status === 'draft' && (
              <>
                <Button type="primary" icon={<SendOutlined />} onClick={() => handleAction(detailRecord.id, 'submit')}>
                  Submit
                </Button>
                <Button icon={<EditOutlined />} onClick={() => { handleEdit(detailRecord); setDetailRecord(null); }}>
                  Edit
                </Button>
              </>
            )}
            {detailRecord.status === 'open' && (
              <Popconfirm title="Close this requirement?" onConfirm={() => handleAction(detailRecord.id, 'close')}>
                <Button icon={<CheckCircleOutlined />}>Close</Button>
              </Popconfirm>
            )}
            {['draft', 'open'].includes(detailRecord.status) && (
              <Popconfirm title="Cancel this requirement?" onConfirm={() => handleAction(detailRecord.id, 'cancel')} okButtonProps={{ danger: true }}>
                <Button danger icon={<CloseCircleOutlined />}>Cancel</Button>
              </Popconfirm>
            )}
            <Button icon={<ArrowLeftOutlined />} onClick={() => setDetailRecord(null)}>Back to List</Button>
          </Space>
        </PageHeader>

        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {STATUS_FLOW.map((s, idx) => {
              const isCurrent = s === detailRecord.status;
              const isPast = idx < statusIdx;
              const isCancelled = detailRecord.status === 'cancelled';
              return (
                <Tag key={s} color={isCancelled ? 'default' : isCurrent ? 'blue' : isPast ? 'green' : 'default'} style={{ padding: '4px 12px', fontSize: 13 }}>
                  {s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </Tag>
              );
            })}
            {detailRecord.status === 'cancelled' && <Tag color="red" style={{ padding: '4px 12px', fontSize: 13 }}>Cancelled</Tag>}
          </div>
        </Card>

        <Card>
          <Tabs
            activeKey={detailTab}
            onChange={(tab) => { setDetailTab(tab); if (tab === 'quotations') fetchLinkedQuotations(); }}
            items={[
              {
                key: 'info',
                label: 'Requirement Info',
                children: (
                  <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
                    <Descriptions.Item label="Requirement #">{detailRecord.requirement_number}</Descriptions.Item>
                    <Descriptions.Item label="Type">
                      {REQUIREMENT_TYPES.find((t) => t.value === detailRecord.requirement_type)?.label || detailRecord.requirement_type || '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="Status"><StatusTag status={detailRecord.status} /></Descriptions.Item>
                    <Descriptions.Item label="Dispatch Location">{detailRecord.dispatch_location || detailRecord.dispatch_warehouse_name || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Destination">{detailRecord.destination || detailRecord.destination_warehouse_name || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Material Description">{detailRecord.material_description || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Total Qty">{formatNumber(detailRecord.total_qty)}</Descriptions.Item>
                    <Descriptions.Item label="Total Weight">{detailRecord.total_weight ? `${detailRecord.total_weight} kg` : '-'}</Descriptions.Item>
                    <Descriptions.Item label="Total Volume">{detailRecord.total_volume ? `${detailRecord.total_volume} m3` : '-'}</Descriptions.Item>
                    <Descriptions.Item label="Vehicle Type Required">
                      {VEHICLE_TYPES.find((t) => t.value === detailRecord.vehicle_type_required)?.label || detailRecord.vehicle_type_required || '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="Expected Dispatch">{formatDate(detailRecord.expected_dispatch_date)}</Descriptions.Item>
                    <Descriptions.Item label="Expected Delivery">{formatDate(detailRecord.expected_delivery_date)}</Descriptions.Item>
                    <Descriptions.Item label="Priority">
                      <Tag color={PRIORITY_COLORS[detailRecord.priority] || 'default'}>
                        {(detailRecord.priority || '').charAt(0).toUpperCase() + (detailRecord.priority || '').slice(1)}
                      </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="Created By">{detailRecord.created_by_name || detailRecord.created_by || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Quotations Count">
                      <Text strong>{detailRecord.quotations_count || 0}</Text>
                    </Descriptions.Item>
                    <Descriptions.Item label="Remarks" span={3}>{detailRecord.remarks || '-'}</Descriptions.Item>
                  </Descriptions>
                ),
              },
              {
                key: 'quotations',
                label: `Quotations (${detailRecord.quotations_count || 0})`,
                children: (
                  <Table
                    dataSource={linkedQuotations}
                    loading={tabLoading}
                    rowKey="id"
                    size="small"
                    pagination={{ pageSize: 20, showSizeChanger: true }}
                    scroll={{ x: 'max-content' }}
                    columns={[
                      { title: 'Quotation #', dataIndex: 'quotation_number', key: 'qn', width: 150 },
                      { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 180, render: (v, r) => v || r.vendor || '-' },
                      { title: 'Quoted Amount', dataIndex: 'quoted_amount', key: 'amount', width: 130, align: 'right', render: (v) => formatNumber(v) },
                      { title: 'Vehicle Type', dataIndex: 'vehicle_type', key: 'vt', width: 120 },
                      { title: 'Delivery Days', dataIndex: 'estimated_delivery_days', key: 'days', width: 110, align: 'right' },
                      { title: 'Status', dataIndex: 'status', key: 'status', width: 120, render: (s) => <StatusTag status={s} /> },
                    ]}
                  />
                ),
              },
            ]}
          />
        </Card>
      </div>
    );
  }

  // LIST VIEW
  return (
    <div>
      <PageHeader title="Transport Requirements" subtitle="Manage transport requirements">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Create Requirement</Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchData}
        rowKey="id"
        searchPlaceholder="Search by requirement number..."
        exportFileName="transport_requirements"
        toolbar={toolbar}
        scroll={{ x: 1800 }}
      />

      <Drawer
        title={editingRecord ? `Edit ${editingRecord.requirement_number}` : 'Create Transport Requirement'}
        width={800}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setEditingRecord(null); form.resetFields(); }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); setEditingRecord(null); form.resetFields(); }}>Cancel</Button>
            <Button onClick={() => handleSubmit(false)} loading={submitting}>Save as Draft</Button>
            <Button type="primary" icon={<SendOutlined />} onClick={() => handleSubmit(true)} loading={submitting}>Submit</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="requirement_type" label="Requirement Type" rules={[{ required: true, message: 'Required' }]}>
                <Select options={REQUIREMENT_TYPES} placeholder="Select type" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="priority" label="Priority" rules={[{ required: true, message: 'Required' }]}>
                <Select options={PRIORITIES} placeholder="Select priority" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="dispatch_warehouse_id" label="Dispatch Warehouse" rules={[{ required: true, message: 'Required' }]}>
                <Select options={warehouses} placeholder="Select dispatch warehouse" allowClear showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="destination" label="Destination" rules={[{ required: true, message: 'Required' }]}>
                <Input placeholder="Warehouse name or full address" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="material_description" label="Material Description" rules={[{ required: true, message: 'Required' }]}>
            <TextArea rows={2} placeholder="Describe the materials to be transported" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="total_qty" label="Total Qty">
                <InputNumber min={0} style={{ width: '100%' }} placeholder="Quantity" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="total_weight" label="Total Weight (kg)">
                <InputNumber min={0} style={{ width: '100%' }} placeholder="Weight in kg" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="total_volume" label="Total Volume (m3)">
                <InputNumber min={0} style={{ width: '100%' }} placeholder="Volume in m3" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="vehicle_type_required" label="Vehicle Type Required" rules={[{ required: true, message: 'Required' }]}>
                <Select options={VEHICLE_TYPES} placeholder="Select vehicle type" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="expected_dispatch_date" label="Expected Dispatch Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="expected_delivery_date" label="Expected Delivery Date">
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remarks" label="Remarks">
            <TextArea rows={2} placeholder="Any remarks..." />
          </Form.Item>

          {/* CR_01/17: attachment widget — drawing, vendor docs, packing list, etc. */}
          <Form.Item label="Supporting Documents">
            <AttachmentUploader
              entityType="transport_requirement"
              entityId={editingRecord?.id || null}
              staged={stagedAttachments}
              setStaged={setStagedAttachments}
              label="TR Document"
            />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
};

export default TransportRequirements;

