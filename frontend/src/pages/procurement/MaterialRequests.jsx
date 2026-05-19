import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Tabs,
  Divider, Typography, Tooltip, Tag, Empty, Spin,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  ArrowLeftOutlined, SendOutlined, CloseCircleOutlined,
  MinusCircleOutlined, DownloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import {
  formatDate, formatCurrency, getErrorMessage, formatDateForAPI,
  downloadExcel,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const REQUEST_TYPES = [
  { label: 'Purchase', value: 'purchase' },
  { label: 'Transfer', value: 'transfer' },
  { label: 'Consumption', value: 'consumption' },
  { label: 'Maintenance', value: 'maintenance' },
  { label: 'Replenishment', value: 'replenishment' },
];

const PRIORITIES = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Critical', value: 'critical' },
];

const PRIORITY_COLORS = {
  low: 'blue',
  medium: 'gold',
  high: 'orange',
  critical: 'red',
};

const MR_STATUS_FLOW = [
  'draft',
  'pending_approval',
  'approved',
  'partially_ordered',
  'ordered',
];

const MaterialRequests = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingMR, setEditingMR] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterType, setFilterType] = useState(undefined);
  const [filterPriority, setFilterPriority] = useState(undefined);

  // Detail view
  const [detailMR, setDetailMR] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState('info');
  const [linkedPOs, setLinkedPOs] = useState([]);
  const [tabLoading, setTabLoading] = useState(false);

  // Items in drawer
  const [mrItems, setMrItems] = useState([]);

  // Lookup data
  const [departments, setDepartments] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [projects, setProjects] = useState([]);
  const [uoms, setUoms] = useState([]);

  const loadLookups = useCallback(async () => {
    try {
      const [deptRes, whRes, projRes, uomRes] = await Promise.allSettled([
        api.get('/masters/departments', { params: { page_size: 200 } }),
        api.get('/masters/warehouses', { params: { page_size: 200 } }),
        api.get('/masters/projects', { params: { page_size: 200 } }),
        api.get('/masters/uom', { params: { page_size: 200 } }),
      ]);
      if (deptRes.status === 'fulfilled') {
        const d = deptRes.value.data;
        const items = d.items || d.data || d || [];
        setDepartments(items.map((i) => ({ label: i.name, value: i.name })));
      }
      if (whRes.status === 'fulfilled') {
        const w = whRes.value.data;
        setWarehouses((w.items || w.data || w || []).map((i) => ({ label: i.name || i.warehouse_name, value: i.id })));
      }
      if (projRes.status === 'fulfilled') {
        const p = projRes.value.data;
        setProjects((p.items || p.data || p || []).map((i) => ({ label: i.name || i.project_name, value: i.id })));
      }
      if (uomRes.status === 'fulfilled') {
        const u = uomRes.value.data;
        const items = u.items || u.data || u || [];
        setUoms(items.map((i) => ({ label: `${i.name} (${i.abbreviation || ''})`, value: i.id })));
      }
    } catch {
      // silent
    }
  }, []);

  // Preload lookups on mount
  useEffect(() => {
    loadLookups();
  }, []);

  const fetchMRs = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterType) qp.request_type = filterType;
      if (filterPriority) qp.priority = filterPriority;
      return await api.get('/procurement/material-requests', { params: qp });
    },
    [filterStatus, filterType, filterPriority]
  );

  const handleAdd = () => {
    setEditingMR(null);
    form.resetFields();
    form.setFieldsValue({
      request_type: 'purchase',
      priority: 'medium',
      required_date: dayjs().add(7, 'day'),
    });
    setMrItems([{ key: Date.now(), item_id: null, item_name: '', qty: 1, uom_id: null, target_warehouse_id: null, remarks: '' }]);
    loadLookups();
    setDrawerOpen(true);
  };

  const handleEdit = async (record) => {
    setEditingMR(record);
    loadLookups();
    try {
      const res = await api.get(`/procurement/material-requests/${record.id}`);
      const data = res.data;
      form.setFieldsValue({
        ...data,
        required_date: data.required_date ? dayjs(data.required_date) : null,
      });
      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_name: item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.item_name || item.item.name}` : ''),
        qty: item.qty || item.quantity,
        uom_id: item.uom_id || null,
        target_warehouse_id: item.target_warehouse_id,
        remarks: item.remarks || '',
      }));
      setMrItems(items.length > 0 ? items : [{ key: Date.now(), item_id: null, item_name: '', qty: 1, uom_id: null, target_warehouse_id: null, remarks: '' }]);
    } catch (err) {
      message.error(getErrorMessage(err));
      return;
    }
    setDrawerOpen(true);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/procurement/material-requests/${id}`);
      message.success('Material Request deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSubmit = async (submitForApproval = false) => {
    try {
      const values = await form.validateFields();
      // BUG-PRO-149 fix: qty=0 rows passed through and forced the backend
      // schema to 422. Filter them out client-side with a clear message.
      const validItems = mrItems.filter((item) => item.item_id && Number(item.qty) > 0);
      if (validItems.length === 0) {
        message.error('Please add at least one item with qty > 0');
        return;
      }
      setSubmitting(true);

      const payload = {
        request_type: values.request_type,
        project_id: values.project_id ? parseInt(values.project_id, 10) : null,
        warehouse_id: values.warehouse_id ? parseInt(values.warehouse_id, 10) : null,
        department: values.department_id || values.department || null,
        priority: values.priority,
        remarks: values.remarks || null,
        // BUG-PRO-148 fix: pull the date from the form when the user picked
        // one (e.g. back-dating an MR to the actual indent date) instead of
        // unconditionally stamping "now".
        request_date: formatDateForAPI(values.request_date || new Date()),
        required_date: formatDateForAPI(values.required_date),
        items: validItems.map((item) => ({
          item_id: item.item_id,
          qty: item.qty,
          uom_id: item.uom_id || null,
          target_warehouse_id: item.target_warehouse_id || null,
          remarks: item.remarks || '',
        })),
      };

      if (editingMR) {
        await api.put(`/procurement/material-requests/${editingMR.id}`, payload);
        if (submitForApproval && editingMR.status === 'draft') {
          try {
            await api.post(`/procurement/material-requests/${editingMR.id}/submit`);
            message.success('Material Request submitted for approval');
          } catch (submitErr) {
            message.warning('MR saved but approval submission failed: ' + getErrorMessage(submitErr));
          }
        } else {
          message.success('Material Request updated');
        }
      } else {
        const res = await api.post('/procurement/material-requests', payload);
        const newId = res.data?.id;
        if (submitForApproval && newId) {
          try {
            await api.post(`/procurement/material-requests/${newId}/submit`);
            message.success('Material Request created and submitted for approval');
          } catch (submitErr) {
            message.warning('MR created but approval submission failed: ' + getErrorMessage(submitErr));
          }
        } else {
          message.success('Material Request created as draft');
        }
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingMR(null);
      setMrItems([]);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id) => {
    try {
      await api.post(`/procurement/material-requests/${id}/cancel`);
      message.success('Material Request cancelled');
      setRefreshKey((k) => k + 1);
      if (detailMR && detailMR.id === id) {
        setDetailMR((prev) => ({ ...prev, status: 'cancelled' }));
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSubmitForApproval = async (id) => {
    try {
      await api.post(`/procurement/material-requests/${id}/submit`);
      message.success('Material Request submitted for approval');
      setRefreshKey((k) => k + 1);
      if (detailMR && detailMR.id === id) {
        setDetailMR((prev) => ({ ...prev, status: 'pending_approval' }));
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // Detail view
  const handleViewMR = async (record) => {
    setDetailLoading(true);
    setDetailMR(null);
    setDetailTab('info');
    setLinkedPOs([]);
    try {
      const res = await api.get(`/procurement/material-requests/${record.id}`);
      setDetailMR(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const fetchLinkedPOs = async () => {
    if (!detailMR) return;
    setTabLoading(true);
    try {
      const res = await api.get(`/procurement/material-requests/${detailMR.id}/purchase-orders`, { params: { page_size: 100 } });
      setLinkedPOs(res.data.items || res.data.data || res.data || []);
    } catch {
      // silent
    } finally {
      setTabLoading(false);
    }
  };

  // Items table management
  const addItemRow = () => {
    setMrItems((prev) => [
      ...prev,
      { key: Date.now(), item_id: null, item_name: '', qty: 1, uom_id: null, target_warehouse_id: null, remarks: '' },
    ]);
  };

  const removeItemRow = (key) => {
    setMrItems((prev) => prev.filter((item) => item.key !== key));
  };

  const updateItemRow = (key, field, value) => {
    setMrItems((prev) =>
      prev.map((item) => (item.key === key ? { ...item, [field]: value } : item))
    );
  };

  const itemColumns = [
    {
      title: '#',
      width: 40,
      render: (_, __, idx) => idx + 1,
    },
    {
      title: 'Item',
      dataIndex: 'item_id',
      width: 280,
      render: (val, record) => (
        <ItemSelector
          value={val}
          onChange={(itemId, item) => {
            updateItemRow(record.key, 'item_id', itemId);
            if (item) {
              updateItemRow(record.key, 'item_name', item.item_name || item.name || '');
              updateItemRow(record.key, 'uom_id', item.primary_uom_id || null);
            }
          }}
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Qty',
      dataIndex: 'qty',
      width: 100,
      render: (val, record) => (
        <InputNumber
          min={0.01}
          value={val}
          onChange={(v) => updateItemRow(record.key, 'qty', v)}
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'UOM',
      dataIndex: 'uom_id',
      width: 140,
      render: (val, record) => (
        <Select
          value={val}
          onChange={(v) => updateItemRow(record.key, 'uom_id', v)}
          options={uoms}
          placeholder="Select UOM"
          optionFilterProp="label"
          allowClear
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Target Warehouse',
      dataIndex: 'target_warehouse_id',
      width: 180,
      render: (val, record) => (
        <Select
          value={val}
          onChange={(v) => updateItemRow(record.key, 'target_warehouse_id', v)}
          options={warehouses}
          placeholder="Select"
          allowClear
          optionFilterProp="label"
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Remarks',
      dataIndex: 'remarks',
      width: 160,
      render: (val, record) => (
        <Input
          value={val}
          onChange={(e) => updateItemRow(record.key, 'remarks', e.target.value)}
          placeholder="Remarks"
        />
      ),
    },
    {
      title: '',
      width: 40,
      render: (_, record) =>
        mrItems.length > 1 ? (
          <Tooltip title="Remove">
            <MinusCircleOutlined
              style={{ color: '#ff4d4f', cursor: 'pointer', fontSize: 16 }}
              onClick={() => removeItemRow(record.key)}
            />
          </Tooltip>
        ) : null,
    },
  ];

  const columns = [
    {
      title: 'MR Number',
      dataIndex: 'mr_number',
      key: 'mr_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a onClick={() => handleViewMR(record)}>{text}</a>
      ),
    },
    {
      title: 'Request Date',
      dataIndex: 'request_date',
      key: 'request_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Request Type',
      dataIndex: 'request_type',
      key: 'request_type',
      width: 130,
      render: (v) => {
        const found = REQUEST_TYPES.find((t) => t.value === v);
        return <StatusTag status={v} />;
      },
    },
    {
      title: 'Department',
      dataIndex: 'department_name',
      key: 'department',
      width: 140,
      render: (v, r) => v || r.department || '-',
    },
    {
      title: 'Requested By',
      dataIndex: 'requested_by_name',
      key: 'requested_by',
      width: 140,
      render: (v, r) => v || r.requested_by || '-',
    },
    {
      title: 'Required Date',
      dataIndex: 'required_date',
      key: 'required_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Priority',
      dataIndex: 'priority',
      key: 'priority',
      width: 100,
      render: (v) => {
        return <StatusTag status={v} />;
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 140,
      render: (status) => <StatusTag status={status} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleViewMR(record)} />
          {record.status === 'draft' && (
            <>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
              <Tooltip title="Submit for Approval">
                <Button type="link" size="small" icon={<SendOutlined />} onClick={() => handleSubmitForApproval(record.id)} />
              </Tooltip>
              <Popconfirm title="Delete this MR?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
          {['draft', 'pending_approval'].includes(record.status) && (
            <Popconfirm title="Cancel this MR?" onConfirm={() => handleCancel(record.id)} okButtonProps={{ danger: true }}>
              <Button type="link" size="small" danger icon={<CloseCircleOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 160 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Draft', value: 'draft' },
          { label: 'Pending Approval', value: 'pending_approval' },
          { label: 'Approved', value: 'approved' },
          { label: 'Partially Ordered', value: 'partially_ordered' },
          { label: 'Ordered', value: 'ordered' },
          { label: 'Cancelled', value: 'cancelled' },
        ]}
      />
      <Select
        placeholder="Request Type"
        allowClear
        style={{ width: 140 }}
        value={filterType}
        onChange={(v) => { setFilterType(v); setRefreshKey((k) => k + 1); }}
        options={REQUEST_TYPES}
      />
      <Select
        placeholder="Priority"
        allowClear
        style={{ width: 120 }}
        value={filterPriority}
        onChange={(v) => { setFilterPriority(v); setRefreshKey((k) => k + 1); }}
        options={PRIORITIES}
      />
    </Space>
  );

  // -- DETAIL VIEW --
  if (detailLoading) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (detailMR) {
    const mrItemsList = detailMR.items || [];
    const statusIdx = MR_STATUS_FLOW.indexOf(detailMR.status);

    return (
      <div>
        <PageHeader
          title={`${detailMR.mr_number}`}
          subtitle="Material Request Detail"
        >
          <Space>
            {detailMR.status === 'draft' && (
              <>
                <Button icon={<SendOutlined />} type="primary" onClick={() => handleSubmitForApproval(detailMR.id)}>
                  Submit for Approval
                </Button>
                <Button icon={<EditOutlined />} onClick={() => { handleEdit(detailMR); setDetailMR(null); }}>
                  Edit
                </Button>
              </>
            )}
            {['draft', 'pending_approval'].includes(detailMR.status) && (
              <Popconfirm title="Cancel this MR?" onConfirm={() => handleCancel(detailMR.id)} okButtonProps={{ danger: true }}>
                <Button danger icon={<CloseCircleOutlined />}>Cancel</Button>
              </Popconfirm>
            )}
            <Button icon={<ArrowLeftOutlined />} onClick={() => setDetailMR(null)}>
              Back to List
            </Button>
          </Space>
        </PageHeader>

        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {MR_STATUS_FLOW.map((s, idx) => {
              const isCurrent = s === detailMR.status;
              const isPast = idx < statusIdx;
              const isCancelled = detailMR.status === 'cancelled';
              return (
                <Tag
                  key={s}
                  color={isCancelled ? 'default' : isCurrent ? 'blue' : isPast ? 'green' : 'default'}
                  style={{ padding: '4px 12px', fontSize: 13 }}
                >
                  {s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </Tag>
              );
            })}
            {detailMR.status === 'cancelled' && (
              <StatusTag status="cancelled" style={{ padding: '4px 12px', fontSize: 13 }} />
            )}
          </div>
        </Card>

        <Card>
          <Tabs
            activeKey={detailTab}
            onChange={(tab) => {
              setDetailTab(tab);
              if (tab === 'linked_pos') fetchLinkedPOs();
            }}
            items={[
              {
                key: 'info',
                label: 'MR Info',
                children: (
                  <>
                    <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
                      <Descriptions.Item label="MR Number">{detailMR.mr_number}</Descriptions.Item>
                      <Descriptions.Item label="Request Date">{formatDate(detailMR.request_date)}</Descriptions.Item>
                      <Descriptions.Item label="Request Type">
                        {REQUEST_TYPES.find((t) => t.value === detailMR.request_type)?.label || detailMR.request_type || '-'}
                      </Descriptions.Item>
                      <Descriptions.Item label="Department">{detailMR.department_name || detailMR.department || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Project">{detailMR.project_name || detailMR.project || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Warehouse">{detailMR.warehouse_name || detailMR.warehouse || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Requested By">{detailMR.requested_by_name || detailMR.requested_by || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Required Date">{formatDate(detailMR.required_date)}</Descriptions.Item>
                      <Descriptions.Item label="Priority">
                        <StatusTag status={detailMR.priority} />
                      </Descriptions.Item>
                      <Descriptions.Item label="Status"><StatusTag status={detailMR.status} /></Descriptions.Item>
                      <Descriptions.Item label="Approved By">{detailMR.approved_by_name || detailMR.approved_by || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Approved Date">{formatDate(detailMR.approved_date)}</Descriptions.Item>
                      <Descriptions.Item label="Remarks" span={3}>{detailMR.remarks || '-'}</Descriptions.Item>
                    </Descriptions>

                    <Divider orientation="left">Items</Divider>
                    <Table
                      dataSource={mrItemsList}
                      rowKey={(r) => r.id || r.item_id}
                      size="small"
                      pagination={false}
                      scroll={{ x: 'max-content' }}
                      columns={[
                        { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
                        {
                          title: 'Item Code',
                          dataIndex: ['item', 'item_code'],
                          key: 'code',
                          width: 120,
                          render: (t, r) => t || r.item_code || '-',
                        },
                        {
                          title: 'Item Name',
                          dataIndex: ['item', 'item_name'],
                          key: 'name',
                          width: 220,
                          render: (t, r) => t || r.item_name || (r.item && r.item.name) || '-',
                        },
                        { title: 'Qty', dataIndex: 'qty', key: 'qty', width: 80, align: 'right', render: (v, r) => v || r.quantity || '-' },
                        { title: 'UOM', dataIndex: 'uom', key: 'uom', width: 80, render: (v, r) => v || r.unit || '-' },
                        {
                          title: 'Target Warehouse',
                          dataIndex: 'target_warehouse_name',
                          key: 'tw',
                          width: 160,
                          render: (v, r) => v || r.target_warehouse || '-',
                        },
                        {
                          title: 'Ordered Qty',
                          dataIndex: 'ordered_qty',
                          key: 'oq',
                          width: 100,
                          align: 'right',
                          render: (v) => v || 0,
                        },
                        { title: 'Remarks', dataIndex: 'remarks', key: 'rem', width: 160, ellipsis: true, render: (v) => v || '-' },
                      ]}
                    />
                  </>
                ),
              },
              {
                key: 'approval',
                label: 'Approval History',
                children: (
                  <Table
                    dataSource={detailMR.approval_history || detailMR.approvals || []}
                    rowKey={(r) => r.id || r.timestamp || Math.random()}
                    size="small"
                    pagination={false}
                    scroll={{ x: 'max-content' }}
                    locale={{ emptyText: <Empty description="No approval history" /> }}
                    columns={[
                      { title: 'Action', dataIndex: 'action', key: 'action', width: 120, render: (v) => <StatusTag status={v} /> },
                      { title: 'By', dataIndex: 'user_name', key: 'by', width: 160, render: (v, r) => v || r.user || '-' },
                      { title: 'Date', dataIndex: 'timestamp', key: 'date', width: 160, render: (v) => formatDate(v) },
                      { title: 'Remarks', dataIndex: 'remarks', key: 'rem', ellipsis: true, render: (v) => v || '-' },
                    ]}
                  />
                ),
              },
              {
                key: 'linked_pos',
                label: 'Linked POs',
                children: (
                  <Table
                    dataSource={linkedPOs}
                    loading={tabLoading}
                    rowKey="id"
                    size="small"
                    pagination={{ pageSize: 20, showSizeChanger: true }}
                    scroll={{ x: 'max-content' }}
                    locale={{ emptyText: <Empty description="No linked purchase orders" /> }}
                    columns={[
                      { title: 'PO Number', dataIndex: 'po_number', key: 'po', width: 140 },
                      { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 180, render: (v, r) => v || r.vendor || '-' },
                      { title: 'PO Date', dataIndex: 'po_date', key: 'date', width: 120, render: (v) => formatDate(v) },
                      { title: 'Total', dataIndex: 'grand_total', key: 'total', width: 120, align: 'right', render: (v) => formatCurrency(v) },
                      { title: 'Status', dataIndex: 'status', key: 'status', width: 130, render: (s) => <StatusTag status={s} /> },
                    ]}
                  />
                ),
              },
            ]}
          />
        </Card>
      </div>
    );
  }

  // -- LIST VIEW --
  return (
    <div>
      <PageHeader title="Material Requests" subtitle="Manage material requests">
        <Space>
          <Button icon={<DownloadOutlined />} onClick={async () => {
            try {
              const res = await api.get('/procurement/material-requests', { params: { page_size: 10000 } });
              const data = res.data;
              const items = data.items || data.data || data || [];
              const exportData = items.map((mr) => ({
                'MR Number': mr.mr_number,
                'Request Date': formatDate(mr.request_date),
                'Request Type': mr.request_type || '',
                'Department': mr.department_name || mr.department || '',
                'Priority': mr.priority || '',
                'Required Date': formatDate(mr.required_date),
                'Status': mr.status,
              }));
              downloadExcel(exportData, 'material_requests', 'Material Requests');
              message.success('Export completed');
            } catch (err) { message.error(getErrorMessage(err)); }
          }}>Export</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            Create MR
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchMRs}
        rowKey="id"
        searchPlaceholder="Search by MR number..."
        exportFileName="material_requests"
        toolbar={toolbar}
        scroll={{ x: 1600 }}
        onRow={(record) => ({
          style: { cursor: 'pointer' },
          onClick: (e) => {
            if (e.target.tagName === 'A' || e.target.closest('button') || e.target.closest('.ant-popconfirm')) return;
          },
        })}
      />

      {/* Create / Edit Drawer */}
      <Drawer
        title={editingMR ? `Edit ${editingMR.mr_number}` : 'Create Material Request'}
        width={960}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setEditingMR(null);
          form.resetFields();
          setMrItems([]);
        }}
        destroyOnHidden
        extra={
          <Space>
            <Button
              onClick={() => {
                setDrawerOpen(false);
                setEditingMR(null);
                form.resetFields();
                setMrItems([]);
              }}
            >
              Cancel
            </Button>
            <Button onClick={() => handleSubmit(false)} loading={submitting}>
              Save as Draft
            </Button>
            <Button type="primary" icon={<SendOutlined />} onClick={() => handleSubmit(true)} loading={submitting}>
              Submit for Approval
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="request_type"
                label="Request Type"
                rules={[{ required: true, message: 'Required' }]}
              >
                <Select options={REQUEST_TYPES} placeholder="Select type" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="project_id" label="Project">
                <Select
                  options={projects}
                  placeholder="Select project"
                  allowClear
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true, message: 'Warehouse is required' }]}>
                <Select
                  options={warehouses}
                  placeholder="Select warehouse"
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="department_id" label="Department">
                <Select
                  options={departments}
                  placeholder="Select department"
                  allowClear
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="required_date"
                label="Required Date"
                rules={[{ required: true, message: 'Required' }]}
              >
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="priority"
                label="Priority"
                rules={[{ required: true, message: 'Required' }]}
              >
                <Select options={PRIORITIES} placeholder="Select priority" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remarks" label="Remarks">
            <TextArea rows={2} placeholder="Any remarks..." />
          </Form.Item>
        </Form>

        <Divider orientation="left">Items</Divider>
        <Table
          dataSource={mrItems}
          columns={itemColumns}
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
      </Drawer>
    </div>
  );
};

export default MaterialRequests;

