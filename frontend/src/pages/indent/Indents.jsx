import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Tabs,
  Divider, Typography, Tooltip, Tag, Spin, Empty, Progress, Modal,
  Upload, Steps, Timeline,
} from 'antd';
import {
  PlusOutlined, EditOutlined, EyeOutlined, ArrowLeftOutlined,
  SendOutlined, CloseCircleOutlined, CheckCircleOutlined,
  MinusCircleOutlined, StopOutlined, PaperClipOutlined,
  FileTextOutlined, ShoppingCartOutlined, InboxOutlined,
  CarOutlined, AuditOutlined, ExportOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import useAuthStore from '../../store/authStore';
import {
  formatDate, formatNumber, getErrorMessage, formatDateForAPI,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

// Auto Reorder is not user-selectable — backend creates those automatically
// from reorder level rules. Users only pick Regular or Urgent.
const INDENT_TYPES_SELECTABLE = [
  { label: 'Regular', value: 'regular' },
  { label: 'Urgent', value: 'urgent' },
];
const INDENT_TYPES = [
  ...INDENT_TYPES_SELECTABLE,
  { label: 'Auto Reorder', value: 'auto_reorder' },
];

const INDENT_TYPE_COLORS = {
  regular: 'blue',
  urgent: 'red',
  auto_reorder: 'purple',
};

const STATUS_FLOW = ['draft', 'pending_approval', 'approved', 'partially_fulfilled', 'fulfilled'];

const Indents = () => {
  const { user: currentUser, hasPermission } = useAuthStore();
  // "Raise Material Request" from an approved indent is the warehouse-side
  // hand-off to procurement when stock isn't available. Backend allows
  // warehouse_manager / purchase_manager / store_keeper / field_supervisor /
  // project_manager / admin (APPROVER_ROLES). Field_staff who can also create
  // procurement docs would 403 anyway. Gate on indent.approve since that's
  // the smallest perm set those roles share.
  const canRaiseMR = hasPermission('indent', 'approve')
    || hasPermission('procurement', 'create');
  const navigate = useNavigate();
  // Roles allowed to issue materials against an approved indent. Anyone in
  // this list sees the "Issue Materials" shortcut on approved rows so they
  // can skip the Warehouse → Material Issues hunt.
  const _activeRoleCode =
    currentUser?.role ||
    (Array.isArray(currentUser?.roles) ? currentUser.roles[0]?.code : null) ||
    currentUser?.user_type;
  const canIssue = [
    'super_admin', 'admin',
    'warehouse_manager', 'warehouse_operator', 'store_keeper',
  ].includes(_activeRoleCode);
  // Approve button visibility — only show when backend explicitly says
  // can_approve_now is TRUE, AND the current user is not the indent's
  // raiser. Defaulting to "show unless backend says no" (the old
  // !== false logic) leaks the button to field users on indents that
  // don't have a workflow_meta row yet.
  const canApprove = (record) =>
    record?.status === 'pending_approval' &&
    record?.can_approve_now === true &&
    record?.raised_by !== currentUser?.id;
  const isRaiser = (record) => record?.raised_by === currentUser?.id;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterType, setFilterType] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);
  const [filterProject, setFilterProject] = useState(undefined);

  const [detailRecord, setDetailRecord] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState('info');

  const [indentItems, setIndentItems] = useState([]);

  // Attachments for the drawer. Required at Submit per MoM 2026-04-19 §6.
  // pendingFiles = staged in drawer; existingDrawerAttachments = already on
  // server when editing a draft; detailAttachments = what we show in the
  // read-only detail view.
  const [pendingFiles, setPendingFiles] = useState([]);
  const [existingDrawerAttachments, setExistingDrawerAttachments] = useState([]);
  const [detailAttachments, setDetailAttachments] = useState([]);

  const [departments, setDepartments] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [projects, setProjects] = useState([]);
  const [uoms, setUoms] = useState([]);

  // Approve modal
  const [approveModalOpen, setApproveModalOpen] = useState(false);
  const [approveItems, setApproveItems] = useState([]);
  const [approving, setApproving] = useState(false);

  // Acknowledgement modal
  const [ackModalOpen, setAckModalOpen] = useState(false);
  const [ackItems, setAckItems] = useState([]);
  const [ackSubmitting, setAckSubmitting] = useState(false);
  const [ackHistory, setAckHistory] = useState([]);
  const [ackHistoryLoading, setAckHistoryLoading] = useState(false);

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
      if (uomRes.status === 'fulfilled') {
        const u = uomRes.value.data;
        const items = u.items || u.data || u || [];
        setUoms(items.map((i) => ({ label: `${i.name} (${i.abbreviation || ''})`, value: i.id })));
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
    } catch { /* silent */ }
  }, [form]);

  // Preload lookups on mount
  useEffect(() => {
    loadLookups();
  }, []);

  const fetchData = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterType) qp.indent_type = filterType;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      if (filterProject) qp.project_id = filterProject;
      return await api.get('/indent/indents', { params: qp });
    },
    [filterStatus, filterType, filterWarehouse, filterProject]
  );

  const handleAdd = () => {
    setEditingRecord(null);
    form.resetFields();
    form.setFieldsValue({
      indent_type: 'regular',
      required_date: dayjs().add(5, 'day'),
    });
    setIndentItems([{ key: Date.now(), item_id: null, item_name: '', requested_qty: 1, uom_id: null, uom: '', remarks: '' }]);
    setPendingFiles([]);
    setExistingDrawerAttachments([]);
    loadLookups();
    setDrawerOpen(true);
  };

  const handleEdit = async (record) => {
    setEditingRecord(record);
    loadLookups();
    try {
      const res = await api.get(`/indent/indents/${record.id}`);
      const data = res.data;
      form.setFieldsValue({
        ...data,
        required_date: data.required_date ? dayjs(data.required_date) : null,
      });
      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_name: item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.item_name || item.item.name}` : ''),
        requested_qty: item.requested_qty || item.qty,
        uom: item.uom || item.unit,
        remarks: item.remarks || '',
      }));
      setIndentItems(items.length > 0 ? items : [{ key: Date.now(), item_id: null, item_name: '', requested_qty: 1, uom_id: null, uom: '', remarks: '' }]);
      setPendingFiles([]);
      try {
        const attRes = await api.get('/attachments', {
          params: { entity_type: 'indent', entity_id: record.id },
        });
        const rows = Array.isArray(attRes.data)
          ? attRes.data
          : (attRes.data?.results || attRes.data?.items || []);
        setExistingDrawerAttachments(rows);
      } catch {
        setExistingDrawerAttachments([]);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
      return;
    }
    setDrawerOpen(true);
  };

  const uploadPendingFiles = async (indentId) => {
    for (const fileWrapper of pendingFiles) {
      const file = fileWrapper.originFileObj || fileWrapper;
      const fd = new FormData();
      fd.append('file', file);
      fd.append('entity_type', 'indent');
      fd.append('entity_id', String(indentId));
      await api.post('/attachments/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
    }
  };

  const fetchDetailAttachments = async (indentId) => {
    try {
      const attRes = await api.get('/attachments', {
        params: { entity_type: 'indent', entity_id: indentId },
      });
      const rows = Array.isArray(attRes.data)
        ? attRes.data
        : (attRes.data?.results || attRes.data?.items || []);
      setDetailAttachments(rows);
    } catch {
      setDetailAttachments([]);
    }
  };

  const handleSubmit = async (submitForApproval = false) => {
    try {
      const values = await form.validateFields();
      const validItems = indentItems.filter((item) => item.item_id);
      if (validItems.length === 0) {
        message.error('Please add at least one item');
        return;
      }
      setSubmitting(true);
      const payload = {
        ...values,
        required_date: formatDateForAPI(values.required_date),
        items: validItems.map((item) => ({
          item_id: item.item_id,
          requested_qty: item.requested_qty,
          uom_id: typeof item.uom_id === 'number' ? item.uom_id : (parseInt(item.uom_id, 10) || null),
          remarks: item.remarks || '',
        })),
      };
      if (!editingRecord) {
        payload.indent_date = formatDateForAPI(new Date());
      }
      let targetId = editingRecord?.id;
      if (editingRecord) {
        await api.put(`/indent/indents/${editingRecord.id}`, payload);
      } else {
        const res = await api.post('/indent/indents', payload);
        targetId = res.data?.id;
      }

      // Upload any staged attachments now that we have an indent id.
      if (pendingFiles.length > 0 && targetId) {
        try {
          await uploadPendingFiles(targetId);
        } catch (err) {
          message.error(`Attachment upload failed: ${getErrorMessage(err)}`);
          setDrawerOpen(false);
          form.resetFields();
          setEditingRecord(null);
          setIndentItems([]);
          setPendingFiles([]);
          setExistingDrawerAttachments([]);
          setRefreshKey((k) => k + 1);
          return;
        }
      }

      if (editingRecord) {
        if (submitForApproval && editingRecord.status === 'draft') {
          try {
            await api.post(`/indent/indents/${editingRecord.id}/submit`);
            message.success('Indent submitted for approval');
          } catch (submitErr) {
            message.warning('Indent saved but approval submission failed: ' + getErrorMessage(submitErr));
          }
        } else {
          message.success('Indent updated');
        }
      } else if (submitForApproval && targetId) {
        try {
          await api.post(`/indent/indents/${targetId}/submit`);
          message.success('Indent created and submitted for approval');
        } catch (submitErr) {
          message.warning('Indent created but approval submission failed: ' + getErrorMessage(submitErr));
        }
      } else {
        message.success('Indent created as draft');
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingRecord(null);
      setIndentItems([]);
      setPendingFiles([]);
      setExistingDrawerAttachments([]);
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
      await api.post(`/indent/indents/${id}/${action}`);
      const labels = { submit: 'submitted for approval', reject: 'rejected', cancel: 'cancelled' };
      message.success(`Indent ${labels[action] || action}`);
      setRefreshKey((k) => k + 1);
      if (detailRecord && detailRecord.id === id) {
        const res = await api.get(`/indent/indents/${id}`);
        setDetailRecord(res.data);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleView = async (record) => {
    setDetailLoading(true);
    setDetailRecord(null);
    setDetailAttachments([]);
    setAckHistory([]);
    setDetailTab('info');
    try {
      const res = await api.get(`/indent/indents/${record.id}`);
      setDetailRecord(res.data);
      fetchDetailAttachments(record.id);
      if (['approved', 'partially_fulfilled', 'fulfilled'].includes(res.data?.status)) {
        fetchAckHistory(record.id);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const openApproveModal = () => {
    if (!detailRecord) return;
    const items = (detailRecord.items || []).map((item) => ({
      ...item,
      approved_qty: item.approved_qty || item.requested_qty || item.qty,
    }));
    setApproveItems(items);
    setApproveModalOpen(true);
  };

  const handleApprove = async () => {
    setApproving(true);
    try {
      const payload = {
        items: approveItems.map((item) => ({
          id: item.id,
          item_id: item.item_id,
          approved_qty: item.approved_qty,
        })),
      };
      await api.post(`/indent/indents/${detailRecord.id}/approve`, payload);
      message.success('Indent approved');
      setApproveModalOpen(false);
      const res = await api.get(`/indent/indents/${detailRecord.id}`);
      setDetailRecord(res.data);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setApproving(false);
    }
  };

  const fetchAckHistory = async (indentId) => {
    setAckHistoryLoading(true);
    try {
      const res = await api.get(`/indent/indents/${indentId}/acknowledgements`);
      setAckHistory(Array.isArray(res.data) ? res.data : (res.data?.items || []));
    } catch {
      setAckHistory([]);
    } finally {
      setAckHistoryLoading(false);
    }
  };

  const openAckModal = () => {
    if (!detailRecord) return;
    const items = (detailRecord.items || []).map((item) => ({
      ...item,
      received_qty: item.issued_qty || item.approved_qty || item.requested_qty || 0,
    }));
    setAckItems(items);
    setAckModalOpen(true);
  };

  const handleAcknowledge = async () => {
    setAckSubmitting(true);
    try {
      const payload = {
        indent_id: detailRecord.id,
        items: ackItems.map((item) => ({
          indent_item_id: item.id,
          item_id: item.item_id,
          received_qty: item.received_qty || 0,
        })),
      };
      await api.post(`/indent/indents/${detailRecord.id}/acknowledge`, payload);
      message.success('Acknowledgement recorded successfully');
      setAckModalOpen(false);
      const res = await api.get(`/indent/indents/${detailRecord.id}`);
      setDetailRecord(res.data);
      fetchAckHistory(detailRecord.id);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setAckSubmitting(false);
    }
  };

  // Items table management
  const addItemRow = () => {
    setIndentItems((prev) => [
      ...prev,
      { key: Date.now(), item_id: null, item_name: '', requested_qty: 1, uom_id: null, uom: '', remarks: '' },
    ]);
  };

  const removeItemRow = (key) => {
    setIndentItems((prev) => prev.filter((item) => item.key !== key));
  };

  const updateItemRow = (key, field, value) => {
    setIndentItems((prev) =>
      prev.map((item) => (item.key === key ? { ...item, [field]: value } : item))
    );
  };

  const itemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
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
              updateItemRow(record.key, 'uom', item.primary_uom?.name || item.primary_uom_name || '');
            }
          }}
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Requested Qty',
      dataIndex: 'requested_qty',
      width: 120,
      render: (val, record) => (
        <InputNumber
          min={0.01}
          value={val}
          onChange={(v) => updateItemRow(record.key, 'requested_qty', v)}
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
      title: 'Remarks',
      dataIndex: 'remarks',
      width: 180,
      render: (val, record) => (
        <Input value={val} onChange={(e) => updateItemRow(record.key, 'remarks', e.target.value)} placeholder="Remarks" />
      ),
    },
    {
      title: '',
      width: 40,
      render: (_, record) =>
        indentItems.length > 1 ? (
          <Tooltip title="Remove">
            <MinusCircleOutlined style={{ color: '#ff4d4f', cursor: 'pointer', fontSize: 16 }} onClick={() => removeItemRow(record.key)} />
          </Tooltip>
        ) : null,
    },
  ];

  const columns = [
    {
      title: 'Indent #',
      dataIndex: 'indent_number',
      key: 'indent_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => handleView(record)}>{text}</a>,
    },
    { title: 'Project', dataIndex: 'project_name', key: 'project', width: 150, render: (v, r) => v || r.project || '-' },
    { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 150, render: (v, r) => v || r.warehouse || '-' },
    { title: 'Indent Date', dataIndex: 'indent_date', key: 'indent_date', width: 120, sorter: true, render: (v) => formatDate(v) },
    { title: 'Required Date', dataIndex: 'required_date', key: 'required_date', width: 120, sorter: true, render: (v) => formatDate(v) },
    { title: 'Department', dataIndex: 'department_name', key: 'department', width: 140, render: (v, r) => v || r.department || '-' },
    {
      title: 'Indent Type',
      dataIndex: 'indent_type',
      key: 'indent_type',
      width: 120,
      render: (v) => <StatusTag status={v} />,
    },
    { title: 'Raised By', dataIndex: 'raised_by_name', key: 'raised_by', width: 140, render: (v, r) => v || r.raised_by || '-' },
    { title: 'Status', dataIndex: 'status', key: 'status', width: 150, render: (s) => <StatusTag status={s} /> },
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
              <Tooltip title="Submit for Approval">
                <Button type="link" size="small" icon={<SendOutlined />} onClick={() => handleAction(record.id, 'submit')} />
              </Tooltip>
            </>
          )}
          {canApprove(record) && (
            <Tooltip title={
              record.current_workflow_level
                ? `Approve at level ${record.current_workflow_level}/${record.total_workflow_levels || ''}`
                : 'Approve'
            }>
              <Button type="link" size="small" icon={<CheckCircleOutlined />} style={{ color: '#52c41a' }} onClick={() => { handleView(record).then(() => openApproveModal()); }} />
            </Tooltip>
          )}
          {record.status === 'pending_approval' && !canApprove(record) && !isRaiser(record) && record.current_workflow_level && (
            <Tooltip title={`Awaiting level ${record.current_workflow_level} approver`}>
              <Button type="link" size="small" disabled icon={<CheckCircleOutlined />} />
            </Tooltip>
          )}
          {(
            (record.status === 'draft' && isRaiser(record)) ||
            (record.status === 'pending_approval' && canApprove(record))
          ) && (
            <Popconfirm title={record.status === 'draft' ? 'Cancel this draft?' : 'Reject this indent?'} onConfirm={() => handleAction(record.id, 'reject')} okButtonProps={{ danger: true }}>
              <Button type="link" size="small" danger icon={<StopOutlined />} />
            </Popconfirm>
          )}
          {canIssue &&
            ['approved', 'partially_fulfilled'].includes(record.status) && (
              <Tooltip title="Issue materials against this indent">
                <Button
                  type="link"
                  size="small"
                  icon={<ExportOutlined />}
                  style={{ color: '#481890' }}
                  onClick={() =>
                    navigate(
                      `/warehouse/material-issues?indent_id=${record.id}`,
                    )
                  }
                />
              </Tooltip>
            )}
        </Space>
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      {warehouses.length > 1 && (
        <Select
          placeholder="Warehouse"
          allowClear
          style={{ width: 150 }}
          value={filterWarehouse}
          onChange={(v) => { setFilterWarehouse(v); setRefreshKey((k) => k + 1); }}
          options={warehouses}
          showSearch
          filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
          onFocus={loadLookups}
        />
      )}
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
          { label: 'Partially Fulfilled', value: 'partially_fulfilled' },
          { label: 'Fulfilled', value: 'fulfilled' },
          { label: 'Rejected', value: 'rejected' },
          { label: 'Cancelled', value: 'cancelled' },
        ]}
      />
      <Select
        placeholder="Type"
        allowClear
        style={{ width: 130 }}
        value={filterType}
        onChange={(v) => { setFilterType(v); setRefreshKey((k) => k + 1); }}
        options={INDENT_TYPES}
      />
      {projects.length > 1 && (
        <Select
          placeholder="Project"
          allowClear
          style={{ width: 150 }}
          value={filterProject}
          onChange={(v) => { setFilterProject(v); setRefreshKey((k) => k + 1); }}
          options={projects}
          showSearch
          filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
          onFocus={loadLookups}
        />
      )}
    </Space>
  );

  // DETAIL VIEW
  if (detailLoading) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (detailRecord) {
    const detailItems = detailRecord.items || [];
    const statusIdx = STATUS_FLOW.indexOf(detailRecord.status);

    return (
      <div>
        <PageHeader title={detailRecord.indent_number} subtitle="Indent Detail">
          <Space>
            {detailRecord.status === 'draft' && (
              <>
                <Button type="primary" icon={<SendOutlined />} onClick={() => handleAction(detailRecord.id, 'submit')}>
                  Submit for Approval
                </Button>
                <Button icon={<EditOutlined />} onClick={() => { handleEdit(detailRecord); setDetailRecord(null); }}>Edit</Button>
              </>
            )}
            {canApprove(detailRecord) && (
              <>
                <Button type="primary" icon={<CheckCircleOutlined />} onClick={openApproveModal}>
                  {detailRecord.current_workflow_level
                    ? `Approve (Level ${detailRecord.current_workflow_level}/${detailRecord.total_workflow_levels || ''})`
                    : 'Approve'}
                </Button>
                <Popconfirm title="Reject this indent?" onConfirm={() => handleAction(detailRecord.id, 'reject')} okButtonProps={{ danger: true }}>
                  <Button danger icon={<StopOutlined />}>Reject</Button>
                </Popconfirm>
              </>
            )}
            {detailRecord.status === 'pending_approval' && !canApprove(detailRecord) && !isRaiser(detailRecord) && (
              <Tooltip title={
                detailRecord.current_workflow_level
                  ? `Awaiting level ${detailRecord.current_workflow_level} approver. You are not the approver at this level.`
                  : 'Awaiting approval. You are not the approver.'
              }>
                <Button type="primary" icon={<CheckCircleOutlined />} disabled>
                  Awaiting Level {detailRecord.current_workflow_level || ''} Approver
                </Button>
              </Tooltip>
            )}
            {detailRecord.status === 'approved' && canRaiseMR && (
              <Button
                type="primary"
                icon={<SendOutlined />}
                onClick={async () => {
                  try {
                    const res = await api.post(`/indent/indents/${detailRecord.id}/convert-to-mr`);
                    const data = res.data;
                    message.success(data.message || 'Material Request created from indent');
                  } catch (err) {
                    message.error(getErrorMessage(err));
                  }
                }}
              >
                Raise Material Request
              </Button>
            )}
            <Button icon={<ArrowLeftOutlined />} onClick={() => setDetailRecord(null)}>Back to List</Button>
          </Space>
        </PageHeader>

        <Card style={{ marginBottom: 16 }}>
          {/* BHSPL SCM Workflow Steps */}
          {(() => {
            const s = detailRecord.status;
            const isCancelled = s === 'cancelled';
            const isRejected = s === 'rejected';
            const hasMI = (detailRecord.material_issues || []).length > 0;
            const hasMR = (detailRecord.material_requests || []).length > 0;
            const isAcknowledged = detailRecord.is_acknowledged;

            // Determine current step index
            const stepOrder = ['draft', 'pending_approval', 'approved', 'in_progress', 'fulfilled', 'acknowledged'];
            let currentStep = 0;
            if (s === 'pending_approval') currentStep = 1;
            else if (s === 'approved') currentStep = 2;
            else if (s === 'partially_fulfilled') currentStep = 3;
            else if (s === 'fulfilled') currentStep = 4;
            if (isAcknowledged) currentStep = 5;
            if (isCancelled || isRejected) currentStep = -1;

            // Determine flow type description
            let flowLabel = 'Awaiting warehouse decision';
            if (hasMR && hasMI) flowLabel = 'Flow 2 (Procurement) → Flow 1 (Issue)';
            else if (hasMI) flowLabel = 'Flow 1: Direct from stock';
            else if (hasMR) flowLabel = 'Flow 2: Procurement in progress';

            return (
              <>
                {(isCancelled || isRejected) ? (
                  (() => {
                    const lastReject = (detailRecord.approval_history || [])
                      .filter((h) => h.action === 'rejected')
                      .slice(-1)[0];
                    return (
                      <div style={{
                        marginBottom: 12,
                        padding: '12px 16px',
                        background: isRejected ? '#fff2f0' : '#fffbe6',
                        border: `1px solid ${isRejected ? '#ffccc7' : '#ffe58f'}`,
                        borderRadius: 6,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: lastReject ? 8 : 0 }}>
                          <StatusTag status={s} style={{ fontSize: 14, padding: '4px 12px' }} />
                          <Text strong>This indent was {s}.</Text>
                        </div>
                        {lastReject && (
                          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                            <div><Text type="secondary">By:</Text> <Text strong>{lastReject.user_name || '—'}</Text>{lastReject.level ? <Text type="secondary"> (L{lastReject.level})</Text> : null}</div>
                            <div><Text type="secondary">When:</Text> {formatDate(lastReject.timestamp)}</div>
                            <div><Text type="secondary">Reason:</Text> {lastReject.remarks || <Text type="secondary">No remarks given</Text>}</div>
                          </div>
                        )}
                      </div>
                    );
                  })()
                ) : (
                  <Steps
                    current={currentStep}
                    size="small"
                    style={{ marginBottom: 8 }}
                    items={[
                      {
                        title: 'Raised',
                        description: detailRecord.raised_by_name || '',
                        icon: <AuditOutlined />,
                      },
                      {
                        title: 'Pending Approval',
                        description: currentStep > 1 ? 'Submitted' : (s === 'pending_approval' ? 'Awaiting approver' : ''),
                        icon: <FileTextOutlined />,
                      },
                      {
                        title: 'Approved',
                        description: currentStep > 2 ? (detailRecord.approved_by_name || 'Approved') : '',
                        icon: <CheckCircleOutlined />,
                      },
                      {
                        title: 'In Progress',
                        description: s === 'approved' ? flowLabel : (hasMI ? 'Material issued' : hasMR ? 'Procurement active' : ''),
                        icon: hasMR ? <ShoppingCartOutlined /> : <InboxOutlined />,
                      },
                      {
                        title: 'Fulfilled',
                        description: s === 'partially_fulfilled' ? 'Partially fulfilled' : s === 'fulfilled' ? 'Fully fulfilled' : '',
                        icon: <CarOutlined />,
                      },
                      {
                        title: 'Acknowledged',
                        description: isAcknowledged ? 'Received by raiser' : 'Pending receipt',
                        icon: <CheckCircleOutlined />,
                      },
                    ]}
                  />
                )}
                {s === 'approved' && !hasMI && !hasMR && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Warehouse manager will issue material directly (Flow 1) or raise a Material Request for procurement (Flow 2).
                  </Text>
                )}
              </>
            );
          })()}
        </Card>

        <Card>
          <Tabs
            activeKey={detailTab}
            onChange={setDetailTab}
            items={[
              {
                key: 'info',
                label: 'Indent Info',
                children: (
                  <>
                    <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
                      <Descriptions.Item label="Indent #">{detailRecord.indent_number}</Descriptions.Item>
                      <Descriptions.Item label="Indent Date">{formatDate(detailRecord.indent_date)}</Descriptions.Item>
                      <Descriptions.Item label="Required Date">{formatDate(detailRecord.required_date)}</Descriptions.Item>
                      <Descriptions.Item label="Project">{detailRecord.project_name || detailRecord.project || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Warehouse">{detailRecord.warehouse_name || detailRecord.warehouse || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Department">{detailRecord.department_name || detailRecord.department || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Indent Type">
                        <Tag color={INDENT_TYPE_COLORS[detailRecord.indent_type] || 'default'}>
                          {INDENT_TYPES.find((t) => t.value === detailRecord.indent_type)?.label || detailRecord.indent_type || '-'}
                        </Tag>
                      </Descriptions.Item>
                      <Descriptions.Item label="Raised By">{detailRecord.raised_by_name || detailRecord.raised_by || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Status"><StatusTag status={detailRecord.status} /></Descriptions.Item>
                      <Descriptions.Item label="Approved By">{detailRecord.approved_by_name || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Approved Date">{formatDate(detailRecord.approved_date)}</Descriptions.Item>
                      <Descriptions.Item label="Remarks" span={3}>{detailRecord.remarks || '-'}</Descriptions.Item>
                    </Descriptions>

                    <Divider orientation="left">Items</Divider>
                    <Table
                      dataSource={detailItems}
                      rowKey={(r) => r.id || r.item_id}
                      size="small"
                      pagination={false}
                      scroll={{ x: 'max-content' }}
                      columns={[
                        { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
                        { title: 'Item Code', dataIndex: ['item', 'item_code'], key: 'code', width: 120, render: (t, r) => t || r.item_code || '-' },
                        { title: 'Item Name', dataIndex: ['item', 'item_name'], key: 'name', width: 200, render: (t, r) => t || r.item_name || (r.item && r.item.name) || '-' },
                        { title: 'UOM', dataIndex: 'uom', key: 'uom', width: 80, render: (v, r) => v || r.unit || '-' },
                        {
                          title: 'Requested Qty',
                          dataIndex: 'requested_qty',
                          key: 'rq',
                          width: 120,
                          align: 'right',
                          render: (v) => formatNumber(v),
                        },
                        {
                          title: 'Approved Qty',
                          dataIndex: 'approved_qty',
                          key: 'aq',
                          width: 120,
                          align: 'right',
                          render: (v) => v != null ? formatNumber(v) : '-',
                        },
                        {
                          title: 'Issued Qty',
                          dataIndex: 'issued_qty',
                          key: 'iq',
                          width: 120,
                          align: 'right',
                          render: (v) => formatNumber(v || 0),
                        },
                        {
                          title: 'Fulfillment',
                          key: 'progress',
                          width: 180,
                          render: (_, record) => {
                            const total = record.approved_qty || record.requested_qty || 1;
                            const issued = record.issued_qty || 0;
                            const pct = Math.min(Math.round((issued / total) * 100), 100);
                            return (
                              <div>
                                <Progress percent={pct} size="small" status={pct >= 100 ? 'success' : 'active'} />
                                <Text type="secondary" style={{ fontSize: 11 }}>
                                  {issued} / {total}
                                </Text>
                              </div>
                            );
                          },
                        },
                        { title: 'Remarks', dataIndex: 'remarks', key: 'rem', width: 160, ellipsis: true, render: (v) => v || '-' },
                      ]}
                    />

                    <Divider orientation="left">Supporting Documents</Divider>
                    {detailAttachments.length === 0 ? (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="No attachments"
                      />
                    ) : (
                      <div>
                        {detailAttachments.map((a) => (
                          <Tag
                            key={a.id}
                            icon={<PaperClipOutlined />}
                            color="blue"
                            style={{ marginBottom: 4 }}
                          >
                            <a href={a.file_path || a.url} target="_blank" rel="noreferrer">
                              {a.file_name}
                            </a>
                          </Tag>
                        ))}
                      </div>
                    )}
                  </>
                ),
              },
              {
                key: 'history',
                label: 'Approval History',
                children: (
                  <Table
                    dataSource={detailRecord.approval_history || detailRecord.approvals || []}
                    rowKey={(r) => r.id || r.timestamp || Math.random()}
                    size="small"
                    pagination={false}
                    locale={{ emptyText: <Empty description="No approval history" /> }}
                    columns={[
                      { title: 'Level', dataIndex: 'level', key: 'level', width: 70, render: (v) => v ? `L${v}` : '-' },
                      { title: 'Action', dataIndex: 'action', key: 'action', width: 130, render: (v) => <StatusTag status={v} /> },
                      { title: 'By', dataIndex: 'user_name', key: 'by', width: 180, render: (v, r) => v || r.user || '-' },
                      { title: 'Date', dataIndex: 'timestamp', key: 'date', width: 160, render: (v) => formatDate(v) },
                      { title: 'Remarks', dataIndex: 'remarks', key: 'rem', ellipsis: true, render: (v) => v || <Text type="secondary">No remarks</Text> },
                    ]}
                  />
                ),
              },
              {
                key: 'linked_docs',
                label: 'Linked Documents',
                children: (() => {
                  const mis = detailRecord.material_issues || [];
                  const mrs = detailRecord.material_requests || [];
                  return (
                    <div>
                      <Divider orientation="left">
                        <Space><InboxOutlined /> Material Issues (Flow 1 — Direct Stock)</Space>
                      </Divider>
                      {mis.length === 0 ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No material issues linked to this indent yet." />
                      ) : (
                        <Space wrap>
                          {mis.map((mi) => (
                            <Tag key={mi.id} color="blue" style={{ padding: '4px 12px', fontSize: 13 }}>
                              <FileTextOutlined style={{ marginRight: 4 }} />
                              {mi.issue_number}
                              <Tag color={mi.status === 'issued' ? 'green' : 'orange'} style={{ marginLeft: 6 }}>
                                {mi.status}
                              </Tag>
                            </Tag>
                          ))}
                        </Space>
                      )}

                      <Divider orientation="left">
                        <Space><ShoppingCartOutlined /> Material Requests (Flow 2 — Procurement)</Space>
                      </Divider>
                      {mrs.length === 0 ? (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No material requests raised for this indent yet." />
                      ) : (
                        <Space wrap>
                          {mrs.map((mr) => (
                            <Tag key={mr.id} color="purple" style={{ padding: '4px 12px', fontSize: 13 }}>
                              <ShoppingCartOutlined style={{ marginRight: 4 }} />
                              {mr.mr_number}
                              <Tag color={mr.status === 'approved' ? 'green' : 'orange'} style={{ marginLeft: 6 }}>
                                {mr.status}
                              </Tag>
                            </Tag>
                          ))}
                        </Space>
                      )}
                    </div>
                  );
                })(),
              },
              {
                key: 'acknowledgement',
                label: 'Acknowledgement',
                children: (
                  <div>
                    {isRaiser(detailRecord) && ['approved', 'partially_fulfilled', 'fulfilled'].includes(detailRecord.status) && !detailRecord.is_acknowledged && (
                      <div style={{ marginBottom: 16 }}>
                        <Button type="primary" icon={<CheckCircleOutlined />} onClick={openAckModal}>
                          Mark as Received
                        </Button>
                        <Text type="secondary" style={{ marginLeft: 12 }}>
                          Confirm that you have received the issued material.
                        </Text>
                      </div>
                    )}
                    {detailRecord.is_acknowledged && (
                      <div style={{ marginBottom: 16 }}>
                        <Tag color="green" style={{ fontSize: 14, padding: '4px 12px' }}>
                          <CheckCircleOutlined style={{ marginRight: 4 }} /> Material Received & Acknowledged
                        </Tag>
                      </div>
                    )}
                    {ackHistoryLoading ? (
                      <Spin />
                    ) : ackHistory.length === 0 ? (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No acknowledgements recorded yet." />
                    ) : (
                      <Timeline
                        items={ackHistory.map((ack) => ({
                          color: 'green',
                          children: (
                            <div>
                              <Text strong>{ack.acknowledged_by_name || 'Unknown'}</Text>
                              <Text type="secondary" style={{ marginLeft: 8 }}>{formatDate(ack.acknowledged_at)}</Text>
                              {ack.remarks && <div><Text type="secondary">{ack.remarks}</Text></div>}
                              {(ack.items || []).length > 0 && (
                                <Table
                                  size="small"
                                  pagination={false}
                                  style={{ marginTop: 8 }}
                                  dataSource={ack.items}
                                  rowKey={(r) => r.id || r.item_id}
                                  columns={[
                                    { title: 'Item', dataIndex: 'item_name', key: 'name', render: (v) => v || '-' },
                                    { title: 'Received Qty', dataIndex: 'received_qty', key: 'qty', align: 'right', render: (v) => formatNumber(v) },
                                    { title: 'UOM', dataIndex: 'uom', key: 'uom', width: 80 },
                                  ]}
                                />
                              )}
                            </div>
                          ),
                        }))}
                      />
                    )}
                  </div>
                ),
              },
            ]}
          />
        </Card>

        {/* Approve Modal */}
        <Modal
          title="Approve Indent - Set Approved Quantities"
          open={approveModalOpen}
          onOk={handleApprove}
          onCancel={() => setApproveModalOpen(false)}
          confirmLoading={approving}
          okText="Approve"
          width={700}
        >
          <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
            Review and set approved quantities for each item. You may reduce quantities if needed.
          </Text>
          <Table
            dataSource={approveItems}
            rowKey={(r) => r.id || r.item_id}
            size="small"
            pagination={false}
            columns={[
              { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
              { title: 'Item', dataIndex: 'item_name', key: 'name', width: 200, render: (v, r) => v || r.item?.item_name || r.item?.name || '-' },
              { title: 'Requested', dataIndex: 'requested_qty', key: 'rq', width: 100, align: 'right', render: (v) => formatNumber(v) },
              {
                title: 'Approved Qty',
                dataIndex: 'approved_qty',
                key: 'aq',
                width: 130,
                render: (val, record, idx) => (
                  <InputNumber
                    min={0}
                    max={record.requested_qty}
                    value={val}
                    onChange={(v) => {
                      setApproveItems((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, approved_qty: v } : item))
                      );
                    }}
                    style={{ width: '100%' }}
                  />
                ),
              },
              { title: 'UOM', dataIndex: 'uom', key: 'uom', width: 80 },
            ]}
          />
        </Modal>

        {/* Acknowledgement Modal */}
        <Modal
          title="Acknowledge Receipt of Material"
          open={ackModalOpen}
          onOk={handleAcknowledge}
          onCancel={() => setAckModalOpen(false)}
          confirmLoading={ackSubmitting}
          okText="Confirm Receipt"
          width={700}
        >
          <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
            Confirm the quantities you have physically received. This will record your acknowledgement.
          </Text>
          <Table
            dataSource={ackItems}
            rowKey={(r) => r.id || r.item_id}
            size="small"
            pagination={false}
            columns={[
              { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
              { title: 'Item', dataIndex: 'item_name', key: 'name', width: 200, render: (v, r) => v || r.item?.item_name || r.item?.name || '-' },
              { title: 'Approved', dataIndex: 'approved_qty', key: 'aq', width: 100, align: 'right', render: (v) => v != null ? formatNumber(v) : '-' },
              { title: 'Issued', dataIndex: 'issued_qty', key: 'iq', width: 100, align: 'right', render: (v) => formatNumber(v || 0) },
              {
                title: 'Received Qty',
                dataIndex: 'received_qty',
                key: 'rq',
                width: 130,
                render: (val, record, idx) => (
                  <InputNumber
                    min={0}
                    value={val}
                    onChange={(v) => {
                      setAckItems((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, received_qty: v } : item))
                      );
                    }}
                    style={{ width: '100%' }}
                  />
                ),
              },
              { title: 'UOM', dataIndex: 'uom', key: 'uom', width: 80 },
            ]}
          />
        </Modal>
      </div>
    );
  }

  // LIST VIEW
  return (
    <div>
      <PageHeader title="Indents" subtitle="Manage material indent requests">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Create Indent</Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchData}
        rowKey="id"
        searchPlaceholder="Search by indent number..."
        exportFileName="indents"
        toolbar={toolbar}
        scroll={{ x: 1800 }}
      />

      <Drawer
        title={editingRecord ? `Edit ${editingRecord.indent_number}` : 'Create Indent'}
        width={960}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setEditingRecord(null); form.resetFields(); setIndentItems([]); setPendingFiles([]); setExistingDrawerAttachments([]); }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); setEditingRecord(null); form.resetFields(); setIndentItems([]); setPendingFiles([]); setExistingDrawerAttachments([]); }}>Cancel</Button>
            <Button onClick={() => handleSubmit(false)} loading={submitting}>Save as Draft</Button>
            <Button type="primary" icon={<SendOutlined />} onClick={() => handleSubmit(true)} loading={submitting}>Submit for Approval</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" requiredMark="optional">
          <Form.Item name="indent_type" hidden><Input /></Form.Item>
          {/* Hidden registration when auto-filled, so validateFields() still
              returns the value. See IndentForm.jsx for the same pattern. */}
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
                  <Select options={projects} placeholder="Select project" allowClear optionFilterProp="label" />
                </Form.Item>
              </Col>
            )}
            {warehouses.length > 1 && (
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true, message: 'Required' }]}>
                  <Select options={warehouses} placeholder="Select warehouse" allowClear optionFilterProp="label" />
                </Form.Item>
              </Col>
            )}
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="required_date" label="Required Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="department" label="Department (optional)">
                <Select options={departments} placeholder="Select department" allowClear optionFilterProp="label" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={24} md={16}>
              <Form.Item name="remarks" label="Remarks (optional)">
                <TextArea rows={2} placeholder="Any remarks..." />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item style={{ marginBottom: 8 }}>
            <Button
              size="small"
              type={form.getFieldValue('indent_type') === 'urgent' ? 'primary' : 'default'}
              danger={form.getFieldValue('indent_type') === 'urgent'}
              onClick={() => {
                const cur = form.getFieldValue('indent_type');
                form.setFieldValue('indent_type', cur === 'urgent' ? 'regular' : 'urgent');
                setIndentItems((prev) => [...prev]);
              }}
            >
              {form.getFieldValue('indent_type') === 'urgent' ? '⚡ Urgent' : 'Mark as urgent'}
            </Button>
          </Form.Item>
        </Form>

        <Divider orientation="left">Items</Divider>
        <Table
          dataSource={indentItems}
          columns={itemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 900 }}
          footer={() => (
            <Button type="dashed" onClick={addItemRow} icon={<PlusOutlined />} block>Add Item</Button>
          )}
        />

        <Divider orientation="left">
          Supporting Documents{' '}
          <Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>
            (optional)
          </Text>
        </Divider>
        {existingDrawerAttachments.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            {existingDrawerAttachments.map((a) => (
              <Tag
                key={a.id}
                icon={<PaperClipOutlined />}
                color="blue"
                style={{ marginBottom: 4 }}
              >
                <a href={a.file_path || a.url} target="_blank" rel="noreferrer">
                  {a.file_name}
                </a>
              </Tag>
            ))}
          </div>
        )}
        <Upload
          fileList={pendingFiles}
          beforeUpload={(file) => {
            if (file.size / 1024 / 1024 > 10) {
              message.error('File must be smaller than 10 MB');
              return Upload.LIST_IGNORE;
            }
            return false;
          }}
          onChange={({ fileList }) => setPendingFiles(fileList)}
          onRemove={(file) => {
            setPendingFiles((prev) => prev.filter((f) => f.uid !== file.uid));
          }}
          multiple
          accept=".pdf,.jpg,.jpeg,.png,.gif,.bmp,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt"
        >
          <Button icon={<PaperClipOutlined />}>
            Attach prescription / order / supporting doc
          </Button>
        </Upload>
      </Drawer>
    </div>
  );
};

export default Indents;

