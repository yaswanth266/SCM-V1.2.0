import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card, Button, Modal, Form, Input, Select, Switch, Space,
  Popconfirm, message, InputNumber, DatePicker, Table, Tag, Row, Col,
  Spin, Empty,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, DownloadOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import {
  formatCurrency, formatDate, getErrorMessage, downloadExcel,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const PriceLists = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  // Price list items
  const [expandedPLId, setExpandedPLId] = useState(null);
  const [plItems, setPlItems] = useState([]);
  const [plItemsLoading, setPlItemsLoading] = useState(false);

  // Item modal
  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [itemForm] = Form.useForm();
  const [itemSubmitting, setItemSubmitting] = useState(false);
  const [currentPLId, setCurrentPLId] = useState(null);

  const fetchPriceLists = useCallback(async (params) => {
    return await api.get('/masters/price-lists', { params });
  }, []);

  const handleAdd = () => {
    navigate('/masters/price-lists/new');
  };

  const handleEdit = (record) => {
    navigate(`/masters/price-lists/${record.id}/edit`);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/masters/price-lists/${id}`);
      message.success('Price list deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // Price List Items
  const fetchPLItems = async (plId) => {
    setPlItemsLoading(true);
    try {
      const res = await api.get(`/masters/price-lists/${plId}/items`, { params: { page_size: 500 } });
      const data = res.data;
      setPlItems(data.items || data.data || data || []);
    } catch {
      setPlItems([]);
    } finally {
      setPlItemsLoading(false);
    }
  };

  const handleExpand = (expanded, record) => {
    if (expanded) {
      setExpandedPLId(record.id);
      fetchPLItems(record.id);
    } else {
      setExpandedPLId(null);
      setPlItems([]);
    }
  };

  const handleAddItem = (plId) => {
    setCurrentPLId(plId);
    setEditingItem(null);
    itemForm.resetFields();
    setItemModalOpen(true);
  };

  const handleEditItem = (plId, record) => {
    setCurrentPLId(plId);
    setEditingItem(record);
    itemForm.setFieldsValue({
      item_id: record.item_id || record.item?.id,
      rate: record.rate,
      min_qty: record.min_qty,
      max_qty: record.max_qty,
      discount_percent: record.discount_percent,
    });
    setItemModalOpen(true);
  };

  const handleDeleteItem = async (plId, itemId) => {
    try {
      await api.delete(`/masters/price-lists/${plId}/items/${itemId}`);
      message.success('Item removed from price list');
      fetchPLItems(plId);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleItemSubmit = async () => {
    try {
      const values = await itemForm.validateFields();
      setItemSubmitting(true);
      if (editingItem) {
        await api.put(`/masters/price-lists/${currentPLId}/items/${editingItem.id}`, values);
        message.success('Item updated');
      } else {
        await api.post(`/masters/price-lists/${currentPLId}/items`, values);
        message.success('Item added to price list');
      }
      setItemModalOpen(false);
      itemForm.resetFields();
      setEditingItem(null);
      fetchPLItems(currentPLId);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setItemSubmitting(false);
    }
  };

  const handleExport = async () => {
    try {
      const res = await api.get('/masters/price-lists', { params: { page_size: 10000 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      const exportData = items.map((pl) => ({
        'Name': pl.name,
        'Type': pl.type,
        'Currency': pl.currency,
        'Valid From': pl.valid_from || '',
        'Valid To': pl.valid_to || '',
        'Default': pl.is_default ? 'Yes' : 'No',
        'Status': pl.status,
      }));
      downloadExcel(exportData, 'price_lists', 'Price Lists');
      message.success('Export completed');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      width: 220,
      sorter: true,
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 110,
      render: (v) => (
        <Tag color={v === 'buying' ? 'blue' : 'green'}>
          {v === 'buying' ? 'Buying' : 'Selling'}
        </Tag>
      ),
    },
    { title: 'Currency', dataIndex: 'currency', key: 'currency', width: 90 },
    {
      title: 'Valid From',
      dataIndex: 'valid_from',
      key: 'valid_from',
      width: 120,
      render: (v) => formatDate(v),
    },
    {
      title: 'Valid To',
      dataIndex: 'valid_to',
      key: 'valid_to',
      width: 120,
      render: (v) => formatDate(v),
    },
    {
      title: 'Default',
      dataIndex: 'is_default',
      key: 'is_default',
      width: 90,
      render: (v) => v ? <Tag color="gold">Default</Tag> : '-',
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
      width: 150,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button
            type="link"
            size="small"
            icon={<UnorderedListOutlined />}
            onClick={() => {
              if (expandedPLId === record.id) {
                setExpandedPLId(null);
                setPlItems([]);
              } else {
                setExpandedPLId(record.id);
                fetchPLItems(record.id);
              }
            }}
            title="View Items"
          />
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          <Popconfirm
            title="Delete this price list?"
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

  const plItemColumns = [
    {
      title: 'Item Code',
      dataIndex: ['item', 'item_code'],
      key: 'code',
      width: 120,
      render: (t, r) => t || r.item_code || '-',
    },
    {
      title: 'Item Name',
      dataIndex: ['item', 'name'],
      key: 'name',
      width: 200,
      render: (t, r) => t || r.item_name || '-',
      ellipsis: true,
    },
    {
      title: 'Rate',
      dataIndex: 'rate',
      key: 'rate',
      width: 120,
      align: 'right',
      render: (v) => formatCurrency(v),
    },
    {
      title: 'Min Qty',
      dataIndex: 'min_qty',
      key: 'min',
      width: 90,
      align: 'right',
      render: (v) => v ?? '-',
    },
    {
      title: 'Max Qty',
      dataIndex: 'max_qty',
      key: 'max',
      width: 90,
      align: 'right',
      render: (v) => v ?? '-',
    },
    {
      title: 'Discount %',
      dataIndex: 'discount_percent',
      key: 'disc',
      width: 100,
      align: 'right',
      render: (v) => v != null ? `${v}%` : '-',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 100,
      render: (_, record) => (
        <Space size="small">
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEditItem(expandedPLId, record)}
          />
          <Popconfirm
            title="Remove item?"
            onConfirm={() => handleDeleteItem(expandedPLId, record.id)}
            okText="Remove"
            okButtonProps={{ danger: true }}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const expandedRowRender = (record) => {
    if (expandedPLId !== record.id) return null;
    return (
      <div style={{ padding: '8px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <strong>Items in Price List</strong>
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => handleAddItem(record.id)}>
            Add Item
          </Button>
        </div>
        <Table
          columns={plItemColumns}
          dataSource={plItems}
          loading={plItemsLoading}
          rowKey="id"
          size="small"
          pagination={{ pageSize: 10, showSizeChanger: true }}
          scroll={{ x: 'max-content' }}
        />
      </div>
    );
  };

  return (
    <div>
      <PageHeader title="Price Lists" subtitle="Manage buying and selling price lists">
        <Space>
          <Button icon={<DownloadOutlined />} onClick={handleExport}>
            Export
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            Add Price List
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchPriceLists}
        rowKey="id"
        searchPlaceholder="Search price lists..."
        exportFileName="price_lists"
        scroll={{ x: 1200 }}
        expandable={{
          expandedRowRender,
          expandedRowKeys: expandedPLId ? [expandedPLId] : [],
          onExpand: handleExpand,
        }}
      />



      {/* Item Modal */}
      <Modal
        title={editingItem ? 'Edit Item in Price List' : 'Add Item to Price List'}
        open={itemModalOpen}
        onOk={handleItemSubmit}
        onCancel={() => { setItemModalOpen(false); setEditingItem(null); itemForm.resetFields(); }}
        confirmLoading={itemSubmitting}
        okText={editingItem ? 'Update' : 'Add'}
        destroyOnHidden
        width={500}
      >
        <Form form={itemForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="item_id" label="Item" rules={[{ required: true, message: 'Select an item' }]}>
            <ItemSelector placeholder="Search and select item" disabled={!!editingItem} />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="rate" label="Rate" rules={[{ required: true, message: 'Required' }]}>
                <InputNumber min={0} step={0.01} style={{ width: '100%' }} placeholder="0.00" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="discount_percent" label="Discount (%)">
                <InputNumber min={0} max={100} step={0.01} style={{ width: '100%' }} placeholder="0" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="min_qty" label="Min Qty">
                <InputNumber min={0} style={{ width: '100%' }} placeholder="0" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="max_qty" label="Max Qty">
                <InputNumber min={0} style={{ width: '100%' }} placeholder="0" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
};

export default PriceLists;

