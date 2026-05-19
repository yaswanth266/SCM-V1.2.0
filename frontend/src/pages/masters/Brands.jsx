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

const Brands = () => {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRow, setEditingRow] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchBrands = async (params) => api.get('/masters/brands', { params });

  const handleAdd = () => {
    setEditingRow(null);
    form.resetFields();
    form.setFieldsValue({ is_active: true });
    setModalOpen(true);
  };

  const handleEdit = (record) => {
    setEditingRow(record);
    // BUG-FE-133: ensure is_active is hydrated even if backend omits it (rare)
    form.setFieldsValue({
      ...record,
      is_active: record.is_active !== false,
    });
    setModalOpen(true);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/masters/brands/${id}`);
      message.success('Brand deactivated');
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
        await api.put(`/masters/brands/${editingRow.id}`, values);
        message.success('Brand updated');
      } else {
        await api.post('/masters/brands', values);
        message.success('Brand created');
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
    { title: 'Code', dataIndex: 'code', width: 160 },
    { title: 'Name', dataIndex: 'name' },
    { title: 'Description', dataIndex: 'description', ellipsis: true },
    { title: 'Active', dataIndex: 'is_active', width: 100, render: (v) => <StatusTag status={v ? 'active' : 'inactive'} /> },
    {
      title: 'Actions',
      width: 120,
      render: (_, r) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)} />
          <Popconfirm title="Deactivate this brand?" onConfirm={() => handleDelete(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Brands" subtitle="Brand master — referenced by items">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Add Brand</Button>
      </PageHeader>
      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchBrands}
        rowKey="id"
        searchPlaceholder="Search by code or name..."
        exportFileName="brands"
      />
      <Modal
        title={editingRow ? 'Edit Brand' : 'Add Brand'}
        open={modalOpen}
        // BUG-FE-027: disable cancel/X-close while a save is in flight to
        // prevent the user from dismissing a half-submitted modal.
        // BUG-FE-132: also clear editingRow so the next "Add" doesn't bleed
        // the previous edit row's id into the create flow.
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
          <Form.Item name="code" label="Code" rules={[{ required: true, message: 'Code is required' }]}>
            <Input placeholder="e.g. BRND-DOLO" />
          </Form.Item>
          <Form.Item name="name" label="Brand Name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="e.g. Dolo" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          {/* BUG-FE-028 / BUG-FE-133: expose Active toggle in the modal so the
              status read into the form can actually be edited. */}
          <Form.Item name="is_active" label="Active" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Brands;

