import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Form, Input, Select, Button, Space, Spin, message,
  Descriptions, Row, Col, Popconfirm, Tag, Alert, Typography,
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

  // State
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [entry, setEntry] = useState(null);
  const [warehouses, setWarehouses] = useState([]);
  const [serviceOrderOptions, setServiceOrderOptions] = useState([]);
  const [gateType, setGateType] = useState('inward');

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

  // --- Load existing entry ---
  const fetchEntry = useCallback(async () => {
    if (isNew) return;
    setLoading(true);
    try {
      const res = await api.get(`/warehouse/gate-entries/${id}`);
      setEntry(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/logistics/gate-entry');
    } finally {
      setLoading(false);
    }
  }, [id, isNew, navigate]);

  useEffect(() => {
    if (isNew) {
      loadWarehouses();
      loadServiceOrderOptions();
      const defaultType = getDefaultGateType();
      setGateType(defaultType);
      form.setFieldsValue({ gate_type: defaultType });
    } else {
      fetchEntry();
    }
  }, [isNew, fetchEntry, loadWarehouses, loadServiceOrderOptions]);

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

      const payload = {
        gate_type: values.gate_type,
        warehouse_id: values.warehouse_id || null,
        so_id: values.so_id || null,
        vehicle_number: values.vehicle_number || null,
        person_name: values.person_name || null,
        person_contact: values.person_contact || null,
        material_description: values.material_description || null,
        remarks: values.remarks || null,
      };

      const res = await api.post('/warehouse/gate-entries', payload);
      message.success('Gate entry created successfully');
      const newId = res.data?.id;
      if (newId) {
        navigate(`/logistics/gate-entry/${newId}`);
      } else {
        navigate('/logistics/gate-entry');
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
              onClick={() => navigate('/logistics/gate-entry')}
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
            <Descriptions.Item label="Warehouse">
              {entry.warehouse_name || '-'}
            </Descriptions.Item>
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
            <Descriptions.Item label="Person Name">
              {entry.person_name || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Person Contact">
              {entry.person_contact || '-'}
            </Descriptions.Item>
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
            onClick={() => navigate('/logistics/gate-entry')}
          >
            Back
          </Button>
        </Space>
      </PageHeader>

      <Card>
        <Form
          form={form}
          layout="vertical"
         
          initialValues={{ gate_type: getDefaultGateType() }}
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
                    form.setFieldsValue({ so_id: undefined });
                  }}
                />
              </Form.Item>
            </Col>
            {gateType === 'inward' && (
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
            )}
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

          <Row gutter={24}>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="vehicle_number" label="Vehicle Number">
                <Input placeholder="e.g., MH12AB1234" prefix={<CarOutlined />} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="person_name" label="Person Name" rules={[{ required: true, message: 'Required' }]}>
                <Input placeholder="Driver / visitor / contact person" prefix={<UserOutlined />} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={24}>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="person_contact" label="Person Contact">
                <Input placeholder="Phone number" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={24}>
            <Col xs={24} md={16}>
              <Form.Item name="material_description" label="Material Description" rules={[{ required: true, message: 'Destination / material description is required' }]}>
                <TextArea rows={3} placeholder="Description of materials..." />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={24}>
            <Col xs={24} md={16}>
              <Form.Item name="remarks" label="Remarks">
                <TextArea rows={2} placeholder="Any additional remarks..." />
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
              <Button onClick={() => navigate('/logistics/gate-entry')}>
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
