import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Modal,
  Divider, Typography, Tooltip, Tag, Steps, Alert, Badge, Timeline,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  SendOutlined, CheckOutlined, CloseCircleOutlined,
  MinusCircleOutlined, SwapOutlined, CarOutlined, InboxOutlined,
  CheckCircleFilled, ClockCircleFilled, SyncOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import WarehouseTree from '../../components/WarehouseTree';
import api from '../../config/api';
import {
  formatDate, formatDateTime, formatCurrency, formatNumber, getErrorMessage,
  formatDateForAPI,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text, Title } = Typography;

const TRANSFER_TYPES = [
  { label: 'Warehouse to Warehouse', value: 'warehouse_to_warehouse' },
  { label: 'Location to Location', value: 'location_to_location' },
  { label: 'Bin to Bin', value: 'bin_to_bin' },
];

const TRANSFER_STATUSES = [
  { label: 'Draft', value: 'draft' },
  { label: 'Pending Approval', value: 'pending_approval' },
  { label: 'Approved', value: 'approved' },
  { label: 'In Transit', value: 'in_transit' },
  { label: 'Received', value: 'received' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const STATUS_STEP_MAP = {
  draft: 0,
  pending_approval: 1,
  approved: 2,
  in_transit: 3,
  received: 4,
  completed: 5,
};

const StockTransfer = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [viewData, setViewData] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [editingTransfer, setEditingTransfer] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);

  // Drawer state
  const [transferItems, setTransferItems] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [uomOptions, setUomOptions] = useState([]);

  // Load lookups
  const loadLookups = useCallback(async () => {
    try {
      const [whRes, uomRes] = await Promise.allSettled([
        api.get('/masters/warehouses', { params: { page_size: 200 } }),
        api.get('/masters/uom', { params: { page_size: 200 } }),
      ]);
      if (whRes.status === 'fulfilled') {
        const d = whRes.value.data;
        const items = d.items || d.data || d || [];
        setWarehouses(items.map((w) => ({
          label: w.name || w.warehouse_name,
          value: w.id,
        })));
      }
      if (uomRes.status === 'fulfilled') {
        const u = uomRes.value.data;
        setUomOptions(
          (u.items || u.data || u || []).map((i) => ({
            label: i.name || i.uom_name || i.code,
            value: i.id,
          }))
        );
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    loadLookups();
  }, [loadLookups]);

  // Fetch transfers
  const fetchTransfers = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      return await api.get('/inventory/stock-transfers', { params: qp });
    },
    [filterStatus, filterWarehouse]
  );

  // Item row helpers
  const createEmptyItem = () => ({
    key: Date.now() + Math.random(),
    item_id: null,
    item_name: '',
    item_code: '',
    batch: '',
    batch_id: null,
    qty: 0,
    uom: '',
    uom_id: null,
    primary_uom_id: null,
    source_bin: undefined,
    source_bin_id: null,
    destination_bin: undefined,
    destination_bin_id: null,
  });

  const updateTransferItem = (key, field, value) => {
    setTransferItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        return { ...item, [field]: value };
      })
    );
  };

  const addTransferItemRow = () => {
    setTransferItems((prev) => [...prev, createEmptyItem()]);
  };

  const removeTransferItemRow = (key) => {
    setTransferItems((prev) => prev.filter((i) => i.key !== key));
  };

  // Open drawer
  const handleAdd = () => {
    setEditingTransfer(null);
    form.resetFields();
    form.setFieldsValue({
      transfer_date: dayjs(),
      transfer_type: 'warehouse_to_warehouse',
    });
    setTransferItems([createEmptyItem()]);
    setDrawerOpen(true);
  };

  const handleEdit = async (record) => {
    setEditingTransfer(record);
    try {
      const res = await api.get(`/inventory/stock-transfers/${record.id}`);
      const data = res.data;
      form.setFieldsValue({
        source_warehouse_id: data.source_warehouse_id,
        destination_warehouse_id: data.destination_warehouse_id,
        transfer_date: data.transfer_date ? dayjs(data.transfer_date) : dayjs(),
        transfer_type: data.transfer_type || 'warehouse_to_warehouse',
        remarks: data.remarks,
      });
      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_name: item.item_name || '',
        item_code: item.item_code || '',
        batch: item.batch || '',
        batch_id: item.batch_id || null,
        qty: item.qty || 0,
        received_qty: item.received_qty || 0,
        uom: item.uom || '',
        uom_id: item.uom_id || null,
        primary_uom_id: item.primary_uom_id || null,
        source_bin: item.source_bin || undefined,
        source_bin_id: item.source_bin_id || null,
        destination_bin: item.destination_bin || undefined,
        destination_bin_id: item.destination_bin_id || null,
      }));
      setTransferItems(items.length > 0 ? items : [createEmptyItem()]);
      setDrawerOpen(true);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // View detail
  const handleView = async (record) => {
    setViewLoading(true);
    setViewModalOpen(true);
    try {
      const res = await api.get(`/inventory/stock-transfers/${record.id}`);
      setViewData(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
      setViewModalOpen(false);
    } finally {
      setViewLoading(false);
    }
  };

  // Submit
  const handleSubmit = async (submitAction = 'draft') => {
    try {
      const values = await form.validateFields();
      const validItems = transferItems.filter((i) => i.item_id && i.qty > 0);
      if (validItems.length === 0) {
        message.error('Please add at least one item with quantity');
        return;
      }
      // BUG-INV-068: bin_to_bin transfers MUST keep the source warehouse
      // equal to the destination warehouse. The form previously let users
      // pick different warehouses with type=bin_to_bin and the backend then
      // rejected at create-time, but only after a confusing error.
      if (
        values.transfer_type === 'bin_to_bin'
        && values.source_warehouse_id !== values.destination_warehouse_id
      ) {
        message.error('bin_to_bin transfers require the same warehouse on both sides');
        return;
      }
      if (
        values.transfer_type !== 'bin_to_bin'
        && values.source_warehouse_id === values.destination_warehouse_id
      ) {
        message.error('Source and destination warehouses must differ (use bin_to_bin for same-warehouse moves)');
        return;
      }
      setSubmitting(true);

      let status = 'draft';
      if (submitAction === 'submit_approval') status = 'pending_approval';

      const payload = {
        source_warehouse_id: values.source_warehouse_id,
        destination_warehouse_id: values.destination_warehouse_id,
        transfer_date: formatDateForAPI(values.transfer_date),
        transfer_type: values.transfer_type || 'warehouse_to_warehouse',
        remarks: values.remarks,
        items: validItems.map((item) => ({
          item_id: item.item_id,
          batch_id: item.batch_id || null,
          qty: item.qty,
          uom_id: item.uom_id || item.primary_uom_id || 1,
          source_bin_id: item.source_bin_id || null,
          destination_bin_id: item.destination_bin_id || null,
        })),
      };

      if (editingTransfer) {
        await api.put(`/inventory/stock-transfers/${editingTransfer.id}`, payload);
        message.success('Transfer updated successfully');
      } else {
        await api.post('/inventory/stock-transfers', payload);
        message.success('Transfer created successfully');
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingTransfer(null);
      setTransferItems([]);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // Actions
  const handleAction = async (id, action, successMsg) => {
    try {
      await api.post(`/inventory/stock-transfers/${id}/${action}`);
      message.success(successMsg);
      setRefreshKey((k) => k + 1);
      if (viewModalOpen) {
        const res = await api.get(`/inventory/stock-transfers/${id}`);
        setViewData(res.data);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/inventory/stock-transfers/${id}`);
      message.success('Transfer deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // Transfer items columns (drawer)
  const transferItemColumns = [
    { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item',
      dataIndex: 'item_id',
      width: 200,
      render: (val, record) =>
        record.item_name && editingTransfer ? (
          <Tooltip title={record.item_name}>
            <Text ellipsis style={{ maxWidth: 180 }}>{record.item_name}</Text>
          </Tooltip>
        ) : (
          <ItemSelector
            value={val}
            onChange={(itemId, item) => {
              updateTransferItem(record.key, 'item_id', itemId);
              if (item) {
                updateTransferItem(record.key, 'item_name', item.item_name || item.name || '');
                updateTransferItem(record.key, 'item_code', item.item_code || item.code || '');
                updateTransferItem(record.key, 'uom', item.primary_uom?.name || item.primary_uom_name || '');
                updateTransferItem(record.key, 'uom_id', item.primary_uom_id || null);
              }
            }}
            style={{ width: '100%' }}
          />
        ),
    },
    {
      title: 'Batch',
      dataIndex: 'batch',
      width: 100,
      render: (val, record) => (
        <Input
          value={val}
          onChange={(e) => updateTransferItem(record.key, 'batch', e.target.value)}
          size="small"
          placeholder="Batch"
        />
      ),
    },
    {
      title: 'Qty',
      dataIndex: 'qty',
      width: 90,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateTransferItem(record.key, 'qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'UOM',
      dataIndex: 'uom_id',
      width: 110,
      render: (val, record) => (
        <Select
          value={val}
          onChange={(v) => updateTransferItem(record.key, 'uom_id', v)}
          options={uomOptions}
          placeholder="UOM"
          size="small"
          style={{ width: '100%' }}
          showSearch
          optionFilterProp="label"
        />
      ),
    },
    {
      title: 'Source Bin',
      dataIndex: 'source_bin',
      width: 180,
      render: (val, record) => (
        <WarehouseTree
          value={val}
          onChange={(v) => {
            updateTransferItem(record.key, 'source_bin', v);
            // Extract numeric bin ID from "bin-123" format
            // BUG-INV-116: only bin-* keys map to a real bin_id. Any other
            // key (location-*, line-*, rack-*) or empty value resolves to
            // null instead of NaN — sending NaN as bin_id silently broke
            // the backend cast and bin validation downstream.
            let binId = null;
            if (typeof v === 'number' && Number.isFinite(v)) {
              binId = v;
            } else if (typeof v === 'string' && v.startsWith('bin-')) {
              const parsed = parseInt(v.split('-')[1], 10);
              binId = Number.isFinite(parsed) ? parsed : null;
            }
            updateTransferItem(record.key, 'source_bin_id', binId);
          }}
          placeholder="Source bin..."
          selectableLevel="bin"
        />
      ),
    },
    {
      title: 'Destination Bin',
      dataIndex: 'destination_bin',
      width: 180,
      render: (val, record) => (
        <WarehouseTree
          value={val}
          onChange={(v) => {
            updateTransferItem(record.key, 'destination_bin', v);
            // BUG-INV-116: only bin-* keys map to a real bin_id. Any other
            // key (location-*, line-*, rack-*) or empty value resolves to
            // null instead of NaN — sending NaN as bin_id silently broke
            // the backend cast and bin validation downstream.
            let binId = null;
            if (typeof v === 'number' && Number.isFinite(v)) {
              binId = v;
            } else if (typeof v === 'string' && v.startsWith('bin-')) {
              const parsed = parseInt(v.split('-')[1], 10);
              binId = Number.isFinite(parsed) ? parsed : null;
            }
            updateTransferItem(record.key, 'destination_bin_id', binId);
          }}
          placeholder="Dest bin..."
          selectableLevel="bin"
        />
      ),
    },
    {
      title: '',
      width: 40,
      render: (_, record) => (
        transferItems.length > 1 ? (
          <Button
            type="text"
            danger
            icon={<MinusCircleOutlined />}
            size="small"
            onClick={() => removeTransferItemRow(record.key)}
          />
        ) : null
      ),
    },
  ];

  // Main table columns
  const columns = [
    {
      title: 'Transfer No',
      dataIndex: 'transfer_number',
      width: 150,
      fixed: 'left',
      sorter: true,
      render: (val, record) => (
        <Button type="link" size="small" onClick={() => handleView(record)}>
          {val}
        </Button>
      ),
    },
    {
      title: 'Source Warehouse',
      dataIndex: 'source_warehouse_name',
      width: 160,
      sorter: true,
      render: (val) => val || '-',
    },
    {
      title: 'Destination Warehouse',
      dataIndex: 'destination_warehouse_name',
      width: 170,
      sorter: true,
      render: (val) => val || '-',
    },
    {
      title: 'Transfer Date',
      dataIndex: 'transfer_date',
      width: 120,
      sorter: true,
      render: (val) => formatDate(val),
    },
    {
      title: 'Transfer Type',
      dataIndex: 'transfer_type',
      width: 160,
      render: (val) => {
        const found = TRANSFER_TYPES.find((t) => t.value === val);
        return <Tag>{found ? found.label : val || '-'}</Tag>;
      },
    },
    {
      title: 'Items',
      dataIndex: 'total_items',
      width: 70,
      align: 'center',
      render: (val) => val || 0,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 130,
      render: (val) => <StatusTag status={val} />,
    },
    {
      title: 'Created By',
      dataIndex: 'created_by',
      width: 120,
      render: (val) => val || '-',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      fixed: 'right',
      render: (_, record) => {
        const st = (record.status || '').toLowerCase();
        return (
          <Space size="small">
            <Tooltip title="View">
              <Button type="text" icon={<EyeOutlined />} size="small" onClick={() => handleView(record)} />
            </Tooltip>
            {st === 'draft' && (
              <>
                <Tooltip title="Edit">
                  <Button type="text" icon={<EditOutlined />} size="small" onClick={() => handleEdit(record)} />
                </Tooltip>
                <Tooltip title="Submit for Approval">
                  <Popconfirm title="Submit for approval?" onConfirm={() => handleAction(record.id, 'submit', 'Submitted for approval')}>
                    <Button type="text" icon={<SendOutlined />} size="small" />
                  </Popconfirm>
                </Tooltip>
                <Popconfirm title="Delete this transfer?" onConfirm={() => handleDelete(record.id)}>
                  <Button type="text" danger icon={<DeleteOutlined />} size="small" />
                </Popconfirm>
              </>
            )}
            {st === 'pending_approval' && (
              <Tooltip title="Approve">
                <Popconfirm title="Approve this transfer?" onConfirm={() => handleAction(record.id, 'approve', 'Transfer approved')}>
                  <Button type="text" icon={<CheckOutlined />} size="small" style={{ color: '#52c41a' }} />
                </Popconfirm>
              </Tooltip>
            )}
            {st === 'approved' && (
              <Tooltip title="Dispatch">
                <Popconfirm title="Mark as dispatched?" onConfirm={() => handleAction(record.id, 'dispatch', 'Transfer dispatched')}>
                  <Button type="text" icon={<CarOutlined />} size="small" style={{ color: '#eb2f96' }} />
                </Popconfirm>
              </Tooltip>
            )}
            {st === 'in_transit' && (
              <Tooltip title="Receive">
                <Popconfirm title="Mark as received?" onConfirm={() => handleAction(record.id, 'receive', 'Transfer received')}>
                  <Button type="text" icon={<InboxOutlined />} size="small" style={{ color: '#52c41a' }} />
                </Popconfirm>
              </Tooltip>
            )}
            {st === 'received' && (
              <Tooltip title="Complete">
                <Popconfirm title="Mark as complete?" onConfirm={() => handleAction(record.id, 'complete', 'Transfer completed')}>
                  <Button type="text" icon={<CheckCircleFilled />} size="small" style={{ color: '#52c41a' }} />
                </Popconfirm>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
  ];

  // View modal items columns
  const viewItemColumns = [
    { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
    { title: 'Item Code', dataIndex: 'item_code', width: 110 },
    {
      title: 'Item Name',
      dataIndex: 'item_name',
      width: 180,
      render: (val) => (
        <Tooltip title={val}>
          <Text ellipsis style={{ maxWidth: 160 }}>{val || '-'}</Text>
        </Tooltip>
      ),
    },
    { title: 'Batch', dataIndex: 'batch', width: 100, render: (val) => val || '-' },
    { title: 'Transferred Qty', dataIndex: 'qty', width: 120, align: 'right', render: (val) => formatNumber(val || 0) },
    {
      title: 'Received Qty',
      dataIndex: 'received_qty',
      width: 110,
      align: 'right',
      render: (val, record) => {
        const qty = record.qty || 0;
        const recv = val || 0;
        const color = recv < qty ? '#fa8c16' : recv === qty ? '#52c41a' : '#f5222d';
        return <Text style={{ color }}>{formatNumber(recv)}</Text>;
      },
    },
    { title: 'UOM', dataIndex: 'uom', width: 60 },
    { title: 'Source Bin', dataIndex: 'source_bin_name', width: 120, render: (val) => val || '-' },
    { title: 'Dest Bin', dataIndex: 'destination_bin_name', width: 120, render: (val) => val || '-' },
  ];

  const filterToolbar = (
    <Space wrap size="small" style={{ marginLeft: 12 }}>
      <Select
        placeholder="Warehouse"
        options={warehouses}
        value={filterWarehouse}
        onChange={(val) => { setFilterWarehouse(val); setRefreshKey((k) => k + 1); }}
        allowClear
        style={{ width: 160 }}
        size="middle"
      />
      <Select
        placeholder="Status"
        options={TRANSFER_STATUSES}
        value={filterStatus}
        onChange={(val) => { setFilterStatus(val); setRefreshKey((k) => k + 1); }}
        allowClear
        style={{ width: 150 }}
        size="middle"
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="Stock Transfer" subtitle="Inter-location stock transfers">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          Create Transfer
        </Button>
      </PageHeader>

      <Card bodyStyle={{ padding: 0 }}>
        <DataTable
          key={refreshKey}
          columns={columns}
          fetchFunction={fetchTransfers}
          rowKey="id"
          searchPlaceholder="Search transfers..."
          exportFileName="Stock_Transfers"
          toolbar={filterToolbar}
          scroll={{ x: 1400 }}
        />
      </Card>

      {/* Create/Edit Drawer */}
      <Drawer
        title={editingTransfer ? `Edit Transfer: ${editingTransfer.transfer_number}` : 'Create Stock Transfer'}
        placement="right"
        width={960}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>Cancel</Button>
            <Button onClick={() => handleSubmit('draft')} loading={submitting}>
              Save as Draft
            </Button>
            <Button type="primary" icon={<SendOutlined />} onClick={() => handleSubmit('submit_approval')} loading={submitting}>
              Submit for Approval
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="source_warehouse_id"
                label="Source Warehouse"
                rules={[{ required: true, message: 'Select source warehouse' }]}
              >
                <Select
                  placeholder="Select source warehouse"
                  options={warehouses}
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="destination_warehouse_id"
                label="Destination Warehouse"
                rules={[{ required: true, message: 'Select destination warehouse' }]}
              >
                <Select
                  placeholder="Select destination warehouse"
                  options={warehouses}
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="transfer_date"
                label="Transfer Date"
                rules={[{ required: true, message: 'Select date' }]}
              >
                <DatePicker format={DATE_FORMAT} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="transfer_type"
                label="Transfer Type"
                rules={[{ required: true, message: 'Select type' }]}
              >
                <Select options={TRANSFER_TYPES} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="remarks" label="Remarks">
                <TextArea rows={1} placeholder="Optional remarks..." />
              </Form.Item>
            </Col>
          </Row>
        </Form>

        <Divider orientation="left" style={{ marginTop: 8 }}>
          <Space>
            <SwapOutlined />
            Transfer Items
          </Space>
        </Divider>

        <Table
          columns={transferItemColumns}
          dataSource={transferItems}
          rowKey="key"
          pagination={false}
          scroll={{ x: 900 }}
          size="small"
          footer={() => (
            <Button
              type="dashed"
              icon={<PlusOutlined />}
              onClick={addTransferItemRow}
              block
            >
              Add Item
            </Button>
          )}
          summary={(pageData) => {
            if (!pageData || pageData.length === 0) return null;
            const totalQty = pageData.reduce((s, i) => s + (i.qty || 0), 0);
            return (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={3}>
                  <Text strong>Total</Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="right">
                  <Text strong>{formatNumber(totalQty)}</Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2} colSpan={4} />
              </Table.Summary.Row>
            );
          }}
        />
      </Drawer>

      {/* View Detail Modal */}
      <Modal
        title={
          viewData ? (
            <Space>
              <SwapOutlined />
              <span>Transfer: {viewData.transfer_number}</span>
              <StatusTag status={viewData.status} />
            </Space>
          ) : 'Transfer Detail'
        }
        open={viewModalOpen}
        onCancel={() => { setViewModalOpen(false); setViewData(null); }}
        width={1000}
        loading={viewLoading}
        footer={
          viewData ? (
            <Space>
              {viewData.status === 'draft' && (
                <Popconfirm title="Submit for approval?" onConfirm={() => handleAction(viewData.id, 'submit', 'Submitted for approval')}>
                  <Button icon={<SendOutlined />}>Submit for Approval</Button>
                </Popconfirm>
              )}
              {viewData.status === 'pending_approval' && (
                <Popconfirm title="Approve?" onConfirm={() => handleAction(viewData.id, 'approve', 'Transfer approved')}>
                  <Button type="primary" icon={<CheckOutlined />}>Approve</Button>
                </Popconfirm>
              )}
              {viewData.status === 'approved' && (
                <Popconfirm title="Dispatch?" onConfirm={() => handleAction(viewData.id, 'dispatch', 'Transfer dispatched')}>
                  <Button type="primary" icon={<CarOutlined />}>Dispatch</Button>
                </Popconfirm>
              )}
              {viewData.status === 'in_transit' && (
                <Popconfirm title="Receive?" onConfirm={() => handleAction(viewData.id, 'receive', 'Transfer received')}>
                  <Button type="primary" icon={<InboxOutlined />}>Receive</Button>
                </Popconfirm>
              )}
              {viewData.status === 'received' && (
                <Popconfirm title="Complete?" onConfirm={() => handleAction(viewData.id, 'complete', 'Transfer completed')}>
                  <Button type="primary" icon={<CheckCircleFilled />}>Complete</Button>
                </Popconfirm>
              )}
              <Button onClick={() => setViewModalOpen(false)}>Close</Button>
            </Space>
          ) : null
        }
      >
        {viewData && (
          <>
            {/* Status Timeline */}
            <Steps
              current={STATUS_STEP_MAP[viewData.status] ?? 0}
              size="small"
              style={{ marginBottom: 24 }}
              items={[
                { title: 'Draft', icon: <EditOutlined /> },
                { title: 'Pending Approval', icon: <ClockCircleFilled /> },
                { title: 'Approved', icon: <CheckOutlined /> },
                { title: 'In Transit', icon: <CarOutlined /> },
                { title: 'Received', icon: <InboxOutlined /> },
                { title: 'Completed', icon: <CheckCircleFilled /> },
              ]}
            />

            <Descriptions size="small" column={3} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="Transfer No">{viewData.transfer_number}</Descriptions.Item>
              <Descriptions.Item label="Transfer Date">{formatDate(viewData.transfer_date)}</Descriptions.Item>
              <Descriptions.Item label="Transfer Type">
                {TRANSFER_TYPES.find((t) => t.value === viewData.transfer_type)?.label || viewData.transfer_type}
              </Descriptions.Item>
              <Descriptions.Item label="Source Warehouse">{viewData.source_warehouse_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Dest Warehouse">{viewData.destination_warehouse_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Status"><StatusTag status={viewData.status} /></Descriptions.Item>
              <Descriptions.Item label="Created By">{viewData.created_by || '-'}</Descriptions.Item>
              <Descriptions.Item label="Created At">{formatDateTime(viewData.created_at)}</Descriptions.Item>
              <Descriptions.Item label="Remarks">{viewData.remarks || '-'}</Descriptions.Item>
            </Descriptions>

            <Divider orientation="left" style={{ fontSize: 14 }}>Items</Divider>
            <Table
              columns={viewItemColumns}
              dataSource={viewData.items || []}
              rowKey={(r, idx) => r.id || idx}
              pagination={false}
              scroll={{ x: 900 }}
              size="small"
              summary={(pageData) => {
                if (!pageData || pageData.length === 0) return null;
                const totalTransferred = pageData.reduce((s, i) => s + (i.qty || 0), 0);
                const totalReceived = pageData.reduce((s, i) => s + (i.received_qty || 0), 0);
                return (
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0} colSpan={4}>
                      <Text strong>Total</Text>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={1} align="right">
                      <Text strong>{formatNumber(totalTransferred)}</Text>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={2} align="right">
                      <Text strong>{formatNumber(totalReceived)}</Text>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={3} colSpan={3} />
                  </Table.Summary.Row>
                );
              }}
            />
          </>
        )}
      </Modal>
    </div>
  );
};

export default StockTransfer;

