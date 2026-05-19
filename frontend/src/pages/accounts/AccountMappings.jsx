import React, { useEffect, useState, useCallback } from 'react';
import {
  Card, Table, Button, Tag, message, Modal, Form, Select, Space, Switch, Popconfirm, Tooltip,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined, InfoCircleOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const EVENT_OPTIONS = [
  { value: 'grn', label: 'GRN posted (stock received)' },
  { value: 'invoice', label: 'Invoice created (vendor bill)' },
  { value: 'payment', label: 'Payment created (settle bill)' },
  { value: 'issue', label: 'Material issue (stock out)' },
  { value: 'return', label: 'Purchase return (reverse GRN)' },
  { value: 'consumption', label: 'Consumption entry' },
  { value: 'opening_stock', label: 'Opening stock posting' },
];

const EVENT_COLORS = {
  grn: 'blue', invoice: 'gold', payment: 'green',
  issue: 'orange', return: 'red', consumption: 'purple',
  opening_stock: 'cyan',
};

export default function AccountMappings() {
  const [rows, setRows] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [m, a, c, w] = await Promise.all([
        api.get('/accounts/account-mappings'),
        api.get('/accounts/chart-of-accounts'),
        api.get('/masters/item-categories?page=1&page_size=200').catch(() => ({ data: { data: [] } })),
        api.get('/masters/warehouses?page=1&page_size=200').catch(() => ({ data: { data: [] } })),
      ]);
      setRows(m.data || []);
      setAccounts(a.data || []);
      setCategories(c.data?.data || c.data || []);
      setWarehouses(w.data?.data || w.data || []);
    } catch (e) {
      message.error(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ is_active: true });
    setModalOpen(true);
  };

  const openEdit = (row) => {
    setEditing(row);
    form.setFieldsValue({
      event: row.event,
      item_category_id: row.item_category_id,
      warehouse_id: row.warehouse_id,
      debit_account_id: row.debit_account_id,
      credit_account_id: row.credit_account_id,
      is_active: row.is_active,
    });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editing) {
        await api.put(`/accounts/account-mappings/${editing.id}`, values);
        message.success('Mapping updated');
      } else {
        await api.post('/accounts/account-mappings', values);
        message.success('Mapping created');
      }
      setModalOpen(false);
      fetchAll();
    } catch (e) {
      if (e?.errorFields) return;
      message.error(getErrorMessage(e));
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/accounts/account-mappings/${id}`);
      message.success('Mapping deleted');
      fetchAll();
    } catch (e) { message.error(getErrorMessage(e)); }
  };

  const columns = [
    {
      title: 'Event', dataIndex: 'event', key: 'event',
      render: (e) => <Tag color={EVENT_COLORS[e] || 'default'}>{e}</Tag>,
      filters: EVENT_OPTIONS.map((o) => ({ text: o.value, value: o.value })),
      onFilter: (v, r) => r.event === v,
    },
    {
      title: 'Item Category', dataIndex: 'item_category_id', key: 'cat',
      render: (id) => id ? (categories.find((c) => c.id === id)?.name || `#${id}`) : <Tag>any</Tag>,
    },
    {
      title: 'Warehouse', dataIndex: 'warehouse_id', key: 'wh',
      render: (id) => id ? (warehouses.find((w) => w.id === id)?.name || `#${id}`) : <Tag>any</Tag>,
    },
    {
      title: 'Debit Account', dataIndex: 'debit_code', key: 'd',
      render: (code, r) => code ? <span><strong>{code}</strong> {r.debit_name}</span> : '—',
    },
    {
      title: 'Credit Account', dataIndex: 'credit_code', key: 'c',
      render: (code, r) => code ? <span><strong>{code}</strong> {r.credit_name}</span> : '—',
    },
    {
      title: 'Active', dataIndex: 'is_active', key: 'a',
      render: (v) => v ? <Tag color="green">active</Tag> : <Tag>inactive</Tag>,
    },
    {
      title: 'Actions', key: 'x', width: 140,
      render: (_, row) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>Edit</Button>
          <Popconfirm title="Delete this mapping?" onConfirm={() => handleDelete(row.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Account Mappings"
        subtitle={
          <span>
            Decide which GL account is debited / credited per business event.{' '}
            <Tooltip title="Lookup precedence: (event, category, warehouse) → (event, category) → (event, warehouse) → (event, default)">
              <InfoCircleOutlined />
            </Tooltip>
          </span>
        }
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchAll}>Refresh</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>New Mapping</Button>
          </Space>
        }
      />

      <Card>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={rows}
          columns={columns}
          pagination={{ pageSize: 25, showSizeChanger: false }}
        />
      </Card>

      <Modal
        title={editing ? `Edit Mapping #${editing.id}` : 'New Account Mapping'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        width={680}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="event" label="Event" rules={[{ required: true }]}>
            <Select options={EVENT_OPTIONS} />
          </Form.Item>
          <Form.Item name="item_category_id" label="Item Category (optional — leave blank for any)">
            <Select allowClear options={categories.map((c) => ({ value: c.id, label: c.name }))} />
          </Form.Item>
          <Form.Item name="warehouse_id" label="Warehouse (optional — leave blank for any)">
            <Select allowClear options={warehouses.map((w) => ({ value: w.id, label: w.name }))} />
          </Form.Item>
          <Form.Item name="debit_account_id" label="Debit Account" rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={accounts.map((a) => ({
                value: a.id, label: `${a.account_code} — ${a.account_name} (${a.account_type})`,
              }))}
            />
          </Form.Item>
          <Form.Item name="credit_account_id" label="Credit Account" rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={accounts.map((a) => ({
                value: a.id, label: `${a.account_code} — ${a.account_name} (${a.account_type})`,
              }))}
            />
          </Form.Item>
          <Form.Item name="is_active" label="Active" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

