import React, { useEffect, useMemo, useState } from 'react';
import {
  Button, Col, Empty, Form, message, Row, Select, Space, Spin, Table, Tag, Tree, Typography,
} from 'antd';
import { ApartmentOutlined, LinkOutlined, ReloadOutlined } from '@ant-design/icons';
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

const CategoryAttributeMapping = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [mappingSubmitting, setMappingSubmitting] = useState(false);
  const [categories, setCategories] = useState([]);
  const [selectedCategoryKeys, setSelectedCategoryKeys] = useState([]);
  const [expandedCategoryKeys, setExpandedCategoryKeys] = useState([]);
  const [attributes, setAttributes] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [uomCategories, setUomCategories] = useState([]);
  const [uoms, setUoms] = useState([]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [catRes, attrRes, uomCatRes, uomRes] = await Promise.all([
        api.get('/masters/categories', { params: { page_size: 1000 } }),
        api.get('/masters/item-attributes'),
        api.get('/masters/uom-categories'),
        api.get('/masters/uom', { params: { page_size: 500 } }),
      ]);
      const catItems = catRes.data?.items || catRes.data?.data || catRes.data || [];
      const attrItems = attrRes.data || [];
      const uomCatItems = uomCatRes.data?.items || uomCatRes.data?.data || uomCatRes.data || [];
      const uomItems = uomRes.data?.items || uomRes.data?.data || uomRes.data || [];

      setCategories(catItems);
      const nextTree = buildCategoryTree(catItems);
      setExpandedCategoryKeys(collectCategoryKeys(nextTree));
      setAttributes(attrItems);
      setMappings(attrItems.filter((r) => r.category_id));
      setUomCategories(uomCatItems.map((c) => ({ label: c.name, value: c.id })));
      setUoms(uomItems.map((u) => ({
        label: `${u.name} (${u.abbreviation || ''})`,
        value: u.id,
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

  const categoryLookup = (id) => {
    const category = categories.find((c) => c.id === id);
    return category ? `${category.code || category.full_code || ''} · ${category.name}` : '-';
  };
  const uomCategoryLookup = (id) => uomCategories.find((c) => c.value === id)?.label || '-';
  const uomLookup = (id) => uoms.find((u) => u.value === id)?.label || '-';

  const attributeOptions = useMemo(() => (
    Array.from(
      attributes
        .filter((r) => r.is_active !== false)
        .sort((a, b) => Number(Boolean(a.category_id)) - Number(Boolean(b.category_id)))
        .reduce((map, r) => {
          const key = String(r.code || '').trim().toLowerCase() || String(r.id);
          if (!map.has(key)) {
            map.set(key, { label: `${r.code} · ${r.name}`, value: r.id });
          }
          return map;
        }, new Map())
        .values()
    )
  ), [attributes]);

  const selectedCategoryIds = Form.useWatch('category_ids', form) || [];
  const selectedAttributeId = Form.useWatch('attribute_id', form);
  const selectedAttribute = attributes.find((a) => a.id === selectedAttributeId);
  const categoryTree = useMemo(() => buildCategoryTree(categories), [categories]);

  const handleCategoryCheck = (keys) => {
    const nextKeys = Array.isArray(keys) ? keys : keys.checked;
    setSelectedCategoryKeys(nextKeys);
    form.setFieldsValue({ category_ids: categoryIdsFromKeys(nextKeys) });
  };

  const handleMapSubmit = async () => {
    try {
      const values = await form.validateFields();
      setMappingSubmitting(true);
      const res = await api.post('/masters/item-attribute-category-mappings', {
        attribute_id: values.attribute_id,
        category_ids: values.category_ids,
      });
      const mapped = res.data?.mapped || 0;
      const reactivated = res.data?.reactivated || 0;
      const skipped = res.data?.skipped || 0;
      message.success(`Mapping saved: ${mapped} new, ${reactivated} reactivated, ${skipped} already mapped`);
      form.resetFields();
      setSelectedCategoryKeys([]);
      await loadData();
      try {
        window.dispatchEvent(new Event('item-attributes-changed'));
      } catch { /* no-op */ }
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setMappingSubmitting(false);
    }
  };

  const panelStyle = {
    background: '#fff',
    border: '1px solid #f0f0f0',
    borderRadius: 8,
    padding: 16,
    minHeight: 360,
  };

  return (
    <div>
      <PageHeader title="Category Attribute Mapping" subtitle="Map one attribute to multiple item categories and review existing mappings.">
        <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>Refresh</Button>
      </PageHeader>

      <Form form={form} layout="vertical">
        <Row gutter={16} align="stretch">
          <Col xs={24} lg={7}>
            <div style={panelStyle}>
              <Space direction="vertical" size={4} style={{ marginBottom: 16 }}>
                <Space>
                  <ApartmentOutlined />
                  <Text strong>Categories</Text>
                </Space>
                <Text type="secondary">Choose every category that should receive this attribute.</Text>
              </Space>
              <Form.Item
                name="category_ids"
                hidden
                rules={[{ required: true, message: 'Select at least one category' }]}
              >
                <Select mode="multiple" />
              </Form.Item>
              <Space style={{ marginBottom: 12 }} wrap>
                <Button size="small" onClick={() => handleCategoryCheck(collectCategoryKeys(categoryTree))}>
                  Select all
                </Button>
                <Button size="small" onClick={() => handleCategoryCheck([])}>
                  Clear
                </Button>
              </Space>
              {loading ? (
                <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
              ) : categoryTree.length === 0 ? (
                <Empty description="No categories found" />
              ) : (
                <Tree
                  checkable
                  blockNode
                  treeData={categoryTree}
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
                <Space>
                  <LinkOutlined />
                  <Text strong>Attribute</Text>
                </Space>
                <Text type="secondary">Select one attribute to map to the chosen categories.</Text>
              </Space>
              <Form.Item
                name="attribute_id"
                label="Attribute"
                rules={[{ required: true, message: 'Select an attribute' }]}
              >
                <Select
                  options={attributeOptions}
                  showSearch
                  optionFilterProp="label"
                  placeholder="Select attribute"
                />
              </Form.Item>
              {selectedAttribute ? (
                <div style={{ marginTop: 12 }}>
                  <Space size={8} wrap>
                    <Tag>{String(selectedAttribute.data_type || '').toUpperCase()}</Tag>
                    <Text type="secondary">{selectedAttribute.code}</Text>
                  </Space>
                  <div style={{ marginTop: 8 }}>
                    <Text strong>{selectedAttribute.name}</Text>
                  </div>
                </div>
              ) : null}
              <Button
                type="primary"
                onClick={handleMapSubmit}
                loading={mappingSubmitting}
                style={{ marginTop: 24 }}
                block
              >
                Map Attribute
              </Button>
            </div>
          </Col>

          <Col xs={24} lg={10}>
            <div style={panelStyle}>
              <Space direction="vertical" size={4} style={{ marginBottom: 16 }}>
                <Text strong>Mapped History</Text>
                <Text type="secondary">{mappings.length} category-attribute mappings found.</Text>
              </Space>
              <Table
                rowKey="id"
                size="small"
                loading={loading}
                dataSource={mappings}
                pagination={{ pageSize: 8, showSizeChanger: false }}
                columns={[
                  { title: 'Category', dataIndex: 'category_id', render: (v) => categoryLookup(v), ellipsis: true },
                  { title: 'Attribute', dataIndex: 'name', ellipsis: true },
                  { title: 'Code', dataIndex: 'code', render: (v) => <code>{v}</code> },
                  { title: 'Type', dataIndex: 'data_type', width: 86, render: (v) => <Tag>{String(v || '').toUpperCase()}</Tag> },
                  { title: 'UOM Category', dataIndex: 'uom_category_id', render: (v) => uomCategoryLookup(v), ellipsis: true },
                  { title: 'UOM', dataIndex: 'uom_id', render: (v) => uomLookup(v), ellipsis: true },
                ]}
              />
            </div>
          </Col>
        </Row>
      </Form>
    </div>
  );
};

export default CategoryAttributeMapping;
