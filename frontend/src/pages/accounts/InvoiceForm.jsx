import React, { useState, useEffect, useCallback } from 'react';
import {
  Button, Form, Input, InputNumber, Select, Space, DatePicker,
  message, Row, Col, Table, Card, Descriptions, Divider,
  Typography, Tooltip, Spin, Upload,
} from 'antd';
import {
  PlusOutlined, ArrowLeftOutlined, SendOutlined, EditOutlined,
  MinusCircleOutlined, SaveOutlined, UploadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useParams, useNavigate } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import {
  formatDate, formatCurrency, getErrorMessage, formatDateForAPI,
  calcTaxAmount, handleFormValidationFailed,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const INVOICE_TYPES = [
  { label: 'Purchase', value: 'purchase' },
];

const InvoiceForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [invoice, setInvoice] = useState(null);
  const [editMode, setEditMode] = useState(isNew);

  // Items
  const [invoiceItems, setInvoiceItems] = useState([
    { key: Date.now(), item_id: null, item_name: '', qty: 1, uom_id: null, uom: '', rate: 0, discount_pct: 0, cgst_rate: 0, sgst_rate: 0, igst_rate: 0 },
  ]);

  // Lookups
  const [vendors, setVendors] = useState([]);
  const [projects, setProjects] = useState([]);
  const [uoms, setUoms] = useState([]);

  // Attachment
  const [attachmentUrl, setAttachmentUrl] = useState('');
  const [fileList, setFileList] = useState([]);

  const loadLookups = useCallback(async () => {
    try {
      const [vendorRes, projRes, uomRes] = await Promise.allSettled([
        api.get('/masters/vendors', { params: { page_size: 200 } }),
        api.get('/masters/projects', { params: { page_size: 200 } }),
        api.get('/masters/uom', { params: { page_size: 200 } }),
      ]);
      if (vendorRes.status === 'fulfilled') {
        const v = vendorRes.value.data;
        setVendors((v.items || v.data || v || []).map((i) => ({ label: i.name || i.vendor_name, value: i.id })));
      }
      if (projRes.status === 'fulfilled') {
        const p = projRes.value.data;
        setProjects((p.items || p.data || p || []).map((i) => ({ label: i.name || i.project_name, value: i.id })));
      }
      if (uomRes.status === 'fulfilled') {
        const u = uomRes.value.data;
        const items = u.items || u.data || u || [];
        setUoms(items.map((i) => ({ label: `${i.name} (${i.abbreviation || ''})`, value: i.id })));
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    loadLookups();
    if (!isNew) {
      fetchInvoice();
    } else {
      form.setFieldsValue({
        invoice_type: 'purchase',
        invoice_date: dayjs(),
        due_date: dayjs().add(30, 'day'),
      });
    }
  }, [id]);

  const fetchInvoice = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/accounts/invoices/${id}`);
      const data = res.data;
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
      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_name: item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.item_name || item.item.name}` : ''),
        qty: item.qty || item.quantity || 0,
        uom_id: item.uom_id || null,
        uom: item.uom || item.unit || '',
        rate: item.rate || 0,
        discount_pct: item.discount_pct || 0,
        cgst_rate: item.cgst_rate || 0,
        sgst_rate: item.sgst_rate || 0,
        igst_rate: item.igst_rate || 0,
      }));
      setInvoiceItems(items.length > 0 ? items : [
        { key: Date.now(), item_id: null, item_name: '', qty: 1, uom_id: null, uom: '', rate: 0, discount_pct: 0, cgst_rate: 0, sgst_rate: 0, igst_rate: 0 },
      ]);
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/accounts/invoices');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const validItems = invoiceItems.filter((item) => item.item_id);
      if (validItems.length === 0) {
        message.error('Please add at least one item');
        const tbl = document.querySelector('.ant-table');
        if (tbl) {
          tbl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          tbl.style.border = '1.5px dashed #FF4D4F';
          tbl.style.backgroundColor = '#FFF2F0';
          setTimeout(() => {
            tbl.style.border = '';
            tbl.style.backgroundColor = '';
          }, 3000);
        }
        return;
      }
      // Validate each item has required fields
      for (const item of validItems) {
        if (!item.qty || item.qty <= 0) {
          message.error('Each item must have a quantity greater than 0');
          const rowInputs = document.querySelectorAll('.ant-input-number');
          rowInputs.forEach((inp) => {
            const val = parseFloat(inp.querySelector('input')?.value || '0');
            if (val <= 0 || isNaN(val)) {
              inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
              inp.style.border = '1.5px solid #FF4D4F';
              inp.style.backgroundColor = '#FFF2F0';
              setTimeout(() => {
                inp.style.border = '';
                inp.style.backgroundColor = '';
              }, 3000);
            }
          });
          return;
        }
        if (item.rate < 0) {
          message.error('Rate cannot be negative');
          return;
        }
        if (item.discount_pct < 0 || item.discount_pct > 100) {
          message.error('Discount percentage must be between 0% and 100%');
          return;
        }
      }
      setSubmitting(true);

      const payload = {
        ...values,
        invoice_date: formatDateForAPI(values.invoice_date),
        due_date: formatDateForAPI(values.due_date),
        attachment_url: attachmentUrl || null,
        items: validItems.map((item) => ({
          item_id: item.item_id,
          qty: item.qty,
          uom_id: item.uom_id || null,
          rate: item.rate,
          discount_pct: item.discount_pct || 0,
          cgst_rate: item.cgst_rate || 0,
          sgst_rate: item.sgst_rate || 0,
          igst_rate: item.igst_rate || 0,
        })),
      };

      if (isNew) {
        const res = await api.post('/accounts/invoices', payload);
        message.success('Invoice created successfully');
        navigate(`/accounts/invoices/${res.data.id || res.data.data?.id}`);
      } else {
        await api.put(`/accounts/invoices/${id}`, payload);
        message.success('Invoice updated successfully');
        setEditMode(false);
        fetchInvoice();
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

  // Item row management
  const addItemRow = () => {
    setInvoiceItems((prev) => [
      ...prev,
      { key: Date.now(), item_id: null, item_name: '', qty: 1, uom_id: null, uom: '', rate: 0, discount_pct: 0, cgst_rate: 0, sgst_rate: 0, igst_rate: 0 },
    ]);
  };

  const removeItemRow = (key) => {
    setInvoiceItems((prev) => prev.filter((item) => item.key !== key));
  };

  const updateItemRow = (key, field, value) => {
    setInvoiceItems((prev) =>
      prev.map((item) => (item.key === key ? { ...item, [field]: value } : item))
    );
  };

  // Compute line totals
  const getLineBase = (item) => {
    const gross = (item.qty || 0) * (item.rate || 0);
    const discount = gross * ((item.discount_pct || 0) / 100);
    return Number((gross - discount).toFixed(2));
  };

  const getLineTax = (item) => {
    const base = getLineBase(item);
    return Number((
      calcTaxAmount(base, item.cgst_rate || 0) +
      calcTaxAmount(base, item.sgst_rate || 0) +
      calcTaxAmount(base, item.igst_rate || 0)
    ).toFixed(2));
  };

  const getLineTotal = (item) => {
    return Number((getLineBase(item) + getLineTax(item)).toFixed(2));
  };

  const computeTotals = () => {
    let subtotal = 0;
    let totalTax = 0;
    invoiceItems.forEach((item) => {
      if (item.item_id) {
        subtotal += getLineBase(item);
        totalTax += getLineTax(item);
      }
    });
    return {
      subtotal: Number(subtotal.toFixed(2)),
      totalTax: Number(totalTax.toFixed(2)),
      grandTotal: Number((subtotal + totalTax).toFixed(2)),
    };
  };

  const totals = computeTotals();

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}><Spin size="large" /></div>;
  }

  // Detail / View mode for existing invoice
  if (!isNew && invoice && !editMode) {
    const invItems = invoice.items || [];
    const viewSubtotal = invItems.reduce((sum, item) => {
      const gross = (item.qty || 0) * (item.rate || 0);
      const disc = gross * ((item.discount_pct || 0) / 100);
      return sum + gross - disc;
    }, 0);
    const viewTax = invItems.reduce((sum, item) => {
      const gross = (item.qty || 0) * (item.rate || 0);
      const disc = gross * ((item.discount_pct || 0) / 100);
      const base = gross - disc;
      return sum + calcTaxAmount(base, item.cgst_rate || 0) + calcTaxAmount(base, item.sgst_rate || 0) + calcTaxAmount(base, item.igst_rate || 0);
    }, 0);
    const viewGrand = invoice.grand_total || invoice.total_amount || (viewSubtotal + viewTax);

    return (
      <div>
        <PageHeader title={invoice.invoice_number || `Invoice #${id}`} subtitle="Invoice Detail">
          <Space>
            {(invoice.status === 'draft') && (
              <Button icon={<EditOutlined />} onClick={() => setEditMode(true)}>Edit</Button>
            )}
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/accounts/invoices')}>Back</Button>
          </Space>
        </PageHeader>

        <Card>
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

          <Divider orientation="left">Items</Divider>
          <Table
            dataSource={invItems}
            rowKey={(r) => r.id || r.item_id}
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
              { title: 'Item Code', width: 110, render: (_, r) => r.item_code || (r.item && r.item.item_code) || '-' },
              { title: 'Item Name', width: 200, render: (_, r) => r.item_name || (r.item && (r.item.item_name || r.item.name)) || '-' },
              { title: 'Qty', dataIndex: 'qty', width: 70, align: 'right', render: (v) => v || 0 },
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

          {/* Totals */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <div style={{ width: 300 }}>
              <Row justify="space-between" style={{ marginBottom: 4 }}>
                <Col><Text>Subtotal:</Text></Col>
                <Col><Text>{formatCurrency(viewSubtotal)}</Text></Col>
              </Row>
              <Row justify="space-between" style={{ marginBottom: 4 }}>
                <Col><Text>Tax:</Text></Col>
                <Col><Text>{formatCurrency(viewTax)}</Text></Col>
              </Row>
              <Divider style={{ margin: '8px 0' }} />
              <Row justify="space-between">
                <Col><Text strong style={{ fontSize: 16 }}>Grand Total:</Text></Col>
                <Col><Text strong style={{ fontSize: 16 }}>{formatCurrency(viewGrand)}</Text></Col>
              </Row>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // Edit / Create mode
  const TAX_RATE_OPTIONS = [0, 5, 12, 18, 28].map((r) => ({ label: `${r}%`, value: r }));

  const itemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item', dataIndex: 'item_id', width: 240,
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
      title: 'Qty', dataIndex: 'qty', width: 80,
      render: (val, record) => (
        <InputNumber min={0.01} value={val} onChange={(v) => updateItemRow(record.key, 'qty', v)} style={{ width: '100%' }} />
      ),
    },
    {
      title: 'UOM', dataIndex: 'uom_id', width: 130,
      render: (val, record) => (
        <Select
          value={val}
          onChange={(v) => updateItemRow(record.key, 'uom_id', v)}
          options={uoms}
          placeholder="UOM"
          showSearch
          optionFilterProp="label"
          allowClear
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Rate', dataIndex: 'rate', width: 100,
      render: (val, record) => (
        <InputNumber min={0} value={val} onChange={(v) => updateItemRow(record.key, 'rate', v)} style={{ width: '100%' }} precision={2} />
      ),
    },
    {
      title: 'Disc %', dataIndex: 'discount_pct', width: 80,
      render: (val, record) => (
        <InputNumber min={0} max={100} value={val} onChange={(v) => updateItemRow(record.key, 'discount_pct', v)} style={{ width: '100%' }} precision={2} />
      ),
    },
    {
      title: 'CGST %', dataIndex: 'cgst_rate', width: 85,
      render: (val, record) => (
        <Select 
          value={val} 
          onChange={(v) => {
            updateItemRow(record.key, 'cgst_rate', v);
            if (v > 0) updateItemRow(record.key, 'igst_rate', 0);
          }} 
          options={TAX_RATE_OPTIONS} 
          style={{ width: '100%' }} 
        />
      ),
    },
    {
      title: 'SGST %', dataIndex: 'sgst_rate', width: 85,
      render: (val, record) => (
        <Select 
          value={val} 
          onChange={(v) => {
            updateItemRow(record.key, 'sgst_rate', v);
            if (v > 0) updateItemRow(record.key, 'igst_rate', 0);
          }} 
          options={TAX_RATE_OPTIONS} 
          style={{ width: '100%' }} 
        />
      ),
    },
    {
      title: 'IGST %', dataIndex: 'igst_rate', width: 85,
      render: (val, record) => (
        <Select 
          value={val} 
          onChange={(v) => {
            updateItemRow(record.key, 'igst_rate', v);
            if (v > 0) {
              updateItemRow(record.key, 'cgst_rate', 0);
              updateItemRow(record.key, 'sgst_rate', 0);
            }
          }} 
          options={TAX_RATE_OPTIONS} 
          style={{ width: '100%' }} 
        />
      ),
    },
    {
      title: 'Amount', width: 110, align: 'right',
      render: (_, record) => <Text>{formatCurrency(getLineTotal(record))}</Text>,
    },
    {
      title: '', width: 40,
      render: (_, record) => invoiceItems.length > 1 ? (
        <Tooltip title="Remove"><MinusCircleOutlined style={{ color: '#ff4d4f', cursor: 'pointer', fontSize: 16 }} onClick={() => removeItemRow(record.key)} /></Tooltip>
      ) : null,
    },
  ];

  return (
    <div>
      <PageHeader title={isNew ? 'Create Invoice' : `Edit ${invoice?.invoice_number || ''}`} subtitle={isNew ? 'Create a new invoice' : 'Edit invoice'}>
        <Space>
          <Button onClick={() => navigate('/accounts/invoices')} icon={<ArrowLeftOutlined />}>Back</Button>
          {!isNew && <Button onClick={() => setEditMode(false)}>Cancel Edit</Button>}
        </Space>
      </PageHeader>

      <Card>
        <Form form={form} layout="vertical" scrollToFirstError={true}>
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item name="party_id" label="Vendor" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  options={vendors}
                  placeholder="Select vendor"
                  allowClear
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="project_id" label="Project">
                <Select options={projects} placeholder="Select project" allowClear showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item
                name="invoice_date"
                label="Invoice Date"
                rules={[
                  { required: true, message: 'Invoice Date is required' },
                  {
                    validator: (_, value) => {
                      if (value && value.isAfter(dayjs(), 'day')) {
                        return Promise.reject(new Error('Invoice Date cannot be in the future'));
                      }
                      return Promise.resolve();
                    }
                  }
                ]}
              >
                <DatePicker 
                  style={{ width: '100%' }} 
                  format={DATE_FORMAT} 
                  disabledDate={(current) => current && current.isAfter(dayjs(), 'day')}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                name="due_date"
                label="Due Date"
                rules={[
                  { required: true, message: 'Due Date is required' },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      const invDate = getFieldValue('invoice_date');
                      if (value && invDate && value.isBefore(invDate, 'day')) {
                        return Promise.reject(new Error('Due Date must be on or after the Invoice Date'));
                      }
                      return Promise.resolve();
                    },
                  }),
                ]}
              >
                <DatePicker 
                  style={{ width: '100%' }} 
                  format={DATE_FORMAT} 
                  disabledDate={(current) => {
                    const invDate = form.getFieldValue('invoice_date');
                    if (invDate) {
                      return current && current.isBefore(invDate, 'day');
                    }
                    return false;
                  }}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                name="po_id"
                label="PO Reference"
                rules={[
                  {
                    validator: (_, value) => {
                      if (value != null && value <= 0) {
                        return Promise.reject(new Error('PO Reference ID must be a positive number'));
                      }
                      return Promise.resolve();
                    }
                  }
                ]}
              >
                <InputNumber style={{ width: '100%' }} placeholder="PO ID (optional)" min={1} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                name="so_id"
                label="SO Reference"
                rules={[
                  {
                    validator: (_, value) => {
                      if (value != null && value <= 0) {
                        return Promise.reject(new Error('SO Reference ID must be a positive number'));
                      }
                      return Promise.resolve();
                    }
                  }
                ]}
              >
                <InputNumber style={{ width: '100%' }} placeholder="SO ID (optional)" min={1} />
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

        <Divider orientation="left">Items</Divider>
        <Table
          dataSource={invoiceItems}
          columns={itemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 1200 }}
          footer={() => (
            <Button type="dashed" onClick={addItemRow} icon={<PlusOutlined />} block>Add Item</Button>
          )}
        />

        {/* Totals Section */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <div style={{ width: 300 }}>
            <Row justify="space-between" style={{ marginBottom: 4 }}>
              <Col><Text>Subtotal:</Text></Col>
              <Col><Text>{formatCurrency(totals.subtotal)}</Text></Col>
            </Row>
            <Row justify="space-between" style={{ marginBottom: 4 }}>
              <Col><Text>Tax:</Text></Col>
              <Col><Text>{formatCurrency(totals.totalTax)}</Text></Col>
            </Row>
            <Divider style={{ margin: '8px 0' }} />
            <Row justify="space-between">
              <Col><Text strong style={{ fontSize: 16 }}>Grand Total:</Text></Col>
              <Col><Text strong style={{ fontSize: 16 }}>{formatCurrency(totals.grandTotal)}</Text></Col>
            </Row>
          </div>
        </div>

        <Divider />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={() => navigate('/accounts/invoices')}>Cancel</Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSubmit} loading={submitting}>
            {isNew ? 'Create Invoice' : 'Update Invoice'}
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default InvoiceForm;
