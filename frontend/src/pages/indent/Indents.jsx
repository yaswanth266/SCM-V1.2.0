import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, Popconfirm, message, InputNumber,
  Modal, Table, Typography,
} from 'antd';
import {
  PlusOutlined, EditOutlined, EyeOutlined,
  SendOutlined, CheckCircleOutlined, StopOutlined, ExportOutlined,
  PrinterOutlined,
} from '@ant-design/icons';
import { useReactToPrint } from 'react-to-print';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { formatDate, formatNumber, getErrorMessage } from '../../utils/helpers';
import useAuthStore from '../../store/authStore';
import { IndentPrint } from '../../components/PrintTemplates';

const { Text } = Typography;

// Auto Reorder is not user-selectable — backend creates those automatically
// from reorder level rules. Users only pick Regular or Urgent.
const INDENT_TYPES = [
  { label: 'Regular', value: 'regular' },
  { label: 'Urgent', value: 'urgent' },
  { label: 'Auto Reorder', value: 'auto_reorder' },
];

const Indents = () => {
  const { user: currentUser, hasPermission } = useAuthStore();
  const navigate = useNavigate();

  const canRaiseMR = hasPermission('indent', 'approve')
    || hasPermission('procurement', 'create');

  const _activeRoleCode =
    currentUser?.role ||
    (Array.isArray(currentUser?.roles) ? currentUser.roles[0]?.code : null) ||
    currentUser?.user_type;
  const canIssue = [
    'super_admin', 'admin',
    'warehouse_manager', 'warehouse_operator', 'store_keeper',
  ].includes(_activeRoleCode);

  const canApprove = (record) =>
    record?.status === 'pending_approval' &&
    record?.can_approve_now === true &&
    record?.raised_by !== currentUser?.id;
  const isRaiser = (record) => record?.raised_by === currentUser?.id;

  const [refreshKey, setRefreshKey] = useState(0);
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterType, setFilterType] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);
  const [filterProject, setFilterProject] = useState(undefined);
  const [warehouses, setWarehouses] = useState([]);
  const [projects, setProjects] = useState([]);

  // Approve modal (quick approve from list)
  const [approveModalOpen, setApproveModalOpen] = useState(false);
  const [approveTarget, setApproveTarget] = useState(null);
  const [approveItems, setApproveItems] = useState([]);
  const [approving, setApproving] = useState(false);

  // Print support
  const [printData, setPrintData] = useState(null);
  const printRef = useRef(null);
  const handlePrint = useReactToPrint({
    content: () => printRef.current,
    onAfterPrint: () => setPrintData(null),
  });

  const handlePrintClick = async (id) => {
    try {
      message.loading({ content: 'Loading indent details...', key: 'printIndent' });
      const res = await api.get(`/indent/indents/${id}`);
      setPrintData(res.data);
      message.destroy('printIndent');
    } catch (err) {
      message.error({ content: getErrorMessage(err), key: 'printIndent' });
    }
  };

  useEffect(() => {
    if (printData) {
      handlePrint();
    }
  }, [printData, handlePrint]);

  const loadLookups = useCallback(async () => {
    try {
      const [whRes, projRes] = await Promise.allSettled([
        api.get('/masters/warehouses', { params: { page_size: 200, exclude_virtual: true } }),
        api.get('/masters/projects', { params: { page_size: 200 } }),
      ]);
      if (whRes.status === 'fulfilled') {
        const w = whRes.value.data;
        setWarehouses((w.items || w.data || w || []).map((i) => ({ label: i.name || i.warehouse_name, value: i.id })));
      }
      if (projRes.status === 'fulfilled') {
        const p = projRes.value.data;
        setProjects((p.items || p.data || p || []).map((i) => ({ label: i.name || i.project_name, value: i.id })));
      }
    } catch { /* silent */ }
  }, []);

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

  const handleAction = async (id, action) => {
    try {
      await api.post(`/indent/indents/${id}/${action}`);
      const labels = { submit: 'submitted for approval', reject: 'rejected', cancel: 'cancelled' };
      message.success(`Indent ${labels[action] || action}`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const openApproveModal = async (record) => {
    try {
      const res = await api.get(`/indent/indents/${record.id}`);
      const data = res.data;
      const items = (data.items || []).map((item) => ({
        ...item,
        approved_qty: item.approved_qty ?? item.requested_qty ?? item.qty,
      }));
      setApproveTarget(data);
      setApproveItems(items);
      setApproveModalOpen(true);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
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
      await api.post(`/indent/indents/${approveTarget.id}/approve`, payload);
      message.success('Indent approved');
      setApproveModalOpen(false);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setApproving(false);
    }
  };

  const columns = [
    {
      title: 'Indent #',
      dataIndex: 'indent_number',
      key: 'indent_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => navigate(`/indent/indents/${record.id}`)}>{text}</a>,
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
    {
      title: 'Raising Position',
      dataIndex: 'position_name',
      key: 'position_name',
      width: 180,
      render: (text, record) => {
        if (!text) return '-';
        return (
          <span style={{ 
            backgroundColor: '#e6f7ff', 
            color: '#0050b3', 
            border: '1px solid #91d5ff', 
            padding: '4px 8px', 
            borderRadius: '4px',
            fontWeight: '600',
            fontSize: '12px',
            display: 'inline-block'
          }}>
            {text} {record.position_code ? `(${record.position_code})` : ''}
          </span>
        );
      }
    },
    { title: 'Status', dataIndex: 'status', key: 'status', width: 150, render: (s, record) => <StatusTag status={s} record={record} /> },
    {
      title: 'Actions',
      key: 'actions',
      width: 240,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => navigate(`/indent/indents/${record.id}`)} />
          <Button
            type="link"
            size="small"
            icon={<PrinterOutlined />}
            title="Print Indent"
            onClick={() => handlePrintClick(record.id)}
          />
          {record.status === 'draft' && (
            <>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => navigate(`/indent/indents/${record.id}`)} />
              <Button
                type="link"
                size="small"
                icon={<SendOutlined />}
                title="Submit for Approval"
                onClick={() => handleAction(record.id, 'submit')}
              />
            </>
          )}
          {canApprove(record) && (
            <Button
              type="link"
              size="small"
              icon={<CheckCircleOutlined />}
              style={{ color: '#52c41a' }}
              title={record.current_workflow_level
                ? `Approve at level ${record.current_workflow_level}/${record.total_workflow_levels || ''}`
                : 'Approve'}
              onClick={() => openApproveModal(record)}
            />
          )}
          {record.status === 'pending_approval' && !canApprove(record) && !isRaiser(record) && record.current_workflow_level && (
            <Button type="link" size="small" disabled icon={<CheckCircleOutlined />} title={`Awaiting level ${record.current_workflow_level} approver`} />
          )}
          {(
            (record.status === 'draft' && isRaiser(record)) ||
            (record.status === 'pending_approval' && canApprove(record))
          ) && (
            <Popconfirm
              title={record.status === 'draft' ? 'Cancel this draft?' : 'Reject this indent?'}
              onConfirm={() => handleAction(record.id, 'reject')}
              okButtonProps={{ danger: true }}
            >
              <Button type="link" size="small" danger icon={<StopOutlined />} />
            </Popconfirm>
          )}
          {canIssue && ['approved', 'partially_fulfilled'].includes(record.status) && (
            <Button
              type="link"
              size="small"
              icon={<ExportOutlined />}
              style={{ color: '#481890' }}
              title="Issue materials against this indent"
              onClick={() => navigate(`/warehouse/material-issues?indent_id=${record.id}`)}
            />
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
          optionFilterProp="label"
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

  return (
    <div>
      <PageHeader title="Indents" subtitle="Manage material indent requests">
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/indent/indents/new')}>
          Create Indent
        </Button>
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

      {/* Quick Approve Modal from list view */}
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

      <div style={{ display: 'none' }}>
        <IndentPrint ref={printRef} data={printData} />
      </div>
    </div>
  );
};

export default Indents;
