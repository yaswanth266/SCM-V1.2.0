import React, { useState, useCallback, useRef } from 'react';
import {
  Button, Drawer, Form, Input, Select, Space, DatePicker, Tabs,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Modal,
  Divider, Typography, Tooltip, Tag, Badge, Alert,
} from 'antd';
import {
  PlusOutlined, EyeOutlined, CheckOutlined,
  CloseCircleOutlined, PrinterOutlined, ScanOutlined,
  LoginOutlined, LogoutOutlined, CarOutlined,
  ClockCircleOutlined, UserOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useReactToPrint } from 'react-to-print';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import BarcodeScanner from '../../components/BarcodeScanner';
import BarcodeDisplay from '../../components/BarcodeDisplay';
import api from '../../config/api';
import {
  formatDate, formatDateTime, getErrorMessage, formatDateForAPI,
} from '../../utils/helpers';
import { DATE_FORMAT, DATETIME_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const GATE_STATUSES = [
  { label: 'Pending', value: 'pending' },
  { label: 'Approved', value: 'approved' },
  { label: 'Gate In', value: 'gate_in' },
  { label: 'Gate Out', value: 'gate_out' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const GateEntry = () => {
  const [activeTab, setActiveTab] = useState('inward');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [viewData, setViewData] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [scannerMode, setScannerMode] = useState(null); // 'gate_in' | 'gate_out'
  const printRef = useRef(null);

  // Form state
  const [gateType, setGateType] = useState('inward');
  const [warehouses, setWarehouses] = useState([]);
  const [serviceOrderOptions, setServiceOrderOptions] = useState([]);
  const [dispatchOptions, setDispatchOptions] = useState([]);

  // Filter
  const [filterStatus, setFilterStatus] = useState(undefined);

  // --- Lookups ---
  const loadLookups = useCallback(async () => {
    try {
      const [whRes] = await Promise.allSettled([
        api.get('/masters/warehouses', { params: { page_size: 200 } }),
      ]);
      if (whRes.status === 'fulfilled') {
        const w = whRes.value.data;
        setWarehouses(
          (w.items || w.data || w || []).map((i) => ({
            label: i.name || i.warehouse_name,
            value: i.id,
          }))
        );
      }
    } catch {
      // silent
    }
  }, []);

  const loadServiceOrderOptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/logistics/so', { params: { exclude_gated: true } });
      const data = res.data || [];
      const filtered = search
        ? data.filter((so) =>
            so.so_number?.toLowerCase().includes(search.toLowerCase()) ||
            so.vendor_name?.toLowerCase().includes(search.toLowerCase())
          )
        : data;
      setServiceOrderOptions(
        filtered.map((so) => ({
          label: `${so.so_number} - ${so.vendor_name || ''}`,
          value: so.id,
          so: so,
        }))
      );
    } catch {
      // silent
    }
  }, []);

  const loadDispatchOptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/outbound/dispatches', {
        params: { page_size: 50, search },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setDispatchOptions(
        items.map((d) => ({
          label: `${d.dispatch_number || d.id} - ${d.customer_name || ''}`,
          value: d.id,
        }))
      );
    } catch {
      // silent
    }
  }, []);

  // --- Fetch Gate Entries ---
  const fetchGateEntries = useCallback(
    async (params) => {
      const qp = { ...params, gate_type: activeTab };
      if (filterStatus) qp.status = filterStatus;
      return await api.get('/warehouse/gate-entries', { params: qp });
    },
    [activeTab, filterStatus]
  );

  // --- Open Drawer ---
  const handleAdd = () => {
    form.resetFields();
    const type = activeTab;
    setGateType(type);
    form.setFieldsValue({ gate_type: type });
    loadLookups();
    if (type === 'inward') loadServiceOrderOptions();
    if (type === 'outward') loadDispatchOptions();
    setDrawerOpen(true);
  };

  // --- View Detail ---
  const handleView = async (record) => {
    setViewLoading(true);
    setViewModalOpen(true);
    setScannerMode(null);
    try {
      const res = await api.get(`/warehouse/gate-entries/${record.id}`);
      setViewData(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
      setViewModalOpen(false);
    } finally {
      setViewLoading(false);
    }
  };

  // --- Submit ---
  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      const payload = {
        ...values,
        gate_type: gateType,
        status: 'pending',
      };

      await api.post('/warehouse/gate-entries', payload);
      message.success('Gate pass created successfully');
      setDrawerOpen(false);
      form.resetFields();
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // --- Actions ---
  const handleApprove = async (id) => {
    try {
      await api.post(`/warehouse/gate-entries/${id}/approve`);
      message.success('Gate pass approved');
      setRefreshKey((k) => k + 1);
      if (viewData && viewData.id === id) {
        setViewData((prev) => prev ? { ...prev, status: 'approved' } : prev);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleRecordGateIn = async (id, barcode = null) => {
    try {
      await api.post(`/warehouse/gate-entries/${id}/gate-in`, {
        gate_in_time: new Date().toISOString(),
        barcode,
      });
      message.success('Gate IN time recorded');
      setRefreshKey((k) => k + 1);
      if (viewData && viewData.id === id) {
        setViewData((prev) => prev ? { ...prev, status: 'gate_in', gate_in_time: new Date().toISOString() } : prev);
      }
      setScannerMode(null);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleRecordGateOut = async (id, barcode = null) => {
    try {
      await api.post(`/warehouse/gate-entries/${id}/gate-out`, {
        gate_out_time: new Date().toISOString(),
        barcode,
      });
      message.success('Gate OUT time recorded');
      setRefreshKey((k) => k + 1);
      if (viewData && viewData.id === id) {
        setViewData((prev) => prev ? { ...prev, status: 'gate_out', gate_out_time: new Date().toISOString() } : prev);
      }
      setScannerMode(null);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleCancel = async (id) => {
    try {
      await api.post(`/warehouse/gate-entries/${id}/cancel`);
      message.success('Gate pass cancelled');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Barcode scan for gate in/out ---
  const handleGateScan = (scanResult) => {
    if (!viewData) return;
    const scannedValue = scanResult.value;

    // Validate that scanned barcode matches gate pass
    if (
      scannedValue !== viewData.gate_pass_number &&
      scannedValue !== viewData.vehicle_number &&
      !scannedValue.includes(viewData.gate_pass_number || '')
    ) {
      message.error(`Scanned barcode "${scannedValue}" does not match gate pass "${viewData.gate_pass_number}"`);
      return;
    }

    if (scannerMode === 'gate_in') {
      handleRecordGateIn(viewData.id, scannedValue);
    } else if (scannerMode === 'gate_out') {
      handleRecordGateOut(viewData.id, scannedValue);
    }
  };

  // --- Print Gate Pass ---
  const handlePrint = useReactToPrint({
    content: () => printRef.current,
    documentTitle: viewData ? `GatePass_${viewData.gate_pass_number}` : 'GatePass',
  });

  // --- Columns ---
  const columns = [
    {
      title: 'Gate Pass No.',
      dataIndex: 'gate_pass_number',
      key: 'gate_pass_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => handleView(record)}>{text}</a>,
    },
    {
      title: 'Gate Type',
      dataIndex: 'gate_type',
      key: 'gate_type',
      width: 100,
      render: (v) => (
        <Tag
          icon={v === 'inward' ? <LoginOutlined /> : <LogoutOutlined />}
          color={v === 'inward' ? 'blue' : 'orange'}
        >
          {v === 'inward' ? 'Inward' : 'Outward'}
        </Tag>
      ),
    },
    {
      title: 'Reference',
      key: 'reference',
      width: 150,
      render: (_, record) => {
        if (record.so_number) return <Text>{record.so_number}</Text>;
        if (record.dispatch_number) return <Text>{record.dispatch_number}</Text>;
        return '-';
      },
    },
    {
      title: 'Warehouse',
      dataIndex: 'warehouse_name',
      key: 'warehouse',
      width: 140,
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: 'Vehicle No.',
      dataIndex: 'vehicle_number',
      key: 'vehicle_number',
      width: 130,
      render: (v) => v ? <Tag icon={<CarOutlined />}>{v}</Tag> : '-',
    },
    {
      title: 'Person Name',
      dataIndex: 'person_name',
      key: 'person_name',
      width: 140,
      render: (v) => v || '-',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Gate In',
      dataIndex: 'gate_in_time',
      key: 'gate_in_time',
      width: 150,
      render: (v) => v ? (
        <Space size={4}>
          <ClockCircleOutlined style={{ color: '#52c41a' }} />
          <Text style={{ fontSize: 12 }}>{formatDateTime(v)}</Text>
        </Space>
      ) : '-',
    },
    {
      title: 'Gate Out',
      dataIndex: 'gate_out_time',
      key: 'gate_out_time',
      width: 150,
      render: (v) => v ? (
        <Space size={4}>
          <ClockCircleOutlined style={{ color: '#fa8c16' }} />
          <Text style={{ fontSize: 12 }}>{formatDateTime(v)}</Text>
        </Space>
      ) : '-',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(record)} />
          </Tooltip>
          {record.status === 'pending' && (
            <>
              <Tooltip title="Approve">
                <Popconfirm title="Approve this gate pass?" onConfirm={() => handleApprove(record.id)}>
                  <Button type="link" size="small" icon={<CheckOutlined />} style={{ color: '#52c41a' }} />
                </Popconfirm>
              </Tooltip>
              <Tooltip title="Cancel">
                <Popconfirm title="Cancel this gate pass?" onConfirm={() => handleCancel(record.id)} okButtonProps={{ danger: true }}>
                  <Button type="link" size="small" danger icon={<CloseCircleOutlined />} />
                </Popconfirm>
              </Tooltip>
            </>
          )}
          {record.status === 'approved' && (
            <Tooltip title="Record Gate In">
              <Button
                type="link"
                size="small"
                icon={<LoginOutlined />}
                style={{ color: '#eb2f96' }}
                onClick={() => handleRecordGateIn(record.id)}
              />
            </Tooltip>
          )}
          {record.status === 'gate_in' && (
            <Tooltip title="Record Gate Out">
              <Button
                type="link"
                size="small"
                icon={<LogoutOutlined />}
                style={{ color: '#fa8c16' }}
                onClick={() => handleRecordGateOut(record.id)}
              />
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
        placeholder="Status"
        allowClear
        style={{ width: 140 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={GATE_STATUSES}
      />
    </Space>
  );

  // --- Tab Content ---
  const renderTabContent = () => (
    <DataTable
      key={`${activeTab}-${refreshKey}`}
      columns={columns}
      fetchFunction={fetchGateEntries}
      rowKey="id"
      searchPlaceholder="Search by gate pass number, vehicle, person..."
      exportFileName={`gate_entries_${activeTab}`}
      toolbar={toolbar}
      scroll={{ x: 1600 }}
    />
  );

  const tabItems = [
    {
      key: 'inward',
      label: (
        <span>
          <LoginOutlined /> Inward
        </span>
      ),
      children: renderTabContent(),
    },
    {
      key: 'outward',
      label: (
        <span>
          <LogoutOutlined /> Outward
        </span>
      ),
      children: renderTabContent(),
    },
  ];

  return (
    <div>
      <PageHeader title="Gate Entry" subtitle="Manage gate passes for inward and outward movements">
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            Create Gate Pass
          </Button>
        </Space>
      </PageHeader>

      <Tabs
        activeKey={activeTab}
        onChange={(key) => {
          setActiveTab(key);
          setFilterStatus(undefined);
          setRefreshKey((k) => k + 1);
        }}
        items={tabItems}
      />

      {/* --- Create Gate Pass Drawer --- */}
      <Drawer
        title="Create Gate Pass"
        width={600}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          form.resetFields();
        }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); form.resetFields(); }}>
              Cancel
            </Button>
            <Button type="primary" onClick={handleSubmit} loading={submitting}>
              Create Gate Pass
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item name="gate_type" label="Gate Type" rules={[{ required: true, message: 'Required' }]}>
            <Select
              options={[
                { label: 'Inward', value: 'inward' },
                { label: 'Outward', value: 'outward' },
              ]}
              onChange={(v) => {
                setGateType(v);
                form.setFieldsValue({ so_id: undefined, dispatch_id: undefined });
                if (v === 'inward') loadServiceOrderOptions();
                if (v === 'outward') loadDispatchOptions();
              }}
            />
          </Form.Item>

          {gateType === 'inward' && (
            <Form.Item name="so_id" label="Link to Service Order">
              <Select
                options={serviceOrderOptions}
                placeholder="Select Service Order (optional)"
                showSearch
                optionFilterProp="label"
                allowClear
                onSearch={(v) => loadServiceOrderOptions(v)}
                onChange={(soId) => {
                  if (!soId) return;
                  const selectedOption = serviceOrderOptions.find(o => o.value === soId);
                  if (selectedOption && selectedOption.so) {
                    const so = selectedOption.so;
                    const vehicle = so.vehicles?.[0] || {};
                    const sdoNumbers = so.mappings?.map(m => m.sdo_number).filter(Boolean).join(', ') || '';
                    form.setFieldsValue({
                      warehouse_id: so.warehouse_id || undefined,
                      vehicle_number: vehicle.vehicle_registration_no || '',
                      person_name: vehicle.driver_name || '',
                      person_contact: vehicle.driver_mobile || '',
                      material_description: sdoNumbers ? `SDOs: ${sdoNumbers}` : 'SCM Materials',
                    });
                  }
                }}
              />
            </Form.Item>
          )}

          {gateType === 'outward' && (
            <Form.Item name="dispatch_id" label="Link to Dispatch">
              <Select
                options={dispatchOptions}
                placeholder="Select Dispatch (optional)"
                showSearch
                optionFilterProp="label"
                allowClear
                onSearch={(v) => loadDispatchOptions(v)}
              />
            </Form.Item>
          )}

          <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true, message: 'Required' }]}>
            <Select
              options={warehouses}
              placeholder="Select warehouse"
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="vehicle_number" label="Vehicle Number">
                <Input placeholder="e.g., MH12AB1234" prefix={<CarOutlined />} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="person_name" label="Person Name" rules={[{ required: true, message: 'Required' }]}>
                <Input placeholder="Driver / person name" prefix={<UserOutlined />} />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="person_contact" label="Person Contact">
            <Input placeholder="Phone number" />
          </Form.Item>

          <Form.Item name="material_description" label="Material Description">
            <TextArea rows={3} placeholder="Describe the materials being transported..." />
          </Form.Item>
        </Form>
      </Drawer>

      {/* --- View Detail Modal --- */}
      <Modal
        title={viewData ? `Gate Pass: ${viewData.gate_pass_number}` : 'Gate Pass Detail'}
        open={viewModalOpen}
        onCancel={() => { setViewModalOpen(false); setViewData(null); setScannerMode(null); }}
        footer={
          viewData && (
            <Space>
              {viewData.status === 'pending' && (
                <Popconfirm title="Approve this gate pass?" onConfirm={async () => { await handleApprove(viewData.id); }}>
                  <Button type="primary" icon={<CheckOutlined />}>Approve</Button>
                </Popconfirm>
              )}
              {viewData.status === 'approved' && (
                <Button
                  type="primary"
                  icon={<LoginOutlined />}
                  onClick={() => setScannerMode('gate_in')}
                >
                  Record Gate In
                </Button>
              )}
              {viewData.status === 'gate_in' && (
                <Button
                  type="primary"
                  icon={<LogoutOutlined />}
                  onClick={() => setScannerMode('gate_out')}
                  style={{ backgroundColor: '#fa8c16', borderColor: '#fa8c16' }}
                >
                  Record Gate Out
                </Button>
              )}
              <Button icon={<PrinterOutlined />} onClick={handlePrint}>
                Print Gate Pass
              </Button>
              <Button onClick={() => { setViewModalOpen(false); setViewData(null); setScannerMode(null); }}>
                Close
              </Button>
            </Space>
          )
        }
        width={700}
        loading={viewLoading}
      >
        {viewData && (
          <div ref={printRef}>
            {/* Barcode Scanner for Gate In/Out */}
            {scannerMode && (
              <Card
                size="small"
                style={{
                  marginBottom: 16,
                  background: scannerMode === 'gate_in' ? '#e6f7ff' : '#fff7e6',
                  border: `1px solid ${scannerMode === 'gate_in' ? '#91d5ff' : '#ffd591'}`,
                }}
                title={
                  <Space>
                    <ScanOutlined />
                    <Text strong>
                      {scannerMode === 'gate_in' ? 'Scan to Record Gate IN' : 'Scan to Record Gate OUT'}
                    </Text>
                  </Space>
                }
                extra={
                  <Space>
                    <Button
                      size="small"
                      type="primary"
                      onClick={() => {
                        if (scannerMode === 'gate_in') handleRecordGateIn(viewData.id);
                        else handleRecordGateOut(viewData.id);
                      }}
                    >
                      Record Without Scan
                    </Button>
                    <Button size="small" onClick={() => setScannerMode(null)}>Cancel</Button>
                  </Space>
                }
              >
                <BarcodeScanner
                  onScan={handleGateScan}
                  placeholder="Scan gate pass barcode..."
                  autoFocus
                />
              </Card>
            )}

            <Descriptions bordered size="small" column={2} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="Gate Pass No.">{viewData.gate_pass_number}</Descriptions.Item>
              <Descriptions.Item label="Status"><StatusTag status={viewData.status} /></Descriptions.Item>
              <Descriptions.Item label="Gate Type">
                <Tag
                  icon={viewData.gate_type === 'inward' ? <LoginOutlined /> : <LogoutOutlined />}
                  color={viewData.gate_type === 'inward' ? 'blue' : 'orange'}
                >
                  {viewData.gate_type === 'inward' ? 'Inward' : 'Outward'}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Warehouse">{viewData.warehouse_name || '-'}</Descriptions.Item>
              {viewData.so_number && (
                <Descriptions.Item label="Service Order Reference">{viewData.so_number}</Descriptions.Item>
              )}
              {viewData.dispatch_number && (
                <Descriptions.Item label="Dispatch Reference">{viewData.dispatch_number}</Descriptions.Item>
              )}
              <Descriptions.Item label="Vehicle No.">
                {viewData.vehicle_number ? (
                  <Tag icon={<CarOutlined />}>{viewData.vehicle_number}</Tag>
                ) : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Person Name">{viewData.person_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Person Contact">{viewData.person_contact || '-'}</Descriptions.Item>
              <Descriptions.Item label="Created">{formatDateTime(viewData.created_at)}</Descriptions.Item>
            </Descriptions>

            {viewData.material_description && (
              <Card size="small" style={{ marginBottom: 16 }}>
                <Text strong>Material Description:</Text>
                <div style={{ marginTop: 4 }}>{viewData.material_description}</div>
              </Card>
            )}

            {/* Gate In / Gate Out Times */}
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={12}>
                <Card
                  size="small"
                  style={{
                    textAlign: 'center',
                    borderColor: viewData.gate_in_time ? '#52c41a' : '#d9d9d9',
                    background: viewData.gate_in_time ? '#f6ffed' : '#fafafa',
                  }}
                >
                  <LoginOutlined style={{ fontSize: 24, color: viewData.gate_in_time ? '#52c41a' : '#bfbfbf' }} />
                  <div style={{ marginTop: 4 }}>
                    <Text type="secondary">Gate IN</Text>
                  </div>
                  <div>
                    {viewData.gate_in_time ? (
                      <Text strong style={{ color: '#52c41a' }}>{formatDateTime(viewData.gate_in_time)}</Text>
                    ) : (
                      <Text type="secondary">Not recorded</Text>
                    )}
                  </div>
                </Card>
              </Col>
              <Col span={12}>
                <Card
                  size="small"
                  style={{
                    textAlign: 'center',
                    borderColor: viewData.gate_out_time ? '#fa8c16' : '#d9d9d9',
                    background: viewData.gate_out_time ? '#fff7e6' : '#fafafa',
                  }}
                >
                  <LogoutOutlined style={{ fontSize: 24, color: viewData.gate_out_time ? '#fa8c16' : '#bfbfbf' }} />
                  <div style={{ marginTop: 4 }}>
                    <Text type="secondary">Gate OUT</Text>
                  </div>
                  <div>
                    {viewData.gate_out_time ? (
                      <Text strong style={{ color: '#fa8c16' }}>{formatDateTime(viewData.gate_out_time)}</Text>
                    ) : (
                      <Text type="secondary">Not recorded</Text>
                    )}
                  </div>
                </Card>
              </Col>
            </Row>

            {/* Duration */}
            {viewData.gate_in_time && viewData.gate_out_time && (
              <Alert
                message={
                  <Text>
                    Duration: <Text strong>
                      {(() => {
                        const diff = dayjs(viewData.gate_out_time).diff(dayjs(viewData.gate_in_time), 'minute');
                        const hours = Math.floor(diff / 60);
                        const mins = diff % 60;
                        return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
                      })()}
                    </Text>
                  </Text>
                }
                type="info"
                icon={<ClockCircleOutlined />}
                showIcon
                style={{ marginBottom: 16 }}
              />
            )}

            {/* Barcode Display */}
            {viewData.gate_pass_number && (
              <div style={{ textAlign: 'center', marginTop: 16, paddingTop: 16, borderTop: '1px dashed #d9d9d9' }}>
                <BarcodeDisplay
                  value={viewData.gate_pass_number}
                  label="Gate Pass Barcode"
                  height={70}
                />
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
};

export default GateEntry;
