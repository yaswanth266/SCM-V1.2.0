import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Button, Form, Input, InputNumber, Select, Switch, Space, Tabs,
  Popconfirm, App as AntApp, Row, Col, Rate, Table, Card, Descriptions, Tag,
  Spin, Empty, Modal, Tooltip, Typography, Alert,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  ArrowLeftOutlined, DownloadOutlined, CloseCircleOutlined,
  WarningOutlined, KeyOutlined, LockOutlined, UserOutlined,
  CheckCircleOutlined, CloseOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatCurrency, formatDate, getErrorMessage, downloadExcel, formatNumber,
  handleFormValidationFailed,
} from '../../utils/helpers';

const STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka',
  'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
  'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Delhi', 'Jammu & Kashmir', 'Ladakh', 'Chandigarh', 'Puducherry',
];

const VENDOR_TEXT_FIELDS = [
  'contact_person', 'email', 'phone', 'alt_phone', 'address_line1',
  'address_line2', 'city', 'state', 'pincode', 'country', 'gst_number',
  'pan_number', 'bank_name', 'bank_account', 'bank_ifsc',
  'drug_license_number', 'drug_license_state', 'gst_certificate_url',
  'license_doc_url',
];

const legacyVendorType = (type) => {
  const value = String(type?.code || type?.name || type || '').trim().toLowerCase();
  if (!value) return 'material';
  if (value === 'both' || value.includes('both')) return 'both';
  if (value === 'transport' || value.includes('transport') || value.includes('logistics')) return 'transport';
  if (value === 'service' || value.includes('service')) return 'service';
  return 'material';
};

const isMaterialSupplierVendor = (record) => {
  const typeCodes = Array.isArray(record?.vendor_types)
    ? record.vendor_types.map((t) => legacyVendorType(t))
    : [];
  const primaryType = legacyVendorType(record?.vendor_type_name || record?.vendor_type);
  return typeCodes.includes('material')
    || typeCodes.includes('both')
    || primaryType === 'material'
    || primaryType === 'both';
};

const filterMaterialSupplierVendors = (items) => items.filter(isMaterialSupplierVendor);

const Vendors = () => {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);
  const [filterType, setFilterType] = useState(undefined);
  const [filterCategory, setFilterCategory] = useState(undefined);
  const [filterCity, setFilterCity] = useState(undefined);
  const [vendorTypes, setVendorTypes] = useState([]);
  const [vendorTypeLoading, setVendorTypeLoading] = useState(false);
  const [vendorTypeModalOpen, setVendorTypeModalOpen] = useState(false);
  const [editingVendorType, setEditingVendorType] = useState(null);
  const [vendorTypeForm] = Form.useForm();
  const [vendorTypeSubmitting, setVendorTypeSubmitting] = useState(false);
  const [vendorCategories, setVendorCategories] = useState([]);
  const [vendorCategoryLoading, setVendorCategoryLoading] = useState(false);
  const [vendorCategoryModalOpen, setVendorCategoryModalOpen] = useState(false);
  const [editingVendorCategory, setEditingVendorCategory] = useState(null);
  const [vendorCategoryForm] = Form.useForm();
  const [vendorCategorySubmitting, setVendorCategorySubmitting] = useState(false);



  // Supplier login management state
  const [supplierLogins, setSupplierLogins] = useState([]);
  const [supplierLoginsLoading, setSupplierLoginsLoading] = useState(false);
  const [supplierLoginModal, setSupplierLoginModal] = useState(false);
  const [supplierLoginVendor, setSupplierLoginVendor] = useState(null);
  const [supplierLoginForm] = Form.useForm();
  const [supplierLoginSubmitting, setSupplierLoginSubmitting] = useState(false);
  const [supplierLoginMode, setSupplierLoginMode] = useState('create'); // 'create' | 'reset'
  const [supplierLoginError, setSupplierLoginError] = useState('');

  useEffect(() => {
    fetchVendorTypes();
    fetchVendorCategories();
    fetchSupplierLogins();
  }, []);

  const supplierLoginVendorIds = useMemo(
    () => new Set(
      supplierLogins
        .filter((row) => row.login)
        .map((row) => Number(row.vendor_id)),
    ),
    [supplierLogins],
  );

  const fetchVendorTypes = async () => {
    setVendorTypeLoading(true);
    try {
      const res = await api.get('/masters/vendor-types', { params: { include_inactive: true } });
      const data = res.data;
      setVendorTypes(data.items || data.data || data || []);
    } catch {
      setVendorTypes([]);
    } finally {
      setVendorTypeLoading(false);
    }
  };

  const fetchVendorCategories = async () => {
    setVendorCategoryLoading(true);
    try {
      const res = await api.get('/masters/vendor-categories', { params: { include_inactive: true } });
      const data = res.data;
      setVendorCategories(data.items || data.data || data || []);
    } catch {
      setVendorCategories([]);
    } finally {
      setVendorCategoryLoading(false);
    }
  };

  const fetchSupplierLogins = async () => {
    setSupplierLoginsLoading(true);
    try {
      const res = await api.get('/masters/vendors/supplier-logins');
      setSupplierLogins(res.data || []);
    } catch {
      setSupplierLogins([]);
    } finally {
      setSupplierLoginsLoading(false);
    }
  };

  const openSupplierLoginModal = (vendor, mode) => {
    const existingLogin = vendor.login;
    const resolvedMode = mode || (existingLogin ? 'reset' : 'create');

    setSupplierLoginVendor(vendor);
    setSupplierLoginMode(resolvedMode);
    setSupplierLoginError('');
    supplierLoginForm.resetFields();
    if (resolvedMode === 'create') {
      supplierLoginForm.setFieldsValue({
        full_name: vendor.contact_person || '',
        email: vendor.email || '',
        phone: vendor.phone || '',
      });
    } else {
      supplierLoginForm.setFieldsValue({
        full_name: vendor.contact_person || '',
        email: vendor.login?.email || vendor.email || '',
        phone: vendor.phone || '',
        is_active: vendor.login?.is_active !== false,
      });
    }
    setSupplierLoginModal(true);
  };

  const handleSupplierLoginSubmit = async (values) => {
    if (supplierLoginMode === 'create' && supplierLoginVendor?.is_active === false) {
      setSupplierLoginError('Cannot create portal login for an inactive vendor. Activate the vendor first.');
      return;
    }
    setSupplierLoginSubmitting(true);
    setSupplierLoginError('');
    try {
      const vendorId = supplierLoginVendor.vendor_id;
      if (supplierLoginMode === 'create') {
        await api.post(`/masters/vendors/${vendorId}/supplier-login`, {
          username: values.username,
          email: values.email,
          password: values.password,
          full_name: values.full_name,
          phone: values.phone,
        });
        message.success('Supplier login created successfully');
      } else {
        await api.put(`/masters/vendors/${vendorId}/supplier-login`, {
          new_password: values.password || undefined,
          is_active: values.is_active !== undefined ? values.is_active : undefined,
          email: values.email,
          full_name: values.full_name,
          phone: values.phone,
        });
        message.success('Supplier login updated');
      }
      setSupplierLoginModal(false);
      await fetchSupplierLogins();
    } catch (err) {
      const detail = err?.response?.data?.detail;
      const msg = Array.isArray(detail)
        ? detail.map((d) => d.msg || d.message || String(d)).join(', ')
        : detail || err?.response?.data?.message || 'Operation failed';
      setSupplierLoginError(msg);
      message.error(msg);
    } finally {
      setSupplierLoginSubmitting(false);
    }
  };

  const handleDeactivateSupplierLogin = async (vendorId) => {
    try {
      await api.delete(`/masters/vendors/${vendorId}/supplier-login`);
      message.success('Supplier login deactivated');
      fetchSupplierLogins();
    } catch (err) {
      message.error(err?.response?.data?.detail || 'Failed to deactivate login');
    }
  };


  const vendorTypeOptions = vendorTypes
    .filter((t) => t.is_active !== false)
    .map((t) => ({ label: t.name, value: t.id, code: t.code }));

  const vendorCategoryOptions = vendorCategories
    .filter((c) => c.is_active !== false)
    .map((c) => ({ label: c.name, value: c.id, code: c.code }));

  const fetchVendors = useCallback(
    async (params) => {
      const queryParams = { ...params };
      if (filterType) queryParams.vendor_type = filterType;
      if (filterCategory) queryParams.vendor_category_id = filterCategory;
      if (filterCity) queryParams.city = filterCity;
      const response = await api.get('/masters/vendors', { params: queryParams });
      const responseData = response.data || {};
      const items = responseData.items || responseData.data || responseData || [];
      if (!Array.isArray(items)) return response;
      const filteredItems = items.filter(isMaterialSupplierVendor);
      return {
        ...response,
        data: {
          ...responseData,
          items: filteredItems,
          data: filteredItems,
          total: filterType ? responseData.total : filteredItems.length,
          count: filterType ? responseData.count : filteredItems.length,
        },
      };
    },
    [filterType, filterCategory, filterCity]
  );

  const handleAdd = () => {
    navigate('/masters/vendors/new');
  };

  const handleEdit = (record) => {
    navigate(`/masters/vendors/${record.id}/edit`);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/masters/vendors/${id}`);
      message.success('Vendor deleted successfully');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleAddVendorType = () => {
    setEditingVendorType(null);
    vendorTypeForm.resetFields();
    vendorTypeForm.setFieldsValue({ status: 'active' });
    setVendorTypeModalOpen(true);
  };

  const handleEditVendorType = (record) => {
    setEditingVendorType(record);
    vendorTypeForm.setFieldsValue({
      ...record,
      status: record.is_active === false ? 'inactive' : 'active',
    });
    setVendorTypeModalOpen(true);
  };

  const handleVendorTypeSubmit = async () => {
    try {
      const values = await vendorTypeForm.validateFields();
      const { status, ...rest } = values;
      const payload = { ...rest, is_active: status ? status !== 'inactive' : true };
      setVendorTypeSubmitting(true);
      if (editingVendorType) {
        await api.put(`/masters/vendor-types/${editingVendorType.id}`, payload);
        message.success('Vendor type updated');
      } else {
        await api.post('/masters/vendor-types', payload);
        message.success('Vendor type created');
      }
      setVendorTypeModalOpen(false);
      setEditingVendorType(null);
      vendorTypeForm.resetFields();
      await fetchVendorTypes();
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setVendorTypeSubmitting(false);
    }
  };

  const handleDeleteVendorType = async (id) => {
    try {
      await api.delete(`/masters/vendor-types/${id}`);
      message.success('Vendor type deactivated');
      await fetchVendorTypes();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleAddVendorCategory = () => {
    setEditingVendorCategory(null);
    vendorCategoryForm.resetFields();
    vendorCategoryForm.setFieldsValue({ status: 'active' });
    setVendorCategoryModalOpen(true);
  };

  const handleEditVendorCategory = (record) => {
    setEditingVendorCategory(record);
    vendorCategoryForm.setFieldsValue({
      ...record,
      status: record.is_active === false ? 'inactive' : 'active',
    });
    setVendorCategoryModalOpen(true);
  };

  const handleVendorCategorySubmit = async () => {
    try {
      const values = await vendorCategoryForm.validateFields();
      const { status, ...rest } = values;
      const payload = { ...rest, is_active: status ? status !== 'inactive' : true };
      setVendorCategorySubmitting(true);
      if (editingVendorCategory) {
        await api.put(`/masters/vendor-categories/${editingVendorCategory.id}`, payload);
        message.success('Vendor category updated');
      } else {
        await api.post('/masters/vendor-categories', payload);
        message.success('Vendor category created');
      }
      setVendorCategoryModalOpen(false);
      setEditingVendorCategory(null);
      vendorCategoryForm.resetFields();
      await fetchVendorCategories();
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setVendorCategorySubmitting(false);
    }
  };

  const handleDeleteVendorCategory = async (id) => {
    try {
      await api.delete(`/masters/vendor-categories/${id}`);
      message.success('Vendor category deactivated');
      await fetchVendorCategories();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };



  const handleExport = async () => {
    try {
      // BUG-FE-174: cap export and warn when truncated.
      const EXPORT_CAP = 5000;
      const hide = message.loading('Preparing export...', 0);
      const res = await api.get('/masters/vendors', { params: { page_size: EXPORT_CAP } });
      hide();
      const data = res.data;
      const items = data.items || data.data || data || [];
      if (data.total && data.total > EXPORT_CAP) {
        message.warning(`Showing first ${EXPORT_CAP} of ${data.total} vendors. Apply filters to narrow the export.`);
      }
      const exportData = items.map((v) => ({
        'Vendor Code': v.vendor_code,
        'Name': v.name,
        'Contact Person': v.contact_person || '',
        'Phone': v.phone || '',
        'Email': v.email || '',
        'City': v.city || '',
        'State': v.state || '',
        'Vendor Type': (v.vendor_types || []).map((t) => t.name).join(', ') || v.vendor_type_name || v.vendor_type || '',
        'Vendor Category': v.vendor_category_name || '',
        'GST Number': v.gst_number || '',
        'Credit Limit': v.credit_limit || 0,
        'Rating': v.rating || 0,
        'Status': v.status,
      }));
      downloadExcel(exportData, 'vendors', 'Vendors');
      message.success('Export completed');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const renderHistoryChange = (record) => {
    const changes = [
      ['Code', record.old_vendor_item_code, record.new_vendor_item_code],
      ['Lead Time', record.old_lead_time_days, record.new_lead_time_days],
      ['Min Qty', record.old_min_order_qty, record.new_min_order_qty],
      ['Rate', record.old_rate, record.new_rate],
      ['Preferred', record.old_is_preferred == null ? null : (record.old_is_preferred ? 'Yes' : 'No'), record.new_is_preferred == null ? null : (record.new_is_preferred ? 'Yes' : 'No')],
    ].filter(([, oldValue, newValue]) => oldValue !== newValue && (oldValue != null || newValue != null));
    if (!changes.length) return '-';
    return (
      <Space direction="vertical" size={2}>
        {changes.map(([label, oldValue, newValue]) => (
          <Typography.Text key={label} style={{ fontSize: 12 }}>
            <strong>{label}:</strong> {oldValue ?? '-'} {'->'} {newValue ?? '-'}
          </Typography.Text>
        ))}
      </Space>
    );
  };

  const columns = [
    {
      title: 'Vendor Code',
      dataIndex: 'vendor_code',
      key: 'vendor_code',
      width: 130,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a onClick={() => navigate(`/masters/vendors/${record.id}`)}>{text}</a>
      ),
    },
    { title: 'Name', dataIndex: 'name', key: 'name', width: 200, sorter: true, ellipsis: true },
    { title: 'Contact Person', dataIndex: 'contact_person', key: 'contact', width: 150, render: (v) => v || '-' },
    { title: 'Phone', dataIndex: 'phone', key: 'phone', width: 130, render: (v) => v || '-' },
    { title: 'Email', dataIndex: 'email', key: 'email', width: 220, ellipsis: true, render: (v) => v ? <Tooltip title={v}><Typography.Text ellipsis style={{ maxWidth: 200 }}>{v}</Typography.Text></Tooltip> : '-' },
    { title: 'City', dataIndex: 'city', key: 'city', width: 120, render: (v) => v || '-' },
    { title: 'State', dataIndex: 'state', key: 'state', width: 130, render: (v) => v || '-' },
    {
      title: 'Type',
      dataIndex: 'vendor_type',
      key: 'vendor_type',
      width: 190,
      render: (v, record) => {
        const types = Array.isArray(record?.vendor_types) ? record.vendor_types : [];
        if (types.length) {
          return (
            <Space size={[4, 4]} wrap style={{ maxWidth: 180 }}>
              {types.map((t) => (
                <Tag
                  key={t.id || t.code || t.name}
                  style={{
                    maxWidth: 170,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    marginInlineEnd: 0,
                  }}
                >
                  {t.name || t.code}
                </Tag>
              ))}
            </Space>
          );
        }
        const label = record?.vendor_type_name || (typeof v === 'string' || typeof v === 'number' ? v : '-');
        if (label === '-') return '-';
        return (
          <Typography.Text ellipsis style={{ maxWidth: 170, display: 'block' }}>
            {label}
          </Typography.Text>
        );
      },
    },
    {
      title: 'Category',
      dataIndex: 'vendor_category_name',
      key: 'vendor_category',
      width: 220,
      render: (v, record) => {
        const label = v || record.vendor_category?.name || '-';
        if (label === '-') return '-';
        return (
          <Typography.Text style={{ maxWidth: 205, display: 'block', whiteSpace: 'normal', wordBreak: 'break-word' }}>
            {label}
          </Typography.Text>
        );
      },
    },
    {
      title: 'Rating',
      dataIndex: 'rating',
      key: 'rating',
      width: 150,
      render: (v) => <Rate disabled allowHalf value={v || 0} style={{ fontSize: 14 }} />,
    },
    {
      title: 'Status',
      key: 'status',
      width: 100,
      // BUG-FE-056: server returns `is_active` (bool); the legacy `status`
      // string isn't on the model. Derive the tag value here so both shapes
      // (back-compat or boolean-only) render correctly.
      render: (_, record) => (
        <StatusTag status={record.is_active === false ? 'inactive' : (record.status || 'active')} />
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 140,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => navigate(`/masters/vendors/${record.id}`)} />
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          {isMaterialSupplierVendor(record) && (
            (record.has_login || supplierLoginVendorIds.has(Number(record.id))) ? (
              <Tooltip title="Manage active portal login">
                <Button
                  type="link"
                  size="small"
                  icon={<UserOutlined style={{ color: '#52c41a' }} />}
                  onClick={async () => {
                    let vendorWithLogin = record;
                    try {
                      const res = await api.get(`/masters/vendors/${record.id}/supplier-login`);
                      vendorWithLogin = {
                        ...record,
                        vendor_id: record.id,
                        login: res.data?.has_login ? res.data : null,
                      };
                    } catch {
                      vendorWithLogin = { ...record, vendor_id: record.id, login: null };
                    }
                    openSupplierLoginModal(vendorWithLogin, 'reset');
                  }}
                />
              </Tooltip>
            ) : (
              <Tooltip title="Create supplier portal login">
                <Button
                  type="link"
                  size="small"
                  icon={<KeyOutlined />}
                  onClick={async () => {
                    let vendorWithLogin = record;
                    try {
                      const res = await api.get(`/masters/vendors/${record.id}/supplier-login`);
                      vendorWithLogin = {
                        ...record,
                        vendor_id: record.id,
                        login: res.data?.has_login ? res.data : null,
                      };
                    } catch {
                      vendorWithLogin = { ...record, vendor_id: record.id, login: null };
                    }
                    openSupplierLoginModal(vendorWithLogin, 'create');
                  }}
                />
              </Tooltip>
            )
          )}
          <Popconfirm
            title="Delete this vendor?"
            onConfirm={() => handleDelete(record.id)}
            okText="Delete"
            okButtonProps={{ danger: true }}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <Select
        placeholder="Vendor Type"
        allowClear
        style={{ width: 150 }}
        value={filterType}
        onChange={(v) => { setFilterType(v); setRefreshKey((k) => k + 1); }}
        options={vendorTypeOptions.map((t) => ({ ...t, value: t.code || t.value }))}
      />
      <Select
        placeholder="Category"
        allowClear
        style={{ width: 150 }}
        value={filterCategory}
        onChange={(v) => { setFilterCategory(v); setRefreshKey((k) => k + 1); }}
        options={vendorCategoryOptions}
      />
    </Space>
  );



  return (
    <div>
      <PageHeader title="Vendors" subtitle="Manage vendor information">
        <Space>
          <Link to="/masters/vendor-material-mapping">
            <Button>
              Material Mapping
            </Button>
          </Link>
          <Button icon={<DownloadOutlined />} onClick={handleExport}>
            Export
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            Add Vendor
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchVendors}
        rowKey="id"
        searchPlaceholder="Search by vendor name or code..."
        exportFileName="vendors"
        toolbar={toolbar}
        scroll={{ x: 2000 }}
      />

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card
            title="Vendor Types"
            extra={<Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleAddVendorType}>Add Type</Button>}
          >
            <Table
              rowKey="id"
              size="small"
              loading={vendorTypeLoading}
              dataSource={vendorTypes}
              pagination={{ pageSize: 5, showSizeChanger: false }}
              columns={[
                { title: 'Code', dataIndex: 'code', width: 110, render: (v) => <code>{v}</code> },
                { title: 'Name', dataIndex: 'name', ellipsis: true },
                { title: 'Status', dataIndex: 'status', width: 90, render: (v) => <StatusTag status={v} /> },
                {
                  title: 'Actions',
                  width: 96,
                  render: (_, record) => (
                    <Space size="small">
                      <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEditVendorType(record)} />
                      <Popconfirm
                        title="Deactivate this vendor type?"
                        onConfirm={() => handleDeleteVendorType(record.id)}
                        okText="Deactivate"
                        okButtonProps={{ danger: true }}
                      >
                        <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            title="Vendor Categories"
            extra={<Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleAddVendorCategory}>Add Category</Button>}
          >
            <Table
              rowKey="id"
              size="small"
              loading={vendorCategoryLoading}
              dataSource={vendorCategories}
              pagination={{ pageSize: 5, showSizeChanger: false }}
              columns={[
                { title: 'Code', dataIndex: 'code', width: 110, render: (v) => <code>{v}</code> },
                { title: 'Name', dataIndex: 'name', ellipsis: true },
                { title: 'Status', dataIndex: 'status', width: 90, render: (v) => <StatusTag status={v} /> },
                {
                  title: 'Actions',
                  width: 96,
                  render: (_, record) => (
                    <Space size="small">
                      <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEditVendorCategory(record)} />
                      <Popconfirm
                        title="Deactivate this vendor category?"
                        onConfirm={() => handleDeleteVendorCategory(record.id)}
                        okText="Deactivate"
                        okButtonProps={{ danger: true }}
                      >
                        <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Modal
        title={editingVendorType ? 'Edit Vendor Type' : 'Add Vendor Type'}
        open={vendorTypeModalOpen}
        onOk={handleVendorTypeSubmit}
        onCancel={() => { setVendorTypeModalOpen(false); setEditingVendorType(null); vendorTypeForm.resetFields(); }}
        confirmLoading={vendorTypeSubmitting}
        okText={editingVendorType ? 'Update' : 'Create'}
        destroyOnHidden
      >
        <Form form={vendorTypeForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="code" label="Code" rules={[{ required: true, message: 'Code is required' }]}>
            <Input placeholder="e.g. raw_material" />
          </Form.Item>
          <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="e.g. Raw Material Supplier" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="status" label="Status" initialValue="active">
            <Select options={[{ label: 'Active', value: 'active' }, { label: 'Inactive', value: 'inactive' }]} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editingVendorCategory ? 'Edit Vendor Category' : 'Add Vendor Category'}
        open={vendorCategoryModalOpen}
        onOk={handleVendorCategorySubmit}
        onCancel={() => { setVendorCategoryModalOpen(false); setEditingVendorCategory(null); vendorCategoryForm.resetFields(); }}
        confirmLoading={vendorCategorySubmitting}
        okText={editingVendorCategory ? 'Update' : 'Create'}
        destroyOnHidden
      >
        <Form form={vendorCategoryForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="code" label="Code" rules={[{ required: true, message: 'Code is required' }]}>
            <Input placeholder="e.g. preferred" />
          </Form.Item>
          <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="e.g. Preferred" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="status" label="Status" initialValue="active">
            <Select options={[{ label: 'Active', value: 'active' }, { label: 'Inactive', value: 'inactive' }]} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={supplierLoginMode === 'create' ? 'Create Supplier Login' : 'Manage Supplier Login'}
        open={supplierLoginModal}
        onCancel={() => {
          setSupplierLoginModal(false);
          setSupplierLoginVendor(null);
          supplierLoginForm.resetFields();
          setSupplierLoginError('');
        }}
        footer={null}
        destroyOnHidden
      >
        <Descriptions size="small" column={1} style={{ marginBottom: 16 }}>
          <Descriptions.Item label="Supplier">
            {supplierLoginVendor?.name || '-'}
          </Descriptions.Item>
          <Descriptions.Item label="Vendor Code">
            {supplierLoginVendor?.vendor_code || '-'}
          </Descriptions.Item>
          <Descriptions.Item label="Vendor Status">
            <Tag color={supplierLoginVendor?.is_active === false ? 'red' : 'success'}>
              {supplierLoginVendor?.is_active === false ? 'Inactive' : 'Active'}
            </Tag>
          </Descriptions.Item>
        </Descriptions>
        {supplierLoginError && (
          <Alert
            type="error"
            showIcon
            message={supplierLoginError}
            style={{ marginBottom: 16 }}
          />
        )}
        <Form
          form={supplierLoginForm}
          layout="vertical"
          onFinish={handleSupplierLoginSubmit}
          initialValues={{ is_active: true }}
        >
          {supplierLoginMode === 'create' && (
            <Form.Item
              name="username"
              label="Username"
              rules={[
                { required: true, message: 'Username is required' },
                { min: 3, message: 'Minimum 3 characters' },
                { pattern: /^[a-zA-Z0-9_.-]+$/, message: 'Use letters, numbers, dot, dash or underscore only' },
              ]}
            >
              <Input prefix={<UserOutlined />} placeholder="supplier.username" />
            </Form.Item>
          )}
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="full_name" label="Contact Name">
                <Input placeholder="Contact person" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="phone" label="Phone">
                <Input placeholder="Phone" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="email" label="Email" rules={[{ required: supplierLoginMode === 'create' }, { type: 'email' }]}>
            <Input placeholder="supplier@example.com" />
          </Form.Item>
          <Form.Item
            name="password"
            label={supplierLoginMode === 'create' ? 'Temporary Password' : 'New Password'}
            rules={[
              { required: supplierLoginMode === 'create', message: 'Password is required' },
              ...(supplierLoginMode === 'create' ? [
                { min: 8, message: 'Minimum 8 characters' },
                { pattern: /[A-Z]/, message: 'Must include uppercase letter' },
                { pattern: /[a-z]/, message: 'Must include lowercase letter' },
                { pattern: /\d/, message: 'Must include a number' },
              ] : [
                {
                  validator: (_, value) => {
                    if (!value) return Promise.resolve();
                    if (value.length < 8) return Promise.reject(new Error('Minimum 8 characters'));
                    if (!/[A-Z]/.test(value)) return Promise.reject(new Error('Must include uppercase letter'));
                    if (!/[a-z]/.test(value)) return Promise.reject(new Error('Must include lowercase letter'));
                    if (!/\d/.test(value)) return Promise.reject(new Error('Must include a number'));
                    return Promise.resolve();
                  }
                }
              ])
            ]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder={supplierLoginMode === 'create' ? 'At least 8 characters' : 'Leave blank to keep current password'} />
          </Form.Item>
          {supplierLoginMode !== 'create' && (
            <Form.Item name="is_active" label="Active" valuePropName="checked">
              <Switch />
            </Form.Item>
          )}
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={() => setSupplierLoginModal(false)}>Cancel</Button>
            <Button type="primary" htmlType="submit" loading={supplierLoginSubmitting} icon={<KeyOutlined />}>
              {supplierLoginMode === 'create' ? 'Create Login' : 'Update Login'}
            </Button>
          </Space>
        </Form>
      </Modal>
    </div>
  );
};

export default Vendors;
