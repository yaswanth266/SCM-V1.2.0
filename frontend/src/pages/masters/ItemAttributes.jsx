import React, { useState, useEffect } from 'react';
import {
  Button, Modal, Form, Input, InputNumber, Select, Space, Popconfirm, message, Switch, Tag, Table,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const DATA_TYPES = [
  { label: 'Text', value: 'text' },
  { label: 'Number', value: 'number' },
  { label: 'Boolean', value: 'boolean' },
  { label: 'Enum (allowed values)', value: 'enum' },
];

const ItemAttributes = () => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRow, setEditingRow] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [categories, setCategories] = useState([]);
  const [uomCategories, setUomCategories] = useState([]);
  const [uoms, setUoms] = useState([]);
  const [filterCat, setFilterCat] = useState(undefined);
  // BUG-FE-035: previously `Form.useWatch('data_type', form)` was hooked at
  // page level — every keystroke in the modal forced a full table re-render.
  // Conditional fields are now driven by Form.Item shouldUpdate inside the
  // modal so only the relevant items re-render.

  const loadLookups = async () => {
    try {
      const [catRes, uomRes, uomCatRes] = await Promise.all([
        api.get('/masters/categories', { params: { page_size: 500 } }),
        api.get('/masters/uom', { params: { page_size: 500 } }),
        api.get('/masters/uom-categories'),
      ]);
      const catItems = catRes.data?.items || catRes.data?.data || catRes.data || [];
      setCategories(catItems.map((c) => ({ label: `${c.code} · ${c.name}`, value: c.id })));
      const uomItems = uomRes.data?.items || uomRes.data?.data || uomRes.data || [];
      setUoms(uomItems.map((u) => ({
        label: `${u.name} (${u.abbreviation || ''})`,
        value: u.id,
        category_id: u.category_id || null,
      })));
      const uomCatItems = uomCatRes.data?.items || uomCatRes.data?.data || uomCatRes.data || [];
      setUomCategories(uomCatItems.map((c) => ({ label: c.name, value: c.id })));
    } catch { /* silent */ }
  };

  const fetchRows = async () => {
    setLoading(true);
    try {
      const params = filterCat ? { category_id: filterCat } : {};
      const res = await api.get('/masters/item-attributes', { params });
      setRows(res.data || []);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadLookups(); }, []);
  useEffect(() => { fetchRows(); }, [filterCat]);

  const handleAdd = () => {
    setEditingRow(null);
    form.resetFields();
    form.setFieldsValue({ data_type: 'text', is_required: false, sort_order: 0, is_active: true });
    setModalOpen(true);
  };

  const handleEdit = (r) => {
    setEditingRow(r);
    form.setFieldsValue(r);
    setModalOpen(true);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/masters/item-attributes/${id}`);
      message.success('Attribute deactivated');
      fetchRows();
      // BUG-FE-036: notify other open pages (Items.jsx) so they refetch
      // attribute definitions instead of using a stale list.
      try {
        window.dispatchEvent(new Event('item-attributes-changed'));
      } catch { /* no-op */ }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (!values.uom_category_id && values.uom_id) {
        values.uom_category_id = uoms.find((u) => u.value === values.uom_id)?.category_id || null;
      }
      values.category_id = editingRow?.category_id || null;
      if (values.data_type !== 'enum') values.allowed_values = null;
      setSubmitting(true);
      if (editingRow) {
        await api.put(`/masters/item-attributes/${editingRow.id}`, values);
        message.success('Attribute updated');
      } else {
        await api.post('/masters/item-attributes', values);
        message.success('Attribute created');
      }
      setModalOpen(false);
      fetchRows();
      // BUG-FE-036: broadcast change so other tabs/pages refresh
      try {
        window.dispatchEvent(new Event('item-attributes-changed'));
      } catch { /* no-op */ }
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const catLookup = (id) => categories.find((c) => c.value === id)?.label || '-';
  const uomCategoryLookup = (id) => uomCategories.find((c) => c.value === id)?.label || '-';
  const uomLookup = (id) => uoms.find((u) => u.value === id)?.label || '-';
  const getUomOptionsForCategory = (categoryId) => (
    categoryId ? uoms.filter((u) => u.category_id === categoryId) : uoms
  );

  return (
    <div>
      <PageHeader title="Item Attributes" subtitle="Define per-category attributes (Dosage Form, RAM, Processor...)">
        <Space>
          <Select
            placeholder="Filter by category"
            allowClear
            style={{ width: 260 }}
            value={filterCat}
            onChange={setFilterCat}
            options={categories}
            showSearch
            optionFilterProp="label"
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Add Attribute</Button>
        </Space>
      </PageHeader>

      {/* BUG-FE-038: replace hand-rolled <table> with Antd Table so the page
          gets pagination, sorting, and a11y for free. */}
      <Table
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t, r) => `${r[0]}-${r[1]} of ${t}` }}
        size="small"
        columns={[
          { title: 'Category', dataIndex: 'category_id', sorter: (a, b) => (a.category_id || 0) - (b.category_id || 0), render: (v) => catLookup(v) },
          { title: 'Code', dataIndex: 'code', sorter: (a, b) => String(a.code).localeCompare(String(b.code)), render: (v) => <code>{v}</code> },
          { title: 'Name', dataIndex: 'name', sorter: (a, b) => String(a.name).localeCompare(String(b.name)) },
          { title: 'Data Type', dataIndex: 'data_type', sorter: (a, b) => String(a.data_type).localeCompare(String(b.data_type)), render: (v) => <Tag>{v}</Tag> },
          { title: 'UOM Category', dataIndex: 'uom_category_id', render: (v) => uomCategoryLookup(v) },
          { title: 'UOM', dataIndex: 'uom_id', render: (v) => uomLookup(v) },
          { title: 'Required', dataIndex: 'is_required', sorter: (a, b) => Number(a.is_required) - Number(b.is_required), render: (v) => (v ? 'Yes' : 'No') },
          { title: 'Sort', dataIndex: 'sort_order', sorter: (a, b) => (a.sort_order || 0) - (b.sort_order || 0) },
          {
            title: 'Actions',
            width: 110,
            render: (_, r) => (
              <Space>
                <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)} />
                <Popconfirm title="Deactivate?" onConfirm={() => handleDelete(r.id)}>
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={editingRow ? 'Edit Attribute' : 'Add Attribute'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={submitting}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          {/* BUG-FE-037: include explicit message strings on required rules
              so the form errors are screen-readable rather than the antd
              fallback `'${label}' is required` template. */}
          <Form.Item name="code" label="Code" rules={[{ required: true, message: 'Code is required' }]}>
            <Input placeholder="e.g. PROCESSOR, RAM, DOSAGE_FORM" />
          </Form.Item>
          <Form.Item name="name" label="Display Name" rules={[{ required: true, message: 'Display name is required' }]}>
            <Input placeholder="e.g. Processor, RAM, Dosage Form" />
          </Form.Item>
          <Form.Item name="data_type" label="Data Type" rules={[{ required: true, message: 'Data type is required' }]}>
            <Select options={DATA_TYPES} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.data_type !== cur.data_type}>
            {({ getFieldValue }) => {
              const dt = getFieldValue('data_type');
              return (
                <>
                  {dt && (
                    <>
                      <Form.Item name="uom_category_id" label="UOM Category">
                        <Select
                          options={uomCategories}
                          allowClear
                          showSearch
                          optionFilterProp="label"
                          placeholder="Select UOM category"
                          onChange={(categoryId) => {
                            const uomId = form.getFieldValue('uom_id');
                            const selectedUom = uoms.find((u) => u.value === uomId);
                            if (selectedUom?.category_id && categoryId && selectedUom.category_id !== categoryId) {
                              form.setFieldValue('uom_id', null);
                            }
                          }}
                        />
                      </Form.Item>
                      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.uom_category_id !== cur.uom_category_id}>
                        {({ getFieldValue: getNestedFieldValue }) => (
                          <Form.Item name="uom_id" label="UOM">
                            <Select
                              options={getUomOptionsForCategory(getNestedFieldValue('uom_category_id'))}
                              allowClear
                              showSearch
                              optionFilterProp="label"
                              placeholder="e.g. GB, kg"
                              onChange={(uomId) => {
                                const selectedUom = uoms.find((u) => u.value === uomId);
                                if (!form.getFieldValue('uom_category_id') && selectedUom?.category_id) {
                                  form.setFieldValue('uom_category_id', selectedUom.category_id);
                                }
                              }}
                            />
                          </Form.Item>
                        )}
                      </Form.Item>
                    </>
                  )}
                  {dt === 'enum' && (
                    <Form.Item name="allowed_values" label="Allowed Values (comma-separated)">
                      <Input placeholder="e.g. Tablet, Syrup, Injection" />
                    </Form.Item>
                  )}
                </>
              );
            }}
          </Form.Item>
          <Form.Item name="is_required" label="Required" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="sort_order" label="Sort Order">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default ItemAttributes;

