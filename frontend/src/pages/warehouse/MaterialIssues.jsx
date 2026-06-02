import React, { useState, useCallback, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Modal,
  Divider, Typography, Tooltip, Tag, Badge,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  CheckOutlined, MinusCircleOutlined, InboxOutlined,
  SendOutlined, FileDoneOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import SerialNumbersModal from '../../components/SerialNumbersModal';
import api from '../../config/api';
import {
  formatDate, formatCurrency, formatNumber, getErrorMessage,
  formatDateForAPI,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const MI_STATUSES = [
  { label: 'Draft', value: 'draft' },
  { label: 'Issued', value: 'issued' },
  { label: 'Dispatched', value: 'dispatched' },
  { label: 'Acknowledged', value: 'acknowledged' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const MaterialIssues = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [viewData, setViewData] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [editingRecord, setEditingRecord] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);
  const [filterDepartment, setFilterDepartment] = useState(undefined);

  // Drawer state
  const [issueItems, setIssueItems] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [allWarehouses, setAllWarehouses] = useState([]);
  const [indentOptions, setIndentOptions] = useState([]);
  const [mrOptions, setMrOptions] = useState([]);
  const [uomOptions, setUomOptions] = useState([]);
  const [userOptions, setUserOptions] = useState([]);
  // item_id -> available qty (in the currently-selected warehouse). Populated
  // when an indent is picked or when the warehouse changes; surfaces inline so
  // the store keeper sees how much they can actually issue per line.
  const [stockMap, setStockMap] = useState({});
  // item_id -> { batches: [{id, batch_number, expiry_date}], bins: [{id, code}] }
  // Populated when an item is selected to allow batch/bin dropdown selection
  const [itemStockDetails, setItemStockDetails] = useState({});

  // --- Lookups ---
  const loadLookups = useCallback(async () => {
    try {
      const [whRes, allWhRes, uomRes, userRes] = await Promise.allSettled([
        api.get('/masters/warehouses', { params: { page_size: 200, exclude_virtual: true } }),
        api.get('/masters/warehouses', { params: { page_size: 200 } }),
        api.get('/masters/uom', { params: { page_size: 200 } }),
        // Bug fix BUG_0064: was calling /settings/users (admin-only) → 403 →
        // empty IssuedTo dropdown for non-admin users. /users/lookup is open
        // to all authenticated users.
        api.get('/users/lookup', { params: { page_size: 200 } }),
      ]);
      if (whRes.status === 'fulfilled') {
        const w = whRes.value.data;
        setWarehouses(
          (w.items || w.data || w || []).map((i) => ({
            label: i.name || i.warehouse_name,
            value: i.id,
          }))
        );
      }
      if (allWhRes.status === 'fulfilled') {
        const w = allWhRes.value.data;
        setAllWarehouses(
          (w.items || w.data || w || []).map((i) => ({
            label: i.name || i.warehouse_name,
            value: i.id,
          }))
        );
      }
      if (uomRes.status === 'fulfilled') {
        const u = uomRes.value.data;
        setUomOptions(
          (u.items || u.data || u || []).map((i) => ({
            label: i.name || i.uom_name || i.code,
            value: i.id,
          }))
        );
      }
      if (userRes.status === 'fulfilled') {
        const u = userRes.value.data;
        setUserOptions(
          (u.items || u.data || u || []).map((i) => ({
            label: i.full_name || i.name || i.username || i.email,
            value: i.id,
          }))
        );
      }
    } catch (err) {
      console.error('Error loading lookups:', err);
    }
  }, []);

  const loadIndentOptions = useCallback(async (search = '') => {
    try {
      const warehouseId = form.getFieldValue('warehouse_id');
      const params = { page_size: 50, search, available_for_issue: true };
      if (warehouseId) {
        params.warehouse_id = warehouseId;
      }
      // Backend filter `available_for_issue=true` covers
      // approved + partially_fulfilled AND drops indents fully issued
      // already, so the same indent can't be picked twice.
      const res = await api.get('/indent/indents', { params });
      const data = res.data;
      const items = data.items || data.data || data || [];
      const newOptions = items.map((ind) => ({
        label: `${ind.indent_number}${ind.warehouse_name ? ` · ${ind.warehouse_name}` : ''}${ind.raised_by_name ? ` · ${ind.raised_by_name}` : ''}`,
        value: ind.id,
      }));

      // Keep the currently selected indent option if it's not in the returned list
      const currentVal = form.getFieldValue('indent_id');
      if (currentVal) {
        setIndentOptions((prev) => {
          const selectedOpt = prev.find((o) => o.value === currentVal);
          if (selectedOpt && !newOptions.some((o) => o.value === currentVal)) {
            return [selectedOpt, ...newOptions];
          }
          return newOptions;
        });
      } else {
        setIndentOptions(newOptions);
      }
    } catch (err) {
      console.error('Error loading indent options:', err);
    }
  }, [form]);

  // Fetch available qty per item for the given warehouse and update stockMap.
  // Used after an indent is picked (so the operator sees stock-vs-requested
  // before saving) and when warehouse changes.
  const refreshStockForItems = useCallback(async (warehouseId, itemIds) => {
    if (!warehouseId || !itemIds || itemIds.length === 0) {
      setStockMap({});
      return;
    }
    try {
      // /inventory/stock-balance returns rows per (item, batch). Sum batch
      // qtys per item so the row shows the total available across batches.
      const res = await api.get('/inventory/stock-balance', {
        params: {
          warehouse_id: warehouseId,
          item_id: itemIds.join(','),
          page_size: 200,
        },
      });
      const rows = res.data?.items || res.data?.data || res.data || [];
      if (!Array.isArray(rows)) {
        setStockMap({});
        return;
      }
      const map = {};
      rows.forEach((r) => {
        const k = r.item_id;
        // BUG-ISS-009: use item_code as an optional secondary key if id is missing
        const key = k || r.item_code;
        if (key) {
          map[key] = (map[key] || 0) + (Number(r.available_qty) || 0);
        }
      });
      setStockMap(map);
    } catch {
      setStockMap({});
    }
  }, []);

  // Fetch batch and bin details for a specific item in a warehouse.
  // Called when an item is selected to populate batch/bin dropdowns.
  const fetchItemStockDetails = useCallback(async (warehouseId, itemId) => {
    if (!warehouseId || !itemId) return;
    try {
      // Use the newly updated Stock Balance API that returns batch_number and bin_code
      const res = await api.get('/inventory/stock-balance', {
        params: {
          warehouse_id: warehouseId,
          item_id: String(itemId),
          show_zero_stock: false, // Only show what we can actually issue
          page_size: 200,
        },
      });
      const rows = res.data?.items || res.data?.data || res.data || [];
      if (!Array.isArray(rows)) return;

      const batchMap = new Map();
      const binMap = new Map();
      
      rows.forEach((r) => {
        // Collect Batch Info
        const bid = r.batch_id;
        const bName = r.batch_number || r.batch_name || (bid ? `Batch ${bid}` : 'No Batch');
        const bidKey = bid === null ? 'null_batch' : bid;
        if (!batchMap.has(bidKey)) {
          batchMap.set(bidKey, {
            id: bid,
            batch_number: bName,
            expiry_date: r.expiry_date,
            qty: Number(r.available_qty) || 0,
          });
        } else {
          batchMap.get(bidKey).qty += Number(r.available_qty) || 0;
        }

        // Collect Bin Info
        const bnid = r.bin_id;
        const bCode = r.bin_code || r.bin_name || (bnid ? `Bin ${bnid}` : 'General Area');
        const bnidKey = bnid === null ? 'null_bin' : bnid;
        if (!binMap.has(bnidKey)) {
          binMap.set(bnidKey, {
            id: bnid,
            code: bCode,
            qty: Number(r.available_qty) || 0,
          });
        } else {
          binMap.get(bnidKey).qty += Number(r.available_qty) || 0;
        }
      });

      const batches = Array.from(batchMap.values());
      const bins = Array.from(binMap.values());

      const serialsMap = {};
      let itemHasSerial = false;
      rows.forEach((r) => {
        if (r.has_serial) {
          itemHasSerial = true;
        }
        const key = `${r.batch_id || 'null'}-${r.bin_id || 'null'}`;
        if (Array.isArray(r.serial_numbers)) {
          serialsMap[key] = r.serial_numbers;
        }
      });

      setItemStockDetails((prev) => ({
        ...prev,
        [itemId]: { batches, bins, serialsMap, hasSerial: itemHasSerial },
      }));

      if (itemHasSerial) {
        setIssueItems((prev) =>
          prev.map((it) => (it.item_id === itemId ? { ...it, has_serial: true } : it))
        );
      }

      // Auto-select if there is only one option to save user clicks
      const currentItems = form.getFieldValue('items') || [];
      const hasUpdates = currentItems.some(it => 
        it.item_id === itemId && 
        ((batches.length === 1 && !it.batch_id) || (bins.length === 1 && !it.bin_id))
      );

      if (hasUpdates) {
        const newData = currentItems.map((it) => {
          if (it.item_id === itemId) {
            return {
              ...it,
              batch_id: (batches.length === 1 && !it.batch_id) ? batches[0].id : it.batch_id,
              bin_id: (bins.length === 1 && !it.bin_id) ? bins[0].id : it.bin_id,
            };
          }
          return it;
        });
        form.setFieldsValue({ items: newData });
      }
    } catch (err) {
      console.error('Failed to fetch stock details:', err);
    }
  }, [form]);

  // When an indent is chosen, replace the items table with that indent's
  // approved lines (qty = approved - already_issued so re-issuing partial
  // fulfilment works). Also lock the warehouse to the indent's warehouse.
  const prefillFromIndent = useCallback(async (indentId) => {
    if (!indentId) {
      setStockMap({});
      form.setFieldsValue({
        destination_warehouse_id: undefined,
        issued_to: undefined,
      });
      return;
    }
    try {
      const res = await api.get(`/indent/indents/${indentId}`);
      const ind = res.data;
      if (!ind) return;

      // Inject this option into indentOptions so the select can render its human label
      const optionLabel = `${ind.indent_number}${ind.warehouse_name ? ` · ${ind.warehouse_name}` : ''}${ind.raised_by_name ? ` · ${ind.raised_by_name}` : ''}`;
      const newOption = { label: optionLabel, value: ind.id };
      setIndentOptions((prev) => {
        if (prev.some((opt) => opt.value === ind.id)) return prev;
        return [newOption, ...prev];
      });
      // 2026-05-06: vehicle model — if the indent's destination is a
      // virtual warehouse (vehicle / mobile unit), the Material Issue
      // SOURCE must be a real warehouse (where stock lives). Fall back
      // to the first real warehouse the user has access to.
      let sourceWarehouseId = ind.warehouse_id;
      try {
        const whRes = await api.get('/masters/warehouses', { params: { page_size: 200 } });
        const whList = Array.isArray(whRes.data) ? whRes.data : (whRes.data?.items || []);
        const indentWh = whList.find((w) => w.id === ind.warehouse_id);
        const isVirtual = indentWh && indentWh.type === 'virtual';
        if (isVirtual) {
          const realWh = whList.find((w) => w.type === 'main' || w.type === 'regional');
          if (realWh) sourceWarehouseId = realWh.id;
        }
      } catch { /* fall back to indent's warehouse */ }
      form.setFieldsValue({
        warehouse_id: sourceWarehouseId,
        destination_warehouse_id: ind.warehouse_id,
        department: ind.department || form.getFieldValue('department'),
        issued_to: ind.raised_by || form.getFieldValue('issued_to'),
      });
      const lines = (ind.items || []).map((it) => ({
        key: `${it.id}-${Date.now()}-${Math.random()}`,
        item_id: it.item_id,
        item_name: it.item_name || it.name || '',
        item_code: it.item_code || '',
        uom_id: it.uom_id || null,
        qty: Math.max(
          Number(
            it.issue_remaining_qty ?? (
              (Number(it.approved_qty ?? it.requested_qty) || 0)
                - (Number(it.issued_qty) || 0)
            ),
          ) || 0,
          0,
        ),
        batch_id: null,
        bin_id: null,
        rate: Number(it.rate) || Number(it.purchase_price) || 0,
        amount: 0,
        has_batch: !!it.has_batch,
        has_serial: !!it.has_serial,
        serial_numbers: [],
      }));
      setIssueItems(lines.length > 0 ? lines : [createEmptyItem()]);
      const itemIds = lines.map((l) => l.item_id).filter(Boolean);
      // Stock lookup uses the SOURCE warehouse (real one), not the indent's
      // destination vehicle.
      await refreshStockForItems(sourceWarehouseId, itemIds);
      // Fetch batch/bin details for all indent items
      itemIds.forEach((id) => fetchItemStockDetails(sourceWarehouseId, id));
      message.success(
        `Loaded ${lines.length} line${lines.length === 1 ? '' : 's'} from ${ind.indent_number}`,
      );
    } catch (err) {
      message.error(getErrorMessage(err) || 'Could not load indent');
    }
  }, [form, refreshStockForItems, fetchItemStockDetails]);

  const loadMROptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/procurement/material-requests', {
        params: { page_size: 50, search },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setMrOptions(
        items.map((mr) => ({
          label: `${mr.mr_number} - ${mr.department || ''}`,
          value: mr.id,
        }))
      );
    } catch (err) {
      console.error('Error loading MR options:', err);
    }
  }, []);

  // --- Fetch ---
  const fetchRecords = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      if (filterDepartment) qp.department = filterDepartment;
      return await api.get('/warehouse/material-issues', { params: qp });
    },
    [filterStatus, filterWarehouse, filterDepartment]
  );

  // --- Item Row ---
  const createEmptyItem = () => ({
    key: Date.now() + Math.random(),
    item_id: null,
    item_name: '',
    item_code: '',
    uom_id: null,
    qty: 0,
    batch_id: null,
    bin_id: null,
    rate: 0,
    amount: 0,
    has_batch: false,
    has_serial: false,
    serial_numbers: [],
  });

  const recalcItem = (item) => {
    item.amount = Number(((item.qty || 0) * (item.rate || 0)).toFixed(2));
    return item;
  };

  const updateIssueItem = (key, field, value) => {
    setIssueItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        const updated = { ...item, [field]: value };
        return recalcItem(updated);
      })
    );
  };

  const addItemRow = () => {
    setIssueItems((prev) => [...prev, createEmptyItem()]);
  };

  const removeItemRow = (key) => {
    setIssueItems((prev) => prev.filter((i) => i.key !== key));
  };

  // --- Totals ---
  const calcTotalQty = () => issueItems.reduce((s, i) => s + (i.qty || 0), 0);
  const calcTotalAmount = () => issueItems.reduce((s, i) => s + (i.amount || 0), 0);

  // --- Open Drawer ---
  const handleAdd = () => {
    setEditingRecord(null);
    form.resetFields();
    form.setFieldsValue({
      issue_date: dayjs(),
    });
    setIssueItems([createEmptyItem()]);
    setStockMap({});
    setItemStockDetails({});
    loadLookups();
    loadIndentOptions();
    loadMROptions();
    setDrawerOpen(true);
  };

  // Deep-link entry: when the URL has ?indent_id=NN (set by the "Issue
  // Materials" button on the Indents page), open the drawer with that indent
  // pre-selected and auto-loaded. Strip the query param after consuming so a
  // back-nav doesn't keep re-opening the drawer.
  useEffect(() => {
    const indentId = searchParams.get('indent_id');
    if (!indentId) return;
    setEditingRecord(null);
    form.resetFields();
    form.setFieldsValue({
      issue_date: dayjs(),
      indent_id: Number(indentId),
    });
    setIssueItems([createEmptyItem()]);
    setStockMap({});
    setItemStockDetails({});
    loadLookups();
    loadIndentOptions();
    loadMROptions();
    setDrawerOpen(true);
    prefillFromIndent(Number(indentId));
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- View Detail ---
  const handleView = async (record) => {
    setViewLoading(true);
    setViewModalOpen(true);
    try {
      const res = await api.get(`/warehouse/material-issues/${record.id}`);
      setViewData(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
      setViewModalOpen(false);
    } finally {
      setViewLoading(false);
    }
  };

  // --- Edit ---
  const handleEdit = async (record) => {
    setEditingRecord(record);
    loadLookups();
    loadIndentOptions();
    loadMROptions();
    try {
      const res = await api.get(`/warehouse/material-issues/${record.id}`);
      const data = res.data;
      form.setFieldsValue({
        warehouse_id: data.warehouse_id,
        destination_warehouse_id: data.destination_warehouse_id,
        indent_id: data.indent_id,
        mr_id: data.mr_id,
        department: data.department,
        issued_to: data.issued_to,
        issue_date: data.issue_date ? dayjs(data.issue_date) : null,
        cost_center: data.cost_center,
        remarks: data.remarks,
      });
      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_name: item.item_name || '',
        item_code: item.item_code || '',
        uom_id: item.uom_id,
        qty: Number(item.qty || 0),
        batch_id: item.batch_id || null,
        bin_id: item.bin_id || null,
        rate: Number(item.rate || 0),
        amount: Number(item.amount || 0),
        has_batch: !!item.has_batch,
        has_serial: !!item.has_serial,
        serial_numbers: item.serial_numbers || [],
      }));
      setIssueItems(items.length > 0 ? items : [createEmptyItem()]);
      // Fetch batch/bin details for all loaded items
      const warehouseId = data.warehouse_id;
      if (warehouseId) {
        items.forEach((it) => {
          if (it.item_id) {
            fetchItemStockDetails(warehouseId, it.item_id);
          }
        });
      }
      setDrawerOpen(true);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Submit ---
  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const validItems = issueItems.filter((i) => i.item_id && i.qty > 0);
      if (validItems.length === 0) {
        message.error('Please add at least one item with quantity');
        return;
      }
      const itemsWithoutUOM = validItems.filter((i) => !i.uom_id);
      if (itemsWithoutUOM.length > 0) {
        message.error('UOM is required for all items — please select each item from the lookup');
        return;
      }

      // Validate serial numbers count for serial-tracked items
      const invalidSerials = validItems.filter(
        (i) => i.has_serial && (!i.serial_numbers || i.serial_numbers.length !== Math.round(Number(i.qty)))
      );
      if (invalidSerials.length > 0) {
        message.error('For serial-tracked items, selected serial numbers count must equal the quantity');
        return;
      }

      setSubmitting(true);

      const payload = {
        ...values,
        issue_date: formatDateForAPI(values.issue_date),
        items: validItems.map((item) => ({
          item_id: item.item_id,
          qty: item.qty,
          uom_id: item.uom_id,
          batch_id: item.batch_id || null,
          bin_id: item.bin_id || null,
          rate: item.rate,
          serial_numbers: item.has_serial ? item.serial_numbers : null,
        })),
      };

      if (editingRecord) {
        await api.put(`/warehouse/material-issues/${editingRecord.id}`, payload);
        message.success('Material Issue updated successfully');
      } else {
        await api.post('/warehouse/material-issues', payload);
        message.success('Material Issue created successfully');
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingRecord(null);
      setIssueItems([]);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // --- Actions ---
  const handleIssue = async (id) => {
    try {
      await api.post(`/warehouse/material-issues/${id}/issue`);
      message.success('Material issued successfully, stock reserved');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleDispatch = async (id) => {
    try {
      await api.post(`/warehouse/material-issues/${id}/dispatch`);
      message.success('Material issue dispatched successfully, stock deducted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleAcknowledge = async (id) => {
    try {
      await api.post(`/warehouse/material-issues/${id}/acknowledge`);
      message.success('Material issue acknowledged');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/warehouse/material-issues/${id}`);
      message.success('Material Issue deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Item Columns in Drawer ---
  const issueItemColumns = [
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
              updateIssueItem(record.key, 'item_id', itemId);
              if (item) {
                updateIssueItem(record.key, 'item_name', item.item_name || item.name || '');
                updateIssueItem(record.key, 'item_code', item.item_code || item.code || '');
                updateIssueItem(record.key, 'rate', item.last_purchase_rate || item.rate || 0);
                // Auto-fill UOM from the item master so the row can be
                // saved without manually picking it. Backend requires uom_id.
                updateIssueItem(record.key, 'uom_id', item.primary_uom_id || item.uom_id || null);
                updateIssueItem(record.key, 'has_batch', !!item.has_batch);
                updateIssueItem(record.key, 'has_serial', !!item.has_serial);
                updateIssueItem(record.key, 'serial_numbers', []);
                // Reset batch/bin when item changes
                updateIssueItem(record.key, 'batch_id', null);
                updateIssueItem(record.key, 'bin_id', null);
                // Fetch available batches and bins for this item
                const warehouseId = form.getFieldValue('warehouse_id');
                if (warehouseId && itemId) {
                  refreshStockForItems(warehouseId, [itemId]);
                  fetchItemStockDetails(warehouseId, itemId);
                }
              }
            }}
            style={{ width: '100%' }}
          />
        ),
    },
    {
      title: 'Qty', dataIndex: 'qty', width: 120,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateIssueItem(record.key, 'qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
          status={
            // Highlight when issuing more than what's on hand so the operator
            // sees the shortfall before they save (backend will reject anyway).
            record.item_id && stockMap[record.item_id] != null && (val || 0) > stockMap[record.item_id]
              ? 'error'
              : ''
          }
        />
      ),
    },
    {
      title: 'Available',
      dataIndex: 'item_id',
      width: 90,
      render: (itemId) => {
        if (!itemId) return <Text type="secondary">—</Text>;
        const avail = stockMap[itemId];
        if (avail == null) return <Text type="secondary">—</Text>;
        return (
          <Text strong style={{ color: avail > 0 ? '#2E7D52' : '#D80048' }}>
            {formatNumber(avail)}
          </Text>
        );
      },
    },
    {
      title: 'UOM', dataIndex: 'uom_id', width: 110,
      render: (val, record) => (
        <Select
          value={val}
          onChange={(v) => updateIssueItem(record.key, 'uom_id', v)}
          options={uomOptions}
          placeholder="UOM"
          size="small"
          style={{ width: '100%' }}
          showSearch
          optionFilterProp="label"
        />
      ),
    },
    {
      title: 'Batch No.', dataIndex: 'batch_id', width: 200,
      render: (val, record) => {
        const warehouseId = form.getFieldValue('warehouse_id');
        const details = itemStockDetails[record.item_id] || { batches: [], bins: [] };
        // If no item selected or no warehouse, show disabled placeholder
        if (!record.item_id || !warehouseId) {
          return (
            <Select
              value={val}
              disabled
              placeholder={!record.item_id ? 'Select item first' : 'Select warehouse'}
              size="small"
              style={{ width: '100%' }}
            />
          );
        }
        // If item does not require batch tracking per master data,
        // BUT we found batches in stock, allow selecting them anyway to 
        // prevent "Insufficient stock" errors on legacy/inconsistent data.
        if (!record.has_batch && details.batches.length === 0) {
          return (
            <Select
              value={val}
              disabled
              placeholder="Not required"
              size="small"
              style={{ width: '100%' }}
            />
          );
        }
        
        // If item has batch tracking but no batches available in stock
        if (record.has_batch && details.batches.length === 0) {
          return (
            <Select
              value={val}
              disabled
              placeholder="No batches in stock"
              size="small"
              style={{ width: '100%' }}
            />
          );
        }
        return (
          <Select
            value={val === null ? '' : val}
            onChange={(v) => {
              updateIssueItem(record.key, 'batch_id', v === '' ? null : v);
              updateIssueItem(record.key, 'serial_numbers', []);
            }}
            options={details.batches.map((b) => ({
              label: `${b.batch_number}${b.expiry_date ? ` (Exp: ${b.expiry_date})` : ''} - Qty: ${formatNumber(b.qty)}`,
              value: b.id === null ? '' : b.id,
            }))}
            placeholder="Select batch"
            size="small"
            style={{ width: '100%' }}
            allowClear
            showSearch
            optionFilterProp="label"
          />
        );
      },
    },
    {
      title: 'Bin Code', dataIndex: 'bin_id', width: 160,
      render: (val, record) => {
        const warehouseId = form.getFieldValue('warehouse_id');
        const details = itemStockDetails[record.item_id] || { batches: [], bins: [] };
        if (!record.item_id || !warehouseId) {
          return (
            <Select
              value={val}
              disabled
              placeholder={!record.item_id ? 'Select item first' : 'Select warehouse'}
              size="small"
              style={{ width: '100%' }}
            />
          );
        }
        if (details.bins.length === 0) {
          return (
            <Select
              value={val}
              disabled
              placeholder="No bins available"
              size="small"
              style={{ width: '100%' }}
            />
          );
        }
        return (
          <Select
            value={val === null ? '' : val}
            onChange={(v) => {
              updateIssueItem(record.key, 'bin_id', v === '' ? null : v);
              updateIssueItem(record.key, 'serial_numbers', []);
            }}
            options={details.bins.map((b) => ({
              label: `${b.code} - Qty: ${formatNumber(b.qty)}`,
              value: b.id === null ? '' : b.id,
            }))}
            placeholder="Select bin"
            size="small"
            style={{ width: '100%' }}
            allowClear
            showSearch
            optionFilterProp="label"
          />
        );
      },
    },
    {
      title: 'Serial Numbers',
      dataIndex: 'serial_numbers',
      width: 150,
      render: (val, record) => {
        // Compute available serials based on selected batch + bin
        const details = itemStockDetails[record.item_id] || {};
        const serialsMap = details.serialsMap || {};
        const key = `${record.batch_id || 'null'}-${record.bin_id || 'null'}`;
        const availableSerials = serialsMap[key] || [];
        return (
          <SerialNumbersModal
            value={val || []}
            onChange={(updated) => updateIssueItem(record.key, 'serial_numbers', updated)}
            itemName={record.item_name}
            itemCode={record.item_code}
            quantity={Math.round(Number(record.qty || 0))}
            hasSerial={record.has_serial}
            size="small"
            mode="select"
            availableSerials={availableSerials}
          />
        );
      },
    },
    {
      title: 'Rate', dataIndex: 'rate', width: 120,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateIssueItem(record.key, 'rate', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'Amount', dataIndex: 'amount', width: 110, align: 'right',
      render: (val) => <Text strong style={{ fontSize: 12 }}>{formatCurrency(val)}</Text>,
    },
    {
      title: '', width: 35,
      render: (_, record) =>
        issueItems.length > 1 ? (
          <MinusCircleOutlined
            style={{ color: '#ff4d4f', cursor: 'pointer' }}
            onClick={() => removeItemRow(record.key)}
          />
        ) : null,
    },
  ];

  // --- Main Table Columns ---
  const columns = [
    {
      title: 'Issue Number',
      dataIndex: 'issue_number',
      key: 'issue_number',
      width: 160,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a onClick={() => handleView(record)}>{text}</a>
      ),
    },
    {
      title: 'Source Warehouse',
      dataIndex: 'warehouse_name',
      key: 'warehouse',
      width: 150,
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: 'Destination Warehouse',
      dataIndex: 'destination_warehouse_name',
      key: 'destination_warehouse',
      width: 160,
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: 'Department',
      dataIndex: 'department',
      key: 'department',
      width: 140,
      render: (v) => v || '-',
    },
    {
      title: 'Issue Date',
      dataIndex: 'issue_date',
      key: 'issue_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Issued To',
      dataIndex: 'issued_to_name',
      key: 'issued_to',
      width: 150,
      ellipsis: true,
      render: (v, r) => v || r.issued_to || '-',
    },
    {
      title: 'Cost Center',
      dataIndex: 'cost_center',
      key: 'cost_center',
      width: 130,
      render: (v) => v || '-',
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
      width: 180,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View Detail">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(record)} />
          </Tooltip>
          {record.status === 'draft' && (
            <>
              <Tooltip title="Edit">
                <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
              </Tooltip>
              <Tooltip title="Issue Material (Reserve)">
                <Popconfirm title="Issue this material? Stock will be reserved." onConfirm={() => handleIssue(record.id)}>
                  <Button type="link" size="small" icon={<SendOutlined />} style={{ color: '#eb2f96' }} />
                </Popconfirm>
              </Tooltip>
              <Popconfirm title="Delete this Material Issue?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
          {record.status === 'issued' && (
            <Tooltip title="Dispatch Material">
              <Popconfirm title="Dispatch this material? Stock will be physically deducted." onConfirm={() => handleDispatch(record.id)}>
                <Button type="link" size="small" icon={<SendOutlined />} style={{ color: '#1890ff' }} />
              </Popconfirm>
            </Tooltip>
          )}
          {record.status === 'dispatched' && (
            <Tooltip title="Acknowledge">
              <Popconfirm title="Acknowledge receipt of this material?" onConfirm={() => handleAcknowledge(record.id)}>
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
        options={MI_STATUSES}
      />
      <Select
        placeholder="Warehouse"
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ width: 160 }}
        value={filterWarehouse}
        onChange={(v) => { setFilterWarehouse(v); setRefreshKey((k) => k + 1); }}
        options={warehouses}
        onOpenChange={(open) => { if (open && warehouses.length === 0) loadLookups(); }}
      />
      <Input
        placeholder="Department"
        allowClear
        style={{ width: 150 }}
        value={filterDepartment}
        onChange={(e) => { setFilterDepartment(e.target.value || undefined); }}
        onPressEnter={() => setRefreshKey((k) => k + 1)}
      />
    </Space>
  );

  // --- View Detail Items Columns ---
  const viewItemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
    { title: 'Item', dataIndex: 'item_name', width: 200, ellipsis: true, render: (v, r) => v || r.item_code || '-' },
    { title: 'Qty', dataIndex: 'qty', width: 90, align: 'right', render: (v) => formatNumber(v) },
    { title: 'UOM', dataIndex: 'uom_name', width: 80, render: (v) => v || '-' },
    { title: 'Batch', dataIndex: 'batch_id', width: 80, render: (v) => v || '-' },
    { title: 'Bin', dataIndex: 'bin_id', width: 80, render: (v) => v || '-' },
    {
      title: 'Serial Numbers',
      dataIndex: 'serial_numbers',
      width: 150,
      render: (serials) =>
        serials && serials.length > 0 ? (
          <Tooltip title={serials.join(', ')}>
            <div style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {serials.map((s) => <Tag key={s} color="blue">{s}</Tag>)}
            </div>
          </Tooltip>
        ) : (
          '-'
        ),
    },
    { title: 'Rate', dataIndex: 'rate', width: 110, align: 'right', render: (v) => formatCurrency(v) },
    { title: 'Amount', dataIndex: 'amount', width: 120, align: 'right', render: (v) => <Text strong>{formatCurrency(v)}</Text> },
  ];

  return (
    <div>
      <PageHeader title="Material Issues" subtitle="Manage material issues from warehouse">
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            Create Issue
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchRecords}
        rowKey="id"
        searchPlaceholder="Search by issue number, department..."
        exportFileName="material_issues_list"
        toolbar={toolbar}
        scroll={{ x: 1200 }}
      />

      {/* --- Create / Edit Drawer --- */}
      <Drawer
        title={editingRecord ? `Edit ${editingRecord.issue_number}` : 'Create Material Issue'}
        width={1050}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setEditingRecord(null);
          form.resetFields();
          setIssueItems([]);
          setItemStockDetails({});
        }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); setEditingRecord(null); form.resetFields(); setIssueItems([]); setItemStockDetails({}); }}>
              Cancel
            </Button>
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={handleSubmit}
              loading={submitting}
            >
              {editingRecord ? 'Update' : 'Save'}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  options={warehouses}
                  placeholder="Select warehouse"
                  showSearch
                  optionFilterProp="label"
                  onChange={(whId) => {
                    // Re-fetch stock for the existing line items when the
                    // warehouse changes — the Available column was for the
                    // OLD warehouse otherwise.
                    const itemIds = issueItems
                      .map((l) => l.item_id)
                      .filter(Boolean);
                    refreshStockForItems(whId, itemIds);
                    // Also refresh batch/bin options for all items
                    itemIds.forEach((id) => fetchItemStockDetails(whId, id));
                    // Reset existing batch/bin selections since they are warehouse-specific
                    setIssueItems(issueItems.map(i => ({ ...i, batch_id: null, bin_id: null })));
                    // NOTE: Do NOT reset indent_id here. The user explicitly selected
                    // the indent; changing the source warehouse (e.g. from CENTRAL to
                    // another main warehouse) should not lose the indent reference.
                    // Indent options are filtered by destination warehouse, not source.
                  }}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="department" label="Department">
                <Input placeholder="Department name" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="issue_date" label="Issue Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="indent_id"
                label="Indent (auto-loads items)"
                tooltip="Pick an approved indent — warehouse + items + remaining qty are filled in for you."
              >
                <Select
                  options={indentOptions}
                  placeholder="Pick approved indent to issue against"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  onFocus={() => loadIndentOptions()}
                  onSearch={(v) => loadIndentOptions(v)}
                  onChange={(v) => prefillFromIndent(v)}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="mr_id" label="Material Request">
                <Select
                  options={mrOptions}
                  placeholder="Select MR (optional)"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  onSearch={(v) => loadMROptions(v)}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                noStyle
                shouldUpdate={(prevValues, currentValues) => prevValues.indent_id !== currentValues.indent_id}
              >
                {({ getFieldValue }) => (
                  <Form.Item name="destination_warehouse_id" label="Destination Warehouse">
                    <Select
                      options={allWarehouses}
                      placeholder="Select destination warehouse"
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      disabled={!!getFieldValue('indent_id')}
                    />
                  </Form.Item>
                )}
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="issued_to" label="Issued To">
                <Select
                  options={userOptions}
                  placeholder="Select user"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="cost_center" label="Cost Center">
                <Input placeholder="Cost center" />
              </Form.Item>
            </Col>
            <Col span={8}>
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
            <Badge count={issueItems.filter((i) => i.item_id).length} style={{ backgroundColor: '#eb2f96' }} />
          </Space>
        </Divider>
        <Table
          dataSource={issueItems}
          columns={issueItemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 1350 }}
          footer={() => (
            <Button type="dashed" onClick={addItemRow} icon={<PlusOutlined />} block>
              Add Item
            </Button>
          )}
        />

        {/* Running Totals */}
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ width: 380 }}>
            <Row style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Col span={14}><Text>Total Qty:</Text></Col>
              <Col span={10} style={{ textAlign: 'right' }}><Text strong>{formatNumber(calcTotalQty())}</Text></Col>
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
        title={viewData ? `Material Issue: ${viewData.issue_number}` : 'Material Issue Detail'}
        open={viewModalOpen}
        onCancel={() => { setViewModalOpen(false); setViewData(null); }}
        footer={
          viewData && (
            <Space>
              {viewData.status === 'draft' && (
                <Popconfirm title="Issue this material? Stock will be reserved." onConfirm={async () => { await handleIssue(viewData.id); setViewModalOpen(false); }}>
                  <Button type="primary" icon={<SendOutlined />}>Issue</Button>
                </Popconfirm>
              )}
              {viewData.status === 'issued' && (
                <Popconfirm title="Dispatch this material? Stock will be physically deducted." onConfirm={async () => { await handleDispatch(viewData.id); setViewModalOpen(false); }}>
                  <Button type="primary" icon={<SendOutlined />} style={{ background: '#1890ff', borderColor: '#1890ff' }}>Dispatch</Button>
                </Popconfirm>
              )}
              {viewData.status === 'dispatched' && (
                <Popconfirm title="Acknowledge receipt of this material?" onConfirm={async () => { await handleAcknowledge(viewData.id); setViewModalOpen(false); }}>
                  <Button type="primary" icon={<CheckOutlined />}>Acknowledge</Button>
                </Popconfirm>
              )}
              <Button onClick={() => { setViewModalOpen(false); setViewData(null); }}>Close</Button>
            </Space>
          )
        }
        width={900}
        loading={viewLoading}
      >
        {viewData && (
          <>
            <Descriptions bordered size="small" column={3} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="Issue Number">{viewData.issue_number}</Descriptions.Item>
              <Descriptions.Item label="Status"><StatusTag status={viewData.status} /></Descriptions.Item>
              <Descriptions.Item label="Issue Date">{formatDate(viewData.issue_date)}</Descriptions.Item>
              <Descriptions.Item label="Source Warehouse">{viewData.warehouse_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Destination Warehouse">{viewData.destination_warehouse_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Department">{viewData.department || '-'}</Descriptions.Item>
              <Descriptions.Item label="Issued To">{viewData.issued_to_name || viewData.issued_to || '-'}</Descriptions.Item>
              <Descriptions.Item label="MR Reference">{viewData.mr_number || viewData.mr_id || '-'}</Descriptions.Item>
              <Descriptions.Item label="Indent Reference">{viewData.indent_number || viewData.indent_id || '-'}</Descriptions.Item>
              <Descriptions.Item label="Cost Center">{viewData.cost_center || '-'}</Descriptions.Item>
              <Descriptions.Item label="Remarks" span={2}>{viewData.remarks || '-'}</Descriptions.Item>
            </Descriptions>

            <Divider orientation="left">Items</Divider>
            <Table
              dataSource={viewData.items || []}
              columns={viewItemColumns}
              rowKey="id"
              pagination={false}
              size="small"
              scroll={{ x: 800 }}
            />
          </>
        )}
      </Modal>
    </div>
  );
};

export default MaterialIssues;

