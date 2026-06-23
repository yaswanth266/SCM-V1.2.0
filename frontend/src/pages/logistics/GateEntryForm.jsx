import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Form, Input, Select, Button, Space, Spin, message,
  Descriptions, Row, Col, Popconfirm, Tag, Alert, Typography, Divider,
} from 'antd';
import {
  ArrowLeftOutlined, SaveOutlined, CheckOutlined,
  LoginOutlined, LogoutOutlined, CarOutlined, UserOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { formatDateTime, getErrorMessage } from '../../utils/helpers';

const { TextArea } = Input;
const { Text } = Typography;

const GateEntryForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [form] = Form.useForm();
  const isNew = !id || id === 'new';
  const modulePrefix = location.pathname.startsWith('/warehouse') ? '/warehouse' : '/logistics';

  // State
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [entry, setEntry] = useState(null);
  const [warehouses, setWarehouses] = useState([]);
  const [serviceOrderOptions, setServiceOrderOptions] = useState([]);
  const [inwardPassOptions, setInwardPassOptions] = useState([]);
  const [gateType, setGateType] = useState('inward');
  const [visitorType, setVisitorType] = useState('employee');

  // Determine default gate type from URL query or referrer
  const getDefaultGateType = () => {
    const params = new URLSearchParams(location.search);
    const typeParam = params.get('type');
    if (typeParam === 'outward' || typeParam === 'inward') return typeParam;
    return 'inward';
  };

  // --- Load Warehouses ---
  const loadWarehouses = useCallback(async () => {
    try {
      const res = await api.get('/masters/warehouses', { params: { page_size: 200, exclude_virtual: true } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setWarehouses(items.map((w) => ({ label: w.name || w.warehouse_name, value: w.id })));
    } catch {
      // silent
    }
  }, []);

  const loadServiceOrderOptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/logistics/so');
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

  const loadInwardPassOptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/warehouse/gate-entries', {
        params: { gate_type: 'inward', page_size: 100 },
      });
      const items = res.data?.items || res.data?.data || [];
      const filtered = search
        ? items.filter((p) =>
            p.gate_pass_number?.toLowerCase().includes(search.toLowerCase()) ||
            p.person_name?.toLowerCase().includes(search.toLowerCase()) ||
            p.vehicle_number?.toLowerCase().includes(search.toLowerCase())
          )
        : items;
      setInwardPassOptions(
        filtered.map((p) => ({
          label: `${p.gate_pass_number}${p.person_name ? ` – ${p.person_name}` : ''}${p.vehicle_number ? ` [${p.vehicle_number}]` : ''}`,
          value: p.id,
        }))
      );
    } catch {
      // silent
    }
  }, []);

  // --- Load existing entry ---
  const fetchEntry = useCallback(async () => {
    if (isNew) return;
    setLoading(true);
    try {
      const res = await api.get(`/warehouse/gate-entries/${id}`);
      const data = res.data;
      setEntry(data);
      if (data.visitor_type) setVisitorType(data.visitor_type);
      if (data.gate_type) setGateType(data.gate_type);
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate(`${modulePrefix}/gate-entry`);
    } finally {
      setLoading(false);
    }
  }, [id, isNew, navigate, modulePrefix]);

  useEffect(() => {
    if (isNew) {
      loadWarehouses();
      loadServiceOrderOptions();
      loadInwardPassOptions();
      const defaultType = getDefaultGateType();
      setGateType(defaultType);
      form.setFieldsValue({ gate_type: defaultType });
    } else {
      fetchEntry();
    }
  }, [isNew, fetchEntry, loadWarehouses, loadServiceOrderOptions, loadInwardPassOptions]);

  const getQueryParam = (key) => {
    const params = new URLSearchParams(location.search);
    return params.get(key);
  };
  const soIdParam = getQueryParam('so_id');

  useEffect(() => {
    if (isNew && soIdParam && serviceOrderOptions.length > 0) {
      const soId = parseInt(soIdParam);
      const selectedOption = serviceOrderOptions.find(o => o.value === soId);
      if (selectedOption && selectedOption.so) {
        const so = selectedOption.so;
        const vehicle = so.vehicles?.[0] || {};
        const sdoNumbers = so.mappings?.map(m => m.sdo_number).filter(Boolean).join(', ') || '';
        form.setFieldsValue({
          so_id: soId,
          warehouse_id: so.warehouse_id || undefined,
          vehicle_number: vehicle.vehicle_registration_no || '',
          person_name: vehicle.driver_name || '',
          person_contact: vehicle.driver_mobile || '',
          material_description: sdoNumbers ? `SDOs: ${sdoNumbers}` : 'SCM Materials',
        });
      }
    }
  }, [isNew, soIdParam, serviceOrderOptions, form]);

  // --- Submit new gate entry ---
  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      const visitor_details = {};
      if (values.visitor_type === 'employee') {
        visitor_details.employee_code = values.employee_code || null;
        if (values.gate_type === 'outward') {
          visitor_details.reference_no = values.reference_no || null;
        }
      } else if (values.visitor_type === 'courier') {
        visitor_details.courier_company = values.courier_company || null;
        if (values.gate_type === 'outward') {
          visitor_details.reference_no = values.reference_no || null;
        }
      } else if (values.visitor_type === 'third_party') {
        visitor_details.reference_no = values.reference_no || null;
        visitor_details.provider_name = values.provider_name || null;
      } else if (values.visitor_type === 'company_vehicle') {
        visitor_details.driver_code = values.driver_code || null;
        if (values.gate_type === 'outward') {
          visitor_details.reference_no = values.reference_no || null;
        }
      }

      const payload = {
        gate_type: values.gate_type,
        warehouse_id: values.warehouse_id || null,
        so_id: values.so_id || null,
        vehicle_number: values.vehicle_number || null,
        person_name: values.person_name || null,
        person_contact: values.person_contact || null,
        material_description: values.material_description || null,
        remarks: values.remarks || null,
        visitor_type: values.visitor_type || null,
        visitor_details: visitor_details,
        ref_gate_pass_id: values.ref_gate_pass_id || null,
      };

      const res = await api.post('/warehouse/gate-entries', payload);
      message.success('Gate entry created successfully');
      const newId = res.data?.id;
      if (newId) {
        navigate(`${modulePrefix}/gate-entry/${newId}`);
      } else {
        navigate(`${modulePrefix}/gate-entry`);
      }
    } catch (err) {
      if (err.errorFields) return; // form validation
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // --- Actions for existing entries ---
  const handleApprove = async () => {
    setActionLoading(true);
    try {
      await api.post(`/warehouse/gate-entries/${id}/approve`);
      message.success('Gate entry approved');
      fetchEntry();
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  };

  const handleComplete = async () => {
    setActionLoading(true);
    try {
      await api.post(`/warehouse/gate-entries/${id}/complete`);
      message.success('Gate entry completed');
      fetchEntry();
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  };

  // --- Loading spinner ---
  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <Spin size="large" tip="Loading Gate Entry..." fullscreen />
      </div>
    );
  }

  // --- VIEW MODE (existing entry) ---
  if (!isNew && entry) {
    return (
      <div>
        <PageHeader
          title={entry.gate_pass_number || `Gate Entry #${id}`}
          subtitle="Gate Entry Detail"
        >
          <Space>
            {entry.status === 'pending' && (
              <Popconfirm title="Approve this gate entry?" onConfirm={handleApprove}>
                <Button
                  type="primary"
                  icon={<CheckOutlined />}
                  loading={actionLoading}
                >
                  Approve
                </Button>
              </Popconfirm>
            )}
            {(entry.status === 'approved' || entry.status === 'pending') && (
              <Popconfirm title="Mark this gate entry as completed?" onConfirm={handleComplete}>
                <Button
                  type="primary"
                  icon={<CheckOutlined />}
                  loading={actionLoading}
                  style={{ backgroundColor: '#52c41a', borderColor: '#52c41a' }}
                >
                  Complete
                </Button>
              </Popconfirm>
            )}
            <Button
              icon={<ArrowLeftOutlined />}
              onClick={() => navigate(`${modulePrefix}/gate-entry`)}
            >
              Back
            </Button>
          </Space>
        </PageHeader>

        <Card style={{ marginBottom: 16 }}>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="Gate Pass No.">
              <Text strong>{entry.gate_pass_number || '-'}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="Status">
              <StatusTag status={entry.status} />
            </Descriptions.Item>
            <Descriptions.Item label="Gate Type">
              <Tag
                icon={entry.gate_type === 'inward' ? <LoginOutlined /> : <LogoutOutlined />}
                color={entry.gate_type === 'inward' ? 'blue' : 'orange'}
              >
                {entry.gate_type === 'inward' ? 'Inward' : 'Outward'}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Visitor Category">
              <Tag color="purple">
                {entry.visitor_type === 'employee' && 'Employee'}
                {entry.visitor_type === 'courier' && 'Courier'}
                {entry.visitor_type === 'third_party' && 'Third Party'}
                {entry.visitor_type === 'company_vehicle' && 'Company Vehicle'}
                {!entry.visitor_type && '-'}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Warehouse">
              {entry.warehouse_name || '-'}
            </Descriptions.Item>
            {entry.gate_type === 'outward' && entry.ref_gate_pass_number && (
              <Descriptions.Item label="Reference Gate Pass (Inward)">
                <a onClick={() => navigate(`${modulePrefix}/gate-entry/${entry.ref_gate_pass_id}`)}>
                  <Tag color="blue" icon={<LoginOutlined />} style={{ cursor: 'pointer' }}>
                    {entry.ref_gate_pass_number}
                  </Tag>
                </a>
              </Descriptions.Item>
            )}
            {entry.gate_type === 'inward' && entry.outward_gate_pass_number && (
              <Descriptions.Item label="Linked Gate Pass (Outward)">
                <a onClick={() => navigate(`${modulePrefix}/gate-entry/${entry.outward_gate_pass_id}`)}>
                  <Tag color="orange" icon={<LogoutOutlined />} style={{ cursor: 'pointer' }}>
                    {entry.outward_gate_pass_number}
                  </Tag>
                </a>
              </Descriptions.Item>
            )}
            {entry.so_number && (
              <Descriptions.Item label="Service Order Reference">
                {entry.so_number}
              </Descriptions.Item>
            )}
            <Descriptions.Item label="Vehicle Number">
              {entry.vehicle_number ? (
                <Tag icon={<CarOutlined />}>{entry.vehicle_number}</Tag>
              ) : '-'}
            </Descriptions.Item>

            {entry.visitor_type === 'employee' && (
              <>
                <Descriptions.Item label="Employee Code (CID)">{entry.visitor_details?.employee_code || '-'}</Descriptions.Item>
                <Descriptions.Item label="Employee Name">{entry.person_name || '-'}</Descriptions.Item>
                {entry.gate_type === 'outward' && (
                  <Descriptions.Item label="Dispatch Reference">{entry.visitor_details?.reference_no || '-'}</Descriptions.Item>
                )}
              </>
            )}

            {entry.visitor_type === 'courier' && (
              <>
                <Descriptions.Item label="Courier Company">{entry.visitor_details?.courier_company || '-'}</Descriptions.Item>
                <Descriptions.Item label="Agent Name">{entry.person_name || '-'}</Descriptions.Item>
                <Descriptions.Item label="Agent Contact">{entry.person_contact || '-'}</Descriptions.Item>
                {entry.gate_type === 'outward' && (
                  <Descriptions.Item label="Dispatch Reference">{entry.visitor_details?.reference_no || '-'}</Descriptions.Item>
                )}
              </>
            )}

            {entry.visitor_type === 'third_party' && (
              <>
                <Descriptions.Item label="PO / SO Ref">{entry.visitor_details?.reference_no || '-'}</Descriptions.Item>
                <Descriptions.Item label="Provider Name">{entry.visitor_details?.provider_name || '-'}</Descriptions.Item>
                <Descriptions.Item label="Contact Person">{entry.person_name || '-'}</Descriptions.Item>
                <Descriptions.Item label="Contact Phone">{entry.person_contact || '-'}</Descriptions.Item>
              </>
            )}

            {entry.visitor_type === 'company_vehicle' && (
              <>
                <Descriptions.Item label="Driver Code">{entry.visitor_details?.driver_code || '-'}</Descriptions.Item>
                <Descriptions.Item label="Driver Name">{entry.person_name || '-'}</Descriptions.Item>
                <Descriptions.Item label="Driver Contact">{entry.person_contact || '-'}</Descriptions.Item>
                {entry.gate_type === 'outward' && (
                  <Descriptions.Item label="Dispatch Reference">{entry.visitor_details?.reference_no || '-'}</Descriptions.Item>
                )}
              </>
            )}

            {!entry.visitor_type && (
              <>
                <Descriptions.Item label="Person Name">{entry.person_name || '-'}</Descriptions.Item>
                <Descriptions.Item label="Person Contact">{entry.person_contact || '-'}</Descriptions.Item>
              </>
            )}

            <Descriptions.Item label="Material Description">
              {entry.material_description || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Remarks" span={3}>
              {entry.remarks || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Created At">
              {formatDateTime(entry.created_at)}
            </Descriptions.Item>
            <Descriptions.Item label="Created By">
              {entry.created_by_name || entry.created_by || '-'}
            </Descriptions.Item>
            {entry.approved_at && (
              <Descriptions.Item label="Approved At">
                {formatDateTime(entry.approved_at)}
              </Descriptions.Item>
            )}
          </Descriptions>
        </Card>

        {/* Gate In / Gate Out Times */}
        {(entry.gate_in_time || entry.gate_out_time) && (
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col span={12}>
              <Card
                size="small"
                style={{
                  textAlign: 'center',
                  borderColor: entry.gate_in_time ? '#52c41a' : '#d9d9d9',
                  background: entry.gate_in_time ? '#f6ffed' : '#fafafa',
                }}
              >
                <LoginOutlined style={{ fontSize: 24, color: entry.gate_in_time ? '#52c41a' : '#bfbfbf' }} />
                <div style={{ marginTop: 4 }}>
                  <Text type="secondary">Gate IN</Text>
                </div>
                <div>
                  {entry.gate_in_time ? (
                    <Text strong style={{ color: '#52c41a' }}>{formatDateTime(entry.gate_in_time)}</Text>
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
                  borderColor: entry.gate_out_time ? '#fa8c16' : '#d9d9d9',
                  background: entry.gate_out_time ? '#fff7e6' : '#fafafa',
                }}
              >
                <LogoutOutlined style={{ fontSize: 24, color: entry.gate_out_time ? '#fa8c16' : '#bfbfbf' }} />
                <div style={{ marginTop: 4 }}>
                  <Text type="secondary">Gate OUT</Text>
                </div>
                <div>
                  {entry.gate_out_time ? (
                    <Text strong style={{ color: '#fa8c16' }}>{formatDateTime(entry.gate_out_time)}</Text>
                  ) : (
                    <Text type="secondary">Not recorded</Text>
                  )}
                </div>
              </Card>
            </Col>
          </Row>
        )}

        {/* Duration */}
        {entry.gate_in_time && entry.gate_out_time && (
          <Alert
            message={
              <Text>
                Duration:{' '}
                <Text strong>
                  {(() => {
                    const diff = dayjs(entry.gate_out_time).diff(dayjs(entry.gate_in_time), 'minute');
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
          />
        )}
      </div>
    );
  }

  // --- CREATE MODE ---
  return (
    <div>
      <PageHeader title="Create Gate Entry" subtitle="Register a new gate entry pass">
        <Space>
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate(`${modulePrefix}/gate-entry`)}
          >
            Back
          </Button>
        </Space>
      </PageHeader>

      <Card>
        <Form
          form={form}
          layout="vertical"
          initialValues={{ gate_type: getDefaultGateType(), visitor_type: 'employee' }}
          onFinish={handleSubmit}
        >
          <Row gutter={24}>
            <Col xs={24} sm={12} md={8}>
              <Form.Item
                name="gate_type"
                label="Gate Type"
                rules={[{ required: true, message: 'Please select gate type' }]}
              >
                <Select
                  options={[
                    { label: 'Inward', value: 'inward' },
                    { label: 'Outward', value: 'outward' },
                  ]}
                  onChange={(v) => {
                    setGateType(v);
                    form.setFieldsValue({ so_id: undefined, ref_gate_pass_id: undefined });
                    if (v === 'outward') loadInwardPassOptions();
                  }}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Form.Item
                name="visitor_type"
                label="Visitor Category"
                rules={[{ required: true, message: 'Please select visitor category' }]}
              >
                <Select
                  options={[
                    { label: 'Employee', value: 'employee' },
                    { label: 'Courier', value: 'courier' },
                    { label: 'Third Party', value: 'third_party' },
                    { label: 'Company Vehicle', value: 'company_vehicle' },
                  ]}
                  onChange={(v) => {
                    setVisitorType(v);
                  }}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  options={warehouses}
                  placeholder="Select warehouse"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                />
              </Form.Item>
            </Col>
          </Row>

          {gateType === 'inward' && visitorType === 'third_party' && (
            <Row gutter={24}>
              <Col xs={24} sm={12} md={8}>
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
              </Col>
            </Row>
          )}

          {/* Reference Gate Pass (Inward) — only shown for outward gate passes */}
          {gateType === 'outward' && (
            <Row gutter={24}>
              <Col xs={24} sm={12} md={10}>
                <Form.Item
                  name="ref_gate_pass_id"
                  label="Reference Gate Pass (Inward)"
                  tooltip="Optionally link the inward gate pass that this outward movement is related to"
                >
                  <Select
                    options={inwardPassOptions}
                    placeholder="Search and select an inward gate pass (optional)"
                    showSearch
                    optionFilterProp="label"
                    allowClear
                    onSearch={(v) => loadInwardPassOptions(v)}
                  />
                </Form.Item>
              </Col>
            </Row>
          )}

          {/* DYNAMIC VISITOR FIELDS */}
          <Divider orientation="left" style={{ margin: '12px 0' }}>Visitor / Vehicle Details</Divider>

          {visitorType === 'employee' && (
            <Row gutter={24}>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="employee_code" label="Employee Code (CID)" rules={[{ required: true, message: 'Required' }]}>
                  <Input placeholder="Enter employee CID" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="person_name" label="Employee Name" rules={[{ required: true, message: 'Required' }]}>
                  <Input placeholder="Enter name" prefix={<UserOutlined />} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="vehicle_number" label="Vehicle Number (optional)">
                  <Input placeholder="e.g. MH12AB1234" prefix={<CarOutlined />} />
                </Form.Item>
              </Col>
              {gateType === 'outward' && (
                <Col xs={24} sm={12} md={8}>
                  <Form.Item name="reference_no" label="Reference No (Dispatch)" rules={[{ required: true, message: 'Required' }]}>
                    <Input placeholder="Enter dispatch reference" />
                  </Form.Item>
                </Col>
              )}
            </Row>
          )}

          {visitorType === 'courier' && (
            <Row gutter={24}>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="courier_company" label="Courier Company Name" rules={[{ required: true, message: 'Required' }]}>
                  <Input placeholder="e.g. DHL, BlueDart" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="person_name" label="Agent / User Name" rules={[{ required: true, message: 'Required' }]}>
                  <Input placeholder="Agent name" prefix={<UserOutlined />} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="person_contact" label="Agent Contact Number" rules={[{ required: true, message: 'Required' }]}>
                  <Input placeholder="Contact number" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="vehicle_number" label="Vehicle Number (optional)">
                  <Input placeholder="e.g. MH12AB1234" prefix={<CarOutlined />} />
                </Form.Item>
              </Col>
              {gateType === 'outward' && (
                <Col xs={24} sm={12} md={8}>
                  <Form.Item name="reference_no" label="Reference No (Dispatch)" rules={[{ required: true, message: 'Required' }]}>
                    <Input placeholder="Enter dispatch reference" />
                  </Form.Item>
                </Col>
              )}
            </Row>
          )}

          {visitorType === 'third_party' && (
            <Row gutter={24}>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="reference_no" label="Reference No (Service Order / PO No)" rules={[{ required: true, message: 'Required' }]}>
                  <Input placeholder="Enter PO/SO number" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="provider_name" label="Provider Company Details" rules={[{ required: true, message: 'Required' }]}>
                  <Input placeholder="Provider company name" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="person_name" label="Contact Person Name" rules={[{ required: true, message: 'Required' }]}>
                  <Input placeholder="Contact person" prefix={<UserOutlined />} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="person_contact" label="Contact Phone">
                  <Input placeholder="Contact phone number" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="vehicle_number" label="Vehicle Details (optional)">
                  <Input placeholder="Vehicle details" prefix={<CarOutlined />} />
                </Form.Item>
              </Col>
            </Row>
          )}

          {visitorType === 'company_vehicle' && (
            <Row gutter={24}>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="vehicle_number" label="Company Vehicle Number / Details" rules={[{ required: true, message: 'Required' }]}>
                  <Input placeholder="Vehicle details" prefix={<CarOutlined />} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="driver_code" label="Driver Employee Code / ID" rules={[{ required: true, message: 'Required' }]}>
                  <Input placeholder="Driver code" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="person_name" label="Driver Name" rules={[{ required: true, message: 'Required' }]}>
                  <Input placeholder="Driver name" prefix={<UserOutlined />} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="person_contact" label="Driver Contact Phone">
                  <Input placeholder="Driver contact phone number" />
                </Form.Item>
              </Col>
              {gateType === 'outward' && (
                <Col xs={24} sm={12} md={8}>
                  <Form.Item name="reference_no" label="Reference No (Dispatch)" rules={[{ required: true, message: 'Required' }]}>
                    <Input placeholder="Enter dispatch reference" />
                  </Form.Item>
                </Col>
              )}
            </Row>
          )}

          <Divider style={{ margin: '12px 0' }} />

          <Row gutter={24}>
            <Col xs={24} md={16}>
              <Form.Item name="material_description" label="Materials Description">
                <TextArea rows={3} placeholder="Describe the materials being transported..." />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={24}>
            <Col xs={24} md={16}>
              <Form.Item name="remarks" label={gateType === 'inward' ? "Reason for Inward / Remarks" : "Remarks"}>
                <TextArea rows={2} placeholder="Any additional comments..." />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item>
            <Space>
              <Button
                type="primary"
                htmlType="submit"
                icon={<SaveOutlined />}
                loading={submitting}
                size="large"
              >
                Create Gate Entry
              </Button>
              <Button onClick={() => navigate(`${modulePrefix}/gate-entry`)}>
                Cancel
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};

export default GateEntryForm;
