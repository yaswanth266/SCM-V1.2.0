import React, { useState, useEffect } from 'react';
import {
  Card, Button, Modal, Form, Input, Select, Space, Popconfirm, message,
  Table, DatePicker, Alert, Typography, Divider, Tree, Spin
} from 'antd';
import { PlusOutlined, DeleteOutlined, CopyOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';
import dayjs from 'dayjs';

const { Text, Paragraph } = Typography;

const buildRoleTree = (roles = [], query = '') => {
  return roles
    .filter((role) => {
      if (!query) return true;
      const q = query.toLowerCase();
      return (
        String(role.name || '').toLowerCase().includes(q) ||
        String(role.code || '').toLowerCase().includes(q)
      );
    })
    .map((role) => ({
      key: `role-${role.id}`,
      title: `${role.code ? `[${role.code}] ` : ''}${role.name || ''}`,
      isLeaf: true,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
};

const SCOPE_OPTIONS = [
  {
    label: 'Masters',
    options: [
      { label: 'Items (Read)', value: 'masters:items:read' },
      { label: 'Packaging (Read)', value: 'masters:packaging:read' },
      { label: 'Categories (Read)', value: 'masters:categories:read' },
      { label: 'Vendors (Read)', value: 'masters:vendors:read' },
      { label: 'Vendor Mapping (Read)', value: 'masters:vendor-mapping:read' },
      { label: 'User Mapping (Read)', value: 'masters:user-mapping:read' },
      { label: 'Warehouses (Read)', value: 'masters:warehouses:read' },
      { label: 'UOM (Read)', value: 'masters:uom:read' },
      { label: 'Brands (Read)', value: 'masters:brands:read' },
      { label: 'Features (Read)', value: 'masters:features:read' },
      { label: 'Item Types (Read)', value: 'masters:item-types:read' },
      { label: 'Attributes (Read)', value: 'masters:attributes:read' },
      { label: 'Attribute Mapping (Read)', value: 'masters:attribute-mapping:read' },
      { label: 'Specs (Read)', value: 'masters:specs:read' },
      { label: 'Users (Read)', value: 'masters:users:read' },
      { label: 'User Groups (Read)', value: 'masters:user-groups:read' },
      { label: 'Org Structure (Read)', value: 'masters:org-structure:read' },
      { label: 'Price Lists (Read)', value: 'masters:price-lists:read' },
    ]
  },
  {
    label: 'Inventory',
    options: [
      { label: 'Stock Balance (Read)', value: 'inventory:stock-balance:read' },
      { label: 'Stock Ledger (Read)', value: 'inventory:stock-ledger:read' },
      { label: 'Stock Transfer (Read)', value: 'inventory:stock-transfer:read' },
      { label: 'Stock Audit (Read)', value: 'inventory:stock-audit:read' },
      { label: 'Replenishment (Read)', value: 'inventory:replenishment:read' },
    ]
  }
];

const ApiKeys = () => {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [revealModalOpen, setRevealModalOpen] = useState(false);
  const [newRawKey, setNewRawKey] = useState(null);
  
  const [scopeOptions, setScopeOptions] = useState(SCOPE_OPTIONS);
  const [treeData, setTreeData] = useState({ roles: [] });
  const [treeLoading, setTreeLoading] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [roleSearch, setRoleSearch] = useState('');
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySearch, setHistorySearch] = useState('');

  const formatItemTypeName = (name) => {
    if (!name) return '';
    return name
      .split(/[-_ ]+/)
      .map(word => {
        if (word.toLowerCase() === 'it') return 'IT';
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(' ');
  };

  const fetchItemTypes = async () => {
    try {
      const res = await api.get('/masters/item-types', { params: { page: 1, page_size: 200 } });
      const types = res.data?.items || [];
      const activeTypes = types.filter(t => t.is_active);
      
      const stockBalanceOptions = [
        { label: 'Stock Balance (All - Read)', value: 'inventory:stock-balance:read' }
      ];
      
      activeTypes.forEach(t => {
        const formatted = formatItemTypeName(t.name);
        stockBalanceOptions.push({
          label: `Stock Balance - ${formatted} (Serial - Read)`,
          value: `inventory:stock-balance:${t.name}:serial:read`
        });
        stockBalanceOptions.push({
          label: `Stock Balance - ${formatted} (Non-Serial - Read)`,
          value: `inventory:stock-balance:${t.name}:non-serial:read`
        });
      });
      
      const updatedOptions = SCOPE_OPTIONS.map(group => {
        if (group.label === 'Inventory') {
          return {
            ...group,
            options: [
              ...stockBalanceOptions,
              ...group.options.filter(opt => opt.value !== 'inventory:stock-balance:read')
            ]
          };
        }
        return group;
      });
      
      setScopeOptions(updatedOptions);
    } catch (err) {
      console.error('Failed to fetch item types for scopes:', err);
      setScopeOptions(SCOPE_OPTIONS);
    }
  };

  useEffect(() => {
    fetchKeys();
    fetchItemTypes();
  }, []);

  const fetchTreeData = async () => {
    setTreeLoading(true);
    try {
      const res = await api.get('/masters/user-material-mapping/tree');
      setTreeData(res.data || {});
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setTreeLoading(false);
    }
  };

  const loadHistory = async (search = '') => {
    setHistoryLoading(true);
    try {
      const res = await api.get('/masters/user-material-mappings', {
        params: { page: 1, page_size: 1000, search: search || undefined },
      });
      
      const rawItems = res.data?.items || [];
      const grouped = new Map();
      
      rawItems.forEach((item) => {
        if (!grouped.has(item.role_id)) {
          grouped.set(item.role_id, {
            id: `role-${item.role_id}`,
            isRoleRow: true,
            role_name: item.role_name,
            role_code: item.role_code,
            children: [],
          });
        }
        grouped.get(item.role_id).children.push(item);
      });
      
      setHistory(Array.from(grouped.values()));
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setHistoryLoading(false);
    }
  };

  const fetchKeys = async () => {
    setLoading(true);
    try {
      const res = await api.get('/api-keys');
      setKeys(res.data || []);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = () => {
    form.resetFields();
    setSelectedKeys([]);
    setRoleSearch('');
    setHistorySearch('');
    setModalOpen(true);
    if (!treeData.roles?.length) {
      fetchTreeData();
    }
    if (!history.length) {
      loadHistory();
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/api-keys/${id}`);
      message.success('API Key revoked successfully');
      fetchKeys();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      
      const payload = {
        name: values.name,
        scopes: values.scopes || [],
        expires_at: values.expires_at ? values.expires_at.toISOString() : null,
        linked_role_ids: selectedKeys.filter(k => k.startsWith('role-')).map(k => parseInt(k.replace('role-', ''))),
      };

      setSubmitting(true);
      const res = await api.post('/api-keys', payload);
      
      setModalOpen(false);
      form.resetFields();
      
      // Show the raw key
      setNewRawKey(res.data.raw_key);
      setRevealModalOpen(true);
      
      fetchKeys();
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyKey = () => {
    navigator.clipboard.writeText(newRawKey).then(() => {
      message.success('API Key copied to clipboard');
    }).catch(() => {
      message.error('Failed to copy API Key');
    });
  };

  const columns = [
    { title: 'Name', dataIndex: 'name', key: 'name', width: 200 },
    { 
      title: 'Scopes', 
      dataIndex: 'scopes', 
      key: 'scopes', 
      width: 200,
      render: (scopes) => scopes?.join(', ') || 'None'
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 150,
      render: (val) => val ? dayjs(val).format('YYYY-MM-DD HH:mm') : '-',
    },
    {
      title: 'Expires',
      dataIndex: 'expires_at',
      key: 'expires_at',
      width: 150,
      render: (val) => val ? dayjs(val).format('YYYY-MM-DD HH:mm') : 'Never',
    },
    {
      title: 'Last Used',
      dataIndex: 'last_used_at',
      key: 'last_used_at',
      width: 150,
      render: (val) => val ? dayjs(val).format('YYYY-MM-DD HH:mm') : 'Never',
    },
    {
      title: 'Status',
      key: 'status',
      width: 100,
      render: (_, record) => {
        if (!record.is_active) return <StatusTag status="inactive" />;
        if (record.expires_at && dayjs(record.expires_at).isBefore(dayjs())) {
          return <StatusTag status="expired" />;
        }
        return <StatusTag status="active" />;
      }
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      render: (_, record) => (
        <Popconfirm
          title="Revoke this API Key?"
          description="This action cannot be undone. Systems using this key will lose access immediately."
          onConfirm={() => handleDelete(record.id)}
          okText="Revoke"
          okButtonProps={{ danger: true }}
          icon={<ExclamationCircleOutlined style={{ color: 'red' }} />}
        >
          <Button type="link" danger icon={<DeleteOutlined />}>Revoke</Button>
        </Popconfirm>
      ),
    },
  ];

  const historyColumns = [
    {
      title: 'Role / Target Name',
      dataIndex: 'target_name',
      render: (value, row) => {
        if (row.isRoleRow) {
          return (
            <Space size={6}>
              <Text strong>{row.role_code ? `[${row.role_code}]` : ''}</Text>
              <Text type="secondary">{row.role_name}</Text>
            </Space>
          );
        }
        return (
          <Space size={6}>
            <Text>{row.target_code || '-'}</Text>
            <Text type="secondary">{value || '-'}</Text>
          </Space>
        );
      },
    },
    { 
      title: 'Target Type', 
      dataIndex: 'entity_type', 
      width: 150, 
      render: (value, row) => row.isRoleRow ? null : (value === 'item_category' ? 'Category' : 'Item') 
    },
    { 
      title: 'Permission', 
      dataIndex: 'action', 
      width: 150, 
      render: (value, row) => row.isRoleRow ? null : <Typography.Text type="secondary" style={{ textTransform: 'uppercase' }}>{String(value || '')}</Typography.Text>
    },
  ];

  return (
    <div>
      <PageHeader title="API Keys" subtitle="Manage API keys for external access">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          Generate New Key
        </Button>
      </PageHeader>

      <Card>
        <Table
          columns={columns}
          dataSource={keys}
          loading={loading}
          rowKey="id"
          pagination={false}
          scroll={{ x: 'max-content' }}
        />
      </Card>

      <Modal
        title="Generate New API Key"
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => { setModalOpen(false); form.resetFields(); setSelectedKeys([]); }}
        confirmLoading={submitting}
        okText="Generate"
        destroyOnHidden
        width={700}
      >
        <Spin spinning={treeLoading}>
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item 
            name="name" 
            label="Key Name" 
            rules={[{ required: true, message: 'Please provide a name to identify this key' }]}
            extra="Example: External Inventory Integration"
          >
            <Input placeholder="e.g. ERP Integration" />
          </Form.Item>
          <Form.Item 
            name="scopes" 
            label="Scopes" 
            rules={[{ required: true, message: 'Please select at least one scope' }]}
          >
            <Select
              mode="multiple"
              placeholder="Select permissions for this key"
              options={scopeOptions}
            />
          </Form.Item>
          <Form.Item 
            name="expires_at" 
            label="Expiration Date (Optional)"
            extra="Leave empty for a non-expiring key"
          >
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          
          <Divider>Data Filtering</Divider>
          <Paragraph type="secondary">
            Select roles to restrict this API Key's access only to the items and materials mapped to those roles. If no roles are selected, no filtering is applied.
          </Paragraph>
          <Input.Search 
            placeholder="Search roles..." 
            onChange={(e) => setRoleSearch(e.target.value)}
            style={{ marginBottom: 16 }}
            allowClear
          />
          <div style={{ height: 300, overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 4, padding: 8 }}>
            <Tree
              checkable
              checkedKeys={selectedKeys}
              onCheck={(keys) => setSelectedKeys(keys)}
              treeData={buildRoleTree(treeData.roles || [], roleSearch.trim())}
              height={280}
            />
          </div>

          <Divider>Mapping History</Divider>
          <Paragraph type="secondary">
            Review existing mappings below to confirm what access the selected roles have before generating the key.
          </Paragraph>
          <Input.Search 
            placeholder="Search history by role or item..." 
            value={historySearch}
            onChange={(e) => setHistorySearch(e.target.value)}
            onSearch={loadHistory}
            style={{ marginBottom: 16 }}
            allowClear
          />
          <Table
            columns={historyColumns}
            dataSource={history}
            rowKey="id"
            loading={historyLoading}
            size="small"
            pagination={{ pageSize: 10, showSizeChanger: false }}
            scroll={{ x: 'max-content' }}
          />
        </Form>
        </Spin>
      </Modal>

      <Modal
        title={
          <Space>
            <ExclamationCircleOutlined style={{ color: '#faad14' }} />
            <span>Save Your New API Key</span>
          </Space>
        }
        open={revealModalOpen}
        onCancel={() => { setRevealModalOpen(false); setNewRawKey(null); }}
        footer={[
          <Button key="close" type="primary" onClick={() => { setRevealModalOpen(false); setNewRawKey(null); }}>
            I have saved the key
          </Button>
        ]}
        maskClosable={false}
        closable={false}
      >
        <Alert
          message="Important"
          description="Please copy your API key and save it securely. For security reasons, you will NOT be able to see it again after closing this window."
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
        />
        
        <div style={{ background: '#f5f5f5', padding: '16px', borderRadius: '4px', position: 'relative' }}>
          <Paragraph style={{ margin: 0, fontFamily: 'monospace', fontSize: '16px', wordBreak: 'break-all', paddingRight: '32px' }}>
            {newRawKey}
          </Paragraph>
          <Button 
            icon={<CopyOutlined />} 
            type="text" 
            style={{ position: 'absolute', top: '12px', right: '8px' }}
            onClick={handleCopyKey}
          />
        </div>
      </Modal>
    </div>
  );
};

export default ApiKeys;
