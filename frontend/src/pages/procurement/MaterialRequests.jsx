import React, { useState, useCallback } from 'react';
import {
  Button, Select, Space, Popconfirm, message, Tag, Tooltip
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  SendOutlined, CloseCircleOutlined, DownloadOutlined
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatDate, getErrorMessage, downloadExcel
} from '../../utils/helpers';

const REQUEST_TYPES = [
  { label: 'Purchase', value: 'purchase' },
  { label: 'Transfer', value: 'transfer' },
  { label: 'Consumption', value: 'consumption' },
  { label: 'Maintenance', value: 'maintenance' },
  { label: 'Replenishment', value: 'replenishment' },
];

const PRIORITIES = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Critical', value: 'critical' },
];

const MaterialRequests = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterType, setFilterType] = useState(undefined);
  const [filterPriority, setFilterPriority] = useState(undefined);

  const fetchMRs = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterType) qp.request_type = filterType;
      if (filterPriority) qp.priority = filterPriority;
      return await api.get('/procurement/material-requests', { params: qp });
    },
    [filterStatus, filterType, filterPriority]
  );

  const handleAdd = () => {
    navigate('/procurement/material-requests/new');
  };

  const handleEdit = (record) => {
    navigate(`/procurement/material-requests/${record.id}?edit=true`);
  };

  const handleView = (record) => {
    navigate(`/procurement/material-requests/${record.id}`);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/procurement/material-requests/${id}`);
      message.success('Material request deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSubmitForApproval = async (id) => {
    try {
      await api.post(`/procurement/material-requests/${id}/submit`);
      message.success('Material request submitted for approval');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleCancel = async (id) => {
    try {
      await api.post(`/procurement/material-requests/${id}/cancel`);
      message.success('Material request cancelled');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'MR Number',
      dataIndex: 'mr_number',
      key: 'mr_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a onClick={() => handleView(record)}>{text}</a>
      ),
    },
    {
      title: 'Request Date',
      dataIndex: 'request_date',
      key: 'request_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Request Type',
      dataIndex: 'request_type',
      key: 'request_type',
      width: 130,
      render: (v) => REQUEST_TYPES.find((t) => t.value === v)?.label || v || '-',
    },
    {
      title: 'Department',
      dataIndex: 'department_name',
      key: 'department',
      width: 150,
      render: (v, r) => v || r.department || '-',
    },
    {
      title: 'Warehouse',
      dataIndex: 'warehouse_name',
      key: 'warehouse',
      width: 160,
      render: (v, r) => v || r.warehouse || '-',
    },
    {
      title: 'Project',
      dataIndex: 'project_name',
      key: 'project',
      width: 160,
      render: (v, r) => v || r.project || '-',
    },
    {
      title: 'Requested By',
      dataIndex: 'requested_by_name',
      key: 'requested_by',
      width: 150,
      render: (v, r) => v || r.requested_by || '-',
    },
    {
      title: 'Priority',
      dataIndex: 'priority',
      key: 'priority',
      width: 110,
      render: (v) => <StatusTag status={v} />,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 140,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(record)} />
          {record.status === 'draft' && (
            <>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
              <Tooltip title="Submit for Approval">
                <Button type="link" size="small" icon={<SendOutlined />} onClick={() => handleSubmitForApproval(record.id)} />
              </Tooltip>
              <Popconfirm title="Delete this MR?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
          {['draft', 'pending_approval'].includes(record.status) && (
            <Popconfirm title="Cancel this MR?" onConfirm={() => handleCancel(record.id)} okButtonProps={{ danger: true }}>
              <Button type="link" size="small" danger icon={<CloseCircleOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 160 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Draft', value: 'draft' },
          { label: 'Pending Approval', value: 'pending_approval' },
          { label: 'Approved', value: 'approved' },
          { label: 'Partially Ordered', value: 'partially_ordered' },
          { label: 'Ordered', value: 'ordered' },
          { label: 'Cancelled', value: 'cancelled' },
        ]}
      />
      <Select
        placeholder="Request Type"
        allowClear
        style={{ width: 140 }}
        value={filterType}
        onChange={(v) => { setFilterType(v); setRefreshKey((k) => k + 1); }}
        options={REQUEST_TYPES}
      />
      <Select
        placeholder="Priority"
        allowClear
        style={{ width: 120 }}
        value={filterPriority}
        onChange={(v) => { setFilterPriority(v); setRefreshKey((k) => k + 1); }}
        options={PRIORITIES}
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="Material Requests" subtitle="Manage material requests">
        <Space>
          <Button icon={<DownloadOutlined />} onClick={async () => {
            try {
              const res = await api.get('/procurement/material-requests', { params: { page_size: 10000 } });
              const data = res.data;
              const items = data.items || data.data || data || [];
              const exportData = items.map((mr) => ({
                'MR Number': mr.mr_number,
                'Request Date': formatDate(mr.request_date),
                'Request Type': mr.request_type || '',
                'Department': mr.department_name || mr.department || '',
                'Priority': mr.priority || '',
                'Required Date': formatDate(mr.required_date),
                'Status': mr.status,
              }));
              downloadExcel(exportData, 'material_requests', 'Material Requests');
              message.success('Export completed');
            } catch (err) { message.error(getErrorMessage(err)); }
          }}>Export</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            Create MR
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchMRs}
        rowKey="id"
        searchPlaceholder="Search by MR number..."
        exportFileName="material_requests"
        toolbar={toolbar}
        scroll={{ x: 1600 }}
      />
    </div>
  );
};

export default MaterialRequests;
