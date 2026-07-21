import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Select, Space, Popconfirm, Tag, App } from 'antd';
import { PlusOutlined, EyeOutlined, StopOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { formatDate, getErrorMessage } from '../../utils/helpers';
import useAuthStore from '../../store/authStore';

const TemplateIndentList = ({ title = "Template Indents" }) => {
  const { message } = App.useApp();
  const { user: currentUser } = useAuthStore();
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterProject, setFilterProject] = useState(undefined);
  const [projects, setProjects] = useState([]);

  const isRaiser = (record) => record?.raised_by === currentUser?.id;

  const loadProjects = useCallback(async () => {
    try {
      const projRes = await api.get('/masters/projects', { params: { page_size: 200 } });
      const data = projRes.data?.items || projRes.data?.data || projRes.data || [];
      setProjects(data.map((p) => ({ label: p.name || p.project_name, value: p.id })));
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const fetchData = useCallback(
    async (params) => {
      const qp = { ...params, template_type: 'dp_project' };
      if (filterStatus) qp.status = filterStatus;
      if (filterProject) qp.project_id = filterProject;
      // Fetch indents
      const res = await api.get('/indent/indents', { params: qp });
      return res;
    },
    [filterStatus, filterProject]
  );

  const handleAction = async (id, action) => {
    try {
      await api.post(`/indent/indents/${id}/${action}`);
      const labels = { submit: 'submitted for approval', reject: 'rejected', cancel: 'cancelled' };
      message.success(`Indent ${labels[action] || action}`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'Indent #',
      dataIndex: 'indent_number',
      key: 'indent_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => navigate(`/indent/template-indents/${record.id}`)}>{text}</a>,
    },
    { title: 'Project', dataIndex: 'project_name', key: 'project', width: 180, render: (v, r) => v || r.project || '-' },
    {
      title: 'Template Name',
      dataIndex: 'template_name',
      key: 'template_name',
      width: 180,
      render: (v) => <Tag color="purple" style={{ fontWeight: 600 }}>{v || '-'}</Tag>,
    },
    { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 160, render: (v, r) => v || r.warehouse || '-' },
    { title: 'Vehicle Code', dataIndex: 'vehicle_code', key: 'vehicle_code', width: 120, render: (v) => v || '-' },
    { title: 'Vehicle Number', dataIndex: 'vehicle_number', key: 'vehicle_number', width: 140, render: (v) => v || '-' },
    { title: 'Indent Date', dataIndex: 'indent_date', key: 'indent_date', width: 120, sorter: true, render: (v) => formatDate(v) },
    { title: 'Required Date', dataIndex: 'required_date', key: 'required_date', width: 120, sorter: true, render: (v) => formatDate(v) },
    { title: 'Raised By', dataIndex: 'raised_by_name', key: 'raised_by', width: 140, render: (v, r) => v || r.raised_by || '-' },
    { title: 'Status', dataIndex: 'status', key: 'status', width: 150, render: (s) => <StatusTag status={s} /> },
    {
      title: 'Actions',
      key: 'actions',
      width: 100,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => navigate(`/indent/template-indents/${record.id}`)} />
          {record.status === 'draft' && isRaiser(record) && (
            <Popconfirm
              title="Cancel this draft?"
              onConfirm={() => handleAction(record.id, 'reject')}
              okButtonProps={{ danger: true }}
            >
              <Button type="link" size="small" danger icon={<StopOutlined />} />
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
          { label: 'Partially Fulfilled', value: 'partially_fulfilled' },
          { label: 'Fulfilled', value: 'fulfilled' },
          { label: 'Rejected', value: 'rejected' },
          { label: 'Cancelled', value: 'cancelled' },
        ]}
      />
      {projects.length > 1 && (
        <Select
          placeholder="Project"
          allowClear
          style={{ width: 200 }}
          value={filterProject}
          onChange={(v) => { setFilterProject(v); setRefreshKey((k) => k + 1); }}
          options={projects}
          showSearch
          filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
        />
      )}
    </Space>
  );

  return (
    <div>
      <PageHeader title={title} subtitle="Create and manage project template indents with fixed items & quantities">
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/indent/template-indents/new')}>
          Create Template Indent
        </Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchData}
        rowKey="id"
        searchPlaceholder="Search by indent number..."
        exportFileName="template_indents"
        toolbar={toolbar}
        scroll={{ x: 1400 }}
      />
    </div>
  );
};

export default TemplateIndentList;
