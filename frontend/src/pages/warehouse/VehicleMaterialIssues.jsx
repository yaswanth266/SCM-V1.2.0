import React, { useState, useCallback, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, Popconfirm, message, Input, Tooltip
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  SendOutlined
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatDate, getErrorMessage, exportGlobalToExcel, printGlobalToPDF
} from '../../utils/helpers';

const VI_STATUSES = [
  { label: 'Draft', value: 'draft' },
  { label: 'Issued', value: 'issued' },
  { label: 'Acknowledged', value: 'acknowledged' },
  { label: 'Cancelled', value: 'cancelled' },
];

const VehicleMaterialIssues = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);
  const [filterDepartment, setFilterDepartment] = useState(undefined);

  const [warehouses, setWarehouses] = useState([]);

  // --- Lookups ---
  const loadLookups = useCallback(async () => {
    try {
      const whRes = await api.get('/masters/warehouses', { params: { page_size: 200, exclude_virtual: true } });
      const w = whRes.data;
      setWarehouses(
        (w.items || w.data || w || []).map((i) => ({
          label: i.name || i.warehouse_name,
          value: i.id,
        }))
      );
    } catch (err) {
      console.error('Error loading lookups:', err);
    }
  }, []);

  useEffect(() => {
    loadLookups();
  }, [loadLookups]);

  // --- Fetch ---
  const fetchRecords = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      if (filterDepartment) qp.department = filterDepartment;
      return await api.get('/warehouse/vehicle-issues', { params: qp });
    },
    [filterStatus, filterWarehouse, filterDepartment]
  );

  // --- Actions ---
  const handleIssue = async (id) => {
    try {
      await api.post(`/warehouse/vehicle-issues/${id}/issue`);
      message.success('Vehicle issue confirmed successfully, stock reserved');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/warehouse/vehicle-issues/${id}`);
      message.success('Vehicle issue deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Main Table Columns ---
  const columns = [
    {
      title: 'Issue Number',
      dataIndex: 'issue_number',
      key: 'issue_number',
      width: 160,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a onClick={() => navigate(`/warehouse/vehicle-material-issues/${record.id}`)}>{text}</a>
      ),
    },
    {
      title: 'Source Warehouse',
      dataIndex: 'warehouse_name',
      key: 'warehouse',
      width: 150,
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: 'Vehicle Code',
      dataIndex: 'vehicle_code',
      key: 'vehicle_code',
      width: 140,
      render: (v) => v || '-',
    },
    {
      title: 'Vehicle Number',
      dataIndex: 'vehicle_number',
      key: 'vehicle_number',
      width: 140,
      render: (v) => v || '-',
    },
    {
      title: 'Department',
      dataIndex: 'department',
      key: 'department',
      width: 140,
      render: (v) => v || '-',
    },
    {
      title: 'Issue Date',
      dataIndex: 'issue_date',
      key: 'issue_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Emp Name',
      dataIndex: 'raised_by_name',
      key: 'emp_name',
      width: 150,
      ellipsis: true,
      render: (v, r) => v || r.created_by_name || r.issued_to_name || '-',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View Detail">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => navigate(`/warehouse/vehicle-material-issues/${record.id}`)} />
          </Tooltip>
          {record.status === 'draft' && (
            <>
              <Tooltip title="Edit">
                <Button type="link" size="small" icon={<EditOutlined />} onClick={() => navigate(`/warehouse/vehicle-material-issues/${record.id}?edit=true`)} />
              </Tooltip>
              <Tooltip title="Issue Material (Reserve)">
                <Popconfirm
                  title="Issue this material? Stock will be reserved in source warehouse."
                  onConfirm={() => handleIssue(record.id)}
                >
                  <Button type="link" size="small" icon={<SendOutlined />} style={{ color: '#eb2f96' }} />
                </Popconfirm>
              </Tooltip>
              <Popconfirm title="Delete this Vehicle Issue?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ];

  // --- Filter Toolbar ---
  const toolbar = (
    <Space style={{ marginLeft: 12 }} wrap>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 150 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={VI_STATUSES}
      />
      <Select
        placeholder="Warehouse"
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ width: 160 }}
        value={filterWarehouse}
        onChange={(v) => { setFilterWarehouse(v); setRefreshKey((k) => k + 1); }}
        options={warehouses}
        onOpenChange={(open) => { if (open && warehouses.length === 0) loadLookups(); }}
      />
      <Input
        placeholder="Department"
        allowClear
        style={{ width: 150 }}
        value={filterDepartment}
        onChange={(e) => { setFilterDepartment(e.target.value || undefined); }}
        onPressEnter={() => setRefreshKey((k) => k + 1)}
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="Vehicle Material Issues" subtitle="Manage material issues to vehicles">
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/warehouse/vehicle-material-issues/new')}>
            Create Vehicle Issue
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchRecords}
        rowKey="id"
        searchPlaceholder="Search by issue number, vehicle code, number..."
        exportFileName="vehicle_material_issues_list"
        toolbar={toolbar}
        scroll={{ x: 1200 }}
        onExport={(data) => exportGlobalToExcel(data, 'vehicle_issue')}
        onPrint={(data) => printGlobalToPDF(data, 'vehicle_issue')}
      />
    </div>
  );
};

export default VehicleMaterialIssues;
