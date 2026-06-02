import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Switch, Space, Tabs,
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingVendor, setEditingVendor] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [formErrors, setFormErrors] = useState([]);

  const hasTabErrors = (tabKey) => {
    const tabFields = {
      basic: ['vendor_code', 'name', 'contact_person', 'email', 'phone', 'alt_phone', 'status'],
      address: ['address_line1', 'address_line2', 'city', 'state', 'pincode', 'country'],
      tax_bank: ['gst_number', 'pan_number', 'bank_name', 'bank_account', 'bank_ifsc'],
      terms: ['payment_terms_days', 'credit_limit', 'vendor_type_ids', 'vendor_category_id', 'is_transport_vendor']
    };
    const fieldsWithError = formErrors
      .filter(f => f.errors && f.errors.length > 0)
      .map(f => Array.isArray(f.name) ? f.name[0] : f.name);
    
    return fieldsWithError.some(fieldName => tabFields[tabKey]?.includes(fieldName));
  };
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

  // Detail view state
  const [detailVendor, setDetailVendor] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState('info');
  const [vendorItems, setVendorItems] = useState([]);
  const [vendorItemHistory, setVendorItemHistory] = useState([]);
  const [vendorContracts, setVendorContracts] = useState([]);
  const [vendorRatings, setVendorRatings] = useState([]);
  const [vendorPOs, setVendorPOs] = useState([]);
  const [detailDataLoading, setDetailDataLoading] = useState(false);

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
    setEditingVendor(null);
    form.resetFields();
    setFormErrors([]);
    form.setFieldsValue({ vendor_code: '', status: 'active', is_transport_vendor: false, country: 'India', vendor_type_ids: [], vendor_category_id: undefined });
    setDrawerOpen(true);
  };

  const handleEdit = (record) => {
    setEditingVendor(record);
    setFormErrors([]);
    form.setFieldsValue({
      ...record,
      vendor_type_ids: record.vendor_type_ids || [],
      vendor_type_id: record.vendor_type_id || undefined,
      vendor_category_id: record.vendor_category_id || undefined,
    });
    setDrawerOpen(true);
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

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const { status, ...rest } = values;
      const vendorTypeIds = rest.vendor_type_ids || [];
      const selectedPrimary = vendorTypeIds[0] || rest.vendor_type_id;
      const selectedType = vendorTypes.find((t) => t.id === selectedPrimary);
      const cleanText = (value) => {
        if (typeof value !== 'string') return value ?? null;
        const trimmed = value.trim();
        return trimmed ? trimmed : null;
      };
      const payload = {
        vendor_code: cleanText(rest.vendor_code),
        name: cleanText(rest.name),
        payment_terms_days: rest.payment_terms_days ?? null,
        credit_limit: rest.credit_limit ?? null,
        drug_license_expiry: rest.drug_license_expiry ?? null,
        vendor_type_id: selectedPrimary,
        vendor_type_ids: vendorTypeIds,
        vendor_type: legacyVendorType(selectedType || rest.vendor_type),
        vendor_category_id: rest.vendor_category_id || null,
        is_active: status ? status !== 'inactive' : rest.is_active,
        is_transport_vendor: !!rest.is_transport_vendor,
      };
      VENDOR_TEXT_FIELDS.forEach((field) => {
        payload[field] = cleanText(rest[field]);
      });
      setSubmitting(true);
      if (editingVendor) {
        await api.put(`/masters/vendors/${editingVendor.id}`, payload);
        message.success('Vendor updated successfully');
      } else {
        await api.post('/masters/vendors', payload);
        message.success('Vendor created successfully');
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingVendor(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) {
        handleFormValidationFailed(err);
        return;
      }
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
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

  const handleViewVendor = async (record) => {
    setDetailLoading(true);
    setDetailVendor(null);
    setDetailTab('info');
    try {
      const res = await api.get(`/masters/vendors/${record.id}`);
      setDetailVendor(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    if (detailVendor) {
      fetchDetailData(detailTab);
    }
  }, [detailTab, detailVendor]);

  const fetchDetailData = async (tab) => {
    if (!detailVendor) return;
    setDetailDataLoading(true);
    try {
      if (tab === 'items') {
        const res = await api.get(`/masters/vendors/${detailVendor.id}/items`, { params: { page_size: 200 } });
        setVendorItems((res.data.items || res.data.data || res.data || []));
      } else if (tab === 'item_history') {
        const res = await api.get(`/masters/vendors/${detailVendor.id}/items/history`, { params: { page_size: 200 } });
        setVendorItemHistory((res.data.items || res.data.data || res.data || []));
      } else if (tab === 'contracts') {
        const res = await api.get(`/masters/vendors/${detailVendor.id}/contracts`, { params: { page_size: 100 } });
        setVendorContracts((res.data.items || res.data.data || res.data || []));
      } else if (tab === 'ratings') {
        const res = await api.get(`/masters/vendors/${detailVendor.id}/ratings`, { params: { page_size: 100 } });
        setVendorRatings((res.data.items || res.data.data || res.data || []));
      } else if (tab === 'po_history') {
        const res = await api.get(`/masters/vendors/${detailVendor.id}/purchase-orders`, { params: { page_size: 100 } });
        setVendorPOs((res.data.items || res.data.data || res.data || []));
      }
    } catch {
      // silent
    } finally {
      setDetailDataLoading(false);
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
        <a onClick={() => handleViewVendor(record)}>{text}</a>
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
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleViewVendor(record)} />
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

  // Vendor detail view
  if (detailVendor) {
    return (
      <div>
        <PageHeader title={`${detailVendor.vendor_code} - ${detailVendor.name}`} subtitle="Vendor Detail">
          <Button icon={<ArrowLeftOutlined />} onClick={() => setDetailVendor(null)}>
            Back to List
          </Button>
        </PageHeader>
        <Card>
          <Tabs
            activeKey={detailTab}
            onChange={setDetailTab}
            items={[
              {
                key: 'info',
                label: 'Info',
                children: (
                  <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
                    <Descriptions.Item label="Vendor Code">{detailVendor.vendor_code}</Descriptions.Item>
                    <Descriptions.Item label="Name">{detailVendor.name}</Descriptions.Item>
                    <Descriptions.Item label="Contact Person">{detailVendor.contact_person || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Email">{detailVendor.email || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Phone">{detailVendor.phone || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Alt Phone">{detailVendor.alt_phone || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Address" span={2}>{[detailVendor.address_line1, detailVendor.address_line2].filter(Boolean).join(', ') || '-'}</Descriptions.Item>
                    <Descriptions.Item label="City">{detailVendor.city || '-'}</Descriptions.Item>
                    <Descriptions.Item label="State">{detailVendor.state || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Pincode">{detailVendor.pincode || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Country">{detailVendor.country || 'India'}</Descriptions.Item>
                    <Descriptions.Item label="GST Number">{detailVendor.gst_number || '-'}</Descriptions.Item>
                    <Descriptions.Item label="PAN">{detailVendor.pan_number || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Bank">{detailVendor.bank_name || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Account No">{detailVendor.bank_account || '-'}</Descriptions.Item>
                    <Descriptions.Item label="IFSC">{detailVendor.bank_ifsc || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Vendor Type">
                      {(detailVendor.vendor_types || []).length
                        ? <Space size={4} wrap>{detailVendor.vendor_types.map((t) => <Tag key={t.id}>{t.name}</Tag>)}</Space>
                        : detailVendor.vendor_type_name || detailVendor.vendor_type || '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="Vendor Category">{detailVendor.vendor_category_name || detailVendor.vendor_category?.name || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Transport Vendor">{detailVendor.is_transport_vendor ? 'Yes' : 'No'}</Descriptions.Item>
                    <Descriptions.Item label="Payment Terms">{detailVendor.payment_terms_days ? `${detailVendor.payment_terms_days} days` : '-'}</Descriptions.Item>
                    <Descriptions.Item label="Credit Limit">{formatCurrency(detailVendor.credit_limit)}</Descriptions.Item>
                    <Descriptions.Item label="Rating"><Rate disabled allowHalf value={detailVendor.rating || 0} /></Descriptions.Item>
                    <Descriptions.Item label="Status"><StatusTag status={detailVendor.status} /></Descriptions.Item>
                  </Descriptions>
                ),
              },
              {
                key: 'items',
                label: 'Items Supplied',
                children: (
                  <Table
                    dataSource={vendorItems}
                    loading={detailDataLoading}
                    rowKey={(r) => r.id || r.item_id}
                    size="small"
                    pagination={{ pageSize: 20, showSizeChanger: true }}
                    scroll={{ x: 'max-content' }}
                    columns={[
                      { title: 'Item Code', dataIndex: ['item', 'item_code'], key: 'code', render: (t, r) => t || r.item_code || '-' },
                      { title: 'Item Name', dataIndex: ['item', 'name'], key: 'name', render: (t, r) => t || r.item_name || '-' },
                      { title: 'Lead Time', dataIndex: 'lead_time_days', key: 'lt', align: 'right', render: (v) => v ? `${v} days` : '-' },
                      { title: 'Last Price', dataIndex: 'last_price', key: 'lp', align: 'right', render: (v) => formatCurrency(v) },
                      { title: 'Preferred', dataIndex: 'is_preferred', key: 'pref', render: (v) => v ? <Tag color="green">Yes</Tag> : <Tag>No</Tag> },
                    ]}
                  />
                ),
              },
              {
                key: 'item_history',
                label: 'Mapping History',
                children: (
                  <Table
                    dataSource={vendorItemHistory}
                    loading={detailDataLoading}
                    rowKey="id"
                    size="small"
                    pagination={{ pageSize: 20, showSizeChanger: true }}
                    scroll={{ x: 'max-content' }}
                    columns={[
                      { title: 'Date', dataIndex: 'changed_at', key: 'date', width: 160, render: (v) => formatDate(v) },
                      { title: 'Action', dataIndex: 'action', key: 'action', width: 100, render: (v) => <Tag color={v === 'delete' ? 'red' : v === 'update' ? 'blue' : 'green'}>{String(v || '').toUpperCase()}</Tag> },
                      { title: 'Item Code', dataIndex: 'item_code', key: 'code', width: 130, render: (v) => v || '-' },
                      { title: 'Item Name', dataIndex: 'item_name', key: 'name', width: 220, ellipsis: true, render: (v) => v || '-' },
                      { title: 'Changes', key: 'changes', render: (_, record) => renderHistoryChange(record) },
                      { title: 'Changed By', dataIndex: 'changed_by_name', key: 'by', width: 150, render: (v) => v || '-' },
                    ]}
                  />
                ),
              },
              {
                key: 'contracts',
                label: 'Contracts',
                children: (
                  <Table
                    dataSource={vendorContracts}
                    loading={detailDataLoading}
                    rowKey="id"
                    size="small"
                    pagination={{ pageSize: 20, showSizeChanger: true }}
                    scroll={{ x: 'max-content' }}
                    columns={[
                      { title: 'Contract No', dataIndex: 'contract_number', key: 'no' },
                      { title: 'Description', dataIndex: 'description', key: 'desc', ellipsis: true },
                      { title: 'Start Date', dataIndex: 'start_date', key: 'start', render: (v) => formatDate(v) },
                      { title: 'End Date', dataIndex: 'end_date', key: 'end', render: (v) => formatDate(v) },
                      { title: 'Value', dataIndex: 'contract_value', key: 'val', align: 'right', render: (v) => formatCurrency(v) },
                      { title: 'Status', dataIndex: 'status', key: 'status', render: (s) => <StatusTag status={s} /> },
                    ]}
                  />
                ),
              },
              {
                key: 'ratings',
                label: 'Ratings',
                children: (
                  <Table
                    dataSource={vendorRatings}
                    loading={detailDataLoading}
                    rowKey="id"
                    size="small"
                    pagination={{ pageSize: 20, showSizeChanger: true }}
                    scroll={{ x: 'max-content' }}
                    columns={[
                      { title: 'Date', dataIndex: 'rating_date', key: 'date', render: (v) => formatDate(v) },
                      { title: 'Criteria', dataIndex: 'criteria', key: 'criteria' },
                      { title: 'Score', dataIndex: 'score', key: 'score', render: (v) => <Rate disabled allowHalf value={v || 0} style={{ fontSize: 14 }} /> },
                      { title: 'Remarks', dataIndex: 'remarks', key: 'remarks', ellipsis: true },
                      { title: 'Rated By', dataIndex: 'rated_by_name', key: 'by', render: (t, r) => t || r.rated_by || '-' },
                    ]}
                  />
                ),
              },
              {
                key: 'po_history',
                label: 'PO History',
                children: (
                  <Table
                    dataSource={vendorPOs}
                    loading={detailDataLoading}
                    rowKey="id"
                    size="small"
                    pagination={{ pageSize: 20, showSizeChanger: true }}
                    scroll={{ x: 'max-content' }}
                    columns={[
                      { title: 'PO Number', dataIndex: 'po_number', key: 'po' },
                      { title: 'Date', dataIndex: 'po_date', key: 'date', render: (v) => formatDate(v) },
                      { title: 'Total Amount', dataIndex: 'total_amount', key: 'amt', align: 'right', render: (v) => formatCurrency(v) },
                      { title: 'Items', dataIndex: 'item_count', key: 'items', align: 'right' },
                      { title: 'Status', dataIndex: 'status', key: 'status', render: (s) => <StatusTag status={s} /> },
                      { title: 'Delivery Date', dataIndex: 'expected_delivery_date', key: 'del', render: (v) => formatDate(v) },
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

      <Drawer
        title={editingVendor ? 'Edit Vendor' : 'Add Vendor'}
        width={720}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setEditingVendor(null); form.resetFields(); setFormErrors([]); }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); setEditingVendor(null); form.resetFields(); setFormErrors([]); }}>
              Cancel
            </Button>
            <Button type="primary" onClick={handleSubmit} loading={submitting}>
              {editingVendor ? 'Update' : 'Create'}
            </Button>
          </Space>
        }
      >
        <Form 
          form={form} 
          layout="vertical" 
          scrollToFirstError={true}
          onFieldsChange={() => {
            setFormErrors(form.getFieldsError());
          }}
        >
          <Tabs
            defaultActiveKey="basic"
            items={[
              {
                key: 'basic',
                label: (
                  <Space>
                    <span>Basic</span>
                    {hasTabErrors('basic') && (
                      <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 13 }} />
                    )}
                  </Space>
                ),
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item 
                          name="vendor_code" 
                          label="Vendor Code" 
                          rules={[
                            { required: true, message: 'Vendor Code is required' },
                            { pattern: /^[A-Za-z0-9-_]+$/, message: 'Vendor Code must be alphanumeric without spaces' }
                          ]}
                        >
                          <Input placeholder="e.g. VND-001" style={{ textTransform: 'uppercase' }} onChange={(e) => form.setFieldsValue({ vendor_code: e.target.value.toUpperCase() })} />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item 
                          name="name" 
                          label="Vendor Name" 
                          rules={[
                            { required: true, message: 'Vendor Name is required' },
                            { min: 3, message: 'Name must be at least 3 characters' },
                            { max: 100, message: 'Name must not exceed 100 characters' }
                          ]}
                        >
                          <Input placeholder="Enter vendor name" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="contact_person" label="Contact Person">
                          <Input placeholder="Contact person name" />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="email" label="Email" rules={[{ type: 'email', message: 'Please enter a valid email address (e.g. info@vendor.com)' }]}>
                          <Input placeholder="email@example.com" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="phone" label="Phone" rules={[{ pattern: /^[0-9+\-\s()]{6,20}$/, message: 'Please enter a valid phone number (6-20 digits)' }]}>
                          <Input placeholder="Phone number" />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="alt_phone" label="Alt Phone" rules={[{ pattern: /^[0-9+\-\s()]{6,20}$/, message: 'Please enter a valid alternate phone number' }]}>
                          <Input placeholder="Alternate phone" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item name="status" label="Status" initialValue="active">
                      <Select
                        options={[
                          { label: 'Active', value: 'active' },
                          { label: 'Inactive', value: 'inactive' },
                        ]}
                      />
                    </Form.Item>
                  </>
                ),
              },
              {
                key: 'address',
                label: (
                  <Space>
                    <span>Address</span>
                    {hasTabErrors('address') && (
                      <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 13 }} />
                    )}
                  </Space>
                ),
                children: (
                  <>
                    <Form.Item name="address_line1" label="Address Line 1">
                      <Input placeholder="Street address" />
                    </Form.Item>
                    <Form.Item name="address_line2" label="Address Line 2">
                      <Input placeholder="Apartment, suite, etc." />
                    </Form.Item>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item name="city" label="City">
                          <Input placeholder="City" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="state" label="State">
                          <Select placeholder="Select state" allowClear showSearch options={STATES.map((s) => ({ label: s, value: s }))} />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="pincode" label="Pincode" rules={[{ pattern: /^[0-9]{5,10}$/, message: 'Pincode must be between 5 and 10 digits' }]}>
                          <Input placeholder="Pincode" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item name="country" label="Country" initialValue="India">
                      <Input placeholder="Country" />
                    </Form.Item>
                  </>
                ),
              },
              {
                key: 'tax_bank',
                label: (
                  <Space>
                    <span>Tax & Bank</span>
                    {hasTabErrors('tax_bank') && (
                      <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 13 }} />
                    )}
                  </Space>
                ),
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item 
                          name="gst_number" 
                          label="GST Number" 
                          rules={[{ pattern: /^[0-9]{2}[A-Z0-9]{10}[A-Z0-9]{3}$/, message: 'Enter a valid 15-character GSTIN (e.g. 29ABCDE1234F1Z5)' }]}
                        >
                          <Input placeholder="GSTIN" style={{ textTransform: 'uppercase' }} onChange={(e) => form.setFieldsValue({ gst_number: e.target.value.toUpperCase() })} />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item 
                          name="pan_number" 
                          label="PAN Number"
                          rules={[{ pattern: /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, message: 'Enter a valid 10-character PAN number (e.g. ABCDE1234F)' }]}
                        >
                          <Input placeholder="PAN" style={{ textTransform: 'uppercase' }} onChange={(e) => form.setFieldsValue({ pan_number: e.target.value.toUpperCase() })} />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item name="bank_name" label="Bank Name">
                          <Input placeholder="Bank name" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item 
                          name="bank_account" 
                          label="Bank Account No"
                          rules={[{ pattern: /^[0-9]{9,18}$/, message: 'Bank Account Number must be between 9 and 18 numeric digits' }]}
                        >
                          <Input placeholder="Account number" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item 
                          name="bank_ifsc" 
                          label="Bank IFSC"
                          rules={[{ pattern: /^[A-Z]{4}0[A-Z0-9]{6}$/, message: 'Enter a valid 11-character IFSC code (e.g. HDFC0000123)' }]}
                        >
                          <Input placeholder="IFSC code" style={{ textTransform: 'uppercase' }} onChange={(e) => form.setFieldsValue({ bank_ifsc: e.target.value.toUpperCase() })} />
                        </Form.Item>
                      </Col>
                    </Row>
                  </>
                ),
              },
              {
                key: 'terms',
                label: (
                  <Space>
                    <span>Terms</span>
                    {hasTabErrors('terms') && (
                      <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 13 }} />
                    )}
                  </Space>
                ),
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="payment_terms_days" label="Payment Terms (days)">
                          <InputNumber
                            min={0}
                            max={365}
                            step={1}
                            style={{ width: '100%' }}
                            placeholder="Net 30 / Net 45 / Net 60 …"
                          />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="credit_limit" label="Credit Limit">
                          <InputNumber min={0} step={100} style={{ width: '100%' }} placeholder="0.00" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="vendor_type_ids" label="Vendor Types">
                          <Select
                            mode="multiple"
                            placeholder="Select vendor types"
                            options={vendorTypeOptions}
                            allowClear
                            showSearch
                            optionFilterProp="label"
                            maxTagCount="responsive"
                          />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="vendor_category_id" label="Vendor Category">
                          <Select
                            placeholder="Select vendor category"
                            options={vendorCategoryOptions}
                            allowClear
                            showSearch
                            optionFilterProp="label"
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="is_transport_vendor" label="Transport Vendor" valuePropName="checked">
                          <Switch />
                        </Form.Item>
                      </Col>
                    </Row>
                  </>
                ),
              },
            ]}
          />
        </Form>
      </Drawer>

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
