import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Table, Tag, Space, message, Select, Popconfirm, Input,
  Modal, Empty, Statistic, Row, Col, Card, Typography, Tooltip,
  Progress, Badge,
} from 'antd';
import {
  ReloadOutlined, CheckCircleOutlined, FundOutlined, ExportOutlined,
  ClockCircleOutlined, CheckOutlined, SyncOutlined, HourglassOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { formatNumber, getErrorMessage, formatDate } from '../../utils/helpers';

const { Text } = Typography;

/* ── per-source status badge config ──────────────────────────────────────── */
const IDENT_STATUS_CONFIG = {
  pending:         { color: 'default',   icon: <HourglassOutlined />, label: 'Pending Issue' },
  in_mr:           { color: 'blue',      icon: <SyncOutlined />,      label: 'In MR' },
  issued:          { color: 'geekblue',  icon: <ClockCircleOutlined />, label: 'Issued — Awaiting Ack' },
  partially_acked: { color: 'orange',    icon: <SyncOutlined />,      label: 'Partially Acked' },
};

function IdentStatusTag({ status }) {
  const cfg = IDENT_STATUS_CONFIG[status] || IDENT_STATUS_CONFIG.pending;
  return <Tag color={cfg.color} icon={cfg.icon} style={{ fontSize: 11 }}>{cfg.label}</Tag>;
}

/* ── expanded source-indent rows ─────────────────────────────────────────── */
function SourcesPanel({ sources, uomName }) {
  return (
    <div style={{ padding: '4px 0' }}>
      {sources.map((s) => {
        const pct = s.qty > 0 ? Math.round((s.acknowledged_qty / s.qty) * 100) : 0;
        return (
          <div
            key={s.indent_item_id}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '6px 0', borderBottom: '1px solid #f0f0f0',
              flexWrap: 'wrap',
            }}
          >
            {/* Indent number */}
            <Text strong style={{ fontSize: 12, minWidth: 110 }}>{s.indent_number}</Text>

            {/* Status badge */}
            <IdentStatusTag status={s.ident_status} />

            {/* Qty breakdown */}
            <span style={{ fontSize: 11, color: '#595959', minWidth: 200 }}>
              Approved:&nbsp;<Text strong>{formatNumber(s.qty)}</Text>&nbsp;
              Issued:&nbsp;<Text style={{ color: '#1677ff' }}>{formatNumber(s.issued_qty ?? 0)}</Text>&nbsp;
              Acked:&nbsp;<Text style={{ color: '#52c41a' }}>{formatNumber(s.acknowledged_qty ?? 0)}</Text>&nbsp;
              <Text type="danger">Remaining: {formatNumber(s.remaining_qty ?? s.qty)}</Text>
              &nbsp;{uomName}
            </span>

            {/* Acknowledgement progress */}
            <div style={{ minWidth: 120, flex: 1, maxWidth: 200 }}>
              <Progress
                percent={pct}
                size="small"
                strokeColor={pct >= 100 ? '#52c41a' : pct > 0 ? '#fa8c16' : '#d9d9d9'}
                format={(p) => <span style={{ fontSize: 10 }}>{p}% ack</span>}
              />
            </div>

            {/* Required date */}
            {s.required_date && (
              <Text type="secondary" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                Due: {formatDate(s.required_date)}
              </Text>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────── */

const DemandPool = () => {
  const navigate = useNavigate();
  const [groups, setGroups] = useState([]);
  const [groupCount, setGroupCount] = useState(0);
  const [indentCount, setIndentCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [warehouses, setWarehouses] = useState([]);
  const [filterWh, setFilterWh] = useState(undefined);
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const loadWarehouses = async () => {
    try {
      const r = await api.get('/masters/warehouses', { params: { page_size: 200 } });
      const items = r.data?.items || r.data?.data || r.data || [];
      setWarehouses(items.map((w) => ({ label: w.name, value: w.id })));
    } catch { /* silent */ }
  };

  const fetchPool = async () => {
    setLoading(true);
    try {
      const params = filterWh ? { warehouse_id: filterWh } : {};
      const r = await api.get('/procurement/demand-pool', { params });
      const data = r.data || {};
      setGroups((data.groups || []).map((g, i) => ({ ...g, key: `${g.warehouse_id}-${g.item_id}-${g.uom_id}-${i}` })));
      setGroupCount(data.group_count || 0);
      setIndentCount(data.indent_count || 0);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadWarehouses(); }, []);
  useEffect(() => { fetchPool(); }, [filterWh]);

  const selectedRows = useMemo(
    () => groups.filter((g) => selectedKeys.includes(g.key)),
    [groups, selectedKeys]
  );

  // Only pending/unissued sources can be consolidated into an MR
  const selectedIndentIds = useMemo(() => {
    const ids = new Set();
    selectedRows.forEach((g) =>
      g.sources
        .filter((s) => s.ident_status !== 'in_mr' && s.qty > (s.issued_qty ?? 0))
        .forEach((s) => ids.add(s.indent_id))
    );
    return [...ids];
  }, [selectedRows]);

  const selectedTotalQty = useMemo(
    () => selectedRows.reduce((sum, g) => sum + (g.total_qty || 0), 0),
    [selectedRows]
  );

  /* aggregate pool-wide status counts */
  const statusCounts = useMemo(() => {
    const counts = { pending: 0, in_mr: 0, issued: 0, partially_acked: 0 };
    groups.forEach((g) => g.sources?.forEach((s) => {
      counts[s.ident_status] = (counts[s.ident_status] || 0) + 1;
    }));
    return counts;
  }, [groups]);

  const handleConsolidate = async () => {
    if (selectedIndentIds.length === 0) {
      message.warning('No pending indents in selected rows. Already-issued items must be acknowledged before re-consolidation.');
      return;
    }
    setSubmitting(true);
    try {
      const r = await api.post('/procurement/material-requests/consolidate', {
        indent_ids: selectedIndentIds,
      });
      const mrs = r.data?.mrs || [];
      message.success(`Created ${mrs.length} consolidated MR(s): ${mrs.map((m) => m.mr_number).join(', ')}`);
      setSelectedKeys([]);
      setConfirmOpen(false);
      fetchPool();
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const canIssueSource = (source) => {
    const targetQty = Number(source?.qty || 0);
    const issuedQty = Number(source?.issued_qty || 0);
    const acknowledgedQty = Number(source?.acknowledged_qty || 0);
    const remainingQty = Number(source?.remaining_qty || 0);
    return targetQty > issuedQty || (acknowledgedQty > 0 && remainingQty > 0);
  };

  const columns = [
    {
      title: 'Warehouse',
      dataIndex: 'warehouse_name',
      width: 160,
      render: (v) => v || '-',
      filters: [...new Set(groups.map((g) => g.warehouse_name))]
        .filter(Boolean)
        .map((w) => ({ text: w, value: w })),
      onFilter: (v, r) => r.warehouse_name === v,
    },
    {
      title: 'Item Code',
      dataIndex: 'item_code',
      width: 140,
      render: (v) => <code>{v || '-'}</code>,
    },
    {
      title: 'Item Name',
      dataIndex: 'item_name',
      ellipsis: true,
    },
    {
      title: 'Outstanding Demand',
      dataIndex: 'total_qty',
      width: 160,
      align: 'right',
      sorter: (a, b) => (a.total_qty || 0) - (b.total_qty || 0),
      render: (v, r) => (
        <Space direction="vertical" size={0} style={{ textAlign: 'right' }}>
          <Text strong style={{ color: '#cf1322' }}>{formatNumber(v)}</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            outstanding {r.uom_name || ''}
          </Text>
        </Space>
      ),
    },
    {
      title: '# Indents',
      dataIndex: 'indent_count',
      width: 90,
      align: 'right',
      render: (v) => <Tag>{v}</Tag>,
    },
    {
      title: 'Source Indents & Status',
      dataIndex: 'sources',
      ellipsis: false,
      render: (sources, r) => {
        // Show a summary with status badges
        const byStatus = {};
        (sources || []).forEach((s) => {
          byStatus[s.ident_status] = (byStatus[s.ident_status] || 0) + 1;
        });
        return (
          <Space wrap size={4}>
            {Object.entries(byStatus).map(([st, cnt]) => {
              const cfg = IDENT_STATUS_CONFIG[st] || IDENT_STATUS_CONFIG.pending;
              return (
                <Tag key={st} color={cfg.color} icon={cfg.icon} style={{ fontSize: 11 }}>
                  {cnt}× {cfg.label}
                </Tag>
              );
            })}
          </Space>
        );
      },
    },
    {
      title: 'Earliest Required',
      dataIndex: 'sources',
      width: 140,
      render: (sources) => {
        const dates = sources.map((s) => s.required_date).filter(Boolean).sort();
        return dates[0] ? formatDate(dates[0]) : '-';
      },
    },
    {
      title: 'Stock @ Source',
      dataIndex: 'available_qty',
      width: 150,
      render: (v, r) => {
        const status = r.stock_status;
        const color = status === 'in_stock' ? 'green' : status === 'partial' ? 'orange' : 'red';
        const label = status === 'in_stock' ? 'In stock' : status === 'partial' ? 'Partial' : 'No stock';
        return (
          <Space direction="vertical" size={0}>
            <Tag color={color}>{label}</Tag>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {formatNumber(v || 0)} avail
            </Text>
          </Space>
        );
      },
    },
    {
      title: 'Action',
      width: 130,
      render: (_, r) => {
        const eligibleSource = r.sources?.find(canIssueSource);
        if (eligibleSource && (r.stock_status === 'in_stock' || r.stock_status === 'partial')) {
          return (
            <Tooltip title="Stock available — go to Material Issue prefilled from this indent">
              <Button
                size="small"
                type="link"
                icon={<ExportOutlined />}
                onClick={() => navigate(`/warehouse/material-issues?indent_id=${eligibleSource.indent_id}`)}
              >
                Issue Now
              </Button>
            </Tooltip>
          );
        }
        const awaitingAck = r.sources?.some((s) => (s.issued_qty ?? 0) > (s.acknowledged_qty ?? 0));
        if (awaitingAck) {
          return (
            <Tooltip title="Material has been issued — waiting for raiser to acknowledge receipt">
              <Tag color="geekblue" icon={<ClockCircleOutlined />} style={{ fontSize: 11 }}>Awaiting Ack</Tag>
            </Tooltip>
          );
        }
        return <Text type="secondary" style={{ fontSize: 11 }}>Select &amp; Raise MR</Text>;
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Demand Pool"
        subtitle="Outstanding indent demand — indents stay here until the raiser acknowledges full receipt"
      >
        <Space>
          <Select
            placeholder="Filter by warehouse"
            allowClear
            style={{ width: 220 }}
            value={filterWh}
            onChange={setFilterWh}
            options={warehouses}
            showSearch
            optionFilterProp="label"
          />
          <Button icon={<ReloadOutlined />} onClick={fetchPool}>Refresh</Button>
          <Button
            type="primary"
            icon={<CheckCircleOutlined />}
            disabled={selectedKeys.length === 0}
            onClick={() => setConfirmOpen(true)}
          >
            Create Consolidated MR ({selectedKeys.length})
          </Button>
        </Space>
      </PageHeader>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={5}>
          <Card size="small">
            <Statistic title="Item groups in pool" value={groupCount} prefix={<FundOutlined />} />
          </Card>
        </Col>
        <Col span={5}>
          <Card size="small">
            <Statistic title="Source indents" value={indentCount} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small" style={{ borderColor: '#d9d9d9' }}>
            <Statistic title="Pending Issue" value={statusCounts.pending || 0} valueStyle={{ color: '#595959' }} />
          </Card>
        </Col>
        <Col span={5}>
          <Card size="small" style={{ borderColor: '#1677ff' }}>
            <Statistic title="Issued — Awaiting Ack" value={statusCounts.issued || 0} valueStyle={{ color: '#1677ff' }} />
          </Card>
        </Col>
        <Col span={5}>
          <Card size="small" style={{ borderColor: '#fa8c16' }}>
            <Statistic title="Partially Acknowledged" value={statusCounts.partially_acked || 0} valueStyle={{ color: '#fa8c16' }} />
          </Card>
        </Col>
      </Row>

      <Table
        rowKey="key"
        columns={columns}
        dataSource={groups}
        loading={loading}
        size="small"
        pagination={{ pageSize: 20, showSizeChanger: true }}
        scroll={{ x: 'max-content' }}
        rowSelection={{
          selectedRowKeys: selectedKeys,
          onChange: setSelectedKeys,
          getCheckboxProps: (record) => ({
            // Disable selection for rows that are fully issued/acked (no pending indents)
            disabled: record.sources?.every((s) => 
              s.ident_status === 'in_mr' || s.qty <= (s.issued_qty ?? 0)
            ),
          }),
        }}
        expandable={{
          expandedRowRender: (r) => (
            <SourcesPanel sources={r.sources || []} uomName={r.uom_name || ''} />
          ),
          rowExpandable: (r) => (r.sources?.length || 0) > 0,
        }}
        locale={{ emptyText: <Empty description="Pool is empty — all indents have been acknowledged" /> }}
      />

      <Modal
        title="Create Consolidated MR(s)"
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onOk={handleConsolidate}
        confirmLoading={submitting}
        okText="Confirm — Create"
      >
        <p>
          You are about to create one or more Material Requests covering{' '}
          <Text strong>{selectedIndentIds.length}</Text> source indent(s) and{' '}
          <Text strong>{selectedKeys.length}</Text> item line(s).
        </p>
        <p>
          One MR per warehouse will be created. Lines with the same item + UOM
          will be merged with summed qty. Source indent items get linked for
          full traceability and won't appear in the pool again.
        </p>
        <p style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>
          The MR(s) will be auto-submitted to the purchase manager for approval.
          You don't need to submit them manually.
        </p>
      </Modal>
    </div>
  );
};

export default DemandPool;
