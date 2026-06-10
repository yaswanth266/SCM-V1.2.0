import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Space, Popconfirm, message, Tag
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const documentTypeOptions = [
  { label: 'Indent', value: 'Indent' },
  { label: 'Material issue', value: 'Material issue' },
];

const BOMs = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchBOMs = async (params) => {
    return api.get('/masters/boms', { params });
  };

  const handleAdd = () => {
    navigate('/masters/boms/new');
  };

  const handleEdit = (record) => {
    navigate(`/masters/boms/${record.id}/edit`);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/masters/boms/${id}`);
      message.success('BOM deleted successfully');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    { title: 'BOM Code', dataIndex: 'bom_code', width: 180, render: (text, record) => <a onClick={() => handleEdit(record)}>{text}</a> },
    { title: 'BOM Name', dataIndex: 'name' },
    { title: 'Project', dataIndex: 'project_name', render: (text) => text || '-' },
    {
      title: 'Document Types',
      dataIndex: 'document_types',
      render: (types) => (
        <>
          {(types || []).map((type) => {
            let color = type === 'Indent' ? 'blue' : 'purple';
            return (
              <Tag color={color} key={type}>
                {type}
              </Tag>
            );
          })}
        </>
      ),
    },
    { title: 'Active', dataIndex: 'is_active', width: 100, render: (v) => <StatusTag status={v ? 'active' : 'inactive'} /> },
    {
      title: 'Actions',
      width: 120,
      render: (_, r) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)} />
          <Popconfirm title="Delete this BOM?" onConfirm={() => handleDelete(r.id)} okButtonProps={{ danger: true }}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="BOM (Bill of Materials)" subtitle="Manage BOM master definitions for Indents and Material Issues">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Add BOM</Button>
      </PageHeader>
      
      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchBOMs}
        rowKey="id"
        searchPlaceholder="Search by BOM code or name..."
        exportFileName="bill_of_materials"
      />


    </div>
  );
};

export default BOMs;
