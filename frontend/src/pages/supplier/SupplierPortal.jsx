import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Table, Tag, Badge, Spin, Typography, message, Button, Modal,
  Form, Input, InputNumber, Checkbox, Space, Tooltip, Tabs, Descriptions, Alert,
  Empty, Row, Col, Statistic, Divider, DatePicker,
} from 'antd';
import dayjs from 'dayjs';
import {
  ShoppingOutlined, FileTextOutlined, CheckCircleOutlined,
  CloseCircleOutlined, EditOutlined, KeyOutlined, UserOutlined,
  LockOutlined, LogoutOutlined, DollarOutlined, ClockCircleOutlined,
  FileSearchOutlined, ExclamationCircleOutlined, SendOutlined, CalendarOutlined,
} from '@ant-design/icons';
import vendorApi from '../../config/vendorApi';
import useVendorAuthStore from '../../store/vendorAuthStore';

const { Title, Paragraph, Text } = Typography;

/* ─── Status colour mapping ─── */
const QUOTE_STATUS_CONFIG = {
  draft: { color: 'orange', label: 'Open / Awaiting Quote' },
  submitted: { color: 'blue', label: 'Quote Submitted' },
  accepted: { color: 'success', label: 'Accepted' },
  rejected: { color: 'red', label: 'Rejected' },
  cancelled: { color: 'default', label: 'Cancelled' },
};

const MR_STATUS_CONFIG = {
  approved: { color: 'green', label: 'Approved' },
  ordered: { color: 'blue', label: 'Ordered' },
  pending_approval: { color: 'orange', label: 'Pending Approval' },
  draft: { color: 'default', label: 'Draft' },
};

/* ─── Helpers ─── */
const fmt = (n) => {
  const num = parseFloat(n || 0);
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(num);
};

const fmtDate = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
};

const toDateInput = (d) => {
  if (!d) return undefined;
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10);
};

/* ─── Quote Item Table (inside modal) ─── */
function QuoteItemsForm({ rfq, form, disabled }) {
  const items = rfq?.items || [];

  const computeAmount = (idx) => {
    const values = form.getFieldValue(['items', idx]) || {};
    const qty = parseFloat(values.qty || 0);
    const rate = parseFloat(values.rate || 0);
    const disc = parseFloat(values.discount_pct || 0);
    const cgst = parseFloat(values.cgst_rate || 0);
    const sgst = parseFloat(values.sgst_rate || 0);
    const igst = parseFloat(values.igst_rate || 0);
    const gross = qty * rate;
    const discAmt = gross * (disc / 100);
    const net = gross - discAmt;
    const taxAmt = net * ((cgst + sgst + igst) / 100);
    return (net + taxAmt).toFixed(2);
  };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr style={{ background: '#f1f5f9', borderBottom: '2px solid #e2e8f0' }}>
            <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, color: '#475569' }}>Item</th>
            <th style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#475569' }}>Req. Qty</th>
            <th style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#475569' }}>Your Qty</th>
            <th style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#475569' }}>Rate (₹)</th>
            <th style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#475569' }}>Disc %</th>
            <th style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#475569' }}>CGST %</th>
            <th style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#475569' }}>SGST %</th>
            <th style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#475569' }}>IGST %</th>
            <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, color: '#475569' }}>Remarks</th>
            <th style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#475569' }}>Amount (₹)</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, idx) => (
            <tr key={item.id || idx} style={{ borderBottom: '1px solid #e2e8f0' }}>
              <td style={{ padding: '10px 12px', verticalAlign: 'middle' }}>
                <div style={{ fontWeight: 600, color: '#1e293b' }}>{item.item_name || '—'}</div>
                <div style={{ color: '#64748b', fontSize: '11px', fontFamily: 'monospace' }}>{item.item_code}</div>
                <Form.Item name={['items', idx, 'item_id']} hidden initialValue={item.item_id}>
                  <Input />
                </Form.Item>
                <Form.Item name={['items', idx, 'uom_id']} hidden initialValue={item.uom_id}>
                  <Input />
                </Form.Item>
              </td>
              <td style={{ padding: '10px 12px', textAlign: 'right', color: '#64748b', fontFamily: 'monospace' }}>
                {item.qty} {item.uom}
              </td>
              <td style={{ padding: '6px 12px', textAlign: 'right' }}>
                <Form.Item
                  name={['items', idx, 'qty']}
                  rules={[{ required: true, message: 'Required' }]}
                  style={{ margin: 0 }}
                  initialValue={item.qty}
                >
                  <InputNumber min={0.01} step={0.01} style={{ width: 90 }} disabled={disabled} />
                </Form.Item>
              </td>
              <td style={{ padding: '6px 12px', textAlign: 'right' }}>
                <Form.Item
                  name={['items', idx, 'rate']}
                  rules={[{ required: true, message: 'Required' }]}
                  style={{ margin: 0 }}
                >
                  <InputNumber min={0} step={0.01} prefix="₹" style={{ width: 110 }} disabled={disabled} />
                </Form.Item>
              </td>
              <td style={{ padding: '6px 12px', textAlign: 'right' }}>
                <Form.Item name={['items', idx, 'discount_pct']} style={{ margin: 0 }} initialValue={0}>
                  <InputNumber min={0} max={100} step={0.5} style={{ width: 70 }} disabled={disabled} />
                </Form.Item>
              </td>
              <td style={{ padding: '6px 12px', textAlign: 'right' }}>
                <Form.Item name={['items', idx, 'cgst_rate']} style={{ margin: 0 }} initialValue={0}>
                  <InputNumber
                    min={0}
                    max={100}
                    step={0.5}
                    style={{ width: 70 }}
                    disabled={disabled}
                    onChange={(val) => {
                      if (val > 0) {
                        const itemsVal = form.getFieldValue('items') || [];
                        itemsVal[idx] = { ...itemsVal[idx], igst_rate: 0 };
                        form.setFieldsValue({ items: itemsVal });
                      }
                    }}
                  />
                </Form.Item>
              </td>
              <td style={{ padding: '6px 12px', textAlign: 'right' }}>
                <Form.Item name={['items', idx, 'sgst_rate']} style={{ margin: 0 }} initialValue={0}>
                  <InputNumber
                    min={0}
                    max={100}
                    step={0.5}
                    style={{ width: 70 }}
                    disabled={disabled}
                    onChange={(val) => {
                      if (val > 0) {
                        const itemsVal = form.getFieldValue('items') || [];
                        itemsVal[idx] = { ...itemsVal[idx], igst_rate: 0 };
                        form.setFieldsValue({ items: itemsVal });
                      }
                    }}
                  />
                </Form.Item>
              </td>
              <td style={{ padding: '6px 12px', textAlign: 'right' }}>
                <Form.Item name={['items', idx, 'igst_rate']} style={{ margin: 0 }} initialValue={0}>
                  <InputNumber
                    min={0}
                    max={100}
                    step={0.5}
                    style={{ width: 70 }}
                    disabled={disabled}
                    onChange={(val) => {
                      if (val > 0) {
                        const itemsVal = form.getFieldValue('items') || [];
                        itemsVal[idx] = { ...itemsVal[idx], cgst_rate: 0, sgst_rate: 0 };
                        form.setFieldsValue({ items: itemsVal });
                      }
                    }}
                  />
                </Form.Item>
              </td>
              <td style={{ padding: '6px 12px' }}>
                <Form.Item name={['items', idx, 'remarks']} style={{ margin: 0 }}>
                  <Input placeholder="Optional" style={{ minWidth: 140 }} disabled={disabled} />
                </Form.Item>
              </td>
              <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#0f172a', fontFamily: 'monospace' }}>
                <Form.Item noStyle shouldUpdate>
                  {() => computeAmount(idx)}
                </Form.Item>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Main Portal ─── */
export default function SupplierPortal() {
  const { user, logout } = useVendorAuthStore();
  const [rfqs, setRfqs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [quoteModalVisible, setQuoteModalVisible] = useState(false);
  const [isQuoteViewOnly, setIsQuoteViewOnly] = useState(false);
  const [selectedRfq, setSelectedRfq] = useState(null);
  const [quoteSubmitting, setQuoteSubmitting] = useState(false);
  const [declineConfirm, setDeclineConfirm] = useState(null);
  const [changePassVisible, setChangePassVisible] = useState(false);
  const [changePassLoading, setChangePassLoading] = useState(false);
  const [quoteForm] = Form.useForm();
  const [passForm] = Form.useForm();
  const { changePassword } = useVendorAuthStore();

  /* Purchase Order Acknowledgment states */
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [poLoading, setPoLoading] = useState(false);
  const [poModalVisible, setPoModalVisible] = useState(false);
  const [selectedPo, setSelectedPo] = useState(null);
  const [selectedPoDetails, setSelectedPoDetails] = useState(null);
  const [poDetailsLoading, setPoDetailsLoading] = useState(false);
  const [poActionLoading, setPoActionLoading] = useState(false);
  const [rejectReasonVisible, setRejectReasonVisible] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  /* Must change password on first login */
  const mustChange = user?.must_change_password;

  const fetchRfqs = useCallback(async () => {
    try {
      setLoading(true);
      const res = await vendorApi.get('/supplier/rfqs');
      setRfqs(res.data || []);
    } catch (err) {
      message.error('Failed to load RFQs. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchPurchaseOrders = useCallback(async () => {
    try {
      setPoLoading(true);
      const res = await vendorApi.get('/supplier/purchase-orders');
      setPurchaseOrders(res.data?.items || []);
    } catch (err) {
      message.error('Failed to load Purchase Orders. Please try again.');
    } finally {
      setPoLoading(false);
    }
  }, []);

  const handleOpenPoDetails = async (po) => {
    setSelectedPo(po);
    setPoModalVisible(true);
    setRejectReasonVisible(false);
    setRejectReason('');
    setSelectedPoDetails(null);
    try {
      setPoDetailsLoading(true);
      const res = await vendorApi.get(`/supplier/purchase-orders/${po.id}`);
      setSelectedPoDetails(res.data || null);
    } catch (err) {
      message.error(err?.response?.data?.detail || 'Failed to fetch Purchase Order details');
      setPoModalVisible(false);
    } finally {
      setPoDetailsLoading(false);
    }
  };

  const handleAcknowledgePO = async (poId, action, remarks = '') => {
    try {
      setPoActionLoading(true);
      const res = await vendorApi.post(`/supplier/purchase-orders/${poId}/acknowledge`, {
        action,
        remarks,
      });
      message.success(res.data?.message || `Purchase order ${action}ed successfully!`);
      setPoModalVisible(false);
      fetchPurchaseOrders();
    } catch (err) {
      message.error(err?.response?.data?.detail || `Failed to ${action} Purchase Order`);
    } finally {
      setPoActionLoading(false);
    }
  };

  useEffect(() => {
    if (!mustChange) {
      fetchRfqs();
      fetchPurchaseOrders();
    }
  }, [fetchRfqs, fetchPurchaseOrders, mustChange]);

  /* ── Open Quote Modal ── */
  const handleOpenQuote = (rfq, viewOnly = false) => {
    setIsQuoteViewOnly(viewOnly);
    setSelectedRfq(rfq);
    // Pre-fill from existing quote if present
    const existing = rfq.my_quote;
    const initialItems = rfq.items.map((item) => {
      const qi = existing?.items?.find((q) => q.item_id === item.item_id);
      let cg = qi?.cgst_rate ?? 0;
      let sg = qi?.sgst_rate ?? 0;
      let ig = qi?.igst_rate ?? 0;
      if (cg === 0 && sg === 0 && ig === 0 && qi?.tax_rate > 0) {
        cg = qi.tax_rate / 2;
        sg = qi.tax_rate / 2;
      }
      return {
        item_id: item.item_id,
        uom_id: item.uom_id,
        qty: qi?.qty ?? item.qty,
        rate: qi?.rate ?? undefined,
        discount_pct: qi?.discount_pct ?? 0,
        tax_rate: qi?.tax_rate ?? 0,
        cgst_rate: cg,
        sgst_rate: sg,
        igst_rate: ig,
        remarks: qi?.remarks ?? '',
      };
    });
    // Determine the existing expected_arrival_date from the first item's expected_delivery
    const existingArrivalDate = existing?.items?.[0]?.expected_delivery
      ? dayjs(existing.items[0].expected_delivery)
      : undefined;
    quoteForm.resetFields();
    quoteForm.setFieldsValue({
      items: initialItems,
      delivery_days: existing?.delivery_days ?? undefined,
      payment_terms: existing?.payment_terms ?? '',
      valid_until: toDateInput(existing?.valid_until),
      expected_arrival_date: existingArrivalDate,
      remarks: existing?.remarks ?? '',
      with_vehicle: existing?.with_vehicle ?? false,
      vehicle_cost: existing?.vehicle_cost ?? 0,
    });
    setQuoteModalVisible(true);
  };

  /* ── Submit Quote ── */
  const handleSubmitQuote = async () => {
    try {
      const values = await quoteForm.validateFields();
      setQuoteSubmitting(true);
      // Attach expected_arrival_date to every item as expected_delivery
      const arrivalDateStr = values.expected_arrival_date
        ? dayjs(values.expected_arrival_date).format('YYYY-MM-DD')
        : null;
      const itemsWithDelivery = (values.items || []).map((item) => ({
        ...item,
        expected_delivery: arrivalDateStr,
      }));
      await vendorApi.post(`/supplier/rfqs/${selectedRfq.id}/quote`, {
        items: itemsWithDelivery,
        delivery_days: values.delivery_days,
        payment_terms: values.payment_terms,
        valid_until: values.valid_until || null,
        remarks: values.remarks,
        with_vehicle: values.with_vehicle || false,
        vehicle_cost: values.vehicle_cost || 0,
      });
      message.success('Your quotation has been submitted successfully!');
      setQuoteModalVisible(false);
      fetchRfqs();
    } catch (err) {
      if (err?.errorFields) return; // Ant validation
      message.error(err?.response?.data?.detail || 'Failed to submit quotation');
    } finally {
      setQuoteSubmitting(false);
    }
  };

  /* ── Decline RFQ ── */
  const handleDecline = async (rfq) => {
    try {
      await vendorApi.post(`/supplier/rfqs/${rfq.id}/decline`, {
        reason: 'Unable to supply at this time',
      });
      message.success('RFQ declined');
      setDeclineConfirm(null);
      fetchRfqs();
    } catch (err) {
      message.error(err?.response?.data?.detail || 'Failed to decline RFQ');
    }
  };

  /* ── Change Password ── */
  const handleChangePassword = async (values) => {
    try {
      setChangePassLoading(true);
      await changePassword(values.currentPassword, values.newPassword);
      message.success('Password changed successfully!');
      passForm.resetFields();
      setChangePassVisible(false);
    } catch (err) {
      message.error(err?.response?.data?.detail || 'Failed to change password');
    } finally {
      setChangePassLoading(false);
    }
  };

  /* ── Stats ── */
  const open = rfqs.filter((r) => r.quotation_status === 'draft').length;
  const submitted = rfqs.filter((r) => r.quotation_status === 'submitted').length;
  const accepted = rfqs.filter((r) => r.quotation_status === 'accepted').length;
  const pendingPos = purchaseOrders.filter((p) => p.supplier_acknowledgement === 'pending').length;
  const acceptedPos = purchaseOrders.filter((p) => p.supplier_acknowledgement === 'accepted').length;

  /* ── RFQ Table ── */
  const expandedRender = (record) => (
    <div style={{ padding: '0 16px 16px' }}>
      <Text strong style={{ color: '#475569', fontSize: '12px' }}>REQUESTED ITEMS</Text>
      <Table
        size="small"
        dataSource={record.items}
        rowKey={(r) => r.item_id}
        pagination={false}
        style={{ marginTop: 8 }}
        columns={[
          {
            title: 'Item',
            key: 'item',
            render: (_, r) => (
              <Space direction="vertical" size={0}>
                <Text strong>{r.item_name}</Text>
                <Text style={{ color: '#64748b', fontSize: '11px', fontFamily: 'monospace' }}>{r.item_code}</Text>
              </Space>
            ),
          },
          {
            title: 'Required Qty',
            key: 'qty',
            align: 'right',
            render: (_, r) => <Text style={{ fontFamily: 'monospace' }}>{r.qty} {r.uom}</Text>,
          },
          {
            title: 'Remarks',
            dataIndex: 'remarks',
            key: 'remarks',
            render: (v) => v || '—',
          },
          record.my_quote && {
            title: 'Your Rate',
            key: 'my_rate',
            align: 'right',
            render: (_, r) => {
              const qi = record.my_quote?.items?.find((q) => q.item_id === r.item_id);
              if (!qi) return <Text style={{ color: '#94a3b8' }}>—</Text>;
              
              let taxText = '0%';
              if (qi.igst_rate > 0) {
                taxText = `IGST ${qi.igst_rate}%`;
              } else if (qi.cgst_rate > 0 || qi.sgst_rate > 0) {
                taxText = `CGST ${qi.cgst_rate}% + SGST ${qi.sgst_rate}%`;
              } else if (qi.tax_rate > 0) {
                taxText = `Tax ${qi.tax_rate}%`;
              }
              
              return (
                <Space direction="vertical" size={0} style={{ textAlign: 'right' }}>
                  <Text strong style={{ fontFamily: 'monospace', color: '#0f172a' }}>{fmt(qi.rate)}/unit</Text>
                  <Text style={{ fontSize: '11px', color: '#64748b' }}>{taxText} · Disc {qi.discount_pct}%</Text>
                </Space>
              );
            },
          },
        ].filter(Boolean)}
      />
      {record.my_quote && (
        <div style={{ marginTop: 12, padding: '12px 16px', background: 'rgba(59,130,246,0.06)', borderRadius: 8, border: '1px solid rgba(59,130,246,0.2)' }}>
          <Row gutter={24}>
            <Col xs={12} sm={6} md={4}><Statistic title="Delivery Days" value={record.my_quote.delivery_days || '—'} /></Col>
            <Col xs={12} sm={6} md={5}><Statistic title="Payment Terms" value={record.my_quote.payment_terms || '—'} /></Col>
            <Col xs={12} sm={6} md={5}><Statistic title="Logistics" value={record.my_quote.with_vehicle ? `Vehicle (${fmt(record.my_quote.vehicle_cost)})` : 'No Vehicle'} /></Col>
            <Col xs={12} sm={6} md={5}>
              <Tooltip title={
                <div style={{ fontSize: '12px' }}>
                  <div>Subtotal: {fmt(record.my_quote.total_amount)}</div>
                  {record.my_quote.cgst_amount > 0 && <div>CGST: {fmt(record.my_quote.cgst_amount)}</div>}
                  {record.my_quote.sgst_amount > 0 && <div>SGST: {fmt(record.my_quote.sgst_amount)}</div>}
                  {record.my_quote.igst_amount > 0 && <div>IGST: {fmt(record.my_quote.igst_amount)}</div>}
                  {record.my_quote.tax_amount > 0 && record.my_quote.cgst_amount === 0 && record.my_quote.igst_amount === 0 && (
                    <div>Tax: {fmt(record.my_quote.tax_amount)}</div>
                  )}
                  {record.my_quote.with_vehicle && <div>Logistics: {fmt(record.my_quote.vehicle_cost)}</div>}
                </div>
              }>
                <Statistic title="Grand Total" value={fmt(record.my_quote.grand_total)} valueStyle={{ cursor: 'help' }} />
              </Tooltip>
            </Col>
            <Col xs={12} sm={6} md={5}><Statistic title="Status" value={QUOTE_STATUS_CONFIG[record.quotation_status]?.label || record.quotation_status} /></Col>
          </Row>
          {record.my_quote.remarks && (
            <div style={{ marginTop: 8, fontSize: '12px', color: '#475569' }}>
              <strong>Remarks:</strong> {record.my_quote.remarks}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const columns = [
    {
      title: 'MR Number',
      dataIndex: 'mr_number',
      key: 'mr_number',
      width: 140,
      render: (text) => <Text strong style={{ fontFamily: 'monospace', color: '#0284c7' }}>{text}</Text>,
    },
    {
      title: 'Department',
      dataIndex: 'department',
      key: 'dept',
      width: 140,
      render: (v) => v || '—',
    },
    {
      title: 'Priority',
      dataIndex: 'priority',
      key: 'priority',
      width: 100,
      render: (v) => {
        const clr = v === 'urgent' ? 'red' : v === 'high' ? 'orange' : 'default';
        return <Tag color={clr}>{(v || 'Normal').toUpperCase()}</Tag>;
      },
    },
    {
      title: 'Required By',
      dataIndex: 'required_date',
      key: 'req_date',
      width: 130,
      render: fmtDate,
    },
    {
      title: 'Items',
      key: 'items_count',
      width: 80,
      align: 'center',
      render: (_, r) => <Badge count={r.items?.length || 0} style={{ backgroundColor: '#64748b' }} />,
    },
    {
      title: 'Quote Status',
      key: 'status',
      width: 160,
      render: (_, record) => {
        const cfg = QUOTE_STATUS_CONFIG[record.quotation_status] || {};
        return <Tag color={cfg.color || 'default'}>{cfg.label || record.quotation_status}</Tag>;
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      render: (_, record) => {
        const canEdit = record.can_edit;
        const isDeclined = record.quotation_status === 'rejected';
        return (
          <Space>
            {!isDeclined && canEdit && (
              <Button
                type="primary"
                size="small"
                icon={<SendOutlined />}
                onClick={() => handleOpenQuote(record)}
              >
                {record.my_quote ? 'Edit Quote' : 'Submit Quote'}
              </Button>
            )}
            {!isDeclined && canEdit && (
              <Tooltip title="Decline RFQ">
                <Button
                  danger
                  type="text"
                  size="small"
                  icon={<CloseCircleOutlined />}
                  onClick={() => {
                    Modal.confirm({
                      title: 'Decline this RFQ?',
                      content: 'This will notify the procurement team that you cannot supply these items.',
                      okText: 'Decline',
                      okType: 'danger',
                      onOk: () => handleDecline(record),
                    });
                  }}
                />
              </Tooltip>
            )}
            {isDeclined && (
              <Text style={{ color: '#94a3b8', fontSize: '12px' }}>Declined</Text>
            )}
            {!canEdit && !isDeclined && record.my_quote && (
              <Space size={4}>
                <Tag color="blue">Submitted</Tag>
                <Button
                  type="default"
                  size="small"
                  icon={<FileSearchOutlined />}
                  onClick={() => handleOpenQuote(record, true)}
                >
                  View Quote
                </Button>
              </Space>
            )}
          </Space>
        );
      },
    },
  ];

  /* ── PO Columns ── */
  const poColumns = [
    {
      title: 'PO Number',
      dataIndex: 'po_number',
      key: 'po_number',
      width: 160,
      render: (text) => <Text strong style={{ fontFamily: 'monospace', color: '#0284c7' }}>{text}</Text>,
    },
    {
      title: 'PO Date',
      dataIndex: 'po_date',
      key: 'po_date',
      width: 130,
      render: fmtDate,
    },
    {
      title: 'Delivery Warehouse',
      dataIndex: 'warehouse_name',
      key: 'warehouse_name',
      width: 180,
      render: (v) => v || '—',
    },
    {
      title: 'Grand Total',
      dataIndex: 'grand_total',
      key: 'grand_total',
      width: 140,
      align: 'right',
      render: (v, r) => {
        let itemsTotal = 0;
        (r.items || []).forEach(({ amount }) => {
          itemsTotal += parseFloat(amount || 0);
        });
        let vCost = 0;
        if (r.remarks) {
          const match = r.remarks.match(/Includes vehicle cost:\s*(\d+(\.\d+)?)/);
          if (match) vCost = parseFloat(match[1]);
        }
        const calcGrand = Math.max(parseFloat(v || 0), itemsTotal + vCost);
        return <Text strong style={{ fontFamily: 'monospace' }}>{fmt(calcGrand)}</Text>;
      },
    },
    {
      title: 'Acknowledgment',
      dataIndex: 'supplier_acknowledgement',
      key: 'supplier_acknowledgement',
      width: 160,
      render: (status) => {
        let color = 'gold';
        let label = 'Pending Acknowledgment';
        if (status === 'accepted') {
          color = 'green';
          label = 'Accepted';
        } else if (status === 'rejected') {
          color = 'red';
          label = 'Rejected';
        }
        return <Tag color={color}>{label.toUpperCase()}</Tag>;
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      render: (_, record) => (
        <Button
          type="primary"
          ghost
          size="small"
          icon={<FileSearchOutlined />}
          onClick={() => handleOpenPoDetails(record)}
        >
          {record.supplier_acknowledgement === 'pending' ? 'Review & Acknowledge' : 'View Details'}
        </Button>
      ),
    },
  ];

  const poItemColumns = [
    {
      title: 'Item',
      key: 'item',
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Text strong>{r.item_name || '—'}</Text>
          <Text style={{ color: '#64748b', fontSize: '11px', fontFamily: 'monospace' }}>{r.item_code}</Text>
        </Space>
      ),
    },
    {
      title: 'Ordered Qty',
      key: 'qty',
      align: 'right',
      render: (_, r) => <Text style={{ fontFamily: 'monospace' }}>{r.qty} {r.uom_name || 'Units'}</Text>,
    },
    {
      title: 'Unit Rate',
      dataIndex: 'rate',
      key: 'rate',
      align: 'right',
      render: (v) => fmt(v),
    },
    {
      title: 'Discount %',
      dataIndex: 'discount_pct',
      key: 'discount_pct',
      align: 'right',
      render: (v) => v ? `${v}%` : '0%',
    },
    {
      title: 'Taxes',
      key: 'taxes',
      align: 'right',
      render: (_, r) => {
        if (r.igst_rate > 0) {
          return `IGST ${r.igst_rate}%`;
        }
        if (r.cgst_rate > 0 || r.sgst_rate > 0) {
          return `CGST ${r.cgst_rate}% + SGST ${r.sgst_rate}%`;
        }
        return '0%';
      },
    },
    {
      title: 'Line Total',
      dataIndex: 'amount',
      key: 'amount',
      align: 'right',
      render: (v) => <Text strong style={{ fontFamily: 'monospace' }}>{fmt(v)}</Text>,
    },
  ];

  /* ── Must Change Password Screen ── */
  if (mustChange) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%)',
      }}>
        <Card style={{ width: 440, borderRadius: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div style={{ fontSize: 48, marginBottom: 8 }}>🔑</div>
            <Title level={4} style={{ margin: 0 }}>Change Your Password</Title>
            <Paragraph style={{ color: '#64748b', margin: '4px 0 0' }}>
              This is your first login. Please set a new password to continue.
            </Paragraph>
          </div>
          <Form layout="vertical" onFinish={handleChangePassword} form={passForm}>
            <Form.Item name="currentPassword" label="Current Password" rules={[{ required: true }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="Your current / temporary password" />
            </Form.Item>
            <Form.Item
              name="newPassword"
              label="New Password"
              rules={[
                { required: true },
                { min: 8, message: 'Minimum 8 characters' },
                { pattern: /[A-Z]/, message: 'Must include uppercase letter' },
                { pattern: /[a-z]/, message: 'Must include lowercase letter' },
                { pattern: /\d/, message: 'Must include a number' },
              ]}
            >
              <Input.Password prefix={<LockOutlined />} placeholder="Strong new password" />
            </Form.Item>
            <Form.Item
              name="confirmPassword"
              label="Confirm Password"
              rules={[
                { required: true },
                ({ getFieldValue }) => ({
                  validator(_, v) {
                    if (!v || getFieldValue('newPassword') === v) return Promise.resolve();
                    return Promise.reject('Passwords do not match');
                  },
                }),
              ]}
            >
              <Input.Password prefix={<LockOutlined />} placeholder="Confirm password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={changePassLoading}>
              Set Password & Continue
            </Button>
          </Form>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc' }}>
      {/* ── Header ── */}
      <div style={{
        background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
        padding: '0 24px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        height: 64, boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
      }}>
        <Space align="center">
          <ShoppingOutlined style={{ color: '#38bdf8', fontSize: 22 }} />
          <div>
            <div style={{ color: '#f1f5f9', fontWeight: 700, fontSize: 16, lineHeight: 1.2 }}>
              Bavya SCM — Supplier Portal
            </div>
            <div style={{ color: '#64748b', fontSize: 11 }}>
              {user?.vendor_name || 'Material Supplier'}
            </div>
          </div>
        </Space>
        <Space>
          <div style={{ textAlign: 'right', marginRight: 8 }}>
            <div style={{ color: '#94a3b8', fontSize: 11 }}>Logged in as</div>
            <div style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 600 }}>
              {user?.full_name || user?.username}
            </div>
          </div>
          <Tooltip title="Change Password">
            <Button
              type="text"
              icon={<KeyOutlined style={{ color: '#94a3b8' }} />}
              onClick={() => { passForm.resetFields(); setChangePassVisible(true); }}
            />
          </Tooltip>
          <Tooltip title="Logout">
            <Button
              type="text"
              icon={<LogoutOutlined style={{ color: '#f87171' }} />}
              onClick={() => {
                Modal.confirm({
                  title: 'Sign out?',
                  okText: 'Sign Out',
                  onOk: logout,
                });
              }}
            />
          </Tooltip>
        </Space>
      </div>

      {/* ── Page Body ── */}
      <div style={{ padding: '24px', maxWidth: 1200, margin: '0 auto' }}>
        {/* Stats row */}
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col xs={24} sm={6}>
            <Card variant="borderless" style={{ borderRadius: 12, background: 'linear-gradient(135deg, #fff7ed, #fff)', border: '1px solid #fed7aa' }}>
              <Statistic
                title={<span style={{ color: '#c2410c', fontWeight: 600 }}>Open RFQs</span>}
                value={open}
                prefix={<FileSearchOutlined style={{ color: '#f97316' }} />}
                valueStyle={{ color: '#c2410c' }}
              />
              <Paragraph style={{ margin: 0, fontSize: 12, color: '#94a3b8', marginTop: 4 }}>Awaiting your quotation</Paragraph>
            </Card>
          </Col>
          <Col xs={24} sm={6}>
            <Card variant="borderless" style={{ borderRadius: 12, background: 'linear-gradient(135deg, #eff6ff, #fff)', border: '1px solid #bfdbfe' }}>
              <Statistic
                title={<span style={{ color: '#1d4ed8', fontWeight: 600 }}>Submitted Quotes</span>}
                value={submitted}
                prefix={<CheckCircleOutlined style={{ color: '#3b82f6' }} />}
                valueStyle={{ color: '#1d4ed8' }}
              />
              <Paragraph style={{ margin: 0, fontSize: 12, color: '#94a3b8', marginTop: 4 }}>Quotes under review</Paragraph>
            </Card>
          </Col>
          <Col xs={24} sm={6}>
            <Card variant="borderless" style={{ borderRadius: 12, background: 'linear-gradient(135deg, #fef9c3, #fff)', border: '1px solid #fef08a' }}>
              <Statistic
                title={<span style={{ color: '#a16207', fontWeight: 600 }}>Pending POs</span>}
                value={pendingPos}
                prefix={<ClockCircleOutlined style={{ color: '#eab308' }} />}
                valueStyle={{ color: '#a16207' }}
              />
              <Paragraph style={{ margin: 0, fontSize: 12, color: '#94a3b8', marginTop: 4 }}>Awaiting acknowledgment</Paragraph>
            </Card>
          </Col>
          <Col xs={24} sm={6}>
            <Card variant="borderless" style={{ borderRadius: 12, background: 'linear-gradient(135deg, #f0fdf4, #fff)', border: '1px solid #bbf7d0' }}>
              <Statistic
                title={<span style={{ color: '#15803d', fontWeight: 600 }}>Accepted POs</span>}
                value={acceptedPos}
                prefix={<DollarOutlined style={{ color: '#22c55e' }} />}
                valueStyle={{ color: '#15803d' }}
              />
              <Paragraph style={{ margin: 0, fontSize: 12, color: '#94a3b8', marginTop: 4 }}>Acknowledged this cycle</Paragraph>
            </Card>
          </Col>
        </Row>

        {/* Tab Wrapper */}
        <Tabs
          defaultActiveKey="rfqs"
          type="card"
          style={{ marginBottom: 16 }}
          items={[
            {
              key: 'rfqs',
              label: (
                <Space>
                  <FileTextOutlined />
                  <span>Purchase RFQs</span>
                  {open > 0 && <Badge count={open} style={{ backgroundColor: '#f97316' }} />}
                </Space>
              ),
              children: (
                <Card
                  variant="borderless"
                  title={
                    <Space>
                      <FileTextOutlined />
                      <span style={{ fontWeight: 700 }}>Purchase RFQs</span>
                      <Tag color="blue">{rfqs.length}</Tag>
                    </Space>
                  }
                  extra={
                    <Button icon={<ClockCircleOutlined />} onClick={fetchRfqs} loading={loading}>
                      Refresh
                    </Button>
                  }
                  style={{ borderRadius: '0 0 12px 12px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}
                >
                  <Spin spinning={loading} tip="Loading your RFQs...">
                    {rfqs.length === 0 && !loading ? (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="No RFQs have been assigned to you yet. The procurement team will notify you when a request is raised."
                      />
                    ) : (
                      <Table
                        dataSource={rfqs}
                        columns={columns}
                        rowKey="quotation_id"
                        expandable={{ expandedRowRender: expandedRender }}
                        pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t) => `${t} RFQs` }}
                        scroll={{ x: 900 }}
                        rowClassName={(r) => r.quotation_status === 'draft' ? 'rfq-row-open' : ''}
                      />
                    )}
                  </Spin>
                </Card>
              )
            },
            {
              key: 'purchase_orders',
              label: (
                <Space>
                  <ShoppingOutlined />
                  <span>Purchase Orders</span>
                  {pendingPos > 0 && <Badge count={pendingPos} style={{ backgroundColor: '#eab308' }} />}
                </Space>
              ),
              children: (
                <Card
                  variant="borderless"
                  title={
                    <Space>
                      <ShoppingOutlined />
                      <span style={{ fontWeight: 700 }}>Purchase Orders</span>
                      <Tag color="blue">{purchaseOrders.length}</Tag>
                    </Space>
                  }
                  extra={
                    <Button icon={<ClockCircleOutlined />} onClick={fetchPurchaseOrders} loading={poLoading}>
                      Refresh
                    </Button>
                  }
                  style={{ borderRadius: '0 0 12px 12px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}
                >
                  <Spin spinning={poLoading} tip="Loading Purchase Orders...">
                    {purchaseOrders.length === 0 && !poLoading ? (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description="No Purchase Orders have been raised for your account yet."
                      />
                    ) : (
                      <Table
                        dataSource={purchaseOrders}
                        columns={poColumns}
                        rowKey="id"
                        pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t) => `${t} Purchase Orders` }}
                        scroll={{ x: 900 }}
                        rowClassName={(r) => r.supplier_acknowledgement === 'pending' ? 'po-row-pending' : ''}
                      />
                    )}
                  </Spin>
                </Card>
              )
            }
          ]}
        />
      </div>

      <Modal
        title={
          <Space>
            {isQuoteViewOnly ? <FileSearchOutlined style={{ color: '#0284c7' }} /> : <SendOutlined style={{ color: '#3b82f6' }} />}
            <span>
              {isQuoteViewOnly ? 'View Your Quotation' : (selectedRfq?.my_quote ? 'Edit Your Quotation' : 'Submit Quotation')} — {selectedRfq?.mr_number}
            </span>
          </Space>
        }
        open={quoteModalVisible}
        onCancel={() => setQuoteModalVisible(false)}
        footer={null}
        width={900}
        styles={{ body: { padding: '16px 24px 8px' } }}
      >
        <Form form={quoteForm} layout="vertical" onFinish={handleSubmitQuote}>
          {/* Item pricing table */}
          {selectedRfq && <QuoteItemsForm rfq={selectedRfq} form={quoteForm} disabled={isQuoteViewOnly} />}

          <Divider style={{ margin: '16px 0' }} />

          {/* Header fields */}
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="delivery_days" label="Delivery Lead Time (days)">
                <InputNumber min={1} step={1} style={{ width: '100%' }} placeholder="e.g. 7" disabled={isQuoteViewOnly} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="payment_terms" label="Payment Terms">
                <Input placeholder="e.g. Net 30 days" disabled={isQuoteViewOnly} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="valid_until" label="Quote Valid Until">
                <Input type="date" style={{ width: '100%' }} disabled={isQuoteViewOnly} />
              </Form.Item>
            </Col>
          </Row>

          {/* Expected Arrival Date — must be before the RFQ's required_date */}
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="expected_arrival_date"
                label={
                  <Space size={4}>
                    <CalendarOutlined style={{ color: '#0284c7' }} />
                    <span style={{ fontWeight: 600, color: '#0284c7' }}>Expected Arrival Date</span>
                  </Space>
                }
                tooltip="Date by which you commit to delivering the goods. Must be on or before the buyer's required delivery date."
                rules={[
                  { required: true, message: 'Expected arrival date is required' },
                  () => ({
                    validator(_, value) {
                      if (!value) return Promise.resolve();
                      const reqDate = selectedRfq?.required_date;
                      if (reqDate) {
                        const requiredDay = dayjs(reqDate).endOf('day');
                        if (value.isAfter(requiredDay, 'day')) {
                          return Promise.reject(
                            new Error(
                              `Expected arrival date must be on or before the required delivery date (${dayjs(reqDate).format('DD/MM/YYYY')})`
                            )
                          );
                        }
                      }
                      return Promise.resolve();
                    },
                  }),
                ]}
              >
                <DatePicker
                  style={{ width: '100%' }}
                  disabled={isQuoteViewOnly}
                  disabledDate={(d) => {
                    const reqDate = selectedRfq?.required_date;
                    if (reqDate) {
                      return d && d.isAfter(dayjs(reqDate), 'day');
                    }
                    return false;
                  }}
                  placeholder="Select your commitment delivery date"
                  format="DD/MM/YYYY"
                />
              </Form.Item>
            </Col>
            {selectedRfq?.required_date && (
              <Col span={12}>
                <div
                  style={{
                    marginTop: 30,
                    padding: '8px 12px',
                    background: '#fef3c7',
                    border: '1px solid #fde68a',
                    borderRadius: 6,
                    fontSize: 12,
                    color: '#92400e',
                  }}
                >
                  <strong>⏰ Buyer's Required By:</strong>{' '}
                  <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>
                    {dayjs(selectedRfq.required_date).format('DD/MM/YYYY')}
                  </span>
                  <br />
                  <span style={{ color: '#78350f' }}>Your expected arrival must be on or before this date.</span>
                </div>
              </Col>
            )}
          </Row>

          <Row gutter={16} align="middle" style={{ marginBottom: 16 }}>
            <Col span={8}>
              <Form.Item name="with_vehicle" label="Transport / Vehicle Included?" valuePropName="checked" style={{ margin: 0 }}>
                <Checkbox
                  disabled={isQuoteViewOnly}
                  onChange={() => {
                    quoteForm.setFieldsValue({ with_vehicle: quoteForm.getFieldValue('with_vehicle') });
                  }}
                >
                  Yes, include vehicle logistics
                </Checkbox>
              </Form.Item>
            </Col>
            <Form.Item noStyle shouldUpdate={(prev, curr) => prev.with_vehicle !== curr.with_vehicle}>
              {({ getFieldValue }) => {
                const isChecked = getFieldValue('with_vehicle');
                if (!isChecked) return null;
                return (
                  <Col span={8}>
                    <Form.Item name="vehicle_cost" label="Logistics / Vehicle Cost (₹)" rules={[{ required: true, message: 'Required' }]} style={{ margin: 0 }}>
                      <InputNumber min={0} step={100} prefix="₹" style={{ width: '100%' }} placeholder="e.g. 5000" disabled={isQuoteViewOnly} />
                    </Form.Item>
                  </Col>
                );
              }}
            </Form.Item>
          </Row>

          <Form.Item name="remarks" label="Remarks / Terms &amp; Conditions">
            <Input.TextArea
              rows={3}
              placeholder="Any conditions, exclusions, or notes for the procurement team..."
              maxLength={1000}
              showCount
              disabled={isQuoteViewOnly}
            />
          </Form.Item>

          <Alert
            message={isQuoteViewOnly ? "This is a read-only view of your submitted quotation." : "By submitting, you confirm that the prices and availability are accurate as of today."}
            type="info"
            showIcon
            style={{ marginBottom: 16, fontSize: 12 }}
          />

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            {isQuoteViewOnly ? (
              <Button type="primary" onClick={() => setQuoteModalVisible(false)}>Close</Button>
            ) : (
              <>
                <Button onClick={() => setQuoteModalVisible(false)}>Cancel</Button>
                <Button
                  type="primary"
                  htmlType="submit"
                  icon={<SendOutlined />}
                  loading={quoteSubmitting}
                >
                  Submit Quotation
                </Button>
              </>
            )}
          </div>
        </Form>
      </Modal>

      {/* ── Change Password Modal ── */}
      <Modal
        title={
          <Space>
            <KeyOutlined style={{ color: '#d97706' }} />
            Change Password
          </Space>
        }
        open={changePassVisible}
        onCancel={() => setChangePassVisible(false)}
        footer={null}
        width={420}
      >
        <Form layout="vertical" form={passForm} onFinish={handleChangePassword}>
          <Form.Item name="currentPassword" label="Current Password" rules={[{ required: true }]}>
            <Input.Password prefix={<LockOutlined />} />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="New Password"
            rules={[
              { required: true },
              { min: 8 },
              { pattern: /[A-Z]/, message: 'Must include an uppercase letter' },
              { pattern: /[a-z]/, message: 'Must include a lowercase letter' },
              { pattern: /\d/, message: 'Must include a number' },
            ]}
          >
            <Input.Password prefix={<LockOutlined />} />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="Confirm Password"
            rules={[
              { required: true },
              ({ getFieldValue }) => ({
                validator(_, v) {
                  if (!v || getFieldValue('newPassword') === v) return Promise.resolve();
                  return Promise.reject('Passwords do not match');
                },
              }),
            ]}
          >
            <Input.Password prefix={<LockOutlined />} />
          </Form.Item>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
            <Button onClick={() => setChangePassVisible(false)}>Cancel</Button>
            <Button type="primary" htmlType="submit" loading={changePassLoading}>
              Update Password
            </Button>
          </div>
        </Form>
      </Modal>

      {/* ── Purchase Order Review Modal ── */}
      <Modal
        title={
          <Space>
            <ShoppingOutlined style={{ color: '#0284c7' }} />
            <span>Purchase Order Review — {selectedPo?.po_number}</span>
          </Space>
        }
        open={poModalVisible}
        onCancel={() => {
          if (!poActionLoading) {
            setPoModalVisible(false);
          }
        }}
        footer={null}
        width={950}
        styles={{ body: { padding: '16px 24px 8px' } }}
      >
        <Spin spinning={poDetailsLoading} tip="Loading Purchase Order Details...">
          {selectedPoDetails && (
            <div>
              <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }} style={{ marginBottom: 20 }}>
                <Descriptions.Item label="PO Number">
                  <Text strong style={{ fontFamily: 'monospace' }}>{selectedPoDetails.po_number}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="PO Date">{fmtDate(selectedPoDetails.po_date)}</Descriptions.Item>
                <Descriptions.Item label="Expected Delivery">{fmtDate(selectedPoDetails.expected_delivery_date)}</Descriptions.Item>
                <Descriptions.Item label="Warehouse">{selectedPoDetails.warehouse_name || '—'}</Descriptions.Item>
                <Descriptions.Item label="Grand Total">
                  {(() => {
                    let itemsTotal = 0;
                    (selectedPoDetails.items || []).forEach(({ amount }) => {
                      itemsTotal += parseFloat(amount || 0);
                    });
                    let vCost = 0;
                    if (selectedPoDetails.remarks) {
                      const match = selectedPoDetails.remarks.match(/Includes vehicle cost:\s*(\d+(\.\d+)?)/);
                      if (match) vCost = parseFloat(match[1]);
                    }
                    const calcGrand = Math.max(parseFloat(selectedPoDetails.grand_total || 0), itemsTotal + vCost);
                    return <Text strong style={{ color: '#15803d', fontFamily: 'monospace' }}>{fmt(calcGrand)}</Text>;
                  })()}
                </Descriptions.Item>
                <Descriptions.Item label="Acknowledgment Status">
                  {(() => {
                    let color = 'gold';
                    let label = 'Pending Acknowledgment';
                    if (selectedPoDetails.supplier_acknowledgement === 'accepted') {
                      color = 'green';
                      label = 'Accepted';
                    } else if (selectedPoDetails.supplier_acknowledgement === 'rejected') {
                      color = 'red';
                      label = 'Rejected';
                    }
                    return <Tag color={color}>{label.toUpperCase()}</Tag>;
                  })()}
                </Descriptions.Item>
              </Descriptions>

              <Row gutter={16} style={{ marginBottom: 20 }}>
                <Col xs={24} md={12}>
                  <Card size="small" title="Billing Address" style={{ height: '100%', background: '#f8fafc' }}>
                    <div style={{ whiteSpace: 'pre-wrap', fontSize: '13px', color: '#475569' }}>
                      {selectedPoDetails.billing_address || 'No billing address provided'}
                    </div>
                  </Card>
                </Col>
                <Col xs={24} md={12}>
                  <Card size="small" title="Shipping Address" style={{ height: '100%', background: '#f8fafc' }}>
                    <div style={{ whiteSpace: 'pre-wrap', fontSize: '13px', color: '#475569' }}>
                      {selectedPoDetails.shipping_address || 'No shipping address provided'}
                    </div>
                  </Card>
                </Col>
              </Row>

              {selectedPoDetails.remarks && (
                <Alert
                  message={
                    <span>
                      <strong>Internal Remarks / Terms:</strong> {selectedPoDetails.remarks}
                    </span>
                  }
                  type="info"
                  style={{ marginBottom: 20 }}
                />
              )}

              <Text strong style={{ color: '#475569', fontSize: '13px', display: 'block', marginBottom: 8 }}>
                ORDERED ITEMS BREAKDOWN
              </Text>
              
              <Table
                dataSource={selectedPoDetails.items || []}
                columns={poItemColumns}
                rowKey="id"
                pagination={false}
                size="small"
                style={{ marginBottom: 24 }}
                summary={(pageData) => {
                  let itemsTotal = 0;
                  pageData.forEach(({ amount }) => {
                    itemsTotal += parseFloat(amount || 0);
                  });
                  
                  let vehicleCost = 0;
                  if (selectedPoDetails.remarks) {
                    const match = selectedPoDetails.remarks.match(/Includes vehicle cost:\s*(\d+(\.\d+)?)/);
                    if (match) {
                      vehicleCost = parseFloat(match[1]);
                    }
                  }
                  
                  const calculatedGrandTotal = Math.max(parseFloat(selectedPoDetails.grand_total || 0), itemsTotal + vehicleCost);

                  return (
                    <>
                      {vehicleCost > 0 && (
                        <>
                          <Table.Summary.Row style={{ background: '#f8fafc' }}>
                            <Table.Summary.Cell index={0} colSpan={5} style={{ textAlign: 'right', fontWeight: 600, color: '#64748b' }}>
                              Items Subtotal:
                            </Table.Summary.Cell>
                            <Table.Summary.Cell index={1} style={{ textAlign: 'right' }}>
                              <Text strong style={{ fontFamily: 'monospace', color: '#64748b' }}>
                                {fmt(itemsTotal)}
                              </Text>
                            </Table.Summary.Cell>
                          </Table.Summary.Row>
                          <Table.Summary.Row style={{ background: '#f8fafc' }}>
                            <Table.Summary.Cell index={0} colSpan={5} style={{ textAlign: 'right', fontWeight: 600, color: '#64748b' }}>
                              Vehicle / Freight Cost:
                            </Table.Summary.Cell>
                            <Table.Summary.Cell index={1} style={{ textAlign: 'right' }}>
                              <Text strong style={{ fontFamily: 'monospace', color: '#64748b' }}>
                                + {fmt(vehicleCost)}
                              </Text>
                            </Table.Summary.Cell>
                          </Table.Summary.Row>
                        </>
                      )}
                      <Table.Summary.Row style={{ background: '#f8fafc' }}>
                        <Table.Summary.Cell index={0} colSpan={5} style={{ textAlign: 'right', fontWeight: 600 }}>
                          Grand Total:
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={1} style={{ textAlign: 'right' }}>
                          <Text strong style={{ fontFamily: 'monospace', color: '#1e293b' }}>
                            {fmt(calculatedGrandTotal)}
                          </Text>
                        </Table.Summary.Cell>
                      </Table.Summary.Row>
                    </>
                  );
                }}
              />

              <Divider style={{ margin: '16px 0' }} />

              {/* Action buttons panel */}
              {selectedPoDetails.supplier_acknowledgement === 'pending' && (
                <div style={{ padding: '12px 16px', background: '#fef3c7', borderRadius: 8, border: '1px solid #fde68a', marginBottom: 16 }}>
                  <Space direction="vertical" style={{ width: '100%' }} size={12}>
                    <Text>
                      ⚠️ <strong>Review Required:</strong> Please verify the quantities and rates raised above. You must acknowledge this PO to proceed.
                    </Text>
                    {rejectReasonVisible && (
                      <div style={{ width: '100%' }}>
                        <Text strong style={{ display: 'block', marginBottom: 6 }}>Rejection Remarks / Justification (Required):</Text>
                        <Input.TextArea
                          rows={3}
                          value={rejectReason}
                          onChange={(e) => setRejectReason(e.target.value)}
                          placeholder="Please state the discrepancy (e.g. quantity mismatch, rate mismatch, capacity limits)..."
                          maxLength={500}
                          showCount
                        />
                      </div>
                    )}
                  </Space>
                </div>
              )}

              {selectedPoDetails.supplier_acknowledgement === 'accepted' && (
                <Alert
                  message="✓ Purchase Order Acknowledged"
                  description="You have accepted this Purchase Order. Production and delivery processes are approved."
                  type="success"
                  showIcon
                  style={{ marginBottom: 16 }}
                />
              )}

              {selectedPoDetails.supplier_acknowledgement === 'rejected' && (
                <Alert
                  message="✗ Purchase Order Rejected"
                  description="You have rejected this Purchase Order. The procurement department will contact you or update the order as needed."
                  type="error"
                  showIcon
                  style={{ marginBottom: 16 }}
                />
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                <Button onClick={() => setPoModalVisible(false)} disabled={poActionLoading}>
                  Close
                </Button>
                
                {selectedPoDetails.supplier_acknowledgement === 'pending' && (
                  <>
                    {!rejectReasonVisible ? (
                      <>
                        <Button
                          danger
                          ghost
                          loading={poActionLoading}
                          onClick={() => setRejectReasonVisible(true)}
                        >
                          Reject PO
                        </Button>
                        <Button
                          type="primary"
                          style={{ background: '#16a34a', borderColor: '#16a34a' }}
                          loading={poActionLoading}
                          onClick={() => {
                            Modal.confirm({
                              title: 'Accept this Purchase Order?',
                              content: 'By accepting, you commit to fulfilling this order under the specified quantities, pricing, and expected delivery date.',
                              okText: 'Accept PO',
                              okButtonProps: { style: { background: '#16a34a', borderColor: '#16a34a' } },
                              onOk: () => handleAcknowledgePO(selectedPoDetails.id, 'accept'),
                            });
                          }}
                        >
                          Accept PO
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button onClick={() => setRejectReasonVisible(false)} disabled={poActionLoading}>
                          Cancel
                        </Button>
                        <Button
                          danger
                          type="primary"
                          loading={poActionLoading}
                          disabled={!rejectReason.trim()}
                          onClick={() => handleAcknowledgePO(selectedPoDetails.id, 'reject', rejectReason)}
                        >
                          Confirm Rejection
                        </Button>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </Spin>
      </Modal>
    </div>
  );
}
