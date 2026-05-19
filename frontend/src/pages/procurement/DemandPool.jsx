import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Table, Tag, Space, message, Select, Popconfirm, Input,
  Modal, Empty, Statistic, Row, Col, Card, Typography, Tooltip,
} from 'antd';
import {
  ReloadOutlined, CheckCircleOutlined, FundOutlined, ExportOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { formatNumber, getErrorMessage, formatDate } from '../../utils/helpers';

const { Text } = Typography;

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

  // All indents covered by the selected group rows
  const selectedIndentIds = useMemo(() => {
    const ids = new Set();
    selectedRows.forEach((g) => g.sources.forEach((s) => ids.add(s.indent_id)));
    return [...ids];
  }, [selectedRows]);

  const selectedTotalQty = useMemo(
    () => selectedRows.reduce((sum, g) => sum + (g.total_qty || 0), 0),
    [selectedRows]
  );

  const handleConsolidate = async () => {
    if (selectedIndentIds.length === 0) {
      message.warning('Pick at least one item group first');
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
      title: 'Total Demand',
      dataIndex: 'total_qty',
      width: 130,
      align: 'right',
      sorter: (a, b) => (a.total_qty || 0) - (b.total_qty || 0),
      render: (v, r) => <Text strong>{formatNumber(v)} <Text type="secondary" style={{ fontSize: 11 }}>{r.uom_name || ''}</Text></Text>,
    },
    {
      title: '# Indents',
      dataIndex: 'indent_count',
      width: 90,
      align: 'right',
      render: (v) => <Tag>{v}</Tag>,
    },
    {
      title: 'Source Indents',
      dataIndex: 'sources',
      ellipsis: true,
      render: (sources) => (
        <Tooltip
          title={sources.map((s) => `${s.indent_number} → ${formatNumber(s.qty)}`).join('  ·  ')}
        >
          <span style={{ fontSize: 12 }}>
            {sources.slice(0, 3).map((s) => s.indent_number).join(', ')}
            {sources.length > 3 ? `  +${sources.length - 3} more` : ''}
          </span>
        </Tooltip>
      ),
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
        if (r.stock_status === 'in_stock' && r.sources?.length === 1) {
          return (
            <Tooltip title="Stock available — go to Material Issue prefilled from this indent">
              <Button
                size="small"
                type="link"
                icon={<ExportOutlined />}
                onClick={() => navigate(`/warehouse/material-issues?indent_id=${r.sources[0].indent_id}`)}
              >
                Issue Now
              </Button>
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
        subtitle="Approved indents waiting to be consolidated into bulk MRs (many → one)"
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
        <Col span={6}>
          <Card size="small">
            <Statistic title="Item groups in pool" value={groupCount} prefix={<FundOutlined />} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="Source indents waiting" value={indentCount} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="Selected groups" value={selectedKeys.length} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="Selected total qty" value={selectedTotalQty} precision={2} />
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
        }}
        locale={{ emptyText: <Empty description="Pool is empty — no approved indents waiting" /> }}
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
