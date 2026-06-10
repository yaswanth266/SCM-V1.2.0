import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, Popconfirm, message, Card, Tooltip, Tag, DatePicker
} from 'antd';
import {
  PlusOutlined, EditOutlined, EyeOutlined, SendOutlined,
  CloseCircleOutlined, CheckCircleOutlined
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatDate, getErrorMessage, formatDateForAPI
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { RangePicker } = DatePicker;

const SOURCE_LABELS = {
  web: 'Web',
  mobile_app: 'Mobile App',
};

const ConsumptionEntry = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterProject, setFilterProject] = useState(undefined);
  const [filterDepartment, setFilterDepartment] = useState(undefined);
  const [filterDateRange, setFilterDateRange] = useState(null);

  const [departments, setDepartments] = useState([]);
  const [projects, setProjects] = useState([]);

  const loadLookups = useCallback(async () => {
    try {
      const [deptRes, projRes] = await Promise.allSettled([
        api.get('/masters/departments', { params: { page_size: 200 } }),
        api.get('/masters/projects', { params: { page_size: 200 } }),
      ]);
      if (deptRes.status === 'fulfilled') {
        const d = deptRes.value.data;
        setDepartments((d.items || d.data || d || []).map((i) => ({ label: i.name, value: i.id })));
      }
      if (projRes.status === 'fulfilled') {
        const p = projRes.value.data;
        setProjects((p.items || p.data || p || []).map((i) => ({ label: i.name || i.project_name, value: i.id })));
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    loadLookups();
  }, [loadLookups]);

  const fetchData = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterProject) qp.project_id = filterProject;
      if (filterDepartment) qp.department_id = filterDepartment;
      if (filterDateRange && filterDateRange[0]) qp.date_from = formatDateForAPI(filterDateRange[0]);
      if (filterDateRange && filterDateRange[1]) qp.date_to = formatDateForAPI(filterDateRange[1]);
      return await api.get('/consumption/entries', { params: qp });
    },
    [filterStatus, filterProject, filterDepartment, filterDateRange]
  );

  const handleAction = async (id, action) => {
    try {
      await api.post(`/consumption/entries/${id}/${action}`);
      const labels = { submit: 'submitted', approve: 'approved', cancel: 'cancelled' };
      message.success(`Consumption entry ${labels[action] || action}`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'Entry #',
      dataIndex: 'entry_number',
      key: 'entry_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => navigate(`/consumption/entry/${record.id}`)}>{text}</a>,
    },
    { title: 'Date', dataIndex: 'consumption_date', key: 'date', width: 120, sorter: true, render: (v) => formatDate(v) },
    { title: 'Project', dataIndex: 'project_name', key: 'project', width: 150, render: (v, r) => v || r.project || '-' },
    { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 150, render: (v, r) => v || r.warehouse || '-' },
    { title: 'Department', dataIndex: 'department_name', key: 'department', width: 140, render: (v, r) => v || r.department || '-' },
    { title: 'Consumed By', dataIndex: 'consumed_by_name', key: 'consumed_by', width: 140, render: (v, r) => v || r.consumed_by || '-' },
    {
      title: 'Source',
      dataIndex: 'source',
      key: 'source',
      width: 100,
      render: (v) => <Tag color={v === 'web' ? 'blue' : 'green'}>{SOURCE_LABELS[v] || v || '-'}</Tag>,
    },
    { title: 'Status', dataIndex: 'status', key: 'status', width: 140, render: (s) => <StatusTag status={s} /> },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => navigate(`/consumption/entry/${record.id}`)} />
          {record.status === 'draft' && (
            <>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => navigate(`/consumption/entry/${record.id}?edit=true`)} />
              <Tooltip title="Submit">
                <Button type="link" size="small" icon={<SendOutlined />} onClick={() => handleAction(record.id, 'submit')} />
              </Tooltip>
            </>
          )}
          {record.status === 'pending_approval' && (
            <Tooltip title="Approve">
              <Popconfirm title="Approve this entry?" onConfirm={() => handleAction(record.id, 'approve')}>
                <Button type="link" size="small" icon={<CheckCircleOutlined />} style={{ color: '#52c41a' }} />
              </Popconfirm>
            </Tooltip>
          )}
          {['draft', 'pending_approval'].includes(record.status) && (
            <Popconfirm title="Cancel this entry?" onConfirm={() => handleAction(record.id, 'cancel')} okButtonProps={{ danger: true }}>
              <Button type="link" size="small" danger icon={<CloseCircleOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <RangePicker
        format={DATE_FORMAT}
        value={filterDateRange}
        onChange={(v) => { setFilterDateRange(v); setRefreshKey((k) => k + 1); }}
        style={{ width: 240 }}
        allowClear
      />
      <Select
        placeholder="Project"
        allowClear
        style={{ width: 140 }}
        value={filterProject}
        onChange={(v) => { setFilterProject(v); setRefreshKey((k) => k + 1); }}
        options={projects}
        showSearch
        optionFilterProp="label"
        onFocus={loadLookups}
      />
      <Select
        placeholder="Department"
        allowClear
        style={{ width: 140 }}
        value={filterDepartment}
        onChange={(v) => { setFilterDepartment(v); setRefreshKey((k) => k + 1); }}
        options={departments}
        showSearch
        optionFilterProp="label"
        onFocus={loadLookups}
      />
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 150 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Draft', value: 'draft' },
          { label: 'Pending Approval', value: 'pending_approval' },
          { label: 'Approved', value: 'approved' },
          { label: 'Cancelled', value: 'cancelled' },
        ]}
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="Consumption Entry" subtitle="Daily consumption booking and management">
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/consumption/entry/new')}>Book Consumption</Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchData}
        rowKey="id"
        searchPlaceholder="Search by entry number..."
        exportFileName="consumption_entries"
        toolbar={toolbar}
        scroll={{ x: 1600 }}
      />
    </div>
  );
};

export default ConsumptionEntry;
