import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, Popconfirm, message, Card, Tooltip, Tag
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  SendOutlined, CheckOutlined, CarOutlined, InboxOutlined,
  CheckCircleFilled
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import useAuthStore from '../../store/authStore';
import {
  formatDate, getErrorMessage
} from '../../utils/helpers';

const TRANSFER_TYPES = [
  { label: 'Warehouse to Warehouse', value: 'warehouse_to_warehouse' },
  { label: 'Location to Location', value: 'location_to_location' },
  { label: 'Bin to Bin', value: 'bin_to_bin' },
];

const TRANSFER_STATUSES = [
  { label: 'Draft', value: 'draft' },
  { label: 'Pending Approval', value: 'pending_approval' },
  { label: 'Approved', value: 'approved' },
  { label: 'In Transit', value: 'in_transit' },
  { label: 'Received', value: 'received' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const StockTransfer = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const user = useAuthStore((s) => s.user);
  const [filterWarehouse, setFilterWarehouse] = useState(user?.warehouse_id || undefined);

  const [warehouses, setWarehouses] = useState([]);

  // Load lookups
  const loadLookups = useCallback(async () => {
    try {
      const whRes = await api.get('/masters/warehouses', { params: { page_size: 200, exclude_virtual: true } });
      const d = whRes.data;
      const items = d.items || d.data || d || [];
      setWarehouses(items.map((w) => ({
        label: w.name || w.warehouse_name,
        value: w.id,
      })));
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    loadLookups();
  }, [loadLookups]);

  // Fetch transfers
  const fetchTransfers = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      return await api.get('/inventory/stock-transfers', { params: qp });
    },
    [filterStatus, filterWarehouse]
  );

  // Actions
  const handleAction = async (id, action, successMsg) => {
    try {
      await api.post(`/inventory/stock-transfers/${id}/${action}`);
      message.success(successMsg);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/inventory/stock-transfers/${id}`);
      message.success('Transfer deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // Main table columns
  const columns = [
    {
      title: 'Transfer No',
      dataIndex: 'transfer_number',
      width: 150,
      fixed: 'left',
      sorter: true,
      render: (val, record) => (
        <a onClick={() => navigate(`/inventory/stock-transfer/${record.id}`)}>
          {val}
        </a>
      ),
    },
    {
      title: 'Source Warehouse',
      dataIndex: 'source_warehouse_name',
      width: 160,
      sorter: true,
      render: (val) => val || '-',
    },
    {
      title: 'Destination Warehouse',
      dataIndex: 'destination_warehouse_name',
      width: 170,
      sorter: true,
      render: (val) => val || '-',
    },
    {
      title: 'Transfer Date',
      dataIndex: 'transfer_date',
      width: 120,
      sorter: true,
      render: (val) => formatDate(val),
    },
    {
      title: 'Transfer Type',
      dataIndex: 'transfer_type',
      width: 160,
      render: (val) => {
        const found = TRANSFER_TYPES.find((t) => t.value === val);
        return <Tag>{found ? found.label : val || '-'}</Tag>;
      },
    },
    {
      title: 'Items',
      dataIndex: 'total_items',
      width: 70,
      align: 'center',
      render: (val) => val || 0,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 130,
      render: (val) => <StatusTag status={val} />,
    },
    {
      title: 'Created By',
      dataIndex: 'created_by',
      width: 120,
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
              <Button type="text" icon={<EyeOutlined />} size="small" onClick={() => navigate(`/inventory/stock-transfer/${record.id}`)} />
            </Tooltip>
            {st === 'draft' && (
              <>
                <Tooltip title="Edit">
                  <Button type="text" icon={<EditOutlined />} size="small" onClick={() => navigate(`/inventory/stock-transfer/${record.id}?edit=true`)} />
                </Tooltip>
                <Tooltip title="Submit for Approval">
                  <Popconfirm title="Submit for approval?" onConfirm={() => handleAction(record.id, 'submit', 'Submitted for approval')}>
                    <Button type="text" icon={<SendOutlined />} size="small" />
                  </Popconfirm>
                </Tooltip>
                <Popconfirm title="Delete this transfer?" onConfirm={() => handleDelete(record.id)}>
                  <Button type="text" danger icon={<DeleteOutlined />} size="small" />
                </Popconfirm>
              </>
            )}
            {st === 'pending_approval' && (
              <Tooltip title="Approve">
                <Popconfirm title="Approve this transfer?" onConfirm={() => handleAction(record.id, 'approve', 'Transfer approved')}>
                  <Button type="text" icon={<CheckOutlined />} size="small" style={{ color: '#52c41a' }} />
                </Popconfirm>
              </Tooltip>
            )}
            {st === 'approved' && (
              <Tooltip title="Dispatch">
                <Popconfirm title="Mark as dispatched?" onConfirm={() => handleAction(record.id, 'dispatch', 'Transfer dispatched')}>
                  <Button type="text" icon={<CarOutlined />} size="small" style={{ color: '#eb2f96' }} />
                </Popconfirm>
              </Tooltip>
            )}
            {st === 'in_transit' && (
              <Tooltip title="Receive">
                <Popconfirm title="Mark as received?" onConfirm={() => handleAction(record.id, 'receive', 'Transfer received')}>
                  <Button type="text" icon={<InboxOutlined />} size="small" style={{ color: '#52c41a' }} />
                </Popconfirm>
              </Tooltip>
            )}
            {st === 'received' && (
              <Tooltip title="Complete">
                <Popconfirm title="Mark as complete?" onConfirm={() => handleAction(record.id, 'complete', 'Transfer completed')}>
                  <Button type="text" icon={<CheckCircleFilled />} size="small" style={{ color: '#52c41a' }} />
                </Popconfirm>
              </Tooltip>
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
        showSearch
        optionFilterProp="label"
      />
      <Select
        placeholder="Status"
        options={TRANSFER_STATUSES}
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
      <PageHeader title="Stock Transfer" subtitle="Inter-location stock transfers">
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/inventory/stock-transfer/new')}>
          Create Transfer
        </Button>
      </PageHeader>

      <Card styles={{ body: { padding: 0 } }}>
        <DataTable
          key={refreshKey}
          columns={columns}
          fetchFunction={fetchTransfers}
          rowKey="id"
          searchPlaceholder="Search transfers..."
          exportFileName="Stock_Transfers"
          toolbar={filterToolbar}
          scroll={{ x: 1400 }}
        />
      </Card>
    </div>
  );
};

export default StockTransfer;
