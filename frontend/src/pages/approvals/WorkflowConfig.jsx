import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, Switch, Card, Table, Popconfirm, message, 
  Tag, Tooltip, Typography, Tabs, Checkbox
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const WorkflowConfig = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  // Project hierarchy config state
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configData, setConfigData] = useState([]);

  // Fetch projects list
  useEffect(() => {
    const loadProjects = async () => {
      try {
        const res = await api.get('/masters/projects', { params: { page_size: 200 } });
        const d = res.data;
        const items = d.items || d.data || d || [];
        setProjects(items.map(p => ({ label: p.name || p.project_name, value: p.id })));
        if (items.length > 0) {
          setSelectedProject(items[0].id);
        }
      } catch (err) {
        message.error('Failed to load projects');
      }
    };
    loadProjects();
  }, []);

  // Fetch matrix config when selectedProject changes
  const loadProjectConfig = useCallback(async (projId) => {
    if (!projId) return;
    setLoadingConfig(true);
    try {
      const res = await api.get('/approvals/project-workflow-config', {
        params: { project_id: projId }
      });
      setConfigData(res.data || []);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoadingConfig(false);
    }
  }, []);

  useEffect(() => {
    if (selectedProject) {
      loadProjectConfig(selectedProject);
    }
  }, [selectedProject, loadProjectConfig]);

  const handleCheckboxChange = (roleId, field, checked) => {
    setConfigData(prev =>
      prev.map(row => {
        if (row.role_id === roleId) {
          let updatedRow = { ...row, [field]: checked };
          if (field === 'indent_approve' && checked) {
            updatedRow.indent_view = true;
          }
          if (field === 'dispatch_approve' && checked) {
            updatedRow.dispatch_view = true;
          }
          if (field === 'indent_view' && !checked) {
            updatedRow.indent_approve = false;
          }
          if (field === 'dispatch_view' && !checked) {
            updatedRow.dispatch_approve = false;
          }
          return updatedRow;
        }
        return row;
      })
    );
  };

  const handleSaveConfig = async () => {
    if (!selectedProject) return;
    setSavingConfig(true);
    try {
      await api.post('/approvals/project-workflow-config', {
        project_id: selectedProject,
        configs: configData
      });
      message.success('Project workflow configurations saved successfully.');
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setSavingConfig(false);
    }
  };

  const fetchWorkflows = useCallback(
    async (params) => {
      const res = await api.get('/approvals/workflows', { params });
      if (res.data) {
        // Filter out legacy indent workflows from standard list
        const items = res.data.items || res.data.data || res.data;
        const filtered = items.filter(
          w => w.document_type !== 'indent' && w.document_type !== 'indent_return'
        );
        if (Array.isArray(res.data)) {
          res.data = filtered;
        } else if (res.data.items) {
          res.data.items = filtered;
        } else if (res.data.data) {
          res.data.data = filtered;
        }
      }
      return res;
    },
    []
  );

  const handleAdd = () => {
    navigate('/approvals/workflow-config/new');
  };

  const handleEdit = (record) => {
    navigate(`/approvals/workflow-config/${record.id}/edit`);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/approvals/workflows/${id}`);
      message.success('Workflow deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleToggleActive = async (record) => {
    try {
      await api.put(`/approvals/workflows/${record.id}`, {
        is_active: !record.is_active,
      });
      message.success(`Workflow ${record.is_active ? 'deactivated' : 'activated'}`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'Workflow Name',
      dataIndex: 'name',
      key: 'name',
      width: 220,
      sorter: true,
      render: (text, record) => (
        <a onClick={() => handleEdit(record)}>{text}</a>
      ),
    },
    {
      title: 'Module',
      dataIndex: 'module',
      key: 'module',
      width: 140,
      render: (val) => (
        <Tag color="blue">
          {(val || '').charAt(0).toUpperCase() + (val || '').slice(1)}
        </Tag>
      ),
    },
    {
      title: 'Document Type',
      dataIndex: 'document_type',
      key: 'document_type',
      width: 180,
      render: (val) => (val || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    },
    {
      title: 'Project',
      dataIndex: 'project_name',
      key: 'project',
      width: 160,
      ellipsis: true,
      render: (val) => val || '-',
    },
    {
      title: 'Levels',
      key: 'levels_count',
      width: 80,
      align: 'center',
      render: (_, record) => (
        <Tag color="geekblue">{record.levels_count || record.levels?.length || 0}</Tag>
      ),
    },
    {
      title: 'Active',
      dataIndex: 'is_active',
      key: 'is_active',
      width: 100,
      align: 'center',
      render: (val, record) => (
        <Switch
          checked={val}
          onChange={() => handleToggleActive(record)}
          checkedChildren={<CheckCircleOutlined />}
          unCheckedChildren={<CloseCircleOutlined />}
        />
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 140,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="Edit">
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          </Tooltip>
          <Popconfirm
            title="Delete this workflow?"
            onConfirm={() => handleDelete(record.id)}
            okButtonProps={{ danger: true }}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const projectConfigColumns = [
    {
      title: 'Role Name',
      dataIndex: 'role_name',
      key: 'role_name',
      width: 250,
      render: (text) => <strong>{text}</strong>
    },
    {
      title: 'Indent Approve',
      dataIndex: 'indent_approve',
      key: 'indent_approve',
      align: 'center',
      render: (val, record) => (
        <Checkbox
          checked={val}
          onChange={(e) => handleCheckboxChange(record.role_id, 'indent_approve', e.target.checked)}
        />
      )
    },
    {
      title: 'Indent View',
      dataIndex: 'indent_view',
      key: 'indent_view',
      align: 'center',
      render: (val, record) => (
        <Checkbox
          checked={val}
          onChange={(e) => handleCheckboxChange(record.role_id, 'indent_view', e.target.checked)}
        />
      )
    },
    {
      title: 'Material Distribution Workflow',
      dataIndex: 'dispatch_approve',
      key: 'dispatch_approve',
      align: 'center',
      render: (val, record) => (
        <Checkbox
          checked={val}
          onChange={(e) => handleCheckboxChange(record.role_id, 'dispatch_approve', e.target.checked)}
        />
      )
    },
    {
      title: 'Dispatch View (Material Distribution)',
      dataIndex: 'dispatch_view',
      key: 'dispatch_view',
      align: 'center',
      render: (val, record) => (
        <Checkbox
          checked={val}
          onChange={(e) => handleCheckboxChange(record.role_id, 'dispatch_view', e.target.checked)}
        />
      )
    }
  ];

  const tabItems = [
    {
      key: 'standard',
      label: 'Standard Workflows',
      children: (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
              Create Workflow
            </Button>
          </div>
          <DataTable
            key={refreshKey}
            columns={columns}
            fetchFunction={fetchWorkflows}
            rowKey="id"
            searchPlaceholder="Search by workflow name, module..."
            exportFileName="approval_workflows"
            scroll={{ x: 1100 }}
          />
        </div>
      )
    },
    {
      key: 'project-hierarchy',
      label: 'Indent & Dispatch Config (Position-Reporting)',
      children: (
        <Card title="Project-Based Workflow Configuration (Hierarchical Matrix)" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
            <span>Select Project:</span>
            <Select
              style={{ width: 350 }}
              options={projects}
              value={selectedProject}
              onChange={setSelectedProject}
              placeholder="Select project"
              showSearch
              optionFilterProp="label"
            />
            <Button type="primary" onClick={handleSaveConfig} loading={savingConfig}>
              Save Configuration
            </Button>
          </div>
          <Table
            loading={loadingConfig}
            dataSource={configData}
            columns={projectConfigColumns}
            rowKey="role_id"
            pagination={false}
            bordered
            size="middle"
          />
        </Card>
      )
    }
  ];

  return (
    <div>
      <PageHeader title="Workflow Configuration" subtitle="Manage approval workflows and levels" />
      <Tabs defaultActiveKey="standard" items={tabItems} style={{ padding: '0 24px' }} />
    </div>
  );
};

export default WorkflowConfig;
