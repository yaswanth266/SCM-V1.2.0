import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Modal,
  Divider, Typography, Tooltip, Tag, Alert, Badge, Statistic,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  SendOutlined, CheckOutlined, CloseCircleOutlined,
  MinusCircleOutlined, AuditOutlined, ExclamationCircleOutlined,
  ArrowUpOutlined, ArrowDownOutlined, CheckCircleFilled,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatDate, formatDateTime, formatCurrency, formatNumber, getErrorMessage,
  formatDateForAPI,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const AUDIT_TYPES = [
  { label: 'Full Audit', value: 'full' },
  { label: 'Partial Audit', value: 'partial' },
  { label: 'Cycle Count', value: 'cycle_count' },
];

const AUDIT_STATUSES = [
  { label: 'Draft', value: 'draft' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Pending Approval', value: 'pending_approval' },
  { label: 'Approved', value: 'approved' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const StockAudit = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [viewData, setViewData] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [editingAudit, setEditingAudit] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);
  const [filterAuditType, setFilterAuditType] = useState(undefined);

  // Drawer state
  const [auditItems, setAuditItems] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);

  // Load lookups
  useEffect(() => {
    const loadLookups = async () => {
      try {
        const res = await api.get('/masters/warehouses', { params: { page_size: 200 } });
        const d = res.data;
        const items = d.items || d.data || d || [];
        setWarehouses(items.map((w) => ({
          label: w.name || w.warehouse_name,
          value: w.id,
        })));
      } catch {
        // silent
      }
    };
    loadLookups();
  }, []);

  // Fetch audits
  const fetchAudits = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      if (filterAuditType) qp.audit_type = filterAuditType;
      return await api.get('/inventory/stock-audits', { params: qp });
    },
    [filterStatus, filterWarehouse, filterAuditType]
  );

  // Auto-populate items for a warehouse
  const populateWarehouseItems = async (warehouseId) => {
    if (!warehouseId) {
      setAuditItems([]);
      return;
    }
    setLoadingItems(true);
    try {
      const res = await api.get('/inventory/stock-balance', {
        params: { warehouse_id: warehouseId, page_size: 200 },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      const mapped = items.map((item, idx) => {
        const sysQty = item.total_qty || item.available_qty || 0;
        return {
          key: item.id || Date.now() + idx,
          item_id: item.item_id,
          item_code: item.item_code || '',
          item_name: item.item_name || '',
          batch: item.batch || '',
          location: item.location || '',
          rack: item.rack || '',
          bin: item.bin || '',
          uom: item.uom || item.uom_name || '',
          uom_id: item.uom_id || item.primary_uom_id || null,  // required by backend
          system_qty: sysQty,
          physical_qty: sysQty,  // default to system qty; user edits if variance
          variance: 0,
          variance_value: 0,
          valuation_rate: item.valuation_rate || 0,
          remarks: '',
        };
      });
      setAuditItems(mapped);
      if (mapped.length > 0) {
        message.success(`Loaded ${mapped.length} items from stock`);
      } else {
        message.info('No stock found for this warehouse');
      }
    } catch (err) {
      message.error(getErrorMessage(err));
      setAuditItems([]);
    } finally {
      setLoadingItems(false);
    }
  };

  // Update audit item
  const updateAuditItem = (key, field, value) => {
    setAuditItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        const updated = { ...item, [field]: value };
        if (field === 'physical_qty') {
          const phys = value ?? 0;
          const sys = updated.system_qty || 0;
          updated.variance = phys - sys;
          updated.variance_value = updated.variance * (updated.valuation_rate || 0);
        }
        return updated;
      })
    );
  };

  // Variance summary
  const getVarianceSummary = (items) => {
    const total = items.length;
    const counted = items.filter((i) => i.physical_qty !== null && i.physical_qty !== undefined).length;
    const matched = items.filter((i) => i.physical_qty !== null && i.variance === 0).length;
    const varianceItems = items.filter((i) => i.physical_qty !== null && i.variance !== 0);
    const varianceCount = varianceItems.length;
    const totalVarianceValue = varianceItems.reduce((s, i) => s + Math.abs(i.variance_value || 0), 0);
    const positiveVariance = varianceItems.filter((i) => i.variance > 0).length;
    const negativeVariance = varianceItems.filter((i) => i.variance < 0).length;
    return { total, counted, matched, varianceCount, totalVarianceValue, positiveVariance, negativeVariance };
  };

  // Open drawer
  const handleAdd = () => {
    setEditingAudit(null);
    form.resetFields();
    form.setFieldsValue({
      audit_date: dayjs(),
      audit_type: 'full',
    });
    setAuditItems([]);
    setDrawerOpen(true);
  };

  const handleEdit = async (record) => {
    setEditingAudit(record);
    try {
      const res = await api.get(`/inventory/stock-audits/${record.id}`);
      const data = res.data;
      form.setFieldsValue({
        warehouse_id: data.warehouse_id,
        audit_date: data.audit_date ? dayjs(data.audit_date) : dayjs(),
        audit_type: data.audit_type || 'full',
        remarks: data.remarks,
      });
      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_code: item.item_code || '',
        item_name: item.item_name || '',
        batch: item.batch || '',
        location: item.location || '',
        rack: item.rack || '',
        bin: item.bin || '',
        uom: item.uom || '',
        system_qty: item.system_qty || 0,
        physical_qty: item.physical_qty,
        variance: item.variance || 0,
        variance_value: item.variance_value || 0,
        valuation_rate: item.valuation_rate || 0,
        remarks: item.remarks || '',
      }));
      setAuditItems(items);
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
      const res = await api.get(`/inventory/stock-audits/${record.id}`);
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
      if (auditItems.length === 0) {
        message.error('No items to audit. Select a warehouse to populate items.');
        return;
      }
      setSubmitting(true);

      let status = 'draft';
      if (submitAction === 'in_progress') status = 'in_progress';
      if (submitAction === 'submit_approval') status = 'pending_approval';

      const payload = {
        ...values,
        audit_date: formatDateForAPI(values.audit_date),
        status,
        items: auditItems.map((item) => ({
          item_id: item.item_id,
          item_code: item.item_code,
          item_name: item.item_name,
          batch: item.batch,
          location: item.location,
          rack: item.rack,
          bin: item.bin,
          uom: item.uom,
          uom_id: item.uom_id,  // required by backend
          system_qty: item.system_qty,
          physical_qty: item.physical_qty ?? item.system_qty ?? 0,  // never null
          variance: item.variance,
          variance_value: item.variance_value,
          valuation_rate: item.valuation_rate,
          remarks: item.remarks,
        })),
      };

      if (editingAudit) {
        await api.put(`/inventory/stock-audits/${editingAudit.id}`, payload);
        message.success('Audit updated successfully');
      } else {
        await api.post('/inventory/stock-audits', payload);
        message.success('Audit created successfully');
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingAudit(null);
      setAuditItems([]);
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
      // BUG-INV-079: 'approve' must POST /audits/{id}/adjust to actually post
      // the variance adjustments to stock. Previously this only PUT a status
      // change endpoint that didn't update inventory.
      if (action === 'approve') {
        await api.post(`/inventory/audits/${id}/adjust`);
      } else {
        await api.put(`/inventory/stock-audits/${id}/${action}`);
      }
      message.success(successMsg);
      setRefreshKey((k) => k + 1);
      if (viewModalOpen) {
        const res = await api.get(`/inventory/stock-audits/${id}`);
        setViewData(res.data);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/inventory/stock-audits/${id}`);
      message.success('Audit deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // Audit items columns (drawer)
  const auditItemColumns = [
    { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
    { title: 'Item Code', dataIndex: 'item_code', width: 100 },
    {
      title: 'Item Name',
      dataIndex: 'item_name',
      width: 160,
      render: (val) => (
        <Tooltip title={val}>
          <Text ellipsis style={{ maxWidth: 140 }}>{val || '-'}</Text>
        </Tooltip>
      ),
    },
    { title: 'Batch', dataIndex: 'batch', width: 80, render: (val) => val || '-' },
    { title: 'Location', dataIndex: 'location', width: 80, render: (val) => val || '-' },
    { title: 'Rack', dataIndex: 'rack', width: 60, render: (val) => val || '-' },
    { title: 'Bin', dataIndex: 'bin', width: 60, render: (val) => val || '-' },
    {
      title: 'System Qty',
      dataIndex: 'system_qty',
      width: 90,
      align: 'right',
      render: (val) => <Text type="secondary">{formatNumber(val || 0)}</Text>,
    },
    {
      title: 'Physical Qty',
      dataIndex: 'physical_qty',
      width: 100,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateAuditItem(record.key, 'physical_qty', v)}
          style={{ width: '100%' }}
          size="small"
          placeholder="Count"
        />
      ),
    },
    {
      title: 'Variance',
      dataIndex: 'variance',
      width: 90,
      align: 'right',
      render: (val) => {
        if (val === 0 || val === null || val === undefined) {
          return <Text type="secondary">0</Text>;
        }
        if (val > 0) {
          return (
            <Text style={{ color: '#52c41a' }}>
              <ArrowUpOutlined /> +{formatNumber(val)}
            </Text>
          );
        }
        return (
          <Text style={{ color: '#f5222d' }}>
            <ArrowDownOutlined /> {formatNumber(val)}
          </Text>
        );
      },
    },
    {
      title: 'Variance Value',
      dataIndex: 'variance_value',
      width: 110,
      align: 'right',
      render: (val) => {
        if (!val || val === 0) return <Text type="secondary">-</Text>;
        const color = val > 0 ? '#52c41a' : '#f5222d';
        return <Text style={{ color }}>{formatCurrency(val)}</Text>;
      },
    },
    {
      title: 'Remarks',
      dataIndex: 'remarks',
      width: 120,
      render: (val, record) => (
        <Input
          value={val}
          onChange={(e) => updateAuditItem(record.key, 'remarks', e.target.value)}
          size="small"
          placeholder="Note..."
        />
      ),
    },
  ];

  // Main table columns
  const columns = [
    {
      title: 'Audit No',
      dataIndex: 'audit_number',
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
      title: 'Warehouse',
      dataIndex: 'warehouse_name',
      width: 160,
      sorter: true,
      render: (val) => val || '-',
    },
    {
      title: 'Audit Date',
      dataIndex: 'audit_date',
      width: 110,
      sorter: true,
      render: (val) => formatDate(val),
    },
    {
      title: 'Audit Type',
      dataIndex: 'audit_type',
      width: 120,
      render: (val) => {
        const found = AUDIT_TYPES.find((t) => t.value === val);
        const colors = { full: 'blue', partial: 'orange', cycle_count: 'purple' };
        return <Tag color={colors[val] || 'default'}>{found ? found.label : val || '-'}</Tag>;
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 130,
      render: (val) => <StatusTag status={val} />,
    },
    {
      title: 'Total Items',
      dataIndex: 'total_items',
      width: 100,
      align: 'center',
      render: (val) => formatNumber(val || 0),
    },
    {
      title: 'Variance Items',
      dataIndex: 'variance_items',
      width: 120,
      align: 'center',
      render: (val) => {
        if (!val || val === 0) return <Text type="secondary">0</Text>;
        return (
          <Badge count={val} style={{ backgroundColor: '#fa8c16' }} />
        );
      },
    },
    {
      title: 'Variance Value',
      dataIndex: 'total_variance_value',
      width: 120,
      align: 'right',
      render: (val) => {
        if (!val || val === 0) return <Text type="secondary">-</Text>;
        return <Text style={{ color: '#fa8c16' }}>{formatCurrency(Math.abs(val))}</Text>;
      },
    },
    {
      title: 'Created By',
      dataIndex: 'created_by',
      width: 110,
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
            {(st === 'draft' || st === 'in_progress') && (
              <>
                <Tooltip title="Edit">
                  <Button type="text" icon={<EditOutlined />} size="small" onClick={() => handleEdit(record)} />
                </Tooltip>
                <Tooltip title="Submit for Approval">
                  <Popconfirm title="Submit audit for approval?" onConfirm={() => handleAction(record.id, 'submit', 'Submitted for approval')}>
                    <Button type="text" icon={<SendOutlined />} size="small" />
                  </Popconfirm>
                </Tooltip>
              </>
            )}
            {st === 'draft' && (
              <Popconfirm title="Delete this audit?" onConfirm={() => handleDelete(record.id)}>
                <Button type="text" danger icon={<DeleteOutlined />} size="small" />
              </Popconfirm>
            )}
            {st === 'pending_approval' && (
              <>
                <Tooltip title="Approve Adjustments">
                  <Popconfirm title="Approve adjustments and apply to stock?" onConfirm={() => handleAction(record.id, 'approve', 'Adjustments approved and applied')}>
                    <Button type="text" icon={<CheckOutlined />} size="small" style={{ color: '#52c41a' }} />
                  </Popconfirm>
                </Tooltip>
                <Tooltip title="Reject">
                  <Popconfirm title="Reject this audit?" onConfirm={() => handleAction(record.id, 'reject', 'Audit rejected')}>
                    <Button type="text" danger icon={<CloseCircleOutlined />} size="small" />
                  </Popconfirm>
                </Tooltip>
              </>
            )}
          </Space>
        );
      },
    },
  ];

  // View items columns
  const viewItemColumns = [
    { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
    { title: 'Item Code', dataIndex: 'item_code', width: 100 },
    {
      title: 'Item Name',
      dataIndex: 'item_name',
      width: 160,
      render: (val) => (
        <Tooltip title={val}>
          <Text ellipsis style={{ maxWidth: 140 }}>{val || '-'}</Text>
        </Tooltip>
      ),
    },
    { title: 'Batch', dataIndex: 'batch', width: 80, render: (val) => val || '-' },
    { title: 'Location', dataIndex: 'location', width: 80, render: (val) => val || '-' },
    {
      title: 'System Qty',
      dataIndex: 'system_qty',
      width: 90,
      align: 'right',
      render: (val) => formatNumber(val || 0),
    },
    {
      title: 'Physical Qty',
      dataIndex: 'physical_qty',
      width: 100,
      align: 'right',
      render: (val) => {
        if (val === null || val === undefined) return <Text type="secondary">Not counted</Text>;
        return <Text strong>{formatNumber(val)}</Text>;
      },
    },
    {
      title: 'Variance',
      dataIndex: 'variance',
      width: 90,
      align: 'right',
      render: (val) => {
        if (!val || val === 0) return <Text type="secondary">0</Text>;
        if (val > 0) return <Text style={{ color: '#52c41a' }}>+{formatNumber(val)}</Text>;
        return <Text style={{ color: '#f5222d' }}>{formatNumber(val)}</Text>;
      },
    },
    {
      title: 'Variance Value',
      dataIndex: 'variance_value',
      width: 110,
      align: 'right',
      render: (val) => {
        if (!val || val === 0) return <Text type="secondary">-</Text>;
        const color = val > 0 ? '#52c41a' : '#f5222d';
        return <Text style={{ color }}>{formatCurrency(val)}</Text>;
      },
    },
    { title: 'Remarks', dataIndex: 'remarks', width: 120, render: (val) => val || '-' },
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
        placeholder="Audit Type"
        options={AUDIT_TYPES}
        value={filterAuditType}
        onChange={(val) => { setFilterAuditType(val); setRefreshKey((k) => k + 1); }}
        allowClear
        style={{ width: 140 }}
        size="middle"
      />
      <Select
        placeholder="Status"
        options={AUDIT_STATUSES}
        value={filterStatus}
        onChange={(val) => { setFilterStatus(val); setRefreshKey((k) => k + 1); }}
        allowClear
        style={{ width: 150 }}
        size="middle"
      />
    </Space>
  );

  const drawerVarianceSummary = getVarianceSummary(auditItems);

  return (
    <div>
      <PageHeader title="Stock Audit" subtitle="Physical inventory and stock audit management">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          Create Audit
        </Button>
      </PageHeader>

      <Card bodyStyle={{ padding: 0 }}>
        <DataTable
          key={refreshKey}
          columns={columns}
          fetchFunction={fetchAudits}
          rowKey="id"
          searchPlaceholder="Search audits..."
          exportFileName="Stock_Audits"
          toolbar={filterToolbar}
          scroll={{ x: 1500 }}
        />
      </Card>

      {/* Create/Edit Drawer */}
      <Drawer
        title={
          <Space>
            <AuditOutlined />
            {editingAudit ? `Edit Audit: ${editingAudit.audit_number}` : 'Create Stock Audit'}
          </Space>
        }
        placement="right"
        width={1100}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => setDrawerOpen(false)}>Cancel</Button>
            <Button onClick={() => handleSubmit('in_progress')} loading={submitting}>
              Save In Progress
            </Button>
            <Button onClick={() => handleSubmit('draft')} loading={submitting}>
              Save Draft
            </Button>
            <Button type="primary" icon={<SendOutlined />} onClick={() => handleSubmit('submit_approval')} loading={submitting}>
              Submit for Approval
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="warehouse_id"
                label="Warehouse"
                rules={[{ required: true, message: 'Select warehouse' }]}
              >
                <Select
                  placeholder="Select warehouse"
                  options={warehouses}
                  showSearch
                  optionFilterProp="label"
                  onChange={(val) => populateWarehouseItems(val)}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="audit_date"
                label="Audit Date"
                rules={[{ required: true, message: 'Select date' }]}
              >
                <DatePicker format={DATE_FORMAT} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="audit_type"
                label="Audit Type"
                rules={[{ required: true, message: 'Select audit type' }]}
              >
                <Select options={AUDIT_TYPES} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item name="remarks" label="Remarks">
                <TextArea rows={2} placeholder="Audit notes..." />
              </Form.Item>
            </Col>
          </Row>
        </Form>

        {/* Variance Summary */}
        {auditItems.length > 0 && (
          <Card size="small" style={{ marginBottom: 16, background: '#fafafa' }}>
            <Row gutter={16}>
              <Col span={4}>
                <Statistic title="Total Items" value={drawerVarianceSummary.total} />
              </Col>
              <Col span={4}>
                <Statistic title="Counted" value={drawerVarianceSummary.counted} valueStyle={{ color: '#eb2f96' }} />
              </Col>
              <Col span={4}>
                <Statistic title="Matched" value={drawerVarianceSummary.matched} valueStyle={{ color: '#52c41a' }} />
              </Col>
              <Col span={4}>
                <Statistic
                  title="Variance Items"
                  value={drawerVarianceSummary.varianceCount}
                  valueStyle={{ color: drawerVarianceSummary.varianceCount > 0 ? '#fa8c16' : undefined }}
                />
              </Col>
              <Col span={4}>
                <Statistic
                  title="Surplus"
                  value={drawerVarianceSummary.positiveVariance}
                  prefix={<ArrowUpOutlined />}
                  valueStyle={{ color: '#52c41a' }}
                />
              </Col>
              <Col span={4}>
                <Statistic
                  title="Shortage"
                  value={drawerVarianceSummary.negativeVariance}
                  prefix={<ArrowDownOutlined />}
                  valueStyle={{ color: '#f5222d' }}
                />
              </Col>
            </Row>
            {drawerVarianceSummary.totalVarianceValue > 0 && (
              <Alert
                message={`Total Variance Value: ${formatCurrency(drawerVarianceSummary.totalVarianceValue)}`}
                type="warning"
                showIcon
                icon={<ExclamationCircleOutlined />}
                style={{ marginTop: 12 }}
              />
            )}
          </Card>
        )}

        <Divider orientation="left" style={{ marginTop: 8 }}>
          <Space>
            <AuditOutlined />
            Audit Items
            {loadingItems && <Text type="secondary">(Loading...)</Text>}
          </Space>
        </Divider>

        <Table
          columns={auditItemColumns}
          dataSource={auditItems}
          rowKey="key"
          pagination={auditItems.length > 50 ? { pageSize: 50, showSizeChanger: true } : false}
          scroll={{ x: 1200 }}
          size="small"
          loading={loadingItems}
          rowClassName={(record) => {
            if (record.physical_qty === null || record.physical_qty === undefined) return '';
            if (record.variance > 0) return 'audit-row-surplus';
            if (record.variance < 0) return 'audit-row-shortage';
            return 'audit-row-matched';
          }}
        />
      </Drawer>

      {/* View Detail Modal */}
      <Modal
        title={
          viewData ? (
            <Space>
              <AuditOutlined />
              <span>Audit: {viewData.audit_number}</span>
              <StatusTag status={viewData.status} />
            </Space>
          ) : 'Audit Detail'
        }
        open={viewModalOpen}
        onCancel={() => { setViewModalOpen(false); setViewData(null); }}
        width={1100}
        loading={viewLoading}
        footer={
          viewData ? (
            <Space>
              {(viewData.status === 'draft' || viewData.status === 'in_progress') && (
                <Popconfirm title="Submit for approval?" onConfirm={() => handleAction(viewData.id, 'submit', 'Submitted for approval')}>
                  <Button icon={<SendOutlined />}>Submit for Approval</Button>
                </Popconfirm>
              )}
              {viewData.status === 'pending_approval' && (
                <>
                  <Popconfirm title="Approve adjustments and apply to stock ledger?" onConfirm={() => handleAction(viewData.id, 'approve', 'Adjustments approved and applied')}>
                    <Button type="primary" icon={<CheckOutlined />}>Approve Adjustments</Button>
                  </Popconfirm>
                  <Popconfirm title="Reject?" onConfirm={() => handleAction(viewData.id, 'reject', 'Audit rejected')}>
                    <Button danger icon={<CloseCircleOutlined />}>Reject</Button>
                  </Popconfirm>
                </>
              )}
              <Button onClick={() => setViewModalOpen(false)}>Close</Button>
            </Space>
          ) : null
        }
      >
        {viewData && (
          <>
            <Descriptions size="small" column={3} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="Audit No">{viewData.audit_number}</Descriptions.Item>
              <Descriptions.Item label="Warehouse">{viewData.warehouse_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Audit Date">{formatDate(viewData.audit_date)}</Descriptions.Item>
              <Descriptions.Item label="Audit Type">
                {AUDIT_TYPES.find((t) => t.value === viewData.audit_type)?.label || viewData.audit_type}
              </Descriptions.Item>
              <Descriptions.Item label="Status"><StatusTag status={viewData.status} /></Descriptions.Item>
              <Descriptions.Item label="Created By">{viewData.created_by || '-'}</Descriptions.Item>
              <Descriptions.Item label="Created At" span={2}>{formatDateTime(viewData.created_at)}</Descriptions.Item>
              <Descriptions.Item label="Remarks">{viewData.remarks || '-'}</Descriptions.Item>
            </Descriptions>

            {/* Variance Summary for view */}
            {(() => {
              const vs = getVarianceSummary(viewData.items || []);
              return (
                <Card size="small" style={{ marginBottom: 16, background: '#fafafa' }}>
                  <Row gutter={16}>
                    <Col span={4}><Statistic title="Total Items" value={vs.total} /></Col>
                    <Col span={4}><Statistic title="Matched" value={vs.matched} valueStyle={{ color: '#52c41a' }} /></Col>
                    <Col span={4}>
                      <Statistic title="Variance Items" value={vs.varianceCount} valueStyle={{ color: vs.varianceCount > 0 ? '#fa8c16' : undefined }} />
                    </Col>
                    <Col span={6}>
                      <Statistic title="Total Variance Value" value={formatCurrency(vs.totalVarianceValue)} valueStyle={{ color: '#fa8c16' }} />
                    </Col>
                    <Col span={3}><Statistic title="Surplus" value={vs.positiveVariance} prefix={<ArrowUpOutlined />} valueStyle={{ color: '#52c41a' }} /></Col>
                    <Col span={3}><Statistic title="Shortage" value={vs.negativeVariance} prefix={<ArrowDownOutlined />} valueStyle={{ color: '#f5222d' }} /></Col>
                  </Row>
                </Card>
              );
            })()}

            <Divider orientation="left" style={{ fontSize: 14 }}>Audit Items</Divider>
            <Table
              columns={viewItemColumns}
              dataSource={viewData.items || []}
              rowKey={(r, idx) => r.id || idx}
              pagination={false}
              scroll={{ x: 1000 }}
              size="small"
              rowClassName={(record) => {
                if (record.physical_qty === null || record.physical_qty === undefined) return '';
                if (record.variance > 0) return 'audit-row-surplus';
                if (record.variance < 0) return 'audit-row-shortage';
                return 'audit-row-matched';
              }}
            />
          </>
        )}
      </Modal>

      <style>{`
        .audit-row-surplus { background-color: #f6ffed !important; }
        .audit-row-surplus:hover > td { background-color: #d9f7be !important; }
        .audit-row-shortage { background-color: #fff1f0 !important; }
        .audit-row-shortage:hover > td { background-color: #ffccc7 !important; }
        .audit-row-matched { background-color: #fff !important; }
      `}</style>
    </div>
  );
};

export default StockAudit;

