import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Button, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, Row, Col, Table, Card, Descriptions, Divider,
  Typography, Tooltip, Tag, Spin, Upload, App
} from 'antd';
import {
  ArrowLeftOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  MinusCircleOutlined, SaveOutlined, UploadOutlined, PrinterOutlined,
  WarningOutlined
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import {
  formatDate, formatCurrency, formatNumber, getErrorMessage, formatDateForAPI,
  handleFormValidationFailed
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const INVOICE_TYPES = [
  { label: 'Purchase', value: 'purchase' },
];

const TAX_RATE_OPTIONS = [0, 5, 12, 18, 28].map((r) => ({ label: `${r}%`, value: r }));

const InvoiceForm = () => {
  const { message } = App.useApp();
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isNew = !id || id === 'new';

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [invoice, setInvoice] = useState(null);
  const [editMode, setEditMode] = useState(isNew);

  // Form states
  const [invoiceItems, setInvoiceItems] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [poOptions, setPoOptions] = useState([]);
  const [projects, setProjects] = useState([]);
  const [paymentHistory, setPaymentHistory] = useState([]);

  // Attachment
  const [attachmentUrl, setAttachmentUrl] = useState('');
  const [fileList, setFileList] = useState([]);

  // Rounding and tax logic matching Invoices.jsx
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

  const createEmptyItem = () => ({
    key: Date.now() + Math.random(),
    item_id: null,
    item_name: '',
    qty: 1,
    uom: '',
    uom_id: null,
    rate: 0,
    discount_percent: 0,
    cgst_percent: 9,
    sgst_percent: 9,
    igst_percent: 0,
    tax_amount: 0,
    amount: 0,
  });

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

  // Totals calculations
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

  // --- Lookups ---
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

  // --- Fetch existing record ---
  const fetchInvoice = useCallback(async () => {
    setLoading(true);
    setPaymentHistory([]);
    try {
      const [detailRes, paymentsRes] = await Promise.allSettled([
        api.get(`/accounts/invoices/${id}`),
        api.get(`/accounts/invoices/${id}/payments`),
      ]);
      if (detailRes.status === 'fulfilled') {
        const data = detailRes.value.data;
        setInvoice(data);
        setAttachmentUrl(data.attachment_url || '');
        if (data.attachment_url) {
          setFileList([{
            uid: '-1',
            name: data.attachment_url.split('/').pop() || 'Attachment',
            status: 'done',
            url: data.attachment_url,
          }]);
        }
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
            uom_id: item.uom_id || null,
            rate: item.rate || item.unit_price || 0,
            discount_percent: item.discount_percent || item.discount_pct || 0,
            cgst_percent: item.cgst_percent ?? item.cgst_rate ?? 0,
            sgst_percent: item.sgst_percent ?? item.sgst_rate ?? 0,
            igst_percent: item.igst_percent ?? item.igst_rate ?? 0,
            tax_amount: 0,
            amount: 0,
          };
          return recalcItem(row);
        });
        setInvoiceItems(items.length > 0 ? items : [createEmptyItem()]);

        const queryParams = new URLSearchParams(location.search);
        if (queryParams.get('edit') === 'true' && (data.status === 'draft' || data.status === 'unpaid')) {
          setEditMode(true);
        }
      }
      if (paymentsRes.status === 'fulfilled') {
        const pData = paymentsRes.value.data;
        setPaymentHistory(pData.items || pData.data || pData || []);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/accounts/invoices');
    } finally {
      setLoading(false);
    }
  }, [id, form, location.search, navigate, message]);

  // Init
  useEffect(() => {
    loadLookups();
    loadPOOptions();
    if (!isNew) {
      fetchInvoice();
    } else {
      form.setFieldsValue({
        invoice_type: 'purchase',
        party_type: 'vendor',
        invoice_date: dayjs(),
        due_date: dayjs().add(30, 'day'),
      });
      setInvoiceItems([createEmptyItem()]);

      // Handle deep link from PO
      const queryParams = new URLSearchParams(location.search);
      const incomingPoId = queryParams.get('po_id');
      if (incomingPoId) {
        setTimeout(() => {
          form.setFieldsValue({ po_id: Number(incomingPoId) });
          handlePOSelect(Number(incomingPoId));
        }, 500);
      }
    }
  }, [id, isNew, fetchInvoice, loadLookups, loadPOOptions, form]);

  const handlePOSelect = async (poId) => {
    if (!poId) return;
    try {
      const hasUserEdits = (invoiceItems || []).some(
        (it) => it && it.item_id && Number(it.rate || 0) > 0
      );
      if (hasUserEdits) {
        const ok = window.confirm(
          'Loading items from this PO will replace your current line items. Continue?'
        );
        if (!ok) return;
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
          uom_id: item.uom_id,
          rate: item.rate ?? item.unit_price ?? 0,
          discount_percent: item.discount_percent || item.discount_pct || 0,
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

  // Attachment upload handler
  const handleUpload = async ({ file, onSuccess, onError, onProgress }) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await api.post('/attachments/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (event) => {
          const percent = Math.round((event.loaded / event.total) * 100);
          onProgress({ percent });
        },
      });
      const data = response.data;
      setAttachmentUrl(data.url || data.file_url || '');
      onSuccess(data);
      message.success('File uploaded');
    } catch (error) {
      onError(error);
      message.error('Upload failed');
    }
  };

  const handleFileChange = ({ fileList: newFileList }) => {
    setFileList(newFileList);
    if (newFileList.length === 0) {
      setAttachmentUrl('');
    }
  };

  const handlePrint = async () => {
    try {
      const res = await api.get(`/accounts/invoices/${id}/print`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const w = window.open(url, '_blank');
      if (w) w.print();
    } catch (err) {
      try {
        const fallbackRes = await api.get(`/accounts/invoices/${id}/print`, { responseType: 'blob' });
        const fallbackUrl = URL.createObjectURL(new Blob([fallbackRes.data], { type: 'application/pdf' }));
        window.open(fallbackUrl, '_blank');
      } catch {
        message.error('Failed to download invoice');
      }
    }
  };

  const handleDelete = async () => {
    try {
      await api.delete(`/accounts/invoices/${id}`);
      message.success('Invoice deleted');
      navigate('/accounts/invoices');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Submit ---
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
        invoice_type: 'purchase',
        party_type: 'vendor',
        invoice_date: formatDateForAPI(values.invoice_date),
        due_date: formatDateForAPI(values.due_date),
        attachment_url: attachmentUrl || null,
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

      if (!isNew) {
        await api.put(`/accounts/invoices/${id}`, payload);
        message.success('Invoice updated');
        setEditMode(false);
        fetchInvoice();
      } else {
        const res = await api.post('/accounts/invoices', payload);
        const newId = res.data?.id;
        message.success('Invoice created');
        if (newId) {
          navigate(`/accounts/invoices/${newId}`);
        } else {
          navigate('/accounts/invoices');
        }
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

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}>
        <Spin size="large" />
      </div>
    );
  }

  // --- VIEW MODE ---
  if (!isNew && invoice && !editMode) {
    const invItems = invoice.items || [];
    const totalAmount = invoice.grand_total || invoice.total_amount || 0;

    return (
      <div>
        <PageHeader
          title={invoice.invoice_number || `Invoice #${id}`}
          subtitle="Invoice Details"
        >
          <Space>
            {(invoice.status === 'draft' || invoice.status === 'unpaid') && (
              <Button icon={<EditOutlined />} onClick={() => setEditMode(true)} type="primary">
                Edit
              </Button>
            )}
            <Button icon={<PrinterOutlined />} onClick={handlePrint}>Print</Button>
            {invoice.status === 'draft' && (
              <Popconfirm title="Delete this invoice?" onConfirm={handleDelete} okButtonProps={{ danger: true }}>
                <Button danger icon={<DeleteOutlined />}>Delete</Button>
              </Popconfirm>
            )}
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/accounts/invoices')}>
              Back
            </Button>
          </Space>
        </PageHeader>

        <Card style={{ marginBottom: 16 }}>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="Invoice Number">{invoice.invoice_number || '-'}</Descriptions.Item>
            <Descriptions.Item label="Invoice Date">{formatDate(invoice.invoice_date)}</Descriptions.Item>
            <Descriptions.Item label="Due Date">{formatDate(invoice.due_date)}</Descriptions.Item>
            <Descriptions.Item label="Invoice Type">
              {INVOICE_TYPES.find((t) => t.value === invoice.invoice_type)?.label || invoice.invoice_type || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Vendor">{invoice.party_name || invoice.vendor_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Project">{invoice.project_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={invoice.status} /></Descriptions.Item>
            <Descriptions.Item label="Attachment">
              {invoice.attachment_url ? (
                <a href={invoice.attachment_url} target="_blank" rel="noopener noreferrer">View Attachment</a>
              ) : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Remarks" span={3}>{invoice.remarks || '-'}</Descriptions.Item>
          </Descriptions>
        </Card>

        <Card title="Invoice Items" style={{ marginBottom: 16 }}>
          <Table
            dataSource={invItems}
            rowKey="id"
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
              { title: 'Item Code', width: 110, render: (_, r) => r.item_code || (r.item && r.item.item_code) || '-' },
              { title: 'Item Name', width: 200, render: (_, r) => r.item_name || (r.item && (r.item.item_name || r.item.name)) || '-' },
              { title: 'Qty', dataIndex: 'qty', width: 70, align: 'right', render: (v) => formatNumber(v || 0) },
              { title: 'UOM', dataIndex: 'uom', width: 70, render: (v, r) => v || r.unit || '-' },
              { title: 'Rate', dataIndex: 'rate', width: 100, align: 'right', render: (v) => formatCurrency(v) },
              { title: 'Disc %', dataIndex: 'discount_pct', width: 70, align: 'right', render: (v) => `${v || 0}%` },
              { title: 'CGST %', dataIndex: 'cgst_rate', width: 70, align: 'right', render: (v) => `${v || 0}%` },
              { title: 'SGST %', dataIndex: 'sgst_rate', width: 70, align: 'right', render: (v) => `${v || 0}%` },
              { title: 'IGST %', dataIndex: 'igst_rate', width: 70, align: 'right', render: (v) => `${v || 0}%` },
              {
                title: 'Amount', width: 120, align: 'right',
                render: (_, r) => {
                  const gross = (r.qty || 0) * (r.rate || 0);
                  const disc = gross * ((r.discount_pct || 0) / 100);
                  const base = gross - disc;
                  const tax = calcTaxAmount(base, r.cgst_rate || 0) + calcTaxAmount(base, r.sgst_rate || 0) + calcTaxAmount(base, r.igst_rate || 0);
                  return formatCurrency(base + tax);
                },
              },
            ]}
          />

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <div style={{ width: 300 }}>
              <Row justify="space-between" style={{ marginBottom: 4 }}>
                <Col><Text>Subtotal:</Text></Col>
                <Col><Text>{formatCurrency(invoice.subtotal)}</Text></Col>
              </Row>
              <Row justify="space-between" style={{ marginBottom: 4 }}>
                <Col><Text>Tax:</Text></Col>
                <Col><Text>{formatCurrency(invoice.tax_amount)}</Text></Col>
              </Row>
              <Divider style={{ margin: '8px 0' }} />
              <Row justify="space-between">
                <Col><Text strong style={{ fontSize: 16 }}>Grand Total:</Text></Col>
                <Col><Text strong style={{ fontSize: 16 }}>{formatCurrency(totalAmount)}</Text></Col>
              </Row>
            </div>
          </div>
        </Card>

        {paymentHistory.length > 0 && (
          <Card title="Payment History">
            <Table
              dataSource={paymentHistory}
              rowKey="id"
              pagination={false}
              size="small"
              columns={[
                { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
                { title: 'Payment No', dataIndex: 'payment_number' },
                { title: 'Date', dataIndex: 'payment_date', render: (v) => formatDate(v) },
                { title: 'Amount', dataIndex: 'amount', align: 'right', render: (v) => formatCurrency(v) },
                { title: 'Reference', dataIndex: 'reference_number', render: (v) => v || '-' },
                { title: 'Mode', dataIndex: 'payment_mode' },
              ]}
            />
          </Card>
        )}
      </div>
    );
  }

  // --- EDIT / CREATE MODE ---
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
      title: 'UOM', dataIndex: 'uom', width: 100,
      render: (val, record) => (
        <Select
          value={record.uom_id}
          onChange={(v) => {
            updateInvoiceItem(record.key, 'uom_id', v);
            const foundUom = uoms.find(o => o.value === v);
            if (foundUom) {
              updateInvoiceItem(record.key, 'uom', foundUom.label);
            }
          }}
          options={uoms}
          placeholder="UOM"
          size="small"
          style={{ width: '100%' }}
          showSearch
          optionFilterProp="label"
        />
      ),
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

  return (
    <div>
      <PageHeader
        title={isNew ? 'Create Invoice' : `Edit Invoice`}
        subtitle="Manage invoice details and taxes"
      >
        <Space>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={handleSubmit}
            loading={submitting}
          >
            Save
          </Button>
          <Button
            onClick={() => {
              if (isNew) {
                navigate('/accounts/invoices');
              } else {
                setEditMode(false);
              }
            }}
          >
            Cancel
          </Button>
        </Space>
      </PageHeader>

      <Card style={{ marginBottom: 16 }}>
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
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="Attachment">
                <Upload
                  fileList={fileList}
                  customRequest={handleUpload}
                  onChange={handleFileChange}
                  maxCount={1}
                  accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx"
                >
                  <Button icon={<UploadOutlined />}>Upload Attachment</Button>
                </Upload>
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="remarks" label="Remarks">
                <TextArea rows={2} placeholder="Any remarks..." />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      <Card title="Invoice Items">
        <Table
          dataSource={invoiceItems}
          columns={invoiceItemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 1200 }}
          footer={() => (
            <Button type="dashed" onClick={addItemRow} icon={<PlusOutlined />} block>
              Add Item
            </Button>
          )}
        />

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <div style={{ width: 300 }}>
            <Row justify="space-between" style={{ marginBottom: 4 }}>
              <Col><Text>Subtotal:</Text></Col>
              <Col><Text>{formatCurrency(calcSubtotal())}</Text></Col>
            </Row>
            <Row justify="space-between" style={{ marginBottom: 4 }}>
              <Col><Text>Tax:</Text></Col>
              <Col><Text>{formatCurrency(calcTaxTotal())}</Text></Col>
            </Row>
            <Divider style={{ margin: '8px 0' }} />
            <Row justify="space-between">
              <Col><Text strong style={{ fontSize: 16 }}>Grand Total:</Text></Col>
              <Col><Text strong style={{ fontSize: 16 }}>{formatCurrency(calcGrandTotal())}</Text></Col>
            </Row>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default InvoiceForm;
