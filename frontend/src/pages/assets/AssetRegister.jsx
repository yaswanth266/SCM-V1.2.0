import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Drawer, Form, Input, Select, InputNumber, Space, Row, Col,
  Popconfirm, message, DatePicker, Descriptions, Timeline, Tabs, Modal, Tag, Spin,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  DownloadOutlined, ToolOutlined, CheckCircleOutlined,
  ClockCircleOutlined, WarningOutlined, AppstoreOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatCard from '../../components/StatCard';
import StatusTag from '../../components/StatusTag';
import BarcodeDisplay from '../../components/BarcodeDisplay';
import api from '../../config/api';
import { formatCurrency, formatDate, formatDateForAPI, getErrorMessage, downloadExcel } from '../../utils/helpers';
import { ASSET_CATEGORIES, BARCODE_TYPES, DATE_FORMAT } from '../../utils/constants';

const ASSET_STATUSES = [
  { label: 'In Use', value: 'in_use' },
  { label: 'Available', value: 'available' },
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

const AssetRegister = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detailModal, setDetailModal] = useState(false);
  const [editingAsset, setEditingAsset] = useState(null);
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [movementHistory, setMovementHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [filterCategory, setFilterCategory] = useState(undefined);
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterCondition, setFilterCondition] = useState(undefined);
  const [refreshKey, setRefreshKey] = useState(0);
  const [categories, setCategories] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [users, setUsers] = useState([]);
  const [stats, setStats] = useState({ total: 0, in_use: 0, available: 0, under_maintenance: 0 });

  useEffect(() => {
    fetchLookups();
    fetchStats();
  }, []);

  const fetchLookups = async () => {
    try {
      const [catRes, vendorRes, warehouseRes, userRes] = await Promise.allSettled([
        api.get('/assets/categories'),
        api.get('/masters/vendors', { params: { page_size: 500, status: 'active' } }),
        api.get('/masters/warehouses', { params: { page_size: 500, status: 'active' } }),
        api.get('/users/lookup', { params: { page_size: 500 } }),
      ]);
      if (catRes.status === 'fulfilled') {
        const d = catRes.value.data;
        setCategories((d.items || d.data || d || []).map((c) => ({ label: c.name, value: c.id })));
      }
      if (vendorRes.status === 'fulfilled') {
        const d = vendorRes.value.data;
        setVendors((d.items || d.data || d || []).map((v) => ({ label: v.name, value: v.id })));
      }
      if (warehouseRes.status === 'fulfilled') {
        const d = warehouseRes.value.data;
        setWarehouses((d.items || d.data || d || []).map((w) => ({ label: w.name, value: w.id })));
      }
      if (userRes.status === 'fulfilled') {
        const d = userRes.value.data;
        setUsers((d.items || d.data || d || []).map((u) => ({ label: u.full_name || u.username, value: u.id })));
      }
    } catch {
      // silent
    }
  };

  const fetchStats = async () => {
    try {
      const res = await api.get('/assets/stats');
      const data = res.data;
      // BUG-HC-129 fix: backend /assets/stats returns `total_assets`,
      // `active`, `in_maintenance`, `disposed` — not `total`/`in_use`/
      // `available`/`under_maintenance`. Map both shapes so the cards
      // populate regardless of which build is on the server.
      setStats({
        total: data.total_assets ?? data.total ?? 0,
        in_use: data.active ?? data.in_use ?? 0,
        available: data.available ?? 0, // backend doesn't separate; remains 0
        under_maintenance: data.in_maintenance ?? data.under_maintenance ?? 0,
      });
    } catch {
      // silent
    }
  };

  const fetchAssets = useCallback(
    async (params) => {
      const queryParams = { ...params };
      // BUG-HC-126 fix: backend /assets accepts `category_id` (int), not
      // `category` (string). Sending `category=Laptop` was silently dropped.
      // Now we forward filterCategory (which is the dropdown's category id)
      // as `category_id`. Condition is not filterable on the backend yet —
      // skip it client-side until BUG-HC-127 lands a real column.
      if (filterCategory) queryParams.category_id = filterCategory;
      if (filterStatus) queryParams.status = filterStatus;
      // condition filter intentionally not forwarded — backend has no field.
      const res = await api.get('/assets', { params: queryParams });
      return res;
    },
    [filterCategory, filterStatus, filterCondition]
  );

  const fetchMovementHistory = async (assetId) => {
    setHistoryLoading(true);
    try {
      const res = await api.get(`/assets/${assetId}/movements`, { params: { page_size: 100 } });
      const data = res.data;
      setMovementHistory(data.items || data.data || data || []);
    } catch {
      setMovementHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleAdd = () => {
    setEditingAsset(null);
    form.resetFields();
    form.setFieldsValue({ status: 'available', condition: 'new', barcode_type: 'CODE128' });
    setDrawerOpen(true);
  };

  const handleEdit = (record) => {
    setEditingAsset(record);
    form.setFieldsValue({
      name: record.name,
      category_id: record.category_id,
      serial_number: record.serial_number,
      status: record.status,
      condition: record.condition_status || record.condition,
      purchase_price: record.purchase_price,
      current_value: record.current_value,
      vendor_id: record.vendor_id,
      current_warehouse_id: record.current_warehouse_id,
      current_location: record.current_location,
      assigned_to: record.assigned_to,
      remarks: record.remarks,
      purchase_date: record.purchase_date ? dayjs(record.purchase_date) : null,
      warranty_expiry: record.warranty_expiry ? dayjs(record.warranty_expiry) : null,
    });
    setDrawerOpen(true);
  };

  const handleView = (record) => {
    setSelectedAsset(record);
    setDetailModal(true);
    fetchMovementHistory(record.id);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/assets/${id}`);
      message.success('Asset deleted successfully');
      setRefreshKey((k) => k + 1);
      fetchStats();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload = {
        name: values.name,
        category_id: values.category_id || null,
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
        // update-only fields
        status: values.status || null,
        condition_status: values.condition || values.condition_status || null,
      };
      if (editingAsset) {
        await api.put(`/assets/${editingAsset.id}`, payload);
        message.success('Asset updated successfully');
      } else {
        await api.post('/assets', payload);
        message.success('Asset created successfully');
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingAsset(null);
      setRefreshKey((k) => k + 1);
      fetchStats();
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleExport = async () => {
    try {
      const res = await api.get('/assets', { params: { page_size: 10000 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      const exportData = items.map((a) => ({
        'Asset Code': a.asset_code,
        'Name': a.name,
        'Category': a.category_name || ASSET_CATEGORIES.find((c) => c.value === a.category_id)?.label || '',
        'Serial Number': a.serial_number || '',
        'Purchase Date': formatDate(a.purchase_date),
        'Purchase Price': a.purchase_price || 0,
        'Current Value': a.current_value || 0,
        'Location': a.current_location || '',
        'Assigned To': a.assigned_to_name || '',
        'Status': a.status,
        'Condition': a.condition_status || a.condition,
      }));
      downloadExcel(exportData, 'assets', 'Assets');
      message.success('Export completed');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const getMovementColor = (type) => {
    const map = { transfer: 'blue', assign: 'green', return: 'orange', maintenance: 'purple', dispose: 'red' };
    return map[type] || 'gray';
  };

  const columns = [
    {
      title: 'Asset Code',
      dataIndex: 'asset_code',
      key: 'asset_code',
      width: 140,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => handleView(record)}>{text}</a>,
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      width: 200,
      sorter: true,
      ellipsis: true,
    },
    {
      // Bug fix BUG_0014: backend returns category_name, not category
      title: 'Category',
      dataIndex: 'category_name',
      key: 'category',
      width: 140,
      render: (val, record) => {
        const name = val || record.category_name;
        if (name) return name;
        const found = ASSET_CATEGORIES.find((c) => c.value === record.category_id);
        return found ? found.label : '-';
      },
    },
    {
      title: 'Serial Number',
      dataIndex: 'serial_number',
      key: 'serial_number',
      width: 150,
      render: (val) => val || '-',
    },
    {
      title: 'Purchase Date',
      dataIndex: 'purchase_date',
      key: 'purchase_date',
      width: 120,
      render: (val) => formatDate(val),
      sorter: true,
    },
    {
      title: 'Purchase Price',
      dataIndex: 'purchase_price',
      key: 'purchase_price',
      width: 130,
      align: 'right',
      render: (val) => formatCurrency(val),
      sorter: true,
    },
    {
      title: 'Current Value',
      dataIndex: 'current_value',
      key: 'current_value',
      width: 130,
      align: 'right',
      render: (val) => formatCurrency(val),
    },
    {
      title: 'Location',
      dataIndex: 'current_location',
      key: 'current_location',
      width: 150,
      render: (val) => val || '-',
    },
    {
      title: 'Assigned To',
      dataIndex: 'assigned_to_name',
      key: 'assigned_to',
      width: 150,
      render: (text, record) => text || record.assigned_to_name || '-',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (status) => <StatusTag status={status} />,
    },
    {
      // Bug fix BUG_0014: backend returns condition_status, not condition
      title: 'Condition',
      dataIndex: 'condition_status',
      key: 'condition',
      width: 100,
      render: (val) => {
        const colorMap = { new: 'green', good: 'blue', fair: 'orange', poor: 'red', damaged: 'red' };
        return <Tag color={colorMap[val] || 'default'}>{val ? val.charAt(0).toUpperCase() + val.slice(1) : '-'}</Tag>;
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 140,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(record)} />
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          <Popconfirm
            title="Delete this asset?"
            description="This action cannot be undone."
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
        placeholder="Category"
        allowClear
        style={{ width: 160 }}
        value={filterCategory}
        onChange={(v) => { setFilterCategory(v); setRefreshKey((k) => k + 1); }}
        options={ASSET_CATEGORIES}
      />
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 150 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={ASSET_STATUSES}
      />
      <Select
        placeholder="Condition"
        allowClear
        style={{ width: 130 }}
        value={filterCondition}
        onChange={(v) => { setFilterCondition(v); setRefreshKey((k) => k + 1); }}
        options={CONDITION_OPTIONS}
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="Asset Register" subtitle="Manage organization assets">
        <Space>
          <Button icon={<DownloadOutlined />} onClick={handleExport}>Export</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Add Asset</Button>
        </Space>
      </PageHeader>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={12} lg={6}>
          <StatCard
            icon={<AppstoreOutlined />}
            iconColor="#eb2f96"
            iconBg="#e6f7ff"
            value={stats.total}
            label="Total Assets"
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard
            icon={<CheckCircleOutlined />}
            iconColor="#52c41a"
            iconBg="#f6ffed"
            value={stats.in_use}
            label="In Use"
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard
            icon={<ClockCircleOutlined />}
            iconColor="#fa8c16"
            iconBg="#fff7e6"
            value={stats.available}
            label="Available"
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard
            icon={<ToolOutlined />}
            iconColor="#722ed1"
            iconBg="#f9f0ff"
            value={stats.under_maintenance}
            label="Under Maintenance"
          />
        </Col>
      </Row>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchAssets}
        rowKey="id"
        searchPlaceholder="Search by asset code or name..."
        exportFileName="assets"
        toolbar={toolbar}
        scroll={{ x: 1800 }}
      />

      {/* Add/Edit Drawer */}
      <Drawer
        title={editingAsset ? 'Edit Asset' : 'Add Asset'}
        width={720}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setEditingAsset(null); form.resetFields(); }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); setEditingAsset(null); form.resetFields(); }}>Cancel</Button>
            <Button type="primary" onClick={handleSubmit} loading={submitting}>
              {editingAsset ? 'Update' : 'Create'}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Tabs
            defaultActiveKey="basic"
            items={[
              {
                key: 'basic',
                label: 'Basic Info',
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="asset_code" label="Asset Code" rules={[{ required: true, message: 'Asset code is required' }]}>
                          <Input placeholder="e.g. AST-001" />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="name" label="Asset Name" rules={[{ required: true, message: 'Name is required' }]}>
                          <Input placeholder="Enter asset name" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item name="description" label="Description">
                      <Input.TextArea rows={3} placeholder="Asset description" />
                    </Form.Item>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="category_id" label="Category" rules={[{ required: true, message: 'Select category' }]}>
                          <Select placeholder="Select category" options={categories} showSearch optionFilterProp="label" />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="serial_number" label="Serial Number">
                          <Input placeholder="Enter serial number" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="status" label="Status" rules={[{ required: true }]}>
                          <Select options={ASSET_STATUSES} />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="condition" label="Condition" rules={[{ required: true }]}>
                          <Select options={CONDITION_OPTIONS} />
                        </Form.Item>
                      </Col>
                    </Row>
                  </>
                ),
              },
              {
                key: 'purchase',
                label: 'Purchase & Value',
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="purchase_date" label="Purchase Date">
                          <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="purchase_price" label="Purchase Price">
                          <InputNumber min={0} step={0.01} style={{ width: '100%' }} placeholder="0.00" prefix="INR" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="current_value" label="Current Value">
                          <InputNumber min={0} step={0.01} style={{ width: '100%' }} placeholder="0.00" prefix="INR" />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="depreciation_rate" label="Depreciation Rate (%)">
                          <InputNumber min={0} max={100} step={0.01} style={{ width: '100%' }} placeholder="0.00" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="vendor_id" label="Vendor">
                          <Select placeholder="Select vendor" options={vendors} showSearch optionFilterProp="label" allowClear />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="invoice_number" label="Invoice Number">
                          <Input placeholder="Invoice reference" />
                        </Form.Item>
                      </Col>
                    </Row>
                  </>
                ),
              },
              {
                key: 'warranty',
                label: 'Warranty',
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="warranty_expiry" label="Warranty Expiry">
                          <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="warranty_provider" label="Warranty Provider">
                          <Input placeholder="Provider name" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item name="warranty_terms" label="Warranty Terms">
                      <Input.TextArea rows={4} placeholder="Warranty terms and conditions" />
                    </Form.Item>
                  </>
                ),
              },
              {
                key: 'location',
                label: 'Location & Assignment',
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="current_warehouse_id" label="Warehouse">
                          <Select placeholder="Select warehouse" options={warehouses} showSearch optionFilterProp="label" allowClear />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="assigned_to" label="Assigned To">
                          <Select placeholder="Select user" options={users} showSearch optionFilterProp="label" allowClear />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="current_location" label="Location (Text)">
                          <Input placeholder="e.g. Building A, Floor 2, Room 101" />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="department" label="Department">
                          <Input placeholder="Department name" />
                        </Form.Item>
                      </Col>
                    </Row>
                  </>
                ),
              },
              {
                key: 'barcode',
                label: 'Barcode',
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="barcode_type" label="Barcode Type">
                          <Select placeholder="Select barcode type" options={BARCODE_TYPES} />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="barcode_value" label="Barcode Value">
                          <Input placeholder="Leave blank to auto-generate" />
                        </Form.Item>
                      </Col>
                    </Row>
                    {editingAsset && editingAsset.barcode_value && (
                      <div style={{ textAlign: 'center', marginTop: 16 }}>
                        <BarcodeDisplay
                          value={editingAsset.barcode_value || editingAsset.asset_code}
                          type={editingAsset.barcode_type || 'CODE128'}
                          label={editingAsset.name}
                          subtitle={editingAsset.asset_code}
                        />
                      </div>
                    )}
                  </>
                ),
              },
            ]}
          />
        </Form>
      </Drawer>

      {/* Detail Modal */}
      <Modal
        title="Asset Details"
        open={detailModal}
        onCancel={() => { setDetailModal(false); setSelectedAsset(null); setMovementHistory([]); }}
        width={800}
        footer={[
          <Button key="close" onClick={() => { setDetailModal(false); setSelectedAsset(null); }}>Close</Button>,
          <Button key="edit" type="primary" icon={<EditOutlined />} onClick={() => { setDetailModal(false); handleEdit(selectedAsset); }}>Edit</Button>,
        ]}
      >
        {selectedAsset && (
          <Tabs
            defaultActiveKey="info"
            items={[
              {
                key: 'info',
                label: 'Asset Info',
                children: (
                  <>
                    <Descriptions bordered size="small" column={2}>
                      <Descriptions.Item label="Asset Code">{selectedAsset.asset_code}</Descriptions.Item>
                      <Descriptions.Item label="Name">{selectedAsset.name}</Descriptions.Item>
                      <Descriptions.Item label="Category">
                        {ASSET_CATEGORIES.find((c) => c.value === selectedAsset.category)?.label || selectedAsset.category}
                      </Descriptions.Item>
                      <Descriptions.Item label="Serial Number">{selectedAsset.serial_number || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Status"><StatusTag status={selectedAsset.status} /></Descriptions.Item>
                      <Descriptions.Item label="Condition">
                        {/* BUG-HC-127 fix: backend serialises this column as
                            condition_status — the previous read of
                            selectedAsset.condition always rendered "-". Fall
                            back to legacy `condition` for older API builds. */}
                        <Tag>{selectedAsset.condition_status || selectedAsset.condition || '-'}</Tag>
                      </Descriptions.Item>
                      <Descriptions.Item label="Purchase Date">{formatDate(selectedAsset.purchase_date)}</Descriptions.Item>
                      <Descriptions.Item label="Purchase Price">{formatCurrency(selectedAsset.purchase_price)}</Descriptions.Item>
                      <Descriptions.Item label="Current Value">{formatCurrency(selectedAsset.current_value)}</Descriptions.Item>
                      <Descriptions.Item label="Location">{selectedAsset.current_location || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Assigned To">{selectedAsset.assigned_to_name || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Department">{selectedAsset.department || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Vendor">{selectedAsset.vendor_name || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Warranty Expiry">{formatDate(selectedAsset.warranty_expiry)}</Descriptions.Item>
                    </Descriptions>
                    <div style={{ textAlign: 'center', marginTop: 24 }}>
                      <BarcodeDisplay
                        value={selectedAsset.barcode_value || selectedAsset.asset_code}
                        type={selectedAsset.barcode_type || 'CODE128'}
                        label={selectedAsset.name}
                        subtitle={selectedAsset.asset_code}
                      />
                    </div>
                  </>
                ),
              },
              {
                key: 'history',
                label: 'Movement History',
                children: (
                  <Spin spinning={historyLoading}>
                    {movementHistory.length === 0 ? (
                      <div style={{ textAlign: 'center', color: '#999', padding: 40 }}>No movement history found</div>
                    ) : (
                      <Timeline
                        items={movementHistory.map((m) => ({
                          color: getMovementColor(m.movement_type),
                          children: (
                            <div>
                              <div style={{ fontWeight: 600 }}>
                                {m.movement_type ? m.movement_type.charAt(0).toUpperCase() + m.movement_type.slice(1) : 'Unknown'}
                              </div>
                              <div style={{ fontSize: 12, color: '#666' }}>
                                {m.from_location && <span>From: {m.from_location} </span>}
                                {m.to_location && <span>To: {m.to_location} </span>}
                              </div>
                              {m.from_user_name && <div style={{ fontSize: 12, color: '#666' }}>From User: {m.from_user_name}</div>}
                              {m.to_user_name && <div style={{ fontSize: 12, color: '#666' }}>To User: {m.to_user_name}</div>}
                              {m.reason && <div style={{ fontSize: 12, color: '#888' }}>Reason: {m.reason}</div>}
                              <div style={{ fontSize: 11, color: '#999' }}>{formatDate(m.movement_date || m.created_at)}</div>
                            </div>
                          ),
                        }))}
                      />
                    )}
                  </Spin>
                ),
              },
            ]}
          />
        )}
      </Modal>
    </div>
  );
};

export default AssetRegister;

