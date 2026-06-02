import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Button, Card, Col, Descriptions, Empty, message, Popconfirm, Row, Select,
  Space, Spin, Table, Tag, Tooltip, Typography, Checkbox, InputNumber, Collapse,
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
 * Side-by-side decision tool: pick an RFQ -> load all supplier quotations ->
 * matrix of items (rows) x vendors (columns) with lowest-price highlight,
 * a manual "best technical" flag, and an "Award to Vendor" action that
 * creates a PO via /procurement/purchase-orders/from-quotation
 * (server pre-fills the PO from the chosen quotation's prices, vendor,
 * warehouse, and expected delivery).
 */
const QuotationComparison = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [rfqList, setRfqList] = useState([]);
  const [rfqListLoading, setRfqListLoading] = useState(false);

  const [selectedRfqNumber, setSelectedRfqNumber] = useState(null);
  const [rfq, setRfq] = useState(null);
  const [quotations, setQuotations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [awardingId, setAwardingId] = useState(null);

  // Manual "best technical" flag — keyed by quotation id.
  const [bestTechnicalId, setBestTechnicalId] = useState(null);

  // Split PO awarding selections and quantities
  const [awardedItems, setAwardedItems] = useState({});
  const [splitAwardLoading, setSplitAwardLoading] = useState(false);

  const handleAwardCheck = (itemId, vendorId, checked, maxQty, rate, quotationId) => {
    setAwardedItems((prev) => {
      const itemAwards = prev[itemId] ? { ...prev[itemId] } : {};
      if (checked) {
        itemAwards[vendorId] = {
          checked: true,
          qty: maxQty,
          rate: rate,
          quotation_id: quotationId,
        };
      } else {
        delete itemAwards[vendorId];
      }
      return { ...prev, [itemId]: itemAwards };
    });
  };

  const handleAwardQtyChange = (itemId, vendorId, qty) => {
    setAwardedItems((prev) => {
      const itemAwards = prev[itemId] ? { ...prev[itemId] } : {};
      if (itemAwards[vendorId]) {
        itemAwards[vendorId] = {
          ...itemAwards[vendorId],
          qty: qty,
        };
      }
      return { ...prev, [itemId]: itemAwards };
    });
  };

  const totalSelectedCount = useMemo(() => {
    let count = 0;
    Object.values(awardedItems).forEach((itemAwards) => {
      Object.values(itemAwards).forEach((award) => {
        if (award.checked) count++;
      });
    });
    return count;
  }, [awardedItems]);

  const autoAllocateL1 = () => {
    const newAwards = {};
    rows.forEach((row) => {
      let bestVendor = null;
      let bestQ = null;
      quotations.forEach((q) => {
        const qi = (q.items || []).find((x) => x.item_id === row.item_id);
        const rate = qi ? Number(qi.rate ?? qi.unit_price ?? 0) : null;
        if (rate !== null && rate === row._minRate) {
          bestVendor = q.vendor_id;
          bestQ = q;
        }
      });

      if (bestVendor && bestQ) {
        const qi = bestQ.items.find((x) => x.item_id === row.item_id);
        const bidQty = qi ? Number(qi.qty || 0) : row.qty;
        newAwards[row.item_id] = {
          [bestVendor]: {
            checked: true,
            qty: bidQty,
            rate: row._minRate,
            quotation_id: bestQ.id,
          },
        };
      }
    });
    setAwardedItems(newAwards);
    message.success('Auto-allocated all items to L1 suppliers at their full bid quantity.');
  };

  const submitSplitAward = async () => {
    setSplitAwardLoading(true);
    try {
      // Validate that total awarded quantity for each item does not exceed required quantity
      if (rfq && rfq.items) {
        for (const mi of rfq.items) {
          const itemId = mi.item_id || mi.id;
          const requiredQty = Number(mi.qty || mi.quantity || 0);
          
          let totalAwarded = 0;
          const itemAwards = awardedItems[itemId] || {};
          Object.values(itemAwards).forEach((award) => {
            if (award.checked) {
              totalAwarded += Number(award.qty || 0);
            }
          });

          if (totalAwarded > requiredQty + 0.0001) {
            message.error(
              `Total awarded quantity for item "${mi.item_name || 'Item'}" (${totalAwarded}) exceeds the required quantity (${requiredQty}). Please adjust your awards.`
            );
            setSplitAwardLoading(false);
            return;
          }
        }
      }

      const awardsList = [];
      Object.entries(awardedItems).forEach(([itemId, itemAwards]) => {
        Object.entries(itemAwards).forEach(([vendorId, award]) => {
          if (award.checked && award.qty > 0) {
            awardsList.push({
              item_id: Number(itemId),
              vendor_id: Number(vendorId),
              qty: Number(award.qty),
              rate: Number(award.rate),
              quotation_id: Number(award.quotation_id),
            });
          }
        });
      });

      const payload = {
        rfq_number: rfq.rfq_number,
        mr_id: rfq.mr_id,
        awards: awardsList,
      };

      const res = await api.post('/procurement/purchase-orders/consolidate-split', payload);
      const data = res.data || {};
      message.success(data.message || 'Successfully created split Purchase Orders!');
      setAwardedItems({});
      navigate('/procurement/purchase-orders');
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setSplitAwardLoading(false);
    }
  };

  // ---------- loaders ----------
  const loadRFQList = useCallback(async () => {
    setRfqListLoading(true);
    try {
      const res = await api.get('/procurement/rfqs', { params: { page_size: 100 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setRfqList(items.map((r) => ({
        label: `${r.rfq_number}${r.mr_number ? ` - ${r.mr_number}` : ''}`,
        value: r.rfq_number,
        rfq: r,
      })));
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setRfqListLoading(false);
    }
  }, []);

  const loadComparison = useCallback(async (rfqNumber) => {
    if (!rfqNumber) {
      setRfq(null);
      setQuotations([]);
      setBestTechnicalId(null);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get(`/procurement/rfqs/${encodeURIComponent(rfqNumber)}`);
      const data = res.data;
      setRfq({
        ...data,
        items: data.quotations?.[0]?.items || [],
      });
      setQuotations(data.quotations || []);
      setBestTechnicalId(null);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // ---------- effects ----------
  useEffect(() => {
    loadRFQList();
  }, [loadRFQList]);

  // Allow deep-linking via ?rfq_number=RFQ-123.
  useEffect(() => {
    const qsRfq = searchParams.get('rfq_number');
    if (qsRfq) {
      setSelectedRfqNumber(qsRfq);
      loadComparison(qsRfq);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectRFQ = (val) => {
    setSelectedRfqNumber(val);
    if (val) {
      setSearchParams({ rfq_number: String(val) });
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
    if (!rfq || quotations.length === 0) return [];
    const mrItems = rfq.items || [];

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
  }, [rfq, quotations]);

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
            <div style={{ fontSize: 11, marginTop: 4 }}>
              {q.with_vehicle ? (
                <Tag color="blue" style={{ margin: 0 }}>
                  Logistics: {formatCurrency(q.vehicle_cost)}
                </Tag>
              ) : (
                <Tag color="default" style={{ margin: 0 }}>No Vehicle</Tag>
              )}
            </div>
          </div>
        ),
        children: [
          {
            title: 'Unit Price',
            dataIndex: `v_${q.id}_rate`,
            key: `v_${q.id}_rate`,
            width: 120,
            align: 'right',
            render: (val, record) => {
              if (val == null) return <Text type="secondary">N/A</Text>;
              const isLowest = val === record._minRate && record._minRate > 0;
              
              const qi = q.items.find((x) => x.item_id === record.item_id);
              let taxText = '';
              if (qi) {
                const cg = Number(qi.cgst_rate || 0);
                const sg = Number(qi.sgst_rate || 0);
                const ig = Number(qi.igst_rate || 0);
                const tx = Number(qi.tax_rate || 0);
                const disc = Number(qi.discount_pct || 0);
                
                const parts = [];
                if (ig > 0) {
                  parts.push(`IGST ${ig}%`);
                } else if (cg > 0 || sg > 0) {
                  parts.push(`CGST ${cg}% + SGST ${sg}%`);
                } else if (tx > 0) {
                  parts.push(`Tax ${tx}%`);
                }
                
                if (disc > 0) {
                  parts.push(`Disc ${disc}%`);
                }
                
                if (parts.length > 0) {
                  taxText = parts.join(' · ');
                }
              }

              return (
                <Space direction="vertical" size={0} style={{ textAlign: 'right', width: '100%' }}>
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
                  {taxText && (
                    <div style={{ fontSize: '11px', color: '#64748b', marginTop: 2 }}>
                      {taxText}
                    </div>
                  )}
                </Space>
              );
            },
          },
          {
            title: 'Award Qty',
            key: `v_${q.id}_award`,
            width: 160,
            align: 'center',
            render: (_, record) => {
              const qi = q.items.find(x => x.item_id === record.item_id);
              if (!qi) return <Text type="secondary">—</Text>;
              const bidQty = Number(qi.qty || 0);
              const awardState = awardedItems[record.item_id]?.[q.vendor_id] || { checked: false, qty: 0 };
              
              return (
                <Space size={4} align="center">
                  <Checkbox
                    checked={awardState.checked}
                    onChange={(e) => handleAwardCheck(
                      record.item_id,
                      q.vendor_id,
                      e.target.checked,
                      bidQty,
                      qi.rate,
                      q.id
                    )}
                  />
                  {awardState.checked && (
                    <InputNumber
                      value={awardState.qty}
                      min={0.001}
                      max={bidQty}
                      step={0.01}
                      size="small"
                      style={{ width: 70 }}
                      onChange={(val) => {
                        let num = parseFloat(val);
                        if (isNaN(num)) num = 0;
                        if (num > bidQty) num = bidQty;
                        handleAwardQtyChange(record.item_id, q.vendor_id, num);
                      }}
                    />
                  )}
                  <span style={{ fontSize: '11px', color: '#888' }}>
                    /{bidQty}
                  </span>
                </Space>
              );
            }
          },
          {
            title: 'Line Total',
            dataIndex: `v_${q.id}_total`,
            key: `v_${q.id}_total`,
            width: 120,
            align: 'right',
            render: (val) => (val == null ? <Text type="secondary">N/A</Text> : formatCurrency(val)),
          },
        ],
      });
    });
    return base;
  }, [quotations, lowestTotalId, bestTechnicalId, awardedItems]);

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
                <Descriptions.Item label="Subtotal">
                  <Text style={{ fontFamily: 'monospace' }}>
                    {formatCurrency(q.subtotal || q.total_amount || 0)}
                  </Text>
                </Descriptions.Item>
                {(Number(q.cgst_amount || 0) > 0 || Number(q.sgst_amount || 0) > 0) && (
                  <>
                    <Descriptions.Item label="CGST">
                      <Text style={{ fontFamily: 'monospace' }}>
                        {formatCurrency(q.cgst_amount || 0)}
                      </Text>
                    </Descriptions.Item>
                    <Descriptions.Item label="SGST">
                      <Text style={{ fontFamily: 'monospace' }}>
                        {formatCurrency(q.sgst_amount || 0)}
                      </Text>
                    </Descriptions.Item>
                  </>
                )}
                {Number(q.igst_amount || 0) > 0 && (
                  <Descriptions.Item label="IGST">
                    <Text style={{ fontFamily: 'monospace' }}>
                      {formatCurrency(q.igst_amount || 0)}
                    </Text>
                  </Descriptions.Item>
                )}
                {Number(q.tax_amount || 0) > 0 && Number(q.cgst_amount || 0) === 0 && Number(q.igst_amount || 0) === 0 && (
                  <Descriptions.Item label="Tax">
                    <Text style={{ fontFamily: 'monospace' }}>
                      {formatCurrency(q.tax_amount || 0)}
                    </Text>
                  </Descriptions.Item>
                )}
                <Descriptions.Item label="Logistics Fee">
                  <Text style={{ fontFamily: 'monospace' }}>
                    {q.with_vehicle ? formatCurrency(q.vehicle_cost || 0) : '— (Excluded)'}
                  </Text>
                </Descriptions.Item>
                <Descriptions.Item label="Grand Total">
                  <Text strong style={isLowestTotal ? { color: '#389e0d', fontFamily: 'monospace' } : { fontFamily: 'monospace' }}>
                    {formatCurrency(q.grand_total || total)}
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
        title="RFQ Comparison"
        subtitle="Side-by-side supplier evaluation against an RFQ"
      >
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => loadComparison(selectedRfqNumber)}
            disabled={!selectedRfqNumber || loading}
          >
            Refresh
          </Button>
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/procurement/quotations')}
          >
            Back to RFQs
          </Button>
        </Space>
      </PageHeader>

      <Card style={{ marginBottom: 16 }}>
        <Row gutter={16} align="middle">
          <Col xs={24} md={10}>
            <Text strong>RFQ</Text>
            <Select
              style={{ width: '100%', marginTop: 6 }}
              placeholder="Select an RFQ to compare supplier quotations"
              options={rfqList}
              value={selectedRfqNumber || undefined}
              onChange={handleSelectRFQ}
              loading={rfqListLoading}
              showSearch
              optionFilterProp="label"
              allowClear
            />
          </Col>
          {rfq && (
            <Col xs={24} md={14}>
              <Descriptions size="small" column={2} style={{ marginTop: 8 }}>
                <Descriptions.Item label="RFQ #">{rfq.rfq_number}</Descriptions.Item>
                <Descriptions.Item label="MR #">{rfq.mr_number || '-'}</Descriptions.Item>
                <Descriptions.Item label="Valid Until">{formatDate(rfq.valid_until)}</Descriptions.Item>
                <Descriptions.Item label="Quotations">{quotations.length}</Descriptions.Item>
              </Descriptions>
            </Col>
          )}
        </Row>
      </Card>

      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
          <Spin size="large" tip="Loading RFQ comparison..." />
        </div>
      )}

      {!loading && rfq && quotations.length === 0 && (
        <Card>
          <Empty description={`No supplier quotations found for ${rfq.rfq_number}`} />
        </Card>
      )}

      {!loading && quotations.length > 0 && (
        <>
          {/* Card 1: RFQ Requested Items */}
          <Card style={{ marginBottom: 16 }} title="RFQ Requested Items">
            <Table
              dataSource={rfq.items.map((line, idx) => ({ ...line, key: line.id || idx }))}
              pagination={false}
              size="small"
              bordered
              columns={[
                { title: '#', width: 50, render: (_, __, idx) => idx + 1 },
                { title: 'Item Code', dataIndex: 'item_code', width: 150 },
                { title: 'Item Name', dataIndex: 'item_name' },
                { title: 'Required Qty', dataIndex: 'qty', width: 150, align: 'right', render: (val) => Number(val).toLocaleString('en-IN') },
                { title: 'UOM', dataIndex: 'uom', width: 120 }
              ]}
            />
          </Card>

          {/* Card 2: Vendor Summary & Award */}
          <Card title="Vendor Summary & Award" style={{ marginBottom: 16 }}>
            {renderVendorCards()}
          </Card>

          {/* Card 3: Collapsible Item-by-Item RFQ Comparison */}
          <Card title="Item-by-Item Sourcing Matrix (Bids & Split Awarding)">
            <div style={{
              marginBottom: 16,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: '#f9f9f9',
              padding: '12px 16px',
              borderRadius: '8px',
              border: '1px solid #e8e8e8',
              flexWrap: 'wrap',
              gap: '12px'
            }}>
              <Space>
                <Button
                  type="primary"
                  ghost
                  icon={<TrophyOutlined />}
                  onClick={autoAllocateL1}
                >
                  Auto-Select L1 Rates
                </Button>
                <Button
                  onClick={() => setAwardedItems({})}
                  disabled={Object.keys(awardedItems).length === 0}
                >
                  Clear Selection
                </Button>
              </Space>
              <Space size={16}>
                <Text strong>Selected Items for Split Award: <Tag color="blue" style={{ fontSize: '14px', margin: 0 }}>{totalSelectedCount}</Tag></Text>
                <Button
                  type="primary"
                  icon={<ShoppingCartOutlined />}
                  onClick={submitSplitAward}
                  disabled={totalSelectedCount === 0}
                  loading={splitAwardLoading}
                >
                  Confirm Split Award
                </Button>
              </Space>
            </div>

            <Collapse defaultActiveKey={rfq.items.map((mi) => String(mi.item_id || mi.id))}>
              {rfq.items.map((mi) => {
                const itemId = mi.item_id || mi.id;
                
                // Find all bids for this item across all suppliers
                const supplierBids = quotations.map((q) => {
                  const qi = (q.items || []).find((x) => x.item_id === itemId);
                  return {
                    quotation: q,
                    bidItem: qi,
                    rate: qi ? Number(qi.rate ?? qi.unit_price ?? 0) : null,
                  };
                }).filter(b => b.bidItem !== undefined);

                // Identify L1 price for this item
                const validRates = supplierBids.map(b => b.rate).filter(r => r !== null && r > 0);
                const minRate = validRates.length > 0 ? Math.min(...validRates) : null;

                const header = (
                  <Row style={{ width: '100%' }} align="middle">
                    <Col span={6}>
                      <Text strong style={{ color: '#0284c7' }}>{mi.item_code}</Text>
                    </Col>
                    <Col span={10}>
                      <Text strong>{mi.item_name}</Text>
                    </Col>
                    <Col span={8} style={{ textAlign: 'right', paddingRight: '24px' }}>
                      <Text type="secondary">Required: </Text>
                      <Text strong>{Number(mi.qty).toLocaleString('en-IN')} {mi.uom}</Text>
                    </Col>
                  </Row>
                );

                return (
                  <Collapse.Panel header={header} key={String(itemId)}>
                    <Table
                      dataSource={supplierBids}
                      rowKey={(b) => b.quotation.id}
                      pagination={false}
                      size="small"
                      bordered
                      columns={[
                        {
                          title: 'Supplier',
                          key: 'supplier',
                          render: (_, b) => (
                            <Space direction="vertical" size={0}>
                              <Text strong>{b.quotation.vendor_name || `Vendor ${b.quotation.vendor_id}`}</Text>
                              <Text type="secondary" style={{ fontSize: '11px' }}>{b.quotation.quotation_number}</Text>
                            </Space>
                          )
                        },
                        {
                          title: 'Delivery Days',
                          key: 'delivery',
                          width: 120,
                          render: (_, b) => (
                            <Text>{b.quotation.delivery_days ? `${b.quotation.delivery_days} days` : '—'}</Text>
                          )
                        },
                        {
                          title: 'Logistics Cost',
                          key: 'logistics',
                          width: 180,
                          render: (_, b) => (
                            b.quotation.with_vehicle ? (
                              <Tag color="blue">Logistics: {formatCurrency(b.quotation.vehicle_cost)}</Tag>
                            ) : (
                              <Tag color="default">No Vehicle</Tag>
                            )
                          )
                        },
                        {
                          title: 'Unit Price',
                          key: 'unit_price',
                          width: 140,
                          align: 'right',
                          render: (_, b) => {
                            const val = b.rate;
                            if (val == null) return <Text type="secondary">N/A</Text>;
                            const isLowest = val === minRate && minRate > 0;
                            
                            let taxText = '';
                            if (b.bidItem) {
                              const cg = Number(b.bidItem.cgst_rate || 0);
                              const sg = Number(b.bidItem.sgst_rate || 0);
                              const ig = Number(b.bidItem.igst_rate || 0);
                              const tx = Number(b.bidItem.tax_rate || 0);
                              const disc = Number(b.bidItem.discount_pct || 0);
                              
                              const parts = [];
                              if (ig > 0) {
                                parts.push(`IGST ${ig}%`);
                              } else if (cg > 0 || sg > 0) {
                                parts.push(`CGST ${cg}% + SGST ${sg}%`);
                              } else if (tx > 0) {
                                parts.push(`Tax ${tx}%`);
                              }
                              
                              if (disc > 0) {
                                parts.push(`Disc ${disc}%`);
                              }
                              
                              if (parts.length > 0) {
                                taxText = parts.join(' · ');
                              }
                            }

                            return (
                              <Space direction="vertical" size={0} style={{ textAlign: 'right', width: '100%' }}>
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
                                {taxText && (
                                  <div style={{ fontSize: '11px', color: '#64748b', marginTop: 2 }}>
                                    {taxText}
                                  </div>
                                )}
                              </Space>
                            );
                          }
                        },
                        {
                          title: 'Award Quantity',
                          key: 'award_qty',
                          width: 200,
                          align: 'center',
                          render: (_, b) => {
                            const bidQty = Number(b.bidItem?.qty || 0);
                            const awardState = awardedItems[itemId]?.[b.quotation.vendor_id] || { checked: false, qty: 0 };
                            return (
                              <Space size={8} align="center">
                                <Checkbox
                                  checked={awardState.checked}
                                  onChange={(e) => handleAwardCheck(
                                    itemId,
                                    b.quotation.vendor_id,
                                    e.target.checked,
                                    bidQty,
                                    b.rate,
                                    b.quotation.id
                                  )}
                                />
                                {awardState.checked && (
                                  <InputNumber
                                    value={awardState.qty}
                                    min={0.001}
                                    max={bidQty}
                                    step={0.01}
                                    size="small"
                                    style={{ width: 80 }}
                                    onChange={(val) => {
                                      let num = parseFloat(val);
                                      if (isNaN(num)) num = 0;
                                      if (num > bidQty) num = bidQty;
                                      handleAwardQtyChange(itemId, b.quotation.vendor_id, num);
                                    }}
                                  />
                                )}
                                <span style={{ fontSize: '11px', color: '#888' }}>
                                  /{bidQty}
                                </span>
                              </Space>
                            );
                          }
                        },
                        {
                          title: 'Award Line Total',
                          key: 'line_total',
                          width: 150,
                          align: 'right',
                          render: (_, b) => {
                            const awardState = awardedItems[itemId]?.[b.quotation.vendor_id];
                            if (!awardState || !awardState.checked) return <Text type="secondary">—</Text>;
                            const total = Number(awardState.qty || 0) * Number(b.rate || 0);
                            return <Text strong>{formatCurrency(total)}</Text>;
                          }
                        }
                      ]}
                    />
                  </Collapse.Panel>
                );
              })}
            </Collapse>
          </Card>
        </>
      )}

      {!loading && !rfq && (
        <Card>
          <Empty description="Select an RFQ above to load supplier quotations for comparison" />
        </Card>
      )}
    </div>
  );
};

export default QuotationComparison;
