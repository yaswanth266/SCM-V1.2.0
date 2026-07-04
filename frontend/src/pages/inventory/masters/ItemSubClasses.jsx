import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button, Modal, Form, Input, Space, Popconfirm, Switch, message, Select, Row, Col, Card
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import PageHeader from '../../../components/PageHeader';
import DataTable from '../../../components/DataTable';
import StatusTag from '../../../components/StatusTag';
import api from '../../../config/api';
import { getErrorMessage } from '../../../utils/helpers';

const ItemSubClasses = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialClassId = searchParams.get('item_type_id') ? parseInt(searchParams.get('item_type_id'), 10) : null;

  const [modalOpen, setModalOpen] = useState(false);
  const [editingRow, setEditingRow] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedClassId, setSelectedClassId] = useState(initialClassId);
  const [itemClasses, setItemClasses] = useState([]);

  useEffect(() => {
    const fetchClasses = async () => {
      try {
        const res = await api.get('/masters/item-types', { params: { page_size: 1000 } });
        const data = res.data?.items || res.data?.data || res.data || [];
        setItemClasses(data);
      } catch (err) {
        message.error('Failed to load item classes');
      }
    };
    fetchClasses();
  }, []);

  const fetchItemSubClasses = async (params) => {
    const finalParams = { ...params };
    if (selectedClassId) {
      finalParams.item_type_id = selectedClassId;
    }
    return api.get('/masters/item-sub-classes', { params: finalParams });
  };

  const handleAdd = () => {
    setEditingRow(null);
    form.resetFields();
    form.setFieldsValue({ 
      is_active: true,
      item_type_id: selectedClassId || undefined
    });
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
      await api.delete(`/masters/item-sub-classes/${id}`);
      message.success('Item sub class deactivated');
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
        await api.put(`/masters/item-sub-classes/${editingRow.id}`, values);
        message.success('Item sub class updated');
      } else {
        await api.post('/masters/item-sub-classes', values);
        message.success('Item sub class created');
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

  const formatClassName = (name) => {
    if (!name) return '';
    return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  };

  const columns = [
    { title: 'Sub Class Code', dataIndex: 'code', width: 150 },
    { title: 'Sub Class Name', dataIndex: 'name', width: 200 },
    { title: 'Parent Class', dataIndex: 'item_type_name', render: (v) => formatClassName(v) },
    { title: 'Inventory', dataIndex: 'inventory', width: 100 },
    { title: 'Depreciation', dataIndex: 'depreciation', width: 120 },
    { title: 'Example', dataIndex: 'example', ellipsis: true },
    { title: 'Active', dataIndex: 'is_active', width: 100, render: (v) => <StatusTag status={v ? 'active' : 'inactive'} /> },
    {
      title: 'Actions',
      width: 120,
      render: (_, r) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)} />
          <Popconfirm title="Deactivate this item sub class?" onConfirm={() => handleDelete(r.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Item Sub Classes" subtitle="Item sub class master — childs to item classes">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Add Sub Class</Button>
      </PageHeader>

      <Card style={{ marginBottom: 16 }}>
        <Row gutter={16} align="middle">
          <Col>
            <strong>Filter by Parent Class:</strong>
          </Col>
          <Col>
            <Select
              placeholder="Select parent class"
              style={{ width: 250 }}
              allowClear
              value={selectedClassId}
              onChange={(value) => {
                setSelectedClassId(value);
                setSearchParams(value ? { item_type_id: value } : {});
                setRefreshKey((k) => k + 1);
              }}
              options={itemClasses.map((c) => ({
                label: formatClassName(c.name),
                value: c.id
              }))}
            />
          </Col>
        </Row>
      </Card>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchItemSubClasses}
        rowKey="id"
        searchPlaceholder="Search by name, code or description..."
        exportFileName="item_sub_classes"
      />

      <Modal
        title={editingRow ? 'Edit Item Sub Class' : 'Add Item Sub Class'}
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
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="item_type_id"
            label="Parent Class"
            rules={[{ required: true, message: 'Parent class is required' }]}
          >
            <Select
              placeholder="Select parent class"
              options={itemClasses.map((c) => ({
                label: formatClassName(c.name),
                value: c.id
              }))}
            />
          </Form.Item>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="code"
                label="Sub Class Code"
                rules={[{ required: true, message: 'Code is required' }]}
              >
                <Input placeholder="e.g. AST" maxLength={50} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="name"
                label="Sub Class Name"
                rules={[{ required: true, message: 'Name is required' }]}
              >
                <Input placeholder="e.g. Asset" maxLength={255} />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="inventory" label="Inventory">
                <Select
                  placeholder="e.g. Yes"
                  options={[
                    { label: 'Yes', value: 'Yes' },
                    { label: 'No', value: 'No' },
                    { label: 'Optional', value: 'Optional' }
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="depreciation" label="Depreciation">
                <Select
                  placeholder="e.g. Yes"
                  options={[
                    { label: 'Yes', value: 'Yes' },
                    { label: 'No', value: 'No' },
                    { label: 'Usually No', value: 'Usually No' },
                    { label: 'Depends', value: 'Depends' },
                    { label: 'Sometimes', value: 'Sometimes' },
                    { label: 'Yes/Amortized', value: 'Yes/Amortized' }
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="example" label="Examples">
            <Input placeholder="e.g. Ambulance, Laptop, ECG Machine" />
          </Form.Item>

          <Form.Item name="is_active" label="Active" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default ItemSubClasses;
