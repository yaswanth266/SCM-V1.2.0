import React, { useState, useCallback, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, Popconfirm, message, Input, Tooltip
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  SendOutlined, PrinterOutlined
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatDate, getErrorMessage, exportGlobalToExcel, printGlobalToPDF,
  printVehicleIssueToPDF
} from '../../utils/helpers';

const VI_STATUSES = [
  { label: 'Issued', value: 'issued' },
  { label: 'Acknowledged', value: 'acknowledged' },
];

const VehicleMaterialIssues = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterVehicle, setFilterVehicle] = useState(undefined);

  const [vehicles, setVehicles] = useState([]);

  // --- Lookups ---
  const loadLookups = useCallback(async () => {
    try {
      const res = await api.get('/masters/vehicles', { params: { is_active: true, limit: 100 } });
      setVehicles(
        (res.data || []).map((v) => ({
          label: `${v.vehicle_code} (${v.vehicle_number})`,
          value: v.vehicle_code,
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
      if (filterVehicle) qp.vehicle_code = filterVehicle;
      return await api.get('/warehouse/vehicle-issues', { params: qp });
    },
    [filterStatus, filterVehicle]
  );

  const [printingId, setPrintingId] = useState(null);

  const handlePrintClick = async (id) => {
    setPrintingId(id);
    try {
      message.loading({ content: 'Loading details for print...', key: 'printVI' });
      const res = await api.get(`/warehouse/vehicle-issues/${id}`);
      printVehicleIssueToPDF(res.data);
      message.success({ content: 'Print report opened', key: 'printVI' });
    } catch (err) {
      message.error({ content: `Failed to load details: ${getErrorMessage(err)}`, key: 'printVI' });
    } finally {
      setPrintingId(null);
    }
  };

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
          <Tooltip title="Print Issue">
            <Button type="link" size="small" icon={<PrinterOutlined />} loading={printingId === record.id} onClick={() => handlePrintClick(record.id)} />
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
        placeholder="Select Vehicle"
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ width: 180 }}
        value={filterVehicle}
        onChange={(v) => { setFilterVehicle(v); setRefreshKey((k) => k + 1); }}
        options={vehicles}
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
