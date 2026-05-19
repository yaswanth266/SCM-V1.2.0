import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Button, Card, Col, Descriptions, Empty, message, Popconfirm, Row, Select,
  Space, Spin, Table, Tag, Tooltip, Typography,
} from 'antd';
import {
  ArrowLeftOutlined, ReloadOutlined, ShoppingCartOutlined, StarFilled,
  StarOutlined, TrophyOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { formatCurrency, formatDate, getErrorMessage } from '../../utils/helpers';

const { Text, Title } = Typography;

/**
 * QuotationComparison
 * --------------------
 * Side-by-side decision tool: pick an MR -> load all its quotations ->
 * matrix of items (rows) x vendors (columns) with lowest-price highlight,
 * a manual "best technical" flag, and an "Award to Vendor" action that
 * creates a PO via /procurement/purchase-orders/from-quotation
 * (server pre-fills the PO from the chosen quotation's prices, vendor,
 * warehouse, and expected delivery).
 */
const QuotationComparison = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [mrList, setMrList] = useState([]);
  const [mrListLoading, setMrListLoading] = useState(false);

  const [selectedMrId, setSelectedMrId] = useState(null);
  const [mr, setMr] = useState(null);
  const [quotations, setQuotations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [awardingId, setAwardingId] = useState(null);

  // Manual "best technical" flag — keyed by quotation id.
  const [bestTechnicalId, setBestTechnicalId] = useState(null);

  // ---------- loaders ----------
  const loadMRList = useCallback(async () => {
    setMrListLoading(true);
    try {
      const res = await api.get('/procurement/material-requests', {
        params: { page_size: 100, status: 'approved' },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setMrList(items.map((m) => ({
        label: `${m.mr_number} — ${m.department_name || m.request_type || ''}`,
        value: m.id,
        mr: m,
      })));
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setMrListLoading(false);
    }
  }, []);

  const loadComparison = useCallback(async (mrId) => {
    if (!mrId) {
      setMr(null);
      setQuotations([]);
      setBestTechnicalId(null);
      return;
    }
    setLoading(true);
    try {
      const [mrRes, quotRes] = await Promise.all([
        api.get(`/procurement/material-requests/${mrId}`),
        api.get('/procurement/quotations', {
          params: { mr_id: mrId, page_size: 100 },
        }),
      ]);
      setMr(mrRes.data);

      const list = quotRes.data.items || quotRes.data.data || quotRes.data || [];
      // Some list responses omit nested items — fall back to detail fetch.
      const enriched = await Promise.all(
        list.map(async (q) => {
          if (q.items && q.items.length > 0) return q;
          try {
            const det = await api.get(`/procurement/quotations/${q.id}`);
            return det.data;
          } catch {
            return q;
          }
        }),
      );
      setQuotations(enriched);
      setBestTechnicalId(null);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // ---------- effects ----------
  useEffect(() => {
    loadMRList();
  }, [loadMRList]);

  // Allow deep-linking via ?mr_id=123 (e.g. from MR detail "Compare Quotations" button)
  useEffect(() => {
    const qsMr = searchParams.get('mr_id');
    if (qsMr) {
      const id = Number(qsMr);
      setSelectedMrId(id);
      loadComparison(id);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectMR = (val) => {
    setSelectedMrId(val);
    if (val) {
      setSearchParams({ mr_id: String(val) });
    } else {
      setSearchParams({});
    }
    loadComparison(val);
  };

  // ---------- award ----------
  const awardToVendor = async (q) => {
    setAwardingId(q.id);
    try {
      const res = await api.post('/procurement/purchase-orders/from-quotation', {
        quotation_id: q.id,
      });
      const newPo = res.data || {};
      message.success(
        `PO ${newPo.po_number || ''} created from quotation ${q.quotation_number}`.trim(),
      );
      // Pre-fill / open the PO form on the freshly created PO so the user
      // can confirm vendor, prices, terms before submitting for approval.
      if (newPo.id) {
        navigate(`/procurement/purchase-orders/${newPo.id}`);
      } else {
        navigate('/procurement/purchase-orders');
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setAwardingId(null);
    }
  };

  // ---------- table model ----------
  const rows = useMemo(() => {
    if (!mr || quotations.length === 0) return [];
    const mrItems = mr.items || [];

    return mrItems.map((mi) => {
      const row = {
        key: mi.item_id || mi.id,
        item_id: mi.item_id,
        item_code: mi.item_code || (mi.item ? mi.item.item_code : ''),
        item_name: mi.item_name || (mi.item ? (mi.item.name || mi.item.item_name) : '-'),
        qty: Number(mi.qty || mi.quantity || 0),
        uom: mi.uom_name || mi.uom || mi.unit || '',
      };

      let minRate = Infinity;
      quotations.forEach((q) => {
        const qi = (q.items || []).find((x) => x.item_id === mi.item_id);
        const rate = qi ? Number(qi.rate ?? qi.unit_price ?? 0) : null;
        const lineTotal = qi
          ? Number(qi.amount ?? (rate || 0) * Number(qi.qty || row.qty || 0))
          : null;
        row[`v_${q.id}_rate`] = rate;
        row[`v_${q.id}_total`] = lineTotal;
        if (rate !== null && rate > 0 && rate < minRate) minRate = rate;
      });
      row._minRate = minRate === Infinity ? null : minRate;
      return row;
    });
  }, [mr, quotations]);

  // Per-vendor aggregates (bottom summary row).
  const vendorTotals = useMemo(() => {
    const totals = {};
    quotations.forEach((q) => {
      const sum = (q.items || []).reduce((acc, i) => {
        const r = Number(i.rate ?? i.unit_price ?? 0);
        const qy = Number(i.qty ?? 0);
        const amt = i.amount != null ? Number(i.amount) : r * qy;
        return acc + amt;
      }, 0);
      totals[q.id] = q.grand_total != null ? Number(q.grand_total) : sum;
    });
    return totals;
  }, [quotations]);

  const lowestTotalId = useMemo(() => {
    let best = null;
    let min = Infinity;
    Object.entries(vendorTotals).forEach(([qid, t]) => {
      if (t > 0 && t < min) {
        min = t;
        best = Number(qid);
      }
    });
    return best;
  }, [vendorTotals]);

  // ---------- columns ----------
  const columns = useMemo(() => {
    const base = [
      { title: 'Item Code', dataIndex: 'item_code', key: 'code', width: 120, fixed: 'left' },
      { title: 'Item', dataIndex: 'item_name', key: 'name', width: 220, fixed: 'left' },
      { title: 'Qty', dataIndex: 'qty', key: 'qty', width: 80, align: 'right' },
      { title: 'UOM', dataIndex: 'uom', key: 'uom', width: 80 },
    ];

    quotations.forEach((q) => {
      const isLowestTotal = q.id === lowestTotalId;
      const isBestTech = q.id === bestTechnicalId;
      base.push({
        title: (
          <div style={{ textAlign: 'center', minWidth: 200 }}>
            <Space size={4} wrap>
              <Text strong>{q.vendor_name || `Vendor ${q.vendor_id}`}</Text>
              {isLowestTotal && (
                <Tooltip title="Lowest grand total">
                  <Tag color="green" icon={<TrophyOutlined />} style={{ marginLeft: 4 }}>L1</Tag>
                </Tooltip>
              )}
              {isBestTech && (
                <Tooltip title="Best technical (manual)">
                  <Tag color="purple" icon={<StarFilled />}>Tech</Tag>
                </Tooltip>
              )}
            </Space>
            <div style={{ fontSize: 11, color: '#888' }}>{q.quotation_number}</div>
          </div>
        ),
        children: [
          {
            title: 'Unit Price',
            dataIndex: `v_${q.id}_rate`,
            key: `v_${q.id}_rate`,
            width: 130,
            align: 'right',
            render: (val, record) => {
              if (val == null) return <Text type="secondary">N/A</Text>;
              const isLowest = val === record._minRate && record._minRate > 0;
              return (
                <span
                  style={isLowest ? {
                    background: '#f6ffed',
                    color: '#389e0d',
                    fontWeight: 600,
                    padding: '2px 6px',
                    borderRadius: 4,
                    display: 'inline-block',
                  } : {}}
                >
                  {formatCurrency(val)}
                  {isLowest && <TrophyOutlined style={{ marginLeft: 4, color: '#52c41a' }} />}
                </span>
              );
            },
          },
          {
            title: 'Line Total',
            dataIndex: `v_${q.id}_total`,
            key: `v_${q.id}_total`,
            width: 130,
            align: 'right',
            render: (val) => (val == null ? <Text type="secondary">N/A</Text> : formatCurrency(val)),
          },
        ],
      });
    });
    return base;
  }, [quotations, lowestTotalId, bestTechnicalId]);

  // Footer summary row spanning fixed cols + each vendor pair.
  const summaryRow = () => {
    if (quotations.length === 0) return null;
    return (
      <Table.Summary fixed>
        <Table.Summary.Row>
          <Table.Summary.Cell index={0} colSpan={4}>
            <Text strong>Grand Total</Text>
          </Table.Summary.Cell>
          {quotations.map((q, idx) => {
            const total = vendorTotals[q.id] || 0;
            const isLowest = q.id === lowestTotalId;
            return (
              <React.Fragment key={q.id}>
                <Table.Summary.Cell index={4 + idx * 2} align="right">
                  <Text strong style={isLowest ? { color: '#389e0d' } : {}}>
                    {formatCurrency(total)}
                  </Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={4 + idx * 2 + 1} align="right">
                  <Tooltip title={`Lead time: ${q.delivery_days ?? '-'} days`}>
                    <Text type="secondary">{q.delivery_days ? `${q.delivery_days}d` : '—'}</Text>
                  </Tooltip>
                </Table.Summary.Cell>
              </React.Fragment>
            );
          })}
        </Table.Summary.Row>
      </Table.Summary>
    );
  };

  // ---------- vendor summary cards ----------
  const renderVendorCards = () => (
    <Row gutter={[16, 16]}>
      {quotations.map((q) => {
        const total = vendorTotals[q.id] || 0;
        const isLowestTotal = q.id === lowestTotalId;
        const isBestTech = q.id === bestTechnicalId;
        const accent = isLowestTotal && isBestTech
          ? '#52c41a'
          : isLowestTotal
            ? '#52c41a'
            : isBestTech
              ? '#722ed1'
              : '#eb2f96';
        return (
          <Col key={q.id} xs={24} sm={12} md={8} lg={6}>
            <Card
              size="small"
              hoverable
              style={{ borderTop: `3px solid ${accent}` }}
              actions={[
                <Button
                  key="tech"
                  type="text"
                  icon={isBestTech ? <StarFilled style={{ color: '#722ed1' }} /> : <StarOutlined />}
                  onClick={() => setBestTechnicalId(isBestTech ? null : q.id)}
                >
                  {isBestTech ? 'Best Tech' : 'Mark Tech'}
                </Button>,
                <Popconfirm
                  key="award"
                  title={`Award PO to ${q.vendor_name || 'this vendor'}?`}
                  description={`Quotation: ${q.quotation_number} • Total: ${formatCurrency(total)}`}
                  okText="Award"
                  okButtonProps={{ loading: awardingId === q.id }}
                  onConfirm={() => awardToVendor(q)}
                >
                  <Button type="link" icon={<ShoppingCartOutlined />} loading={awardingId === q.id}>
                    Award
                  </Button>
                </Popconfirm>,
              ]}
            >
              <div style={{ textAlign: 'center', marginBottom: 8 }}>
                <Title level={5} style={{ margin: 0 }}>{q.vendor_name || `Vendor ${q.vendor_id}`}</Title>
                <Text type="secondary" style={{ fontSize: 12 }}>{q.quotation_number}</Text>
              </div>
              <Space size={4} wrap style={{ marginBottom: 8, justifyContent: 'center', width: '100%' }}>
                {isLowestTotal && <Tag color="green" icon={<TrophyOutlined />}>L1 Lowest</Tag>}
                {isBestTech && <Tag color="purple" icon={<StarFilled />}>Best Tech</Tag>}
                {q.status && <Tag>{q.status}</Tag>}
              </Space>
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="Total">
                  <Text strong style={isLowestTotal ? { color: '#389e0d' } : {}}>
                    {formatCurrency(total)}
                  </Text>
                </Descriptions.Item>
                <Descriptions.Item label="Lead Time">
                  {q.delivery_days != null ? `${q.delivery_days} days` : '—'}
                </Descriptions.Item>
                <Descriptions.Item label="Payment">
                  {q.payment_terms || '—'}
                </Descriptions.Item>
                <Descriptions.Item label="Terms">
                  <Tooltip title={q.remarks || '—'}>
                    <Text ellipsis style={{ maxWidth: 180 }}>{q.remarks || '—'}</Text>
                  </Tooltip>
                </Descriptions.Item>
                <Descriptions.Item label="Valid Until">
                  {q.valid_until ? formatDate(q.valid_until) : '—'}
                </Descriptions.Item>
              </Descriptions>
            </Card>
          </Col>
        );
      })}
    </Row>
  );

  // ---------- render ----------
  return (
    <div>
      <PageHeader
        title="Quotation Comparison"
        subtitle="Side-by-side vendor evaluation against a Material Request"
      >
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => loadComparison(selectedMrId)}
            disabled={!selectedMrId || loading}
          >
            Refresh
          </Button>
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/procurement/quotations')}
          >
            Back to Quotations
          </Button>
        </Space>
      </PageHeader>

      <Card style={{ marginBottom: 16 }}>
        <Row gutter={16} align="middle">
          <Col xs={24} md={10}>
            <Text strong>Material Request</Text>
            <Select
              style={{ width: '100%', marginTop: 6 }}
              placeholder="Select an approved MR to compare quotations"
              options={mrList}
              value={selectedMrId || undefined}
              onChange={handleSelectMR}
              loading={mrListLoading}
              showSearch
              optionFilterProp="label"
              allowClear
            />
          </Col>
          {mr && (
            <Col xs={24} md={14}>
              <Descriptions size="small" column={2} style={{ marginTop: 8 }}>
                <Descriptions.Item label="MR #">{mr.mr_number}</Descriptions.Item>
                <Descriptions.Item label="Type">{mr.request_type}</Descriptions.Item>
                <Descriptions.Item label="Required">{formatDate(mr.required_date)}</Descriptions.Item>
                <Descriptions.Item label="Quotations">{quotations.length}</Descriptions.Item>
              </Descriptions>
            </Col>
          )}
        </Row>
      </Card>

      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
          <Spin size="large" tip="Loading comparison..." />
        </div>
      )}

      {!loading && mr && quotations.length === 0 && (
        <Card>
          <Empty description={`No quotations found for ${mr.mr_number}`} />
        </Card>
      )}

      {!loading && quotations.length > 0 && (
        <>
          <Card style={{ marginBottom: 16 }} title="Item-by-Item Comparison">
            <Table
              dataSource={rows}
              columns={columns}
              rowKey="key"
              pagination={false}
              size="small"
              bordered
              scroll={{ x: 540 + quotations.length * 260 }}
              summary={summaryRow}
            />
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
              <TrophyOutlined style={{ color: '#52c41a' }} /> indicates the lowest unit price for that line.
              Use the "Mark Tech" button on a vendor card to flag the best technical match (manual override).
            </Text>
          </Card>

          <Card title="Vendor Summary & Award">{renderVendorCards()}</Card>
        </>
      )}

      {!loading && !mr && (
        <Card>
          <Empty description="Select a Material Request above to load its quotations for comparison" />
        </Card>
      )}
    </div>
  );
};

export default QuotationComparison;
