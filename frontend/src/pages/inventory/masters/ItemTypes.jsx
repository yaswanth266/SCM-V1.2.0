import React, { useState } from 'react';
import {
  Button, Modal, Form, Input, Space, Popconfirm, Switch, message,
} from 'antd';
import { useNavigate } from 'react-router-dom';
import { PlusOutlined, EditOutlined, DeleteOutlined, UnorderedListOutlined } from '@ant-design/icons';
import PageHeader from '../../../components/PageHeader';
import DataTable from '../../../components/DataTable';
import StatusTag from '../../../components/StatusTag';
import api from '../../../config/api';
import { getErrorMessage } from '../../../utils/helpers';

const ItemTypes = () => {
  const navigate = useNavigate();
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
      message.success('Item class deactivated');
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
        message.success('Item class updated');
      } else {
        await api.post('/masters/item-types', values);
        message.success('Item class created');
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
      width: 160,
      render: (_, r) => (
        <Space>
          <Button size="small" icon={<UnorderedListOutlined />} title="View Sub Classes" onClick={() => navigate(`/inventory/masters/item-sub-classes?item_type_id=${r.id}`)} />
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)} />
          <Popconfirm title="Deactivate this item class?" onConfirm={() => handleDelete(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Item Classes" subtitle="Item class master — referenced by items">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Add Item Class</Button>
      </PageHeader>
      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchItemTypes}
        rowKey="id"
        searchPlaceholder="Search by name..."
        exportFileName="item_classes"
      />
      <Modal
        title={editingRow ? 'Edit Item Class' : 'Add Item Class'}
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
          <Form.Item name="name" label="Class Name" rules={[{ required: true, message: 'Name is required' }]}>
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

