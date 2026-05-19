import React, { useState, useEffect, useCallback } from 'react';
import {
  Button, Form, Input, InputNumber, Select, Space, DatePicker,
  message, Row, Col, Card, Descriptions, Divider, Spin,
} from 'antd';
import {
  ArrowLeftOutlined, SaveOutlined, EditOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useParams, useNavigate } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatDate, formatCurrency, getErrorMessage, formatDateForAPI,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;

const ASSET_STATUSES = [
  { label: 'Available', value: 'available' },
  { label: 'In Use', value: 'in_use' },
  { label: 'Under Maintenance', value: 'under_maintenance' },
  { label: 'Disposed', value: 'disposed' },
  { label: 'Lost', value: 'lost' },
];

const CONDITION_OPTIONS = [
  { label: 'New', value: 'new' },
  { label: 'Good', value: 'good' },
  { label: 'Fair', value: 'fair' },
  { label: 'Poor', value: 'poor' },
  { label: 'Damaged', value: 'damaged' },
];

const AssetForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [asset, setAsset] = useState(null);
  const [editMode, setEditMode] = useState(isNew);

  // Lookups
  const [categories, setCategories] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [users, setUsers] = useState([]);

  const loadLookups = useCallback(async () => {
    try {
      const [catRes, vendorRes, whRes, userRes] = await Promise.allSettled([
        api.get('/assets/categories'),
        api.get('/masters/vendors', { params: { page_size: 500, status: 'active' } }),
        api.get('/masters/warehouses', { params: { page_size: 500, status: 'active' } }),
        api.get('/users/lookup', { params: { page_size: 500 } }),
      ]);
      if (catRes.status === 'fulfilled') {
        const d = catRes.value.data;
        const items = d.items || d.data || d || [];
        setCategories(items.map((c) => ({ label: c.name, value: c.id })));
      }
      if (vendorRes.status === 'fulfilled') {
        const d = vendorRes.value.data;
        setVendors((d.items || d.data || d || []).map((v) => ({ label: v.name, value: v.id })));
      }
      if (whRes.status === 'fulfilled') {
        const d = whRes.value.data;
        setWarehouses((d.items || d.data || d || []).map((w) => ({ label: w.name || w.warehouse_name, value: w.id })));
      }
      if (userRes.status === 'fulfilled') {
        const d = userRes.value.data;
        setUsers((d.items || d.data || d || []).map((u) => ({ label: u.full_name || u.username, value: u.id })));
      }
    } catch {
      // silent
    }
  }, []);

  const fetchAsset = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/assets/${id}`);
      const data = res.data;
      setAsset(data);
      form.setFieldsValue({
        ...data,
        purchase_date: data.purchase_date ? dayjs(data.purchase_date) : null,
        warranty_expiry: data.warranty_expiry ? dayjs(data.warranty_expiry) : null,
      });
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/assets/register');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLookups();
    if (!isNew) {
      fetchAsset();
    }
  }, [id]);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      if (isNew) {
        // AssetCreate payload
        const payload = {
          name: values.name,
          category_id: values.category_id,
          serial_number: values.serial_number || null,
          purchase_date: formatDateForAPI(values.purchase_date),
          purchase_price: values.purchase_price || 0,
          current_value: values.current_value || values.purchase_price || 0,
          vendor_id: values.vendor_id || null,
          warranty_expiry: formatDateForAPI(values.warranty_expiry),
          current_warehouse_id: values.current_warehouse_id || null,
          current_location: values.current_location || null,
          assigned_to: values.assigned_to || null,
          remarks: values.remarks || null,
        };
        const res = await api.post('/assets', payload);
        const newId = res.data.id;
        message.success(`Asset created successfully (${res.data.asset_code || ''})`);
        navigate(`/assets/register/${newId}`);
      } else {
        // AssetUpdate payload (only updatable fields)
        const payload = {
          name: values.name,
          current_value: values.current_value || null,
          current_warehouse_id: values.current_warehouse_id || null,
          current_location: values.current_location || null,
          assigned_to: values.assigned_to || null,
          status: values.status || null,
          condition_status: values.condition_status || null,
          remarks: values.remarks || null,
        };
        await api.put(`/assets/${id}`, payload);
        message.success('Asset updated successfully');
        setEditMode(false);
        fetchAsset();
      }
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}>
        <Spin size="large" />
      </div>
    );
  }

  // View mode for existing asset
  if (!isNew && asset && !editMode) {
    const categoryLabel = categories.find((c) => c.value === asset.category_id)?.label || asset.category_id || '-';
    const vendorLabel = vendors.find((v) => v.value === asset.vendor_id)?.label || asset.vendor_id || '-';
    const warehouseLabel = warehouses.find((w) => w.value === asset.current_warehouse_id)?.label || asset.current_warehouse_id || '-';
    const userLabel = users.find((u) => u.value === asset.assigned_to)?.label || asset.assigned_to || '-';

    return (
      <div>
        <PageHeader title={asset.asset_code || `Asset #${id}`} subtitle="Asset Detail">
          <Space>
            <Button icon={<EditOutlined />} onClick={() => setEditMode(true)}>Edit</Button>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/assets/register')}>Back</Button>
          </Space>
        </PageHeader>

        <Card>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="Asset Code">{asset.asset_code || '-'}</Descriptions.Item>
            <Descriptions.Item label="Name">{asset.name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Category">{categoryLabel}</Descriptions.Item>
            <Descriptions.Item label="Serial Number">{asset.serial_number || '-'}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={asset.status} /></Descriptions.Item>
            <Descriptions.Item label="Condition">{asset.condition_status || '-'}</Descriptions.Item>
            <Descriptions.Item label="Purchase Date">{formatDate(asset.purchase_date)}</Descriptions.Item>
            <Descriptions.Item label="Purchase Price">{formatCurrency(asset.purchase_price)}</Descriptions.Item>
            <Descriptions.Item label="Current Value">{formatCurrency(asset.current_value)}</Descriptions.Item>
            <Descriptions.Item label="Vendor">{vendorLabel}</Descriptions.Item>
            <Descriptions.Item label="Warranty Expiry">{formatDate(asset.warranty_expiry)}</Descriptions.Item>
            <Descriptions.Item label="Warehouse">{warehouseLabel}</Descriptions.Item>
            <Descriptions.Item label="Location">{asset.current_location || '-'}</Descriptions.Item>
            <Descriptions.Item label="Assigned To">{userLabel}</Descriptions.Item>
            <Descriptions.Item label="Remarks" span={3}>{asset.remarks || '-'}</Descriptions.Item>
          </Descriptions>
        </Card>
      </div>
    );
  }

  // Create / Edit mode
  return (
    <div>
      <PageHeader
        title={isNew ? 'Create Asset' : `Edit ${asset?.asset_code || ''}`}
        subtitle={isNew ? 'Register a new asset' : 'Edit asset details'}
      >
        <Space>
          <Button onClick={() => navigate('/assets/register')} icon={<ArrowLeftOutlined />}>Back</Button>
          {!isNew && <Button onClick={() => setEditMode(false)}>Cancel Edit</Button>}
        </Space>
      </PageHeader>

      <Card>
        <Form form={form} layout="vertical">
          {/* Basic Info */}
          <Divider orientation="left">Basic Information</Divider>
          <Row gutter={16}>
            <Col xs={24} sm={12} md={8}>
              <Form.Item
                name="name"
                label="Asset Name"
                rules={[{ required: true, message: 'Asset name is required' }]}
              >
                <Input placeholder="Enter asset name" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Form.Item
                name="category_id"
                label="Category"
                rules={[{ required: true, message: 'Category is required' }]}
              >
                <Select
                  placeholder="Select category"
                  options={categories}
                  showSearch
                  optionFilterProp="label"
                  allowClear
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="serial_number" label="Serial Number">
                <Input placeholder="Enter serial number" />
              </Form.Item>
            </Col>
          </Row>

          {/* Edit-mode only: status & condition */}
          {!isNew && (
            <Row gutter={16}>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="status" label="Status">
                  <Select placeholder="Select status" options={ASSET_STATUSES} />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="condition_status" label="Condition">
                  <Select placeholder="Select condition" options={CONDITION_OPTIONS} allowClear />
                </Form.Item>
              </Col>
            </Row>
          )}

          {/* Purchase & Value */}
          <Divider orientation="left">Purchase &amp; Value</Divider>
          <Row gutter={16}>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="purchase_date" label="Purchase Date">
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="purchase_price" label="Purchase Price">
                <InputNumber
                  min={0}
                  step={0.01}
                  style={{ width: '100%' }}
                  placeholder="0.00"
                  prefix="INR"
                  disabled={!isNew}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="current_value" label="Current Value">
                <InputNumber
                  min={0}
                  step={0.01}
                  style={{ width: '100%' }}
                  placeholder="0.00"
                  prefix="INR"
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="vendor_id" label="Vendor">
                <Select
                  placeholder="Select vendor"
                  options={vendors}
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  disabled={!isNew}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="warranty_expiry" label="Warranty Expiry">
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
          </Row>

          {/* Location & Assignment */}
          <Divider orientation="left">Location &amp; Assignment</Divider>
          <Row gutter={16}>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="current_warehouse_id" label="Warehouse">
                <Select
                  placeholder="Select warehouse"
                  options={warehouses}
                  showSearch
                  optionFilterProp="label"
                  allowClear
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="current_location" label="Location">
                <Input placeholder="e.g. Building A, Floor 2" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="assigned_to" label="Assigned To">
                <Select
                  placeholder="Select user"
                  options={users}
                  showSearch
                  optionFilterProp="label"
                  allowClear
                />
              </Form.Item>
            </Col>
          </Row>

          {/* Remarks */}
          <Divider orientation="left">Additional Details</Divider>
          <Form.Item name="remarks" label="Remarks">
            <TextArea rows={3} placeholder="Any additional remarks..." />
          </Form.Item>
        </Form>

        <Divider />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={() => navigate('/assets/register')}>Cancel</Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSubmit}
            loading={submitting}
          >
            {isNew ? 'Create Asset' : 'Update Asset'}
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default AssetForm;
