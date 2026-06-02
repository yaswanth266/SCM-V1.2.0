import React, { useState, useCallback } from 'react';
import {
  Button, Drawer, Form, Select, Space, DatePicker, Radio,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Modal,
  Divider, Typography, Tooltip, Tag, Badge, Progress, Alert, Input,
} from 'antd';
import {
  EyeOutlined, CheckOutlined, ScanOutlined,
  InboxOutlined, AimOutlined, EnvironmentOutlined,
  ClockCircleOutlined, PlayCircleOutlined, PauseOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import BarcodeScanner from '../../components/BarcodeScanner';
import SerialNumbersModal from '../../components/SerialNumbersModal';
import api from '../../config/api';
import {
  formatDate, formatNumber, getErrorMessage, formatDateTime,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { Text } = Typography;

const PUTAWAY_STATUSES = [
  { label: 'Pending', value: 'pending' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const ITEM_STATUSES = {
  pending: { color: '#fa8c16', label: 'Pending' },
  in_progress: { color: '#eb2f96', label: 'In Progress' },
  done: { color: '#52c41a', label: 'Done' },
  skipped: { color: '#8c8c8c', label: 'Skipped' },
};

const Putaway = () => {
  const [viewDrawerOpen, setViewDrawerOpen] = useState(false);
  const [viewData, setViewData] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [scannerActive, setScannerActive] = useState(false);
  const [activeScanItemKey, setActiveScanItemKey] = useState(null);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);
  const [warehouses, setWarehouses] = useState([]);

  // Putaway items (editable in detail view)
  const [putawayItems, setPutawayItems] = useState([]);
  const [putawayType, setPutawayType] = useState('system_directed');
  const [submitting, setSubmitting] = useState(false);

  // --- Load Warehouses ---
  const loadWarehouses = useCallback(async () => {
    try {
      const res = await api.get('/masters/warehouses', { params: { page_size: 200 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setWarehouses(items.map((w) => ({ label: w.name || w.warehouse_name, value: w.id })));
    } catch {
      // silent
    }
  }, []);

  // --- Fetch Putaways ---
  const fetchPutaways = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      return await api.get('/warehouse/putaways', { params: qp });
    },
    [filterStatus, filterWarehouse]
  );

  // --- View Detail ---
  const handleView = async (record) => {
    setViewLoading(true);
    setViewDrawerOpen(true);
    setScannerActive(false);
    setActiveScanItemKey(null);
    try {
      const res = await api.get(`/warehouse/putaways/${record.id}`);
      const data = res.data;
      setViewData(data);
      setPutawayType(data.putaway_type || 'system_directed');

      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        id: item.id,
        item_id: item.item_id,
        item_name: item.item_name || '',
        item_code: item.item_code || '',
        qty: item.qty || item.quantity || 0,
        batch_number: item.batch_number || '',
        suggested_bin: item.suggested_bin || '',
        suggested_bin_id: item.suggested_bin_id || null,
        actual_bin: item.actual_bin || item.suggested_bin || '',
        actual_bin_id: item.actual_bin_id || item.suggested_bin_id || null,
        status: item.status || 'pending',
        scanned_at: item.scanned_at || null,
        scan_confirmed: !!item.scanned_at,
        has_serial: item.has_serial || false,
        serial_numbers: item.serial_numbers || [],
      }));
      setPutawayItems(items);
    } catch (err) {
      message.error(getErrorMessage(err));
      setViewDrawerOpen(false);
    } finally {
      setViewLoading(false);
    }
  };

  // --- Update Item Bin ---
  // Keep typed bin text in actual_bin_id until the backend resolves or creates
  // the matching warehouse bin. Existing numeric selections still work.
  const updatePutawayItemBin = (key, binValue) => {
    const trimmedValue = typeof binValue === 'string' ? binValue.trim() : binValue;
    const match = typeof trimmedValue === 'string' ? trimmedValue.match(/^bin-(\d+)$/) : null;
    const resolvedValue = match ? parseInt(match[1], 10) : trimmedValue || null;
    setPutawayItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        return { ...item, actual_bin: trimmedValue || '', actual_bin_id: resolvedValue };
      })
    );
    if (viewData) {
      setViewData((prev) => ({
        ...prev,
        items: (prev?.items || []).map((i) =>
          i.key === key ? { ...i, actual_bin: trimmedValue || '', actual_bin_id: resolvedValue } : i
        ),
      }));
    }
  };

  // --- Update Item Batch Number ---
  const updatePutawayItemBatch = (key, batchNumber) => {
    setPutawayItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        return { ...item, batch_number: batchNumber };
      })
    );
  };

  // --- Scan to Confirm ---
  const handleScanConfirm = async (itemKey, scanResult) => {
    const item = putawayItems.find((i) => i.key === itemKey);
    if (!item) return;

    const scannedValue = scanResult.value;
    const timestamp = scanResult.timestamp;

    // Validate scan matches item code or barcode
    const matchesItem = (
      scannedValue === item.item_code ||
      scannedValue === item.item_name ||
      scannedValue === item.batch_number ||
      scannedValue.includes(item.item_code)
    );

    if (!matchesItem) {
      message.error(`Scanned barcode "${scannedValue}" does not match item "${item.item_code || item.item_name}". Please scan the correct item.`);
      return;
    }

    if (item.has_serial) {
      const needed = parseInt(item.qty || 0, 10);
      const filled = (item.serial_numbers || []).filter(s => s && s.trim()).length;
      if (filled !== needed) {
        message.error(`Item "${item.item_name}" requires ${needed} serial numbers. Please fill them in the table before scanning to confirm.`);
        return;
      }
    }

    try {
      await api.put(`/warehouse/putaways/${viewData.id}/items/${item.id}/confirm`, {
        actual_bin_id: item.actual_bin_id,
        scanned_at: timestamp,
        barcode: scannedValue,
        serial_numbers: item.serial_numbers || [],
      });

      setPutawayItems((prev) =>
        prev.map((i) => {
          if (i.key !== itemKey) return i;
          return { ...i, status: 'done', scanned_at: timestamp, scan_confirmed: true };
        })
      );
      message.success(`Item "${item.item_name}" confirmed at bin`);

      // Check if all items are done
      const updatedItems = putawayItems.map((i) =>
        i.key === itemKey ? { ...i, status: 'done' } : i
      );
      const allDone = updatedItems.every((i) => i.status === 'done' || i.status === 'skipped');
      if (allDone) {
        message.success('All items confirmed! Putaway auto-completed.');
        try {
          await api.put(`/warehouse/putaways/${viewData.id}/complete`);
          setViewData((prev) => prev ? { ...prev, status: 'completed', completed_at: new Date().toISOString() } : prev);
          setRefreshKey((k) => k + 1);
        } catch {
          // silent - the above action per-item might have already completed it
        }
      }

      setActiveScanItemKey(null);
      setScannerActive(false);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Batch scan mode ---
  const handleBatchScan = async (scanResult) => {
    const scannedValue = scanResult.value;
    const timestamp = scanResult.timestamp;

    // Find first pending item that matches
    const matchingItem = putawayItems.find(
      (i) =>
        (i.status === 'pending' || i.status === 'in_progress') &&
        (scannedValue === i.item_code ||
          scannedValue === i.batch_number ||
          scannedValue.includes(i.item_code || ''))
    );

    if (!matchingItem) {
      message.warning(`No pending item found matching barcode: ${scannedValue}`);
      return;
    }

    if (matchingItem.has_serial) {
      const needed = parseInt(matchingItem.qty || 0, 10);
      const filled = (matchingItem.serial_numbers || []).filter(s => s && s.trim()).length;
      if (filled !== needed) {
        message.warning(`Item "${matchingItem.item_name}" requires ${needed} serial numbers. Please enter them in the table before scanning to confirm.`);
        return;
      }
    }

    try {
      await api.put(`/warehouse/putaways/${viewData.id}/items/${matchingItem.id}/confirm`, {
        actual_bin_id: matchingItem.actual_bin_id,
        scanned_at: timestamp,
        barcode: scannedValue,
        serial_numbers: matchingItem.serial_numbers || [],
      });

      setPutawayItems((prev) => {
        const updated = prev.map((i) => {
          if (i.key !== matchingItem.key) return i;
          return { ...i, status: 'done', scanned_at: timestamp, scan_confirmed: true };
        });

        // Auto-complete if all done
        const allDone = updated.every((i) => i.status === 'done' || i.status === 'skipped');
        if (allDone) {
          message.success('All items confirmed! Putaway auto-completed.');
          api.put(`/warehouse/putaways/${viewData.id}/complete`).then(() => {
            setViewData((prev) => prev ? { ...prev, status: 'completed', completed_at: new Date().toISOString() } : prev);
            setRefreshKey((k) => k + 1);
          }).catch(() => {});
        }

        return updated;
      });

      message.success(`Confirmed: ${matchingItem.item_name}`);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Skip Item ---
  const handleSkipItem = async (itemKey) => {
    const item = putawayItems.find((i) => i.key === itemKey);
    if (!item) return;
    try {
      await api.put(`/warehouse/putaways/${viewData.id}/items/${item.id}/skip`);
      setPutawayItems((prev) =>
        prev.map((i) => {
          if (i.key !== itemKey) return i;
          return { ...i, status: 'skipped' };
        })
      );
      message.info(`Item "${item.item_name}" skipped`);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Start Putaway ---
  const handleStartPutaway = async () => {
    if (!viewData) return;
    try {
      await api.put(`/warehouse/putaways/${viewData.id}/start`);
      setViewData((prev) => prev ? { ...prev, status: 'in_progress', started_at: new Date().toISOString() } : prev);
      setPutawayItems((prev) => prev.map((i) => i.status === 'pending' ? { ...i, status: 'in_progress' } : i));
      message.success('Putaway started');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Change Putaway Type ---
  const handlePutawayTypeChange = async (type) => {
    if (!viewData) return;
    setPutawayType(type);
    try {
      await api.put(`/warehouse/putaways/${viewData.id}`, { putaway_type: type });
      if (type === 'system_directed') {
        // Refresh to get system-suggested bins
        const res = await api.get(`/warehouse/putaways/${viewData.id}`);
        const data = res.data;
        const items = (data.items || []).map((item, idx) => ({
          key: item.id || Date.now() + idx,
          id: item.id,
          item_id: item.item_id,
          item_name: item.item_name || '',
          item_code: item.item_code || '',
          qty: item.qty || item.quantity || 0,
          batch_number: item.batch_number || '',
          suggested_bin: item.suggested_bin || '',
          suggested_bin_id: item.suggested_bin_id || null,
          actual_bin: item.actual_bin || item.suggested_bin || '',
          actual_bin_id: item.actual_bin_id || item.suggested_bin_id || null,
          status: item.status || 'pending',
          scanned_at: item.scanned_at || null,
          scan_confirmed: !!item.scanned_at,
          has_serial: item.has_serial || false,
          serial_numbers: item.serial_numbers || [],
        }));
        setPutawayItems(items);
        message.success('Bins re-suggested by system based on availability');
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Save Bin Assignments ---
  const handleSaveBinAssignments = async () => {
    if (!viewData) return;
    setSubmitting(true);
    try {
      await api.put(`/warehouse/putaways/${viewData.id}/bins`, {
        items: putawayItems.map((item) => ({
          id: item.id,
          actual_bin_id: item.actual_bin_id,
          actual_bin: item.actual_bin,
          batch_number: item.batch_number,
        })),
      });
      message.success('Bin assignments and batch numbers saved');
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // --- Progress Calculation ---
  const getProgress = () => {
    if (putawayItems.length === 0) return 0;
    const done = putawayItems.filter((i) => i.status === 'done' || i.status === 'skipped').length;
    return Math.round((done / putawayItems.length) * 100);
  };

  // --- View Items Columns ---
  const putawayItemColumns = [
    { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item', dataIndex: 'item_name', width: 180, ellipsis: true,
      render: (v, r) => (
        <Tooltip title={`${r.item_code || ''} - ${v}`}>
          <Text ellipsis style={{ maxWidth: 160 }}>{v}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Qty', dataIndex: 'qty', width: 70, align: 'center',
      render: (v) => <Text strong>{formatNumber(v)}</Text>,
    },
    {
      title: 'Batch', dataIndex: 'batch_number', width: 150,
      render: (v, record) => {
        if (record.status === 'done' || record.status === 'skipped') {
          return <Tag color="blue">{v || '-'}</Tag>;
        }
        return (
          <Input
            size="small"
            placeholder="Enter batch #"
            value={record.batch_number || ''}
            onChange={(e) => updatePutawayItemBatch(record.key, e.target.value)}
            disabled={record.status === 'done' || record.status === 'skipped'}
            style={{ width: '100%' }}
          />
        );
      },
    },
    {
      title: 'Suggested Bin', dataIndex: 'suggested_bin', width: 150,
      render: (v) => v ? (
        <Tag icon={<AimOutlined />} color="blue">{v}</Tag>
      ) : (
        <Text type="secondary">Not assigned</Text>
      ),
    },
    {
      title: 'Actual Bin', dataIndex: 'actual_bin', width: 200,
      render: (val, record) => {
        if (record.scan_confirmed || record.status === 'done') {
          return <Tag icon={<EnvironmentOutlined />} color="green">{val || record.suggested_bin || '-'}</Tag>;
        }
        return (
          <Input
            size="small"
            prefix={<EnvironmentOutlined />}
            placeholder="Enter bin..."
            value={record.actual_bin || ''}
            disabled={record.status === 'done' || record.status === 'skipped'}
            onChange={(e) => updatePutawayItemBin(record.key, e.target.value)}
            style={{ width: '100%', textAlign: 'left' }}
          />
        );
      },
    },
    {
      title: 'Status', dataIndex: 'status', width: 110,
      render: (v) => {
        const cfg = ITEM_STATUSES[v] || ITEM_STATUSES.pending;
        return (
          <Tag style={{ color: '#fff', backgroundColor: cfg.color, borderColor: cfg.color }}>
            {cfg.label}
          </Tag>
        );
      },
    },
    {
      title: 'Scanned At', dataIndex: 'scanned_at', width: 140,
      render: (v) => v ? (
        <Text style={{ fontSize: 12 }}>{formatDateTime(v)}</Text>
      ) : '-',
    },
    {
      title: 'Serial Numbers',
      width: 150,
      render: (_, record) => {
        const isReadOnly = record.status === 'done' || record.status === 'skipped';
        return (
          <SerialNumbersModal
            value={record.serial_numbers || []}
            onChange={(updated) => {
              setPutawayItems((prev) =>
                prev.map((item) =>
                  item.key === record.key ? { ...item, serial_numbers: updated } : item
                )
              );
            }}
            itemName={record.item_name}
            itemCode={record.item_code}
            quantity={parseInt(record.qty || 0, 10)}
            hasSerial={record.has_serial}
            readOnly={isReadOnly}
            size="small"
          />
        );
      },
    },
    {
      title: 'Actions', width: 180,
      render: (_, record) => {
        if (record.status === 'done') {
          return <Tag color="success" icon={<CheckOutlined />}>Confirmed</Tag>;
        }
        if (record.status === 'skipped') {
          return <Tag color="default">Skipped</Tag>;
        }
        return (
          <Space size="small">
            <Tooltip title={record.actual_bin_id ? 'Mark as placed in the selected bin' : 'Pick a bin first'}>
              <Popconfirm
                title="Confirm putaway of this item?"
                onConfirm={async () => {
                  if (!record.actual_bin_id) {
                    message.warning('Pick a bin in "Actual Bin" before confirming.');
                    return;
                  }
                  if (record.has_serial) {
                    const needed = parseInt(record.qty || 0, 10);
                    const filled = (record.serial_numbers || []).filter(s => s && s.trim()).length;
                    if (filled !== needed) {
                      message.warning(`Please enter all ${needed} serial numbers before confirming.`);
                      return;
                    }
                  }
                  try {
                    await api.put(`/warehouse/putaways/${viewData.id}/items/${record.id}/confirm`, {
                      actual_bin_id: record.actual_bin_id,
                      scanned_at: new Date().toISOString(),
                      serial_numbers: record.serial_numbers || [],
                    });
                    setPutawayItems((prev) =>
                      prev.map((i) => i.key === record.key
                        ? { ...i, status: 'done', scan_confirmed: true }
                        : i)
                    );
                    message.success(`Confirmed: ${record.item_name}`);
                  } catch (err) {
                    message.error(getErrorMessage(err));
                  }
                }}
                disabled={!record.actual_bin_id}
              >
                <Button
                  type="primary"
                  size="small"
                  icon={<CheckOutlined />}
                  disabled={!record.actual_bin_id}
                >
                  Confirm
                </Button>
              </Popconfirm>
            </Tooltip>
            <Tooltip title="Scan to Confirm (optional)">
              <Button
                size="small"
                icon={<ScanOutlined />}
                onClick={() => {
                  setActiveScanItemKey(record.key);
                  setScannerActive(true);
                }}
                ghost
              >
                Scan
              </Button>
            </Tooltip>
            <Popconfirm title="Skip this item?" onConfirm={() => handleSkipItem(record.key)}>
              <Button size="small" type="text" danger>Skip</Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  // --- Main Table Columns ---
  const columns = [
    {
      title: 'Putaway Number',
      dataIndex: 'putaway_number',
      key: 'putaway_number',
      width: 160,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => handleView(record)}>{text}</a>,
    },
    {
      title: 'GRN Reference',
      dataIndex: 'grn_number',
      key: 'grn_number',
      width: 150,
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
      title: 'Putaway Type',
      dataIndex: 'putaway_type',
      key: 'putaway_type',
      width: 130,
      render: (v) => {
        const typeMap = { system_directed: 'System Directed', manual: 'Manual' };
        return <Tag color={v === 'system_directed' ? 'blue' : 'orange'}>{typeMap[v] || v || '-'}</Tag>;
      },
    },
    {
      title: 'Assigned To',
      dataIndex: 'assigned_to_name',
      key: 'assigned_to',
      width: 140,
      render: (v, r) => v || r.assigned_to || '-',
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Progress',
      key: 'progress',
      width: 120,
      render: (_, record) => {
        const total = record.total_items || 0;
        const done = record.completed_items || 0;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        return <Progress percent={pct} size="small" format={() => `${done}/${total}`} />;
      },
    },
    {
      title: 'Started At',
      dataIndex: 'started_at',
      key: 'started_at',
      width: 140,
      sorter: true,
      render: (v) => v ? formatDateTime(v) : '-',
    },
    {
      title: 'Completed At',
      dataIndex: 'completed_at',
      key: 'completed_at',
      width: 140,
      sorter: true,
      render: (v) => v ? formatDateTime(v) : '-',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View / Execute Putaway">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(record)} />
          </Tooltip>
          {(record.status === 'draft' || record.status === 'pending') && (
            <Tooltip title="Start Putaway">
              <Popconfirm title="Start this putaway?" onConfirm={async () => {
                try {
                  await api.put(`/warehouse/putaways/${record.id}/start`);
                  message.success('Putaway started');
                  setRefreshKey((k) => k + 1);
                } catch (err) { message.error(getErrorMessage(err)); }
              }}>
                <Button type="link" size="small" icon={<PlayCircleOutlined />} style={{ color: '#eb2f96' }} />
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
        style={{ width: 140 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={PUTAWAY_STATUSES}
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
        onDropdownVisibleChange={(open) => { if (open && warehouses.length === 0) loadWarehouses(); }}
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="Putaway" subtitle="Manage putaway operations for received goods">
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchPutaways}
        rowKey="id"
        searchPlaceholder="Search by putaway number, GRN..."
        exportFileName="putaway_list"
        toolbar={toolbar}
        scroll={{ x: 1500 }}
      />

      {/* --- View / Execute Putaway Drawer --- */}
      <Drawer
        title={viewData ? `Putaway: ${viewData.putaway_number}` : 'Putaway Detail'}
        width={1100}
        open={viewDrawerOpen}
        onClose={() => {
          setViewDrawerOpen(false);
          setViewData(null);
          setPutawayItems([]);
          setScannerActive(false);
          setActiveScanItemKey(null);
        }}
        destroyOnHidden
        loading={viewLoading}
        extra={
          viewData && (
            <Space>
              {(viewData.status === 'draft' || viewData.status === 'pending') && (
                <Button
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  onClick={handleStartPutaway}
                >
                  Start Putaway
                </Button>
              )}
              {((viewData.status === 'draft' || viewData.status === 'pending') || viewData.status === 'in_progress') && (
                <Button onClick={handleSaveBinAssignments} loading={submitting}>
                  Save Bin Assignments
                </Button>
              )}
              <Button onClick={() => { setViewDrawerOpen(false); setViewData(null); }}>
                Close
              </Button>
            </Space>
          )
        }
      >
        {viewData && (
          <>
            {/* Header Info */}
            <Descriptions bordered size="small" column={3} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="Putaway Number">{viewData.putaway_number}</Descriptions.Item>
              <Descriptions.Item label="Status"><StatusTag status={viewData.status} /></Descriptions.Item>
              <Descriptions.Item label="GRN Reference">{viewData.grn_number || '-'}</Descriptions.Item>
              <Descriptions.Item label="Warehouse">{viewData.warehouse_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Assigned To">{viewData.assigned_to_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Putaway Type">
                <Tag color={viewData.putaway_type === 'system_directed' ? 'blue' : 'orange'}>
                  {viewData.putaway_type === 'system_directed' ? 'System Directed' : 'Manual'}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Started At">
                {viewData.started_at ? formatDateTime(viewData.started_at) : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Completed At">
                {viewData.completed_at ? formatDateTime(viewData.completed_at) : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="Created">
                {formatDateTime(viewData.created_at)}
              </Descriptions.Item>
            </Descriptions>

            {/* Progress Bar */}
            <Card size="small" style={{ marginBottom: 16 }}>
              <Row align="middle" gutter={16}>
                <Col span={4}>
                  <Text strong>Progress:</Text>
                </Col>
                <Col span={14}>
                  <Progress
                    percent={getProgress()}
                    status={getProgress() === 100 ? 'success' : 'active'}
                    strokeColor={{
                      '0%': '#eb2f96',
                      '100%': '#52c41a',
                    }}
                  />
                </Col>
                <Col span={6} style={{ textAlign: 'right' }}>
                  <Space>
                    <Badge status="success" text={`Done: ${putawayItems.filter((i) => i.status === 'done').length}`} />
                    <Badge status="processing" text={`Pending: ${putawayItems.filter((i) => i.status === 'pending' || i.status === 'in_progress').length}`} />
                  </Space>
                </Col>
              </Row>
            </Card>

            {/* Putaway Type Toggle */}
            {((viewData.status === 'draft' || viewData.status === 'pending') || viewData.status === 'in_progress') && (
              <div style={{ marginBottom: 16 }}>
                <Text strong style={{ marginRight: 12 }}>Putaway Type:</Text>
                <Radio.Group
                  value={putawayType}
                  onChange={(e) => handlePutawayTypeChange(e.target.value)}
                  optionType="button"
                  buttonStyle="solid"
                >
                  <Radio.Button value="system_directed">
                    <AimOutlined /> System Directed
                  </Radio.Button>
                  <Radio.Button value="manual">
                    <EnvironmentOutlined /> Manual
                  </Radio.Button>
                </Radio.Group>
                {putawayType === 'system_directed' && (
                  <Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>
                    Bins auto-suggested based on availability
                  </Text>
                )}
              </div>
            )}

            {/* Batch Barcode Scanner */}
            {(viewData.status === 'in_progress') && !activeScanItemKey && (
              <div style={{ marginBottom: 16 }}>
                <Button
                  icon={<ScanOutlined />}
                  onClick={() => setScannerActive(!scannerActive)}
                  type={scannerActive ? 'primary' : 'default'}
                  style={{ marginBottom: 8 }}
                >
                  {scannerActive ? 'Hide Batch Scanner' : 'Batch Scan Mode'}
                </Button>
                {scannerActive && (
                  <Card size="small" style={{ background: '#f6ffed', border: '1px solid #b7eb8f' }}>
                    <BarcodeScanner
                      onScan={handleBatchScan}
                      placeholder="Scan item barcodes to confirm putaway..."
                      autoFocus
                    />
                  </Card>
                )}
              </div>
            )}

            {/* Per-item scanner */}
            {activeScanItemKey && (
              <Card
                size="small"
                style={{ marginBottom: 16, background: '#e6f7ff', border: '1px solid #91d5ff' }}
                title={
                  <Space>
                    <ScanOutlined />
                    <Text strong>
                      Scanning for: {putawayItems.find((i) => i.key === activeScanItemKey)?.item_name || 'Item'}
                    </Text>
                  </Space>
                }
                extra={
                  <Button size="small" onClick={() => { setActiveScanItemKey(null); setScannerActive(false); }}>
                    Cancel
                  </Button>
                }
              >
                <BarcodeScanner
                  onScan={(scanResult) => handleScanConfirm(activeScanItemKey, scanResult)}
                  placeholder="Scan item barcode to confirm..."
                  autoFocus
                />
              </Card>
            )}

            {/* Items Table */}
            <Divider orientation="left">
              <Space>
                <InboxOutlined />
                Putaway Items
                <Badge count={putawayItems.length} style={{ backgroundColor: '#eb2f96' }} />
              </Space>
            </Divider>
            <Table
              dataSource={putawayItems}
              columns={putawayItemColumns}
              rowKey="key"
              pagination={false}
              size="small"
              scroll={{ x: 1350 }}
              rowClassName={(record) => {
                if (record.status === 'done') return 'row-done';
                if (record.status === 'skipped') return 'row-skipped';
                return '';
              }}
            />
          </>
        )}
      </Drawer>

    </div>
  );
};

export default Putaway;

