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
      if (String(node.key).startsWith(prefix)) out.push(node.key);
      if (node.children) walk(node.children);
    });
  };
  walk(nodes);
  return out;
};

const idsFromKeys = (keys, prefix) => keys
  .filter((key) => String(key).startsWith(prefix))
  .map((key) => Number(String(key).replace(prefix, '')))
  .filter(Boolean);

const textMatches = (value, query) => String(value || '').toLowerCase().includes(query);
const userMatches = (user, query) => textMatches(`${user.username || ''} ${user.name || ''} ${user.employee_code || ''}`, query);
const positionMatches = (position, query) => textMatches(`${position.code || ''} ${position.name || ''}`, query);
const projectMatches = (project, query) => textMatches(`${project.code || ''} ${project.name}`, query);
const itemMatches = (item, query) => textMatches(`${item.item_code || ''} ${item.name || ''}`, query);
const categoryMatches = (cat, query) => textMatches(`${cat.full_code || ''} ${cat.code || ''} ${cat.name || ''}`, query);

const buildUserTree = (projects, positions, users, query = '') => {
  const usersByPosition = new Map();
  users.forEach((user) => {
    const positionId = user.position_id || 0;
    usersByPosition.set(positionId, [...(usersByPosition.get(positionId) || []), user]);
  });

  const userNode = (user) => ({
    key: `user-${user.id}`,
    title: (
      <Space size={6}>
        <Text>{user.employee_code || user.username}</Text>
        <Text type="secondary">{user.name}</Text>
      </Space>
    ),
    isLeaf: true,
  });

  const makePositionNode = (position, forceVisible = false) => {
    const positionUsers = usersByPosition.get(position.id) || [];
    const visibleUsers = query && !forceVisible && !positionMatches(position, query)
      ? positionUsers.filter((user) => userMatches(user, query))
      : positionUsers;
    if (query && !forceVisible && !positionMatches(position, query) && !visibleUsers.length) return null;
    return {
      key: `position-${position.id}`,
      title: `${position.code || ''} ${position.name}`.trim(),
      children: visibleUsers.map(userNode),
    };
  };

  const projectNodes = projects
    .map((project) => {
      const forceProjectVisible = query && projectMatches(project, query);
      const projectPositions = positions.filter((pos) => pos.project_id === project.id);
      
      const positionsByRole = new Map();
      projectPositions.forEach((pos) => {
        const role = (pos.role_name || 'No Role').trim();
        positionsByRole.set(role, [...(positionsByRole.get(role) || []), pos]);
      });

      const roleNodes = [];
      positionsByRole.forEach((rolePositions, roleName) => {
        const forceRoleVisible = forceProjectVisible || (query && roleName.toLowerCase().includes(query));
        const positionNodes = rolePositions
          .map((position) => makePositionNode(position, forceRoleVisible))
          .filter(Boolean);

        if (query && !forceRoleVisible && !positionNodes.length) return;

        roleNodes.push({
          key: `project-${project.id}-role-${roleName}`,
          title: roleName,
          children: positionNodes,
        });
      });

      roleNodes.sort((a, b) => a.title.localeCompare(b.title));

      if (query && !forceProjectVisible && !roleNodes.length) return null;

      return {
        key: `project-${project.id}`,
        title: `${project.code || ''} ${project.name}`.trim(),
        children: roleNodes,
      };
    })
    .filter(Boolean);

  const unassignedPositions = positions.filter((pos) => !pos.project_id || pos.project_id === 0);
  const unassignedPositionsByRole = new Map();
  unassignedPositions.forEach((pos) => {
    const role = (pos.role_name || 'No Role').trim();
    unassignedPositionsByRole.set(role, [...(unassignedPositionsByRole.get(role) || []), pos]);
  });

  const unassignedRoleNodes = [];
  unassignedPositionsByRole.forEach((rolePositions, roleName) => {
    const forceRoleVisible = query && roleName.toLowerCase().includes(query);
    const positionNodes = rolePositions
      .map((position) => makePositionNode(position, forceRoleVisible))
      .filter(Boolean);

    if (query && !forceRoleVisible && !positionNodes.length) return;

    unassignedRoleNodes.push({
      key: `project-unassigned-role-${roleName}`,
      title: roleName,
      children: positionNodes,
    });
  });
  unassignedRoleNodes.sort((a, b) => a.title.localeCompare(b.title));

  const unassignedUsers = (usersByPosition.get(0) || [])
    .filter((user) => !query || userMatches(user, query))
    .map(userNode);

  const extras = [];
  if (unassignedRoleNodes.length) {
    extras.push({
      key: 'project-unassigned',
      title: 'No Project',
      children: unassignedRoleNodes,
    });
  }
  if (unassignedUsers.length) {
    extras.push({
      key: 'position-unassigned',
      title: 'No Position',
      children: unassignedUsers,
    });
  }

  return [...projectNodes, ...extras];
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
  const [data, setData] = useState({ projects: [], positions: [], users: [], categories: [], items: [] });
  const [userKeys, setUserKeys] = useState([]);
  const [materialKeys, setMaterialKeys] = useState([]);
  const [userSearch, setUserSearch] = useState('');
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
        params: { page, page_size: 20, search: search || undefined },
      });
      setHistory(res.data?.items || []);
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

  const userTree = useMemo(
    () => buildUserTree(data.projects || [], data.positions || [], data.users || [], userSearch.trim().toLowerCase()),
    [data.projects, data.positions, data.users, userSearch],
  );
  const materialTree = useMemo(
    () => buildItemTree(data.categories || [], data.items || [], materialSearch.trim().toLowerCase()),
    [data.categories, data.items, materialSearch],
  );
  const selectedUserIds = useMemo(() => idsFromKeys(userKeys, 'user-'), [userKeys]);
  const selectedCategoryIds = useMemo(() => idsFromKeys(materialKeys, 'cat-'), [materialKeys]);
  const selectedItemIds = useMemo(() => idsFromKeys(materialKeys, 'item-'), [materialKeys]);

  const handleSave = async () => {
    if (!selectedUserIds.length) {
      message.warning('Select at least one user');
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
        user_ids: selectedUserIds,
        category_ids: selectedCategoryIds,
        item_ids: selectedItemIds,
      });
      message.success(res.data?.message || 'User-material mappings saved');
      setUserKeys([]);
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
      title: 'User',
      dataIndex: 'user_name',
      render: (value, row) => (
        <Space size={6}>
          <Text>{row.employee_code || row.username}</Text>
          <Text type="secondary">{value}</Text>
        </Space>
      ),
    },
    { title: 'Target Type', dataIndex: 'entity_type', width: 130, render: (value) => (value === 'item_category' ? 'Category' : 'Item') },
    {
      title: 'Target',
      dataIndex: 'target_name',
      render: (value, row) => (
        <Space size={6}>
          <Text>{row.target_code || '-'}</Text>
          <Text type="secondary">{value || '-'}</Text>
        </Space>
      ),
    },
    { title: 'Permission', dataIndex: 'action', width: 120, render: (value) => <Tag color="blue">{String(value || '').toUpperCase()}</Tag> },
  ];

  return (
    <div>
      <PageHeader title="User Material Mapping" subtitle="Map users by project and position to item categories or specific materials">
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>Refresh</Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving}>Save Mapping</Button>
        </Space>
      </PageHeader>

      <Spin spinning={loading}>
        <Row gutter={16}>
          <Col xs={24} lg={8}>
            <Card title="Projects, Positions & Users" extra={<Button size="small" onClick={() => setUserKeys(collectLeafKeys(userTree, 'user-'))}>Select visible</Button>}>
              <Input.Search placeholder="Search users" allowClear onChange={(e) => setUserSearch(e.target.value)} style={{ marginBottom: 12 }} />
              {userTree.length ? (
                <Tree checkable checkedKeys={userKeys} onCheck={(checked) => setUserKeys(Array.isArray(checked) ? checked : checked.checked)} treeData={userTree} height={520} defaultExpandAll />
              ) : <Empty description="No linked users" />}
            </Card>
          </Col>

          <Col xs={24} lg={10}>
            <Card title="Item Categories & Materials" extra={<Button size="small" onClick={() => setMaterialKeys(collectLeafKeys(materialTree, 'item-'))}>Select visible items</Button>}>
              <Input.Search placeholder="Search items or categories" allowClear onChange={(e) => setMaterialSearch(e.target.value)} style={{ marginBottom: 12 }} />
              {materialTree.length ? (
                <Tree checkable checkedKeys={materialKeys} onCheck={(checked) => setMaterialKeys(Array.isArray(checked) ? checked : checked.checked)} treeData={materialTree} height={520} defaultExpandAll />
              ) : <Empty description="No items" />}
            </Card>
          </Col>

          <Col xs={24} lg={6}>
            <Card title="Mapping Control">
              <Space direction="vertical" style={{ width: '100%' }} size="middle">
                <Row gutter={8}>
                  <Col span={12}><Statistic title="Users" value={selectedUserIds.length} /></Col>
                  <Col span={12}><Statistic title="Targets" value={selectedCategoryIds.length + selectedItemIds.length} /></Col>
                </Row>
                <Tag color="blue">{selectedUserIds.length * (selectedCategoryIds.length + selectedItemIds.length)} permissions</Tag>
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
                    <Checkbox>Replace existing mappings for selected users and permission</Checkbox>
                  </Form.Item>
                </Form>
                <Checkbox checked={!userKeys.length && !materialKeys.length} onChange={() => { setUserKeys([]); setMaterialKeys([]); }}>
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
              pageSize: 20,
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
