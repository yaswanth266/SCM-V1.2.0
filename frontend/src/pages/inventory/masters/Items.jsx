import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Space, Popconfirm, message, Select, Modal,
} from 'antd';
import {
  PlusOutlined, EditOutlined, EyeOutlined,
  DownloadOutlined, CheckCircleOutlined, StopOutlined,
  CloudUploadOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import PageHeader from '../../../components/PageHeader';
import DataTable from '../../../components/DataTable';
import StatusTag from '../../../components/StatusTag';
import api from '../../../config/api';
import { formatCurrency, getErrorMessage, downloadExcel } from '../../../utils/helpers';
import BulkUploadModal from '../../../components/BulkUploadModal';

const Items = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialSearch = searchParams.get('search') || '';
  const [uploadModalOpen, setUploadModalOpen] = useState(false);

  const [deactivateError, setDeactivateError] = useState(null);
  const [allCategoryOptions, setAllCategoryOptions] = useState([]);
  const [itemTypeOptions, setItemTypeOptions] = useState([]);
  const [filterCategory, setFilterCategory] = useState(undefined);
  const [filterType, setFilterType] = useState(undefined);
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchCategories = async () => {
    try {
      const res = await api.get('/masters/categories', { params: { page_size: 500 } });
      const data = res.data;
      const items = data.items || data.data || (Array.isArray(data) ? data : []);
      const options = items.map((c) => ({
        label: c.name,
        value: c.id,
      }));
      setAllCategoryOptions(options);
    } catch (err) {
      console.error('fetchCategories error:', err);
    }
  };

  const fetchItemTypes = async () => {
    try {
      const res = await api.get('/masters/item-types', { params: { page_size: 500 } });
      const data = res.data;
      const items = data.items || data.data || (Array.isArray(data) ? data : []);
      const options = items.map((t) => ({
        label: (t.name || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        value: t.name,
      }));
      setItemTypeOptions(options);
    } catch (err) {
      console.error('fetchItemTypes error:', err);
    }
  };

  useEffect(() => {
    fetchCategories();
    fetchItemTypes();
  }, []);

  const fetchItems = useCallback(
    async (params) => {
      const queryParams = { ...params };
      if (filterCategory) queryParams.category_id = filterCategory;
      if (filterType) queryParams.item_type = filterType;
      if (filterStatus) queryParams.is_active = filterStatus === 'active' ? 'true' : 'false';
      const res = await api.get('/masters/items', { params: queryParams });
      return res;
    },
    [filterCategory, filterType, filterStatus, refreshKey]
  );

  const handleToggleStatus = async (record) => {
    try {
      const isActivating = record.is_active === false;
      if (isActivating) {
        await api.put(`/masters/items/${record.id}`, { is_active: true });
        message.success('Item activated successfully');
      } else {
        await api.delete(`/masters/items/${record.id}`);
        message.success('Item deactivated successfully');
      }
      setRefreshKey((k) => k + 1);
    } catch (err) {
      const errorMsg = getErrorMessage(err);
      if (errorMsg.includes('stock') || errorMsg.includes('quantity')) {
        setDeactivateError({
          title: 'Deactivation Gated',
          subtitle: 'Active Stock in Warehouse',
          message: errorMsg,
        });
      } else if (errorMsg.includes('vendor') || errorMsg.includes('vendors')) {
        setDeactivateError({
          title: 'Deactivation Gated',
          subtitle: 'Active Vendor Linkages',
          message: errorMsg,
        });
      } else {
        message.error(errorMsg);
      }
    }
  };

  const handleExport = async () => {
    try {
      const res = await api.get('/masters/items', { params: { page_size: 10000 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      const exportData = items.map((it) => ({
        'Code': it.item_code,
        'Name': it.name,
        'Category': it.category?.name || it.category_name || '',
        'Type': it.item_type || '',
        'Sub Class': it.item_sub_class_name || '',
        'UOM': it.primary_uom?.name || it.primary_uom_name || '',
        'Safety Stock': it.safety_stock || 0,
        'Reorder Level': it.reorder_level || 0,
        'Status': it.is_active === false ? 'inactive' : 'active',
      }));
      downloadExcel(exportData, 'items_master', 'Items Master');
      message.success('Export completed');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'Readable Code',
      dataIndex: 'readable_code',
      key: 'readable_code',
      width: 240,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a onClick={() => navigate(`/masters/items/${record.id}`)}>{text || '-'}</a>
      ),
    },
    {
      title: 'Item Code',
      dataIndex: 'item_code',
      key: 'item_code',
      width: 130,
      sorter: true,
      render: (text, record) => (
        <a onClick={() => navigate(`/masters/items/${record.id}`)}>{text}</a>
      ),
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      width: 220,
      sorter: true,
      ellipsis: true,
    },
    {
      title: 'Category',
      dataIndex: ['category', 'name'],
      key: 'category',
      width: 150,
      render: (text, record) => text || record.category_name || '-',
    },
    {
      title: 'Item Class',
      dataIndex: 'item_type',
      key: 'item_type',
      width: 130,
      render: (val) => {
        const found = itemTypeOptions.find((t) => t.value === val);
        return found ? found.label : (val || '-');
      },
    },
    {
      title: 'Item Sub Class',
      dataIndex: 'item_sub_class_name',
      key: 'item_sub_class',
      width: 150,
      render: (val) => val || '-',
    },
    {
      title: 'Primary UOM',
      dataIndex: ['primary_uom', 'name'],
      key: 'primary_uom',
      width: 110,
      render: (text, record) => text || record.primary_uom_name || '-',
    },
    {
      title: 'Barcode Type',
      dataIndex: 'barcode_type',
      key: 'barcode_type',
      width: 110,
    },
    {
      title: 'Safety Stock',
      dataIndex: 'safety_stock',
      key: 'safety_stock',
      width: 110,
      align: 'right',
      render: (val) => val ?? '-',
    },
    {
      title: 'Reorder Level',
      dataIndex: 'reorder_level',
      key: 'reorder_level',
      width: 120,
      align: 'right',
      render: (val) => val ?? '-',
    },
    {
      title: 'Purchase Price',
      dataIndex: 'purchase_price',
      key: 'purchase_price',
      width: 130,
      align: 'right',
      render: (val) => formatCurrency(val),
    },
    {
      title: 'Selling Price',
      dataIndex: 'selling_price',
      key: 'selling_price',
      width: 130,
      align: 'right',
      render: (val) => formatCurrency(val),
    },
    {
      title: 'Status',
      dataIndex: 'is_active',
      key: 'status',
      width: 100,
      render: (isActive, record) => {
        const status = record.status || (isActive === false ? 'inactive' : 'active');
        return <StatusTag status={status} />;
      },
    },
    { title: 'Brand', dataIndex: 'brand', key: 'brand', width: 120 },
    { title: 'Manufacturer', dataIndex: 'manufacturer', key: 'manufacturer', width: 150 },
    { title: 'Valuation', dataIndex: 'valuation_method', key: 'valuation_method', width: 100, render: (v) => (v || 'fifo').toUpperCase() },
    {
      title: 'Actions',
      key: 'actions',
      width: 140,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button
            type="link"
            size="small"
            icon={<EyeOutlined />}
            onClick={() => navigate(`/masters/items/${record.id}`)}
          />
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => navigate(`/masters/items/${record.id}/edit`)}
          />
          <Popconfirm
            title={record.is_active === false ? "Activate this item?" : "Deactivate this item?"}
            description={record.is_active === false ? "This will make the item active and transactable." : "This will make the item inactive."}
            onConfirm={() => handleToggleStatus(record)}
            okText="Confirm"
            cancelText="Cancel"
          >
            <Button
              type="link"
              size="small"
              danger={record.is_active !== false}
              style={{ color: record.is_active === false ? '#52c41a' : undefined }}
              icon={record.is_active === false ? <CheckCircleOutlined /> : <StopOutlined />}
            />
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
        showSearch
        optionFilterProp="label"
        style={{ width: 160 }}
        value={filterCategory}
        onChange={(v) => { setFilterCategory(v); setRefreshKey((k) => k + 1); }}
        options={allCategoryOptions}
      />
      <Select
        placeholder="Item Class"
        allowClear
        style={{ width: 150 }}
        value={filterType}
        onChange={(v) => { setFilterType(v); setRefreshKey((k) => k + 1); }}
        options={itemTypeOptions}
      />
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 120 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Active', value: 'active' },
          { label: 'Inactive', value: 'inactive' },
        ]}
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="Items" subtitle="Manage inventory items">
        <Space>
          <Button icon={<DownloadOutlined />} onClick={handleExport}>
            Export
          </Button>
          <Button icon={<CloudUploadOutlined />} onClick={() => setUploadModalOpen(true)}>
            Bulk Upload
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/masters/items/new')}>
            Add Item
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchItems}
        rowKey="id"
        searchPlaceholder="Search by name or code..."
        exportFileName="items"
        toolbar={toolbar}
        scroll={{ x: 1600 }}
        initialSearch={initialSearch}
      />

      <Modal
        open={!!deactivateError}
        onCancel={() => setDeactivateError(null)}
        footer={null}
        closable={true}
        centered
        width={480}
        styles={{ body: { padding: 0 } }}
        style={{ borderRadius: 20, overflow: 'hidden' }}
      >
        <div style={{
          background: 'linear-gradient(135deg, #2A0E2F 0%, #1A0A21 100%)',
          padding: '40px 32px',
          color: '#fff',
          textAlign: 'center',
          position: 'relative',
          overflow: 'hidden'
        }}>
          <div style={{
            position: 'absolute',
            top: '-50px',
            right: '-50px',
            width: '150px',
            height: '150px',
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(240, 144, 0, 0.18) 0%, transparent 70%)',
            filter: 'blur(10px)',
            pointerEvents: 'none'
          }} />
          <div style={{
            position: 'absolute',
            bottom: '-50px',
            left: '-50px',
            width: '150px',
            height: '150px',
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(216, 0, 72, 0.18) 0%, transparent 70%)',
            filter: 'blur(10px)',
            pointerEvents: 'none'
          }} />

          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '64px',
            height: '64px',
            borderRadius: '20px',
            background: 'rgba(255, 255, 255, 0.08)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.3)',
            backdropFilter: 'blur(8px)',
            marginBottom: '20px',
            color: '#F5A623',
            fontSize: '28px'
          }}>
            ⚠️
          </div>

          <h2 style={{
            fontFamily: "var(--bavya-display)",
            color: '#fff',
            fontSize: '22px',
            fontWeight: 700,
            margin: '0 0 4px 0',
            letterSpacing: '-0.01em'
          }}>
            {deactivateError?.title}
          </h2>
          <p style={{
            fontFamily: "var(--bavya-body)",
            color: 'rgba(255, 255, 255, 0.65)',
            fontSize: '11px',
            fontWeight: 600,
            margin: '0 0 24px 0',
            textTransform: 'uppercase',
            letterSpacing: '0.08em'
          }}>
            {deactivateError?.subtitle}
          </p>

          <div style={{
            background: 'rgba(255, 255, 255, 0.04)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: '14px',
            padding: '20px',
            textAlign: 'left',
            marginBottom: '28px',
            backdropFilter: 'blur(4px)'
          }}>
            <p style={{
              fontFamily: "var(--bavya-body)",
              color: '#F4EEEA',
              fontSize: '14px',
              lineHeight: '1.6',
              margin: 0
            }}>
              {deactivateError?.message}
            </p>
          </div>

          <Button
            type="primary"
            onClick={() => setDeactivateError(null)}
            style={{
              width: '100%',
              height: '44px',
              borderRadius: '12px',
              background: 'linear-gradient(90deg, #D80048 0%, #900078 100%)',
              border: 0,
              fontWeight: 600,
              fontSize: '14px',
              boxShadow: '0 4px 12px rgba(216, 0, 72, 0.25)',
              cursor: 'pointer'
            }}
          >
            Understood
          </Button>
        </div>
      </Modal>

      <BulkUploadModal
        open={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        onUploadSuccess={() => setRefreshKey((k) => k + 1)}
      />
    </div>
  );
};

export default Items;
