import React, { useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker, Tabs,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Divider,
  Typography, Tooltip, Tag, Switch, Modal, Spin,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  MinusCircleOutlined, PrinterOutlined, DownloadOutlined,
  DollarOutlined, WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import {
  formatDate, formatCurrency, getErrorMessage, formatDateForAPI,
  downloadExcel,
} from '../../utils/helpers';
import { DATE_FORMAT, PAYMENT_MODES } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const Invoices = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState('purchase');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [viewDrawerOpen, setViewDrawerOpen] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState(null);
  const [viewingInvoice, setViewingInvoice] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterParty, setFilterParty] = useState(undefined);
  const [filterOverdue, setFilterOverdue] = useState(false);
  const [filterDateRange, setFilterDateRange] = useState(null);

  // Items
  const [invoiceItems, setInvoiceItems] = useState([]);

  // Lookups
  const [vendors, setVendors] = useState([]);
  const [poOptions, setPoOptions] = useState([]);
  const [projects, setProjects] = useState([]);
  const [paymentHistory, setPaymentHistory] = useState([]);

  // Form state
  const [invoiceType, setInvoiceType] = useState('purchase');
  const [partyType, setPartyType] = useState('vendor');

  const loadLookups = useCallback(async () => {
    try {
      const [vendorRes, projRes] = await Promise.allSettled([
        api.get('/masters/vendors', { params: { page_size: 200, status: 'active' } }),
        api.get('/masters/projects', { params: { page_size: 200 } }),
      ]);
      if (vendorRes.status === 'fulfilled') {
        const d = vendorRes.value.data;
        const items = d.items || d.data || d || [];
        setVendors(items.map((v) => ({ label: `[${v.vendor_code || v.code}] ${v.name}`, value: v.id })));
      }
      if (projRes.status === 'fulfilled') {
        const d = projRes.value.data;
        const items = d.items || d.data || d || [];
        setProjects(items.map((p) => ({ label: p.name || p.project_name, value: p.id })));
      }
    } catch {
      // silent
    }
  }, []);

  const loadPOOptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/procurement/purchase-orders', {
        params: { page_size: 50, search, status: 'approved' },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setPoOptions(items.map((po) => ({
        label: `${po.po_number} - ${po.vendor_name || ''}`,
        value: po.id,
        po,
      })));
    } catch {
      // silent
    }
  }, []);

  const fetchInvoices = useCallback(
    async (params) => {
      const qp = { ...params, invoice_type: activeTab };
      if (filterStatus) qp.status = filterStatus;
      if (filterParty) qp.party_id = filterParty;
      if (filterOverdue) qp.overdue = true;
      if (filterDateRange && filterDateRange[0]) {
        qp.date_from = formatDateForAPI(filterDateRange[0]);
        qp.date_to = formatDateForAPI(filterDateRange[1]);
      }
      return await api.get('/accounts/invoices', { params: qp });
    },
    [activeTab, filterStatus, filterParty, filterOverdue, filterDateRange]
  );

  const createEmptyItem = () => ({
    key: Date.now() + Math.random(),
    item_id: null,
    item_name: '',
    qty: 1,
    uom: '',
    rate: 0,
    discount_percent: 0,
    cgst_percent: 9,
    sgst_percent: 9,
    igst_percent: 0,
    tax_amount: 0,
    amount: 0,
  });

  // BUG-FIN-030: recalcItem rounds line totals to 2dp, but calcSubtotal
  // and calcCGST/SGST/IGST were re-deriving from raw qty*rate — leading
  // to cross-line drift. Persist a quantized `net` and tax components on
  // each item and have the totals helpers sum those instead of recomputing.
  const round2 = (n) => Number((Number(n) || 0).toFixed(2));
  const recalcItem = (item) => {
    const base = (item.qty || 0) * (item.rate || 0);
    const afterDisc = base - (base * (item.discount_percent || 0)) / 100;
    const net2 = round2(afterDisc);
    const cgstAmt = round2((net2 * (item.cgst_percent || 0)) / 100);
    const sgstAmt = round2((net2 * (item.sgst_percent || 0)) / 100);
    const igstAmt = round2((net2 * (item.igst_percent || 0)) / 100);
    item.net_amount = net2;
    item.cgst_amount = cgstAmt;
    item.sgst_amount = sgstAmt;
    item.igst_amount = igstAmt;
    item.tax_amount = round2(cgstAmt + sgstAmt + igstAmt);
    item.amount = round2(net2 + item.tax_amount);
    return item;
  };

  const updateInvoiceItem = (key, field, value) => {
    setInvoiceItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        const updated = { ...item, [field]: value };
        if (field === 'igst_percent' && value > 0) {
          updated.cgst_percent = 0;
          updated.sgst_percent = 0;
        }
        if ((field === 'cgst_percent' || field === 'sgst_percent') && value > 0) {
          updated.igst_percent = 0;
        }
        return recalcItem(updated);
      })
    );
  };

  const addItemRow = () => {
    setInvoiceItems((prev) => [...prev, createEmptyItem()]);
  };

  const removeItemRow = (key) => {
    setInvoiceItems((prev) => prev.filter((i) => i.key !== key));
  };

  // Totals — sum the quantized per-line values so the displayed Subtotal /
  // CGST / Total agree with what we actually persist. (BUG-FIN-030)
  const calcSubtotal = () =>
    invoiceItems.reduce((sum, item) => sum + (item.net_amount || 0), 0);

  const calcDiscount = () =>
    invoiceItems.reduce((sum, item) => {
      const base = (item.qty || 0) * (item.rate || 0);
      return sum + (base * (item.discount_percent || 0)) / 100;
    }, 0);

  const calcCGST = () =>
    invoiceItems.reduce((sum, item) => sum + (item.cgst_amount || 0), 0);

  const calcSGST = () =>
    invoiceItems.reduce((sum, item) => sum + (item.sgst_amount || 0), 0);

  const calcIGST = () =>
    invoiceItems.reduce((sum, item) => sum + (item.igst_amount || 0), 0);

  const calcTaxTotal = () => calcCGST() + calcSGST() + calcIGST();
  const calcGrandTotal = () =>
    invoiceItems.reduce((sum, item) => sum + (item.amount || 0), 0);

  const handleAdd = () => {
    setEditingInvoice(null);
    setInvoiceType('purchase');
    setPartyType('vendor');
    form.resetFields();
    form.setFieldsValue({
      invoice_type: 'purchase',
      party_type: 'vendor',
      invoice_date: dayjs(),
      due_date: dayjs().add(30, 'day'),
    });
    setInvoiceItems([createEmptyItem()]);
    loadLookups();
    loadPOOptions();
    setDrawerOpen(true);
  };

  // Honor deep-link: /accounts/invoices?new=1&po_id=X opens the create drawer
  // with the PO pre-selected (auto-fills vendor + items via handlePOSelect).
  useEffect(() => {
    const wantNew = searchParams.get('new');
    const incomingPoId = searchParams.get('po_id');
    if (wantNew && !drawerOpen) {
      handleAdd();
      if (incomingPoId) {
        // Wait a beat for the drawer + options to load, then set the PO
        setTimeout(() => {
          form.setFieldsValue({ po_id: Number(incomingPoId) });
          handlePOSelect(Number(incomingPoId));
        }, 500);
      }
      // Clear the query params so a browser back doesn't reopen
      setSearchParams({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEdit = async (record) => {
    setEditingInvoice(record);
    loadLookups();
    loadPOOptions();
    try {
      const res = await api.get(`/accounts/invoices/${record.id}`);
      const data = res.data;
      setInvoiceType(data.invoice_type || 'purchase');
      setPartyType(data.party_type || 'vendor');
      form.setFieldsValue({
        ...data,
        invoice_date: data.invoice_date ? dayjs(data.invoice_date) : null,
        due_date: data.due_date ? dayjs(data.due_date) : null,
      });

      const items = (data.items || []).map((item, idx) => {
        const row = {
          key: item.id || Date.now() + idx,
          item_id: item.item_id,
          item_name: item.item_name || '',
          qty: item.qty || item.quantity || 0,
          uom: item.uom || '',
          rate: item.rate || item.unit_price || 0,
          discount_percent: item.discount_percent || item.discount_pct || 0,
          // Backend InvoiceItem serialises as cgst_rate / sgst_rate / igst_rate
          cgst_percent: item.cgst_percent ?? item.cgst_rate ?? 0,
          sgst_percent: item.sgst_percent ?? item.sgst_rate ?? 0,
          igst_percent: item.igst_percent ?? item.igst_rate ?? 0,
          tax_amount: 0,
          amount: 0,
        };
        return recalcItem(row);
      });
      setInvoiceItems(items.length > 0 ? items : [createEmptyItem()]);
    } catch (err) {
      message.error(getErrorMessage(err));
      return;
    }
    setDrawerOpen(true);
  };

  const handleView = async (record) => {
    setViewingInvoice(record);
    setViewDrawerOpen(true);
    setDetailLoading(true);
    setPaymentHistory([]);
    try {
      const [detailRes, paymentsRes] = await Promise.allSettled([
        api.get(`/accounts/invoices/${record.id}`),
        api.get(`/accounts/invoices/${record.id}/payments`),
      ]);
      if (detailRes.status === 'fulfilled') {
        setViewingInvoice(detailRes.value.data);
      }
      if (paymentsRes.status === 'fulfilled') {
        const pData = paymentsRes.value.data;
        setPaymentHistory(pData.items || pData.data || pData || []);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/accounts/invoices/${id}`);
      message.success('Invoice deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handlePOSelect = async (poId) => {
    if (!poId) return;
    try {
      // BUG-FIN-051: warn before overwriting user-edited items so we don't
      // silently discard manual changes when a different PO is reselected.
      const hasUserEdits = (invoiceItems || []).some(
        (it) => it && it.item_id && Number(it.rate || 0) > 0
      );
      if (hasUserEdits) {
        const ok = window.confirm(
          'Loading items from this PO will replace your current line items. Continue?'
        );
        if (!ok) return;
      }
      const found = poOptions.find((o) => o.value === poId);
      if (found && found.po) {
        form.setFieldsValue({ party_id: found.po.vendor_id });
      }
      const res = await api.get(`/procurement/purchase-orders/${poId}`);
      const poData = res.data;
      if (poData.vendor_id) form.setFieldsValue({ party_id: poData.vendor_id });
      if (poData.project_id) form.setFieldsValue({ project_id: poData.project_id });
      const items = (poData.items || []).map((item, idx) => {
        const row = {
          key: item.id || Date.now() + idx,
          item_id: item.item_id,
          item_name: item.item_name || '',
          qty: item.qty || item.quantity || 0,
          uom: item.uom || item.uom_name || '',
          uom_id: item.uom_id,  // backend requires uom_id, not just name
          // BUG-FIN-147: backend serializes PO items as `rate`; only fall
          // back to unit_price for legacy callers/payloads.
          rate: item.rate ?? item.unit_price ?? 0,
          discount_percent: item.discount_percent || item.discount_pct || 0,
          // BUG-FIN-PO-MAP: POItemResponse returns cgst_rate / sgst_rate / igst_rate,
          // NOT cgst_percent. The old || 9 fallback silently forced 9% CGST+SGST
          // on every item even when the PO had IGST-only or different rates.
          cgst_percent: item.cgst_percent ?? item.cgst_rate ?? 0,
          sgst_percent: item.sgst_percent ?? item.sgst_rate ?? 0,
          igst_percent: item.igst_percent ?? item.igst_rate ?? 0,
          tax_amount: 0,
          amount: 0,
        };
        return recalcItem(row);
      });
      setInvoiceItems(items.length > 0 ? items : [createEmptyItem()]);
      message.success('Items loaded from PO');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const validItems = invoiceItems.filter((i) => i.item_id && i.rate > 0);
      if (validItems.length === 0) {
        message.error('Please add at least one item with a rate');
        return;
      }
      const missingUom = validItems.find((i) => !i.uom_id);
      if (missingUom) {
        message.error(`Please select a UOM for item: ${missingUom.item_name || 'row ' + (validItems.indexOf(missingUom) + 1)}`);
        return;
      }
      setSubmitting(true);

      const payload = {
        ...values,
        invoice_type: invoiceType,
        party_type: partyType,
        invoice_date: formatDateForAPI(values.invoice_date),
        due_date: formatDateForAPI(values.due_date),
        subtotal: Number(calcSubtotal().toFixed(2)),
        discount_total: Number(calcDiscount().toFixed(2)),
        cgst_total: Number(calcCGST().toFixed(2)),
        sgst_total: Number(calcSGST().toFixed(2)),
        igst_total: Number(calcIGST().toFixed(2)),
        tax_amount: Number(calcTaxTotal().toFixed(2)),
        grand_total: Number(calcGrandTotal().toFixed(2)),
        items: validItems.map((item) => ({
          item_id: item.item_id,
          qty: item.qty,
          uom_id: item.uom_id,
          rate: item.rate,
          discount_pct: item.discount_percent || 0,
          cgst_rate: item.cgst_percent || 0,
          sgst_rate: item.sgst_percent || 0,
          igst_rate: item.igst_percent || 0,
        })),
      };

      if (editingInvoice) {
        await api.put(`/accounts/invoices/${editingInvoice.id}`, payload);
        message.success('Invoice updated');
      } else {
        await api.post('/accounts/invoices', payload);
        message.success('Invoice created');
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingInvoice(null);
      setInvoiceItems([]);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handlePrint = async (record) => {
    try {
      const res = await api.get(`/accounts/invoices/${record.id}/print`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const w = window.open(url, '_blank');
      if (w) w.print();
    } catch (err) {
      // Fallback: fetch with auth header and open as blob
      try {
        const fallbackRes = await api.get(`/accounts/invoices/${record.id}/print`, { responseType: 'blob' });
        const fallbackUrl = URL.createObjectURL(new Blob([fallbackRes.data], { type: 'application/pdf' }));
        window.open(fallbackUrl, '_blank');
      } catch {
        message.error('Failed to download invoice');
      }
    }
  };

  // Item columns for drawer
  const invoiceItemColumns = [
    { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item',
      dataIndex: 'item_id',
      width: 220,
      render: (val, record) =>
        record.item_name ? (
          <Tooltip title={record.item_name}>
            <Text ellipsis style={{ maxWidth: 200 }}>{record.item_name}</Text>
          </Tooltip>
        ) : (
          <ItemSelector
            value={val}
            onChange={(itemId, item) => {
              updateInvoiceItem(record.key, 'item_id', itemId);
              if (item) {
                updateInvoiceItem(record.key, 'item_name', item.item_name || item.name || '');
                // BUG-FIN-148: also capture primary UOM id and name so the
                // backend's required uom_id field is populated and submit
                // doesn't error with "select a UOM".
                updateInvoiceItem(record.key, 'uom', item.primary_uom_name || item.uom_name || item.uom || item.default_uom || '');
                updateInvoiceItem(record.key, 'uom_id', item.primary_uom_id || item.uom_id || null);
              }
            }}
            style={{ width: '100%' }}
          />
        ),
    },
    {
      title: 'Qty', dataIndex: 'qty', width: 70,
      render: (val, record) => (
        <InputNumber min={0.01} value={val} onChange={(v) => updateInvoiceItem(record.key, 'qty', v)} style={{ width: '100%' }} size="small" />
      ),
    },
    {
      title: 'UOM', dataIndex: 'uom', width: 60,
      render: (val) => <Text style={{ fontSize: 12 }}>{val || '-'}</Text>,
    },
    {
      title: 'Rate', dataIndex: 'rate', width: 90,
      render: (val, record) => (
        <InputNumber min={0} value={val} onChange={(v) => updateInvoiceItem(record.key, 'rate', v)} style={{ width: '100%' }} size="small" />
      ),
    },
    {
      title: 'Disc%', dataIndex: 'discount_percent', width: 65,
      render: (val, record) => (
        <InputNumber min={0} max={100} value={val} onChange={(v) => updateInvoiceItem(record.key, 'discount_percent', v)} style={{ width: '100%' }} size="small" />
      ),
    },
    {
      title: 'CGST%', dataIndex: 'cgst_percent', width: 65,
      render: (val, record) => (
        <InputNumber min={0} max={28} value={val} onChange={(v) => updateInvoiceItem(record.key, 'cgst_percent', v)} style={{ width: '100%' }} size="small" />
      ),
    },
    {
      title: 'SGST%', dataIndex: 'sgst_percent', width: 65,
      render: (val, record) => (
        <InputNumber min={0} max={28} value={val} onChange={(v) => updateInvoiceItem(record.key, 'sgst_percent', v)} style={{ width: '100%' }} size="small" />
      ),
    },
    {
      title: 'IGST%', dataIndex: 'igst_percent', width: 65,
      render: (val, record) => (
        <InputNumber min={0} max={28} value={val} onChange={(v) => updateInvoiceItem(record.key, 'igst_percent', v)} style={{ width: '100%' }} size="small" />
      ),
    },
    {
      title: 'Tax', dataIndex: 'tax_amount', width: 80, align: 'right',
      render: (val) => <Text style={{ fontSize: 12 }}>{formatCurrency(val)}</Text>,
    },
    {
      title: 'Amount', dataIndex: 'amount', width: 100, align: 'right',
      render: (val) => <Text strong style={{ fontSize: 12 }}>{formatCurrency(val)}</Text>,
    },
    {
      title: '', width: 35,
      render: (_, record) =>
        invoiceItems.length > 1 ? (
          <MinusCircleOutlined style={{ color: '#ff4d4f', cursor: 'pointer' }} onClick={() => removeItemRow(record.key)} />
        ) : null,
    },
  ];

  const getStatusStyle = (status) => {
    if (status === 'overdue') return { color: '#f5222d', fontWeight: 600 };
    if (status === 'partially_paid') return { color: '#fa8c16', fontWeight: 600 };
    return {};
  };

  const columns = [
    {
      title: 'Invoice Number',
      dataIndex: 'invoice_number',
      key: 'invoice_number',
      width: 160,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => handleView(record)}>{text}</a>,
    },
    {
      title: 'Vendor',
      dataIndex: 'party_name',
      key: 'party_name',
      width: 200,
      ellipsis: true,
      render: (val, r) => val || r.vendor_name || r.customer_name || '-',
    },
    {
      title: 'Invoice Date',
      dataIndex: 'invoice_date',
      key: 'invoice_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Due Date',
      dataIndex: 'due_date',
      key: 'due_date',
      width: 120,
      sorter: true,
      render: (v, record) => {
        const isOverdue = v && dayjs(v).isBefore(dayjs(), 'day') &&
          record.status !== 'paid' && record.status !== 'cancelled';
        return (
          <Text style={isOverdue ? { color: '#f5222d', fontWeight: 600 } : undefined}>
            {formatDate(v)}
            {isOverdue && <WarningOutlined style={{ marginLeft: 4, color: '#f5222d' }} />}
          </Text>
        );
      },
    },
    {
      title: 'Subtotal',
      dataIndex: 'subtotal',
      key: 'subtotal',
      width: 120,
      align: 'right',
      render: (v) => formatCurrency(v),
    },
    {
      title: 'Tax',
      dataIndex: 'tax_amount',
      key: 'tax_amount',
      width: 100,
      align: 'right',
      render: (v) => formatCurrency(v),
    },
    {
      title: 'Grand Total',
      dataIndex: 'grand_total',
      key: 'grand_total',
      width: 130,
      align: 'right',
      sorter: true,
      render: (v) => <Text strong>{formatCurrency(v)}</Text>,
    },
    {
      title: 'Paid',
      dataIndex: 'paid_amount',
      key: 'paid_amount',
      width: 120,
      align: 'right',
      render: (v) => <Text style={{ color: '#52c41a' }}>{formatCurrency(v || 0)}</Text>,
    },
    {
      title: 'Balance',
      dataIndex: 'balance_amount',
      key: 'balance_amount',
      width: 120,
      align: 'right',
      render: (v, record) => {
        const balance = v != null ? v : (record.grand_total || 0) - (record.paid_amount || 0);
        return <Text style={balance > 0 ? { color: '#f5222d', fontWeight: 600 } : undefined}>{formatCurrency(balance)}</Text>;
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 140,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(record)} />
          </Tooltip>
          {(record.status === 'draft' || record.status === 'unpaid') && (
            <Tooltip title="Edit">
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
            </Tooltip>
          )}
          <Tooltip title="Print">
            <Button type="link" size="small" icon={<PrinterOutlined />} onClick={() => handlePrint(record)} />
          </Tooltip>
          {record.status === 'draft' && (
            <Popconfirm title="Delete this invoice?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
              <Button type="link" size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 160 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Draft', value: 'draft' },
          { label: 'Unpaid', value: 'unpaid' },
          { label: 'Partially Paid', value: 'partially_paid' },
          { label: 'Paid', value: 'paid' },
          { label: 'Overdue', value: 'overdue' },
          { label: 'Cancelled', value: 'cancelled' },
        ]}
      />
      <DatePicker.RangePicker
        value={filterDateRange}
        onChange={(v) => { setFilterDateRange(v); setRefreshKey((k) => k + 1); }}
        format={DATE_FORMAT}
        placeholder={['From Date', 'To Date']}
        style={{ width: 240 }}
      />
      <Switch
        checked={filterOverdue}
        onChange={(v) => { setFilterOverdue(v); setRefreshKey((k) => k + 1); }}
        checkedChildren="Overdue"
        unCheckedChildren="All"
      />
    </Space>
  );

  const tabItems = [
    { key: 'purchase', label: 'Purchase Invoices' },
  ];

  return (
    <div>
      <PageHeader title="Invoices" subtitle="Manage purchase and sales invoices">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          Create Invoice
        </Button>
      </PageHeader>

      <Card bodyStyle={{ paddingBottom: 0 }}>
        <Tabs
          activeKey={activeTab}
          onChange={(key) => {
            setActiveTab(key);
            setFilterStatus(undefined);
            setFilterParty(undefined);
            setFilterOverdue(false);
            setFilterDateRange(null);
            setRefreshKey((k) => k + 1);
          }}
          items={tabItems}
        />
      </Card>

      <div style={{ marginTop: 16 }}>
        <DataTable
          key={`${activeTab}-${refreshKey}`}
          columns={columns}
          fetchFunction={fetchInvoices}
          rowKey="id"
          searchPlaceholder="Search by invoice number, party..."
          exportFileName={`${activeTab}_invoices`}
          toolbar={toolbar}
          scroll={{ x: 1700 }}
        />
      </div>

      {/* Create / Edit Drawer */}
      <Drawer
        title={editingInvoice ? `Edit Invoice ${editingInvoice.invoice_number}` : 'Create Invoice'}
        width={1100}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setEditingInvoice(null); form.resetFields(); setInvoiceItems([]); }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); setEditingInvoice(null); form.resetFields(); setInvoiceItems([]); }}>
              Cancel
            </Button>
            <Button type="primary" onClick={handleSubmit} loading={submitting}>
              {editingInvoice ? 'Update Invoice' : 'Create Invoice'}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="party_id" label="Vendor" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  options={vendors}
                  placeholder="Select vendor"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={6}>
              <Form.Item
                name="po_id"
                label="Link to PO"
              >
                <Select
                  options={poOptions}
                  placeholder="Select PO"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  onChange={handlePOSelect}
                  onSearch={loadPOOptions}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="project_id" label="Project">
                <Select options={projects} placeholder="Project" allowClear showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="invoice_date" label="Invoice Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="due_date" label="Due Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
          </Row>
        </Form>

        <Divider orientation="left">Items</Divider>
        <Table
          dataSource={invoiceItems}
          columns={invoiceItemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 1050 }}
          footer={() => (
            <Button type="dashed" onClick={addItemRow} icon={<PlusOutlined />} block>
              Add Item
            </Button>
          )}
        />

        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ width: 340 }}>
            <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Col span={14}><Text>Subtotal:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}><Text>{formatCurrency(calcSubtotal())}</Text></Col>
            </Row>
            <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Col span={14}><Text>Discount:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}><Text type="danger">-{formatCurrency(calcDiscount())}</Text></Col>
            </Row>
            <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Col span={14}><Text>CGST:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}><Text>{formatCurrency(calcCGST())}</Text></Col>
            </Row>
            <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Col span={14}><Text>SGST:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}><Text>{formatCurrency(calcSGST())}</Text></Col>
            </Row>
            <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Col span={14}><Text>IGST:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}><Text>{formatCurrency(calcIGST())}</Text></Col>
            </Row>
            <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Col span={14}><Text>Tax Total:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}><Text>{formatCurrency(calcTaxTotal())}</Text></Col>
            </Row>
            <Row style={{ padding: '8px 0', background: '#fafafa', borderRadius: 4, marginTop: 4 }}>
              <Col span={14}><Text strong style={{ fontSize: 16 }}>Grand Total:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}><Text strong style={{ fontSize: 16, color: '#eb2f96' }}>{formatCurrency(calcGrandTotal())}</Text></Col>
            </Row>
          </div>
        </div>

        <Divider orientation="left">Additional Details</Divider>
        <Form form={form} layout="vertical">
          <Form.Item name="remarks" label="Remarks">
            <TextArea rows={2} placeholder="Any remarks..." />
          </Form.Item>
        </Form>
      </Drawer>

      {/* View Detail Drawer */}
      <Drawer
        title={
          viewingInvoice ? (
            <Space>
              <Text strong>{viewingInvoice.invoice_number}</Text>
              <StatusTag status={viewingInvoice.status} />
            </Space>
          ) : 'Invoice Details'
        }
        width={780}
        open={viewDrawerOpen}
        onClose={() => { setViewDrawerOpen(false); setViewingInvoice(null); setPaymentHistory([]); }}
        destroyOnHidden
        extra={
          viewingInvoice && (
            <Button icon={<PrinterOutlined />} onClick={() => handlePrint(viewingInvoice)}>
              Print Invoice
            </Button>
          )
        }
      >
        {detailLoading ? (
          <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
        ) : viewingInvoice && (
          <>
            <Card size="small" style={{ marginBottom: 16 }}>
              <Descriptions column={2} size="small">
                <Descriptions.Item label="Invoice Number">{viewingInvoice.invoice_number}</Descriptions.Item>
                <Descriptions.Item label="Type">
                  <StatusTag status={viewingInvoice.invoice_type} />
                </Descriptions.Item>
                <Descriptions.Item label="Party">{viewingInvoice.party_name || '-'}</Descriptions.Item>
                <Descriptions.Item label="Invoice Date">{formatDate(viewingInvoice.invoice_date)}</Descriptions.Item>
                <Descriptions.Item label="Due Date">
                  <Text style={
                    viewingInvoice.due_date && dayjs(viewingInvoice.due_date).isBefore(dayjs(), 'day') && viewingInvoice.status !== 'paid'
                      ? { color: '#f5222d', fontWeight: 600 }
                      : undefined
                  }>
                    {formatDate(viewingInvoice.due_date)}
                  </Text>
                </Descriptions.Item>
                <Descriptions.Item label="Project">{viewingInvoice.project_name || '-'}</Descriptions.Item>
                <Descriptions.Item label="Status"><StatusTag status={viewingInvoice.status} /></Descriptions.Item>
              </Descriptions>
            </Card>

            {/* Items */}
            {viewingInvoice.items && viewingInvoice.items.length > 0 && (
              <Card size="small" title="Invoice Items" style={{ marginBottom: 16 }}>
                <Table
                  dataSource={viewingInvoice.items}
                  rowKey={(r, idx) => r.id || idx}
                  pagination={false}
                  size="small"
                  scroll={{ x: 700 }}
                  columns={[
                    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
                    { title: 'Item', dataIndex: 'item_name', ellipsis: true, render: (v) => v || '-' },
                    { title: 'Qty', dataIndex: 'qty', width: 70, render: (v, r) => v || r.quantity || '-' },
                    { title: 'UOM', dataIndex: 'uom', width: 60 },
                    { title: 'Rate', dataIndex: 'rate', width: 90, align: 'right', render: (v) => formatCurrency(v) },
                    { title: 'Tax', dataIndex: 'tax_amount', width: 90, align: 'right', render: (v) => formatCurrency(v) },
                    { title: 'Amount', dataIndex: 'amount', width: 110, align: 'right', render: (v) => <Text strong>{formatCurrency(v)}</Text> },
                  ]}
                />
              </Card>
            )}

            {/* Totals */}
            <Card size="small" style={{ marginBottom: 16 }}>
              <Row gutter={16}>
                <Col span={12}>
                  <Descriptions column={1} size="small">
                    <Descriptions.Item label="Subtotal">{formatCurrency(viewingInvoice.subtotal)}</Descriptions.Item>
                    <Descriptions.Item label="Tax">{formatCurrency(viewingInvoice.tax_amount)}</Descriptions.Item>
                    <Descriptions.Item label="Grand Total">
                      <Text strong style={{ color: '#eb2f96', fontSize: 16 }}>{formatCurrency(viewingInvoice.grand_total)}</Text>
                    </Descriptions.Item>
                  </Descriptions>
                </Col>
                <Col span={12}>
                  <Descriptions column={1} size="small">
                    <Descriptions.Item label="Paid Amount">
                      <Text style={{ color: '#52c41a' }}>{formatCurrency(viewingInvoice.paid_amount || 0)}</Text>
                    </Descriptions.Item>
                    <Descriptions.Item label="Balance">
                      <Text strong style={{
                        color: (viewingInvoice.balance_amount || ((viewingInvoice.grand_total || 0) - (viewingInvoice.paid_amount || 0))) > 0 ? '#f5222d' : '#52c41a',
                        fontSize: 16,
                      }}>
                        {formatCurrency(viewingInvoice.balance_amount != null ? viewingInvoice.balance_amount : ((viewingInvoice.grand_total || 0) - (viewingInvoice.paid_amount || 0)))}
                      </Text>
                    </Descriptions.Item>
                  </Descriptions>
                </Col>
              </Row>
            </Card>

            {/* Payment History */}
            <Card size="small" title="Payment History" style={{ marginBottom: 16 }}>
              {paymentHistory.length > 0 ? (
                <Table
                  dataSource={paymentHistory}
                  rowKey={(r, idx) => r.id || idx}
                  pagination={false}
                  size="small"
                  columns={[
                    { title: 'Payment #', dataIndex: 'payment_number', width: 140 },
                    { title: 'Date', dataIndex: 'payment_date', width: 110, render: (v) => formatDate(v) },
                    { title: 'Mode', dataIndex: 'payment_mode', width: 120, render: (v) => (v || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) },
                    { title: 'Reference', dataIndex: 'reference_number', width: 140 },
                    { title: 'Amount', dataIndex: 'amount', width: 120, align: 'right', render: (v) => <Text strong style={{ color: '#52c41a' }}>{formatCurrency(v)}</Text> },
                  ]}
                />
              ) : (
                <Text type="secondary">No payments recorded yet</Text>
              )}
            </Card>
          </>
        )}
      </Drawer>
    </div>
  );
};

export default Invoices;

