import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, Switch, Card,
  Popconfirm, message, Row, Col, Table, Divider, Typography, Tooltip, Tag,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, MinusCircleOutlined,
  ArrowUpOutlined, ArrowDownOutlined, CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const { Text } = Typography;

const MODULE_OPTIONS = [
  { label: 'Procurement', value: 'procurement' },
  { label: 'Indent', value: 'indent' },
  { label: 'Warehouse', value: 'warehouse' },
];

const DOC_TYPE_MAP = {
  procurement: [
    { label: 'Material Request', value: 'material_request' },
    { label: 'Purchase Order', value: 'purchase_order' },
    { label: 'Quotation', value: 'quotation' },
    { label: 'Auto Reorder', value: 'auto_reorder' },
  ],
  indent: [
    { label: 'Indent', value: 'indent' },
    { label: 'Indent Return', value: 'indent_return' },
  ],
  warehouse: [
    { label: 'Stock Transfer', value: 'stock_transfer' },
    { label: 'GRN', value: 'grn' },
    { label: 'Stock Adjustment', value: 'stock_adjustment' },
  ],
};

const WorkflowConfig = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchWorkflows = useCallback(
    async (params) => {
      return await api.get('/approvals/workflows', { params });
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

  return (
    <div>
      <PageHeader title="Workflow Configuration" subtitle="Manage approval workflows and levels">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          Create Workflow
        </Button>
      </PageHeader>

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
  );
};

export default WorkflowConfig;

