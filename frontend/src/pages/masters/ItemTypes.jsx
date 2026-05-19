import React, { useState } from 'react';
import {
  Button, Modal, Form, Input, Space, Popconfirm, Switch, message,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const ItemTypes = () => {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRow, setEditingRow] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchItemTypes = async (params) => api.get('/masters/item-types', { params });

  const handleAdd = () => {
    setEditingRow(null);
    form.resetFields();
    form.setFieldsValue({ is_active: true });
    setModalOpen(true);
  };

  const handleEdit = (record) => {
    setEditingRow(record);
    form.setFieldsValue({
      ...record,
      is_active: record.is_active !== false,
    });
    setModalOpen(true);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/masters/item-types/${id}`);
      message.success('Item type deactivated');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      if (editingRow) {
        await api.put(`/masters/item-types/${editingRow.id}`, values);
        message.success('Item type updated');
      } else {
        await api.post('/masters/item-types', values);
        message.success('Item type created');
      }
      setModalOpen(false);
      form.resetFields();
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const columns = [
    { title: 'Name', dataIndex: 'name', render: (v) => (v || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) },
    { title: 'Description', dataIndex: 'description', ellipsis: true },
    { title: 'Active', dataIndex: 'is_active', width: 100, render: (v) => <StatusTag status={v ? 'active' : 'inactive'} /> },
    {
      title: 'Actions',
      width: 120,
      render: (_, r) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)} />
          <Popconfirm title="Deactivate this item type?" onConfirm={() => handleDelete(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Item Types" subtitle="Item type master — referenced by items">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Add Item Type</Button>
      </PageHeader>
      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchItemTypes}
        rowKey="id"
        searchPlaceholder="Search by name..."
        exportFileName="item_types"
      />
      <Modal
        title={editingRow ? 'Edit Item Type' : 'Add Item Type'}
        open={modalOpen}
        onCancel={() => {
          if (submitting) return;
          setModalOpen(false);
          setEditingRow(null);
          form.resetFields();
        }}
        cancelButtonProps={{ disabled: submitting }}
        closable={!submitting}
        maskClosable={!submitting}
        keyboard={!submitting}
        onOk={handleSubmit}
        confirmLoading={submitting}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Type Name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="e.g. medicine" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="is_active" label="Active" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default ItemTypes;

