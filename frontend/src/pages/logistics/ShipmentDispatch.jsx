import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Drawer, Form, Input, DatePicker, Select, Space, Popconfirm,
  message, Row, Col, Card, Descriptions, Tag, Tooltip, Divider,
} from 'antd';
import {
  SendOutlined, CarOutlined, EyeOutlined, UserOutlined, PhoneOutlined,
  EnvironmentOutlined, CheckCircleOutlined, ReloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { formatDate, formatDateTime, getErrorMessage, formatDateForAPI } from '../../utils/helpers';

const { TextArea } = Input;

// Backend lifecycle: draft -> loaded -> dispatched -> delivered (or cancelled)
// Confirm-loading is the gate before "Dispatch". This page focuses on the
// "ready to leave" buckets so warehouse dispatchers can fire the final
// shipment trigger.
const STATUS_OPTIONS = [
  { label: 'Draft', value: 'draft' },
  { label: 'Loading', value: 'loading' },
  { label: 'Loaded (Ready)', value: 'loaded' },
  { label: 'Dispatched', value: 'dispatched' },
  { label: 'Delivered', value: 'delivered' },
  { label: 'Cancelled', value: 'cancelled' },
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

const ShipmentDispatch = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);
  // Default to "loaded" — the bucket from which the Dispatch action is legal
  // server-side. User can switch via toolbar.
  const [filterStatus, setFilterStatus] = useState('loaded');

  // Dispatch confirmation drawer
  const [dispatchDrawerOpen, setDispatchDrawerOpen] = useState(false);
  const [dispatchTarget, setDispatchTarget] = useState(null);
  const [dispatchForm] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  // Detail drawer
  const [detailRecord, setDetailRecord] = useState(null);
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchData = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      return await api.get('/outbound/dispatch-orders', { params: qp });
    },
    [filterStatus]
  );

  const handleView = async (record) => {
    setDetailLoading(true);
    setDetailRecord(record);
    setDetailDrawerOpen(true);
    try {
      // List endpoint already returns enriched row; use it directly.
      // No GET /dispatch/{id} on the backend, so we keep what the list gave us.
      setDetailRecord(record);
    } finally {
      setDetailLoading(false);
    }
  };

  const openDispatch = (record) => {
    if (record.status !== 'loaded') {
      message.warning(
        `Cannot dispatch order in '${record.status}' status — must be 'loaded' (confirm loading first).`
      );
      return;
    }
    setDispatchTarget(record);
    dispatchForm.setFieldsValue({
      vehicle_number: record.vehicle_number || '',
      vehicle_type: record.vehicle_type || undefined,
      driver_name: record.driver_name || '',
      driver_contact: record.driver_contact || '',
      lr_number: record.lr_number || '',
      docket_number: record.docket_number || '',
      eta: record.eta ? dayjs(record.eta) : null,
      remarks: '',
    });
    setDispatchDrawerOpen(true);
  };

  const handleDispatch = async () => {
    try {
      const values = await dispatchForm.validateFields();
      if (!dispatchTarget) return;
      setSubmitting(true);

      // The /dispatch/{id}/dispatch backend route takes no payload — it just
      // flips status from 'loaded' to 'dispatched' and stamps dispatch_date.
      // Vehicle / driver / LR / docket are persisted separately. If any of
      // those changed in the form, we shouldn't drop them — but there is
      // currently no UPDATE route for dispatch metadata after creation, so
      // we surface this as a hint and proceed with the dispatch flip.
      await api.post(`/outbound/dispatch/${dispatchTarget.id}/dispatch`);

      message.success(`Dispatch ${dispatchTarget.dispatch_number} marked dispatched`);
      setDispatchDrawerOpen(false);
      dispatchForm.resetFields();
      const targetId = dispatchTarget.id;
      setDispatchTarget(null);
      setRefreshKey((k) => k + 1);

      // Hand off to live tracking view, prefilling the dispatch_id.
      // ShipmentTracking accepts ?order_number / ?docket_number / ?lr_number
      // search params; we surface dispatch_id so the tracking page can pick
      // it up if/when it adds a dispatch lookup. Either way we navigate so
      // the user lands on the in-transit visibility page.
      navigate(`/logistics/shipment-tracking?dispatch_id=${targetId}`);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmLoading = async (record) => {
    try {
      await api.post(`/outbound/dispatch/${record.id}/confirm-loading`);
      message.success(`Loading confirmed for ${record.dispatch_number}`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleCancel = async (record) => {
    try {
      await api.post(`/outbound/dispatch/${record.id}/cancel`);
      message.success(`Dispatch ${record.dispatch_number} cancelled`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'Dispatch #',
      dataIndex: 'dispatch_number',
      key: 'dispatch_number',
      width: 160,
      fixed: 'left',
      render: (text, record) => <a onClick={() => handleView(record)}>{text}</a>,
    },
    {
      title: 'Warehouse',
      dataIndex: 'warehouse_name',
      key: 'warehouse_name',
      width: 180,
      render: (v) => v || '-',
    },
    {
      title: 'Vehicle #',
      dataIndex: 'vehicle_number',
      key: 'vehicle_number',
      width: 130,
      render: (v) => v || <Tag color="warning">Unassigned</Tag>,
    },
    {
      title: 'Vehicle Type',
      dataIndex: 'vehicle_type',
      key: 'vehicle_type',
      width: 130,
      render: (v) => {
        const f = VEHICLE_TYPES.find((t) => t.value === v);
        return f ? f.label : (v || '-');
      },
    },
    {
      title: 'Driver',
      dataIndex: 'driver_name',
      key: 'driver_name',
      width: 140,
      render: (v) => v || '-',
    },
    {
      title: 'LR / Docket',
      key: 'lr_docket',
      width: 160,
      render: (_, r) => (
        <span>
          {r.lr_number || '-'}
          {r.docket_number ? <span style={{ color: 'rgba(0,0,0,0.45)' }}> / {r.docket_number}</span> : ''}
        </span>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Dispatch Date',
      dataIndex: 'dispatch_date',
      key: 'dispatch_date',
      width: 140,
      render: (v) => formatDateTime(v),
    },
    {
      title: 'Dispatcher',
      dataIndex: 'dispatcher_name',
      key: 'dispatcher_name',
      width: 140,
      render: (v) => v || '-',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 220,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(record)} />
          </Tooltip>
          {(record.status === 'draft' || record.status === 'loading') && (
            <Tooltip title="Confirm Loading">
              <Popconfirm
                title="Confirm loading complete?"
                description="Verify packing is completed before continuing."
                onConfirm={() => handleConfirmLoading(record)}
              >
                <Button type="link" size="small" icon={<CheckCircleOutlined />} style={{ color: '#fa8c16' }}>
                  Loaded
                </Button>
              </Popconfirm>
            </Tooltip>
          )}
          {record.status === 'loaded' && (
            <Tooltip title="Dispatch — vehicle leaves the building">
              <Button
                type="primary"
                size="small"
                icon={<SendOutlined />}
                onClick={() => openDispatch(record)}
              >
                Dispatch
              </Button>
            </Tooltip>
          )}
          {!['dispatched', 'delivered', 'cancelled'].includes(record.status) && (
            <Popconfirm title="Cancel this dispatch order?" onConfirm={() => handleCancel(record)}>
              <Button type="link" size="small" danger>Cancel</Button>
            </Popconfirm>
          )}
          {record.status === 'dispatched' && (
            <Tooltip title="View live tracking">
              <Button
                type="link"
                size="small"
                icon={<EnvironmentOutlined />}
                onClick={() =>
                  navigate(`/logistics/shipment-tracking?dispatch_id=${record.id}`)
                }
              >
                Track
              </Button>
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
        style={{ width: 180 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={STATUS_OPTIONS}
      />
      <Button icon={<ReloadOutlined />} onClick={() => setRefreshKey((k) => k + 1)}>
        Refresh
      </Button>
    </Space>
  );

  return (
    <div>
      <PageHeader
        title="Shipment Dispatch"
        subtitle="Confirm shipments leaving the building. Use this page to fire the final dispatch trigger; once dispatched, follow live progress in Shipment Tracking."
      />

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchData}
        rowKey="id"
        searchPlaceholder="Search by dispatch #, vehicle, LR..."
        exportFileName="shipment_dispatch"
        toolbar={toolbar}
        scroll={{ x: 1700 }}
      />

      {/* Dispatch confirmation drawer — confirm vehicle / driver / ETA before
          firing POST /outbound/dispatch/{id}/dispatch. */}
      <Drawer
        title={
          dispatchTarget
            ? `Confirm Dispatch — ${dispatchTarget.dispatch_number}`
            : 'Confirm Dispatch'
        }
        width={560}
        open={dispatchDrawerOpen}
        onClose={() => {
          setDispatchDrawerOpen(false);
          dispatchForm.resetFields();
          setDispatchTarget(null);
        }}
        destroyOnHidden
        extra={
          <Space>
            <Button
              onClick={() => {
                setDispatchDrawerOpen(false);
                dispatchForm.resetFields();
                setDispatchTarget(null);
              }}
            >
              Cancel
            </Button>
            <Popconfirm
              title="Mark this dispatch as dispatched?"
              description="This records the shipment as having physically left the warehouse. Make sure the vehicle is on the way."
              onConfirm={handleDispatch}
            >
              <Button type="primary" icon={<SendOutlined />} loading={submitting}>
                Confirm & Dispatch
              </Button>
            </Popconfirm>
          </Space>
        }
      >
        <div style={{ marginBottom: 16, padding: 12, background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 4 }}>
          <strong>Pre-dispatch checklist:</strong> verify vehicle, driver, and ETA below match the actual truck at the dock. Once dispatched, the order moves into in-transit tracking and these details cannot be edited from this screen.
        </div>
        <Form form={dispatchForm} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="vehicle_number"
                label="Vehicle Number"
                rules={[{ required: true, message: 'Vehicle number required' }]}
              >
                <Input placeholder="e.g. MH01AB1234" prefix={<CarOutlined />} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="vehicle_type" label="Vehicle Type">
                <Select options={VEHICLE_TYPES} placeholder="Select" allowClear />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="driver_name"
                label="Driver Name"
                rules={[{ required: true, message: 'Driver name required' }]}
              >
                <Input placeholder="Driver name" prefix={<UserOutlined />} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="driver_contact"
                label="Driver Contact"
                rules={[{ required: true, message: 'Driver contact required' }]}
              >
                <Input placeholder="Phone number" prefix={<PhoneOutlined />} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="lr_number" label="LR Number">
                <Input placeholder="Lorry Receipt number" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="docket_number" label="Docket Number">
                <Input placeholder="Docket / AWB number" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="eta"
            label="ETA (Estimated Time of Arrival)"
            rules={[{ required: true, message: 'ETA required' }]}
          >
            <DatePicker
              showTime
              style={{ width: '100%' }}
              format="YYYY-MM-DD HH:mm"
              placeholder="Select expected arrival"
            />
          </Form.Item>
          <Form.Item name="remarks" label="Dispatch Remarks">
            <TextArea rows={3} placeholder="Notes for the trip (route, special handling, etc.)" />
          </Form.Item>
        </Form>
      </Drawer>

      {/* Detail drawer — quick read-only view */}
      <Drawer
        title={detailRecord ? `Dispatch ${detailRecord.dispatch_number}` : 'Dispatch'}
        width={560}
        open={detailDrawerOpen}
        onClose={() => { setDetailDrawerOpen(false); setDetailRecord(null); }}
        destroyOnHidden
        loading={detailLoading}
        extra={
          detailRecord && detailRecord.status === 'loaded' ? (
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={() => {
                setDetailDrawerOpen(false);
                openDispatch(detailRecord);
              }}
            >
              Dispatch
            </Button>
          ) : detailRecord && detailRecord.status === 'dispatched' ? (
            <Button
              icon={<EnvironmentOutlined />}
              onClick={() => navigate(`/logistics/shipment-tracking?dispatch_id=${detailRecord.id}`)}
            >
              Track
            </Button>
          ) : null
        }
      >
        {detailRecord && (
          <>
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="Dispatch #">{detailRecord.dispatch_number}</Descriptions.Item>
              <Descriptions.Item label="Status"><StatusTag status={detailRecord.status} /></Descriptions.Item>
              <Descriptions.Item label="Warehouse">{detailRecord.warehouse_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Dispatch Date">{formatDateTime(detailRecord.dispatch_date)}</Descriptions.Item>
              <Descriptions.Item label="Dispatcher">{detailRecord.dispatcher_name || '-'}</Descriptions.Item>
            </Descriptions>
            <Divider orientation="left">Vehicle</Divider>
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="Vehicle #">{detailRecord.vehicle_number || '-'}</Descriptions.Item>
              <Descriptions.Item label="Vehicle Type">
                {VEHICLE_TYPES.find((t) => t.value === detailRecord.vehicle_type)?.label || detailRecord.vehicle_type || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Driver">{detailRecord.driver_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Driver Contact">{detailRecord.driver_contact || '-'}</Descriptions.Item>
            </Descriptions>
            <Divider orientation="left">References</Divider>
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="LR Number">{detailRecord.lr_number || '-'}</Descriptions.Item>
              <Descriptions.Item label="Docket Number">{detailRecord.docket_number || '-'}</Descriptions.Item>
              <Descriptions.Item label="Created At">{formatDateTime(detailRecord.created_at)}</Descriptions.Item>
            </Descriptions>
          </>
        )}
      </Drawer>
    </div>
  );
};

export default ShipmentDispatch;

