import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Space, Tooltip, Tag, App } from 'antd';
import { PlusOutlined, EditOutlined } from '@ant-design/icons';
import PageHeader from '../../../components/PageHeader';
import DataTable from '../../../components/DataTable';
import { formatDate } from '../../../utils/helpers';
import api from '../../../config/api';

const ProjectIndentTemplateList = ({ title = "Template Master for DP Project" }) => {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchTemplates = async (params) => {
    return api.get('/masters/project-indent-templates/list', {
      params,
    });
  };

  const handleConfigure = () => {
    navigate('/inventory/masters/project-templates/new');
  };

  const handleEdit = (record) => {
    navigate(`/inventory/masters/project-templates/edit/${record.id}`);
  };

  const columns = [
    {
      title: 'Project Name',
      dataIndex: 'project_name',
      key: 'project_name',
      sorter: true,
      render: (text, record) => (
        <a onClick={() => handleEdit(record)} style={{ fontWeight: 600, color: '#096dd9' }}>
          {text || 'N/A'}
        </a>
      ),
    },
    {
      title: 'Template Name',
      dataIndex: 'template_name',
      key: 'template_name',
      width: 220,
      render: (text) => (
        <Tag color="blue" style={{ fontSize: 13, padding: '4px 8px', fontWeight: 600 }}>
          {text}
        </Tag>
      ),
    },
    {
      title: 'Project Code',
      dataIndex: 'project_code',
      key: 'project_code',
      width: 150,
      render: (text) => text || '-',
    },
    {
      title: 'Configured Items',
      dataIndex: 'items_count',
      key: 'items_count',
      width: 180,
      align: 'center',
      render: (count) => (
        <span style={{ fontWeight: 'bold', color: count > 0 ? '#52c41a' : '#faad14' }}>
          {count} Item(s)
        </span>
      ),
    },
    {
      title: 'Last Updated',
      dataIndex: 'updated_at',
      key: 'updated_at',
      width: 180,
      render: (date) => formatDate(date),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 100,
      align: 'center',
      render: (_, record) => (
        <Space size="middle">
          <Tooltip title="Edit template items">
            <Button
              type="primary"
              ghost
              size="small"
              icon={<EditOutlined />}
              onClick={() => handleEdit(record)}
            />
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={title}
        subtitle="Manage master item templates with fixed quantities for DP projects"
      >
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleConfigure}
        >
          Create Template Master
        </Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchTemplates}
        rowKey="id"
        searchPlaceholder="Search by template name, project name or code..."
        exportFileName="dp_project_templates"
      />
    </div>
  );
};

export default ProjectIndentTemplateList;
