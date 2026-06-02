import React, { useState, useEffect, useCallback } from 'react';
import {
  Button, Form, Input, InputNumber, Select, Space, DatePicker,
  message, Row, Col, Table, Card, Descriptions, Tabs, Divider,
  Typography, Tooltip, Tag, Empty, Spin, Popconfirm,
} from 'antd';
import {
  PlusOutlined, ArrowLeftOutlined, SendOutlined, EditOutlined,
  CloseCircleOutlined, MinusCircleOutlined, SaveOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useParams, useNavigate } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import {
  formatDate, formatCurrency, getErrorMessage, formatDateForAPI,
  handleFormValidationFailed,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';
import AttachmentUploader, { uploadStagedAttachments } from '../../components/AttachmentUploader';

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

const PRIORITY_COLORS = { low: 'blue', medium: 'gold', high: 'orange', critical: 'red' };

const MR_STATUS_FLOW = ['draft', 'pending_approval', 'approved', 'partially_ordered', 'ordered'];

const MaterialRequestForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [mr, setMr] = useState(null);
  const [editMode, setEditMode] = useState(isNew);

  // Items
  const [mrItems, setMrItems] = useState([
    { key: Date.now(), item_id: null, item_name: '', qty: 1, uom_id: null, uom: '', target_warehouse_id: null, remarks: '' },
  ]);

  // Bug fix BUG_0092: staged attachments (uploaded after MR is created)
  const [stagedAttachments, setStagedAttachments] = useState([]);

  // CR_15: Indent linking — MRs raised against an existing approved indent
  const [indents, setIndents] = useState([]);

  React.useEffect(() => {
    api.get('/indent/indents', { params: { page_size: 200, status: 'approved' } })
      .then((r) => {
        const items = r.data?.data || r.data?.items || [];
        setIndents(items.map((i) => ({
          label: `${i.indent_number} - ${i.department || ''} - ${i.project_name || ''}`,
          value: i.id,
        })));
      })
      .catch(() => setIndents([]));
  }, []);

  // Lookups
  const [departments, setDepartments] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [projects, setProjects] = useState([]);
  const [uoms, setUoms] = useState([]);

  // Linked POs
  const [linkedPOs, setLinkedPOs] = useState([]);
  const [posLoading, setPosLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('items');

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
    } catch (error) {
      console.error('Failed to load form lookups:', error);
      message.error('Failed to load form data. Please refresh the page.');
    }
  }, []);

  useEffect(() => {
    loadLookups();
    if (!isNew) {
      fetchMR();
    } else {
      form.setFieldsValue({
        request_type: 'purchase',
        priority: 'medium',
        required_date: dayjs().add(7, 'day'),
      });
    }
  }, [id]);

  const fetchMR = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/procurement/material-requests/${id}`);
      const data = res.data;
      setMr(data);
      form.setFieldsValue({
        ...data,
        required_date: data.required_date ? dayjs(data.required_date) : null,
      });
      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_name: item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.item_name || item.item.name}` : ''),
        qty: item.qty || item.quantity || 0,
        uom_id: item.uom_id || null,
        uom: item.uom || item.unit || '',
        target_warehouse_id: item.target_warehouse_id,
        remarks: item.remarks || '',
      }));
      setMrItems(items.length > 0 ? items : [{ key: Date.now(), item_id: null, item_name: '', qty: 1, uom_id: null, uom: '', target_warehouse_id: null, remarks: '' }]);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 404) {
        message.error('Material request not found');
        navigate('/procurement/material-requests');
      } else {
        message.error(getErrorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  };

  const fetchLinkedPOs = async () => {
    if (!id) return;
    setPosLoading(true);
    try {
      const res = await api.get(`/procurement/material-requests/${id}/purchase-orders`, { params: { page_size: 100 } });
      setLinkedPOs(res.data.items || res.data.data || res.data || []);
    } catch (error) {
      console.error('Failed to load linked POs:', error);
      message.error('Failed to load linked purchase orders');
    } finally {
      setPosLoading(false);
    }
  };

  const handleSubmit = async (submitForApproval = false) => {
    try {
      const values = await form.validateFields();
      const validItems = mrItems.filter((item) => item.item_id);
      if (validItems.length === 0) {
        message.error('Please add at least one item');
        const tbl = document.querySelector('.ant-table');
        if (tbl) {
          tbl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          tbl.style.border = '1.5px dashed #FF4D4F';
          tbl.style.backgroundColor = '#FFF2F0';
          setTimeout(() => {
            tbl.style.border = '';
            tbl.style.backgroundColor = '';
          }, 3000);
        }
        return;
      }
      // Validate each item has required fields
      for (const item of validItems) {
        if (!item.qty || item.qty <= 0) {
          message.error('Each item must have a quantity greater than 0');
          const rowInputs = document.querySelectorAll('.ant-input-number');
          rowInputs.forEach((inp) => {
            const val = parseFloat(inp.querySelector('input')?.value || '0');
            if (val <= 0 || isNaN(val)) {
              inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
              inp.style.border = '1.5px solid #FF4D4F';
              inp.style.backgroundColor = '#FFF2F0';
              setTimeout(() => {
                inp.style.border = '';
                inp.style.backgroundColor = '';
              }, 3000);
            }
          });
          return;
        }
      }
      setSubmitting(true);

      const payload = {
        request_type: values.request_type,
        project_id: values.project_id ? parseInt(values.project_id, 10) : null,
        warehouse_id: values.warehouse_id ? parseInt(values.warehouse_id, 10) : null,
        department: values.department || null,
        priority: values.priority,
        remarks: values.remarks || null,
        request_date: formatDateForAPI(new Date()),
        required_date: formatDateForAPI(values.required_date),
        // CR_15: link MR to a parent indent
        indent_id: values.indent_id ? parseInt(values.indent_id, 10) : null,
        items: validItems.map((item) => ({
          item_id: parseInt(item.item_id, 10),
          qty: item.qty,
          uom_id: item.uom_id ? parseInt(item.uom_id, 10) : null,
          target_warehouse_id: item.target_warehouse_id ? parseInt(item.target_warehouse_id, 10) : null,
          remarks: item.remarks || '',
        })),
      };

      if (isNew) {
        const res = await api.post('/procurement/material-requests', payload);
        const newId = res.data.id || res.data.data?.id;
        // Wave 11.1 BUG_0092 fix: upload staged attachments now that we have an id
        if (newId && stagedAttachments.length > 0) {
          await uploadStagedAttachments('material_request', newId, stagedAttachments);
        }
        message.success(submitForApproval ? 'Material Request created and submitted' : 'Material Request created');
        navigate(`/procurement/material-requests/${newId}`);
      } else {
        await api.put(`/procurement/material-requests/${id}`, payload);
        if (stagedAttachments.length > 0) {
          await uploadStagedAttachments('material_request', id, stagedAttachments);
          setStagedAttachments([]);
        }
        message.success(submitForApproval ? 'Material Request updated and submitted' : 'Material Request updated');
        setEditMode(false);
        fetchMR();
      }
    } catch (err) {
      if (err.errorFields) {
        handleFormValidationFailed(err);
        return;
      }
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    try {
      await api.post(`/procurement/material-requests/${id}/cancel`);
      message.success('Material Request cancelled');
      fetchMR();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSubmitForApproval = async () => {
    try {
      await api.post(`/procurement/material-requests/${id}/submit`);
      message.success('Material Request submitted for approval');
      fetchMR();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // Item row management
  const addItemRow = () => {
    setMrItems((prev) => [
      ...prev,
      { key: Date.now(), item_id: null, item_name: '', qty: 1, uom_id: null, uom: '', target_warehouse_id: null, remarks: '' },
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

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}><Spin size="large" /></div>;
  }

  // If not new and no data loaded, show error state with retry
  if (!isNew && !mr && !editMode) {
    return (
      <div>
        <PageHeader title="Material Request">
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/procurement/material-requests')}>Back</Button>
        </PageHeader>
        <Card>
          <Empty description="Could not load material request. Please try again.">
            <Button type="primary" onClick={fetchMR}>Retry</Button>
          </Empty>
        </Card>
      </div>
    );
  }

  // Detail / View mode for existing MR
  if (!isNew && mr && !editMode) {
    const mrItemsList = mr.items || [];
    const statusIdx = MR_STATUS_FLOW.indexOf(mr.status);

    return (
      <div>
        <PageHeader title={mr.mr_number} subtitle="Material Request Detail">
          <Space>
            {mr.status === 'draft' && (
              <>
                <Button icon={<EditOutlined />} onClick={() => setEditMode(true)}>Edit</Button>
                <Button type="primary" icon={<SendOutlined />} onClick={handleSubmitForApproval}>Submit for Approval</Button>
              </>
            )}
            {['draft', 'pending_approval'].includes(mr.status) && (
              <Popconfirm title="Cancel this MR?" onConfirm={handleCancel} okButtonProps={{ danger: true }}>
                <Button danger icon={<CloseCircleOutlined />}>Cancel</Button>
              </Popconfirm>
            )}
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/procurement/material-requests')}>Back</Button>
          </Space>
        </PageHeader>

        {/* Status Flow */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {MR_STATUS_FLOW.map((s, idx) => {
              const isCurrent = s === mr.status;
              const isPast = idx < statusIdx;
              return (
                <Tag key={s} color={mr.status === 'cancelled' ? 'default' : isCurrent ? 'blue' : isPast ? 'green' : 'default'}
                  style={{ padding: '4px 12px', fontSize: 13 }}>
                  {s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </Tag>
              );
            })}
            {mr.status === 'cancelled' && <Tag color="red" style={{ padding: '4px 12px', fontSize: 13 }}>Cancelled</Tag>}
          </div>
        </Card>

        <Card>
          <Tabs activeKey={activeTab} onChange={(tab) => { setActiveTab(tab); if (tab === 'linked_pos') fetchLinkedPOs(); }} items={[
            {
              key: 'items', label: 'MR Info & Items',
              children: (
                <>
                  <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
                    <Descriptions.Item label="MR Number">{mr.mr_number}</Descriptions.Item>
                    <Descriptions.Item label="Request Date">{formatDate(mr.request_date)}</Descriptions.Item>
                    <Descriptions.Item label="Type">{REQUEST_TYPES.find((t) => t.value === mr.request_type)?.label || mr.request_type}</Descriptions.Item>
                    <Descriptions.Item label="Department">{mr.department_name || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Project">{mr.project_name || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Warehouse">{mr.warehouse_name || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Requested By">{mr.requested_by_name || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Required Date">{formatDate(mr.required_date)}</Descriptions.Item>
                    <Descriptions.Item label="Priority"><Tag color={PRIORITY_COLORS[mr.priority]}>{(mr.priority || '').charAt(0).toUpperCase() + (mr.priority || '').slice(1)}</Tag></Descriptions.Item>
                    <Descriptions.Item label="Status"><StatusTag status={mr.status} /></Descriptions.Item>
                    <Descriptions.Item label="Approved By">{mr.approved_by_name || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Remarks" span={3}>{mr.remarks || '-'}</Descriptions.Item>
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
                      { title: 'Item Code', width: 120, render: (_, r) => r.item_code || (r.item && r.item.item_code) || '-' },
                      { title: 'Item Name', width: 220, render: (_, r) => r.item_name || (r.item && (r.item.item_name || r.item.name)) || '-' },
                      { title: 'Qty', dataIndex: 'qty', width: 80, align: 'right', render: (v, r) => v || r.quantity || 0 },
                      { title: 'UOM', dataIndex: 'uom', width: 80, render: (v, r) => v || r.unit || '-' },
                      { title: 'Target Warehouse', dataIndex: 'target_warehouse_name', width: 160, render: (v) => v || '-' },
                      { title: 'Ordered Qty', dataIndex: 'ordered_qty', width: 100, align: 'right', render: (v) => v || 0 },
                      { title: 'Remarks', dataIndex: 'remarks', width: 160, ellipsis: true, render: (v) => v || '-' },
                    ]}
                  />
                </>
              ),
            },
            {
              key: 'linked_pos', label: 'Linked POs',
              children: (
                <Table
                  dataSource={linkedPOs}
                  loading={posLoading}
                  rowKey="id"
                  size="small"
                  pagination={{ pageSize: 20 }}
                  scroll={{ x: 'max-content' }}
                  locale={{ emptyText: <Empty description="No linked purchase orders" /> }}
                  columns={[
                    { title: 'PO Number', dataIndex: 'po_number', width: 140, render: (t, r) => <a onClick={() => navigate(`/procurement/purchase-orders/${r.id}`)}>{t}</a> },
                    { title: 'Vendor', dataIndex: 'vendor_name', width: 180, render: (v) => v || '-' },
                    { title: 'PO Date', dataIndex: 'po_date', width: 120, render: (v) => formatDate(v) },
                    { title: 'Total', dataIndex: 'grand_total', width: 120, align: 'right', render: (v) => formatCurrency(v) },
                    { title: 'Status', dataIndex: 'status', width: 130, render: (s) => <StatusTag status={s} /> },
                  ]}
                />
              ),
            },
          ]} />
        </Card>
      </div>
    );
  }

  // Edit / Create mode
  const itemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item', dataIndex: 'item_id', width: 280,
      render: (val, record) => (
        <ItemSelector
          value={val}
          onChange={(itemId, item) => {
            updateItemRow(record.key, 'item_id', itemId);
            if (item) {
              updateItemRow(record.key, 'item_name', item.item_name || item.name || '');
              updateItemRow(record.key, 'uom_id', item.primary_uom_id || null);
              updateItemRow(record.key, 'uom', item.primary_uom?.name || item.primary_uom_name || '');
            }
          }}
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Qty', dataIndex: 'qty', width: 100,
      render: (val, record) => <InputNumber min={0.01} value={val} onChange={(v) => updateItemRow(record.key, 'qty', v)} style={{ width: '100%' }} />,
    },
    {
      title: 'UOM', dataIndex: 'uom_id', width: 140,
      render: (val, record) => (
        <Select
          value={val}
          onChange={(v) => updateItemRow(record.key, 'uom_id', v)}
          options={uoms}
          placeholder="Select UOM"
          showSearch
          optionFilterProp="label"
          allowClear
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Target Warehouse', dataIndex: 'target_warehouse_id', width: 180,
      render: (val, record) => (
        <Select value={val} onChange={(v) => updateItemRow(record.key, 'target_warehouse_id', v)} options={warehouses}
          placeholder="Select" allowClear showSearch optionFilterProp="label" style={{ width: '100%' }} />
      ),
    },
    {
      title: 'Remarks', dataIndex: 'remarks', width: 160,
      render: (val, record) => <Input value={val} onChange={(e) => updateItemRow(record.key, 'remarks', e.target.value)} placeholder="Remarks" />,
    },
    {
      title: '', width: 40,
      render: (_, record) => mrItems.length > 1 ? (
        <Tooltip title="Remove"><MinusCircleOutlined style={{ color: '#ff4d4f', cursor: 'pointer', fontSize: 16 }} onClick={() => removeItemRow(record.key)} /></Tooltip>
      ) : null,
    },
  ];

  return (
    <div>
      <PageHeader title={isNew ? 'Create Material Request' : `Edit ${mr?.mr_number || ''}`} subtitle={isNew ? 'Create a new material request' : 'Edit material request'}>
        <Space>
          <Button onClick={() => navigate('/procurement/material-requests')} icon={<ArrowLeftOutlined />}>Back</Button>
          {!isNew && <Button onClick={() => setEditMode(false)}>Cancel Edit</Button>}
        </Space>
      </PageHeader>

      <Card>
        <Form form={form} layout="vertical" scrollToFirstError={true}>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="request_type" label="Request Type" rules={[{ required: true, message: 'Please select a valid Request Type' }]}>
                <Select options={REQUEST_TYPES} placeholder="Select type" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="project_id" label="Project">
                <Select options={projects} placeholder="Select project" allowClear showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="warehouse_id" label="Warehouse">
                <Select options={warehouses} placeholder="Select warehouse" allowClear showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="department" label="Department">
                <Select options={departments} placeholder="Select department" allowClear showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="required_date"
                label="Required Date"
                rules={[
                  { required: true, message: 'Required Date is mandatory' },
                  {
                    validator: (_, value) => {
                      if (value && value.isBefore(dayjs(), 'day')) {
                        return Promise.reject(new Error('Required Date must be a future date'));
                      }
                      return Promise.resolve();
                    }
                  }
                ]}
              >
                <DatePicker 
                  style={{ width: '100%' }} 
                  format={DATE_FORMAT} 
                  disabledDate={(current) => current && current.isBefore(dayjs(), 'day')}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="priority" label="Priority" rules={[{ required: true, message: 'Please specify the request priority level' }]}>
                <Select options={PRIORITIES} placeholder="Select priority" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item name="indent_id" label="Source Indent (optional — link to a parent approved indent)">
                <Select
                  options={indents}
                  placeholder="Pick an approved indent that this MR fulfills…"
                  allowClear
                  showSearch
                  optionFilterProp="label"
                />
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
            <Button type="dashed" onClick={addItemRow} icon={<PlusOutlined />} block>Add Item</Button>
          )}
        />

        {/* Wave 11.1 BUG_0092 — supporting documents (quotation, sample images, vendor brochure, etc.) */}
        <Divider orientation="left">Supporting Documents</Divider>
        <AttachmentUploader
          entityType="material_request"
          entityId={isNew ? null : id}
          staged={stagedAttachments}
          setStaged={setStagedAttachments}
          label="Supporting Document"
        />

        <Divider />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={() => navigate('/procurement/material-requests')}>Cancel</Button>
          <Button icon={<SaveOutlined />} onClick={() => handleSubmit(false)} loading={submitting}>Save as Draft</Button>
          <Button type="primary" icon={<SendOutlined />} onClick={() => handleSubmit(true)} loading={submitting}>Submit for Approval</Button>
        </div>
      </Card>
    </div>
  );
};

export default MaterialRequestForm;
