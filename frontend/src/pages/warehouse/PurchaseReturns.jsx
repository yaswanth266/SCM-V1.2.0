import React, { useState, useCallback } from 'react';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Modal,
  Divider, Typography, Tooltip, Tag, Badge,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  CheckOutlined, MinusCircleOutlined, InboxOutlined,
  RollbackOutlined, FileDoneOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import {
  formatDate, formatCurrency, formatNumber, getErrorMessage,
  formatDateForAPI,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const PR_STATUSES = [
  { label: 'Draft', value: 'draft' },
  { label: 'Pending Approval', value: 'pending_approval' },
  { label: 'Approved', value: 'approved' },
  { label: 'Dispatched', value: 'dispatched' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const PurchaseReturns = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [viewData, setViewData] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [editingRecord, setEditingRecord] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterVendor, setFilterVendor] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);
  const [filterDateRange, setFilterDateRange] = useState(null);

  // Drawer state
  const [returnItems, setReturnItems] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [poOptions, setPoOptions] = useState([]);
  const [grnOptions, setGrnOptions] = useState([]);
  const [uomOptions, setUomOptions] = useState([]);

  // --- Lookups ---
  const loadLookups = useCallback(async () => {
    try {
      const [vendorRes, whRes, uomRes] = await Promise.allSettled([
        api.get('/masters/vendors', { params: { page_size: 200, status: 'active' } }),
        api.get('/masters/warehouses', { params: { page_size: 200 } }),
        api.get('/masters/uom', { params: { page_size: 200 } }),
      ]);
      if (vendorRes.status === 'fulfilled') {
        const d = vendorRes.value.data;
        const items = d.items || d.data || d || [];
        setVendors(items.map((v) => ({
          label: `[${v.vendor_code}] ${v.name}`,
          value: v.id,
          vendor: v,
        })));
      }
      if (whRes.status === 'fulfilled') {
        const w = whRes.value.data;
        setWarehouses(
          (w.items || w.data || w || []).map((i) => ({
            label: i.name || i.warehouse_name,
            value: i.id,
          }))
        );
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

  const loadPOOptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/procurement/purchase-orders', {
        params: { page_size: 50, search },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setPoOptions(
        items.map((po) => ({
          label: `${po.po_number} - ${po.vendor_name || ''}`,
          value: po.id,
        }))
      );
    } catch {
      // silent
    }
  }, []);

  const loadGRNOptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/warehouse/grn', {
        params: { page_size: 50, search },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setGrnOptions(
        items.map((g) => ({
          label: `${g.grn_number} - ${g.vendor_name || ''}`,
          value: g.id,
        }))
      );
    } catch {
      // silent
    }
  }, []);

  // --- Fetch ---
  const fetchRecords = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterVendor) qp.vendor_id = filterVendor;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      if (filterDateRange && filterDateRange[0]) {
        qp.date_from = formatDateForAPI(filterDateRange[0]);
        qp.date_to = formatDateForAPI(filterDateRange[1]);
      }
      return await api.get('/warehouse/purchase-returns', { params: qp });
    },
    [filterStatus, filterVendor, filterWarehouse, filterDateRange]
  );

  // --- Item Row ---
  const createEmptyItem = () => ({
    key: Date.now() + Math.random(),
    item_id: null,
    item_name: '',
    item_code: '',
    uom_id: null,
    qty: 0,
    rate: 0,
    amount: 0,
    reason: '',
  });

  const recalcItem = (item) => {
    item.amount = Number(((item.qty || 0) * (item.rate || 0)).toFixed(2));
    return item;
  };

  const updateReturnItem = (key, field, value) => {
    setReturnItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        const updated = { ...item, [field]: value };
        return recalcItem(updated);
      })
    );
  };

  const addItemRow = () => {
    setReturnItems((prev) => [...prev, createEmptyItem()]);
  };

  const removeItemRow = (key) => {
    setReturnItems((prev) => prev.filter((i) => i.key !== key));
  };

  // --- Totals ---
  const calcTotalQty = () => returnItems.reduce((s, i) => s + (i.qty || 0), 0);
  const calcTotalAmount = () => returnItems.reduce((s, i) => s + (i.amount || 0), 0);

  // --- Open Drawer ---
  const handleAdd = () => {
    setEditingRecord(null);
    form.resetFields();
    form.setFieldsValue({
      return_date: dayjs(),
    });
    setReturnItems([createEmptyItem()]);
    loadLookups();
    loadPOOptions();
    loadGRNOptions();
    setDrawerOpen(true);
  };

  // --- View Detail ---
  const handleView = async (record) => {
    setViewLoading(true);
    setViewModalOpen(true);
    try {
      const res = await api.get(`/warehouse/purchase-returns/${record.id}`);
      setViewData(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
      setViewModalOpen(false);
    } finally {
      setViewLoading(false);
    }
  };

  // --- Edit ---
  const handleEdit = async (record) => {
    setEditingRecord(record);
    loadLookups();
    loadPOOptions();
    loadGRNOptions();
    try {
      const res = await api.get(`/warehouse/purchase-returns/${record.id}`);
      const data = res.data;
      form.setFieldsValue({
        vendor_id: data.vendor_id,
        warehouse_id: data.warehouse_id,
        po_id: data.po_id,
        grn_id: data.grn_id,
        return_date: data.return_date ? dayjs(data.return_date) : null,
        reason: data.reason,
      });
      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_name: item.item_name || '',
        item_code: item.item_code || '',
        uom_id: item.uom_id,
        qty: Number(item.qty || 0),
        rate: Number(item.rate || 0),
        amount: Number(item.amount || 0),
        reason: item.reason || '',
      }));
      setReturnItems(items.length > 0 ? items : [createEmptyItem()]);
      setDrawerOpen(true);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Submit ---
  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const validItems = returnItems.filter((i) => i.item_id && i.qty > 0);
      if (validItems.length === 0) {
        message.error('Please add at least one item with quantity');
        return;
      }
      setSubmitting(true);

      const payload = {
        ...values,
        return_date: formatDateForAPI(values.return_date),
        items: validItems.map((item) => ({
          item_id: item.item_id,
          qty: item.qty,
          uom_id: item.uom_id,
          rate: item.rate,
          reason: item.reason || '',
        })),
      };

      if (editingRecord) {
        await api.put(`/warehouse/purchase-returns/${editingRecord.id}`, payload);
        message.success('Purchase Return updated successfully');
      } else {
        await api.post('/warehouse/purchase-returns', payload);
        message.success('Purchase Return created successfully');
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingRecord(null);
      setReturnItems([]);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // --- Actions ---
  const handleApprove = async (id) => {
    try {
      await api.post(`/warehouse/purchase-returns/${id}/approve`);
      message.success('Purchase Return approved');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleComplete = async (id) => {
    try {
      await api.post(`/warehouse/purchase-returns/${id}/complete`);
      message.success('Purchase Return completed');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/warehouse/purchase-returns/${id}`);
      message.success('Purchase Return deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Item Columns in Drawer ---
  const returnItemColumns = [
    { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item',
      dataIndex: 'item_id',
      width: 220,
      render: (val, record) =>
        record.item_name ? (
          <Tooltip title={record.item_name}>
            <Text ellipsis style={{ maxWidth: 200 }}>{record.item_name}</Text>
          </Tooltip>
        ) : (
          <ItemSelector
            value={val}
            onChange={(itemId, item) => {
              updateReturnItem(record.key, 'item_id', itemId);
              if (item) {
                // Bug fix BUG_0085 — auto-fill UOM, rate (purchase_price as fallback)
                updateReturnItem(record.key, 'item_name', item.item_name || item.name || '');
                updateReturnItem(record.key, 'item_code', item.item_code || item.code || '');
                const rate = parseFloat(item.last_purchase_rate || item.purchase_price || 0);
                if (rate > 0) updateReturnItem(record.key, 'rate', rate);
                updateReturnItem(record.key, 'uom_id', item.primary_uom_id || item.uom_id || null);
                // Reason should be filled by user per-line, but suggest a default
                if (!record.reason) updateReturnItem(record.key, 'reason', 'Quality issue');
              }
            }}
            style={{ width: '100%' }}
          />
        ),
    },
    {
      title: 'Qty', dataIndex: 'qty', width: 90,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateReturnItem(record.key, 'qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'UOM', dataIndex: 'uom_id', width: 110,
      render: (val, record) => (
        <Select
          value={val}
          onChange={(v) => updateReturnItem(record.key, 'uom_id', v)}
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
      title: 'Rate', dataIndex: 'rate', width: 100,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateReturnItem(record.key, 'rate', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'Amount', dataIndex: 'amount', width: 110, align: 'right',
      render: (val) => <Text strong style={{ fontSize: 12 }}>{formatCurrency(val)}</Text>,
    },
    {
      title: 'Reason', dataIndex: 'reason', width: 160,
      render: (val, record) => (
        <Input
          value={val}
          onChange={(e) => updateReturnItem(record.key, 'reason', e.target.value)}
          size="small"
          placeholder="Reason"
        />
      ),
    },
    {
      title: '', width: 35,
      render: (_, record) =>
        returnItems.length > 1 ? (
          <MinusCircleOutlined
            style={{ color: '#ff4d4f', cursor: 'pointer' }}
            onClick={() => removeItemRow(record.key)}
          />
        ) : null,
    },
  ];

  // --- Main Table Columns ---
  const columns = [
    {
      title: 'Return Number',
      dataIndex: 'return_number',
      key: 'return_number',
      width: 160,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a onClick={() => handleView(record)}>{text}</a>
      ),
    },
    {
      title: 'Vendor',
      dataIndex: 'vendor_name',
      key: 'vendor',
      width: 180,
      ellipsis: true,
      render: (v, r) => v || r.vendor || '-',
    },
    {
      title: 'Warehouse',
      dataIndex: 'warehouse_name',
      key: 'warehouse',
      width: 150,
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: 'Return Date',
      dataIndex: 'return_date',
      key: 'return_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Reason',
      dataIndex: 'reason',
      key: 'reason',
      width: 200,
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: 'Total Amount',
      dataIndex: 'total_amount',
      key: 'total_amount',
      width: 130,
      align: 'right',
      render: (v) => <Text strong>{formatCurrency(v)}</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 140,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View Detail">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(record)} />
          </Tooltip>
          {record.status === 'draft' && (
            <>
              <Tooltip title="Edit">
                <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
              </Tooltip>
              <Tooltip title="Approve">
                <Popconfirm title="Approve this Purchase Return?" onConfirm={() => handleApprove(record.id)}>
                  <Button type="link" size="small" icon={<CheckOutlined />} style={{ color: '#52c41a' }} />
                </Popconfirm>
              </Tooltip>
              <Popconfirm title="Delete this Purchase Return?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
          {(record.status === 'approved' || record.status === 'dispatched') && (
            <Tooltip title="Complete">
              <Popconfirm title="Mark this Purchase Return as completed?" onConfirm={() => handleComplete(record.id)}>
                <Button type="link" size="small" icon={<FileDoneOutlined />} style={{ color: '#52c41a' }} />
              </Popconfirm>
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  // --- Filter Toolbar ---
  const toolbar = (
    <Space style={{ marginLeft: 12 }} wrap>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 160 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={PR_STATUSES}
      />
      <Select
        placeholder="Vendor"
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ width: 180 }}
        value={filterVendor}
        onChange={(v) => { setFilterVendor(v); setRefreshKey((k) => k + 1); }}
        options={vendors}
        onDropdownVisibleChange={(open) => { if (open && vendors.length === 0) loadLookups(); }}
      />
      <Select
        placeholder="Warehouse"
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ width: 160 }}
        value={filterWarehouse}
        onChange={(v) => { setFilterWarehouse(v); setRefreshKey((k) => k + 1); }}
        options={warehouses}
        onDropdownVisibleChange={(open) => { if (open && warehouses.length === 0) loadLookups(); }}
      />
      <DatePicker.RangePicker
        value={filterDateRange}
        onChange={(dates) => { setFilterDateRange(dates); setRefreshKey((k) => k + 1); }}
        format={DATE_FORMAT}
        style={{ width: 240 }}
        placeholder={['From Date', 'To Date']}
      />
    </Space>
  );

  // --- View Detail Items Columns ---
  const viewItemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
    { title: 'Item', dataIndex: 'item_name', width: 200, ellipsis: true, render: (v, r) => v || r.item_code || '-' },
    { title: 'Qty', dataIndex: 'qty', width: 90, align: 'right', render: (v) => formatNumber(v) },
    { title: 'UOM', dataIndex: 'uom_name', width: 80, render: (v) => v || '-' },
    { title: 'Rate', dataIndex: 'rate', width: 110, align: 'right', render: (v) => formatCurrency(v) },
    { title: 'Amount', dataIndex: 'amount', width: 120, align: 'right', render: (v) => <Text strong>{formatCurrency(v)}</Text> },
    { title: 'Reason', dataIndex: 'reason', width: 200, ellipsis: true, render: (v) => v || '-' },
  ];

  return (
    <div>
      <PageHeader title="Purchase Returns" subtitle="Manage purchase returns to vendors">
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            Create Return
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchRecords}
        rowKey="id"
        searchPlaceholder="Search by return number, reason..."
        exportFileName="purchase_returns_list"
        toolbar={toolbar}
        scroll={{ x: 1300 }}
      />

      {/* --- Create / Edit Drawer --- */}
      <Drawer
        title={editingRecord ? `Edit ${editingRecord.return_number}` : 'Create Purchase Return'}
        width={1000}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setEditingRecord(null);
          form.resetFields();
          setReturnItems([]);
        }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); setEditingRecord(null); form.resetFields(); setReturnItems([]); }}>
              Cancel
            </Button>
            <Button
              type="primary"
              icon={<RollbackOutlined />}
              onClick={handleSubmit}
              loading={submitting}
            >
              {editingRecord ? 'Update' : 'Save'}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="vendor_id" label="Vendor" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  options={vendors}
                  placeholder="Select vendor"
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  options={warehouses}
                  placeholder="Select warehouse"
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="return_date" label="Return Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="po_id" label="Purchase Order">
                <Select
                  options={poOptions}
                  placeholder="Select PO (optional)"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  onSearch={(v) => loadPOOptions(v)}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="grn_id" label="GRN">
                <Select
                  options={grnOptions}
                  placeholder="Select GRN (optional)"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  onSearch={(v) => loadGRNOptions(v)}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="reason" label="Reason">
                <Input placeholder="Return reason" />
              </Form.Item>
            </Col>
          </Row>
        </Form>

        {/* Items Table */}
        <Divider orientation="left">
          <Space>
            <InboxOutlined />
            Items
            <Badge count={returnItems.filter((i) => i.item_id).length} style={{ backgroundColor: '#eb2f96' }} />
          </Space>
        </Divider>
        <Table
          dataSource={returnItems}
          columns={returnItemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 900 }}
          footer={() => (
            <Button type="dashed" onClick={addItemRow} icon={<PlusOutlined />} block>
              Add Item
            </Button>
          )}
        />

        {/* Running Totals */}
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ width: 380 }}>
            <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Col span={14}><Text>Total Qty:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}><Text strong>{formatNumber(calcTotalQty())}</Text></Col>
            </Row>
            <Row style={{ padding: '8px 0', background: '#fafafa', borderRadius: 4, marginTop: 4 }}>
              <Col span={14}><Text strong style={{ fontSize: 16 }}>Total Amount:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}>
                <Text strong style={{ fontSize: 16, color: '#eb2f96' }}>{formatCurrency(calcTotalAmount())}</Text>
              </Col>
            </Row>
          </div>
        </div>
      </Drawer>

      {/* --- View Detail Modal --- */}
      <Modal
        title={viewData ? `Purchase Return: ${viewData.return_number}` : 'Purchase Return Detail'}
        open={viewModalOpen}
        onCancel={() => { setViewModalOpen(false); setViewData(null); }}
        footer={
          viewData && (
            <Space>
              {viewData.status === 'draft' && (
                <Popconfirm title="Approve this Purchase Return?" onConfirm={async () => { await handleApprove(viewData.id); setViewModalOpen(false); }}>
                  <Button type="primary" icon={<CheckOutlined />}>Approve</Button>
                </Popconfirm>
              )}
              {(viewData.status === 'approved' || viewData.status === 'dispatched') && (
                <Popconfirm title="Complete this Purchase Return?" onConfirm={async () => { await handleComplete(viewData.id); setViewModalOpen(false); }}>
                  <Button type="primary" icon={<FileDoneOutlined />}>Complete</Button>
                </Popconfirm>
              )}
              <Button onClick={() => { setViewModalOpen(false); setViewData(null); }}>Close</Button>
            </Space>
          )
        }
        width={900}
        loading={viewLoading}
      >
        {viewData && (
          <>
            <Descriptions bordered size="small" column={3} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="Return Number">{viewData.return_number}</Descriptions.Item>
              <Descriptions.Item label="Status"><StatusTag status={viewData.status} /></Descriptions.Item>
              <Descriptions.Item label="Return Date">{formatDate(viewData.return_date)}</Descriptions.Item>
              <Descriptions.Item label="Vendor">{viewData.vendor_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Warehouse">{viewData.warehouse_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="PO Reference">{viewData.po_number || viewData.po_id || '-'}</Descriptions.Item>
              <Descriptions.Item label="GRN Reference">{viewData.grn_number || viewData.grn_id || '-'}</Descriptions.Item>
              <Descriptions.Item label="Reason" span={2}>{viewData.reason || '-'}</Descriptions.Item>
              <Descriptions.Item label="Total Amount"><Text strong>{formatCurrency(viewData.total_amount)}</Text></Descriptions.Item>
            </Descriptions>

            <Divider orientation="left">Items</Divider>
            <Table
              dataSource={viewData.items || []}
              columns={viewItemColumns}
              rowKey="id"
              pagination={false}
              size="small"
              scroll={{ x: 800 }}
            />
          </>
        )}
      </Modal>
    </div>
  );
};

export default PurchaseReturns;

