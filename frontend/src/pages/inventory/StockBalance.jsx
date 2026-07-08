import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Card, Row, Col, Select, Switch, Input, InputNumber, Modal, Table, Descriptions,
  message, Tag, Tooltip, Tabs, Space, Typography, Badge, Form, DatePicker, Popover, List,
  Radio,
} from 'antd';
import {
  AppstoreOutlined, WarningOutlined, ClockCircleOutlined,
  DollarOutlined, DownloadOutlined, EyeOutlined, FilterOutlined,
  BarChartOutlined, UnorderedListOutlined, PlusOutlined,
} from '@ant-design/icons';
import useAuthStore from '../../store/authStore';
import ItemSelector from '../../components/ItemSelector';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatCard from '../../components/StatCard';
import api from '../../config/api';
import {
  formatDate, formatDateTime, formatCurrency, formatNumber, getErrorMessage,
  downloadExcel,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { Text } = Typography;
const { Search } = Input;

const CATEGORY_OPTIONS = [
  { label: 'Raw Material', value: 'raw_material' },
  { label: 'Finished Good', value: 'finished_good' },
  { label: 'Consumable', value: 'consumable' },
  { label: 'Spare Part', value: 'spare_part' },
  { label: 'Asset', value: 'asset' },
  { label: 'Service', value: 'service' },
];

const GROUP_BY_OPTIONS = [
  { label: 'None', value: '' },
  { label: 'Warehouse', value: 'warehouse' },
  { label: 'Item', value: 'item' },
  { label: 'Category', value: 'category' },
  { label: 'Batch', value: 'batch' },
];

const StockBalance = () => {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.roles?.some((r) => ['super_admin', 'admin', 'warehouse_manager'].includes(r.code || r.name));

  // Filters
  const [filterWarehouse, setFilterWarehouse] = useState(user?.warehouse_id || undefined);
  const [filterItem, setFilterItem] = useState('');
  const [filterCategory, setFilterCategory] = useState(undefined);
  const [filterBatch, setFilterBatch] = useState('');
  const [showZeroStock, setShowZeroStock] = useState(false);
  const [groupBy, setGroupBy] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  // Lookups
  const [warehouses, setWarehouses] = useState([]);

  // Summary stats
  const [stats, setStats] = useState({
    total_items: 0,
    total_stock_value: 0,
    low_stock_alerts: 0,
    expiring_soon: 0,
  });

  // Add Stock modal
  const [addStockOpen, setAddStockOpen] = useState(false);
  const [addStockSubmitting, setAddStockSubmitting] = useState(false);
  const [addStockItem, setAddStockItem] = useState(null);
  const [addStockItemMeta, setAddStockItemMeta] = useState(null);
  const [addStockQty, setAddStockQty] = useState(0);
  const [addStockRate, setAddStockRate] = useState(0);
  const [addStockWarehouse, setAddStockWarehouse] = useState(user?.warehouse_id || undefined);
  const [addStockType, setAddStockType] = useState('opening');
  const [addStockUomId, setAddStockUomId] = useState(null);
  // BUG-INV-135: batch fields for Add Stock
  const [addStockBatchNumber, setAddStockBatchNumber] = useState('');
  const [addStockMfgDate, setAddStockMfgDate] = useState(null);
  const [addStockExpiryDate, setAddStockExpiryDate] = useState(null);

  const handleDownloadQRCode = (code, record) => {
    const matCode = record.item_code || '-';
    const itemName = record.item_name || '-';
    const batch = record.batch_number || record.batch_name || '-';
    const wh = record.warehouse_name || '-';
    const expLabel = record.item_type === 'asset' ? 'Warranty' : 'Expiry';
    const exp = record.expiry_date ? dayjs(record.expiry_date).format('YYYY-MM-DD') : '-';
    
    const payload = `Material: ${matCode}\nItem: ${itemName}\nBatch: ${batch}\nCode: ${code}\nWarehouse: ${wh}\n${expLabel}: ${exp}`;
    
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = `https://bwipjs-api.metafloor.com/?bcid=qrcode&text=${encodeURIComponent(payload)}&scale=4`;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 354; // 30mm at 300 DPI
      canvas.height = 295; // 25mm at 300 DPI
      const ctx = canvas.getContext('2d');
      
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      const qrSize = 255;
      const qrX = Math.floor((canvas.width - qrSize) / 2);
      const qrY = Math.floor((canvas.height - qrSize) / 2);
      
      ctx.drawImage(img, qrX, qrY, qrSize, qrSize);
      
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `qrcode_${code}.png`;
      a.click();
    };
    img.onerror = () => {
      message.error('Failed to download QR code');
    };
  };

  const handleAddStock = async () => {
    // BUG-INV-132: guard against double-click. Antd's confirmLoading prevents
    // a second click via the OK button while the request is in flight, but
    // a fast keypress on Enter or a programmatic invocation can still bypass
    // it. The local re-entrancy check makes this idempotent.
    if (addStockSubmitting) return;
    if (!addStockItem || !addStockQty || !addStockWarehouse) {
      message.error('Please fill Item, Warehouse and Quantity');
      return;
    }
    // BUG-INV-135: enforce batch fields for batch-tracked items
    const requiresBatch = !!(addStockItemMeta && (addStockItemMeta.has_batch
      || ['medicine', 'pharma', 'drug'].includes(String(addStockItemMeta.item_type || '').toLowerCase())));
    const requiresExpiry = !!(addStockItemMeta && (addStockItemMeta.has_expiry || requiresBatch));
    if (requiresBatch && !addStockBatchNumber) {
      message.error('Batch number is required for this item');
      return;
    }
    if (requiresExpiry && !addStockExpiryDate) {
      message.error('Expiry date is required for this item');
      return;
    }
    setAddStockSubmitting(true);
    try {
      // Step 1: if batch info supplied, ensure a Batch row exists. We do this
      // via a lightweight POST to a batch-upsert endpoint if available; else
      // rely on the backend stock-entry to handle batch_id. For now we send
      // batch_number / dates and let the backend resolve.
      let batchId = null;
      if (addStockBatchNumber) {
        try {
          const br = await api.post('/warehouse/batches', {
            item_id: addStockItem,
            batch_number: addStockBatchNumber,
            manufacturing_date: addStockMfgDate ? addStockMfgDate.format('YYYY-MM-DD') : null,
            expiry_date: addStockExpiryDate ? addStockExpiryDate.format('YYYY-MM-DD') : null,
          });
          batchId = br.data?.id || br.data?.batch_id || null;
        } catch (_e) {
          // Batch upsert endpoint may not exist on this build — fall through
          // and let the backend reject if it requires a batch_id.
        }
      }
      await api.post('/inventory/stock-entry', {
        entry_type: addStockType,
        remarks: `Manual ${addStockType} entry`,
        items: [{
          item_id: addStockItem,
          warehouse_id: addStockWarehouse,
          qty: addStockQty,
          rate: addStockRate || 0,
          uom_id: addStockUomId,
          batch_id: batchId,
        }]
      });
      message.success('Stock entry posted successfully');
      setAddStockOpen(false);
      setAddStockItem(null);
      setAddStockItemMeta(null);
      setAddStockQty(0);
      setAddStockRate(0);
      setAddStockWarehouse(undefined);
      setAddStockBatchNumber('');
      setAddStockMfgDate(null);
      setAddStockExpiryDate(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setAddStockSubmitting(false);
    }
  };

  // Drill-down modal
  const [drillDownOpen, setDrillDownOpen] = useState(false);
  const [drillDownItem, setDrillDownItem] = useState(null);
  const [drillDownData, setDrillDownData] = useState([]);
  const [drillDownLoading, setDrillDownLoading] = useState(false);
  const [breakdownViewMode, setBreakdownViewMode] = useState('tree');

  // Load lookups
  useEffect(() => {
    const loadLookups = async () => {
      try {
        const [whRes, statsRes] = await Promise.allSettled([
          api.get('/masters/warehouses', { params: { page_size: 200, exclude_virtual: true } }),
          api.get('/inventory/stock-balance/summary', {
            params: {
              warehouse_id: filterWarehouse,
              category: filterCategory,
              batch: filterBatch,
              show_zero_stock: showZeroStock || undefined,
              search: filterItem,
            }
          }),
        ]);
        if (whRes.status === 'fulfilled') {
          const d = whRes.value.data;
          const items = d.items || d.data || d || [];
          setWarehouses(items.map((w) => ({
            label: w.name || w.warehouse_name,
            value: w.id,
          })));
        }
        if (statsRes.status === 'fulfilled') {
          const d = statsRes.value.data;
          setStats({
            total_items: d.total_items || 0,
            total_stock_value: d.total_stock_value || 0,
            low_stock_alerts: d.low_stock_alerts || 0,
            expiring_soon: d.expiring_soon || 0,
          });
        }
      } catch {
        // silent
      }
    };
    loadLookups();
  }, [refreshKey]);

  // Fetch stock balance
  const fetchStockBalance = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      if (filterItem) qp.search = filterItem;
      if (filterCategory) qp.category = filterCategory;
      if (filterBatch) qp.batch = filterBatch;
      if (showZeroStock) qp.show_zero_stock = true;
      if (groupBy) qp.group_by = groupBy;
      return await api.get('/inventory/stock-balance', { params: qp });
    },
    [filterWarehouse, filterItem, filterCategory, filterBatch, showZeroStock, groupBy]
  );

  // Drill-down
  const handleDrillDown = async (record) => {
    setDrillDownItem(record);
    setDrillDownOpen(true);
    setDrillDownLoading(true);
    try {
      // BUG-INV-144: Always use item_id for the breakdown API. The endpoint 
      // expects the Item ID to aggregate all stock records for that item.
      // Using record.id (StockBalance PK) would only return a single row or fail.
      const targetId = record.item_id || record.id;
      const res = await api.get(`/inventory/stock-balance/${targetId}/breakdown`);
      const data = res.data;
      setDrillDownData(data.items || data.data || data || []);
    } catch (err) {
      message.error(getErrorMessage(err));
      setDrillDownData([]);
    } finally {
      setDrillDownLoading(false);
    }
  };


  // Export
  const handleExport = async () => {
    try {
      const res = await api.get('/inventory/stock-balance', {
        params: {
          page_size: 10000,
          warehouse_id: filterWarehouse,
          search: filterItem,
          category: filterCategory,
          batch: filterBatch,
          show_zero_stock: showZeroStock || undefined,
          group_by: groupBy || undefined,
        },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      const exportData = items.map((r) => {
        const row = {
          'Item Code': r.item_code,
          'Item Name': r.item_name,
          'Warehouse': r.warehouse_name || r.warehouse,
          'Location': r.location || '',
          'Rack': r.rack || '',
          'Bin': r.bin_code || r.bin || '',
          'Batch': r.batch_number || r.batch || '',
        };
        const dateKey = r.item_type === 'asset' ? 'Warranty End Date' : 'Expiry Date';
        row[dateKey] = r.expiry_date ? formatDate(r.expiry_date) : '';
        row['Available Qty'] = r.available_qty || 0;
        row['Reserved Qty'] = r.reserved_qty || 0;
        row['Transit Qty'] = r.transit_qty || 0;
        row['Total Qty'] = r.total_qty || 0;
        row['Valuation Rate'] = r.valuation_rate || 0;
        row['Stock Value'] = r.stock_value || 0;
        return row;
      });
      downloadExcel(exportData, 'Stock_Balance');
      message.success('Export downloaded');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // Row color logic
  const getRowClassName = (record) => {
    if (record.is_below_reorder) return 'row-danger';
    if (record.is_low_stock) return 'row-warning';
    if (record.is_expiring_soon) return 'row-expiring';
    return '';
  };

  // Columns
  const columns = [
    {
      title: 'Item Code',
      dataIndex: 'item_code',
      width: 160,
      fixed: 'left',
      sorter: true,
      ellipsis: { showTitle: true },
      render: (val, record) => (
        <Tooltip title={val}>
          <Button type="link" size="small" onClick={() => handleDrillDown(record)}>
            {val}
          </Button>
        </Tooltip>
      ),
    },
    {
      title: 'Item Name',
      dataIndex: 'item_name',
      width: 200,
      sorter: true,
      render: (val, record) => (
        <Space>
          <Tooltip title={val}>
            <Text ellipsis style={{ maxWidth: 170 }}>{val}</Text>
          </Tooltip>
          {record.is_low_stock && (
            <Tooltip title="Low Stock">
              <WarningOutlined style={{ color: '#fa8c16' }} />
            </Tooltip>
          )}
          {record.is_below_reorder && (
            <Tooltip title="Below Reorder Level">
              <WarningOutlined style={{ color: '#f5222d' }} />
            </Tooltip>
          )}
          {record.is_expiring_soon && (
            record.item_type === 'asset' ? (
              <Tooltip title="Warranty Expiring Soon">
                <ClockCircleOutlined style={{ color: '#1890ff' }} />
              </Tooltip>
            ) : (
              <Tooltip title="Expiring Soon">
                <ClockCircleOutlined style={{ color: '#faad14' }} />
              </Tooltip>
            )
          )}
        </Space>
      ),
    },
    {
      title: 'Warehouse',
      dataIndex: 'warehouse_name',
      width: 140,
      sorter: true,
      render: (val) => val || '-',
    },
    {
      title: 'Location',
      dataIndex: 'location',
      width: 100,
      render: (val) => val || '-',
    },
    {
      title: 'Rack',
      dataIndex: 'rack',
      width: 80,
      render: (val) => val || '-',
    },
    {
      title: 'Bin',
      dataIndex: 'bin_code',
      width: 80,
      render: (val) => val || '-',
    },
    {
      title: 'Batch',
      dataIndex: 'batch_number',
      width: 110,
      render: (val) => val || '-',
    },
    {
      title: filterCategory === 'asset' 
        ? 'Warranty End Date' 
        : (filterCategory === 'consumable' ? 'Expiry Date' : 'Expiry / Warranty End Date'),
      dataIndex: 'expiry_date',
      width: 120,
      sorter: true,
      render: (val, record) => {
        if (!val) return '-';
        const d = dayjs(val);
        const isExpiring = d.diff(dayjs(), 'day') <= 30;
        const tooltipTitle = record.item_type === 'asset' ? 'Warranty End Date' : 'Expiry Date';
        return (
          <Tooltip title={tooltipTitle}>
            <Text 
              type={isExpiring ? 'warning' : undefined} 
              style={isExpiring && record.item_type === 'asset' ? { color: '#1890ff' } : undefined}
            >
              {formatDate(val)}
            </Text>
          </Tooltip>
        );
      },
    },
    {
      title: 'S.No.',
      dataIndex: 'serial_numbers',
      width: 130,
      render: (serials, record) => {
        if (!record.has_serial) return '-';
        const list = serials || [];
        if (list.length === 0) return <Text type="secondary">None</Text>;
        const popoverContent = (
          <div style={{ maxHeight: 200, overflowY: 'auto', minWidth: 160 }}>
            <List
              size="small"
              dataSource={list}
              renderItem={(sn) => (
                <List.Item style={{ padding: '2px 0' }}>
                  <Tag color="blue">{sn}</Tag>
                </List.Item>
              )}
            />
          </div>
        );
        return (
          <Popover
            content={popoverContent}
            title="Serial Numbers"
            trigger="click"
            placement="bottom"
          >
            <Button type="link" size="small" style={{ padding: 0 }}>
              View ({list.length})
            </Button>
          </Popover>
        );
      },
    },
    {
      title: 'Asset/Consumable Code',
      dataIndex: 'asset_codes',
      width: 135,
      render: (assetCodes, record) => {
        if (record.item_type !== 'asset' && record.item_type !== 'consumable') return '-';
        const isAsset = record.item_type === 'asset';
        const list = isAsset ? (record.asset_codes || []) : (record.consumable_codes || []);
        if (list.length === 0) return <Text type="secondary">None</Text>;
        const popoverContent = (
          <div style={{ maxHeight: 200, overflowY: 'auto', minWidth: 200 }}>
            <List
              size="small"
              dataSource={list}
              renderItem={(code) => (
                <List.Item 
                  style={{ padding: '2px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <Tag color={isAsset ? "cyan" : "orange"}>{code}</Tag>
                  <Tooltip title="Download QR Code">
                    <Button 
                      type="text" 
                      size="small" 
                      icon={<DownloadOutlined />} 
                      onClick={() => handleDownloadQRCode(code, record)} 
                    />
                  </Tooltip>
                </List.Item>
              )}
            />
          </div>
        );
        return (
          <Popover
            content={popoverContent}
            title={isAsset ? "Asset Codes" : "Consumable Codes"}
            trigger="click"
            placement="bottom"
          >
            <Button type="link" size="small" style={{ padding: 0 }}>
              View ({list.length})
            </Button>
          </Popover>
        );
      },
    },
    {
      title: 'Available Qty',
      dataIndex: 'available_qty',
      width: 110,
      align: 'right',
      sorter: true,
      render: (val) => formatNumber(val || 0),
    },
    {
      title: 'Reserved Qty',
      dataIndex: 'reserved_qty',
      width: 110,
      align: 'right',
      render: (val) => (
        <Text type={val > 0 ? 'warning' : 'secondary'}>{formatNumber(val || 0)}</Text>
      ),
    },
    {
      title: 'Transit Qty',
      dataIndex: 'transit_qty',
      width: 120,
      align: 'right',
      render: (val) => (
        <Text type={val > 0 ? 'warning' : 'secondary'}>{formatNumber(val || 0)}</Text>
      ),
    },
    {
      title: 'Total Qty',
      dataIndex: 'total_qty',
      width: 100,
      align: 'right',
      sorter: true,
      render: (val, record) => {
        let color = undefined;
        if (record.is_below_reorder) color = '#f5222d';
        else if (record.is_low_stock) color = '#fa8c16';
        return (
          <Text strong style={color ? { color } : undefined}>
            {formatNumber(val || 0)}
          </Text>
        );
      },
    },
    {
      title: 'Valuation Rate',
      dataIndex: 'valuation_rate',
      width: 120,
      align: 'right',
      render: (val) => formatCurrency(val),
    },
    {
      title: 'Stock Value',
      dataIndex: 'stock_value',
      width: 130,
      align: 'right',
      sorter: true,
      render: (val) => (
        <Text strong>{formatCurrency(val)}</Text>
      ),
    },
    {
      title: '',
      key: 'action',
      width: 50,
      fixed: 'right',
      render: (_, record) => (
        <Tooltip title="View Breakdown">
          <Button
            type="text"
            icon={<EyeOutlined />}
            size="small"
            onClick={() => handleDrillDown(record)}
          />
        </Tooltip>
      ),
    },
  ];

  // Drill-down breakdown columns
  const breakdownColumns = [
    {
      title: 'Warehouse',
      dataIndex: 'warehouse_name',
      width: 140,
    },
    {
      title: 'Location',
      dataIndex: 'location_name',
      width: 180,
    },
    {
      title: 'Rack',
      dataIndex: 'rack_name',
      width: 120,
    },
    {
      title: 'Bin',
      dataIndex: 'bin_name',
      width: 120,
      render: (val, record) => val || record.bin_code || '-',
    },
    {
      title: 'Batch',
      dataIndex: 'batch_number',
      width: 110,
    },
    {
      title: drillDownItem?.item_type === 'asset' ? 'Warranty End Date' : 'Expiry Date',
      dataIndex: 'expiry_date',
      width: 110,
      render: (val) => formatDate(val),
    },
    {
      title: 'Mfg Date',
      dataIndex: 'manufacturing_date',
      width: 110,
      render: (val) => formatDate(val),
    },
    {
      title: 'S.No.',
      dataIndex: 'serial_numbers',
      width: 130,
      render: (serials, record) => {
        if (!record.has_serial) return '-';
        const list = serials || [];
        if (list.length === 0) return <Text type="secondary">None</Text>;
        const popoverContent = (
          <div style={{ maxHeight: 200, overflowY: 'auto', minWidth: 160 }}>
            <List
              size="small"
              dataSource={list}
              renderItem={(sn) => (
                <List.Item style={{ padding: '2px 0' }}>
                  <Tag color="blue">{sn}</Tag>
                </List.Item>
              )}
            />
          </div>
        );
        return (
          <Popover
            content={popoverContent}
            title="Serial Numbers"
            trigger="click"
            placement="bottom"
          >
            <Button type="link" size="small" style={{ padding: 0 }}>
              View ({list.length})
            </Button>
          </Popover>
        );
      },
    },
    {
      title: 'Asset/Consumable Code',
      dataIndex: 'asset_codes',
      width: 135,
      render: (assetCodes, record) => {
        if (record.item_type !== 'asset' && record.item_type !== 'consumable') return '-';
        const isAsset = record.item_type === 'asset';
        const list = isAsset ? (record.asset_codes || []) : (record.consumable_codes || []);
        if (list.length === 0) return <Text type="secondary">None</Text>;
        const popoverContent = (
          <div style={{ maxHeight: 200, overflowY: 'auto', minWidth: 200 }}>
            <List
              size="small"
              dataSource={list}
              renderItem={(code) => (
                <List.Item 
                  style={{ padding: '2px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <Tag color={isAsset ? "cyan" : "orange"}>{code}</Tag>
                  <Tooltip title="Download QR Code">
                    <Button 
                      type="text" 
                      size="small" 
                      icon={<DownloadOutlined />} 
                      onClick={() => handleDownloadQRCode(code, record)} 
                    />
                  </Tooltip>
                </List.Item>
              )}
            />
          </div>
        );
        return (
          <Popover
            content={popoverContent}
            title={isAsset ? "Asset Codes" : "Consumable Codes"}
            trigger="click"
            placement="bottom"
          >
            <Button type="link" size="small" style={{ padding: 0 }}>
              View ({list.length})
            </Button>
          </Popover>
        );
      },
    },
    {
      title: 'UOM',
      dataIndex: 'uom_name',
      width: 80,
    },
    {
      title: 'Available Qty',
      dataIndex: 'available_qty',
      width: 110,
      align: 'right',
      render: (val) => formatNumber(val || 0),
    },
    {
      title: 'Reserved Qty',
      dataIndex: 'reserved_qty',
      width: 100,
      align: 'right',
      render: (val) => formatNumber(val || 0),
    },
    {
      title: 'Transit Qty',
      dataIndex: 'transit_qty',
      width: 110,
      align: 'right',
      render: (val) => (
        <Text type={val > 0 ? 'warning' : 'secondary'}>{formatNumber(val || 0)}</Text>
      ),
    },
    {
      title: 'Total Qty',
      dataIndex: 'total_qty',
      width: 100,
      align: 'right',
      render: (val) => <Text strong>{formatNumber(val || 0)}</Text>,
    },
    {
      title: 'Val. Rate',
      dataIndex: 'valuation_rate',
      width: 100,
      align: 'right',
      render: (val) => formatCurrency(val),
    },
    {
      title: 'Stock Value',
      dataIndex: 'stock_value',
      width: 120,
      align: 'right',
      render: (val) => formatCurrency(val),
    },
    {
      title: 'Last Updated',
      dataIndex: 'last_updated',
      width: 160,
      render: (val) => formatDateTime(val),
    },
  ];

  const filterToolbar = (
    <Space wrap size="small" style={{ marginLeft: 12 }}>
      <Input
        placeholder="Search items by code or name..."
        value={filterItem}
        onChange={(e) => {
          setFilterItem(e.target.value);
          if (!e.target.value) {
            setRefreshKey((k) => k + 1);
          }
        }}
        onPressEnter={() => setRefreshKey((k) => k + 1)}
        allowClear
        style={{ width: 220 }}
        size="middle"
      />
      <Select
        placeholder="Warehouse"
        options={warehouses}
        value={filterWarehouse}
        onChange={(val) => { setFilterWarehouse(val); setRefreshKey((k) => k + 1); }}
        allowClear
        style={{ width: 160 }}
        size="middle"
        showSearch
        optionFilterProp="label"
      />
      <Select
        placeholder="Category"
        options={CATEGORY_OPTIONS}
        value={filterCategory}
        onChange={(val) => { setFilterCategory(val); setRefreshKey((k) => k + 1); }}
        allowClear
        style={{ width: 140 }}
        size="middle"
      />
      <Input
        placeholder="Batch..."
        value={filterBatch}
        onChange={(e) => setFilterBatch(e.target.value)}
        onPressEnter={() => setRefreshKey((k) => k + 1)}
        allowClear
        style={{ width: 120 }}
        size="middle"
      />
      <Select
        placeholder="Group By"
        options={GROUP_BY_OPTIONS}
        value={groupBy}
        onChange={(val) => { setGroupBy(val); setRefreshKey((k) => k + 1); }}
        style={{ width: 130 }}
        size="middle"
      />
      <Space size="small">
        <Text type="secondary" style={{ fontSize: 12 }}>Zero Stock</Text>
        <Switch
          checked={showZeroStock}
          onChange={(val) => { setShowZeroStock(val); setRefreshKey((k) => k + 1); }}
          size="small"
        />
      </Space>
    </Space>
  );

  const getDrillDownTreeData = () => {
    const tree = [];
    drillDownData.forEach((row) => {
      const whName = row.warehouse_name || 'No Warehouse';
      const locName = row.location_name || 'Main Area';
      const rackName = row.rack_name || 'No Rack';
      const binName = row.bin_name || row.bin_code || 'No Bin';
      const batchName = row.batch_number || 'No Batch';
      
      let whNode = tree.find(w => w.name === whName);
      if (!whNode) {
        whNode = { name: whName, total_qty: 0, locations: [] };
        tree.push(whNode);
      }
      whNode.total_qty += Number(row.total_qty) || 0;
      
      let locNode = whNode.locations.find(l => l.name === locName);
      if (!locNode) {
        locNode = { name: locName, racks: [] };
        whNode.locations.push(locNode);
      }
      
      let rackNode = locNode.racks.find(r => r.name === rackName);
      if (!rackNode) {
        rackNode = { name: rackName, bins: [] };
        locNode.racks.push(rackNode);
      }
      
      let binNode = rackNode.bins.find(b => b.name === binName);
      if (!binNode) {
        binNode = { name: binName, batches: [] };
        rackNode.bins.push(binNode);
      }
      
      const isAsset = row.item_type === 'asset';
      const codes = isAsset ? (row.asset_codes || []) : (row.consumable_codes || []);
      
      binNode.batches.push({
        batch_number: batchName,
        expiry_date: row.expiry_date,
        manufacturing_date: row.manufacturing_date,
        available_qty: row.available_qty,
        reserved_qty: row.reserved_qty,
        total_qty: row.total_qty,
        codes: codes,
        isAsset: isAsset,
        rowRef: row
      });
    });
    return tree;
  };

  const renderTreeBreakdown = () => {
    const treeData = getDrillDownTreeData();
    if (treeData.length === 0) {
      return (
        <div style={{ padding: '24px 0', textAlign: 'center' }}>
          <Text type="secondary">No breakdown data available</Text>
        </div>
      );
    }
    
    return (
      <div style={{ marginTop: 16 }}>
        <List
          dataSource={treeData}
          renderItem={(wh) => (
            <Card 
              size="small" 
              title={
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text strong style={{ fontSize: 15 }}><AppstoreOutlined style={{ marginRight: 8, color: '#1890ff' }} />{wh.name}</Text>
                  <Tag color="blue">Total Qty: {formatNumber(wh.total_qty)}</Tag>
                </div>
              }
              style={{ marginBottom: 16, borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.02)' }}
            >
              {wh.locations.map((loc) => (
                <div key={loc.name} style={{ marginLeft: 8, borderLeft: '2px solid #f0f0f0', paddingLeft: 12, marginBottom: 12 }}>
                  <Text type="secondary" style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
                    <strong>Location:</strong> {loc.name}
                  </Text>
                  
                  {loc.racks.map((rack) => (
                    <div key={rack.name} style={{ marginLeft: 12, marginBottom: 8 }}>
                      <Text style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>
                        <strong>Rack:</strong> {rack.name}
                      </Text>
                      
                      {rack.bins.map((bin) => (
                        <div key={bin.name} style={{ marginLeft: 16, marginBottom: 6 }}>
                          <Text style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>
                            <strong>Bin:</strong> {bin.name}
                          </Text>
                          
                          {bin.batches.map((batch, bIdx) => {
                            const payloadBuilder = (code) => {
                              const matCode = drillDownItem?.item_code || '-';
                              const itemName = drillDownItem?.item_name || '-';
                              const bNum = batch.batch_number || '-';
                              const whName = wh.name || '-';
                              const expLabel = drillDownItem?.item_type === 'asset' ? 'Warranty' : 'Expiry';
                              const expDate = batch.expiry_date ? dayjs(batch.expiry_date).format('YYYY-MM-DD') : '-';
                              return `Material: ${matCode}\nItem: ${itemName}\nBatch: ${bNum}\nCode: ${code}\nWarehouse: ${whName}\n${expLabel}: ${expDate}`;
                            };
                            
                            return (
                              <Card 
                                size="small" 
                                key={bIdx} 
                                style={{ marginLeft: 20, marginBottom: 8, borderRadius: 6, backgroundColor: '#fafafa' }}
                              >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                                  <div>
                                    <Tag color="purple">Batch: {batch.batch_number}</Tag>
                                    {batch.expiry_date && (
                                      <Tag color={drillDownItem?.item_type === 'asset' ? 'blue' : 'red'}>
                                        {drillDownItem?.item_type === 'asset' ? 'Warranty: ' : 'Exp: '}
                                        {formatDate(batch.expiry_date)}
                                      </Tag>
                                    )}
                                  </div>
                                  <Space>
                                    <Tag color="green">Avail: {formatNumber(batch.available_qty)}</Tag>
                                    <Tag color="cyan">Total: {formatNumber(batch.total_qty)}</Tag>
                                  </Space>
                                </div>
                                
                                {batch.codes.length > 0 ? (
                                  <div style={{ marginTop: 12 }}>
                                    <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                                      QR Labels & Codes ({batch.codes.length}):
                                    </Text>
                                    <Row gutter={[12, 12]}>
                                      {batch.codes.map((code) => {
                                        const codePayload = payloadBuilder(code);
                                        return (
                                          <Col xs={24} sm={12} md={8} key={code}>
                                            <div 
                                              style={{ 
                                                display: 'flex', 
                                                alignItems: 'center', 
                                                padding: '8px', 
                                                borderRadius: 6, 
                                                border: '1px solid #e8e8e8',
                                                backgroundColor: '#fff',
                                                justifyContent: 'space-between',
                                                boxShadow: '0 1px 3px rgba(0,0,0,0.02)'
                                              }}
                                            >
                                              <Space direction="vertical" size={2}>
                                                <Tag color={batch.isAsset ? "cyan" : "orange"} style={{ margin: 0 }}>
                                                  {code}
                                                </Tag>
                                                <img 
                                                  src={`https://bwipjs-api.metafloor.com/?bcid=qrcode&text=${encodeURIComponent(codePayload)}&scale=1`} 
                                                  alt="QR" 
                                                  style={{ 
                                                    height: 48, 
                                                    width: 48, 
                                                    marginTop: 4,
                                                    border: '1px solid #eee', 
                                                    padding: 2, 
                                                    backgroundColor: '#fff', 
                                                    borderRadius: 4 
                                                  }} 
                                                />
                                              </Space>
                                              <Tooltip title="Download QR Label">
                                                <Button 
                                                  type="primary" 
                                                  shape="circle" 
                                                  icon={<DownloadOutlined />} 
                                                  size="small" 
                                                  onClick={() => handleDownloadQRCode(code, batch.rowRef)} 
                                                />
                                              </Tooltip>
                                            </div>
                                          </Col>
                                        );
                                      })}
                                    </Row>
                                  </div>
                                ) : (
                                  <Text type="secondary" style={{ fontSize: 12 }}>No codes generated for this batch</Text>
                                )}
                              </Card>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </Card>
          )}
        />
      </div>
    );
  };

  return (
    <div>
      <PageHeader title="Stock Balance" subtitle="Real-time stock visibility across all warehouses">
        <Space>
          <Button icon={<DownloadOutlined />} onClick={handleExport}>
            Export to Excel
          </Button>
          {/* 2026-05-09 — "Add Stock" UI removed. Stock can only enter the
              system via the formal GRN flow (Gate Entry → GRN → QI →
              Putaway). This prevents back-door stock injection that would
              bypass batch/expiry/vendor traceability. */}
        </Space>
      </PageHeader>

      {/* Summary Cards */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={12} md={6}>
          <StatCard
            icon={<AppstoreOutlined />}
            iconColor="#eb2f96"
            iconBg="#e6f7ff"
            value={formatNumber(stats.total_items)}
            label="Total Items"
          />
        </Col>
        <Col xs={24} sm={12} md={6}>
          <StatCard
            icon={<DollarOutlined />}
            iconColor="#52c41a"
            iconBg="#f6ffed"
            value={formatCurrency(stats.total_stock_value)}
            label="Total Stock Value"
          />
        </Col>
        <Col xs={24} sm={12} md={6}>
          <StatCard
            icon={<WarningOutlined />}
            iconColor="#fa8c16"
            iconBg="#fff7e6"
            value={formatNumber(stats.low_stock_alerts)}
            label="Low Stock Alerts"
          />
        </Col>
        <Col xs={24} sm={12} md={6}>
          <StatCard
            icon={<ClockCircleOutlined />}
            iconColor="#faad14"
            iconBg="#fffbe6"
            value={formatNumber(stats.expiring_soon)}
            label={filterCategory === 'asset' ? "Warranty Ending Soon" : (filterCategory === 'consumable' ? "Expiring Soon" : "Expiring / Warranty Ending")}
          />
        </Col>
      </Row>

      {/* Data Table */}
      <Card styles={{ body: { padding: 0 } }}>
        <DataTable
          key={refreshKey}
          columns={columns}
          fetchFunction={fetchStockBalance}
          rowKey="id"
          showSearch={false}
          exportFileName="Stock_Balance"
          showExport={false}
          toolbar={filterToolbar}
          scroll={{ x: 1800 }}
          onRow={(record) => ({
            className: getRowClassName(record),
          })}
        />
      </Card>

      {/* Drill-down Modal */}
      <Modal
        title={
          drillDownItem ? (
            <Space>
              <BarChartOutlined />
              <span>
                Stock Breakdown: [{drillDownItem.item_code}] {drillDownItem.item_name}
              </span>
            </Space>
          ) : 'Stock Breakdown'
        }
        open={drillDownOpen}
        onCancel={() => { setDrillDownOpen(false); setDrillDownItem(null); setDrillDownData([]); }}
        footer={null}
        width={1000}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, marginTop: 8 }}>
          <Text type="secondary">Select layout presentation style for stock balance:</Text>
          <Radio.Group value={breakdownViewMode} onChange={(e) => setBreakdownViewMode(e.target.value)} size="small">
            <Radio.Button value="tree">Tree Hierarchy View</Radio.Button>
            <Radio.Button value="table">Flat Grid View</Radio.Button>
          </Radio.Group>
        </div>

        {/* Weighted Average Cost (WAC) Valuation card for consumables only */}
        {String(drillDownItem?.item_type || '').toLowerCase().includes('consumable') && drillDownData && drillDownData.length > 0 && (() => {
          let overallTotalValue = 0;
          let overallTotalQty = 0;
          drillDownData.forEach((row) => {
            overallTotalValue += Number(row.stock_value) || 0;
            overallTotalQty += Number(row.total_qty) || 0;
          });
          const overallWAC = overallTotalQty > 0 ? overallTotalValue / overallTotalQty : 0;

          return (
            <div style={{ marginBottom: 16, marginTop: 12 }}>
              <Typography.Title level={5} style={{ marginBottom: 12 }}>
                Weighted Average Cost (WAC) Valuation
              </Typography.Title>
              <Row gutter={[16, 16]}>
                <Col xs={24} sm={16} md={12}>
                  <Card 
                    size="small"
                    style={{
                      borderRadius: 8,
                      border: '1px solid #e8e8e8',
                      background: 'linear-gradient(135deg, #ffffff 0%, #fafafa 100%)',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
                    }}
                    styles={{ body: { padding: '12px 16px' } }}
                    hoverable
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                      <Text strong style={{ fontSize: 14, color: '#1890ff' }}>
                        Item Weighted Average Cost
                      </Text>
                    </div>
                    <Descriptions column={1} size="small" colon={false} labelStyle={{ color: '#8c8c8c' }}>
                      <Descriptions.Item label="Total Quantity">
                        <Text strong>{formatNumber(overallTotalQty)}</Text>
                      </Descriptions.Item>
                      <Descriptions.Item label="Weighted Average Rate">
                        <Text strong>{formatCurrency(overallWAC)}</Text>
                      </Descriptions.Item>
                      <Descriptions.Item label="Total Stock Value">
                        <Text strong style={{ color: '#52c41a', fontSize: 14 }}>
                          {formatCurrency(overallTotalValue)}
                        </Text>
                      </Descriptions.Item>
                    </Descriptions>
                  </Card>
                </Col>
              </Row>
            </div>
          );
        })()}

        {breakdownViewMode === 'tree' ? renderTreeBreakdown() : (
          <Table
            columns={breakdownColumns}
            dataSource={drillDownData}
            rowKey={(r, idx) => r.id || idx}
            loading={drillDownLoading}
            pagination={false}
            scroll={{ x: 1500 }}
            size="small"
            style={{ marginTop: 16 }}
            summary={(pageData) => {
              if (!pageData || pageData.length === 0) return null;
              // BUG-INV-121: avoid float drift on stock_value totals by
              // accumulating in cents (×100) and dividing at the end. Quantities
              // are similarly accumulated in milli-units (×1000) so 0.001-precise
              // qty rolls up exactly. Without this the displayed total drifts
              // by a few paise per ~100 rows.
              const totalsScaled = pageData.reduce(
                (acc, row) => ({
                  available: acc.available + Math.round((Number(row.available_qty) || 0) * 1000),
                  reserved: acc.reserved + Math.round((Number(row.reserved_qty) || 0) * 1000),
                  transit: acc.transit + Math.round((Number(row.transit_qty) || 0) * 1000),
                  total: acc.total + Math.round((Number(row.total_qty) || 0) * 1000),
                  valueCents: acc.valueCents + Math.round((Number(row.stock_value) || 0) * 100),
                }),
                { available: 0, reserved: 0, transit: 0, total: 0, valueCents: 0 }
              );
              const totals = {
                available: totalsScaled.available / 1000,
                reserved: totalsScaled.reserved / 1000,
                transit: totalsScaled.transit / 1000,
                total: totalsScaled.total / 1000,
                value: totalsScaled.valueCents / 100,
              };
              return (
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={9}>
                    <Text strong>Total</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={9} align="right">
                    <Text strong>{formatNumber(totals.available)}</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={10} align="right">
                    <Text strong>{formatNumber(totals.reserved)}</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={11} align="right">
                    <Text strong>{formatNumber(totals.transit)}</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={12} align="right">
                    <Text strong>{formatNumber(totals.total)}</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={13} align="right">
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={14} align="right">
                    <Text strong>{formatCurrency(totals.value)}</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={15} align="right">
                  </Table.Summary.Cell>
                </Table.Summary.Row>
              );
            }}
          />
        )}
      </Modal>

      {/* Add Stock Modal */}
      <Modal
        title="Add Stock / Opening Balance"
        open={addStockOpen}
        onOk={handleAddStock}
        onCancel={() => { setAddStockOpen(false); setAddStockItem(null); }}
        confirmLoading={addStockSubmitting}
        okButtonProps={{ disabled: addStockSubmitting }}
        cancelButtonProps={{ disabled: addStockSubmitting }}
        okText="Post Stock Entry"
        width={600}
        destroyOnHidden
      >
        <Form layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="Entry Type" required>
            <Select
              value={addStockType}
              onChange={setAddStockType}
              options={[
                { label: 'Opening Stock', value: 'opening' },
                { label: 'Stock Adjustment (Add)', value: 'adjustment_in' },
                { label: 'Stock Adjustment (Remove)', value: 'adjustment_out' },
              ]}
            />
          </Form.Item>
          <Form.Item label="Item" required>
            <ItemSelector
              value={addStockItem}
              onChange={(itemId, item) => {
                setAddStockItem(itemId);
                setAddStockItemMeta(item || null);
                if (item) setAddStockUomId(item.primary_uom_id || null);
              }}
            />
          </Form.Item>
          <Form.Item label="Warehouse" required>
            <Select
              value={addStockWarehouse}
              onChange={setAddStockWarehouse}
              options={warehouses}
              placeholder="Select warehouse"
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="Quantity" required>
                <InputNumber
                  min={0.001}
                  value={addStockQty}
                  onChange={setAddStockQty}
                  style={{ width: '100%' }}
                  placeholder="Enter quantity"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="Rate per unit">
                <InputNumber
                  min={0}
                  step={0.01}
                  value={addStockRate}
                  onChange={setAddStockRate}
                  style={{ width: '100%' }}
                  placeholder="0.00"
                  prefix="INR"
                />
              </Form.Item>
            </Col>
          </Row>
          {/* BUG-INV-135: batch fields for batch-tracked items */}
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item
                label="Batch Number"
                required={!!(addStockItemMeta && (addStockItemMeta.has_batch
                  || ['medicine', 'pharma', 'drug'].includes(String(addStockItemMeta.item_type || '').toLowerCase())))}
                tooltip="Required for batch-tracked items (medicines, pharma)"
              >
                <Input
                  value={addStockBatchNumber}
                  onChange={(e) => setAddStockBatchNumber(e.target.value)}
                  placeholder="Enter batch number"
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="Manufacturing Date">
                <DatePicker
                  value={addStockMfgDate}
                  onChange={setAddStockMfgDate}
                  style={{ width: '100%' }}
                  format="YYYY-MM-DD"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="Expiry Date"
                required={!!(addStockItemMeta && (addStockItemMeta.has_expiry
                  || addStockItemMeta.has_batch
                  || ['medicine', 'pharma', 'drug'].includes(String(addStockItemMeta.item_type || '').toLowerCase())))}
              >
                <DatePicker
                  value={addStockExpiryDate}
                  onChange={setAddStockExpiryDate}
                  style={{ width: '100%' }}
                  format="YYYY-MM-DD"
                />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <style>{`
        .row-danger { background-color: #fff1f0 !important; }
        .row-danger:hover > td { background-color: #ffccc7 !important; }
        .row-warning { background-color: #fff7e6 !important; }
        .row-warning:hover > td { background-color: #ffe7ba !important; }
        .row-expiring { background-color: #fffbe6 !important; }
        .row-expiring:hover > td { background-color: #fff1b8 !important; }
      `}</style>
    </div>
  );
};

export default StockBalance;
