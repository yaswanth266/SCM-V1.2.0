import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Modal,
  Divider, Typography, Tooltip, Tag, Tabs, Alert, Badge,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  SendOutlined, CheckOutlined, CloseCircleOutlined,
  MinusCircleOutlined, DownloadOutlined, ScanOutlined,
  InboxOutlined, ExperimentOutlined, PrinterOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useReactToPrint } from 'react-to-print';
import PageHeader from '../../components/PageHeader';
import { PurchaseReceiptPrint } from '../../components/PrintTemplates';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import BarcodeScanner from '../../components/BarcodeScanner';
import BarcodeDisplay from '../../components/BarcodeDisplay';
import api from '../../config/api';
import {
  formatDate, formatCurrency, formatNumber, getErrorMessage,
  formatDateForAPI, formatDateTime,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text, Title } = Typography;

const RECEIPT_TYPES = [
  { label: 'Inward Based', value: 'inward_based' },
  { label: 'Direct', value: 'direct' },
  { label: 'Return', value: 'return' },
  { label: 'Transfer', value: 'transfer' },
];

const GRN_STATUSES = [
  { label: 'Draft', value: 'draft' },
  { label: 'Pending QI', value: 'pending_qi' },
  { label: 'QI In Progress', value: 'qi_in_progress' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const GRN = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [viewData, setViewData] = useState(null);
  const printRef = useRef(null);
  const handlePrintGrn = useReactToPrint({ content: () => printRef.current, documentTitle: viewData?.grn_number || 'GRN' });
  const [viewLoading, setViewLoading] = useState(false);
  const [editingGRN, setEditingGRN] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [scannerVisible, setScannerVisible] = useState(false);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterVendor, setFilterVendor] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);
  const [filterDateRange, setFilterDateRange] = useState(null);

  // Drawer state
  const [receiptType, setReceiptType] = useState('inward_based');
  const [grnItems, setGrnItems] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [poOptions, setPoOptions] = useState([]);
  const [selectedPO, setSelectedPO] = useState(null);
  const [selectedVendor, setSelectedVendor] = useState(null);
  const [loadingPO, setLoadingPO] = useState(false);
  const [inwardOptions, setInwardOptions] = useState([]);
  const [loadingInwards, setLoadingInwards] = useState(false);
  const [selectedInward, setSelectedInward] = useState(null);

  // --- Lookups ---
  const loadLookups = useCallback(async () => {
    try {
      const [vendorRes, whRes] = await Promise.allSettled([
        api.get('/masters/vendors', { params: { page_size: 200, status: 'active' } }),
        api.get('/masters/warehouses', { params: { page_size: 200 } }),
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
        setWarehouses(
          (w.items || w.data || w || []).map((i) => ({
            label: i.name || i.warehouse_name,
            value: i.id,
          }))
        );
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
      setPoOptions(
        items.map((po) => ({
          label: `${po.po_number} - ${po.vendor_name || ''}`,
          value: po.id,
          po,
        }))
      );
    } catch {
      // silent
    }
  }, []);

  // Preload lookups on mount
  useEffect(() => {
    loadLookups();
    loadPOOptions();
    loadInwardOptions();
  }, []);

  // --- Fetch GRNs ---
  const fetchGRNs = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterVendor) qp.vendor_id = filterVendor;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      if (filterDateRange && filterDateRange[0]) {
        qp.date_from = formatDateForAPI(filterDateRange[0]);
        qp.date_to = formatDateForAPI(filterDateRange[1]);
      }
      return await api.get('/warehouse/grn', { params: qp });
    },
    [filterStatus, filterVendor, filterWarehouse, filterDateRange]
  );

  // --- Item Row ---
  const createEmptyItem = () => ({
    key: Date.now() + Math.random(),
    item_id: null,
    item_name: '',
    item_code: '',
    uom: '',
    ordered_qty: 0,
    received_qty: 0,
    accepted_qty: 0,
    rejected_qty: 0,
    shortage_qty: 0,
    excess_qty: 0,
    damaged_qty: 0,
    batch_number: '',
    manufacturing_date: null,
    expiry_date: null,
    rate: 0,
    amount: 0,
  });

  const recalcItem = (item) => {
    const accepted = item.accepted_qty || 0;
    const rejected = item.rejected_qty || 0;
    const damaged = item.damaged_qty || 0;
    const received = item.received_qty || 0;
    const ordered = item.ordered_qty || 0;

    item.shortage_qty = Math.max(0, ordered - received);
    item.excess_qty = Math.max(0, received - ordered);
    // BUG-INV-127: align FE amount basis with backend. Backend computes
    // amount = received_qty * rate (because QI hasn't decided accepted yet at
    // GRN-create time). Using accepted_qty here let the FE total disagree
    // with the saved GRN total whenever receipts had any rejected/damaged qty.
    item.amount = Number(((item.received_qty || 0) * (item.rate || 0)).toFixed(2));
    return item;
  };

  const updateGrnItem = (key, field, value) => {
    setGrnItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        const updated = { ...item, [field]: value };
        if (field === 'received_qty') {
          updated.accepted_qty = value - (updated.rejected_qty || 0) - (updated.damaged_qty || 0);
          if (updated.accepted_qty < 0) updated.accepted_qty = 0;
        }
        if (field === 'rejected_qty' || field === 'damaged_qty') {
          updated.accepted_qty = (updated.received_qty || 0) - (updated.rejected_qty || 0) - (updated.damaged_qty || 0);
          if (updated.accepted_qty < 0) updated.accepted_qty = 0;
        }
        return recalcItem(updated);
      })
    );
  };

  const addGrnItemRow = () => {
    setGrnItems((prev) => [...prev, createEmptyItem()]);
  };

  const removeGrnItemRow = (key) => {
    setGrnItems((prev) => prev.filter((i) => i.key !== key));
  };

  // BUG-INV-094: track recent scan timestamps so a quick double-scan within
  // a short window is treated as one event (handhelds and webcams routinely
  // emit duplicates within ~250ms).
  const lastScanRef = useRef({ value: null, ts: 0 });

  // --- Barcode Scan Handler ---
  const handleBarcodeScan = async (scanResult) => {
    const scannedValue = scanResult.value;
    // BUG-INV-094: dedupe quick double-scans of the same code (< 800ms apart)
    const now = Date.now();
    if (
      lastScanRef.current.value === scannedValue &&
      now - lastScanRef.current.ts < 800
    ) {
      return; // silently ignore duplicate
    }
    lastScanRef.current = { value: scannedValue, ts: now };
    try {
      const res = await api.get('/masters/items', {
        params: { search: scannedValue, page_size: 25 },
      });
      const data = res.data;
      const itemsRaw = data.items || data.data || data || [];
      // BUG-INV-092: backend `search` is a partial/prefix match, so picking
      // index 0 routinely picked the wrong item when the scanned code was a
      // prefix of multiple SKUs (e.g. "PARA" matching PARA-500 and PARACET).
      // Require an EXACT match on barcode / item_code / sku before accepting.
      const norm = (v) => (v == null ? '' : String(v).trim());
      const target = norm(scannedValue);
      const items = itemsRaw.filter((it) =>
        norm(it.barcode) === target ||
        norm(it.item_code) === target ||
        norm(it.code) === target ||
        norm(it.sku) === target
      );
      if (items.length === 0) {
        message.warning(`No item found for barcode: ${scannedValue}`);
        return;
      }
      if (items.length > 1) {
        message.error(`Ambiguous barcode "${scannedValue}" — ${items.length} items match. Resolve in Item Master.`);
        return;
      }
      {
        const item = items[0];
        // BUG-INV-093: pack-size aware — scanning a pack barcode increments
        // by the pack quantity (e.g. a strip of 10 tablets) rather than 1.
        const packSize = Number(item.pack_size || item.units_per_pack || 1) || 1;
        const existingIdx = grnItems.findIndex((gi) => gi.item_id === item.id);
        if (existingIdx >= 0) {
          updateGrnItem(grnItems[existingIdx].key, 'received_qty', (grnItems[existingIdx].received_qty || 0) + packSize);
          message.success(`Incremented qty by ${packSize} for ${item.item_name || item.name}`);
        } else {
          const newItem = {
            ...createEmptyItem(),
            item_id: item.id,
            item_name: item.item_name || item.name || '',
            item_code: item.item_code || item.code || '',
            uom: item.uom || item.default_uom || '',
            received_qty: packSize,
            accepted_qty: packSize,
            rate: item.last_purchase_rate || item.rate || 0,
          };
          recalcItem(newItem);
          setGrnItems((prev) => [...prev.filter((i) => i.item_id !== null), newItem]);
          message.success(`Added ${item.item_name || item.name} (${packSize} units) from scan`);
        }
      }
    } catch (err) {
      message.error('Failed to lookup scanned barcode');
    }
  };

  // --- PO Selection ---
  const handlePOSelect = async (poId) => {
    if (!poId) {
      setSelectedPO(null);
      setGrnItems([createEmptyItem()]);
      return;
    }
    setLoadingPO(true);
    try {
      const res = await api.get(`/procurement/purchase-orders/${poId}`);
      const poData = res.data;
      setSelectedPO(poData);

      // Auto-fill vendor
      if (poData.vendor_id) {
        form.setFieldsValue({ vendor_id: poData.vendor_id });
        const found = vendors.find((v) => v.value === poData.vendor_id);
        setSelectedVendor(found ? found.vendor : null);
        // If vendor not in options list yet (filtered), add it
        if (!found && poData.vendor_name) {
          setVendors((prev) => [...prev, { label: `[${poData.vendor_code || poData.vendor_id}] ${poData.vendor_name}`, value: poData.vendor_id, vendor: { id: poData.vendor_id, name: poData.vendor_name } }]);
        }
      }

      // Auto-fill warehouse from PO
      if (poData.warehouse_id) {
        form.setFieldsValue({ warehouse_id: poData.warehouse_id });
      }

      // Auto-fill items
      const items = (poData.items || []).map((item, idx) => {
        const pendingQty = (item.qty || item.quantity || 0) - (item.received_qty || 0);
        const row = {
          key: item.id || Date.now() + idx,
          item_id: item.item_id,
          item_name: item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.item_name}` : ''),
          item_code: item.item_code || (item.item ? item.item.item_code : ''),
          uom: item.uom || item.uom_name || item.unit || '',
          uom_id: item.uom_id,  // backend requires uom_id
          ordered_qty: item.qty || item.quantity || 0,
          pending_qty: Math.max(0, pendingQty),
          received_qty: Math.max(0, pendingQty),
          accepted_qty: Math.max(0, pendingQty),
          rejected_qty: 0,
          shortage_qty: 0,
          excess_qty: 0,
          damaged_qty: 0,
          batch_number: '',
          manufacturing_date: null,
          expiry_date: null,
          rate: item.rate || item.unit_price || 0,
          amount: Number((Math.max(0, pendingQty) * (item.rate || item.unit_price || 0)).toFixed(2)),
          po_item_id: item.id,
        };
        return row;
      });
      setGrnItems(items.length > 0 ? items : [createEmptyItem()]);
      message.success('PO items loaded');
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoadingPO(false);
    }
  };

  // --- Inward Options and Selection ---
  const loadInwardOptions = useCallback(async (search = '') => {
    setLoadingInwards(true);
    try {
      const res = await api.get('/warehouse/inwards', {
        params: { page_size: 100, search, status: 'received' },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setInwardOptions(
        items.map((inw) => ({
          label: `${inw.inward_number} - ${inw.vendor_name || inw.vendor_name_manual || ''}`,
          value: inw.id,
          inward: inw,
        }))
      );
    } catch {
      // silent
    } finally {
      setLoadingInwards(false);
    }
  }, []);

  const handleInwardSelect = async (inwardId) => {
    if (!inwardId) {
      setSelectedInward(null);
      setSelectedPO(null);
      setGrnItems([createEmptyItem()]);
      form.setFieldsValue({ po_number: null });
      return;
    }
    setLoadingPO(true);
    try {
      const res = await api.get(`/warehouse/inwards/${inwardId}`);
      const inwardData = res.data;
      setSelectedInward(inwardData);

      // Auto-fill vendor
      if (inwardData.vendor_id) {
        form.setFieldsValue({ vendor_id: inwardData.vendor_id });
        const found = vendors.find((v) => v.value === inwardData.vendor_id);
        setSelectedVendor(found ? found.vendor : null);
        if (!found && inwardData.vendor_name) {
          setVendors((prev) => [
            ...prev,
            { label: `[${inwardData.vendor_code || inwardData.vendor_id}] ${inwardData.vendor_name}`, value: inwardData.vendor_id, vendor: { id: inwardData.vendor_id, name: inwardData.vendor_name } }
          ]);
        }
      }

      // Auto-fill warehouse
      if (inwardData.warehouse_id) {
        form.setFieldsValue({ warehouse_id: inwardData.warehouse_id });
      }

      // Auto-fill PO number from inward
      form.setFieldsValue({ po_number: inwardData.po_number || null });

      // Auto-fill vehicle number
      if (inwardData.vehicle_number) {
        form.setFieldsValue({ vehicle_number: inwardData.vehicle_number });
      }

      // If inward is PO-linked, fetch PO to get rates and po_item_id mapping
      let poItemsMap = {};
      if (inwardData.po_id) {
        try {
          const poRes = await api.get(`/procurement/purchase-orders/${inwardData.po_id}`);
          const poData = poRes.data;
          setSelectedPO(poData);
          form.setFieldsValue({ po_id: inwardData.po_id });

          if (poData.items) {
            poData.items.forEach((item) => {
              poItemsMap[item.item_id] = item;
            });
          }
        } catch (poErr) {
          console.error('Failed to fetch related PO', poErr);
        }
      } else {
        setSelectedPO(null);
        form.setFieldsValue({ po_id: undefined });
      }

      // Auto-fill items
      const items = (inwardData.items || []).map((item, idx) => {
        const poItem = poItemsMap[item.item_id];
        const rate = poItem ? (poItem.rate || poItem.unit_price || 0) : 0;
        const po_item_id = poItem ? poItem.id : null;
        const ordered_qty = poItem ? (poItem.qty || poItem.quantity || 0) : (item.ordered_qty || 0);

        const row = {
          key: item.id || Date.now() + idx,
          item_id: item.item_id,
          item_name: item.item_name || item.item_name_manual || '',
          item_code: item.item_code || '',
          uom: item.uom_name || item.uom_manual || '',
          uom_id: item.uom_id,
          ordered_qty: ordered_qty,
          pending_qty: Math.max(0, ordered_qty - (item.received_qty || 0)),
          received_qty: item.received_qty || 0,
          accepted_qty: item.received_qty || 0,
          rejected_qty: 0,
          shortage_qty: Math.max(0, ordered_qty - (item.received_qty || 0)),
          excess_qty: Math.max(0, (item.received_qty || 0) - ordered_qty),
          damaged_qty: 0,
          batch_number: '',
          manufacturing_date: null,
          expiry_date: null,
          rate: rate,
          amount: Number(((item.received_qty || 0) * rate).toFixed(2)),
          po_item_id: po_item_id,
        };
        return row;
      });
      setGrnItems(items.length > 0 ? items : [createEmptyItem()]);
      message.success('Material Inward items loaded successfully');
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoadingPO(false);
    }
  };

  // --- Totals ---
  const calcTotalQty = () => grnItems.reduce((s, i) => s + (i.received_qty || 0), 0);
  const calcAcceptedQty = () => grnItems.reduce((s, i) => s + (i.accepted_qty || 0), 0);
  const calcRejectedQty = () => grnItems.reduce((s, i) => s + (i.rejected_qty || 0), 0);
  const calcDamagedQty = () => grnItems.reduce((s, i) => s + (i.damaged_qty || 0), 0);
  const calcTotalAmount = () => grnItems.reduce((s, i) => s + (i.amount || 0), 0);

  // --- Open Drawer ---
  const handleAdd = () => {
    setEditingGRN(null);
    setSelectedVendor(null);
    setSelectedPO(null);
    setSelectedInward(null);
    setReceiptType('inward_based');
    form.resetFields();
    form.setFieldsValue({
      receipt_type: 'inward_based',
      grn_date: dayjs(),
    });
    setGrnItems([createEmptyItem()]);
    loadLookups();
    loadPOOptions();
    loadInwardOptions();
    setScannerVisible(false);
    setDrawerOpen(true);
  };

  // --- View Detail ---
  const handleView = async (record) => {
    setViewLoading(true);
    setViewModalOpen(true);
    try {
      const res = await api.get(`/warehouse/grn/${record.id}`);
      setViewData(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
      setViewModalOpen(false);
    } finally {
      setViewLoading(false);
    }
  };

  // --- Submit ---
  const handleSubmit = async (submitAction = 'draft') => {
    try {
      const values = await form.validateFields();
      const validItems = grnItems.filter((i) => i.item_id && i.received_qty > 0);
      if (validItems.length === 0) {
        message.error('Please add at least one item with received quantity');
        return;
      }
      setSubmitting(true);

      let status = 'draft';
      if (submitAction === 'submit_qi') status = 'pending_qi';
      if (submitAction === 'complete') status = 'completed';

      // BUG-INV-125: tell backend to honour Save-as-Draft instead of always
      // bumping to pending_qi. Backend-side gate added in GRNCreate schema.
      const isDraft = submitAction === 'draft';

      const payload = {
        ...values,
        po_id: selectedPO?.id || values.po_id || null,
        po_number: selectedPO?.po_number || selectedInward?.po_number || null,
        inward_id: selectedInward?.id || values.inward_id || null,
        receipt_type: receiptType,
        grn_date: formatDateForAPI(values.grn_date),
        supplier_invoice_date: formatDateForAPI(values.supplier_invoice_date),
        status,
        is_draft: isDraft,
        total_qty: calcTotalQty(),
        accepted_qty: calcAcceptedQty(),
        rejected_qty: calcRejectedQty(),
        damaged_qty: calcDamagedQty(),
        total_amount: Number(calcTotalAmount().toFixed(2)),
        items: validItems.map((item) => {
          // Fall back to selectedPO line for uom_id if the row lost it (some
          // antd column edits can spread an item without uom_id when columns
          // re-render). Schema on backend requires uom_id (int).
          let uomId = item.uom_id;
          if (uomId == null && selectedPO?.items) {
            const src = selectedPO.items.find((p) => p.item_id === item.item_id);
            uomId = src?.uom_id ?? null;
          }
          return {
            item_id: item.item_id,
            po_item_id: item.po_item_id || null,
            ordered_qty: item.ordered_qty,
            received_qty: item.received_qty,
            accepted_qty: item.accepted_qty,
            rejected_qty: item.rejected_qty,
            shortage_qty: item.shortage_qty,
            excess_qty: item.excess_qty,
            damaged_qty: item.damaged_qty,
            batch_number: item.batch_number,
            manufacturing_date: item.manufacturing_date ? formatDateForAPI(item.manufacturing_date) : null,
            expiry_date: item.expiry_date ? formatDateForAPI(item.expiry_date) : null,
            rate: item.rate,
            amount: item.amount,
            uom: item.uom,
            uom_id: uomId,
          };
        }),
      };

      if (editingGRN) {
        await api.put(`/warehouse/grn/${editingGRN.id}`, payload);
        message.success('GRN updated successfully');
      } else {
        await api.post('/warehouse/grn', payload);
        message.success('GRN created successfully');
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingGRN(null);
      setGrnItems([]);
      setSelectedVendor(null);
      setSelectedPO(null);
      setSelectedInward(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // --- Actions ---
  const handleSubmitForQI = async (id) => {
    try {
      await api.put(`/warehouse/grn/${id}/submit-qi`);
      message.success('GRN submitted for Quality Inspection');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleComplete = async (id) => {
    try {
      await api.put(`/warehouse/grn/${id}/complete`);
      message.success('GRN completed');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/warehouse/grn/${id}`);
      message.success('GRN deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- GRN Items columns in drawer ---
  const grnItemColumns = [
    { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item',
      dataIndex: 'item_id',
      width: 200,
      render: (val, record) =>
        record.item_name ? (
          <Tooltip title={record.item_name}>
            <Text ellipsis style={{ maxWidth: 180 }}>{record.item_name}</Text>
          </Tooltip>
        ) : (
          <ItemSelector
            value={val}
            onChange={(itemId, item) => {
              updateGrnItem(record.key, 'item_id', itemId);
              if (item) {
                updateGrnItem(record.key, 'item_name', item.item_name || item.name || '');
                updateGrnItem(record.key, 'item_code', item.item_code || item.code || '');
                updateGrnItem(record.key, 'uom', item.uom || item.default_uom || '');
                updateGrnItem(record.key, 'rate', item.last_purchase_rate || item.rate || 0);
              }
            }}
            style={{ width: '100%' }}
          />
        ),
    },
    {
      title: 'Ordered', dataIndex: 'ordered_qty', width: 70, align: 'center',
      render: (val) => <Text type="secondary">{formatNumber(val || 0)}</Text>,
    },
    {
      title: 'Received', dataIndex: 'received_qty', width: 80,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateGrnItem(record.key, 'received_qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'Accepted', dataIndex: 'accepted_qty', width: 80,
      render: (val, record) => (
        <InputNumber
          min={0}
          max={record.received_qty || 0}
          value={val}
          onChange={(v) => updateGrnItem(record.key, 'accepted_qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'Rejected', dataIndex: 'rejected_qty', width: 75,
      render: (val, record) => (
        <InputNumber
          min={0}
          max={record.received_qty || 0}
          value={val}
          onChange={(v) => updateGrnItem(record.key, 'rejected_qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'Shortage', dataIndex: 'shortage_qty', width: 70, align: 'center',
      render: (val) => (
        <Text type={val > 0 ? 'warning' : 'secondary'}>{val || 0}</Text>
      ),
    },
    {
      title: 'Excess', dataIndex: 'excess_qty', width: 65, align: 'center',
      render: (val) => (
        <Text type={val > 0 ? 'danger' : 'secondary'}>{val || 0}</Text>
      ),
    },
    {
      title: 'Damaged', dataIndex: 'damaged_qty', width: 75,
      render: (val, record) => (
        <InputNumber
          min={0}
          max={record.received_qty || 0}
          value={val}
          onChange={(v) => updateGrnItem(record.key, 'damaged_qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'Batch No', dataIndex: 'batch_number', width: 100,
      render: (val, record) => (
        <Input
          value={val}
          onChange={(e) => updateGrnItem(record.key, 'batch_number', e.target.value)}
          size="small"
          placeholder="Batch"
        />
      ),
    },
    {
      title: 'Mfg Date', dataIndex: 'manufacturing_date', width: 120,
      render: (val, record) => (
        <DatePicker
          value={val ? dayjs(val) : null}
          onChange={(d) => updateGrnItem(record.key, 'manufacturing_date', d)}
          size="small"
          format={DATE_FORMAT}
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Expiry Date', dataIndex: 'expiry_date', width: 120,
      render: (val, record) => (
        <DatePicker
          value={val ? dayjs(val) : null}
          onChange={(d) => updateGrnItem(record.key, 'expiry_date', d)}
          size="small"
          format={DATE_FORMAT}
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Rate', dataIndex: 'rate', width: 90,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateGrnItem(record.key, 'rate', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'Amount', dataIndex: 'amount', width: 100, align: 'right',
      render: (val) => <Text strong style={{ fontSize: 12 }}>{formatCurrency(val)}</Text>,
    },
    {
      title: '', width: 35,
      render: (_, record) =>
        receiptType !== 'inward_based' && grnItems.length > 1 ? (
          <MinusCircleOutlined
            style={{ color: '#ff4d4f', cursor: 'pointer' }}
            onClick={() => removeGrnItemRow(record.key)}
          />
        ) : null,
    },
  ];

  // --- Main Table Columns ---
  const columns = [
    {
      title: 'GRN Number',
      dataIndex: 'grn_number',
      key: 'grn_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a onClick={() => handleView(record)}>{text}</a>
      ),
    },
    {
      title: 'Vendor',
      dataIndex: 'vendor_name',
      key: 'vendor',
      width: 180,
      ellipsis: true,
      render: (v, r) => v || r.vendor || '-',
    },
    {
      title: 'PO Reference',
      dataIndex: 'po_number',
      key: 'po_number',
      width: 140,
      render: (v) => v || '-',
    },
    {
      title: 'Inward Reference',
      dataIndex: 'inward_number',
      key: 'inward_number',
      width: 140,
      render: (v) => v || '-',
    },
    {
      title: 'Warehouse',
      dataIndex: 'warehouse_name',
      key: 'warehouse',
      width: 140,
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: 'GRN Date',
      dataIndex: 'grn_date',
      key: 'grn_date',
      width: 150,
      minWidth: 150,
      sorter: true,
      ellipsis: false,
      render: (v) => v ? formatDate(v) : '-',
    },
    {
      title: 'Supplier Invoice',
      dataIndex: 'supplier_invoice',
      key: 'supplier_invoice',
      width: 140,
      render: (v) => v || '-',
    },
    {
      title: 'Receipt Type',
      dataIndex: 'receipt_type',
      key: 'receipt_type',
      width: 110,
      render: (v) => {
        const typeMap = { inward_based: 'Inward Based', po_based: 'PO Based', direct: 'Direct', return: 'Return', transfer: 'Transfer' };
        return <Tag>{typeMap[v] || v || '-'}</Tag>;
      },
    },
    {
      title: 'Total Qty',
      dataIndex: 'total_qty',
      key: 'total_qty',
      width: 90,
      align: 'right',
      render: (v) => formatNumber(v),
    },
    {
      title: 'Accepted',
      dataIndex: 'accepted_qty',
      key: 'accepted_qty',
      width: 90,
      align: 'right',
      render: (v) => <Text style={{ color: '#52c41a' }}>{formatNumber(v)}</Text>,
    },
    {
      title: 'Rejected',
      dataIndex: 'rejected_qty',
      key: 'rejected_qty',
      width: 90,
      align: 'right',
      render: (v) => <Text style={{ color: v > 0 ? '#f5222d' : undefined }}>{formatNumber(v)}</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View Detail">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(record)} />
          </Tooltip>
          {record.status === 'draft' && (
            <>
              <Tooltip title="Submit for QI">
                <Popconfirm title="Submit this GRN for Quality Inspection?" onConfirm={() => handleSubmitForQI(record.id)}>
                  <Button type="link" size="small" icon={<ExperimentOutlined />} style={{ color: '#722ed1' }} />
                </Popconfirm>
              </Tooltip>
              <Popconfirm title="Delete this GRN?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
          {(record.status === 'pending_qi' || record.status === 'qi_in_progress') && (
            <Tooltip title="Complete GRN">
              <Popconfirm title="Mark this GRN as completed?" onConfirm={() => handleComplete(record.id)}>
                <Button type="link" size="small" icon={<CheckOutlined />} style={{ color: '#52c41a' }} />
              </Popconfirm>
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  // --- Filter Toolbar ---
  const toolbar = (
    <Space style={{ marginLeft: 12 }} wrap>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 150 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={GRN_STATUSES}
      />
      <Select
        placeholder="Vendor"
        allowClear
        showSearch
        filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
        style={{ width: 180 }}
        value={filterVendor}
        onChange={(v) => { setFilterVendor(v); setRefreshKey((k) => k + 1); }}
        options={vendors}
        onDropdownVisibleChange={(open) => { if (open && vendors.length === 0) loadLookups(); }}
      />
      <Select
        placeholder="Warehouse"
        allowClear
        showSearch
        filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
        style={{ width: 160 }}
        value={filterWarehouse}
        onChange={(v) => { setFilterWarehouse(v); setRefreshKey((k) => k + 1); }}
        options={warehouses}
        onOpenChange={(open) => { if (open && warehouses.length === 0) loadLookups(); }}
      />
      <DatePicker.RangePicker
        value={filterDateRange}
        onChange={(dates) => { setFilterDateRange(dates); setRefreshKey((k) => k + 1); }}
        format={DATE_FORMAT}
        style={{ width: 240 }}
        placeholder={['From Date', 'To Date']}
      />
    </Space>
  );

  // --- View Detail Items Columns ---
  const viewItemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
    { title: 'Item', dataIndex: 'item_name', width: 200, ellipsis: true },
    { title: 'Batch', dataIndex: 'batch_number', width: 100, render: (v) => v || '-' },
    { title: 'Ordered', dataIndex: 'ordered_qty', width: 80, align: 'right', render: (v) => formatNumber(v) },
    { title: 'Received', dataIndex: 'received_qty', width: 80, align: 'right', render: (v) => formatNumber(v) },
    {
      title: 'Accepted', dataIndex: 'accepted_qty', width: 80, align: 'right',
      render: (v) => <Text style={{ color: '#52c41a' }}>{formatNumber(v)}</Text>,
    },
    {
      title: 'Rejected', dataIndex: 'rejected_qty', width: 80, align: 'right',
      render: (v) => <Text style={{ color: v > 0 ? '#f5222d' : undefined }}>{formatNumber(v)}</Text>,
    },
    {
      title: 'Damaged', dataIndex: 'damaged_qty', width: 80, align: 'right',
      render: (v) => <Text style={{ color: v > 0 ? '#f5222d' : undefined }}>{formatNumber(v)}</Text>,
    },
    { title: 'Rate', dataIndex: 'rate', width: 100, align: 'right', render: (v) => formatCurrency(v) },
    { title: 'Amount', dataIndex: 'amount', width: 110, align: 'right', render: (v) => <Text strong>{formatCurrency(v)}</Text> },
    {
      title: 'QI Status', dataIndex: 'qi_status', width: 110,
      render: (v) => <StatusTag status={v || 'pending'} />,
    },
    {
      title: 'Putaway', dataIndex: 'putaway_status', width: 110,
      render: (v) => <StatusTag status={v || 'pending'} />,
    },
  ];

  return (
    <div>
      <PageHeader title="Goods Receipt Notes" subtitle="Manage inbound goods receipts">
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            Create GRN
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchGRNs}
        rowKey="id"
        searchPlaceholder="Search by GRN number, vendor, PO..."
        exportFileName="grn_list"
        toolbar={toolbar}
        scroll={{ x: 2000 }}
      />

      {/* --- Create / Edit Drawer --- */}
      <Drawer
        title={editingGRN ? `Edit ${editingGRN.grn_number}` : 'Create Goods Receipt Note'}
        width={1100}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setEditingGRN(null);
          form.resetFields();
          setGrnItems([]);
          setSelectedVendor(null);
          setSelectedPO(null);
          setScannerVisible(false);
        }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); setEditingGRN(null); form.resetFields(); setGrnItems([]); }}>
              Cancel
            </Button>
            <Button onClick={() => handleSubmit('draft')} loading={submitting}>
              Save as Draft
            </Button>
            <Button
              type="primary"
              icon={<ExperimentOutlined />}
              onClick={() => handleSubmit('submit_qi')}
              loading={submitting}
            >
              Submit for QI
            </Button>
          </Space>
        }
      >
        {/* Barcode Scanner Section */}
        <div style={{ marginBottom: 16 }}>
          <Button
            icon={<ScanOutlined />}
            onClick={() => setScannerVisible(!scannerVisible)}
            type={scannerVisible ? 'primary' : 'default'}
          >
            {scannerVisible ? 'Hide Scanner' : 'Barcode Scanner'}
          </Button>
          {scannerVisible && (
            <Card size="small" style={{ marginTop: 8, background: '#f6ffed', border: '1px solid #b7eb8f' }}>
              <BarcodeScanner
                onScan={handleBarcodeScan}
                placeholder="Scan item barcode to auto-add to GRN..."
                autoFocus={scannerVisible}
              />
            </Card>
          )}
        </div>

        <Form form={form} layout="vertical" requiredMark="optional">
          {/* Receipt Type */}
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item name="receipt_type" label="Receipt Type" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  options={RECEIPT_TYPES}
                  onChange={(v) => {
                    setReceiptType(v);
                    if (v !== 'inward_based') {
                      setSelectedPO(null);
                      form.setFieldsValue({ po_id: undefined });
                      setGrnItems([createEmptyItem()]);
                    }
                  }}
                />
              </Form.Item>
            </Col>
            {receiptType === 'inward_based' && (
              <Col span={8}>
                <Form.Item name="inward_id" label="Material Inward" rules={[{ required: true, message: 'Select a Material Inward' }]}>
                  <Select
                    options={inwardOptions}
                    placeholder="Search and select Material Inward..."
                    showSearch
                    optionFilterProp="label"
                    allowClear
                    onChange={handleInwardSelect}
                    onSearch={(v) => loadInwardOptions(v)}
                    loading={loadingInwards}
                  />
                </Form.Item>
              </Col>
            )}
            {receiptType === 'inward_based' && (
              <Col span={4}>
                <Form.Item name="po_number" label="PO Number">
                  <Input disabled placeholder="Auto from Inward" />
                </Form.Item>
              </Col>
            )}
            <Col span={receiptType === 'inward_based' ? 6 : 6}>
              <Form.Item name="grn_date" label="GRN Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
          </Row>

          {/* Vendor & Warehouse */}
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="vendor_id" label="Vendor" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  options={vendors}
                  placeholder="Select vendor"
                  optionFilterProp="label"
                  disabled={receiptType === 'inward_based' && !!selectedPO}
                  onChange={(vendorId) => {
                    const found = vendors.find((v) => v.value === vendorId);
                    setSelectedVendor(found ? found.vendor : null);
                  }}
                />
              </Form.Item>
            </Col>
            <Col span={4}>
              {selectedVendor && (
                <div style={{ paddingTop: 30 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    GST: {selectedVendor.gst_number || 'N/A'}
                  </Text>
                </div>
              )}
            </Col>
            <Col span={6}>
              <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  options={warehouses}
                  placeholder="Select warehouse"
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="supplier_invoice" label="Supplier Invoice No.">
                <Input placeholder="Invoice number" />
              </Form.Item>
            </Col>
          </Row>

          {/* Additional Info */}
          <Row gutter={16}>
            <Col span={6}>
              <Form.Item name="supplier_invoice_date" label="Supplier Invoice Date">
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="vehicle_number" label="Vehicle Number">
                <Input placeholder="e.g., MH12AB1234" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="lr_number" label="LR Number">
                <Input placeholder="Lorry Receipt number" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="remarks" label="Remarks">
                <Input placeholder="Any remarks" />
              </Form.Item>
            </Col>
          </Row>
        </Form>

        {/* Items Table */}
        <Divider orientation="left">
          <Space>
            <InboxOutlined />
            Items
            <Badge count={grnItems.filter((i) => i.item_id).length} style={{ backgroundColor: '#eb2f96' }} />
          </Space>
        </Divider>
        <Table
          dataSource={grnItems}
          columns={grnItemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 1650 }}
          loading={loadingPO}
          footer={() => (
            // BUG-INV-130: also surface Add Item for inward_based receipts so
            // operators can add substitute items the vendor shipped (out-of-
            // stock alternates). The backend allows extra items not on the PO
            // — the frontend was the only blocker.
            <Button type="dashed" onClick={addGrnItemRow} icon={<PlusOutlined />} block>
              {receiptType === 'inward_based' ? 'Add Substitute / Extra Item' : 'Add Item'}
            </Button>
          )}
        />

        {/* Running Totals */}
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ width: 380 }}>
            <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Col span={14}><Text>Total Received Qty:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}><Text strong>{formatNumber(calcTotalQty())}</Text></Col>
            </Row>
            <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Col span={14}><Text>Accepted Qty:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}><Text style={{ color: '#52c41a' }}>{formatNumber(calcAcceptedQty())}</Text></Col>
            </Row>
            <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Col span={14}><Text>Rejected Qty:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}><Text type="danger">{formatNumber(calcRejectedQty())}</Text></Col>
            </Row>
            <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Col span={14}><Text>Damaged Qty:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}><Text type="danger">{formatNumber(calcDamagedQty())}</Text></Col>
            </Row>
            <Row style={{ padding: '8px 0', background: '#fafafa', borderRadius: 4, marginTop: 4 }}>
              <Col span={14}><Text strong style={{ fontSize: 16 }}>Total Amount:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}>
                <Text strong style={{ fontSize: 16, color: '#eb2f96' }}>{formatCurrency(calcTotalAmount())}</Text>
              </Col>
            </Row>
          </div>
        </div>
      </Drawer>

      {/* --- View Detail Modal --- */}
      <Modal
        title={viewData ? `GRN Detail: ${viewData.grn_number}` : 'GRN Detail'}
        open={viewModalOpen}
        onCancel={() => { setViewModalOpen(false); setViewData(null); }}
        footer={
          viewData && (
            <Space>
              {viewData.status === 'draft' && (
                <Popconfirm title="Submit for Quality Inspection?" onConfirm={async () => { await handleSubmitForQI(viewData.id); setViewModalOpen(false); }}>
                  <Button type="primary" icon={<ExperimentOutlined />}>Submit for QI</Button>
                </Popconfirm>
              )}
              {(viewData.status === 'pending_qi' || viewData.status === 'qi_in_progress') && (
                <Popconfirm title="Complete this GRN?" onConfirm={async () => { await handleComplete(viewData.id); setViewModalOpen(false); }}>
                  <Button type="primary" icon={<CheckOutlined />}>Complete</Button>
                </Popconfirm>
              )}
              <Button icon={<PrinterOutlined />} onClick={handlePrintGrn}>Print</Button>
              <Button onClick={() => { setViewModalOpen(false); setViewData(null); }}>Close</Button>
            </Space>
          )
        }
        width={1000}
        loading={viewLoading}
      >
        {viewData && (
          <>
            <Descriptions bordered size="small" column={3} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="GRN Number">{viewData.grn_number}</Descriptions.Item>
              <Descriptions.Item label="Status"><StatusTag status={viewData.status} /></Descriptions.Item>
              <Descriptions.Item label="Receipt Type">
                <Tag>{viewData.receipt_type?.replace(/_/g, ' ').toUpperCase() || '-'}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Vendor">{viewData.vendor_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="PO Reference">{viewData.po_number || '-'}</Descriptions.Item>
              <Descriptions.Item label="Inward Reference">{viewData.inward_number || '-'}</Descriptions.Item>
              <Descriptions.Item label="Warehouse">{viewData.warehouse_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="GRN Date">{formatDate(viewData.grn_date)}</Descriptions.Item>
              <Descriptions.Item label="Supplier Invoice">{viewData.supplier_invoice || '-'}</Descriptions.Item>
              <Descriptions.Item label="Supplier Invoice Date">{formatDate(viewData.supplier_invoice_date)}</Descriptions.Item>
              <Descriptions.Item label="Vehicle">{viewData.vehicle_number || '-'}</Descriptions.Item>
              <Descriptions.Item label="LR Number">{viewData.lr_number || '-'}</Descriptions.Item>
              <Descriptions.Item label="Total Amount"><Text strong>{formatCurrency(viewData.total_amount)}</Text></Descriptions.Item>
            </Descriptions>

            {/* Summary Cards */}
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={6}>
                <Card size="small" style={{ textAlign: 'center' }}>
                  <Text type="secondary">Total Qty</Text>
                  <div><Text strong style={{ fontSize: 20 }}>{formatNumber(viewData.total_qty)}</Text></div>
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small" style={{ textAlign: 'center', borderColor: '#52c41a' }}>
                  <Text type="secondary">Accepted</Text>
                  <div><Text strong style={{ fontSize: 20, color: '#52c41a' }}>{formatNumber(viewData.accepted_qty)}</Text></div>
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small" style={{ textAlign: 'center', borderColor: '#f5222d' }}>
                  <Text type="secondary">Rejected</Text>
                  <div><Text strong style={{ fontSize: 20, color: '#f5222d' }}>{formatNumber(viewData.rejected_qty)}</Text></div>
                </Card>
              </Col>
              <Col span={6}>
                <Card size="small" style={{ textAlign: 'center', borderColor: '#fa8c16' }}>
                  <Text type="secondary">Damaged</Text>
                  <div><Text strong style={{ fontSize: 20, color: '#fa8c16' }}>{formatNumber(viewData.damaged_qty)}</Text></div>
                </Card>
              </Col>
            </Row>

            <Divider orientation="left">Items</Divider>
            <Table
              dataSource={viewData.items || []}
              columns={viewItemColumns}
              rowKey="id"
              pagination={false}
              size="small"
              scroll={{ x: 1200 }}
            />

            {viewData.grn_number && (
              <div style={{ marginTop: 16, textAlign: 'center' }}>
                <BarcodeDisplay value={viewData.grn_number} label="GRN Barcode" height={60} />
              </div>
            )}
          </>
        )}
      </Modal>

      <div style={{ display: 'none' }}>
        <PurchaseReceiptPrint ref={printRef} data={viewData} />
      </div>
    </div>
  );
};

export default GRN;

