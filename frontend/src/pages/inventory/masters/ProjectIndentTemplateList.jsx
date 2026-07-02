import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Space, message, Tooltip } from 'antd';
import { PlusOutlined, EditOutlined } from '@ant-design/icons';
import PageHeader from '../../../components/PageHeader';
import DataTable from '../../../components/DataTable';
import { formatDate } from '../../../utils/helpers';
import api from '../../../config/api';

const ProjectIndentTemplateList = ({ templateType, title }) => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchTemplates = async (params) => {
    return api.get('/masters/project-indent-templates/list', {
      params: {
        ...params,
        template_type: templateType,
      },
    });
  };

  const handleConfigure = () => {
    const routeType = templateType === 'consumables' ? 'ap104-consumables' : 'ap104-install';
    navigate(`/inventory/masters/${routeType}/new`);
  };

  const handleEdit = (record) => {
    const routeType = templateType === 'consumables' ? 'ap104-consumables' : 'ap104-install';
    navigate(`/inventory/masters/${routeType}/edit/${record.project_id}`);
  };

  const columns = [
    {
      title: 'Project Name',
      dataIndex: 'project_name',
      key: 'project_name',
      sorter: true,
      render: (text, record) => (
        <a onClick={() => handleEdit(record)} style={{ fontWeight: 600, color: '#096dd9' }}>
          {text}
        </a>
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
      title: 'Template Type',
      dataIndex: 'template_type',
      key: 'template_type',
      width: 150,
      render: (text) => (
        <span style={{ textTransform: 'capitalize', fontWeight: 500 }}>
          {text}
        </span>
      ),
    },
    {
      title: 'Total Configured Items',
      dataIndex: 'items_count',
      key: 'items_count',
      width: 200,
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
      width: 120,
      align: 'center',
      render: (_, record) => (
        <Space size="middle">
          <Tooltip title="Edit configured items">
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
        subtitle={`Manage fixed items and quantities master templates for project ${templateType}`}
      >
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleConfigure}
        >
          Configure Project Template
        </Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchTemplates}
        rowKey="id"
        searchPlaceholder="Search by project name or code..."
        exportFileName={`project_indent_templates_${templateType}`}
      />
    </div>
  );
};

export default ProjectIndentTemplateList;
