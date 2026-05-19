import React, { useEffect, useMemo, useState } from 'react';
import {
  Button, Card, Checkbox, Col, Empty, Form, Input, InputNumber, Row,
  Space, Spin, Statistic, Switch, Tag, Tree, Typography, message,
} from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const { Text } = Typography;

const asList = (data) => data?.items || data?.data || data || [];

const collectLeafKeys = (nodes, prefix) => {
  const out = [];
  const walk = (items) => {
    (items || []).forEach((node) => {
      if (String(node.key).startsWith(prefix)) out.push(node.key);
      if (node.children) walk(node.children);
    });
  };
  walk(nodes);
  return out;
};

const buildItemTree = (categories, items) => {
  const byParent = new Map();
  categories.forEach((cat) => {
    const parent = cat.parent_id || 0;
    byParent.set(parent, [...(byParent.get(parent) || []), cat]);
  });
  const itemByCategory = new Map();
  items.forEach((item) => {
    const catId = item.category_id || item.category?.id || 0;
    itemByCategory.set(catId, [...(itemByCategory.get(catId) || []), item]);
  });
  const makeCategoryNode = (cat) => {
    const children = [
      ...(byParent.get(cat.id) || []).map(makeCategoryNode),
      ...(itemByCategory.get(cat.id) || []).map((item) => ({
        key: `item-${item.id}`,
        title: (
          <Space size={6}>
            <Text>{item.item_code || '-'}</Text>
            <Text type="secondary">{item.name}</Text>
          </Space>
        ),
        isLeaf: true,
      })),
    ];
    return {
      key: `cat-${cat.id}`,
      title: `${cat.full_code || cat.code || ''} ${cat.name}`.trim(),
      children,
    };
  };
  const roots = (byParent.get(0) || []).map(makeCategoryNode);
  const uncategorized = (itemByCategory.get(0) || []).map((item) => ({
    key: `item-${item.id}`,
    title: `${item.item_code || '-'} ${item.name}`,
    isLeaf: true,
  }));
  return uncategorized.length ? [...roots, { key: 'cat-uncategorized', title: 'Uncategorized', children: uncategorized }] : roots;
};

const buildVendorTree = (categories, vendors) => {
  const byCategory = new Map();
  vendors.forEach((vendor) => {
    const catId = vendor.vendor_category_id || 0;
    byCategory.set(catId, [...(byCategory.get(catId) || []), vendor]);
  });
  const nodes = categories.map((cat) => ({
    key: `vcat-${cat.id}`,
    title: `${cat.name} (${(byCategory.get(cat.id) || []).length})`,
    children: (byCategory.get(cat.id) || []).map((vendor) => ({
      key: `vendor-${vendor.id}`,
      title: (
        <Space size={6}>
          <Text>{vendor.vendor_code}</Text>
          <Text type="secondary">{vendor.name}</Text>
        </Space>
      ),
      isLeaf: true,
    })),
  }));
  const uncategorized = (byCategory.get(0) || []).map((vendor) => ({
    key: `vendor-${vendor.id}`,
    title: `${vendor.vendor_code} ${vendor.name}`,
    isLeaf: true,
  }));
  return uncategorized.length ? [...nodes, { key: 'vcat-uncategorized', title: `Uncategorized (${uncategorized.length})`, children: uncategorized }] : nodes;
};

const idsFromKeys = (keys, prefix) => keys
  .filter((key) => String(key).startsWith(prefix))
  .map((key) => Number(String(key).replace(prefix, '')))
  .filter(Boolean);

const VendorMaterialMapping = () => {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [vendors, setVendors] = useState([]);
  const [vendorCategories, setVendorCategories] = useState([]);
  const [categories, setCategories] = useState([]);
  const [items, setItems] = useState([]);
  const [vendorKeys, setVendorKeys] = useState([]);
  const [itemKeys, setItemKeys] = useState([]);
  const [vendorSearch, setVendorSearch] = useState('');
  const [itemSearch, setItemSearch] = useState('');
  const [form] = Form.useForm();

  const loadData = async () => {
    setLoading(true);
    try {
      const [vendorRes, vendorCategoryRes, categoryRes, itemRes] = await Promise.all([
        api.get('/masters/vendors', { params: { page_size: 1000, status: 'active' } }),
        api.get('/masters/vendor-categories', { params: { include_inactive: true } }),
        api.get('/masters/categories'),
        api.get('/masters/items', { params: { page_size: 10000, is_active: true } }),
      ]);
      setVendors(asList(vendorRes.data));
      setVendorCategories(asList(vendorCategoryRes.data));
      setCategories(asList(categoryRes.data));
      setItems(asList(itemRes.data));
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    form.setFieldsValue({ lead_time_days: 0, min_order_qty: 0, rate: 0, is_preferred: false });
  }, []);

  const filteredVendors = useMemo(() => {
    const q = vendorSearch.trim().toLowerCase();
    if (!q) return vendors;
    return vendors.filter((v) => `${v.vendor_code || ''} ${v.name || ''} ${v.vendor_category_name || ''}`.toLowerCase().includes(q));
  }, [vendors, vendorSearch]);

  const filteredItems = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => `${i.item_code || ''} ${i.name || ''} ${i.category_name || ''}`.toLowerCase().includes(q));
  }, [items, itemSearch]);

  const vendorTree = useMemo(() => buildVendorTree(vendorCategories, filteredVendors), [vendorCategories, filteredVendors]);
  const itemTree = useMemo(() => buildItemTree(categories, filteredItems), [categories, filteredItems]);
  const selectedVendorIds = useMemo(() => idsFromKeys(vendorKeys, 'vendor-'), [vendorKeys]);
  const selectedItemIds = useMemo(() => idsFromKeys(itemKeys, 'item-'), [itemKeys]);

  const handleVendorCheck = (checked) => {
    setVendorKeys(Array.isArray(checked) ? checked : checked.checked);
  };

  const handleItemCheck = (checked) => {
    setItemKeys(Array.isArray(checked) ? checked : checked.checked);
  };

  const selectAllVisibleVendors = () => setVendorKeys(collectLeafKeys(vendorTree, 'vendor-'));
  const selectAllVisibleItems = () => setItemKeys(collectLeafKeys(itemTree, 'item-'));

  const handleSave = async () => {
    if (!selectedVendorIds.length) {
      message.warning('Select at least one supplier');
      return;
    }
    if (!selectedItemIds.length) {
      message.warning('Select at least one item');
      return;
    }
    try {
      const values = await form.validateFields();
      setSaving(true);
      const res = await api.post('/masters/vendor-item-mappings/bulk', {
        ...values,
        vendor_ids: selectedVendorIds,
        item_ids: selectedItemIds,
      });
      message.success(res.data?.message || 'Vendor-material mappings saved');
      setVendorKeys([]);
      setItemKeys([]);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader title="Vendor Material Mapping" subtitle="Map suppliers to item categories or specific materials">
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>Refresh</Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving}>Save Mapping</Button>
        </Space>
      </PageHeader>

      <Spin spinning={loading}>
        <Row gutter={16}>
          <Col xs={24} lg={8}>
            <Card
              title="Suppliers"
              extra={<Button size="small" onClick={selectAllVisibleVendors}>Select visible</Button>}
            >
              <Input.Search placeholder="Search suppliers or categories" allowClear onChange={(e) => setVendorSearch(e.target.value)} style={{ marginBottom: 12 }} />
              {vendorTree.length ? (
                <Tree checkable checkedKeys={vendorKeys} onCheck={handleVendorCheck} treeData={vendorTree} height={520} defaultExpandAll />
              ) : <Empty description="No suppliers" />}
            </Card>
          </Col>

          <Col xs={24} lg={10}>
            <Card
              title="Item Categories & Materials"
              extra={<Button size="small" onClick={selectAllVisibleItems}>Select visible</Button>}
            >
              <Input.Search placeholder="Search items or categories" allowClear onChange={(e) => setItemSearch(e.target.value)} style={{ marginBottom: 12 }} />
              {itemTree.length ? (
                <Tree checkable checkedKeys={itemKeys} onCheck={handleItemCheck} treeData={itemTree} height={520} defaultExpandAll />
              ) : <Empty description="No items" />}
            </Card>
          </Col>

          <Col xs={24} lg={6}>
            <Card title="Mapping Defaults">
              <Space direction="vertical" style={{ width: '100%' }} size="middle">
                <Row gutter={8}>
                  <Col span={12}><Statistic title="Suppliers" value={selectedVendorIds.length} /></Col>
                  <Col span={12}><Statistic title="Items" value={selectedItemIds.length} /></Col>
                </Row>
                <Tag color="blue">{selectedVendorIds.length * selectedItemIds.length} combinations</Tag>
                <Form form={form} layout="vertical">
                  <Form.Item name="lead_time_days" label="Lead Time">
                    <InputNumber min={0} max={3650} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="min_order_qty" label="Min Order Qty">
                    <InputNumber min={0} precision={3} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="rate" label="Rate">
                    <InputNumber min={0} precision={2} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="is_preferred" label="Preferred" valuePropName="checked">
                    <Switch />
                  </Form.Item>
                </Form>
                <Checkbox checked={!vendorKeys.length && !itemKeys.length} onChange={() => { setVendorKeys([]); setItemKeys([]); }}>
                  Clear selection
                </Checkbox>
              </Space>
            </Card>
          </Col>
        </Row>
      </Spin>
    </div>
  );
};

export default VendorMaterialMapping;
