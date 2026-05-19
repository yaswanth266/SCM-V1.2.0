import React, { useEffect, useMemo, useState } from 'react';
import {
  Button, Col, Empty, Form, Input, InputNumber, message, Modal, Popconfirm, Row, Select,
  Space, Spin, Switch, Table, Tabs, Tag, Tree, Typography,
} from 'antd';
import { ApartmentOutlined, EditOutlined, LinkOutlined, PlusOutlined, ReloadOutlined, SlidersOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const { Text } = Typography;

const categoryKey = (id) => `cat-${id}`;

const categoryIdsFromKeys = (keys) => keys
  .map((key) => Number(String(key).replace('cat-', '')))
  .filter(Boolean);

const buildCategoryTree = (categories) => {
  const byParent = new Map();
  const byId = new Map(categories.map((cat) => [cat.id, cat]));

  categories.forEach((cat) => {
    const parentId = cat.parent_id && byId.has(cat.parent_id) ? cat.parent_id : 0;
    byParent.set(parentId, [...(byParent.get(parentId) || []), cat]);
  });

  const makeNode = (cat) => ({
    key: categoryKey(cat.id),
    title: `${cat.full_code || cat.code || ''} ${cat.name}`.trim(),
    children: (byParent.get(cat.id) || []).map(makeNode),
  });

  return (byParent.get(0) || []).map(makeNode);
};

const collectCategoryKeys = (nodes) => {
  const keys = [];
  const walk = (items) => {
    (items || []).forEach((node) => {
      keys.push(node.key);
      if (node.children) walk(node.children);
    });
  };
  walk(nodes);
  return keys;
};

const DATA_TYPES = [
  { label: 'Text', value: 'text' },
  { label: 'Number', value: 'number' },
  { label: 'Boolean', value: 'boolean' },
  { label: 'Enum', value: 'enum' },
  { label: 'Range', value: 'range' },
];

const Specs = () => {
  const [categoryForm] = Form.useForm();
  const [specForm] = Form.useForm();
  const [mappingForm] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [specModalOpen, setSpecModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [editingSpec, setEditingSpec] = useState(null);
  const [specCategories, setSpecCategories] = useState([]);
  const [specs, setSpecs] = useState([]);
  const [itemCategories, setItemCategories] = useState([]);
  const [selectedCategoryKeys, setSelectedCategoryKeys] = useState([]);
  const [expandedCategoryKeys, setExpandedCategoryKeys] = useState([]);
  const [itemSpecMappings, setItemSpecMappings] = useState([]);
  const [uomCategories, setUomCategories] = useState([]);
  const [uoms, setUoms] = useState([]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [specCatRes, specsRes, itemCatRes, itemSpecRes, uomCatRes, uomRes] = await Promise.all([
        api.get('/masters/spec-categories', { params: { include_inactive: true } }),
        api.get('/masters/specs', { params: { include_inactive: true } }),
        api.get('/masters/categories', { params: { page_size: 1000 } }),
        api.get('/masters/item-specs', { params: { include_inactive: true } }),
        api.get('/masters/uom-categories'),
        api.get('/masters/uom', { params: { page_size: 500 } }),
      ]);
      setSpecCategories(specCatRes.data || []);
      setSpecs(specsRes.data || []);
      const catItems = itemCatRes.data?.items || itemCatRes.data?.data || itemCatRes.data || [];
      setItemCategories(catItems);
      setExpandedCategoryKeys(collectCategoryKeys(buildCategoryTree(catItems)));
      setItemSpecMappings(itemSpecRes.data || []);
      const uomCatItems = uomCatRes.data?.items || uomCatRes.data?.data || uomCatRes.data || [];
      const uomItems = uomRes.data?.items || uomRes.data?.data || uomRes.data || [];
      setUomCategories(uomCatItems.map((c) => ({ label: c.name, value: c.id })));
      setUoms(uomItems.map((u) => ({
        label: `${u.name} (${u.abbreviation || ''})`,
        value: u.id,
        category_id: u.category_id || null,
      })));
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const specCategoryOptions = specCategories
    .filter((c) => c.is_active !== false)
    .map((c) => ({ label: `${c.code} · ${c.name}`, value: c.id }));
  const specOptions = specs
    .filter((s) => s.is_active !== false)
    .map((s) => ({ label: `${s.code} · ${s.name}`, value: s.id }));
  const uomLookup = (id) => uoms.find((u) => u.value === id)?.label || '-';
  const uomCategoryLookup = (id) => uomCategories.find((u) => u.value === id)?.label || '-';
  const getUomOptionsForCategory = (categoryId) => (categoryId ? uoms.filter((u) => u.category_id === categoryId) : uoms);
  const selectedSpecType = Form.useWatch('data_type', specForm);
  const watchedMappingSpecId = Form.useWatch('spec_id', mappingForm);
  const selectedCategoryIds = Form.useWatch('item_category_ids', mappingForm) || [];
  const itemCategoryTree = useMemo(() => buildCategoryTree(itemCategories), [itemCategories]);

  const handleCategoryCheck = (keys) => {
    const nextKeys = Array.isArray(keys) ? keys : keys.checked;
    setSelectedCategoryKeys(nextKeys);
    mappingForm.setFieldsValue({ item_category_ids: categoryIdsFromKeys(nextKeys) });
  };

  const openCategoryModal = (record = null) => {
    setEditingCategory(record);
    categoryForm.resetFields();
    categoryForm.setFieldsValue(record || { sort_order: 0, is_active: true });
    setCategoryModalOpen(true);
  };

  const openSpecModal = (record = null) => {
    setEditingSpec(record);
    specForm.resetFields();
    specForm.setFieldsValue(record || { data_type: 'text', sort_order: 0, is_required: false, is_active: true });
    setSpecModalOpen(true);
  };

  const saveCategory = async () => {
    try {
      const values = await categoryForm.validateFields();
      setSubmitting(true);
      if (editingCategory) {
        await api.put(`/masters/spec-categories/${editingCategory.id}`, values);
        message.success('Spec category updated');
      } else {
        await api.post('/masters/spec-categories', values);
        message.success('Spec category created');
      }
      setCategoryModalOpen(false);
      loadData();
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const saveSpec = async () => {
    try {
      const values = await specForm.validateFields();
      if (values.data_type !== 'enum') values.allowed_values = null;
      if (!values.uom_category_id && values.uom_id) {
        values.uom_category_id = uoms.find((u) => u.value === values.uom_id)?.category_id || null;
      }
      setSubmitting(true);
      if (editingSpec) {
        await api.put(`/masters/specs/${editingSpec.id}`, values);
        message.success('Spec updated');
      } else {
        await api.post('/masters/specs', values);
        message.success('Spec created');
      }
      setSpecModalOpen(false);
      loadData();
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const mapSpec = async () => {
    try {
      const values = await mappingForm.validateFields();
      setSubmitting(true);
      const res = await api.post('/masters/item-specs', {
        item_category_ids: values.item_category_ids,
        spec_id: values.spec_id,
        default_value: values.default_value || null,
        uom_id: values.uom_id || null,
        is_required: Boolean(values.is_required),
        sort_order: values.sort_order || 0,
      });
      message.success(`Mapping saved: ${res.data?.mapped || 0} new, ${res.data?.reactivated || 0} reactivated, ${res.data?.skipped || 0} updated`);
      mappingForm.resetFields();
      setSelectedCategoryKeys([]);
      loadData();
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const deactivate = async (url, label) => {
    try {
      await api.delete(url);
      message.success(`${label} deactivated`);
      loadData();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const panelStyle = {
    background: '#fff',
    border: '1px solid #f0f0f0',
    borderRadius: 8,
    padding: 16,
    minHeight: 330,
  };

  const mappingSpec = useMemo(
    () => specs.find((s) => s.id === watchedMappingSpecId),
    [specs, watchedMappingSpecId]
  );

  return (
    <div>
      <PageHeader title="Specs Master" subtitle="Maintain normalized specification categories, specs, and category mappings.">
        <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>Refresh</Button>
      </PageHeader>

      <Tabs
        items={[
          {
            key: 'categories',
            label: 'Spec Categories',
            children: (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => openCategoryModal()}>Add Category</Button>
                </Space>
                <Table
                  rowKey="id"
                  loading={loading}
                  dataSource={specCategories}
                  size="small"
                  pagination={{ pageSize: 20 }}
                  columns={[
                    { title: 'Code', dataIndex: 'code', render: (v) => <code>{v}</code> },
                    { title: 'Name', dataIndex: 'name' },
                    { title: 'Base UOM', dataIndex: 'base_uom_id', render: (v) => uomLookup(v) },
                    { title: 'Sort', dataIndex: 'sort_order', width: 90 },
                    { title: 'Status', dataIndex: 'is_active', width: 100, render: (v) => <Tag color={v ? 'green' : 'default'}>{v ? 'ACTIVE' : 'INACTIVE'}</Tag> },
                    {
                      title: 'Actions',
                      width: 120,
                      render: (_, r) => (
                        <Space>
                          <Button size="small" icon={<EditOutlined />} onClick={() => openCategoryModal(r)} />
                          <Popconfirm title="Deactivate?" onConfirm={() => deactivate(`/masters/spec-categories/${r.id}`, 'Spec category')}>
                            <Button size="small" danger>Delete</Button>
                          </Popconfirm>
                        </Space>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: 'specs',
            label: 'Specs',
            children: (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => openSpecModal()}>Add Spec</Button>
                </Space>
                <Table
                  rowKey="id"
                  loading={loading}
                  dataSource={specs}
                  size="small"
                  pagination={{ pageSize: 20 }}
                  columns={[
                    { title: 'Category', dataIndex: 'category_name' },
                    { title: 'Code', dataIndex: 'code', render: (v) => <code>{v}</code> },
                    { title: 'Name', dataIndex: 'name' },
                    { title: 'Type', dataIndex: 'data_type', width: 100, render: (v) => <Tag>{String(v).toUpperCase()}</Tag> },
                    { title: 'UOM Category', dataIndex: 'uom_category_id', render: (v) => uomCategoryLookup(v) },
                    { title: 'UOM', dataIndex: 'uom_id', render: (v) => uomLookup(v) },
                    { title: 'Required', dataIndex: 'is_required', width: 100, render: (v) => (v ? 'Yes' : 'No') },
                    {
                      title: 'Actions',
                      width: 120,
                      render: (_, r) => (
                        <Space>
                          <Button size="small" icon={<EditOutlined />} onClick={() => openSpecModal(r)} />
                          <Popconfirm title="Deactivate?" onConfirm={() => deactivate(`/masters/specs/${r.id}`, 'Spec')}>
                            <Button size="small" danger>Delete</Button>
                          </Popconfirm>
                        </Space>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: 'mapping',
            label: 'Category Mapping',
            children: (
              <Form form={mappingForm} layout="vertical">
                <Row gutter={16}>
                  <Col xs={24} lg={7}>
                    <div style={panelStyle}>
                      <Space direction="vertical" size={4} style={{ marginBottom: 16 }}>
                        <Space><ApartmentOutlined /><Text strong>Item Categories</Text></Space>
                        <Text type="secondary">Select all item categories that should receive the spec.</Text>
                      </Space>
                      <Form.Item name="item_category_ids" hidden rules={[{ required: true, message: 'Select at least one category' }]}>
                        <Select mode="multiple" />
                      </Form.Item>
                      <Space style={{ marginBottom: 12 }} wrap>
                        <Button size="small" onClick={() => handleCategoryCheck(collectCategoryKeys(itemCategoryTree))}>
                          Select all
                        </Button>
                        <Button size="small" onClick={() => handleCategoryCheck([])}>
                          Clear
                        </Button>
                      </Space>
                      {loading ? (
                        <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
                      ) : itemCategoryTree.length === 0 ? (
                        <Empty description="No categories found" />
                      ) : (
                        <Tree
                          checkable
                          blockNode
                          treeData={itemCategoryTree}
                          checkedKeys={selectedCategoryKeys}
                          expandedKeys={expandedCategoryKeys}
                          onExpand={setExpandedCategoryKeys}
                          onCheck={handleCategoryCheck}
                          style={{ maxHeight: 260, overflow: 'auto' }}
                        />
                      )}
                      <div style={{ marginTop: 12 }}>
                        <Text type="secondary">{selectedCategoryIds.length} selected</Text>
                      </div>
                    </div>
                  </Col>
                  <Col xs={24} lg={7}>
                    <div style={panelStyle}>
                      <Space direction="vertical" size={4} style={{ marginBottom: 16 }}>
                        <Space><SlidersOutlined /><Text strong>Spec</Text></Space>
                        <Text type="secondary">Select one spec and optional mapping defaults.</Text>
                      </Space>
                      <Form.Item name="spec_id" label="Spec" rules={[{ required: true, message: 'Select a spec' }]}>
                        <Select options={specOptions} showSearch optionFilterProp="label" placeholder="Select spec" />
                      </Form.Item>
                      {mappingSpec ? <Tag>{String(mappingSpec.data_type).toUpperCase()}</Tag> : null}
                      <Form.Item name="default_value" label="Default Value" style={{ marginTop: 12 }}>
                        <Input placeholder="Optional default value" />
                      </Form.Item>
                      <Form.Item name="uom_id" label="Default UOM">
                        <Select options={uoms} allowClear showSearch optionFilterProp="label" placeholder="Optional UOM" />
                      </Form.Item>
                      <Row gutter={12}>
                        <Col span={12}>
                          <Form.Item name="is_required" label="Required" valuePropName="checked">
                            <Switch />
                          </Form.Item>
                        </Col>
                        <Col span={12}>
                          <Form.Item name="sort_order" label="Sort">
                            <InputNumber min={0} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                      </Row>
                      <Button type="primary" icon={<LinkOutlined />} onClick={mapSpec} loading={submitting} block>Map Spec</Button>
                    </div>
                  </Col>
                  <Col xs={24} lg={10}>
                    <div style={panelStyle}>
                      <Space direction="vertical" size={4} style={{ marginBottom: 16 }}>
                        <Text strong>Mapped History</Text>
                        <Text type="secondary">{itemSpecMappings.length} item category/spec mappings found.</Text>
                      </Space>
                      <Table
                        rowKey="id"
                        size="small"
                        dataSource={itemSpecMappings}
                        pagination={{ pageSize: 8, showSizeChanger: false }}
                        columns={[
                          { title: 'Item Category', dataIndex: 'item_category_name', ellipsis: true },
                          { title: 'Spec', dataIndex: 'spec_name', ellipsis: true },
                          { title: 'Code', dataIndex: 'spec_code', render: (v) => <code>{v}</code> },
                          { title: 'Type', dataIndex: 'spec_data_type', width: 86, render: (v) => <Tag>{String(v || '').toUpperCase()}</Tag> },
                          { title: 'Default', dataIndex: 'default_value', ellipsis: true },
                          { title: 'UOM', dataIndex: 'uom_id', render: (v) => uomLookup(v), ellipsis: true },
                        ]}
                      />
                    </div>
                  </Col>
                </Row>
              </Form>
            ),
          },
        ]}
      />

      <Modal
        title={editingCategory ? 'Edit Spec Category' : 'Add Spec Category'}
        open={categoryModalOpen}
        onCancel={() => setCategoryModalOpen(false)}
        onOk={saveCategory}
        confirmLoading={submitting}
        destroyOnHidden
      >
        <Form form={categoryForm} layout="vertical">
          <Form.Item name="code" label="Code" rules={[{ required: true, message: 'Code is required' }]}>
            <Input placeholder="e.g. DIM, ELEC" />
          </Form.Item>
          <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="e.g. Dimensions, Electrical" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="base_uom_id" label="Base UOM">
            <Select options={uoms} allowClear showSearch optionFilterProp="label" placeholder="Optional base UOM" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="sort_order" label="Sort Order">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="is_active" label="Active" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        title={editingSpec ? 'Edit Spec' : 'Add Spec'}
        open={specModalOpen}
        onCancel={() => setSpecModalOpen(false)}
        onOk={saveSpec}
        confirmLoading={submitting}
        destroyOnHidden
      >
        <Form form={specForm} layout="vertical">
          <Form.Item name="category_id" label="Spec Category" rules={[{ required: true, message: 'Spec category is required' }]}>
            <Select options={specCategoryOptions} showSearch optionFilterProp="label" placeholder="Select spec category" />
          </Form.Item>
          <Form.Item name="code" label="Code" rules={[{ required: true, message: 'Code is required' }]}>
            <Input placeholder="e.g. WEIGHT, PROCESSOR" />
          </Form.Item>
          <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="e.g. Weight, Processor" />
          </Form.Item>
          <Form.Item name="data_type" label="Data Type" rules={[{ required: true, message: 'Data type is required' }]}>
            <Select options={DATA_TYPES} />
          </Form.Item>
          <Form.Item name="uom_category_id" label="UOM Category">
            <Select
              options={uomCategories}
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="Optional UOM category"
              onChange={(categoryId) => {
                const uomId = specForm.getFieldValue('uom_id');
                const selectedUom = uoms.find((u) => u.value === uomId);
                if (selectedUom?.category_id && categoryId && selectedUom.category_id !== categoryId) {
                  specForm.setFieldValue('uom_id', null);
                }
              }}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, cur) => prev.uom_category_id !== cur.uom_category_id}>
            {({ getFieldValue }) => (
              <Form.Item name="uom_id" label="Default UOM">
                <Select
                  options={getUomOptionsForCategory(getFieldValue('uom_category_id'))}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  placeholder="Optional default UOM"
                  onChange={(uomId) => {
                    const selectedUom = uoms.find((u) => u.value === uomId);
                    if (!specForm.getFieldValue('uom_category_id') && selectedUom?.category_id) {
                      specForm.setFieldValue('uom_category_id', selectedUom.category_id);
                    }
                  }}
                />
              </Form.Item>
            )}
          </Form.Item>
          {selectedSpecType === 'enum' ? (
            <Form.Item name="allowed_values" label="Allowed Values">
              <Input placeholder="Comma-separated values" />
            </Form.Item>
          ) : null}
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="is_required" label="Required" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="sort_order" label="Sort">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="is_active" label="Active" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
};

export default Specs;

