import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, Popconfirm, message, Card, Tooltip, Tag, Badge, Typography
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  SendOutlined, CheckOutlined, CloseCircleOutlined
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatDate, formatCurrency, formatNumber, getErrorMessage
} from '../../utils/helpers';

const { Text } = Typography;

const AUDIT_TYPES = [
  { label: 'Full Audit', value: 'full' },
  { label: 'Partial Audit', value: 'partial' },
  { label: 'Cycle Count', value: 'cycle_count' },
];

const AUDIT_STATUSES = [
  { label: 'Draft', value: 'draft' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Pending Approval', value: 'pending_approval' },
  { label: 'Approved', value: 'approved' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const StockAudit = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);
  const [filterAuditType, setFilterAuditType] = useState(undefined);

  const [warehouses, setWarehouses] = useState([]);

  // Load lookups
  useEffect(() => {
    const loadLookups = async () => {
      try {
        const res = await api.get('/masters/warehouses', { params: { page_size: 200 } });
        const d = res.data;
        const items = d.items || d.data || d || [];
        setWarehouses(items.map((w) => ({
          label: w.name || w.warehouse_name,
          value: w.id,
        })));
      } catch {
        // silent
      }
    };
    loadLookups();
  }, []);

  // Fetch audits
  const fetchAudits = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      if (filterAuditType) qp.audit_type = filterAuditType;
      return await api.get('/inventory/stock-audits', { params: qp });
    },
    [filterStatus, filterWarehouse, filterAuditType]
  );

  // Actions
  const handleAction = async (id, action, successMsg) => {
    try {
      if (action === 'approve') {
        await api.post(`/inventory/audits/${id}/adjust`);
      } else {
        await api.put(`/inventory/stock-audits/${id}/${action}`);
      }
      message.success(successMsg);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/inventory/stock-audits/${id}`);
      message.success('Audit deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // Main table columns
  const columns = [
    {
      title: 'Audit No',
      dataIndex: 'audit_number',
      width: 150,
      fixed: 'left',
      sorter: true,
      render: (val, record) => (
        <a onClick={() => navigate(`/inventory/stock-audit/${record.id}`)}>
          {val}
        </a>
      ),
    },
    {
      title: 'Warehouse',
      dataIndex: 'warehouse_name',
      width: 160,
      sorter: true,
      render: (val) => val || '-',
    },
    {
      title: 'Audit Date',
      dataIndex: 'audit_date',
      width: 110,
      sorter: true,
      render: (val) => formatDate(val),
    },
    {
      title: 'Audit Type',
      dataIndex: 'audit_type',
      width: 120,
      render: (val) => {
        const found = AUDIT_TYPES.find((t) => t.value === val);
        const colors = { full: 'blue', partial: 'orange', cycle_count: 'purple' };
        return <Tag color={colors[val] || 'default'}>{found ? found.label : val || '-'}</Tag>;
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 130,
      render: (val) => <StatusTag status={val} />,
    },
    {
      title: 'Total Items',
      dataIndex: 'total_items',
      width: 100,
      align: 'center',
      render: (val) => formatNumber(val || 0),
    },
    {
      title: 'Variance Items',
      dataIndex: 'variance_items',
      width: 120,
      align: 'center',
      render: (val) => {
        if (!val || val === 0) return <Text type="secondary">0</Text>;
        return (
          <Badge count={val} style={{ backgroundColor: '#fa8c16' }} />
        );
      },
    },
    {
      title: 'Variance Value',
      dataIndex: 'total_variance_value',
      width: 120,
      align: 'right',
      render: (val) => {
        if (!val || val === 0) return <Text type="secondary">-</Text>;
        return <Text style={{ color: '#fa8c16' }}>{formatCurrency(Math.abs(val))}</Text>;
      },
    },
    {
      title: 'Created By',
      dataIndex: 'created_by',
      width: 110,
      render: (val) => val || '-',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      fixed: 'right',
      render: (_, record) => {
        const st = (record.status || '').toLowerCase();
        return (
          <Space size="small">
            <Tooltip title="View">
              <Button type="text" icon={<EyeOutlined />} size="small" onClick={() => navigate(`/inventory/stock-audit/${record.id}`)} />
            </Tooltip>
            {(st === 'draft' || st === 'in_progress') && (
              <>
                <Tooltip title="Edit">
                  <Button type="text" icon={<EditOutlined />} size="small" onClick={() => navigate(`/inventory/stock-audit/${record.id}?edit=true`)} />
                </Tooltip>
                <Tooltip title="Submit for Approval">
                  <Popconfirm title="Submit audit for approval?" onConfirm={() => handleAction(record.id, 'submit', 'Submitted for approval')}>
                    <Button type="text" icon={<SendOutlined />} size="small" />
                  </Popconfirm>
                </Tooltip>
              </>
            )}
            {st === 'draft' && (
              <Popconfirm title="Delete this audit?" onConfirm={() => handleDelete(record.id)}>
                <Button type="text" danger icon={<DeleteOutlined />} size="small" />
              </Popconfirm>
            )}
            {st === 'pending_approval' && (
              <>
                <Tooltip title="Approve Adjustments">
                  <Popconfirm title="Approve adjustments and apply to stock?" onConfirm={() => handleAction(record.id, 'approve', 'Adjustments approved and applied')}>
                    <Button type="text" icon={<CheckOutlined />} size="small" style={{ color: '#52c41a' }} />
                  </Popconfirm>
                </Tooltip>
                <Tooltip title="Reject">
                  <Popconfirm title="Reject this audit?" onConfirm={() => handleAction(record.id, 'reject', 'Audit rejected')}>
                    <Button type="text" danger icon={<CloseCircleOutlined />} size="small" />
                  </Popconfirm>
                </Tooltip>
              </>
            )}
          </Space>
        );
      },
    },
  ];

  const filterToolbar = (
    <Space wrap size="small" style={{ marginLeft: 12 }}>
      <Select
        placeholder="Warehouse"
        options={warehouses}
        value={filterWarehouse}
        onChange={(val) => { setFilterWarehouse(val); setRefreshKey((k) => k + 1); }}
        allowClear
        style={{ width: 160 }}
        size="middle"
      />
      <Select
        placeholder="Audit Type"
        options={AUDIT_TYPES}
        value={filterAuditType}
        onChange={(val) => { setFilterAuditType(val); setRefreshKey((k) => k + 1); }}
        allowClear
        style={{ width: 140 }}
        size="middle"
      />
      <Select
        placeholder="Status"
        options={AUDIT_STATUSES}
        value={filterStatus}
        onChange={(val) => { setFilterStatus(val); setRefreshKey((k) => k + 1); }}
        allowClear
        style={{ width: 150 }}
        size="middle"
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="Stock Audit" subtitle="Physical inventory and stock audit management">
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/inventory/stock-audit/new')}>
          Create Audit
        </Button>
      </PageHeader>

      <Card bodyStyle={{ padding: 0 }}>
        <DataTable
          key={refreshKey}
          columns={columns}
          fetchFunction={fetchAudits}
          rowKey="id"
          searchPlaceholder="Search audits..."
          exportFileName="Stock_Audits"
          toolbar={filterToolbar}
          scroll={{ x: 1500 }}
        />
      </Card>
    </div>
  );
};

export default StockAudit;
