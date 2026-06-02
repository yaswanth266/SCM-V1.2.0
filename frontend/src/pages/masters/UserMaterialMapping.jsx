import React, { useEffect, useMemo, useState } from 'react';
import {
  App as AntApp, Button, Card, Checkbox, Col, Empty, Form, Input, Row,
  Select, Space, Spin, Statistic, Table, Tag, Tree, Typography,
} from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const { Text } = Typography;

const collectLeafKeys = (nodes, prefix) => {
  const out = [];
  const walk = (items) => {
    (items || []).forEach((node) => {
      if (String(node.key).includes(prefix)) out.push(node.key);
      if (node.children) walk(node.children);
    });
  };
  walk(nodes);
  return out;
};

const idsFromKeys = (keys, prefix) => {
  const ids = new Set();
  (keys || []).forEach((key) => {
    const sKey = String(key);
    if (sKey.includes(prefix)) {
      const idx = sKey.indexOf(prefix);
      const suffix = sKey.substring(idx + prefix.length);
      const num = Number(suffix);
      if (!isNaN(num)) {
        ids.add(num);
      }
    }
  });
  return Array.from(ids);
};

const textMatches = (value, query) => String(value || '').toLowerCase().includes(query);
const itemMatches = (item, query) => textMatches(`${item.item_code || ''} ${item.name || ''}`, query);
const categoryMatches = (cat, query) => textMatches(`${cat.full_code || ''} ${cat.code || ''} ${cat.name || ''}`, query);

const buildRoleTree = (roles = [], query = '') => {
  return roles
    .filter((role) => {
      if (!query) return true;
      const q = query.toLowerCase();
      return (
        String(role.name || '').toLowerCase().includes(q) ||
        String(role.code || '').toLowerCase().includes(q)
      );
    })
    .map((role) => ({
      key: `role-${role.id}`,
      title: `${role.code ? `[${role.code}] ` : ''}${role.name || ''}`,
      isLeaf: true,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
};

const buildItemTree = (categories, items, query = '') => {
  const byParent = new Map();
  categories.forEach((cat) => {
    const parent = cat.parent_id || 0;
    byParent.set(parent, [...(byParent.get(parent) || []), cat]);
  });
  const itemByCategory = new Map();
  items.forEach((item) => {
    const catId = item.category_id || 0;
    itemByCategory.set(catId, [...(itemByCategory.get(catId) || []), item]);
  });
  const makeItemNode = (item) => ({
    key: `item-${item.id}`,
    title: (
      <Space size={6}>
        <Text>{item.item_code || '-'}</Text>
        <Text type="secondary">{item.name}</Text>
      </Space>
    ),
    isLeaf: true,
  });
  const makeCategoryNode = (cat, forceVisible = false) => {
    const forceChildren = forceVisible || (query && categoryMatches(cat, query));
    const childCategories = (byParent.get(cat.id) || []).map((child) => makeCategoryNode(child, forceChildren)).filter(Boolean);
    const childItems = (itemByCategory.get(cat.id) || [])
      .filter((item) => forceChildren || !query || itemMatches(item, query))
      .map(makeItemNode);
    if (query && !forceChildren && !childCategories.length && !childItems.length) return null;
    return {
      key: `cat-${cat.id}`,
      title: `${cat.full_code || cat.code || ''} ${cat.name}`.trim(),
      children: [...childCategories, ...childItems],
    };
  };
  const roots = (byParent.get(0) || []).map((cat) => makeCategoryNode(cat)).filter(Boolean);
  const uncategorized = (itemByCategory.get(0) || [])
    .filter((item) => !query || itemMatches(item, query))
    .map(makeItemNode);
  return uncategorized.length ? [...roots, { key: 'cat-uncategorized', title: 'Uncategorized', children: uncategorized }] : roots;
};

const UserMaterialMapping = () => {
  const { message } = AntApp.useApp();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState({ roles: [], categories: [], items: [] });
  const [roleKeys, setRoleKeys] = useState([]);
  const [materialKeys, setMaterialKeys] = useState([]);
  const [roleSearch, setRoleSearch] = useState('');
  const [materialSearch, setMaterialSearch] = useState('');
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [form] = Form.useForm();

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await api.get('/masters/user-material-mapping/tree');
      setData(res.data || {});
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const loadHistory = async (page = historyPage, search = historySearch) => {
    setHistoryLoading(true);
    try {
      const res = await api.get('/masters/user-material-mappings', {
        params: { page, page_size: 1000, search: search || undefined },
      });
      
      const rawItems = res.data?.items || [];
      const grouped = new Map();
      
      rawItems.forEach((item) => {
        if (!grouped.has(item.role_id)) {
          grouped.set(item.role_id, {
            id: `role-${item.role_id}`,
            isRoleRow: true,
            role_name: item.role_name,
            role_code: item.role_code,
            children: [],
          });
        }
        grouped.get(item.role_id).children.push(item);
      });
      
      setHistory(Array.from(grouped.values()));
      setHistoryTotal(res.data?.total || 0);
      setHistoryPage(page);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    loadHistory(1, '');
    form.setFieldsValue({ action: 'view', replace_existing: false });
  }, []);

  const roleTree = useMemo(
    () => buildRoleTree(data.roles || [], roleSearch.trim()),
    [data.roles, roleSearch],
  );
  const materialTree = useMemo(
    () => buildItemTree(data.categories || [], data.items || [], materialSearch.trim().toLowerCase()),
    [data.categories, data.items, materialSearch],
  );
  const selectedRoleIds = useMemo(() => idsFromKeys(roleKeys, 'role-'), [roleKeys]);
  const selectedCategoryIds = useMemo(() => idsFromKeys(materialKeys, 'cat-'), [materialKeys]);
  const selectedItemIds = useMemo(() => idsFromKeys(materialKeys, 'item-'), [materialKeys]);

  const handleSave = async () => {
    if (!selectedRoleIds.length) {
      message.warning('Select at least one role');
      return;
    }
    if (!selectedCategoryIds.length && !selectedItemIds.length) {
      message.warning('Select at least one category or item');
      return;
    }
    try {
      const values = await form.validateFields();
      setSaving(true);
      const res = await api.post('/masters/user-material-mappings/bulk', {
        ...values,
        role_ids: selectedRoleIds,
        category_ids: selectedCategoryIds,
        item_ids: selectedItemIds,
      });
      message.success(res.data?.message || 'Role-material mappings saved');
      setRoleKeys([]);
      setMaterialKeys([]);
      loadHistory(1, historySearch);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const historyColumns = [
    {
      title: 'Role / Target Name',
      dataIndex: 'target_name',
      render: (value, row) => {
        if (row.isRoleRow) {
          return (
            <Space size={6}>
              <Text strong>{row.role_code ? `[${row.role_code}]` : ''}</Text>
              <Text type="secondary">{row.role_name}</Text>
            </Space>
          );
        }
        return (
          <Space size={6}>
            <Text>{row.target_code || '-'}</Text>
            <Text type="secondary">{value || '-'}</Text>
          </Space>
        );
      },
    },
    { 
      title: 'Target Type', 
      dataIndex: 'entity_type', 
      width: 150, 
      render: (value, row) => row.isRoleRow ? null : (value === 'item_category' ? 'Category' : 'Item') 
    },
    { 
      title: 'Permission', 
      dataIndex: 'action', 
      width: 150, 
      render: (value, row) => row.isRoleRow ? null : <Tag color="blue">{String(value || '').toUpperCase()}</Tag> 
    },
  ];

  return (
    <div>
      <PageHeader title="Role Material Mapping" subtitle="Map roles to item categories or specific materials">
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>Refresh</Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving}>Save Mapping</Button>
        </Space>
      </PageHeader>

      <Spin spinning={loading}>
        <Row gutter={16}>
          <Col xs={24} lg={10}>
            <Card title="Roles" extra={<Button size="small" onClick={() => setRoleKeys(collectLeafKeys(roleTree, 'role-'))}>Select visible</Button>}>
              <Input.Search placeholder="Search roles" allowClear onChange={(e) => setRoleSearch(e.target.value)} style={{ marginBottom: 12 }} />
              {roleTree.length ? (
                <Tree checkable checkedKeys={roleKeys} onCheck={(checked) => setRoleKeys(Array.isArray(checked) ? checked : checked.checked)} treeData={roleTree} height={750} defaultExpandAll />
              ) : <Empty description="No active roles found" />}
            </Card>
          </Col>

          <Col xs={24} lg={10}>
            <Card title="Item Categories & Materials" extra={<Button size="small" onClick={() => setMaterialKeys(collectLeafKeys(materialTree, 'item-'))}>Select visible items</Button>}>
              <Input.Search placeholder="Search items or categories" allowClear onChange={(e) => setMaterialSearch(e.target.value)} style={{ marginBottom: 12 }} />
              {materialTree.length ? (
                <Tree checkable checkedKeys={materialKeys} onCheck={(checked) => setMaterialKeys(Array.isArray(checked) ? checked : checked.checked)} treeData={materialTree} height={750} defaultExpandAll />
              ) : <Empty description="No items" />}
            </Card>
          </Col>

          <Col xs={24} lg={4}>
            <Card title="Mapping Control">
              <Space direction="vertical" style={{ width: '100%' }} size="middle">
                <Row gutter={8}>
                  <Col span={12}><Statistic title="Roles" value={selectedRoleIds.length} /></Col>
                  <Col span={12}><Statistic title="Targets" value={selectedCategoryIds.length + selectedItemIds.length} /></Col>
                </Row>
                <Tag color="blue">{selectedRoleIds.length * (selectedCategoryIds.length + selectedItemIds.length)} permissions</Tag>
                <Form form={form} layout="vertical">
                  <Form.Item name="action" label="Permission">
                     <Select options={[
                      { label: 'View', value: 'view' },
                      { label: 'Indent', value: 'indent' },
                      { label: 'Consume', value: 'consume' },
                      { label: 'Approve', value: 'approve' },
                      { label: 'Create', value: 'create' },
                    ]}
                    />
                  </Form.Item>
                  <Form.Item name="replace_existing" valuePropName="checked">
                    <Checkbox>Replace existing mappings for selected roles and permission</Checkbox>
                  </Form.Item>
                </Form>
                <Checkbox checked={!roleKeys.length && !materialKeys.length} onChange={() => { setRoleKeys([]); setMaterialKeys([]); }}>
                  Clear selection
                </Checkbox>
              </Space>
            </Card>
          </Col>
        </Row>
        <Card
          title="Mapping History"
          style={{ marginTop: 16 }}
          extra={(
            <Input.Search
              placeholder="Search history"
              allowClear
              onSearch={(value) => {
                setHistorySearch(value);
                loadHistory(1, value);
              }}
              onChange={(e) => {
                if (!e.target.value) {
                  setHistorySearch('');
                  loadHistory(1, '');
                }
              }}
              style={{ width: 260 }}
            />
          )}
        >
          <Table
            rowKey="id"
            size="small"
            columns={historyColumns}
            dataSource={history}
            loading={historyLoading}
            pagination={{
              current: historyPage,
              total: historyTotal,
              pageSize: 1000,
              showSizeChanger: false,
              onChange: (page) => loadHistory(page, historySearch),
            }}
          />
        </Card>
      </Spin>
    </div>
  );
};

export default UserMaterialMapping;
