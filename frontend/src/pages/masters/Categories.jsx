import React, { useState, useEffect } from 'react';
import {
  Card, Tree, Button, Modal, Form, Input, Select, Space, Spin, message,
  Table, Row, Col, Empty, Dropdown, Descriptions, Tag,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, FolderOutlined,
  FolderOpenOutlined, ReloadOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const Categories = () => {
  const [categories, setCategories] = useState([]);
  const [flatCategories, setFlatCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [categoryItems, setCategoryItems] = useState([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const [expandedKeys, setExpandedKeys] = useState([]);
  const [targetLevel, setTargetLevel] = useState(null);

  useEffect(() => {
    fetchCategories();
  }, []);

  useEffect(() => {
    if (selectedCategory) {
      fetchCategoryItems(selectedCategory.id);
    }
  }, [selectedCategory]);

  const fetchCategories = async () => {
    setLoading(true);
    try {
      const res = await api.get('/masters/categories', { params: { page_size: 500 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setFlatCategories(items);
      const tree = buildTree(items);
      setCategories(tree);
      
      setExpandedKeys((prev) => {
        if (prev && prev.length > 0) return prev;
        if (!items.length) return [];
        return items.filter((c) => !c.parent_id).map((c) => String(c.id));
      });
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const buildTree = (list) => {
    const map = {};
    const roots = [];
    list.forEach((item) => {
      map[item.id] = {
        ...item,
        key: String(item.id),
        title: item.name,
        icon: ({ expanded }) => expanded ? <FolderOpenOutlined /> : <FolderOutlined />,
        children: [],
      };
    });
    list.forEach((item) => {
      if (item.parent_id && map[item.parent_id]) {
        map[item.parent_id].children.push(map[item.id]);
      } else if (item.parent_id && !map[item.parent_id]) {
        const node = map[item.id];
        node.title = `${item.name} (orphan)`;
        roots.push(node);
      } else {
        roots.push(map[item.id]);
      }
    });
    return roots;
  };

  const fetchCategoryItems = async (categoryId) => {
    setItemsLoading(true);
    try {
      const collectIds = (rootId) => {
        const ids = [rootId];
        const queue = [rootId];
        while (queue.length) {
          const cur = queue.shift();
          flatCategories
            .filter((c) => c.parent_id === cur)
            .forEach((c) => {
              ids.push(c.id);
              queue.push(c.id);
            });
        }
        return Array.from(new Set(ids));
      };
      const ids = collectIds(categoryId);
      const merged = [];
      for (const cid of ids) {
        try {
          const res = await api.get('/masters/items', {
            params: { category_id: cid, page_size: 100 },
          });
          const data = res.data;
          const arr = data.items || data.data || data || [];
          merged.push(...arr);
        } catch {
          // skip
        }
      }
      const seen = new Set();
      const dedup = [];
      for (const it of merged) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        dedup.push(it);
      }
      setCategoryItems(dedup);
    } catch {
      setCategoryItems([]);
    } finally {
      setItemsLoading(false);
    }
  };

  const handleAddByLevel = (level) => {
    setTargetLevel(level);
    setEditingCategory(null);
    form.resetFields();
    form.setFieldsValue({ parent_id: null });
    setModalOpen(true);
  };

  const handleAddChild = (parentNode) => {
    const parentLevel = parentNode.level || 1;
    if (parentLevel >= 3) {
      message.warning('Only three category levels are allowed');
      return;
    }
    setTargetLevel(parentLevel + 1);
    setEditingCategory(null);
    form.resetFields();
    form.setFieldsValue({ parent_id: parentNode.id });
    setModalOpen(true);
  };

  const handleEdit = (cat) => {
    setTargetLevel(null);
    setEditingCategory(cat);
    form.setFieldsValue({
      name: cat.name,
      description: cat.description,
      parent_id: cat.parent_id || null,
    });
    setModalOpen(true);
  };

  const handleDelete = async (catId) => {
    try {
      await api.delete(`/masters/categories/${catId}`);
      message.success('Category deleted successfully');
      if (selectedCategory?.id === catId) {
        setSelectedCategory(null);
        setCategoryItems([]);
      }
      fetchCategories();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const payload = { ...values };
      if (payload.code != null && String(payload.code).trim() === '') {
        delete payload.code;
      }
      setSubmitting(true);
      if (editingCategory) {
        await api.put(`/masters/categories/${editingCategory.id}`, payload);
        message.success('Category updated successfully');
      } else {
        await api.post('/masters/categories', payload);
        message.success('Category created successfully');
      }
      setModalOpen(false);
      form.resetFields();
      setEditingCategory(null);
      fetchCategories();
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onSelect = (selectedKeys, info) => {
    if (info.selected && info.node) {
      const cat = flatCategories.find((c) => String(c.id) === info.node.key);
      setSelectedCategory(cat || info.node);
    } else {
      setSelectedCategory(null);
      setCategoryItems([]);
    }
  };

  const getContextMenu = (node) => ({
    items: [
      {
        key: 'add-child',
        label: 'Add Child Category',
        icon: <PlusOutlined />,
        disabled: (node.level || 1) >= 3,
        onClick: () => handleAddChild(node),
      },
      {
        key: 'edit',
        label: 'Edit',
        icon: <EditOutlined />,
        onClick: () => handleEdit(node),
      },
      {
        type: 'divider',
      },
      {
        key: 'delete',
        label: 'Delete',
        icon: <DeleteOutlined />,
        danger: true,
        onClick: () => {
          Modal.confirm({
            title: 'Delete Category?',
            content: `Are you sure you want to delete "${node.name || node.title}"? This may affect child categories and items.`,
            okText: 'Delete',
            okButtonProps: { danger: true },
            onOk: () => handleDelete(node.id),
          });
        },
      },
    ],
  });

  const titleRender = (nodeData) => (
    <Dropdown menu={getContextMenu(nodeData)} trigger={['contextMenu']}>
      <span className="cat-tree-node" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
        <span style={{ fontWeight: 500 }}>{nodeData.title}</span>
        {nodeData.full_code && (
          <Tag color="blue" style={{ fontSize: 10, lineHeight: '16px', margin: 0 }}>{nodeData.full_code}</Tag>
        )}
        <Tag
          color={nodeData.is_active === false ? 'red' : 'green'}
          style={{ fontSize: 10, lineHeight: '16px', margin: 0 }}
        >
          {(nodeData.is_active === false ? 'inactive' : 'active').toUpperCase()}
        </Tag>
        <span className="cat-tree-actions" style={{ marginLeft: 8, opacity: 0, transition: 'opacity 0.2s' }}>
          {(nodeData.level || 1) < 3 && (
            <Button type="text" size="small" icon={<PlusOutlined style={{ fontSize: 11 }} />}
              onClick={(e) => { e.stopPropagation(); handleAddChild(nodeData); }} style={{ padding: '0 3px', color: '#1677ff' }} />
          )}
          <Button type="text" size="small" icon={<EditOutlined style={{ fontSize: 11 }} />}
            onClick={(e) => { e.stopPropagation(); handleEdit(nodeData); }} style={{ padding: '0 3px', color: '#8c8c8c' }} />
        </span>
      </span>
    </Dropdown>
  );

  const itemColumns = [
    { title: 'Item Code', dataIndex: 'item_code', key: 'code', width: 120 },
    { title: 'Name', dataIndex: 'name', key: 'name', width: 200, ellipsis: true },
    { title: 'Type', dataIndex: 'item_type', key: 'type', width: 120 },
    { title: 'UOM', dataIndex: ['primary_uom', 'name'], key: 'uom', width: 80, render: (t, r) => t || r.primary_uom_name || '-' },
    { title: 'Status', dataIndex: 'status', key: 'status', width: 90, render: (s) => <Tag color={s === 'active' ? 'green' : 'default'}>{s}</Tag> },
  ];

  return (
    <div>
      <PageHeader title="Categories" subtitle="Manage item category hierarchy">
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={fetchCategories} loading={loading}>
            Refresh
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => handleAddByLevel(1)}>
            Add Level 1 Category
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => handleAddByLevel(2)}>
            Add Level 2 Category
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => handleAddByLevel(3)}>
            Add Level 3 Category
          </Button>
        </Space>
      </PageHeader>

      <Row gutter={16}>
        <Col xs={24} md={10} lg={8}>
          <Card
            title="Category Tree"
            size="small"
            style={{ minHeight: 500 }}
            styles={{ body: { padding: '8px 12px' } }}
          >
            {loading ? (
              <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
            ) : categories.length === 0 ? (
              <Empty description="No categories found" />
            ) : (
              <Tree
                showIcon
                treeData={categories}
                expandedKeys={expandedKeys}
                onExpand={setExpandedKeys}
                onClick={(_e, node) => {
                  if (selectedCategory && String(selectedCategory.id) === node.key) {
                    setSelectedCategory(null);
                    setCategoryItems([]);
                  }
                }}
                onSelect={onSelect}
                selectedKeys={selectedCategory ? [String(selectedCategory.id)] : []}
                titleRender={titleRender}
                blockNode
                style={{ minHeight: 400 }}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} md={14} lg={16}>
          <Card
            title={selectedCategory ? `Category: ${selectedCategory.name}` : 'Select a category'}
            size="small"
            style={{ minHeight: 500 }}
          >
            {selectedCategory ? (
              <>
                <Descriptions size="small" column={{ xs: 1, sm: 2 }} bordered style={{ marginBottom: 16 }}>
                  <Descriptions.Item label="Name">{selectedCategory.name}</Descriptions.Item>
                  <Descriptions.Item label="Code">{selectedCategory.code || '-'}</Descriptions.Item>
                  <Descriptions.Item label="Short Code">{selectedCategory.short_code || '-'}</Descriptions.Item>
                  <Descriptions.Item label="Full Code">{selectedCategory.full_code || '-'}</Descriptions.Item>
                  <Descriptions.Item label="Level">{selectedCategory.level || '-'}</Descriptions.Item>
                  <Descriptions.Item label="Status">
                    <Tag color={selectedCategory.is_active === false ? 'red' : 'green'}>
                      {(selectedCategory.is_active === false ? 'inactive' : 'active').toUpperCase()}
                    </Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="Parent">
                    {selectedCategory.parent_id
                      ? flatCategories.find((c) => c.id === selectedCategory.parent_id)?.name || '-'
                      : 'Root'
                    }
                  </Descriptions.Item>
                  <Descriptions.Item label="Description" span={2}>{selectedCategory.description || '-'}</Descriptions.Item>
                </Descriptions>
                <h4 style={{ marginBottom: 8 }}>Items in this category</h4>
                <Table
                  columns={itemColumns}
                  dataSource={categoryItems}
                  loading={itemsLoading}
                  rowKey="id"
                  size="small"
                  pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t, r) => `${r[0]}-${r[1]} of ${t}` }}
                  scroll={{ x: 'max-content' }}
                />
              </>
            ) : (
              <Empty description="Select a category from the tree to view details" />
            )}
          </Card>
        </Col>
      </Row>

      <Modal
        title={editingCategory ? 'Edit Category' : `Add Level ${targetLevel} Category`}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => { setModalOpen(false); setEditingCategory(null); form.resetFields(); }}
        confirmLoading={submitting}
        okText={editingCategory ? 'Update' : 'Create'}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="name"
            label="Category Name"
            rules={[{ required: true, message: 'Category name is required' }]}
          >
            <Input placeholder="Enter category name" />
          </Form.Item>
          
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} placeholder="Category description" />
          </Form.Item>

          <Form.Item
            name="parent_id"
            label={targetLevel === 2 ? 'L1 Parent Category' : targetLevel === 3 ? 'L2 Parent Category' : 'Parent Category'}
            hidden={targetLevel === 1}
            rules={[{ required: targetLevel > 1 && !editingCategory, message: 'Parent category is required' }]}
          >
            <Select
              placeholder={targetLevel === 2 ? 'Select L1 parent' : targetLevel === 3 ? 'Select L2 parent' : 'Select parent'}
              allowClear={!!(targetLevel === 1 || editingCategory)}
              showSearch
              optionFilterProp="label"
              options={(() => {
                if (editingCategory) {
                  // When editing, show all except self and descendants to avoid cycles
                  const blocked = new Set([editingCategory.id]);
                  const childMap = {};
                  flatCategories.forEach((c) => {
                    if (c.parent_id) {
                      (childMap[c.parent_id] ||= []).push(c.id);
                    }
                  });
                  const stack = [editingCategory.id];
                  while (stack.length) {
                    const cur = stack.pop();
                    for (const childId of childMap[cur] || []) {
                      if (!blocked.has(childId)) {
                        blocked.add(childId);
                        stack.push(childId);
                      }
                    }
                  }
                  return flatCategories
                    .filter((c) => !blocked.has(c.id))
                    .map(c => ({ label: c.name, value: c.id }));
                }

                // When adding, filter based on targetLevel
                if (targetLevel === 2) {
                  return flatCategories
                    .filter(c => c.level === 1 || !c.parent_id)
                    .map(c => ({ label: c.name, value: c.id }));
                }
                if (targetLevel === 3) {
                  return flatCategories
                    .filter(c => c.level === 2)
                    .map(c => ({ label: c.name, value: c.id }));
                }
                return [];
              })()}
            />
          </Form.Item>
          
        </Form>
      </Modal>

      <style>{`
        .cat-tree-node:hover .cat-tree-actions { opacity: 1 !important; }
        .ant-tree-treenode { padding: 3px 0 !important; }
        .ant-tree-node-content-wrapper { padding: 2px 8px !important; border-radius: 6px !important; }
        .ant-tree-node-content-wrapper:hover { background: #f0f0f0 !important; }
        .ant-tree-node-selected .ant-tree-node-content-wrapper { background: #e6f4ff !important; }
      `}</style>
    </div>
  );
};

export default Categories;
