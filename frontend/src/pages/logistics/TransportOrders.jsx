import React, { useState, useCallback } from 'react';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Tabs,
  Divider, Typography, Tooltip, Tag, Spin, Empty, Modal, Upload,
} from 'antd';
import {
  PlusOutlined, EditOutlined, EyeOutlined, ArrowLeftOutlined,
  SendOutlined, CloseCircleOutlined, CheckCircleOutlined,
  CarOutlined, UploadOutlined, FileOutlined,
  EnvironmentOutlined, UserOutlined, PhoneOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import FileUpload from '../../components/FileUpload';
import api from '../../config/api';
import {
  formatDate, formatDateTime, formatCurrency, getErrorMessage, formatDateForAPI,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

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

// BUG-ISS-128 — include 'draft' so the lifecycle indicator reflects the
// real backend state machine (orders are created in draft, not confirmed).
const STATUS_FLOW = ['draft', 'confirmed', 'vehicle_assigned', 'dispatched', 'in_transit', 'delivered'];

const DOC_TYPES = [
  { label: 'LR Copy', value: 'lr' },
  { label: 'Docket Copy', value: 'docket' },
  { label: 'Invoice', value: 'invoice' },
  { label: 'POD (Proof of Delivery)', value: 'pod' },
  { label: 'Other', value: 'other' },
];

const TransportOrders = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [vehicleDrawerOpen, setVehicleDrawerOpen] = useState(false);
  const [form] = Form.useForm();
  const [vehicleForm] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [filterStatus, setFilterStatus] = useState(undefined);

  const [detailRecord, setDetailRecord] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState('info');
  const [documents, setDocuments] = useState([]);
  const [docLoading, setDocLoading] = useState(false);

  // Upload modal
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadForm] = Form.useForm();
  const [uploading, setUploading] = useState(false);

  const fetchData = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      return await api.get('/logistics/transport-orders', { params: qp });
    },
    [filterStatus]
  );

  const handleView = async (record) => {
    setDetailLoading(true);
    setDetailRecord(null);
    setDetailTab('info');
    setDocuments([]);
    try {
      const res = await api.get(`/logistics/transport-orders/${record.id}`);
      setDetailRecord(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const fetchDocuments = async () => {
    if (!detailRecord) return;
    setDocLoading(true);
    try {
      const res = await api.get(`/logistics/transport-orders/${detailRecord.id}/documents`, { params: { page_size: 50 } });
      setDocuments(res.data.items || res.data.data || res.data || []);
    } catch { /* silent */ }
    finally { setDocLoading(false); }
  };

  const handleAction = async (id, action) => {
    try {
      await api.put(`/logistics/transport-orders/${id}/${action}`);
      const labels = {
        confirm: 'confirmed',
        assign_vehicle: 'vehicle assigned',
        dispatch: 'dispatched',
        mark_delivered: 'marked as delivered',
      };
      message.success(`Transport order ${labels[action] || action}`);
      setRefreshKey((k) => k + 1);
      if (detailRecord && detailRecord.id === id) {
        const res = await api.get(`/logistics/transport-orders/${id}`);
        setDetailRecord(res.data);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleUpdateVehicle = async () => {
    try {
      const values = await vehicleForm.validateFields();
      setSubmitting(true);
      await api.put(`/logistics/transport-orders/${detailRecord.id}/vehicle-details`, values);
      message.success('Vehicle details updated');
      setVehicleDrawerOpen(false);
      vehicleForm.resetFields();
      const res = await api.get(`/logistics/transport-orders/${detailRecord.id}`);
      setDetailRecord(res.data);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const openVehicleDrawer = () => {
    vehicleForm.setFieldsValue({
      vehicle_type: detailRecord.vehicle_type,
      vehicle_number: detailRecord.vehicle_number,
      driver_name: detailRecord.driver_name,
      driver_contact: detailRecord.driver_contact,
      docket_number: detailRecord.docket_number,
      courier_reference: detailRecord.courier_reference,
      lr_number: detailRecord.lr_number,
    });
    setVehicleDrawerOpen(true);
  };

  const handleUploadDocument = async () => {
    try {
      const values = await uploadForm.validateFields();
      setUploading(true);
      const payload = {
        document_type: values.document_type,
        description: values.description || '',
        files: values.files || [],
      };
      await api.post(`/logistics/transport-orders/${detailRecord.id}/documents`, payload);
      message.success('Document uploaded');
      setUploadModalOpen(false);
      uploadForm.resetFields();
      fetchDocuments();
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const columns = [
    {
      title: 'Order #',
      dataIndex: 'order_number',
      key: 'order_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => handleView(record)}>{text}</a>,
    },
    {
      title: 'Requirement Ref',
      dataIndex: 'requirement_number',
      key: 'requirement_number',
      width: 160,
      render: (v, r) => v || r.transport_requirement?.requirement_number || '-',
    },
    { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 180, render: (v, r) => v || r.vendor || '-' },
    {
      title: 'Vehicle Type',
      dataIndex: 'vehicle_type',
      key: 'vehicle_type',
      width: 130,
      render: (v) => { const f = VEHICLE_TYPES.find((t) => t.value === v); return f ? f.label : (v || '-'); },
    },
    { title: 'Vehicle #', dataIndex: 'vehicle_number', key: 'vehicle_number', width: 130, render: (v) => v || '-' },
    { title: 'Driver', dataIndex: 'driver_name', key: 'driver_name', width: 140, render: (v) => v || '-' },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 140,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Dispatch Date',
      dataIndex: 'dispatch_date',
      key: 'dispatch_date',
      width: 130,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(record)} />
          {record.status === 'draft' && (
            <Tooltip title="Confirm">
              <Popconfirm title="Confirm this order?" onConfirm={() => handleAction(record.id, 'confirm')}>
                <Button type="link" size="small" icon={<CheckCircleOutlined />} style={{ color: '#52c41a' }} />
              </Popconfirm>
            </Tooltip>
          )}
          {record.status === 'confirmed' && (
            <Tooltip title="Assign Vehicle">
              <Button type="link" size="small" icon={<CarOutlined />} onClick={() => { handleView(record).then(() => openVehicleDrawer()); }} />
            </Tooltip>
          )}
          {record.status === 'vehicle_assigned' && (
            <Tooltip title="Dispatch">
              <Popconfirm title="Mark as dispatched?" onConfirm={() => handleAction(record.id, 'dispatch')}>
                <Button type="link" size="small" icon={<SendOutlined />} style={{ color: '#eb2f96' }} />
              </Popconfirm>
            </Tooltip>
          )}
          {['dispatched', 'in_transit'].includes(record.status) && (
            <Tooltip title="Mark Delivered">
              <Popconfirm title="Mark as delivered?" onConfirm={() => handleAction(record.id, 'mark_delivered')}>
                <Button type="link" size="small" icon={<CheckCircleOutlined />} style={{ color: '#52c41a' }} />
              </Popconfirm>
            </Tooltip>
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
        style={{ width: 170 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Draft', value: 'draft' },
          { label: 'Confirmed', value: 'confirmed' },
          { label: 'Vehicle Assigned', value: 'vehicle_assigned' },
          { label: 'Dispatched', value: 'dispatched' },
          { label: 'In Transit', value: 'in_transit' },
          { label: 'Delivered', value: 'delivered' },
          { label: 'Cancelled', value: 'cancelled' },
        ]}
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
        <PageHeader title={detailRecord.order_number} subtitle="Transport Order Detail">
          <Space>
            {detailRecord.status === 'draft' && (
              <Popconfirm title="Confirm this order?" onConfirm={() => handleAction(detailRecord.id, 'confirm')}>
                <Button type="primary" icon={<CheckCircleOutlined />}>Confirm</Button>
              </Popconfirm>
            )}
            {detailRecord.status === 'confirmed' && (
              <Button icon={<CarOutlined />} onClick={openVehicleDrawer}>Assign Vehicle</Button>
            )}
            {detailRecord.status === 'vehicle_assigned' && (
              <Popconfirm title="Mark as dispatched?" onConfirm={() => handleAction(detailRecord.id, 'dispatch')}>
                <Button type="primary" icon={<SendOutlined />}>Dispatch</Button>
              </Popconfirm>
            )}
            {['dispatched', 'in_transit'].includes(detailRecord.status) && (
              <Popconfirm title="Mark as delivered?" onConfirm={() => handleAction(detailRecord.id, 'mark_delivered')}>
                <Button type="primary" icon={<CheckCircleOutlined />}>Mark Delivered</Button>
              </Popconfirm>
            )}
            {/* BUG-ISS-129 — once the truck is dispatched / in_transit / delivered,
                vehicle details are no longer editable from the UI. Allowing edits
                in those states would silently re-route an active shipment. */}
            {!['dispatched', 'in_transit', 'delivered', 'cancelled'].includes(detailRecord.status) && (
              <Button icon={<CarOutlined />} onClick={openVehicleDrawer}>Update Vehicle Details</Button>
            )}
            <Button icon={<UploadOutlined />} onClick={() => { uploadForm.resetFields(); setUploadModalOpen(true); }}>Upload Document</Button>
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
            onChange={(tab) => { setDetailTab(tab); if (tab === 'documents') fetchDocuments(); }}
            items={[
              {
                key: 'info',
                label: 'Order Info',
                children: (
                  <>
                    <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
                      <Descriptions.Item label="Order #">{detailRecord.order_number}</Descriptions.Item>
                      <Descriptions.Item label="Requirement Ref">{detailRecord.requirement_number || detailRecord.transport_requirement?.requirement_number || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Status"><StatusTag status={detailRecord.status} /></Descriptions.Item>
                      <Descriptions.Item label="Vendor">{detailRecord.vendor_name || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Dispatch Date">{formatDate(detailRecord.dispatch_date)}</Descriptions.Item>
                      <Descriptions.Item label="Delivery Date">{formatDate(detailRecord.delivery_date)}</Descriptions.Item>
                      <Descriptions.Item label="Dispatch Location">{detailRecord.dispatch_location || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Destination">{detailRecord.destination || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Amount">{formatCurrency(detailRecord.amount)}</Descriptions.Item>
                    </Descriptions>

                    <Divider orientation="left">Vehicle Information</Divider>
                    <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
                      <Descriptions.Item label="Vehicle Type">
                        {VEHICLE_TYPES.find((t) => t.value === detailRecord.vehicle_type)?.label || detailRecord.vehicle_type || '-'}
                      </Descriptions.Item>
                      <Descriptions.Item label="Vehicle Number">{detailRecord.vehicle_number || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Driver Name">{detailRecord.driver_name || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Driver Contact">{detailRecord.driver_contact || '-'}</Descriptions.Item>
                    </Descriptions>

                    <Divider orientation="left">Transport References</Divider>
                    <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
                      <Descriptions.Item label="Docket Number">{detailRecord.docket_number || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Courier Reference">{detailRecord.courier_reference || '-'}</Descriptions.Item>
                      <Descriptions.Item label="LR Number">{detailRecord.lr_number || '-'}</Descriptions.Item>
                    </Descriptions>
                  </>
                ),
              },
              {
                key: 'documents',
                label: 'Documents',
                children: (
                  <>
                    <div style={{ marginBottom: 16 }}>
                      <Button type="primary" icon={<UploadOutlined />} onClick={() => { uploadForm.resetFields(); setUploadModalOpen(true); }}>
                        Upload Document
                      </Button>
                    </div>
                    <Table
                      dataSource={documents}
                      loading={docLoading}
                      rowKey="id"
                      size="small"
                      pagination={false}
                      locale={{ emptyText: <Empty description="No documents uploaded" /> }}
                      columns={[
                        { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
                        {
                          title: 'Type',
                          dataIndex: 'document_type',
                          key: 'type',
                          width: 150,
                          render: (v) => { const f = DOC_TYPES.find((t) => t.value === v); return <Tag>{f ? f.label : (v || '-')}</Tag>; },
                        },
                        { title: 'File Name', dataIndex: 'file_name', key: 'name', width: 200, render: (v) => v || '-' },
                        { title: 'Description', dataIndex: 'description', key: 'desc', width: 200, ellipsis: true, render: (v) => v || '-' },
                        { title: 'Uploaded By', dataIndex: 'uploaded_by_name', key: 'by', width: 150, render: (v, r) => v || r.uploaded_by || '-' },
                        { title: 'Uploaded At', dataIndex: 'uploaded_at', key: 'at', width: 160, render: (v) => formatDateTime(v) },
                        {
                          title: 'Action',
                          key: 'action',
                          width: 100,
                          render: (_, record) => record.file_url ? (
                            <a href={record.file_url} target="_blank" rel="noopener noreferrer"><FileOutlined /> View</a>
                          ) : '-',
                        },
                      ]}
                    />
                  </>
                ),
              },
            ]}
          />
        </Card>

        {/* Vehicle Details Drawer */}
        <Drawer
          title="Update Vehicle Details"
          width={500}
          open={vehicleDrawerOpen}
          onClose={() => { setVehicleDrawerOpen(false); vehicleForm.resetFields(); }}
          destroyOnHidden
          extra={
            <Space>
              <Button onClick={() => { setVehicleDrawerOpen(false); vehicleForm.resetFields(); }}>Cancel</Button>
              <Button type="primary" onClick={handleUpdateVehicle} loading={submitting}>Save</Button>
            </Space>
          }
        >
          <Form form={vehicleForm} layout="vertical">
            <Form.Item name="vehicle_type" label="Vehicle Type" rules={[{ required: true, message: 'Required' }]}>
              <Select options={VEHICLE_TYPES} placeholder="Select vehicle type" />
            </Form.Item>
            <Form.Item name="vehicle_number" label="Vehicle Number" rules={[{ required: true, message: 'Required' }]}>
              <Input placeholder="e.g. MH01AB1234" prefix={<CarOutlined />} />
            </Form.Item>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="driver_name" label="Driver Name" rules={[{ required: true, message: 'Required' }]}>
                  <Input placeholder="Driver name" prefix={<UserOutlined />} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="driver_contact" label="Driver Contact" rules={[{ required: true, message: 'Required' }]}>
                  <Input placeholder="Phone number" prefix={<PhoneOutlined />} />
                </Form.Item>
              </Col>
            </Row>
            <Divider orientation="left">Reference Numbers</Divider>
            <Form.Item name="docket_number" label="Docket Number">
              <Input placeholder="Docket / AWB number" />
            </Form.Item>
            <Form.Item name="courier_reference" label="Courier Reference">
              <Input placeholder="Courier reference number" />
            </Form.Item>
            <Form.Item name="lr_number" label="LR Number">
              <Input placeholder="Lorry Receipt number" />
            </Form.Item>
          </Form>
        </Drawer>

        {/* Upload Document Modal */}
        <Modal
          title="Upload Transport Document"
          open={uploadModalOpen}
          onOk={handleUploadDocument}
          onCancel={() => { setUploadModalOpen(false); uploadForm.resetFields(); }}
          confirmLoading={uploading}
          okText="Upload"
          width={500}
        >
          <Form form={uploadForm} layout="vertical">
            <Form.Item name="document_type" label="Document Type" rules={[{ required: true, message: 'Required' }]}>
              <Select options={DOC_TYPES} placeholder="Select document type" />
            </Form.Item>
            <Form.Item name="description" label="Description">
              <TextArea rows={2} placeholder="Brief description" />
            </Form.Item>
            <Form.Item name="files" label="File">
              {/* BUG-ISS-131 — old uploadUrl /logistics/transport-orders/upload
                  was 404. Real route is /logistics/transport-orders/{id}/documents.
                  When detailRecord is loaded we point at that; otherwise fall
                  back to the generic uploads endpoint. */}
              <FileUpload
                uploadUrl={detailRecord ? `/logistics/transport-orders/${detailRecord.id}/documents` : '/uploads'}
                maxCount={3}
                accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                hint="Upload LR, Docket, Invoice, or POD documents (PDF, JPG, PNG, DOC)"
              />
            </Form.Item>
          </Form>
        </Modal>
      </div>
    );
  }

  // LIST VIEW
  return (
    <div>
      <PageHeader title="Transport Orders" subtitle="Manage transport orders and vehicle assignments">
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchData}
        rowKey="id"
        searchPlaceholder="Search by order number, vendor..."
        exportFileName="transport_orders"
        toolbar={toolbar}
        scroll={{ x: 1700 }}
      />
    </div>
  );
};

export default TransportOrders;

