import React, { useState } from 'react';
import {
  Button, Modal, Form, Input, Space, Popconfirm, Switch, message,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import PageHeader from '../../../components/PageHeader';
import DataTable from '../../../components/DataTable';
import StatusTag from '../../../components/StatusTag';
import api from '../../../config/api';
import { getErrorMessage } from '../../../utils/helpers';

const Vehicles = () => {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRow, setEditingRow] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchVehicles = async (params) => {
    return api.get('/masters/vehicles', { params });
  };

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
      await api.delete(`/masters/vehicles/${id}`);
      message.success('Vehicle deleted');
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
        await api.put(`/masters/vehicles/${editingRow.id}`, values);
        message.success('Vehicle updated');
      } else {
        await api.post('/masters/vehicles', values);
        message.success('Vehicle created');
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
    { title: 'Vehicle Code', dataIndex: 'vehicle_code', width: 200 },
    { title: 'Vehicle Registration Number', dataIndex: 'vehicle_number' },
    { title: 'Active', dataIndex: 'is_active', width: 120, render: (v) => <StatusTag status={v ? 'active' : 'inactive'} /> },
    {
      title: 'Actions',
      width: 120,
      render: (_, r) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)} />
          <Popconfirm title="Delete this vehicle?" onConfirm={() => handleDelete(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Vehicles" subtitle="Vehicle master — referenced by indents and gate entries">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Add Vehicle</Button>
      </PageHeader>
      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchVehicles}
        rowKey="id"
        searchPlaceholder="Search by code or number..."
        exportFileName="vehicles"
      />
      <Modal
        title={editingRow ? 'Edit Vehicle' : 'Add Vehicle'}
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
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="vehicle_code" label="Vehicle Code" rules={[{ required: true, message: 'Vehicle Code is required' }]}>
            <Input placeholder="e.g. V001" />
          </Form.Item>
          <Form.Item name="vehicle_number" label="Vehicle Registration Number" rules={[{ required: true, message: 'Vehicle Registration Number is required' }]}>
            <Input placeholder="e.g. AP 39 UX 1234" />
          </Form.Item>
          <Form.Item name="is_active" label="Active" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Vehicles;
