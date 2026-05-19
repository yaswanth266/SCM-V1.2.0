import React, { useEffect, useState } from 'react';
import {
  Button, Modal, Form, Input, Space, Popconfirm, Switch, Select, message,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const Features = () => {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRow, setEditingRow] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [categories, setCategories] = useState([]);
  const [form] = Form.useForm();

  const fetchFeatures = async (params) => api.get('/masters/features', {
    params: { ...params, include_inactive: true },
  });

  const loadCategories = async () => {
    try {
      const res = await api.get('/masters/categories', { params: { page_size: 500 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setCategories(items.map((c) => ({ label: c.name, value: c.id })));
    } catch {
      setCategories([]);
    }
  };

  useEffect(() => {
    loadCategories();
  }, []);

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
      await api.delete(`/masters/features/${id}`);
      message.success('Feature deactivated');
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
        await api.put(`/masters/features/${editingRow.id}`, values);
        message.success('Feature updated');
      } else {
        await api.post('/masters/features', values);
        message.success('Feature created');
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
    { title: 'Feature Name', dataIndex: 'name', key: 'name' },
    { title: 'Category', dataIndex: 'category_name', key: 'category_name', render: (v) => v || '-' },
    {
      title: 'Active',
      dataIndex: 'is_active',
      key: 'is_active',
      width: 100,
      render: (v) => <StatusTag status={v ? 'active' : 'inactive'} />,
    },
    {
      title: 'Actions',
      width: 120,
      render: (_, r) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)} />
          <Popconfirm title="Deactivate this feature?" onConfirm={() => handleDelete(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Features" subtitle="Manage category-linked feature master">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Add Feature</Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchFeatures}
        rowKey="id"
        searchPlaceholder="Search feature..."
        exportFileName="features"
      />

      <Modal
        title={editingRow ? 'Edit Feature' : 'Add Feature'}
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
          <Form.Item
            name="category_id"
            label="Category"
            rules={[{ required: true, message: 'Category is required' }]}
          >
            <Select showSearch optionFilterProp="label" options={categories} placeholder="Select category" />
          </Form.Item>
          <Form.Item
            name="name"
            label="Feature Name"
            rules={[{ required: true, message: 'Feature name is required' }]}
          >
            <Input placeholder="Enter feature name" />
          </Form.Item>
          <Form.Item name="is_active" label="Active" valuePropName="checked" initialValue>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Features;

