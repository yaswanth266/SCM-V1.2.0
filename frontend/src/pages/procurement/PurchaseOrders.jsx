import React, { useState, useCallback } from 'react';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, message, Row, Col, Table, Card, Descriptions,
  Divider, Typography, Tooltip, Tag, Spin, Upload,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  SendOutlined, CheckOutlined, CloseCircleOutlined,
  MinusCircleOutlined, DownloadOutlined, UploadOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
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
import { DATE_FORMAT, TAX_RATES } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const PurchaseOrders = () => {
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingPO, setEditingPO] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterVendor, setFilterVendor] = useState(undefined);

  // Drawer state
  const [poItems, setPoItems] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [selectedVendor, setSelectedVendor] = useState(null);
  const [mrOptions, setMrOptions] = useState([]);
  const [quotationOptions, setQuotationOptions] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [projects, setProjects] = useState([]);

  // Attachment
  const [attachmentUrl, setAttachmentUrl] = useState('');
  const [fileList, setFileList] = useState([]);

  const loadLookups = useCallback(async () => {
    try {
      const [vendorRes, whRes, projRes] = await Promise.allSettled([
        api.get('/masters/vendors', { params: { page_size: 200, status: 'active' } }),
        api.get('/masters/warehouses', { params: { page_size: 200 } }),
        api.get('/masters/projects', { params: { page_size: 200 } }),
      ]);
      if (vendorRes.status === 'fulfilled') {
        const d = vendorRes.value.data;
        const items = d.items || d.data || d || [];
        // BUG-PRO-114 fix: log a console warning when the vendor list is
        // truncated. The PO drawer fetches page_size=200 — once an org has
        // more than 200 active vendors the bottom of the list silently drops
        // off and the operator can't pick them. The proper fix is to switch
        // the AntD Select to async/server-side search; until then, surfacing
        // truncation in the console is the minimum viable warning.
        const total = d.total ?? d.count ?? null;
        if (total != null && total > items.length) {
          // eslint-disable-next-line no-console
          console.warn(
            `[PurchaseOrders] Vendor list truncated: showing ${items.length} of ${total}. ` +
            'Use the search box to find a vendor not in the dropdown.'
          );
        }
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
    } catch {
      // silent
    }
  }, []);

  const loadMROptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/procurement/material-requests', {
        params: { page_size: 50, search, status: 'approved' },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setMrOptions(items.map((mr) => ({ label: mr.mr_number, value: mr.id })));
    } catch {
      // silent
    }
  }, []);

  const loadQuotationOptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/procurement/quotations', {
        params: { page_size: 50, search, status: 'accepted' },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setQuotationOptions(items.map((q) => ({ label: `${q.quotation_number} - ${q.vendor_name || ''}`, value: q.id })));
    } catch {
      // silent
    }
  }, []);

  // Bottom-level discount (like ERPNext)
  const [discountType, setDiscountType] = useState('percent'); // 'percent' or 'amount'
  const [discountValue, setDiscountValue] = useState(0);

  const createEmptyItem = () => ({
    key: Date.now() + Math.random(),
    item_id: null,
    item_name: '',
    qty: 1,
    uom: '',
    rate: 0,
    cgst_percent: 9,
    sgst_percent: 9,
    igst_percent: 0,
    tax_amount: 0,
    amount: 0,
  });

  const fetchPOs = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterVendor) qp.vendor_id = filterVendor;
      return await api.get('/procurement/purchase-orders', { params: qp });
    },
    [filterStatus, filterVendor]
  );

  const handleAdd = () => {
    setEditingPO(null);
    setSelectedVendor(null);
    setAttachmentUrl('');
    setFileList([]);
    form.resetFields();
    form.setFieldsValue({
      po_date: dayjs(),
      expected_delivery_date: dayjs().add(14, 'day'),
    });
    setPoItems([createEmptyItem()]);
    setDiscountType('percent');
    setDiscountValue(0);
    loadLookups();
    loadMROptions();
    loadQuotationOptions();
    setDrawerOpen(true);
  };

  const handleEdit = async (record) => {
    setEditingPO(record);
    loadLookups();
    loadMROptions();
    loadQuotationOptions();
    try {
      const res = await api.get(`/procurement/purchase-orders/${record.id}`);
      const data = res.data;
      form.setFieldsValue({
        ...data,
        po_date: data.po_date ? dayjs(data.po_date) : null,
        expected_delivery_date: data.expected_delivery_date ? dayjs(data.expected_delivery_date) : null,
      });

      if (data.vendor) {
        setSelectedVendor(data.vendor);
      }

      // BUG-PRO-142 fix: route the per-row maths through `recalcItem` instead
      // of duplicating the formula inline. Previously the inline branch never
      // populated `discount_pct` and the totals could drift from the table
      // footer (which uses recalcItem).
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
      // Set items first, THEN discount — avoids double-update flicker
      setPoItems(items.length > 0 ? items : [createEmptyItem()]);
      setDiscountType(data.discount_type || 'percent');
      setDiscountValue(data.discount_value || 0);

      // Restore attachment
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
      return;
    }
    setDrawerOpen(true);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/procurement/purchase-orders/${id}`);
      message.success('Purchase Order deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // Item row calculations (no per-item discount — discount is at bottom)
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
        // If IGST is set, clear CGST/SGST and vice versa
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

  // Totals — discount applied at bottom level (like ERPNext)
  const calcGrossTotal = () =>
    poItems.reduce((sum, item) => sum + (item.qty || 0) * (item.rate || 0), 0);

  const calcDiscountAmount = () => {
    const gross = calcGrossTotal();
    if (discountType === 'percent') return gross * (discountValue || 0) / 100;
    return discountValue || 0;
  };

  const calcSubtotal = () => calcGrossTotal() - calcDiscountAmount();

  // Tax calculated on net amount (after discount distributed proportionally)
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

      // Check if selected vendor has GSTIN
      const vendorGstin = (selectedVendor?.gst_number || '').trim();
      const hasGstin = !!vendorGstin;

      const items = (qData.items || []).map((item, idx) => {
        let cg = item.cgst_rate || item.cgst_percent || 0;
        let sg = item.sgst_rate || item.sgst_percent || 0;
        let ig = item.igst_rate || item.igst_percent || 0;
        const taxRate = item.tax_rate || 0;

        if (cg === 0 && sg === 0 && ig === 0 && taxRate > 0) {
          if (hasGstin) {
            cg = taxRate / 2;
            sg = taxRate / 2;
            ig = 0;
          } else {
            cg = 0;
            sg = 0;
            ig = taxRate;
          }
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
      // Copy over everything useful — warehouse was previously missed and
      // blocked save since it's a required field.
      const patch = {};
      if (mrData.warehouse_id) patch.warehouse_id = mrData.warehouse_id;
      if (mrData.project_id) patch.project_id = mrData.project_id;
      if (mrData.required_date) patch.expected_delivery_date = dayjs(mrData.required_date);
      if (Object.keys(patch).length) form.setFieldsValue(patch);

      // Check if selected vendor has GSTIN
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

  const handleSubmit = async (submitAction = 'draft') => {
    try {
      const values = await form.validateFields();
      const validItems = poItems.filter((i) => i.item_id && i.rate > 0);
      if (validItems.length === 0) {
        message.error('Please add at least one item with a rate');
        return;
      }

      // BUG-PRO-136 fix: warn the user (but don't hard-block) when the PO
      // grand_total exceeds the vendor's stored credit_limit. Backend can
      // still allow with override, but a noisy upfront prompt prevents
      // accidental large orders against credit-limited vendors.
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

      // BUG-PRO-137 fix: surface the DL gate at the vendor-selection step
      // (warn before submit) instead of catching it only at backend POST. If
      // any line item is medicine and the selected vendor has no DL on file,
      // refuse the submit with a clear message naming the vendor.
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

      // BUG-PRO-143 fix: GSTIN-vs-tax cross check. If the vendor has no GSTIN,
      // refuse to send CGST/SGST values — those must be IGST or zero. Mirrors
      // the backend BUG-PRO-013 check so the user gets immediate feedback.
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

      setSubmitting(true);

      let status = 'draft';
      if (submitAction === 'submit') status = 'pending_approval';
      if (submitAction === 'approve') status = 'approved';

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
          rate: item.rate,
          discount_pct: 0,
          cgst_rate: item.cgst_percent || item.cgst_rate || 0,
          sgst_rate: item.sgst_percent || item.sgst_rate || 0,
          igst_rate: item.igst_percent || item.igst_rate || 0,
          tax_amount: item.tax_amount,
          amount: item.amount,
        })),
      };

      if (editingPO) {
        await api.put(`/procurement/purchase-orders/${editingPO.id}`, payload);
        if (submitAction === 'submit' && editingPO.status === 'draft') {
          try {
            await api.post(`/procurement/purchase-orders/${editingPO.id}/submit`);
            message.success('Purchase Order submitted for approval');
          } catch (submitErr) {
            // BUG-PRO-135 fix: a submit-after-save failure used to flash a
            // single message.warning that auto-dismissed; users walked away
            // thinking the PO was in approval when it was still draft. Use
            // message.error with a longer duration AND keep the drawer open
            // so the user sees the partial state and can retry submit.
            message.error({
              content: 'PO saved as draft, but submit-for-approval failed: '
                + getErrorMessage(submitErr) + ' — open the PO and retry "Submit".',
              duration: 8,
            });
            return;
          }
        } else {
          message.success('Purchase Order updated');
        }
      } else {
        const res = await api.post('/procurement/purchase-orders', { ...payload, status: 'draft' });
        const newId = res.data?.id;
        if (submitAction === 'submit' && newId) {
          try {
            await api.post(`/procurement/purchase-orders/${newId}/submit`);
            message.success('Purchase Order created and submitted for approval');
          } catch (submitErr) {
            // BUG-PRO-135 fix: same loud-error treatment for the create path.
            message.error({
              content: 'PO created as draft, but submit-for-approval failed: '
                + getErrorMessage(submitErr) + ' — open the PO and retry "Submit".',
              duration: 8,
            });
            return;
          }
        } else {
          message.success('Purchase Order created as draft');
        }
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingPO(null);
      setPoItems([]);
      setSelectedVendor(null);
      setAttachmentUrl('');
      setFileList([]);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleApprove = async (id) => {
    try {
      await api.post(`/procurement/purchase-orders/${id}/approve`);
      message.success('Purchase Order approved');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleCancel = async (id) => {
    try {
      await api.post(`/procurement/purchase-orders/${id}/cancel`);
      message.success('Purchase Order cancelled');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleExport = async () => {
    try {
      const res = await api.get('/procurement/purchase-orders', { params: { page_size: 10000 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      const exportData = items.map((po) => ({
        'PO Number': po.po_number,
        'Vendor': po.vendor_name || '',
        'PO Date': formatDate(po.po_date),
        'Expected Delivery': formatDate(po.expected_delivery_date),
        'Grand Total': po.grand_total || 0,
        'Status': po.status,
      }));
      downloadExcel(exportData, 'purchase_orders', 'Purchase Orders');
      message.success('Export completed');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // PO items table columns in drawer
  const poItemColumns = [
    { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item',
      dataIndex: 'item_id',
      width: 220,
      render: (val, record) => (
        record.item_name ? (
          <Tooltip title={record.item_name}>
            <Text ellipsis style={{ maxWidth: 200 }}>{record.item_name}</Text>
          </Tooltip>
        ) : (
          <ItemSelector
            value={val}
            onChange={(itemId, item) => {
              updatePoItem(record.key, 'item_id', itemId);
              if (item) {
                // Bug fix BUG_0088 — auto-fill UOM, rate, tax when item selected
                updatePoItem(record.key, 'item_name', item.item_name || item.name || '');
                updatePoItem(record.key, 'uom', item.uom || item.default_uom || item.primary_uom?.name || '');
                updatePoItem(record.key, 'uom_id', item.primary_uom_id || item.uom_id || null);
                const rate = parseFloat(item.purchase_price || 0);
                if (rate > 0) updatePoItem(record.key, 'rate', rate);

                // Check if selected vendor has GSTIN and split/assign GST rates dynamically
                const vendorGstin = (selectedVendor?.gst_number || '').trim();
                const hasGstin = !!vendorGstin;

                let cg = parseFloat(item.cgst_rate || item.cgst_percent || 0);
                let sg = parseFloat(item.sgst_rate || item.sgst_percent || 0);
                let ig = parseFloat(item.igst_rate || item.igst_percent || 0);
                const tax = parseFloat(item.tax_rate || 0);

                if (cg === 0 && sg === 0 && ig === 0 && tax > 0) {
                  if (hasGstin) {
                    cg = tax / 2;
                    sg = tax / 2;
                    ig = 0;
                  } else {
                    cg = 0;
                    sg = 0;
                    ig = tax;
                  }
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
      title: 'Qty', dataIndex: 'qty', width: 70,
      render: (val, record) => (
        <InputNumber min={0.01} value={val} onChange={(v) => updatePoItem(record.key, 'qty', v)} style={{ width: '100%' }} size="small" />
      ),
    },
    {
      title: 'UOM', dataIndex: 'uom', width: 60,
      render: (val) => <Text style={{ fontSize: 12 }}>{val || '-'}</Text>,
    },
    {
      title: 'Rate', dataIndex: 'rate', width: 90,
      render: (val, record) => (
        <InputNumber min={0} value={val} onChange={(v) => updatePoItem(record.key, 'rate', v)} style={{ width: '100%' }} size="small" />
      ),
    },
    {
      title: 'CGST%', dataIndex: 'cgst_percent', width: 65,
      render: (val, record) => (
        <InputNumber min={0} max={28} value={val} onChange={(v) => updatePoItem(record.key, 'cgst_percent', v)} style={{ width: '100%' }} size="small" />
      ),
    },
    {
      title: 'SGST%', dataIndex: 'sgst_percent', width: 65,
      render: (val, record) => (
        <InputNumber min={0} max={28} value={val} onChange={(v) => updatePoItem(record.key, 'sgst_percent', v)} style={{ width: '100%' }} size="small" />
      ),
    },
    {
      title: 'IGST%', dataIndex: 'igst_percent', width: 65,
      render: (val, record) => (
        <InputNumber min={0} max={28} value={val} onChange={(v) => updatePoItem(record.key, 'igst_percent', v)} style={{ width: '100%' }} size="small" />
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
        poItems.length > 1 ? (
          <MinusCircleOutlined style={{ color: '#ff4d4f', cursor: 'pointer' }} onClick={() => removePoItemRow(record.key)} />
        ) : null,
    },
  ];

  const columns = [
    {
      title: 'PO Number',
      dataIndex: 'po_number',
      key: 'po_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a onClick={() => navigate(`/procurement/purchase-orders/${record.id}`)}>{text}</a>
      ),
    },
    {
      title: 'Vendor',
      dataIndex: 'vendor_name',
      key: 'vendor',
      width: 200,
      ellipsis: true,
      render: (v, r) => v || r.vendor || '-',
    },
    {
      title: 'PO Date',
      dataIndex: 'po_date',
      key: 'po_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Expected Delivery',
      dataIndex: 'expected_delivery_date',
      key: 'delivery',
      width: 140,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Grand Total',
      dataIndex: 'grand_total',
      key: 'grand_total',
      width: 140,
      align: 'right',
      sorter: true,
      render: (v) => <Text strong>{formatCurrency(v)}</Text>,
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
      width: 180,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button
            type="link"
            size="small"
            icon={<EyeOutlined />}
            onClick={() => navigate(`/procurement/purchase-orders/${record.id}`)}
          />
          {record.status === 'draft' && (
            <>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
              <Tooltip title="Submit for Approval">
                <Popconfirm title="Submit PO for approval?" onConfirm={async () => {
                  try {
                    await api.post(`/procurement/purchase-orders/${record.id}/submit`);
                    message.success('PO submitted for approval');
                    setRefreshKey((k) => k + 1);
                  } catch (err) { message.error(getErrorMessage(err)); }
                }}>
                  <Button type="link" size="small" icon={<SendOutlined />} />
                </Popconfirm>
              </Tooltip>
              <Popconfirm title="Delete this PO?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
          {record.status === 'pending_approval' && (
            <>
              <Tooltip title="Approve">
                <Popconfirm title="Approve this PO?" onConfirm={() => handleApprove(record.id)}>
                  <Button type="link" size="small" style={{ color: '#52c41a' }} icon={<CheckOutlined />} />
                </Popconfirm>
              </Tooltip>
              <Popconfirm title="Cancel this PO?" onConfirm={() => handleCancel(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<CloseCircleOutlined />} />
              </Popconfirm>
            </>
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
          { label: 'Pending Approval', value: 'pending_approval' },
          { label: 'Approved', value: 'approved' },
          { label: 'Partially Received', value: 'partially_received' },
          { label: 'Received', value: 'received' },
          { label: 'Closed', value: 'closed' },
          { label: 'Cancelled', value: 'cancelled' },
        ]}
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="Purchase Orders" subtitle="Manage purchase orders">
        <Space>
          <Button icon={<DownloadOutlined />} onClick={handleExport}>Export</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Create PO</Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchPOs}
        rowKey="id"
        searchPlaceholder="Search by PO number or vendor..."
        exportFileName="purchase_orders"
        toolbar={toolbar}
        scroll={{ x: 1400 }}
      />

      {/* Create / Edit Drawer */}
      <Drawer
        title={editingPO ? `Edit ${editingPO.po_number}` : 'Create Purchase Order'}
        width={1100}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setEditingPO(null);
          form.resetFields();
          setPoItems([]);
          setSelectedVendor(null);
        }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); setEditingPO(null); form.resetFields(); setPoItems([]); setSelectedVendor(null); }}>
              Cancel
            </Button>
            <Button onClick={() => handleSubmit('draft')} loading={submitting}>
              Save as Draft
            </Button>
            <Button type="primary" icon={<SendOutlined />} onClick={() => handleSubmit('submit')} loading={submitting}>
              Submit for Approval
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          {/* Vendor Section */}
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="vendor_id" label="Vendor" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  options={vendors}
                  placeholder="Select vendor"
                  showSearch
                  optionFilterProp="label"
                  onChange={handleVendorChange}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              {selectedVendor && (
                <Card size="small" style={{ background: '#f9f9f9' }}>
                  <Descriptions size="small" column={2}>
                    <Descriptions.Item label="Code">{selectedVendor.vendor_code}</Descriptions.Item>
                    <Descriptions.Item label="Phone">{selectedVendor.phone || '-'}</Descriptions.Item>
                    <Descriptions.Item label="GST">{selectedVendor.gst_number || '-'}</Descriptions.Item>
                    <Descriptions.Item label="Payment Terms">{selectedVendor.payment_terms_days ? `${selectedVendor.payment_terms_days} days` : '-'}</Descriptions.Item>
                  </Descriptions>
                </Card>
              )}
            </Col>
          </Row>

          {/* Linking */}
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="mr_id" label="Link to Material Request">
                <Select
                  options={mrOptions}
                  placeholder="Select MR (optional)"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  onChange={handleMRSelect}
                  onSearch={(v) => loadMROptions(v)}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="quotation_id" label="Link to Quotation">
                <Select
                  options={quotationOptions}
                  placeholder="Select Quotation (optional)"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  onChange={handleQuotationSelect}
                  onSearch={(v) => loadQuotationOptions(v)}
                />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="project_id" label="Project">
                <Select options={projects} placeholder="Project" allowClear showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
            <Col span={4}>
              <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true, message: 'Warehouse is required for GRN tracking' }]}>
                <Select options={warehouses} placeholder="Warehouse" showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
          </Row>

          {/* Dates & Terms */}
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item name="po_date" label="PO Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="expected_delivery_date" label="Expected Delivery" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="payment_terms" label="Payment Terms">
                <Input placeholder="e.g. Net 30" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="currency" label="Currency" initialValue="INR">
                <Select options={[{ label: 'INR', value: 'INR' }, { label: 'USD', value: 'USD' }]} />
              </Form.Item>
            </Col>
          </Row>

        {/* Items Table */}
        <Divider orientation="left">Items</Divider>
        <Table
          dataSource={poItems}
          columns={poItemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 1050 }}
          footer={() => (
            <Button type="dashed" onClick={addPoItemRow} icon={<PlusOutlined />} block>
              Add Item
            </Button>
          )}
        />

        {/* Totals Summary — discount at bottom like ERPNext */}
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ width: 380 }}>
            <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Col span={12}><Text>Gross Total:</Text></Col>
              <Col span={12} style={{ textAlign: 'right' }}><Text>{formatCurrency(calcGrossTotal())}</Text></Col>
            </Row>
            <Row style={{ padding: '8px 0', borderBottom: '1px solid #f0f0f0', alignItems: 'center' }} align="middle">
              <Col span={12}>
                <Space size={4}>
                  <Text>Discount</Text>
                  <Select
                    size="small"
                    value={discountType}
                    onChange={setDiscountType}
                    style={{ width: 65 }}
                    options={[
                      { label: '%', value: 'percent' },
                      { label: 'Amt', value: 'amount' },
                    ]}
                  />
                </Space>
              </Col>
              <Col span={12} style={{ textAlign: 'right' }}>
                <Space size={4}>
                  <InputNumber
                    size="small"
                    min={0}
                    // BUG-PRO-138 fix: percent discount stays capped at 100,
                    // but absolute-amount discount no longer hard-caps at the
                    // current gross — that gross changes as the user types and
                    // a stale cap blocked legitimate edits (e.g., entering ₹500
                    // discount before the second item has been added). The
                    // submit handler still enforces ``discount <= subtotal``.
                    max={discountType === 'percent' ? 100 : undefined}
                    value={discountValue}
                    onChange={(v) => setDiscountValue(v || 0)}
                    style={{ width: 100 }}
                    addonAfter={discountType === 'percent' ? '%' : ''}
                  />
                  {calcDiscountAmount() > 0 && (
                    <Text type="danger" style={{ minWidth: 80, textAlign: 'right', display: 'inline-block' }}>
                      -{formatCurrency(calcDiscountAmount())}
                    </Text>
                  )}
                </Space>
              </Col>
            </Row>
            <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Col span={12}><Text strong>Net Amount:</Text></Col>
              <Col span={12} style={{ textAlign: 'right' }}><Text strong>{formatCurrency(calcSubtotal())}</Text></Col>
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

        {/* Addresses & Remarks */}
        <Divider orientation="left">Additional Details</Divider>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="billing_address" label="Billing Address">
                <TextArea rows={3} placeholder="Billing address..." />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="shipping_address" label="Shipping Address">
                <TextArea rows={3} placeholder="Shipping address..." />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remarks" label="Remarks">
            <TextArea rows={2} placeholder="Any remarks..." />
          </Form.Item>
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
        </Form>
      </Drawer>
    </div>
  );
};

export default PurchaseOrders;

