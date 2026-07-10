import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Button, Form, Input, InputNumber, Select, Space, DatePicker,
  message, Row, Col, Table, Divider, Typography, Tooltip, Tag
} from 'antd';
import {
  PlusOutlined, ArrowLeftOutlined, SaveOutlined, SendOutlined,
  MinusCircleOutlined
} from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import ItemSelector from '../../components/ItemSelector';
import AttachmentUploader from '../../components/AttachmentUploader';
import api from '../../config/api';
import {
  formatCurrency, getErrorMessage, formatDateForAPI
} from '../../utils/helpers';
import useAuthStore from '../../store/authStore';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const PurchaseOrderForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [form] = Form.useForm();
  const user = useAuthStore((s) => s.user);
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [editingPO, setEditingPO] = useState(null);

  // Form selections and items
  const [poItems, setPoItems] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [selectedVendor, setSelectedVendor] = useState(null);
  const [mrOptions, setMrOptions] = useState([]);
  const [quotationOptions, setQuotationOptions] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [projects, setProjects] = useState([]);

  // Discount
  const [discountType, setDiscountType] = useState('percent');
  const [discountValue, setDiscountValue] = useState(0);

  // Attachment
  const [attachmentUrl, setAttachmentUrl] = useState('');
  const [fileList, setFileList] = useState([]);

  const createEmptyItem = () => {
    const vendorGstin = (selectedVendor?.gst_number || '').trim();
    const hasGstin = !!vendorGstin;
    return {
      key: Date.now() + Math.random(),
      item_id: null,
      item_name: '',
      qty: 1,
      uom: '',
      rate: 0,
      cgst_percent: hasGstin ? 9 : 0,
      sgst_percent: hasGstin ? 9 : 0,
      igst_percent: hasGstin ? 0 : 18,
      tax_amount: 0,
      amount: 0,
    };
  };

  const loadLookups = useCallback(async () => {
    try {
      const [vendorRes, whRes, projRes] = await Promise.allSettled([
        api.get('/masters/vendors', { params: { page_size: 200, status: 'active' } }),
        api.get('/masters/warehouses', { params: { page_size: 200, exclude_virtual: true } }),
        api.get('/masters/projects', { params: { page_size: 200 } }),
      ]);
      if (vendorRes.status === 'fulfilled') {
        const d = vendorRes.value.data;
        const items = d.items || d.data || d || [];
        setVendors(items.map((v) => ({
          label: `[${v.vendor_code}] ${v.name}`,
          value: v.id,
          vendor: v,
        })));
      }
      if (whRes.status === 'fulfilled') {
        const w = whRes.value.data;
        setWarehouses((w.items || w.data || w || []).map((i) => ({ label: i.name || i.warehouse_name, value: i.id })));
      }
      if (projRes.status === 'fulfilled') {
        const p = projRes.value.data;
        setProjects((p.items || p.data || p || []).map((i) => ({ label: i.name || i.project_name, value: i.id })));
      }
    } catch { /* silent */ }
  }, []);

  const loadMROptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/procurement/material-requests', {
        params: { page_size: 50, search, status: 'approved' },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setMrOptions(items.map((mr) => ({ label: mr.mr_number, value: mr.id })));
    } catch { /* silent */ }
  }, []);

  const loadQuotationOptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/procurement/quotations', {
        params: { page_size: 50, search, status: 'accepted' },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setQuotationOptions(items.map((q) => ({ label: `${q.quotation_number} - ${q.vendor_name || ''}`, value: q.id })));
    } catch { /* silent */ }
  }, []);

  // Item row calculations
  const recalcItem = (item) => {
    const base = (item.qty || 0) * (item.rate || 0);
    const cgstAmt = (base * (item.cgst_percent || 0)) / 100;
    const sgstAmt = (base * (item.sgst_percent || 0)) / 100;
    const igstAmt = (base * (item.igst_percent || 0)) / 100;
    item.tax_amount = Number((cgstAmt + sgstAmt + igstAmt).toFixed(2));
    item.amount = Number((base + cgstAmt + sgstAmt + igstAmt).toFixed(2));
    return item;
  };

  const updatePoItem = (key, field, value) => {
    setPoItems((prev) =>
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

  const addPoItemRow = () => {
    setPoItems((prev) => [...prev, createEmptyItem()]);
  };

  const removePoItemRow = (key) => {
    setPoItems((prev) => prev.filter((i) => i.key !== key));
  };

  const calcGrossTotal = () =>
    poItems.reduce((sum, item) => sum + (item.qty || 0) * (item.rate || 0), 0);

  const calcDiscountAmount = () => {
    const gross = calcGrossTotal();
    if (discountType === 'percent') return gross * (discountValue || 0) / 100;
    return discountValue || 0;
  };

  const calcSubtotal = () => calcGrossTotal() - calcDiscountAmount();

  const calcTaxComponents = () => {
    const gross = calcGrossTotal();
    const discAmt = calcDiscountAmount();
    const discRatio = gross > 0 ? (gross - discAmt) / gross : 1;

    let cgst = 0, sgst = 0, igst = 0;
    poItems.forEach((item) => {
      const base = (item.qty || 0) * (item.rate || 0) * discRatio;
      cgst += (base * (item.cgst_percent || 0)) / 100;
      sgst += (base * (item.sgst_percent || 0)) / 100;
      igst += (base * (item.igst_percent || 0)) / 100;
    });
    return { cgst, sgst, igst };
  };

  const calcCGST = () => calcTaxComponents().cgst;
  const calcSGST = () => calcTaxComponents().sgst;
  const calcIGST = () => calcTaxComponents().igst;
  const calcTaxTotal = () => calcCGST() + calcSGST() + calcIGST();
  const calcGrandTotal = () => calcSubtotal() + calcTaxTotal();

  const handleVendorChange = (vendorId) => {
    const found = vendors.find((v) => v.value === vendorId);
    setSelectedVendor(found ? found.vendor : null);
  };

  const handleQuotationSelect = async (quotationId) => {
    if (!quotationId) return;
    try {
      const res = await api.get(`/procurement/quotations/${quotationId}`);
      const qData = res.data;
      if (qData.vendor_id) {
        form.setFieldsValue({ vendor_id: qData.vendor_id });
        handleVendorChange(qData.vendor_id);
      }
      if (qData.mr_id) {
        form.setFieldsValue({ mr_id: qData.mr_id });
      }

      const vendorGstin = (selectedVendor?.gst_number || '').trim();
      const hasGstin = !!vendorGstin;

      const items = (qData.items || []).map((item, idx) => {
        let cg = item.cgst_rate || item.cgst_percent || 0;
        let sg = item.sgst_rate || item.sgst_percent || 0;
        let ig = item.igst_rate || item.igst_percent || 0;
        const taxRate = item.tax_rate || 0;

        if (!hasGstin) {
          ig = ig > 0 ? ig : (cg + sg > 0 ? cg + sg : taxRate);
          cg = 0;
          sg = 0;
        } else if (cg === 0 && sg === 0 && ig === 0 && taxRate > 0) {
          cg = taxRate / 2;
          sg = taxRate / 2;
          ig = 0;
        }

        const row = {
          key: item.id || Date.now() + idx,
          item_id: item.item_id,
          item_code: item.item_code || '',
          item_name: item.item_name || '',
          qty: item.qty || item.quantity || 0,
          uom_id: item.uom_id || null,
          uom: item.uom_name || item.uom || '',
          rate: item.rate || item.unit_price || 0,
          discount_percent: item.discount || item.discount_percent || 0,
          cgst_percent: cg,
          sgst_percent: sg,
          igst_percent: ig,
          tax_amount: 0,
          amount: 0,
        };
        return recalcItem(row);
      });
      setPoItems(items.length > 0 ? items : [createEmptyItem()]);
      message.success('Items loaded from quotation');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleMRSelect = async (mrId) => {
    if (!mrId) return;
    try {
      const res = await api.get(`/procurement/material-requests/${mrId}`);
      const mrData = res.data;
      const patch = {};
      if (mrData.warehouse_id) patch.warehouse_id = mrData.warehouse_id;
      if (mrData.project_id) patch.project_id = mrData.project_id;
      if (mrData.required_date) patch.expected_delivery_date = dayjs(mrData.required_date);
      if (Object.keys(patch).length) form.setFieldsValue(patch);

      const vendorGstin = (selectedVendor?.gst_number || '').trim();
      const hasGstin = !!vendorGstin;

      const items = (mrData.items || []).map((item, idx) => {
        const row = {
          key: item.id || Date.now() + idx,
          item_id: item.item_id,
          item_code: item.item_code || '',
          item_name: item.item_name || '',
          qty: item.qty || item.quantity || 0,
          uom_id: item.uom_id || null,
          uom: item.uom_name || item.uom || '',
          rate: 0,
          discount_percent: 0,
          cgst_percent: hasGstin ? 9 : 0,
          sgst_percent: hasGstin ? 9 : 0,
          igst_percent: hasGstin ? 0 : 18,
          tax_amount: 0,
          amount: 0,
        };
        return recalcItem(row);
      });
      if (items.length > 0) {
        setPoItems(items);
        message.success('Items loaded from material request — enter vendor rates');
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const fetchPO = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/procurement/purchase-orders/${id}`);
      const data = res.data;
      setEditingPO(data);
      form.setFieldsValue({
        ...data,
        po_date: data.po_date ? dayjs(data.po_date) : null,
        expected_delivery_date: data.expected_delivery_date ? dayjs(data.expected_delivery_date) : null,
      });

      if (data.vendor_id) {
        try {
          const vRes = await api.get(`/masters/vendors/${data.vendor_id}`);
          setSelectedVendor(vRes.data || null);
        } catch {
          setSelectedVendor(null);
        }
      }

      const items = (data.items || []).map((item, idx) => {
        const row = {
          key: item.id || Date.now() + idx,
          item_id: item.item_id,
          item_name: item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.item_name || item.item.name}` : ''),
          qty: item.qty || item.quantity || 0,
          uom: item.uom || item.unit || '',
          uom_id: item.uom_id || null,
          rate: item.rate || item.unit_price || 0,
          discount_pct: item.discount_pct || 0,
          cgst_percent: item.cgst_percent || item.cgst_rate || 0,
          sgst_percent: item.sgst_percent || item.sgst_rate || 0,
          igst_percent: item.igst_percent || item.igst_rate || 0,
          tax_amount: 0,
          amount: 0,
        };
        return recalcItem(row);
      });
      setPoItems(items.length > 0 ? items : [createEmptyItem()]);
      setDiscountType(data.discount_type || 'percent');
      setDiscountValue(data.discount_value || 0);

      setAttachmentUrl(data.attachment_url || '');
      if (data.attachment_url) {
        setFileList([{
          uid: '-1',
          name: data.attachment_url.split('/').pop() || 'Attachment',
          status: 'done',
          url: data.attachment_url,
        }]);
      } else {
        setFileList([]);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/procurement/purchase-orders');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLookups();
    loadMROptions();
    loadQuotationOptions();
    if (!isNew) {
      fetchPO();
    } else {
      form.setFieldsValue({
        po_date: dayjs(),
        expected_delivery_date: dayjs().add(14, 'day'),
        warehouse_id: user?.warehouse_id || undefined,
      });
      setPoItems([createEmptyItem()]);
    }
  }, [id]);

  const handleSubmit = async (submitAction = 'draft') => {
    try {
      const values = await form.validateFields();
      const validItems = poItems.filter((i) => i.item_id);
      if (validItems.length === 0) {
        message.error('Please add at least one item');
        return;
      }

      const vendorCreditLimit = Number(selectedVendor?.credit_limit || 0);
      const newPoTotal = Number(calcGrandTotal() || 0);
      if (vendorCreditLimit > 0 && newPoTotal > vendorCreditLimit) {
        const ok = window.confirm(
          'This PO total (' + formatCurrency(newPoTotal) +
          ') exceeds the vendor credit limit (' + formatCurrency(vendorCreditLimit) +
          '). Continue anyway?'
        );
        if (!ok) return;
      }

      const hasMedicineLine = validItems.some((it) => {
        const t = (it.item_type || '').toLowerCase();
        return t === 'medicine' || it.requires_prescription || it.is_schedule_h1 || it.is_narcotic;
      });
      if (hasMedicineLine) {
        const vendorDl = (selectedVendor?.drug_license_number || '').trim();
        if (!vendorDl) {
          message.error(
            'This PO contains medicine items but the selected vendor has no Drug License on file. ' +
            'Either pick a DL-holding vendor or update the vendor master.'
          );
          return;
        }
      }

      if (selectedVendor !== null) {
        const vendorGstin = (selectedVendor?.gst_number || '').trim();
        if (!vendorGstin) {
          const hasIntra = validItems.some((it) =>
            (Number(it.cgst_percent) || 0) > 0 || (Number(it.sgst_percent) || 0) > 0
          );
          if (hasIntra) {
            message.error(
              'Vendor has no GSTIN — CGST/SGST cannot be applied. ' +
              'Use IGST or update the vendor first.'
            );
            return;
          }
        }
      }

      setSubmitting(true);

      let status = 'draft';
      if (submitAction === 'submit') status = 'pending_approval';

      const payload = {
        ...values,
        po_date: formatDateForAPI(values.po_date),
        expected_delivery_date: formatDateForAPI(values.expected_delivery_date),
        attachment_url: attachmentUrl || null,
        status,
        subtotal: Number(calcGrossTotal().toFixed(2)),
        discount_type: discountType,
        discount_value: discountValue,
        discount_total: Number(calcDiscountAmount().toFixed(2)),
        cgst_total: Number(calcCGST().toFixed(2)),
        sgst_total: Number(calcSGST().toFixed(2)),
        igst_total: Number(calcIGST().toFixed(2)),
        tax_total: Number(calcTaxTotal().toFixed(2)),
        grand_total: Number(calcGrandTotal().toFixed(2)),
        items: validItems.map((item) => ({
          item_id: item.item_id,
          qty: item.qty,
          uom_id: item.uom_id || (typeof item.uom === 'number' ? item.uom : null),
          rate: (item.rate === null || item.rate === undefined || item.rate === '') ? null : item.rate,
          discount_pct: 0,
          cgst_rate: item.cgst_percent || item.cgst_rate || 0,
          sgst_rate: item.sgst_percent || item.sgst_rate || 0,
          igst_rate: item.igst_percent || item.igst_rate || 0,
          tax_amount: item.tax_amount,
          amount: item.amount,
        })),
      };

      if (!isNew && editingPO) {
        await api.put(`/procurement/purchase-orders/${editingPO.id}`, payload);
        if (submitAction === 'submit' && editingPO.status === 'draft') {
          try {
            await api.post(`/procurement/purchase-orders/${editingPO.id}/submit`);
            message.success('Purchase Order submitted for approval');
          } catch (submitErr) {
            message.error({
              content: 'PO saved as draft, but submit-for-approval failed: '
                + getErrorMessage(submitErr) + ' — retry submit from PO details.',
              duration: 8,
            });
          }
        } else {
          message.success('Purchase Order updated successfully');
        }
      } else {
        const res = await api.post('/procurement/purchase-orders', { ...payload, status: 'draft' });
        const newId = res.data?.id;
        if (submitAction === 'submit' && newId) {
          try {
            await api.post(`/procurement/purchase-orders/${newId}/submit`);
            message.success('Purchase Order created and submitted for approval');
          } catch (submitErr) {
            message.error({
              content: 'PO created as draft, but submit-for-approval failed: '
                + getErrorMessage(submitErr) + ' — retry submit from PO details.',
              duration: 8,
            });
          }
        } else {
          message.success('Purchase Order created as draft');
        }
      }
      navigate('/procurement/purchase-orders');
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const poItemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item',
      dataIndex: 'item_id',
      width: 250,
      render: (val, record) => (
        record.item_name ? (
          <Tooltip title={record.item_name}>
            <Text ellipsis style={{ maxWidth: 200 }}>{record.item_name}</Text>
          </Tooltip>
        ) : (
          <ItemSelector
            value={val}
            onChange={(itemId, item) => {
              if (itemId) {
                const exists = poItems.some(i => i.item_id === itemId && i.key !== record.key);
                if (exists) {
                  const name = item?.item_name || item?.name || 'Selected item';
                  message.warning(`Just update the quantity of ${name}, it already exists in the PO.`);
                  return;
                }
              }
              updatePoItem(record.key, 'item_id', itemId);
              if (item) {
                updatePoItem(record.key, 'item_name', item.item_name || item.name || '');
                updatePoItem(record.key, 'uom', item.uom || item.default_uom || item.primary_uom?.name || '');
                updatePoItem(record.key, 'uom_id', item.primary_uom_id || item.uom_id || null);
                const rate = parseFloat(item.purchase_price || 0);
                if (rate > 0) updatePoItem(record.key, 'rate', rate);

                const vendorGstin = (selectedVendor?.gst_number || '').trim();
                const hasGstin = !!vendorGstin;

                let cg = parseFloat(item.cgst_rate || item.cgst_percent || 0);
                let sg = parseFloat(item.sgst_rate || item.sgst_percent || 0);
                let ig = parseFloat(item.igst_rate || item.igst_percent || 0);
                const tax = parseFloat(item.tax_rate || 0);

                if (!hasGstin) {
                  ig = ig > 0 ? ig : (cg + sg > 0 ? cg + sg : tax);
                  cg = 0;
                  sg = 0;
                } else if (cg === 0 && sg === 0 && ig === 0 && tax > 0) {
                  cg = tax / 2;
                  sg = tax / 2;
                  ig = 0;
                }

                updatePoItem(record.key, 'cgst_percent', cg);
                updatePoItem(record.key, 'sgst_percent', sg);
                updatePoItem(record.key, 'igst_percent', ig);
                updatePoItem(record.key, 'tax_rate', tax);
              }
            }}
            style={{ width: '100%' }}
          />
        )
      ),
    },
    {
      title: 'Qty', dataIndex: 'qty', width: 80,
      render: (val, record) => (
        <InputNumber min={0.01} value={val} onChange={(v) => updatePoItem(record.key, 'qty', v)} style={{ width: '100%' }} size="small" />
      ),
    },
    {
      title: 'UOM', dataIndex: 'uom', width: 70,
      render: (val) => <Text style={{ fontSize: 12 }}>{val || '-'}</Text>,
    },
    {
      title: 'Rate', dataIndex: 'rate', width: 100,
      render: (val, record) => (
        <InputNumber min={0} value={val} onChange={(v) => updatePoItem(record.key, 'rate', v)} style={{ width: '100%' }} size="small" />
      ),
    },
    {
      title: 'CGST%', dataIndex: 'cgst_percent', width: 75,
      render: (val, record) => (
        <InputNumber min={0} max={28} value={val} onChange={(v) => updatePoItem(record.key, 'cgst_percent', v)} style={{ width: '100%' }} size="small" />
      ),
    },
    {
      title: 'SGST%', dataIndex: 'sgst_percent', width: 75,
      render: (val, record) => (
        <InputNumber min={0} max={28} value={val} onChange={(v) => updatePoItem(record.key, 'sgst_percent', v)} style={{ width: '100%' }} size="small" />
      ),
    },
    {
      title: 'IGST%', dataIndex: 'igst_percent', width: 75,
      render: (val, record) => (
        <InputNumber min={0} max={28} value={val} onChange={(v) => updatePoItem(record.key, 'igst_percent', v)} style={{ width: '100%' }} size="small" />
      ),
    },
    {
      title: 'Tax', dataIndex: 'tax_amount', width: 90, align: 'right',
      render: (val) => <Text style={{ fontSize: 12 }}>{formatCurrency(val)}</Text>,
    },
    {
      title: 'Amount', dataIndex: 'amount', width: 110, align: 'right',
      render: (val) => <Text strong style={{ fontSize: 12 }}>{formatCurrency(val)}</Text>,
    },
    {
      title: '', width: 40,
      render: (_, record) =>
        poItems.length > 1 ? (
          <MinusCircleOutlined style={{ color: '#ff4d4f', cursor: 'pointer' }} onClick={() => removePoItemRow(record.key)} />
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title={isNew ? 'Create Purchase Order' : `Edit ${editingPO?.po_number || ''}`}
        subtitle={isNew ? 'Generate a new purchase order' : 'Edit purchase order details'}
      >
        <Button onClick={() => navigate('/procurement/purchase-orders')} icon={<ArrowLeftOutlined />}>
          Back to List
        </Button>
      </PageHeader>

      <Card>
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="vendor_id" label="Vendor" rules={[{ required: true, message: 'Vendor is required' }]}>
                <Select
                  options={vendors}
                  placeholder="Select vendor"
                  showSearch
                  optionFilterProp="label"
                  onChange={(val) => {
                    handleVendorChange(val);
                    // Clear items GSTIN tax since vendor changed
                    setPoItems(poItems.map(item => recalcItem({ ...item, cgst_percent: 0, sgst_percent: 0, igst_percent: 0 })));
                  }}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="mr_id" label="Material Request Link">
                <Select
                  options={mrOptions}
                  placeholder="Select MR (optional)"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  onChange={handleMRSelect}
                  onSearch={loadMROptions}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="quotation_id" label="Quotation Link">
                <Select
                  options={quotationOptions}
                  placeholder="Select Quotation (optional)"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  onChange={handleQuotationSelect}
                  onSearch={loadQuotationOptions}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="po_date" label="PO Date" rules={[{ required: true, message: 'PO Date is required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="expected_delivery_date"
                label="Expected Delivery Date"
                rules={[
                  { required: true, message: 'Required' },
                  () => ({
                    validator(_, value) {
                      if (value && value.isBefore(dayjs(), 'day')) {
                        return Promise.reject(new Error('Expected delivery date cannot be in the past'));
                      }
                      return Promise.resolve();
                    },
                  }),
                ]}
              >
                <DatePicker
                  style={{ width: '100%' }}
                  format={DATE_FORMAT}
                  disabledDate={(current) => current && current.isBefore(dayjs().startOf('day'))}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="warehouse_id" label="Target Warehouse" rules={[{ required: true, message: 'Required' }]}>
                <Select options={warehouses} placeholder="Select warehouse" allowClear showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="project_id" label="Project">
                <Select options={projects} placeholder="Select project" allowClear optionFilterProp="label" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="payment_terms" label="Payment Terms">
                <Input placeholder="e.g. Net 30 days" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="currency" label="Currency">
                <Select
                  options={[
                    { label: 'INR', value: 'INR' },
                    { label: 'USD', value: 'USD' },
                    { label: 'EUR', value: 'EUR' },
                  ]}
                  defaultValue="INR"
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="billing_address" label="Billing Address">
                <TextArea rows={2} placeholder="Enter billing address..." />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="shipping_address" label="Shipping Address">
                <TextArea rows={2} placeholder="Enter shipping address..." />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="remarks" label="Remarks">
            <TextArea rows={2} placeholder="Any remarks..." />
          </Form.Item>
        </Form>

        <Divider orientation="left">Items</Divider>
        <Table
          dataSource={poItems}
          columns={poItemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 1000 }}
          footer={() => (
            <Button type="dashed" onClick={addPoItemRow} icon={<PlusOutlined />} block>
              Add Item
            </Button>
          )}
        />

        <Divider />

        <Row gutter={24}>
          <Col span={12}>
            {/* Attachment Uploader */}
            <div style={{ marginBottom: 16 }}>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>PO Attachment</Text>
              <AttachmentUploader
                entityType="purchase_order"
                entityId={isNew ? null : id}
                label="PO Document"
                onUploadSuccess={(url) => setAttachmentUrl(url)}
              />
            </div>
          </Col>
          <Col span={12}>
            <div style={{ background: '#fafafa', padding: 16, borderRadius: 8 }}>
              <Row style={{ padding: '6px 0' }} align="middle">
                <Col span={12}><Text strong>Gross Total:</Text></Col>
                <Col span={12} style={{ textAlign: 'right' }}><Text>{formatCurrency(calcGrossTotal())}</Text></Col>
              </Row>

              <Row style={{ padding: '6px 0' }} align="middle" gutter={8}>
                <Col span={10}><Text strong>Discount:</Text></Col>
                <Col span={6}>
                  <Select
                    value={discountType}
                    onChange={(v) => setDiscountType(v)}
                    options={[
                      { label: '%', value: 'percent' },
                      { label: 'Val', value: 'amount' },
                    ]}
                    size="small"
                    style={{ width: '100%' }}
                  />
                </Col>
                <Col span={8}>
                  <InputNumber
                    min={0}
                    value={discountValue}
                    onChange={(v) => setDiscountValue(v || 0)}
                    size="small"
                    style={{ width: '100%' }}
                  />
                </Col>
              </Row>

              <Row style={{ padding: '6px 0' }} align="middle">
                <Col span={12}><Text strong>Net Subtotal:</Text></Col>
                <Col span={12} style={{ textAlign: 'right' }}><Text>{formatCurrency(calcSubtotal())}</Text></Col>
              </Row>

              {calcCGST() > 0 && (
                <Row style={{ padding: '4px 0' }}>
                  <Col span={12}><Text type="secondary">CGST:</Text></Col>
                  <Col span={12} style={{ textAlign: 'right' }}><Text>{formatCurrency(calcCGST())}</Text></Col>
                </Row>
              )}
              {calcSGST() > 0 && (
                <Row style={{ padding: '4px 0' }}>
                  <Col span={12}><Text type="secondary">SGST:</Text></Col>
                  <Col span={12} style={{ textAlign: 'right' }}><Text>{formatCurrency(calcSGST())}</Text></Col>
                </Row>
              )}
              {calcIGST() > 0 && (
                <Row style={{ padding: '4px 0' }}>
                  <Col span={12}><Text type="secondary">IGST:</Text></Col>
                  <Col span={12} style={{ textAlign: 'right' }}><Text>{formatCurrency(calcIGST())}</Text></Col>
                </Row>
              )}

              <Divider style={{ margin: '8px 0' }} />

              <Row style={{ padding: '6px 0' }} align="middle">
                <Col span={12}><Text strong style={{ fontSize: 16 }}>Grand Total:</Text></Col>
                <Col span={12} style={{ textAlign: 'right' }}>
                  <Text strong style={{ fontSize: 18, color: '#eb2f96' }}>{formatCurrency(calcGrandTotal())}</Text>
                </Col>
              </Row>
            </div>
          </Col>
        </Row>

        <Divider />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={() => navigate('/procurement/purchase-orders')}>
            Cancel
          </Button>
          <Button onClick={() => handleSubmit('draft')} loading={submitting}>
            Save as Draft
          </Button>
          <Button type="primary" icon={<SendOutlined />} onClick={() => handleSubmit('submit')} loading={submitting}>
            Submit for Approval
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default PurchaseOrderForm;
