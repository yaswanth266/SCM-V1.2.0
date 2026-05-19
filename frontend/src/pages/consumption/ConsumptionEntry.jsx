import React, { useState, useCallback } from 'react';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Tabs,
  Divider, Typography, Tooltip, Tag, Spin, Empty,
} from 'antd';
import {
  PlusOutlined, EditOutlined, EyeOutlined, ArrowLeftOutlined,
  SendOutlined, CloseCircleOutlined, CheckCircleOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import {
  formatDate, formatNumber, formatCurrency, getErrorMessage, formatDateForAPI,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;
const { RangePicker } = DatePicker;

const SOURCE_LABELS = {
  web: 'Web',
  mobile_app: 'Mobile App',
};

const ConsumptionEntry = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterProject, setFilterProject] = useState(undefined);
  const [filterDepartment, setFilterDepartment] = useState(undefined);
  const [filterDateRange, setFilterDateRange] = useState(null);

  const [detailRecord, setDetailRecord] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [consumptionItems, setConsumptionItems] = useState([]);

  const [departments, setDepartments] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [projects, setProjects] = useState([]);
  const [costCenters, setCostCenters] = useState([]);

  const loadLookups = useCallback(async () => {
    try {
      const [deptRes, whRes, projRes, ccRes] = await Promise.allSettled([
        api.get('/masters/departments', { params: { page_size: 200 } }),
        api.get('/masters/warehouses', { params: { page_size: 200 } }),
        api.get('/masters/projects', { params: { page_size: 200 } }),
        api.get('/masters/cost-centers', { params: { page_size: 200 } }),
      ]);
      if (deptRes.status === 'fulfilled') {
        const d = deptRes.value.data;
        setDepartments((d.items || d.data || d || []).map((i) => ({ label: i.name, value: i.id })));
      }
      if (whRes.status === 'fulfilled') {
        const w = whRes.value.data;
        const list = (w.items || w.data || w || []).map((i) => ({ label: i.name || i.warehouse_name, value: i.id }));
        setWarehouses(list);
        if (list.length === 1) form.setFieldValue('warehouse_id', list[0].value);
      }
      if (projRes.status === 'fulfilled') {
        const p = projRes.value.data;
        const list = (p.items || p.data || p || []).map((i) => ({ label: i.name || i.project_name, value: i.id }));
        setProjects(list);
        if (list.length === 1) form.setFieldValue('project_id', list[0].value);
      }
      if (ccRes.status === 'fulfilled') {
        const c = ccRes.value.data;
        setCostCenters((c.items || c.data || c || []).map((i) => ({ label: i.name || i.cost_center_name, value: i.id })));
      }
    } catch { /* silent */ }
  }, []);

  const fetchData = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterProject) qp.project_id = filterProject;
      if (filterDepartment) qp.department_id = filterDepartment;
      if (filterDateRange && filterDateRange[0]) qp.date_from = formatDateForAPI(filterDateRange[0]);
      if (filterDateRange && filterDateRange[1]) qp.date_to = formatDateForAPI(filterDateRange[1]);
      return await api.get('/consumption/entries', { params: qp });
    },
    [filterStatus, filterProject, filterDepartment, filterDateRange]
  );

  const handleAdd = () => {
    // BUG-ISS-117 — explicitly clear ALL drawer state before opening so a
    // prior edit cannot leak patient_name, prescriber_*, items, etc. into
    // the new entry. Resetting form alone leaves stale local state.
    setEditingRecord(null);
    form.resetFields();
    form.setFieldsValue({
      consumption_date: dayjs(),
      source: 'web',
      patient_name: undefined,
      patient_aadhaar: undefined,
      case_id: undefined,
      prescriber_name: undefined,
      prescriber_license: undefined,
    });
    setConsumptionItems([{ key: Date.now(), item_id: null, item_name: '', batch_id: null, qty: 1, uom: '', uom_id: null, remarks: '' }]);
    loadLookups();
    setDrawerOpen(true);
  };

  const handleEdit = async (record) => {
    setEditingRecord(record);
    loadLookups();
    try {
      const res = await api.get(`/consumption/entries/${record.id}`);
      const data = res.data;
      form.setFieldsValue({
        ...data,
        consumption_date: data.consumption_date ? dayjs(data.consumption_date) : dayjs(),
      });
      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_name: item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.item_name || item.item.name}` : ''),
        batch_id: item.batch_id,
        batch_number: item.batch_number || (item.batch ? item.batch.batch_number : ''),
        qty: item.qty || item.quantity,
        uom: item.uom || item.unit,
        uom_id: item.uom_id,
        rate: item.rate || 0,
        amount: item.amount || 0,
        remarks: item.remarks || '',
        available_batches: [],
      }));
      setConsumptionItems(items.length > 0 ? items : [{ key: Date.now(), item_id: null, item_name: '', batch_id: null, qty: 1, uom: '', remarks: '' }]);
      // BUG-ISS-119 — fetch the available batches for each item AFTER the
      // items state is restored so the previously-saved batch can be matched
      // against the current available list. Without this, an expired batch
      // selection persists silently with no warning.
      setTimeout(() => {
        items.forEach((it) => {
          if (it.item_id) {
            fetchBatches(it.item_id, it.key);
          }
        });
      }, 0);
    } catch (err) {
      message.error(getErrorMessage(err));
      return;
    }
    setDrawerOpen(true);
  };

  const handleSubmit = async (submitNow = false) => {
    try {
      const values = await form.validateFields();
      const validItems = consumptionItems.filter((item) => item.item_id);
      if (validItems.length === 0) {
        message.error('Please add at least one item');
        return;
      }
      const itemsWithoutUOM = validItems.filter((item) => !item.uom_id);
      if (itemsWithoutUOM.length > 0) {
        message.error('UOM is required for all items — please select each item from the lookup');
        return;
      }
      setSubmitting(true);
      // BUG-ISS-120 — backend status enum is draft|submitted|approved|cancelled.
      // Never send pending_approval (which 422'd silently). Always create as
      // draft, then call /submit endpoint so the backend can run its
      // validation + ledger posting.
      const payload = {
        ...values,
        consumption_date: formatDateForAPI(values.consumption_date),
        source: 'web',
        items: validItems.map((item) => ({
          item_id: item.item_id,
          batch_id: item.batch_id || null,
          qty: item.qty,
          uom_id: item.uom_id,
          rate: item.rate || 0,
          remarks: item.remarks || '',
        })),
      };
      let entryId;
      if (editingRecord) {
        await api.put(`/consumption/entries/${editingRecord.id}`, payload);
        entryId = editingRecord.id;
        message.success('Consumption entry updated');
      } else {
        const createRes = await api.post('/consumption/entries', payload);
        entryId = createRes.data?.id;
        message.success('Consumption entry saved as draft');
      }
      if (submitNow && entryId) {
        try {
          await api.post(`/consumption/entries/${entryId}/submit`);
          message.success('Consumption submitted');
        } catch (e) {
          message.error(getErrorMessage(e));
        }
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingRecord(null);
      setConsumptionItems([]);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAction = async (id, action) => {
    try {
      await api.post(`/consumption/entries/${id}/${action}`);
      const labels = { submit: 'submitted', approve: 'approved', cancel: 'cancelled' };
      message.success(`Consumption entry ${labels[action] || action}`);
      setRefreshKey((k) => k + 1);
      if (detailRecord && detailRecord.id === id) {
        const res = await api.get(`/consumption/entries/${id}`);
        setDetailRecord(res.data);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleView = async (record) => {
    setDetailLoading(true);
    setDetailRecord(null);
    try {
      const res = await api.get(`/consumption/entries/${record.id}`);
      setDetailRecord(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  };

  // Fetch batches for an item
  const fetchBatches = async (itemId, key) => {
    try {
      const warehouseId = form.getFieldValue('warehouse_id');
      const params = { item_id: itemId, page_size: 100 };
      if (warehouseId) params.warehouse_id = warehouseId;
      const res = await api.get('/inventory/batches', { params });
      const batches = res.data.items || res.data.data || res.data || [];
      // Bug fix BUG_0091: surface empty result instead of silent fail; show
      // expiry + qty in label so user picks the right batch.
      if (batches.length === 0) {
        message.warning('No batches with stock found for this item' + (warehouseId ? ' in selected warehouse.' : '. Pick a warehouse first.'));
      }
      setConsumptionItems((prev) =>
        prev.map((item) =>
          item.key === key ? {
            ...item,
            available_batches: batches.map((b) => ({
              label: `${b.batch_number}  •  Avail: ${b.available_qty || 0}${b.expiry_date ? '  •  Exp: ' + b.expiry_date : ''}${b.is_expired ? '  ⚠ EXPIRED' : ''}`,
              value: b.id,
              disabled: b.is_expired,
            })),
          } : item
        )
      );
    } catch (e) {
      message.error('Failed to load batches: ' + (e?.response?.data?.detail || e?.message || ''));
    }
  };

  // Items management
  const addItemRow = () => {
    setConsumptionItems((prev) => [
      ...prev,
      { key: Date.now(), item_id: null, item_name: '', batch_id: null, qty: 1, uom: '', rate: 0, remarks: '', available_batches: [] },
    ]);
  };

  const removeItemRow = (key) => {
    setConsumptionItems((prev) => prev.filter((item) => item.key !== key));
  };

  const updateItemRow = (key, field, value) => {
    setConsumptionItems((prev) =>
      prev.map((item) => (item.key === key ? { ...item, [field]: value } : item))
    );
  };

  const drawerItemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item',
      dataIndex: 'item_id',
      width: 250,
      render: (val, record) => (
        <ItemSelector
          value={val}
          onChange={(itemId, item) => {
            updateItemRow(record.key, 'item_id', itemId);
            if (item) {
              updateItemRow(record.key, 'item_name', item.item_name || item.name || '');
              updateItemRow(record.key, 'uom', item.uom || item.primary_uom_name || item.default_uom || '');
              updateItemRow(record.key, 'uom_id', item.primary_uom_id || item.uom_id || null);
              updateItemRow(record.key, 'rate', item.rate || item.last_purchase_rate || 0);
              fetchBatches(itemId, record.key);
            }
          }}
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Batch',
      dataIndex: 'batch_id',
      width: 180,
      render: (val, record) => (
        <Select
          value={val}
          onChange={(v) => updateItemRow(record.key, 'batch_id', v)}
          options={record.available_batches || []}
          placeholder="Select batch"
          allowClear
          showSearch
          optionFilterProp="label"
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
      dataIndex: 'uom',
      width: 80,
      render: (val, record) => (
        <Input value={val} onChange={(e) => updateItemRow(record.key, 'uom', e.target.value)} placeholder="UOM" />
      ),
    },
    {
      title: 'Remarks',
      dataIndex: 'remarks',
      width: 150,
      render: (val, record) => (
        <Input value={val} onChange={(e) => updateItemRow(record.key, 'remarks', e.target.value)} placeholder="Remarks" />
      ),
    },
    {
      title: '',
      width: 40,
      render: (_, record) =>
        consumptionItems.length > 1 ? (
          <Tooltip title="Remove">
            <MinusCircleOutlined style={{ color: '#ff4d4f', cursor: 'pointer', fontSize: 16 }} onClick={() => removeItemRow(record.key)} />
          </Tooltip>
        ) : null,
    },
  ];

  const columns = [
    {
      title: 'Entry #',
      dataIndex: 'entry_number',
      key: 'entry_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => handleView(record)}>{text}</a>,
    },
    { title: 'Date', dataIndex: 'consumption_date', key: 'date', width: 120, sorter: true, render: (v) => formatDate(v) },
    { title: 'Project', dataIndex: 'project_name', key: 'project', width: 150, render: (v, r) => v || r.project || '-' },
    { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 150, render: (v, r) => v || r.warehouse || '-' },
    { title: 'Department', dataIndex: 'department_name', key: 'department', width: 140, render: (v, r) => v || r.department || '-' },
    { title: 'Consumed By', dataIndex: 'consumed_by_name', key: 'consumed_by', width: 140, render: (v, r) => v || r.consumed_by || '-' },
    {
      title: 'Source',
      dataIndex: 'source',
      key: 'source',
      width: 100,
      render: (v) => <Tag color={v === 'web' ? 'blue' : 'green'}>{SOURCE_LABELS[v] || v || '-'}</Tag>,
    },
    { title: 'Status', dataIndex: 'status', key: 'status', width: 140, render: (s) => <StatusTag status={s} /> },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(record)} />
          {record.status === 'draft' && (
            <>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
              <Tooltip title="Submit">
                <Button type="link" size="small" icon={<SendOutlined />} onClick={() => handleAction(record.id, 'submit')} />
              </Tooltip>
            </>
          )}
          {record.status === 'pending_approval' && (
            <Tooltip title="Approve">
              <Popconfirm title="Approve this entry?" onConfirm={() => handleAction(record.id, 'approve')}>
                <Button type="link" size="small" icon={<CheckCircleOutlined />} style={{ color: '#52c41a' }} />
              </Popconfirm>
            </Tooltip>
          )}
          {['draft', 'pending_approval'].includes(record.status) && (
            <Popconfirm title="Cancel this entry?" onConfirm={() => handleAction(record.id, 'cancel')} okButtonProps={{ danger: true }}>
              <Button type="link" size="small" danger icon={<CloseCircleOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <RangePicker
        format={DATE_FORMAT}
        value={filterDateRange}
        onChange={(v) => { setFilterDateRange(v); setRefreshKey((k) => k + 1); }}
        style={{ width: 240 }}
        allowClear
      />
      <Select
        placeholder="Project"
        allowClear
        style={{ width: 140 }}
        value={filterProject}
        onChange={(v) => { setFilterProject(v); setRefreshKey((k) => k + 1); }}
        options={projects}
        showSearch
        optionFilterProp="label"
        onFocus={loadLookups}
      />
      <Select
        placeholder="Department"
        allowClear
        style={{ width: 140 }}
        value={filterDepartment}
        onChange={(v) => { setFilterDepartment(v); setRefreshKey((k) => k + 1); }}
        options={departments}
        showSearch
        optionFilterProp="label"
        onFocus={loadLookups}
      />
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 150 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Draft', value: 'draft' },
          { label: 'Pending Approval', value: 'pending_approval' },
          { label: 'Approved', value: 'approved' },
          { label: 'Cancelled', value: 'cancelled' },
        ]}
      />
    </Space>
  );

  // DETAIL VIEW
  if (detailLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (detailRecord) {
    const detailItems = detailRecord.items || [];
    const totalAmount = detailItems.reduce((sum, i) => sum + (i.amount || (i.qty || 0) * (i.rate || 0)), 0);

    return (
      <div>
        <PageHeader title={detailRecord.entry_number} subtitle="Consumption Entry Detail">
          <Space>
            {detailRecord.status === 'draft' && (
              <>
                <Button type="primary" icon={<SendOutlined />} onClick={() => handleAction(detailRecord.id, 'submit')}>Submit</Button>
                <Button icon={<EditOutlined />} onClick={() => { handleEdit(detailRecord); setDetailRecord(null); }}>Edit</Button>
              </>
            )}
            {detailRecord.status === 'pending_approval' && (
              <Popconfirm title="Approve this entry?" onConfirm={() => handleAction(detailRecord.id, 'approve')}>
                <Button type="primary" icon={<CheckCircleOutlined />}>Approve</Button>
              </Popconfirm>
            )}
            {['draft', 'pending_approval'].includes(detailRecord.status) && (
              <Popconfirm title="Cancel this entry?" onConfirm={() => handleAction(detailRecord.id, 'cancel')} okButtonProps={{ danger: true }}>
                <Button danger icon={<CloseCircleOutlined />}>Cancel</Button>
              </Popconfirm>
            )}
            <Button icon={<ArrowLeftOutlined />} onClick={() => setDetailRecord(null)}>Back to List</Button>
          </Space>
        </PageHeader>

        <Card>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="Entry #">{detailRecord.entry_number}</Descriptions.Item>
            <Descriptions.Item label="Date">{formatDate(detailRecord.consumption_date)}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={detailRecord.status} /></Descriptions.Item>
            <Descriptions.Item label="Project">{detailRecord.project_name || detailRecord.project || '-'}</Descriptions.Item>
            <Descriptions.Item label="Warehouse">{detailRecord.warehouse_name || detailRecord.warehouse || '-'}</Descriptions.Item>
            <Descriptions.Item label="Department">{detailRecord.department_name || detailRecord.department || '-'}</Descriptions.Item>
            <Descriptions.Item label="Cost Center">{detailRecord.cost_center_name || detailRecord.cost_center || '-'}</Descriptions.Item>
            <Descriptions.Item label="Consumed By">{detailRecord.consumed_by_name || detailRecord.consumed_by || '-'}</Descriptions.Item>
            <Descriptions.Item label="Source"><Tag color={detailRecord.source === 'web' ? 'blue' : 'green'}>{SOURCE_LABELS[detailRecord.source] || detailRecord.source || '-'}</Tag></Descriptions.Item>
            <Descriptions.Item label="Remarks" span={3}>{detailRecord.remarks || '-'}</Descriptions.Item>
          </Descriptions>

          <Divider orientation="left">Items</Divider>
          <Table
            dataSource={detailItems}
            rowKey={(r) => r.id || r.item_id}
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
            summary={() => (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={5}><Text strong>Total</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={5} align="right"><Text strong>{formatNumber(detailItems.reduce((s, i) => s + (i.qty || 0), 0))}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={6} />
                <Table.Summary.Cell index={7} />
                <Table.Summary.Cell index={8} align="right"><Text strong>{formatCurrency(totalAmount)}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={9} />
              </Table.Summary.Row>
            )}
            columns={[
              { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
              { title: 'Item Code', dataIndex: 'item_code', key: 'code', width: 120, render: (v, r) => v || r.item?.item_code || '-' },
              { title: 'Item Name', dataIndex: 'item_name', key: 'name', width: 200, render: (v, r) => v || r.item?.item_name || '-' },
              { title: 'Batch', dataIndex: 'batch_number', key: 'batch', width: 130, render: (v, r) => v || r.batch?.batch_number || '-' },
              { title: 'UOM', dataIndex: 'uom', key: 'uom', width: 80, render: (v) => v || '-' },
              { title: 'Qty', dataIndex: 'qty', key: 'qty', width: 90, align: 'right', render: (v) => formatNumber(v) },
              { title: 'Rate', dataIndex: 'rate', key: 'rate', width: 100, align: 'right', render: (v) => formatCurrency(v) },
              { title: 'Amount', key: 'amount', width: 120, align: 'right', render: (_, r) => formatCurrency(r.amount || (r.qty || 0) * (r.rate || 0)) },
              { title: 'Remarks', dataIndex: 'remarks', key: 'rem', width: 160, ellipsis: true, render: (v) => v || '-' },
            ]}
          />
        </Card>
      </div>
    );
  }

  // LIST VIEW
  return (
    <div>
      <PageHeader title="Consumption Entry" subtitle="Daily consumption booking and management">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Book Consumption</Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchData}
        rowKey="id"
        searchPlaceholder="Search by entry number..."
        exportFileName="consumption_entries"
        toolbar={toolbar}
        scroll={{ x: 1600 }}
      />

      <Drawer
        title={editingRecord ? `Edit ${editingRecord.entry_number}` : 'Book Consumption'}
        width={960}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setEditingRecord(null); form.resetFields(); setConsumptionItems([]); }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); setEditingRecord(null); form.resetFields(); setConsumptionItems([]); }}>Cancel</Button>
            <Button onClick={() => handleSubmit(false)} loading={submitting}>Save as Draft</Button>
            <Button type="primary" icon={<SendOutlined />} onClick={() => handleSubmit(true)} loading={submitting}>Submit</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          {/* Hidden registration for auto-fill — see IndentForm.jsx. */}
          {warehouses.length <= 1 && (
            <Form.Item name="warehouse_id" hidden><Input /></Form.Item>
          )}
          {projects.length <= 1 && (
            <Form.Item name="project_id" hidden><Input /></Form.Item>
          )}
          <Row gutter={16}>
            {projects.length > 1 && (
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="project_id" label="Project">
                  <Select options={projects} placeholder="Select project" allowClear showSearch optionFilterProp="label" />
                </Form.Item>
              </Col>
            )}
            {warehouses.length > 1 && (
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true, message: 'Required' }]}>
                  <Select options={warehouses} placeholder="Select warehouse" allowClear showSearch optionFilterProp="label" />
                </Form.Item>
              </Col>
            )}
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="consumption_date" label="Consumption Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="department_id" label="Department (optional)">
                <Select options={departments} placeholder="Select department" allowClear showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={24} md={16}>
              <Form.Item name="remarks" label="Remarks (optional)">
                <TextArea rows={2} placeholder="Any remarks..." />
              </Form.Item>
            </Col>
          </Row>
          <details style={{ marginBottom: 12 }}>
            <summary style={{ cursor: 'pointer', color: '#7A6D66', fontSize: 13 }}>
              More fields (cost center)
            </summary>
            <Row gutter={16} style={{ marginTop: 12 }}>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="cost_center_id" label="Cost Center">
                  <Select options={costCenters} placeholder="Select cost center" allowClear showSearch optionFilterProp="label" />
                </Form.Item>
              </Col>
            </Row>
          </details>
        </Form>

        <Divider orientation="left">Items</Divider>
        <Table
          dataSource={consumptionItems}
          columns={drawerItemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 900 }}
          footer={() => (
            <Button type="dashed" onClick={addItemRow} icon={<PlusOutlined />} block>Add Item</Button>
          )}
        />
      </Drawer>
    </div>
  );
};

export default ConsumptionEntry;

