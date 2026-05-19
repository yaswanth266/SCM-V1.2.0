import React, { useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button, Drawer, Form, Input, Select, Space, Tabs, Badge, Card, Descriptions,
  Popconfirm, message, Row, Col, Table, Modal, Typography, Tooltip, Tag, Checkbox, Spin, Statistic,
} from 'antd';
import {
  CheckOutlined, CloseOutlined, PauseCircleOutlined, EyeOutlined,
  MailOutlined, ReloadOutlined, CheckCircleOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import ApprovalTimeline from '../../components/ApprovalTimeline';
import api from '../../config/api';
import useAuthStore from '../../store/authStore';
import {
  formatDateTime, formatCurrency, getErrorMessage, formatDate, formatDocNumber,
} from '../../utils/helpers';

const { TextArea } = Input;
const { Text, Title } = Typography;

const MODULE_TABS = [
  { key: 'all', label: 'All' },
  { key: 'indent', label: 'Indent' },
  { key: 'material_request', label: 'Material Request' },
  { key: 'purchase_order', label: 'Purchase Order' },
  { key: 'auto_reorder', label: 'Auto Reorder' },
  { key: 'stock_transfer', label: 'Stock Transfer' },
];

const PRIORITY_COLORS = {
  low: '#8c8c8c',
  normal: '#eb2f96',
  high: '#fa8c16',
  urgent: '#f5222d',
  critical: '#f5222d',
};

const STATUS_TABS = [
  { key: 'pending',  label: 'Pending' },
  { key: 'on_hold',  label: 'On Hold' },
  { key: 'approved', label: 'Approved by me' },
  { key: 'rejected', label: 'Rejected by me' },
];

const PendingApprovals = () => {
  const user = useAuthStore((s) => s.user);
  const userRoleCodes = (user?.roles || []).map(
    (r) => (r?.code || r?.role_code || '').toLowerCase()
  );
  const isAdmin = userRoleCodes.some((c) => ['super_admin', 'admin'].includes(c));
  const isFieldSupervisor = userRoleCodes.includes('field_supervisor')
    && !isAdmin;
  // Single-module approvers (field_supervisor) only act on indents.
  const isIndentOnlyApprover = isFieldSupervisor && userRoleCodes.length === 1;

  const [searchParams] = useSearchParams();
  // Allow Dashboard tiles to deep-link directly into a sub-tab via
  // /approvals/pending?status=approved | rejected | on_hold | pending.
  const initialStatus = (() => {
    const v = (searchParams.get('status') || '').toLowerCase();
    return ['pending', 'on_hold', 'approved', 'rejected'].includes(v) ? v : 'pending';
  })();

  const [activeModule, setActiveModule] = useState(isIndentOnlyApprover ? 'indent' : 'all');
  const [activeStatus, setActiveStatus] = useState(initialStatus);
  const [refreshKey, setRefreshKey] = useState(0);
  const [tabCounts, setTabCounts] = useState({});
  const [holdCount, setHoldCount] = useState(0);

  // Quick view state
  const [viewDrawerOpen, setViewDrawerOpen] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailData, setDetailData] = useState(null);
  const [approvalSteps, setApprovalSteps] = useState([]);

  // Action modal state
  const [actionModalOpen, setActionModalOpen] = useState(false);
  const [actionType, setActionType] = useState(null); // approve, reject, hold
  const [actionComment, setActionComment] = useState('');
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [actionTarget, setActionTarget] = useState(null); // single record or null for bulk
  // Indent-only: per-line approved_qty edits keyed by IndentItem.id
  const [qtyOverrides, setQtyOverrides] = useState({});

  // Bulk selection
  const [selectedRowKeys, setSelectedRowKeys] = useState([]);
  const [selectedRows, setSelectedRows] = useState([]);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);

  // Load tab counts
  const loadTabCounts = useCallback(async () => {
    try {
      const res = await api.get('/approvals/pending/counts');
      const data = res.data || {};
      setTabCounts(data);
    } catch {
      // silent - counts are non-critical
    }
  }, []);

  useEffect(() => {
    loadTabCounts();
  }, [loadTabCounts, refreshKey]);

  const fetchApprovals = useCallback(
    async (params) => {
      const qp = { ...params };
      if (activeModule !== 'all') {
        qp.document_type = activeModule;
      }
      // 2026-05-05: status sub-tab — pending vs on_hold. Backend filters by
      // ApprovalRequest.status; on_hold rows are otherwise invisible after
      // an approver clicks Hold.
      qp.status = activeStatus || 'pending';
      return await api.get('/approvals/pending', { params: qp });
    },
    [activeModule, activeStatus]
  );

  // Count of held requests for the sub-tab badge.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/approvals/pending', {
          params: { status: 'on_hold', page: 1, page_size: 1 },
        });
        if (!cancelled) {
          const total = res.data?.total ?? res.data?.pagination?.total ?? 0;
          setHoldCount(total);
        }
      } catch {
        // non-critical
      }
    })();
    return () => { cancelled = true; };
  }, [refreshKey]);

  const handleRowClick = async (record) => {
    setSelectedRecord(record);
    setViewDrawerOpen(true);
    setDetailLoading(true);
    setDetailData(null);
    setApprovalSteps([]);
    setQtyOverrides({});
    try {
      const [detailRes, stepsRes] = await Promise.allSettled([
        api.get(`/approvals/pending/${record.id}/detail`),
        api.get(`/approvals/pending/${record.id}/steps`),
      ]);
      if (detailRes.status === 'fulfilled') {
        setDetailData(detailRes.value.data);
      }
      if (stepsRes.status === 'fulfilled') {
        const stepsData = stepsRes.value.data;
        setApprovalSteps(stepsData.items || stepsData.data || stepsData || []);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const openActionModal = (type, record = null) => {
    setActionType(type);
    setActionTarget(record);
    setActionComment('');
    setActionModalOpen(true);
  };

  const handleAction = async () => {
    if (!actionType) return;
    // APR-1 fix: require comment for rejection
    if (actionType === 'reject' && !actionComment.trim()) {
      message.error('Please provide a reason for rejection');
      return;
    }
    setActionSubmitting(true);
    try {
      if (actionTarget) {
        // Single action
        const body = { comments: actionComment };
        // Send per-line approved_qty overrides only on approve, only for
        // indents, and only when the approver actually edited a qty.
        if (
          actionType === 'approve'
          && actionTarget.document_type === 'indent'
          && Object.keys(qtyOverrides).length > 0
        ) {
          body.item_overrides = Object.entries(qtyOverrides)
            .filter(([, v]) => v !== '' && v != null && Number.isFinite(Number(v)))
            .map(([id, v]) => ({ item_id: Number(id), approved_qty: Number(v) }));
        }
        await api.post(`/approvals/pending/${actionTarget.id}/${actionType}`, body);
        message.success(
          `Document ${actionType === 'approve' ? 'approved' : actionType === 'reject' ? 'rejected' : 'put on hold'} successfully`
        );
      } else {
        // Bulk action
        const ids = selectedRowKeys;
        if (ids.length === 0) {
          message.warning('No items selected');
          setActionSubmitting(false);
          return;
        }
        // BUG-FE-APR-026 — surface partial failures. The bulk endpoint
        // returns { succeeded, failed, success } so we can honestly report
        // X-of-Y processed instead of claiming everything worked.
        const bulkRes = await api.post('/approvals/pending/bulk-action', {
          ids,
          action: actionType,
          comments: actionComment,
        });
        const data = bulkRes?.data || {};
        const okCount = (data.succeeded && data.succeeded.length) ?? 0;
        const failCount = (data.failed && data.failed.length) ?? 0;
        if (failCount === 0) {
          message.success(`${okCount} document(s) ${actionType}d successfully`);
        } else if (okCount === 0) {
          message.error(
            `Bulk ${actionType} failed for all ${failCount} document(s). ` +
            `First error: ${data.failed?.[0]?.error || 'unknown'}`
          );
        } else {
          message.warning(
            `${okCount} ${actionType}d, ${failCount} failed. ` +
            `First failure: ${data.failed?.[0]?.error || 'unknown'}`
          );
        }
        setSelectedRowKeys([]);
        setSelectedRows([]);
      }
      setActionModalOpen(false);
      setActionComment('');
      setQtyOverrides({});
      setRefreshKey((k) => k + 1);

      // Refresh detail if view drawer is open
      if (viewDrawerOpen && actionTarget) {
        setViewDrawerOpen(false);
        setSelectedRecord(null);
        setDetailData(null);
      }
    } catch (err) {
      const status = err?.response?.status;
      const errMsg = getErrorMessage(err);
      if (status === 403) {
        message.error(errMsg || 'You do not have permission to perform this action');
      } else {
        message.error(errMsg);
      }
    } finally {
      setActionSubmitting(false);
    }
  };

  const handleBulkApprove = () => {
    if (selectedRowKeys.length === 0) {
      message.warning('Please select at least one item');
      return;
    }
    openActionModal('approve', null);
  };

  // Hide Document Type column when the user only sees one type — it's
  // redundant and just eats horizontal space.
  const indentOnlyView = isIndentOnlyApprover || activeModule === 'indent';
  const columns = [
    !indentOnlyView && {
      title: 'Document Type',
      dataIndex: 'document_type',
      key: 'document_type',
      width: 150,
      render: (val) => (
        <StatusTag status={val} />
      ),
    },
    {
      title: 'Document Number',
      dataIndex: 'document_number',
      key: 'document_number',
      width: 210,
      sorter: true,
      render: (text, record) => (
        <a onClick={() => handleRowClick(record)}>
          {formatDocNumber(text, record.requested_at)}
        </a>
      ),
    },
    {
      title: 'Requested By',
      dataIndex: 'requested_by',
      key: 'requested_by',
      width: 160,
      ellipsis: true,
      render: (val, record) => record.requested_by_name || val || '-',
    },
    {
      title: 'Requested At',
      dataIndex: 'requested_at',
      key: 'requested_at',
      width: 160,
      sorter: true,
      render: (val) => formatDateTime(val),
    },
    {
      title: 'Level',
      key: 'level',
      width: 100,
      align: 'center',
      render: (_, record) => {
        // History row: show the level I acted at, not the workflow's
        // current pointer (which has moved past me).
        if (record.my_action) {
          return <Text>L{record.my_action_level || 1} / {record.total_levels || 1}</Text>;
        }
        return <Text>{record.current_level || 1} / {record.total_levels || 1}</Text>;
      },
    },
    // Amount column makes no sense for indents (no monetary total). Hide it
    // when the active view is indent-only; show for MR/PO/etc. where the
    // backend may surface grand_total.
    !indentOnlyView && {
      title: 'Amount',
      key: 'amount',
      width: 140,
      align: 'right',
      sorter: true,
      render: (_, record) => {
        const val = record.amount ?? record.grand_total ?? null;
        return val != null ? <Text strong>{formatCurrency(val)}</Text> : '-';
      },
    },
    {
      // For indent rows the underlying field is `indent_type` (regular/urgent),
      // not a true priority. Rename header in indent-only views to match.
      title: indentOnlyView ? 'Type' : 'Priority',
      dataIndex: 'priority',
      key: 'priority',
      width: 100,
      render: (val) => {
        const priority = (val || 'normal').toLowerCase();
        return (
          <StatusTag status={priority} />
        );
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 170,
      render: (s, record) => {
        // History view: my_action is set. Render the meaningful stage
        // instead of a generic tick — "Sent to L2", "Final approved",
        // "Rejected by me".
        if (record.my_action === 'approved') {
          const myLevel = record.my_action_level || 1;
          const total = record.total_levels || 1;
          if (myLevel < total) {
            return <Tag color="blue">Sent to L{myLevel + 1}</Tag>;
          }
          return <Tag color="green">Final approved</Tag>;
        }
        if (record.my_action === 'rejected') {
          return <Tag color="red">Rejected by me</Tag>;
        }
        return <StatusTag status={s} />;
      },
    },
    {
      title: '',
      key: 'email_indicator',
      width: 40,
      render: (_, record) =>
        record.email_sent ? (
          <Tooltip title="Email notification sent">
            <MailOutlined style={{ color: '#52c41a' }} />
          </Tooltip>
        ) : null,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      fixed: 'right',
      render: (_, record) => {
        // History rows: only let the user view. Approve/Reject/Hold
        // buttons are meaningless once they've already actioned the
        // request.
        const isHistoryRow = !!record.my_action;
        if (isHistoryRow) {
          return (
            <Tooltip title="View Details">
              <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleRowClick(record)}>
                View
              </Button>
            </Tooltip>
          );
        }
        return (
          <Space size="small">
            <Tooltip title="View Details">
              <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleRowClick(record)} />
            </Tooltip>
            <Tooltip title="Approve">
              <Button
                type="link"
                size="small"
                style={{ color: '#52c41a' }}
                icon={<CheckOutlined />}
                onClick={() => openActionModal('approve', record)}
              />
            </Tooltip>
            <Tooltip title="Reject">
              <Button
                type="link"
                size="small"
                danger
                icon={<CloseOutlined />}
                onClick={() => openActionModal('reject', record)}
              />
            </Tooltip>
            <Tooltip title="Put on Hold">
              <Button
                type="link"
                size="small"
                style={{ color: '#faad14' }}
                icon={<PauseCircleOutlined />}
                onClick={() => openActionModal('hold', record)}
              />
            </Tooltip>
          </Space>
        );
      },
    },
  ].filter(Boolean);

  const rowSelection = {
    selectedRowKeys,
    onChange: (keys, rows) => {
      setSelectedRowKeys(keys);
      setSelectedRows(rows);
    },
    getCheckboxProps: (record) => ({
      disabled: record.status !== 'pending' && record.status !== 'pending_approval',
    }),
  };

  // Filter module tabs: single-module approvers (e.g. field_supervisor) only
  // see the "Indent" tab — All/MR/PO/Auto Reorder/Stock Transfer would always
  // be 0 for them and are meaningless cognitive noise.
  const visibleModuleTabs = isIndentOnlyApprover
    ? MODULE_TABS.filter((t) => t.key === 'indent')
    : MODULE_TABS;
  const tabItems = visibleModuleTabs.map((tab) => {
    const count = tab.key === 'all'
      ? Object.entries(tabCounts)
          .filter(([k]) => k !== 'all')
          .reduce((sum, [, c]) => sum + (c || 0), 0)
      : tabCounts[tab.key] || 0;
    return {
      key: tab.key,
      label: (
        <span>
          {tab.label}
          {count > 0 && (
            <Badge
              count={count}
              size="small"
              style={{ marginLeft: 8, backgroundColor: tab.key === 'all' ? '#eb2f96' : '#fa8c16' }}
            />
          )}
        </span>
      ),
    };
  });

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      {selectedRowKeys.length > 0 && (
        <Button
          type="primary"
          icon={<CheckCircleOutlined />}
          onClick={handleBulkApprove}
          style={{ background: '#52c41a', borderColor: '#52c41a' }}
        >
          Bulk Approve ({selectedRowKeys.length})
        </Button>
      )}
    </Space>
  );

  return (
    <div>
      <PageHeader
        title="Pending Approvals"
        subtitle={
          isIndentOnlyApprover
            ? 'Indents awaiting your approval'
            : 'Central approval hub for all modules'
        }
      >
        <Button
          icon={<ReloadOutlined />}
          onClick={() => { setRefreshKey((k) => k + 1); loadTabCounts(); }}
        >
          Refresh
        </Button>
      </PageHeader>

      {/* Top stats strip — collapses to two cards for single-module approvers
          since the per-module breakdown is meaningless when they only ever
          see one document type. */}
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col xs={12} md={isIndentOnlyApprover ? 12 : 6}>
          <Card bodyStyle={{ padding: 16 }}>
            <Statistic
              title="Pending"
              value={Object.entries(tabCounts).filter(([k]) => k !== 'all').reduce((s, [, v]) => s + (v || 0), 0)}
              valueStyle={{ color: '#fa8c16' }}
            />
          </Card>
        </Col>
        <Col xs={12} md={isIndentOnlyApprover ? 12 : 6}>
          <Card bodyStyle={{ padding: 16 }}>
            <Statistic
              title="On Hold"
              value={holdCount}
              valueStyle={{ color: '#722ed1' }}
            />
          </Card>
        </Col>
        {!isIndentOnlyApprover && (
          <>
            <Col xs={12} md={6}>
              <Card bodyStyle={{ padding: 16 }}>
                <Statistic
                  title="Indents"
                  value={tabCounts.indent || 0}
                  valueStyle={{ color: '#1677ff' }}
                />
              </Card>
            </Col>
            <Col xs={12} md={6}>
              <Card bodyStyle={{ padding: 16 }}>
                <Statistic
                  title="POs / MRs"
                  value={(tabCounts.purchase_order || 0) + (tabCounts.material_request || 0)}
                  valueStyle={{ color: '#13c2c2' }}
                />
              </Card>
            </Col>
          </>
        )}
      </Row>

      <Card bodyStyle={{ paddingBottom: 0 }} style={{ marginBottom: 12 }}>
        <Tabs
          size="small"
          activeKey={activeStatus}
          onChange={(key) => {
            setActiveStatus(key);
            setSelectedRowKeys([]);
            setSelectedRows([]);
            setRefreshKey((k) => k + 1);
          }}
          items={STATUS_TABS.map((t) => ({
            key: t.key,
            label: t.key === 'on_hold' ? (
              <Badge count={holdCount} size="small" offset={[8, -2]}>
                <span>{t.label}</span>
              </Badge>
            ) : t.label,
          }))}
        />
      </Card>

      {visibleModuleTabs.length > 1 && (
        <Card bodyStyle={{ paddingBottom: 0 }}>
          <Tabs
            activeKey={activeModule}
            onChange={(key) => {
              setActiveModule(key);
              setSelectedRowKeys([]);
              setSelectedRows([]);
              setRefreshKey((k) => k + 1);
            }}
            items={tabItems}
          />
        </Card>
      )}

      <div style={{ marginTop: 16 }}>
        <DataTable
          key={`${activeModule}-${activeStatus}-${refreshKey}`}
          columns={columns}
          fetchFunction={fetchApprovals}
          rowKey="id"
          searchPlaceholder="Search by document number, requester..."
          exportFileName="pending_approvals"
          toolbar={toolbar}
          scroll={{ x: 1500 }}
          rowSelection={rowSelection}
          onRow={(record) => ({
            onClick: (e) => {
              // Don't trigger for action buttons / checkboxes
              if (e.target.closest('.ant-btn') || e.target.closest('.ant-checkbox-wrapper')) return;
              handleRowClick(record);
            },
            style: { cursor: 'pointer' },
          })}
        />
      </div>

      {/* Quick View Drawer */}
      <Drawer
        title={
          selectedRecord ? (
            <Space>
              <StatusTag status={selectedRecord.document_type} />
              <Text strong>{formatDocNumber(selectedRecord.document_number, selectedRecord.requested_at)}</Text>
            </Space>
          ) : 'Document Details'
        }
        width={720}
        open={viewDrawerOpen}
        onClose={() => { setViewDrawerOpen(false); setSelectedRecord(null); setDetailData(null); setApprovalSteps([]); }}
        destroyOnHidden
        extra={
          selectedRecord && !selectedRecord.my_action && (
            <Space>
              <Button
                style={{ color: '#52c41a', borderColor: '#52c41a' }}
                icon={<CheckOutlined />}
                onClick={() => openActionModal('approve', selectedRecord)}
              >
                Approve
              </Button>
              <Button
                danger
                icon={<CloseOutlined />}
                onClick={() => openActionModal('reject', selectedRecord)}
              >
                Reject
              </Button>
              <Button
                style={{ color: '#faad14', borderColor: '#faad14' }}
                icon={<PauseCircleOutlined />}
                onClick={() => openActionModal('hold', selectedRecord)}
              >
                Hold
              </Button>
            </Space>
          )
        }
      >
        {detailLoading ? (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <Spin size="large" />
          </div>
        ) : (
          <>
            {/* Document Summary */}
            {selectedRecord && (
              <Card size="small" style={{ marginBottom: 16 }}>
                <Descriptions column={2} size="small">
                  <Descriptions.Item label="Document Type">
                    {(selectedRecord.document_type || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                  </Descriptions.Item>
                  <Descriptions.Item label="Document Number">
                    {formatDocNumber(selectedRecord.document_number, selectedRecord.requested_at)}
                  </Descriptions.Item>
                  <Descriptions.Item label="Requested By">
                    {selectedRecord.requested_by_name || selectedRecord.requested_by || '-'}
                  </Descriptions.Item>
                  <Descriptions.Item label="Requested At">
                    {formatDateTime(selectedRecord.requested_at)}
                  </Descriptions.Item>
                  <Descriptions.Item label="Amount">
                    {selectedRecord.amount != null ? formatCurrency(selectedRecord.amount) : '-'}
                  </Descriptions.Item>
                  <Descriptions.Item label="Priority">
                    <StatusTag status={(selectedRecord.priority || 'normal').toLowerCase()} />
                  </Descriptions.Item>
                  <Descriptions.Item label="Current Level">
                    {selectedRecord.current_level || 1} / {selectedRecord.total_levels || 1}
                  </Descriptions.Item>
                  <Descriptions.Item label="Status">
                    <StatusTag status={selectedRecord.status} />
                  </Descriptions.Item>
                  {selectedRecord.project_name && (
                    <Descriptions.Item label="Project" span={2}>
                      {selectedRecord.project_name}
                    </Descriptions.Item>
                  )}
                </Descriptions>
              </Card>
            )}

            {/* Stock summary banner — only meaningful for indents at L2.
                Tells the approver up-front how many lines are fulfillable
                from the warehouse before they click Approve. */}
            {detailData && selectedRecord?.document_type === 'indent' && detailData.stock_summary && (
              (() => {
                const ss = detailData.stock_summary;
                const allIn = ss.in_stock_lines === ss.total_lines && ss.total_lines > 0;
                const noneIn = ss.in_stock_lines === 0 && ss.total_lines > 0;
                const bg = allIn ? '#f6ffed' : noneIn ? '#fff2f0' : '#fffbe6';
                const border = allIn ? '#b7eb8f' : noneIn ? '#ffccc7' : '#ffe58f';
                const label = allIn
                  ? `All ${ss.total_lines} lines available — approve to issue from stock`
                  : noneIn
                    ? `No stock for any line — approving will need a Material Request (procurement)`
                    : `${ss.in_stock_lines} of ${ss.total_lines} lines in stock — partial issue + MR for the rest`;
                return (
                  <div style={{
                    background: bg, border: `1px solid ${border}`,
                    borderRadius: 6, padding: '10px 14px', marginBottom: 12,
                    fontSize: 13, fontWeight: 500,
                  }}>
                    {label}
                  </div>
                );
              })()
            )}

            {/* Detail Items */}
            {detailData && detailData.items && detailData.items.length > 0 && (
              <Card size="small" title="Items" style={{ marginBottom: 16 }}>
                <Table
                  dataSource={detailData.items}
                  rowKey={(r, idx) => r.id || idx}
                  pagination={false}
                  size="small"
                  scroll={{ x: 600 }}
                  columns={[
                    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
                    {
                      title: 'Item',
                      dataIndex: 'item_name',
                      ellipsis: true,
                      render: (val, r) => val || r.name || '-',
                    },
                    {
                      title: 'Requested',
                      dataIndex: 'qty',
                      width: 90,
                      render: (v, r) => v ?? r.quantity ?? r.requested_qty ?? '-',
                    },
                    {
                      title: 'Approved Qty',
                      width: 110,
                      render: (_, r) => {
                        if (selectedRecord?.document_type !== 'indent') {
                          return r.approved_qty ?? r.qty ?? '-';
                        }
                        const requested = Number(r.qty ?? r.requested_qty ?? 0);
                        const current = qtyOverrides[r.id] != null
                          ? qtyOverrides[r.id]
                          : Number(r.approved_qty || requested);
                        return (
                          <Input
                            type="number"
                            min={0}
                            max={requested}
                            size="small"
                            value={current}
                            onChange={(e) => {
                              const v = e.target.value === '' ? '' : Number(e.target.value);
                              setQtyOverrides((prev) => ({ ...prev, [r.id]: v }));
                            }}
                            style={{ width: 90 }}
                          />
                        );
                      },
                    },
                    { title: 'UOM', dataIndex: 'uom', width: 70, render: (v) => v || '-' },
                    // Stock visibility for indent L2 — colored badge so the
                    // approver can see at a glance whether the line is
                    // fulfillable from this warehouse.
                    selectedRecord?.document_type === 'indent' && {
                      title: 'Available',
                      key: 'available',
                      width: 130,
                      render: (_, r) => {
                        const avail = r.available_qty ?? 0;
                        const req = Number(r.qty || r.requested_qty || 0);
                        const status = r.stock_status;
                        const color = status === 'in_stock' ? 'green'
                          : status === 'partial' ? 'orange' : 'red';
                        const label = status === 'in_stock' ? 'In stock'
                          : status === 'partial' ? `Partial (${avail}/${req})`
                          : 'No stock';
                        return (
                          <Tag color={color} style={{ minWidth: 100, textAlign: 'center' }}>
                            {avail} — {label}
                          </Tag>
                        );
                      },
                    },
                    // Rate / Amount are noise on indents (no monetary line
                    // total). Only show them for procurement-side documents.
                    selectedRecord?.document_type !== 'indent' && {
                      title: 'Rate',
                      dataIndex: 'rate',
                      width: 100,
                      align: 'right',
                      render: (v, r) => v != null ? formatCurrency(v) : r.unit_price != null ? formatCurrency(r.unit_price) : '-',
                    },
                    selectedRecord?.document_type !== 'indent' && {
                      title: 'Amount',
                      dataIndex: 'amount',
                      width: 110,
                      align: 'right',
                      render: (v) => v != null ? <Text strong>{formatCurrency(v)}</Text> : '-',
                    },
                  ].filter(Boolean)}
                />
              </Card>
            )}

            {/* Detail Summary */}
            {detailData && (
              <Card size="small" style={{ marginBottom: 16 }}>
                <Descriptions column={2} size="small">
                  {detailData.subtotal != null && (
                    <Descriptions.Item label="Subtotal">{formatCurrency(detailData.subtotal)}</Descriptions.Item>
                  )}
                  {detailData.tax_total != null && (
                    <Descriptions.Item label="Tax Total">{formatCurrency(detailData.tax_total)}</Descriptions.Item>
                  )}
                  {detailData.grand_total != null && (
                    <Descriptions.Item label="Grand Total">
                      <Text strong style={{ color: '#eb2f96' }}>{formatCurrency(detailData.grand_total)}</Text>
                    </Descriptions.Item>
                  )}
                  {detailData.remarks && (
                    <Descriptions.Item label="Remarks" span={2}>{detailData.remarks}</Descriptions.Item>
                  )}
                </Descriptions>
              </Card>
            )}

            {/* Approval Timeline */}
            <Card size="small" title="Approval History" style={{ marginBottom: 16 }}>
              <ApprovalTimeline steps={approvalSteps} />
            </Card>
          </>
        )}
      </Drawer>

      {/* Action Modal (Approve/Reject/Hold) */}
      <Modal
        title={
          actionType === 'approve'
            ? 'Approve Document'
            : actionType === 'reject'
              ? 'Reject Document'
              : 'Put Document on Hold'
        }
        open={actionModalOpen}
        onCancel={() => { setActionModalOpen(false); setActionComment(''); setActionTarget(null); }}
        onOk={handleAction}
        confirmLoading={actionSubmitting}
        okText={
          actionType === 'approve' ? 'Approve' : actionType === 'reject' ? 'Reject' : 'Hold'
        }
        okButtonProps={{
          danger: actionType === 'reject',
          style: actionType === 'approve'
            ? { background: '#52c41a', borderColor: '#52c41a' }
            : actionType === 'hold'
              ? { background: '#faad14', borderColor: '#faad14', color: '#fff' }
              : undefined,
        }}
      >
        {actionTarget ? (
          <div style={{ marginBottom: 16 }}>
            <Text>
              {actionType === 'approve' ? 'Approving' : actionType === 'reject' ? 'Rejecting' : 'Holding'}{' '}
              <Text strong>{formatDocNumber(actionTarget.document_number, actionTarget.requested_at)}</Text>
              {actionTarget.total_levels > 1 && actionType === 'approve' && (
                <Tag style={{ marginLeft: 8, backgroundColor: '#1677ff', borderColor: '#1677ff', color: '#fff' }}>
                  Level {actionTarget.current_level} of {actionTarget.total_levels}
                </Tag>
              )}
              {actionType === 'reject' && (
                <Tag style={{ marginLeft: 8, backgroundColor: '#ff4d4f', borderColor: '#ff4d4f', color: '#fff' }}>
                  Rejection
                </Tag>
              )}
            </Text>
            {actionTarget.total_levels > 1 && actionTarget.current_level < actionTarget.total_levels && actionType === 'approve' && (
              <div style={{ marginTop: 8, padding: '8px 12px', background: '#f6ffed', borderRadius: 6, border: '1px solid #b7eb8f' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  After this approval, the document will move to Level {actionTarget.current_level + 1} for final approval.
                </Text>
              </div>
            )}
            {actionTarget.total_levels > 1 && actionTarget.current_level >= actionTarget.total_levels && actionType === 'approve' && (
              <div style={{ marginTop: 8, padding: '8px 12px', background: '#f6ffed', borderRadius: 6, border: '1px solid #b7eb8f' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  This is the final approval. The document will be marked as approved.
                </Text>
              </div>
            )}
          </div>
        ) : (
          <div style={{ marginBottom: 16 }}>
            <Text>
              Bulk {actionType} for <Text strong>{selectedRowKeys.length}</Text> document(s)
            </Text>
          </div>
        )}
        <Form layout="vertical" requiredMark="optional">
          <Form.Item
            label="Comments"
            required={actionType === 'reject'}
          >
            <TextArea
              rows={4}
              value={actionComment}
              onChange={(e) => setActionComment(e.target.value)}
              placeholder={
                actionType === 'reject'
                  ? 'Please provide a reason for rejection (required)...'
                  : 'Add comments (optional)...'
              }
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default PendingApprovals;

