import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Button, Form, Input, InputNumber, Select, Space, DatePicker,
  message, Row, Col, Table, Card, Descriptions, Divider,
  Typography, Tooltip, Empty, Spin, Popconfirm,
} from 'antd';
import {
  PlusOutlined, ArrowLeftOutlined, CheckOutlined, CloseOutlined,
  EditOutlined, MinusCircleOutlined, SaveOutlined, ShoppingCartOutlined, PrinterOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useParams, useNavigate } from 'react-router-dom';
import { useReactToPrint } from 'react-to-print';
import PageHeader from '../../components/PageHeader';
import { SupplierQuotationPrint } from '../../components/PrintTemplates';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import {
  formatDate, formatCurrency, getErrorMessage, formatDateForAPI,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const QuotationForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';
  const printRef = useRef(null);
  const handlePrint = useReactToPrint({ content: () => printRef.current, documentTitle: 'Quotation' });

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [quotation, setQuotation] = useState(null);
  const [editMode, setEditMode] = useState(isNew);

  // Items
  const [quotationItems, setQuotationItems] = useState([]);

  // Lookups
  const [vendors, setVendors] = useState([]);
  const [mrOptions, setMrOptions] = useState([]);
  const [uomOptions, setUomOptions] = useState([]);

  const loadVendors = useCallback(async (search = '') => {
    try {
      const res = await api.get('/masters/vendors', { params: { page_size: 100, search, status: 'active' } });
      const data = res.data;
      setVendors((data.items || data.data || data || []).map((v) => ({
        label: `[${v.vendor_code}] ${v.name}`,
        value: v.id,
      })));
    } catch { /* silent */ }
  }, []);

  const loadMROptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/procurement/material-requests', { params: { page_size: 50, search, status: 'approved' } });
      const data = res.data;
      setMrOptions((data.items || data.data || data || []).map((mr) => ({
        label: `${mr.mr_number} - ${mr.department_name || mr.request_type || ''}`,
        value: mr.id,
      })));
    } catch { /* silent */ }
  }, []);

  const loadUOMs = useCallback(async () => {
    try {
      const res = await api.get('/masters/uom', { params: { page_size: 200 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setUomOptions(items.map((u) => ({
        label: `${u.name} (${u.abbreviation || ''})`,
        value: u.id,
      })));
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    loadVendors();
    loadMROptions();
    loadUOMs();
    if (!isNew) {
      fetchQuotation();
    } else {
      form.setFieldsValue({
        quotation_date: dayjs(),
        valid_until: dayjs().add(30, 'day'),
      });
      setQuotationItems([createEmptyItem()]);
    }
  }, [id]);

  const createEmptyItem = () => ({
    key: Date.now() + Math.random(),
    item_id: null,
    item_name: '',
    qty: 1,
    uom_id: null,
    rate: 0,
    discount_pct: 0,
    cgst_rate: 0,
    sgst_rate: 0,
    igst_rate: 0,
    tax_rate: 0,
    amount: 0,
  });

  const fetchQuotation = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/procurement/quotations/${id}`);
      const data = res.data;
      setQuotation(data);
      form.setFieldsValue({
        ...data,
        quotation_date: data.quotation_date ? dayjs(data.quotation_date) : null,
        valid_until: data.valid_until ? dayjs(data.valid_until) : null,
      });
      const items = (data.items || []).map((item, idx) => {
        const row = {
          key: item.id || Date.now() + idx,
          item_id: item.item_id,
          item_name: item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.item_name || item.item.name}` : ''),
          item_code: item.item_code || (item.item ? item.item.item_code : ''),
          qty: item.qty || item.quantity || 0,
          uom_id: item.uom_id || null,
          rate: item.rate || item.unit_price || 0,
          discount_pct: item.discount_pct || item.discount || item.discount_percent || 0,
          cgst_rate: item.cgst_rate || 0,
          sgst_rate: item.sgst_rate || 0,
          igst_rate: item.igst_rate || 0,
          tax_rate: item.tax_rate || item.tax_percent || 0,
          amount: item.amount || item.total || 0,
        };
        return row;
      });
      setQuotationItems(items.length > 0 ? items : [createEmptyItem()]);
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/procurement/quotations');
    } finally {
      setLoading(false);
    }
  };

  const handleMRSelect = async (mrId) => {
    if (!mrId) return;
    try {
      const res = await api.get(`/procurement/material-requests/${mrId}`);
      const mrData = res.data;
      const items = (mrData.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_name: item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.item_name || item.item.name}` : ''),
        item_code: item.item_code || (item.item ? item.item.item_code : ''),
        qty: item.qty || item.quantity || 0,
        uom_id: item.uom_id || (item.item ? item.item.primary_uom_id : null),
        rate: 0,
        discount_pct: 0,
        cgst_rate: 0,
        sgst_rate: 0,
        igst_rate: 0,
        tax_rate: 0,
        amount: 0,
      }));
      setQuotationItems(items.length > 0 ? items : [createEmptyItem()]);
      message.success('Items loaded from MR');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const calcItemAmount = (item) => {
    const base = (item.qty || 0) * (item.rate || 0);
    const discounted = base - (base * (item.discount_pct || 0)) / 100;
    const cgst = (discounted * (item.cgst_rate || 0)) / 100;
    const sgst = (discounted * (item.sgst_rate || 0)) / 100;
    const igst = (discounted * (item.igst_rate || 0)) / 100;
    const tax = cgst + sgst + igst;
    return Number((discounted + tax).toFixed(2));
  };

  const calcSubtotal = () =>
    quotationItems.reduce((sum, item) => {
      const base = (item.qty || 0) * (item.rate || 0);
      return sum + base - (base * (item.discount_pct || 0)) / 100;
    }, 0);

  const calcTaxComponents = () => {
    let cgst = 0, sgst = 0, igst = 0;
    quotationItems.forEach((item) => {
      const base = (item.qty || 0) * (item.rate || 0);
      const discounted = base - (base * (item.discount_pct || 0)) / 100;
      cgst += (discounted * (item.cgst_rate || 0)) / 100;
      sgst += (discounted * (item.sgst_rate || 0)) / 100;
      igst += (discounted * (item.igst_rate || 0)) / 100;
    });
    return { cgst, sgst, igst };
  };

  const calcCGSTTotal = () => calcTaxComponents().cgst;
  const calcSGSTTotal = () => calcTaxComponents().sgst;
  const calcIGSTTotal = () => calcTaxComponents().igst;

  const calcTaxTotal = () => {
    const { cgst, sgst, igst } = calcTaxComponents();
    return cgst + sgst + igst;
  };

  const calcGrandTotal = () => calcSubtotal() + calcTaxTotal();

  const updateItem = (key, field, value) => {
    setQuotationItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        let updated = { ...item, [field]: value };
        if ((field === 'cgst_rate' || field === 'sgst_rate') && value > 0) {
          updated.igst_rate = 0;
        } else if (field === 'igst_rate' && value > 0) {
          updated.cgst_rate = 0;
          updated.sgst_rate = 0;
        }
        updated.amount = calcItemAmount(updated);
        return updated;
      })
    );
  };

  const addItemRow = () => setQuotationItems((prev) => [...prev, createEmptyItem()]);
  const removeItemRow = (key) => setQuotationItems((prev) => prev.filter((i) => i.key !== key));

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      // BUG-PRO-146 fix: discount_pct=100 with rate>0 nets out to 0 — refuse.
      const validItems = quotationItems.filter(
        (i) => i.item_id && Number(i.rate) > 0 && Number(i.discount_pct || 0) < 100
      );
      if (validItems.length === 0) {
        message.error('Please add at least one item with a rate (and discount < 100%)');
        return;
      }
      setSubmitting(true);

      const payload = {
        ...values,
        quotation_date: formatDateForAPI(values.quotation_date),
        valid_until: formatDateForAPI(values.valid_until),
        total_amount: Number(calcSubtotal().toFixed(2)),
        cgst_amount: Number(calcCGSTTotal().toFixed(2)),
        sgst_amount: Number(calcSGSTTotal().toFixed(2)),
        igst_amount: Number(calcIGSTTotal().toFixed(2)),
        tax_amount: Number(calcTaxTotal().toFixed(2)),
        grand_total: Number(calcGrandTotal().toFixed(2)),
        items: validItems.map((item) => ({
          item_id: item.item_id,
          qty: item.qty,
          uom_id: item.uom_id,
          rate: item.rate,
          discount_pct: item.discount_pct || 0,
          cgst_rate: item.cgst_rate || 0,
          sgst_rate: item.sgst_rate || 0,
          igst_rate: item.igst_rate || 0,
          tax_rate: (item.cgst_rate || 0) + (item.sgst_rate || 0) + (item.igst_rate || 0),
          amount: item.amount,
        })),
      };

      if (isNew) {
        const res = await api.post('/procurement/quotations', payload);
        message.success('Quotation created');
        navigate(`/procurement/quotations/${res.data.id || res.data.data?.id}`);
      } else {
        await api.put(`/procurement/quotations/${id}`, payload);
        message.success('Quotation updated');
        setEditMode(false);
        fetchQuotation();
      }
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAccept = async () => {
    try {
      await api.put(`/procurement/quotations/${id}/accept`);
      message.success('Quotation accepted');
      fetchQuotation();
    } catch (err) { message.error(getErrorMessage(err)); }
  };

  const handleReject = async () => {
    try {
      await api.put(`/procurement/quotations/${id}/reject`);
      message.success('Quotation rejected');
      fetchQuotation();
    } catch (err) { message.error(getErrorMessage(err)); }
  };

  const handleCreatePO = async () => {
    try {
      const res = await api.post('/procurement/purchase-orders/from-quotation', { quotation_id: id });
      message.success('Purchase Order created');
      const poId = res.data.id || res.data.data?.id;
      if (poId) navigate(`/procurement/purchase-orders/${poId}`);
      else navigate('/procurement/purchase-orders');
    } catch (err) { message.error(getErrorMessage(err)); }
  };

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}><Spin size="large" /></div>;
  }

  // Detail view
  if (!isNew && quotation && !editMode) {
    const qItems = quotation.items || [];
    return (
      <div>
        <PageHeader title={quotation.quotation_number} subtitle="Quotation Detail">
          <Space>
            {(quotation.status === 'draft' || quotation.status === 'pending') && (
              <>
                <Button icon={<EditOutlined />} onClick={() => setEditMode(true)}>Edit</Button>
                <Popconfirm title="Accept this quotation?" onConfirm={handleAccept}>
                  <Button type="primary" icon={<CheckOutlined />}>Accept</Button>
                </Popconfirm>
                <Popconfirm title="Reject this quotation?" onConfirm={handleReject} okButtonProps={{ danger: true }}>
                  <Button danger icon={<CloseOutlined />}>Reject</Button>
                </Popconfirm>
              </>
            )}
            {quotation.status === 'accepted' && (
              <Popconfirm title="Create PO from this quotation?" onConfirm={handleCreatePO}>
                <Button type="primary" icon={<ShoppingCartOutlined />}>Create PO</Button>
              </Popconfirm>
            )}
            <Button icon={<PrinterOutlined />} onClick={handlePrint}>Print</Button>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/procurement/quotations')}>Back</Button>
          </Space>
        </PageHeader>

        <div style={{ display: 'none' }}>
          <SupplierQuotationPrint ref={printRef} data={quotation} />
        </div>

        <Card>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="Quotation Number">{quotation.quotation_number}</Descriptions.Item>
            <Descriptions.Item label="MR Reference">{quotation.mr_number || quotation.mr_reference || '-'}</Descriptions.Item>
            <Descriptions.Item label="Vendor">{quotation.vendor_name || quotation.vendor || '-'}</Descriptions.Item>
            <Descriptions.Item label="Quotation Date">{formatDate(quotation.quotation_date)}</Descriptions.Item>
            <Descriptions.Item label="Valid Until">{formatDate(quotation.valid_until)}</Descriptions.Item>
            <Descriptions.Item label="Delivery Days">{quotation.delivery_days || '-'}</Descriptions.Item>
            <Descriptions.Item label="Payment Terms">{quotation.payment_terms || '-'}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={quotation.status} /></Descriptions.Item>
            <Descriptions.Item label="Grand Total"><Text strong>{formatCurrency(quotation.grand_total)}</Text></Descriptions.Item>
            <Descriptions.Item label="Remarks" span={3}>{quotation.remarks || '-'}</Descriptions.Item>
          </Descriptions>

          <Divider orientation="left">Items</Divider>
          <Table
            dataSource={qItems}
            rowKey={(r) => r.id || r.item_id}
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
              { title: 'Item Code', width: 120, render: (_, r) => r.item_code || (r.item && r.item.item_code) || '-' },
              { title: 'Item Name', width: 200, render: (_, r) => r.item_name || (r.item && (r.item.item_name || r.item.name)) || '-' },
              { title: 'Qty', dataIndex: 'qty', width: 80, align: 'right', render: (v, r) => v || r.quantity || '-' },
              { title: 'UOM', dataIndex: 'uom_name', width: 70, render: (v, r) => v || r.uom || '-' },
              { title: 'Rate', dataIndex: 'rate', width: 110, align: 'right', render: (v, r) => formatCurrency(v || r.unit_price) },
              { title: 'Disc %', dataIndex: 'discount_pct', width: 80, align: 'right', render: (v, r) => `${v || r.discount || 0}%` },
              { title: 'CGST %', dataIndex: 'cgst_rate', width: 80, align: 'right', render: (v, r) => `${v || r.cgst_rate || 0}%` },
              { title: 'SGST %', dataIndex: 'sgst_rate', width: 80, align: 'right', render: (v, r) => `${v || r.sgst_rate || 0}%` },
              { title: 'IGST %', dataIndex: 'igst_rate', width: 80, align: 'right', render: (v, r) => `${v || r.igst_rate || 0}%` },
              { title: 'Amount', dataIndex: 'amount', width: 120, align: 'right', render: (v, r) => formatCurrency(v || r.total) },
            ]}
            summary={() => (
              <Table.Summary>
                <Table.Summary.Row>
                  <Table.Summary.Cell colSpan={10} align="right"><Text strong>Subtotal:</Text></Table.Summary.Cell>
                  <Table.Summary.Cell align="right"><Text>{formatCurrency(quotation.subtotal || quotation.total_amount)}</Text></Table.Summary.Cell>
                </Table.Summary.Row>
                {(quotation.cgst_amount || 0) > 0 && (
                  <Table.Summary.Row>
                    <Table.Summary.Cell colSpan={10} align="right"><Text strong>CGST:</Text></Table.Summary.Cell>
                    <Table.Summary.Cell align="right"><Text>{formatCurrency(quotation.cgst_amount)}</Text></Table.Summary.Cell>
                  </Table.Summary.Row>
                )}
                {(quotation.sgst_amount || 0) > 0 && (
                  <Table.Summary.Row>
                    <Table.Summary.Cell colSpan={10} align="right"><Text strong>SGST:</Text></Table.Summary.Cell>
                    <Table.Summary.Cell align="right"><Text>{formatCurrency(quotation.sgst_amount)}</Text></Table.Summary.Cell>
                  </Table.Summary.Row>
                )}
                {(quotation.igst_amount || 0) > 0 && (
                  <Table.Summary.Row>
                    <Table.Summary.Cell colSpan={10} align="right"><Text strong>IGST:</Text></Table.Summary.Cell>
                    <Table.Summary.Cell align="right"><Text>{formatCurrency(quotation.igst_amount)}</Text></Table.Summary.Cell>
                  </Table.Summary.Row>
                )}
                <Table.Summary.Row>
                  <Table.Summary.Cell colSpan={10} align="right"><Text strong>Tax Total:</Text></Table.Summary.Cell>
                  <Table.Summary.Cell align="right"><Text>{formatCurrency(quotation.tax_amount)}</Text></Table.Summary.Cell>
                </Table.Summary.Row>
                <Table.Summary.Row>
                  <Table.Summary.Cell colSpan={10} align="right"><Text strong>Grand Total:</Text></Table.Summary.Cell>
                  <Table.Summary.Cell align="right"><Text strong>{formatCurrency(quotation.grand_total)}</Text></Table.Summary.Cell>
                </Table.Summary.Row>
              </Table.Summary>
            )}
          />
        </Card>
      </div>
    );
  }

  // Edit / Create mode
  const itemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item', dataIndex: 'item_id', width: 250,
      render: (val, record) => (
        <ItemSelector
          value={val}
          onChange={(itemId, item) => {
            updateItem(record.key, 'item_id', itemId);
            if (item) {
              // Bug fix BUG_0086 — auto-fill UOM, rate, tax when item selected
              updateItem(record.key, 'item_name', item.item_name || item.name || '');
              updateItem(record.key, 'uom_id', item.primary_uom_id || item.uom_id || null);
              const rate = parseFloat(item.purchase_price || 0);
              if (rate > 0) updateItem(record.key, 'rate', rate);
              updateItem(record.key, 'cgst_rate', parseFloat(item.cgst_rate || 0));
              updateItem(record.key, 'sgst_rate', parseFloat(item.sgst_rate || 0));
              updateItem(record.key, 'igst_rate', parseFloat(item.igst_rate || 0));
            }
          }}
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Qty', dataIndex: 'qty', width: 80,
      render: (val, record) => <InputNumber min={0.01} value={val} onChange={(v) => updateItem(record.key, 'qty', v)} style={{ width: '100%' }} />,
    },
    {
      title: 'UOM', dataIndex: 'uom_id', width: 120,
      render: (val, record) => (
        <Select
          value={val}
          onChange={(v) => updateItem(record.key, 'uom_id', v)}
          options={uomOptions}
          placeholder="UOM"
          showSearch
          optionFilterProp="label"
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'Rate', dataIndex: 'rate', width: 110,
      render: (val, record) => <InputNumber min={0} value={val} onChange={(v) => updateItem(record.key, 'rate', v)} style={{ width: '100%' }} prefix="₹" />,
    },
    {
      title: 'Disc %', dataIndex: 'discount_pct', width: 80,
      render: (val, record) => <InputNumber min={0} max={100} value={val} onChange={(v) => updateItem(record.key, 'discount_pct', v)} style={{ width: '100%' }} />,
    },
    {
      title: 'CGST %', dataIndex: 'cgst_rate', width: 80,
      render: (val, record) => <InputNumber min={0} max={100} value={val} onChange={(v) => updateItem(record.key, 'cgst_rate', v)} style={{ width: '100%' }} />,
    },
    {
      title: 'SGST %', dataIndex: 'sgst_rate', width: 80,
      render: (val, record) => <InputNumber min={0} max={100} value={val} onChange={(v) => updateItem(record.key, 'sgst_rate', v)} style={{ width: '100%' }} />,
    },
    {
      title: 'IGST %', dataIndex: 'igst_rate', width: 80,
      render: (val, record) => <InputNumber min={0} max={100} value={val} onChange={(v) => updateItem(record.key, 'igst_rate', v)} style={{ width: '100%' }} />,
    },
    {
      title: 'Amount', dataIndex: 'amount', width: 110, align: 'right',
      render: (val) => formatCurrency(val),
    },
    {
      title: '', width: 40,
      render: (_, record) => quotationItems.length > 1 ? (
        <MinusCircleOutlined style={{ color: '#ff4d4f', cursor: 'pointer' }} onClick={() => removeItemRow(record.key)} />
      ) : null,
    },
  ];

  return (
    <div>
      <PageHeader title={isNew ? 'Create Quotation' : `Edit ${quotation?.quotation_number || ''}`} subtitle={isNew ? 'Create a new vendor quotation' : 'Edit quotation'}>
        <Space>
          <Button onClick={() => navigate('/procurement/quotations')} icon={<ArrowLeftOutlined />}>Back</Button>
          {!isNew && <Button onClick={() => setEditMode(false)}>Cancel Edit</Button>}
        </Space>
      </PageHeader>

      <Card>
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="mr_id" label="Material Request">
                <Select options={mrOptions} placeholder="Select MR (optional)" showSearch optionFilterProp="label" allowClear
                  onChange={handleMRSelect} onSearch={(v) => loadMROptions(v)} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="vendor_id" label="Vendor" rules={[{ required: true, message: 'Required' }]}>
                <Select options={vendors} placeholder="Select vendor" showSearch optionFilterProp="label" onSearch={(v) => loadVendors(v)} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="quotation_date" label="Quotation Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="valid_until" label="Valid Until" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="delivery_days" label="Delivery Days">
                <InputNumber min={0} style={{ width: '100%' }} placeholder="e.g. 15" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="payment_terms" label="Payment Terms">
                <Input placeholder="e.g. Net 30 days" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="remarks" label="Remarks">
                <Input placeholder="Any remarks..." />
              </Form.Item>
            </Col>
          </Row>
        </Form>

        <Divider orientation="left">Items</Divider>
        <Table
          dataSource={quotationItems}
          columns={itemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 900 }}
          footer={() => (
            <Button type="dashed" onClick={addItemRow} icon={<PlusOutlined />} block>Add Item</Button>
          )}
          summary={() => (
            <Table.Summary>
              <Table.Summary.Row>
                <Table.Summary.Cell colSpan={9} align="right"><Text strong>Subtotal:</Text></Table.Summary.Cell>
                <Table.Summary.Cell align="right"><Text>{formatCurrency(calcSubtotal())}</Text></Table.Summary.Cell>
                <Table.Summary.Cell />
              </Table.Summary.Row>
              {calcCGSTTotal() > 0 && (
                <Table.Summary.Row>
                  <Table.Summary.Cell colSpan={9} align="right"><Text strong>CGST:</Text></Table.Summary.Cell>
                  <Table.Summary.Cell align="right"><Text>{formatCurrency(calcCGSTTotal())}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell />
                </Table.Summary.Row>
              )}
              {calcSGSTTotal() > 0 && (
                <Table.Summary.Row>
                  <Table.Summary.Cell colSpan={9} align="right"><Text strong>SGST:</Text></Table.Summary.Cell>
                  <Table.Summary.Cell align="right"><Text>{formatCurrency(calcSGSTTotal())}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell />
                </Table.Summary.Row>
              )}
              {calcIGSTTotal() > 0 && (
                <Table.Summary.Row>
                  <Table.Summary.Cell colSpan={9} align="right"><Text strong>IGST:</Text></Table.Summary.Cell>
                  <Table.Summary.Cell align="right"><Text>{formatCurrency(calcIGSTTotal())}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell />
                </Table.Summary.Row>
              )}
              <Table.Summary.Row>
                <Table.Summary.Cell colSpan={9} align="right"><Text strong>Tax Total:</Text></Table.Summary.Cell>
                <Table.Summary.Cell align="right"><Text>{formatCurrency(calcTaxTotal())}</Text></Table.Summary.Cell>
                <Table.Summary.Cell />
              </Table.Summary.Row>
              <Table.Summary.Row>
                <Table.Summary.Cell colSpan={9} align="right"><Text strong style={{ fontSize: 15 }}>Grand Total:</Text></Table.Summary.Cell>
                <Table.Summary.Cell align="right"><Text strong style={{ fontSize: 15 }}>{formatCurrency(calcGrandTotal())}</Text></Table.Summary.Cell>
                <Table.Summary.Cell />
              </Table.Summary.Row>
            </Table.Summary>
          )}
        />

        <Divider />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={() => navigate('/procurement/quotations')}>Cancel</Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSubmit} loading={submitting}>
            {isNew ? 'Create Quotation' : 'Update Quotation'}
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default QuotationForm;
