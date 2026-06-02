import React, { useState, useCallback, useEffect } from 'react';
import {
  Card, Button, Modal, Form, Input, Select, Space, Popconfirm, message,
  InputNumber, Table, Divider, Row, Col, DatePicker, Alert,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, SwapOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const UOM = () => {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingUom, setEditingUom] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [categoryForm] = Form.useForm();
  const [categorySubmitting, setCategorySubmitting] = useState(false);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [uomCategories, setUomCategories] = useState([]);

  // Conversions
  const [conversions, setConversions] = useState([]);
  const [convLoading, setConvLoading] = useState(false);
  const [convModalOpen, setConvModalOpen] = useState(false);
  const [editingConv, setEditingConv] = useState(null);
  const [convForm] = Form.useForm();
  const [convSubmitting, setConvSubmitting] = useState(false);
  const [uomList, setUomList] = useState([]);
  const selectedConvCategory = Form.useWatch('category_id', convForm);
  const selectedFromUom = Form.useWatch('from_uom_id', convForm);
  const selectedToUom = Form.useWatch('to_uom_id', convForm);

  const [itemConversions, setItemConversions] = useState([]);
  const [itemConvLoading, setItemConvLoading] = useState(false);
  const [itemConvModalOpen, setItemConvModalOpen] = useState(false);
  const [editingItemConv, setEditingItemConv] = useState(null);
  const [itemConvForm] = Form.useForm();
  const [itemConvSubmitting, setItemConvSubmitting] = useState(false);
  const selectedItemFromUom = Form.useWatch('from_uom_id', itemConvForm);
  const selectedItemToUom = Form.useWatch('to_uom_id', itemConvForm);

  useEffect(() => {
    fetchUOMCategories();
    fetchUOMList();
    fetchConversions();
    fetchItemConversions();
  }, [refreshKey]);

  const fetchUOMCategories = async () => {
    setCategoryLoading(true);
    try {
      const res = await api.get('/masters/uom-categories', { params: { include_inactive: true } });
      const data = res.data;
      setUomCategories(data.items || data.data || data || []);
    } catch {
      setUomCategories([]);
    } finally {
      setCategoryLoading(false);
    }
  };

  const fetchUOMList = async () => {
    try {
      const res = await api.get('/masters/uom', { params: { page_size: 500 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setUomList(items);
    } catch {
      // silent
    }
  };

  const fetchConversions = async () => {
    setConvLoading(true);
    try {
      const res = await api.get('/masters/uom-conversions', { params: { page_size: 500 } });
      const data = res.data;
      setConversions(data.items || data.data || data || []);
    } catch {
      setConversions([]);
    } finally {
      setConvLoading(false);
    }
  };

  const fetchItemConversions = async () => {
    setItemConvLoading(true);
    try {
      const res = await api.get('/masters/item-uom-conversions');
      const data = res.data;
      setItemConversions(data.items || data.data || data || []);
    } catch {
      setItemConversions([]);
    } finally {
      setItemConvLoading(false);
    }
  };

  const fetchUOMs = useCallback(async (params) => {
    return await api.get('/masters/uom', { params });
  }, []);

  const handleAdd = () => {
    setEditingUom(null);
    form.resetFields();
    form.setFieldsValue({ status: 'active', category_id: undefined });
    setModalOpen(true);
  };

  const handleEdit = (record) => {
    setEditingUom(record);
    form.setFieldsValue({
      ...record,
      status: record.is_active === false ? 'inactive' : 'active',
      category_id: record.category_id || undefined,
    });
    setModalOpen(true);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/masters/uom/${id}`);
      message.success('UOM deleted successfully');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      // BUG-FE-085: backend now accepts is_active; map status->is_active and
      // drop the legacy `status` string from the payload.
      const { status, ...rest } = values;
      const payload = {
        ...rest,
        is_active: status ? status !== 'inactive' : (rest.is_active !== false),
      };
      setSubmitting(true);
      if (editingUom) {
        await api.put(`/masters/uom/${editingUom.id}`, payload);
        message.success('UOM updated successfully');
      } else {
        await api.post('/masters/uom', payload);
        message.success('UOM created successfully');
      }
      setModalOpen(false);
      form.resetFields();
      setEditingUom(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddCategory = () => {
    setEditingCategory(null);
    categoryForm.resetFields();
    categoryForm.setFieldsValue({ status: 'active' });
    setCategoryModalOpen(true);
  };

  const handleEditCategory = (record) => {
    setEditingCategory(record);
    categoryForm.setFieldsValue({
      ...record,
      base_uom_id: record.base_uom_id || undefined,
      status: record.is_active === false ? 'inactive' : 'active',
    });
    setCategoryModalOpen(true);
  };

  const handleDeleteCategory = async (id) => {
    try {
      await api.delete(`/masters/uom-categories/${id}`);
      message.success('UOM category deactivated');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleCategorySubmit = async () => {
    try {
      const values = await categoryForm.validateFields();
      const { status, ...rest } = values;
      const payload = {
        ...rest,
        is_active: status ? status !== 'inactive' : true,
      };
      setCategorySubmitting(true);
      if (editingCategory) {
        await api.put(`/masters/uom-categories/${editingCategory.id}`, payload);
        message.success('UOM category updated');
      } else {
        await api.post('/masters/uom-categories', payload);
        message.success('UOM category created');
      }
      setCategoryModalOpen(false);
      categoryForm.resetFields();
      setEditingCategory(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setCategorySubmitting(false);
    }
  };

  // Conversion CRUD
  const handleAddConv = () => {
    setEditingConv(null);
    convForm.resetFields();
    setConvModalOpen(true);
  };

  const handleEditConv = (record) => {
    const fromUom = uomList.find((u) => u.id === (record.from_uom_id || record.from_uom?.id));
    setEditingConv(record);
    convForm.setFieldsValue({
      category_id: fromUom?.category_id || undefined,
      from_uom_id: record.from_uom_id || record.from_uom?.id,
      to_uom_id: record.to_uom_id || record.to_uom?.id,
      factor_num: Number(record.factor_num || record.conversion_factor || 1),
      factor_den: Number(record.factor_den || 1),
    });
    setConvModalOpen(true);
  };

  const handleDeleteConv = async (id) => {
    try {
      await api.delete(`/masters/uom-conversions/${id}`);
      message.success('Conversion deleted');
      fetchConversions();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleConvSubmit = async () => {
    try {
      const values = await convForm.validateFields();
      setConvSubmitting(true);
      if (editingConv) {
        await api.put(`/masters/uom-conversions/${editingConv.id}`, values);
        message.success('Conversion updated');
      } else {
        const res = await api.post('/masters/uom-conversions', values);
        message.success(res.data?.notice || 'Conversion created');
      }
      setConvModalOpen(false);
      convForm.resetFields();
      setEditingConv(null);
      fetchConversions();
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setConvSubmitting(false);
    }
  };

  const handleAddItemConv = () => {
    setEditingItemConv(null);
    itemConvForm.resetFields();
    setItemConvModalOpen(true);
  };

  const handleEditItemConv = (record) => {
    setEditingItemConv(record);
    itemConvForm.setFieldsValue({
      item_id: record.item_id,
      from_uom_id: record.from_uom_id,
      to_uom_id: record.to_uom_id,
      conversion_type: record.conversion_type,
      factor_num: Number(record.factor_num || record.conversion_factor || 1),
      factor_den: Number(record.factor_den || 1),
    });
    setItemConvModalOpen(true);
  };

  const handleDeleteItemConv = async (id) => {
    try {
      await api.delete(`/masters/item-uom-conversions/${id}`);
      message.success('Item conversion expired');
      fetchItemConversions();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleItemConvSubmit = async () => {
    try {
      const values = await itemConvForm.validateFields();
      setItemConvSubmitting(true);
      if (editingItemConv) {
        await api.put(`/masters/item-uom-conversions/${editingItemConv.id}`, values);
        message.success('Item conversion updated');
      } else {
        await api.post('/masters/item-uom-conversions', values);
        message.success('Item conversion created');
      }
      setItemConvModalOpen(false);
      itemConvForm.resetFields();
      setEditingItemConv(null);
      fetchItemConversions();
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setItemConvSubmitting(false);
    }
  };

  const columns = [
    { title: 'Name', dataIndex: 'name', key: 'name', width: 200, sorter: true },
    { title: 'Abbreviation', dataIndex: 'abbreviation', key: 'abbr', width: 120 },
    {
      title: 'Category',
      dataIndex: 'category_name',
      key: 'category',
      width: 160,
      render: (text, record) => text || uomCategories.find((c) => c.id === record.category_id)?.name || '-',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status) => <StatusTag status={status} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          <Popconfirm
            title="Delete this UOM?"
            onConfirm={() => handleDelete(record.id)}
            okText="Delete"
            okButtonProps={{ danger: true }}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const filteredUomList = selectedConvCategory
    ? uomList.filter((u) => u.category_id === selectedConvCategory)
    : uomList;

  const getUomOptions = (excludedId) => filteredUomList
    .filter((u) => u.id !== excludedId)
    .map((u) => ({
      label: `${u.name}${u.abbreviation ? ` (${u.abbreviation})` : ''}`,
      value: u.id,
    }));

  const categoryOptions = uomCategories
    .filter((c) => c.is_active !== false)
    .map((c) => ({ label: c.name, value: c.id }));

  const categoryColumns = [
    { title: 'Category', dataIndex: 'name', key: 'name', width: 180 },
    {
      title: 'Base UOM',
      dataIndex: 'base_uom_name',
      key: 'base_uom',
      width: 160,
      render: (v, r) => v ? `${v}${r.base_uom_abbreviation ? ` (${r.base_uom_abbreviation})` : ''}` : '-',
    },
    { title: 'Description', dataIndex: 'description', key: 'description', ellipsis: true, render: (v) => v || '-' },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status) => <StatusTag status={status} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEditCategory(record)} />
          <Popconfirm
            title="Deactivate this category?"
            onConfirm={() => handleDeleteCategory(record.id)}
            okText="Deactivate"
            okButtonProps={{ danger: true }}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const convColumns = [
    {
      title: 'Category',
      dataIndex: 'category_id',
      key: 'category',
      width: 150,
      render: (v) => uomCategories.find((c) => c.id === v)?.name || '-',
    },
    {
      title: 'From UOM',
      dataIndex: ['from_uom', 'name'],
      key: 'from',
      width: 180,
      render: (t, r) => {
        const fromUom = uomList.find((u) => u.id === r.from_uom_id);
        return t || fromUom?.name || r.from_uom_name || '-';
      },
    },
    {
      title: 'To UOM',
      dataIndex: ['to_uom', 'name'],
      key: 'to',
      width: 180,
      render: (t, r) => {
        const toUom = uomList.find((u) => u.id === r.to_uom_id);
        return t || toUom?.name || r.to_uom_name || '-';
      },
    },
    {
      title: 'Conversion Factor',
      dataIndex: 'conversion_factor',
      key: 'factor',
      width: 160,
      align: 'right',
      render: (v) => v ?? '-',
    },
    {
      title: 'Validity',
      key: 'validity',
      width: 210,
      render: (_, r) => `${r.valid_from ? new Date(r.valid_from).toLocaleDateString() : '-'} to ${r.valid_to ? new Date(r.valid_to).toLocaleDateString() : 'Current'}`,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEditConv(record)} />
          <Popconfirm
            title="Delete this conversion?"
            onConfirm={() => handleDeleteConv(record.id)}
            okText="Delete"
            okButtonProps={{ danger: true }}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const itemConvColumns = [
    { title: 'Item', dataIndex: 'item_name', key: 'item', width: 220, render: (v, r) => v || r.item_code || r.item_id },
    { title: 'Bridge', dataIndex: 'conversion_type', key: 'type', width: 150, render: (v) => v || '-' },
    { title: 'From UOM', dataIndex: 'from_uom_name', key: 'from', width: 150 },
    { title: 'To UOM', dataIndex: 'to_uom_name', key: 'to', width: 150 },
    { title: 'Factor', dataIndex: 'conversion_factor', key: 'factor', width: 140, align: 'right' },
    {
      title: 'Validity',
      key: 'validity',
      width: 210,
      render: (_, r) => `${r.valid_from ? new Date(r.valid_from).toLocaleDateString() : '-'} to ${r.valid_to ? new Date(r.valid_to).toLocaleDateString() : 'Current'}`,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEditItemConv(record)} />
          <Popconfirm
            title="Expire this item conversion?"
            onConfirm={() => handleDeleteItemConv(record.id)}
            okText="Expire"
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
      <PageHeader title="Units of Measure" subtitle="Manage UOMs and conversion factors">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          Add UOM
        </Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchUOMs}
        rowKey="id"
        searchPlaceholder="Search UOM..."
        exportFileName="uom"
      />

      <Divider />

      <Card
        title="UOM Categories"
        extra={
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleAddCategory}>
            Add Category
          </Button>
        }
      >
        <Table
          columns={categoryColumns}
          dataSource={uomCategories}
          loading={categoryLoading}
          rowKey="id"
          size="small"
          pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t, r) => `${r[0]}-${r[1]} of ${t}` }}
          scroll={{ x: 'max-content' }}
        />
      </Card>

      <Divider />

      <Card
        title={
          <Space>
            <SwapOutlined />
            <span>UOM Conversions</span>
          </Space>
        }
        extra={
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleAddConv}>
            Add Conversion
          </Button>
        }
      >
        <Table
          columns={convColumns}
          dataSource={conversions}
          loading={convLoading}
          rowKey="id"
          size="small"
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t, r) => `${r[0]}-${r[1]} of ${t}` }}
          scroll={{ x: 'max-content' }}
        />
      </Card>

      <Divider />

      <Card
        title="Item UOM Bridges"
        extra={
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleAddItemConv}>
            Add Item Bridge
          </Button>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Use item bridges only for item-specific dimensional conversions such as density, fill quantity, dosage weight, yield, width, GSM, or coverage."
        />
        <Table
          columns={itemConvColumns}
          dataSource={itemConversions}
          loading={itemConvLoading}
          rowKey="id"
          size="small"
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t, r) => `${r[0]}-${r[1]} of ${t}` }}
          scroll={{ x: 'max-content' }}
        />
      </Card>

      {/* UOM Modal */}
      <Modal
        title={editingUom ? 'Edit UOM' : 'Add UOM'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => { setModalOpen(false); setEditingUom(null); form.resetFields(); }}
        confirmLoading={submitting}
        okText={editingUom ? 'Update' : 'Create'}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="UOM Name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="e.g. Kilogram" />
          </Form.Item>
          <Form.Item name="abbreviation" label="Abbreviation" rules={[{ required: true, message: 'Abbreviation is required' }]}>
            <Input placeholder="e.g. Kg" />
          </Form.Item>
          <Form.Item name="category_id" label="Category">
            <Select
              placeholder="Select category"
              allowClear
              showSearch
              optionFilterProp="label"
              options={categoryOptions}
            />
          </Form.Item>
          <Form.Item name="status" label="Status" initialValue="active">
            <Select
              options={[
                { label: 'Active', value: 'active' },
                { label: 'Inactive', value: 'inactive' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* UOM Category Modal */}
      <Modal
        title={editingCategory ? 'Edit UOM Category' : 'Add UOM Category'}
        open={categoryModalOpen}
        onOk={handleCategorySubmit}
        onCancel={() => { setCategoryModalOpen(false); setEditingCategory(null); categoryForm.resetFields(); }}
        confirmLoading={categorySubmitting}
        okText={editingCategory ? 'Update' : 'Create'}
        destroyOnHidden
      >
        <Form form={categoryForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="Category Name" rules={[{ required: true, message: 'Category name is required' }]}>
            <Input placeholder="e.g. Weight, Volume, Count" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} placeholder="Optional notes" />
          </Form.Item>
          <Form.Item
            name="base_uom_id"
            label="Base UOM"
            extra="Hub unit for this category. Example: Gram for Weight, Liter for Volume, Each for Count."
          >
            <Select
              placeholder="Select base UOM"
              allowClear
              showSearch
              optionFilterProp="label"
              options={uomList
                .filter((u) => !editingCategory || !u.category_id || u.category_id === editingCategory.id)
                .map((u) => ({ label: `${u.name}${u.abbreviation ? ` (${u.abbreviation})` : ''}`, value: u.id }))}
            />
          </Form.Item>
          <Form.Item name="status" label="Status" initialValue="active">
            <Select
              options={[
                { label: 'Active', value: 'active' },
                { label: 'Inactive', value: 'inactive' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* Conversion Modal */}
      <Modal
        title={editingConv ? 'Edit Conversion' : 'Add Conversion'}
        open={convModalOpen}
        onOk={handleConvSubmit}
        onCancel={() => { setConvModalOpen(false); setEditingConv(null); convForm.resetFields(); }}
        confirmLoading={convSubmitting}
        okText={editingConv ? 'Update' : 'Create'}
        destroyOnHidden
      >
        <Form form={convForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="category_id" label="UOM Category" rules={[{ required: true, message: 'Please select a category first' }]}>
            <Select
              placeholder="Select category (e.g. Weight, Volume)"
              options={categoryOptions}
              onChange={(val) => {
                const category = uomCategories.find(c => c.id === val);
                const baseUomId = category?.base_uom_id;
                // Auto-populate From UOM with Base UOM and clear To UOM
                convForm.setFieldsValue({ from_uom_id: baseUomId, to_uom_id: undefined });
              }}
            />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="from_uom_id" label="From UOM (Base)" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  placeholder={selectedConvCategory ? "Base UOM auto-selected" : "Select category first"}
                  options={filteredUomList.map(u => ({ label: `${u.name} (${u.abbreviation || ''})`, value: u.id }))}
                  disabled={true}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="to_uom_id" label="To UOM" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  placeholder={selectedConvCategory ? "Select UOM" : "Select category first"}
                  options={getUomOptions(selectedFromUom)}
                  showSearch
                  optionFilterProp="label"
                  disabled={!selectedConvCategory}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            label="Exact Factor"
            required
            extra="Stores as numerator / denominator. Example: 1 Case = 24 Each is 24 / 1; 1 Each = 1 / 24 Case is 1 / 24."
          >
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="factor_num" noStyle rules={[{ required: true, message: 'Numerator is required' }]}>
                  <InputNumber min={0} precision={12} step={1} style={{ width: '100%' }} placeholder="Numerator" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="factor_den" noStyle initialValue={1} rules={[{ required: true, message: 'Denominator is required' }]}>
                  <InputNumber min={0} precision={12} step={1} style={{ width: '100%' }} placeholder="Denominator" />
                </Form.Item>
              </Col>
            </Row>
          </Form.Item>
          <Form.Item name="valid_from" label="Valid From">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Item Conversion Modal */}
      <Modal
        title={editingItemConv ? 'Edit Item UOM Bridge' : 'Add Item UOM Bridge'}
        open={itemConvModalOpen}
        onOk={handleItemConvSubmit}
        onCancel={() => { setItemConvModalOpen(false); setEditingItemConv(null); itemConvForm.resetFields(); }}
        confirmLoading={itemConvSubmitting}
        okText={editingItemConv ? 'Update' : 'Create'}
        destroyOnHidden
      >
        <Form form={itemConvForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="item_id" label="Item" rules={[{ required: true, message: 'Item is required' }]}>
            <ItemSelector />
          </Form.Item>
          <Form.Item name="conversion_type" label="Bridge Type">
            <Select
              placeholder="Select bridge type"
              allowClear
              options={[
                { label: 'Density / Specific Gravity', value: 'density' },
                { label: 'Fill Quantity', value: 'fill_quantity' },
                { label: 'Dosage Weight', value: 'dosage_weight' },
                { label: 'Yield / Expansion Rate', value: 'yield' },
                { label: 'Width', value: 'width' },
                { label: 'GSM / Area Weight', value: 'gsm' },
                { label: 'Coverage', value: 'coverage' },
              ]}
            />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="from_uom_id" label="From UOM" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  placeholder="Select UOM"
                  options={uomList
                    .filter((u) => u.id !== selectedItemToUom)
                    .map((u) => ({ label: `${u.name}${u.abbreviation ? ` (${u.abbreviation})` : ''}`, value: u.id }))}
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="to_uom_id" label="To UOM" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  placeholder="Select UOM"
                  options={uomList
                    .filter((u) => u.id !== selectedItemFromUom)
                    .map((u) => ({ label: `${u.name}${u.abbreviation ? ` (${u.abbreviation})` : ''}`, value: u.id }))}
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="Exact Factor" required extra="1 unit of From UOM = numerator / denominator units of To UOM">
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="factor_num" noStyle rules={[{ required: true, message: 'Numerator is required' }]}>
                  <InputNumber min={0} precision={12} step={1} style={{ width: '100%' }} placeholder="Numerator" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="factor_den" noStyle initialValue={1} rules={[{ required: true, message: 'Denominator is required' }]}>
                  <InputNumber min={0} precision={12} step={1} style={{ width: '100%' }} placeholder="Denominator" />
                </Form.Item>
              </Col>
            </Row>
          </Form.Item>
          <Form.Item name="valid_from" label="Valid From">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default UOM;

