import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, Row, Col,
  Popconfirm, message, Tag,
} from 'antd';
import {
  AppstoreOutlined, CheckCircleOutlined, ClockCircleOutlined, ToolOutlined,
  DownloadOutlined, PlusOutlined, EyeOutlined, EditOutlined, DeleteOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatCard from '../../components/StatCard';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { formatCurrency, formatDate, getErrorMessage, downloadExcel } from '../../utils/helpers';
import { ASSET_CATEGORIES } from '../../utils/constants';


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
  const navigate = useNavigate();
  const [filterCategory, setFilterCategory] = useState(undefined);
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterCondition, setFilterCondition] = useState(undefined);
  const [refreshKey, setRefreshKey] = useState(0);
  const [stats, setStats] = useState({ total: 0, in_use: 0, available: 0, under_maintenance: 0 });

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      const res = await api.get('/assets/stats');
      const data = res.data;
      setStats({
        total: data.total_assets ?? data.total ?? 0,
        in_use: data.active ?? data.in_use ?? 0,
        available: data.available ?? 0,
        under_maintenance: data.in_maintenance ?? data.under_maintenance ?? 0,
      });
    } catch {
      // silent
    }
  };

  const fetchAssets = useCallback(
    async (params) => {
      const queryParams = { ...params };
      if (filterCategory) queryParams.category_id = filterCategory;
      if (filterStatus) queryParams.status = filterStatus;
      const res = await api.get('/assets', { params: queryParams });
      return res;
    },
    [filterCategory, filterStatus, filterCondition]
  );

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

  const columns = [
    {
      title: 'Asset Code',
      dataIndex: 'asset_code',
      key: 'asset_code',
      width: 140,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => navigate(`/assets/register/${record.id}`)}>{text}</a>,
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
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => navigate(`/assets/register/${record.id}`)} />
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => navigate(`/assets/register/${record.id}?edit=true`)} />
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
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/assets/register/new')}>Add Asset</Button>
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
    </div>
  );
};

export default AssetRegister;
