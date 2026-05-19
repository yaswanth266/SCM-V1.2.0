import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Card, Select, DatePicker, Space, Typography, message, Tag, Tooltip,
} from 'antd';
import {
  DownloadOutlined, FilterOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import {
  formatDate, formatDateTime, formatCurrency, formatNumber, getErrorMessage,
  formatDateForAPI, downloadExcel,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { Text } = Typography;
const { RangePicker } = DatePicker;

const TRANSACTION_TYPES = [
  { label: 'All Types', value: '' },
  { label: 'GRN', value: 'grn' },
  { label: 'Purchase Receipt', value: 'purchase_receipt' },
  { label: 'Sales Issue', value: 'sales_issue' },
  { label: 'Stock Transfer', value: 'stock_transfer' },
  { label: 'Stock Adjustment', value: 'stock_adjustment' },
  { label: 'Stock Audit', value: 'stock_audit' },
  { label: 'Consumption', value: 'consumption' },
  { label: 'Return Inward', value: 'return_inward' },
  { label: 'Return Outward', value: 'return_outward' },
  { label: 'Putaway', value: 'putaway' },
  { label: 'Picking', value: 'picking' },
  { label: 'Replenishment', value: 'replenishment' },
  { label: 'Opening Stock', value: 'opening_stock' },
  { label: 'Write Off', value: 'write_off' },
];

const StockLedger = () => {
  // Filters
  const [filterItem, setFilterItem] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);
  const [filterTransType, setFilterTransType] = useState('');
  const [filterDateRange, setFilterDateRange] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Lookups
  const [warehouses, setWarehouses] = useState([]);

  // Load lookups
  useEffect(() => {
    const loadLookups = async () => {
      try {
        const res = await api.get('/masters/warehouses', { params: { page_size: 200 } });
        const d = res.data;
        const items = d.items || d.data || d || [];
        setWarehouses(items.map((w) => ({
          label: w.name || w.warehouse_name,
          value: w.id,
        })));
      } catch {
        // silent
      }
    };
    loadLookups();
  }, []);

  // Fetch stock ledger
  const fetchStockLedger = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterItem) qp.item_id = filterItem;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      if (filterTransType) qp.transaction_type = filterTransType;
      if (filterDateRange && filterDateRange[0]) {
        qp.date_from = formatDateForAPI(filterDateRange[0]);
        qp.date_to = formatDateForAPI(filterDateRange[1]);
      }
      return await api.get('/inventory/stock-ledger', { params: qp });
    },
    [filterItem, filterWarehouse, filterTransType, filterDateRange]
  );

  // Apply filters
  const applyFilters = () => {
    setRefreshKey((k) => k + 1);
  };

  // Export
  const handleExport = async () => {
    try {
      const qp = { page_size: 10000 };
      if (filterItem) qp.item_id = filterItem;
      if (filterWarehouse) qp.warehouse_id = filterWarehouse;
      if (filterTransType) qp.transaction_type = filterTransType;
      if (filterDateRange && filterDateRange[0]) {
        qp.date_from = formatDateForAPI(filterDateRange[0]);
        qp.date_to = formatDateForAPI(filterDateRange[1]);
      }
      const res = await api.get('/inventory/stock-ledger', { params: qp });
      const data = res.data;
      const items = data.items || data.data || data || [];
      const exportData = items.map((r) => ({
        'Posting Date': r.posting_date ? formatDateTime(r.posting_date) : '',
        'Item Code': r.item_code || '',
        'Item Name': r.item_name || '',
        'Warehouse': r.warehouse_name || r.warehouse || '',
        'Transaction Type': r.transaction_type || '',
        'Reference': r.reference || '',
        'Qty In': r.qty_in || 0,
        'Qty Out': r.qty_out || 0,
        'Balance Qty': r.balance_qty || 0,
        'Rate': r.rate || 0,
        'Value In': r.value_in || 0,
        'Value Out': r.value_out || 0,
        'Balance Value': r.balance_value || 0,
        'Created By': r.created_by || '',
      }));
      downloadExcel(exportData, 'Stock_Ledger');
      message.success('Export downloaded');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // Transaction type tag color
  const getTransTypeColor = (type) => {
    const colors = {
      grn: 'green',
      purchase_receipt: 'green',
      sales_issue: 'red',
      stock_transfer: 'blue',
      stock_adjustment: 'orange',
      stock_audit: 'purple',
      consumption: 'red',
      return_inward: 'cyan',
      return_outward: 'volcano',
      putaway: 'geekblue',
      picking: 'magenta',
      replenishment: 'blue',
      opening_stock: 'gold',
      write_off: 'red',
    };
    return colors[type] || 'default';
  };

  const getTransTypeLabel = (type) => {
    if (!type) return '-';
    const found = TRANSACTION_TYPES.find((t) => t.value === type);
    if (found) return found.label;
    return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  };

  // Columns
  const columns = [
    {
      title: 'Posting Date',
      dataIndex: 'posting_date',
      width: 150,
      fixed: 'left',
      sorter: true,
      render: (val) => formatDateTime(val),
    },
    {
      title: 'Item Code',
      dataIndex: 'item_code',
      width: 120,
      sorter: true,
    },
    {
      title: 'Item Name',
      dataIndex: 'item_name',
      width: 180,
      sorter: true,
      render: (val) => (
        <Tooltip title={val}>
          <Text ellipsis style={{ maxWidth: 160 }}>{val || '-'}</Text>
        </Tooltip>
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
      title: 'Transaction Type',
      dataIndex: 'transaction_type',
      width: 140,
      render: (val) => (
        <Tag color={getTransTypeColor(val)}>
          {getTransTypeLabel(val)}
        </Tag>
      ),
    },
    {
      title: 'Reference',
      dataIndex: 'reference',
      width: 160,
      render: (val) => (
        <Tooltip title={val}>
          <Text ellipsis style={{ maxWidth: 140 }}>{val || '-'}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Qty In',
      dataIndex: 'qty_in',
      width: 100,
      align: 'right',
      render: (val) => (
        val > 0 ? <Text style={{ color: '#52c41a' }}>+{formatNumber(val)}</Text> : <Text type="secondary">0</Text>
      ),
    },
    {
      title: 'Qty Out',
      dataIndex: 'qty_out',
      width: 100,
      align: 'right',
      render: (val) => (
        val > 0 ? <Text style={{ color: '#f5222d' }}>-{formatNumber(val)}</Text> : <Text type="secondary">0</Text>
      ),
    },
    {
      title: 'Balance Qty',
      dataIndex: 'balance_qty',
      width: 110,
      align: 'right',
      render: (val) => <Text strong>{formatNumber(val || 0)}</Text>,
    },
    {
      title: 'Rate',
      dataIndex: 'rate',
      width: 110,
      align: 'right',
      render: (val) => formatCurrency(val),
    },
    {
      title: 'Value In',
      dataIndex: 'value_in',
      width: 120,
      align: 'right',
      render: (val) => (
        val > 0 ? <Text style={{ color: '#52c41a' }}>{formatCurrency(val)}</Text> : <Text type="secondary">-</Text>
      ),
    },
    {
      title: 'Value Out',
      dataIndex: 'value_out',
      width: 120,
      align: 'right',
      render: (val) => (
        val > 0 ? <Text style={{ color: '#f5222d' }}>{formatCurrency(val)}</Text> : <Text type="secondary">-</Text>
      ),
    },
    {
      title: 'Balance Value',
      dataIndex: 'balance_value',
      width: 130,
      align: 'right',
      render: (val) => <Text strong>{formatCurrency(val)}</Text>,
    },
    {
      title: 'Created By',
      dataIndex: 'created_by',
      width: 120,
      render: (val) => val || '-',
    },
  ];

  const filterToolbar = (
    <Space wrap size="small" style={{ marginLeft: 12 }}>
      <ItemSelector
        value={filterItem}
        onChange={(val) => setFilterItem(val)}
        placeholder="Filter by item..."
        style={{ width: 200 }}
      />
      <Select
        placeholder="Warehouse"
        options={warehouses}
        value={filterWarehouse}
        onChange={(val) => setFilterWarehouse(val)}
        allowClear
        style={{ width: 160 }}
        size="middle"
      />
      <Select
        placeholder="Transaction Type"
        options={TRANSACTION_TYPES}
        value={filterTransType}
        onChange={(val) => setFilterTransType(val)}
        style={{ width: 160 }}
        size="middle"
      />
      <RangePicker
        value={filterDateRange}
        onChange={(val) => setFilterDateRange(val)}
        format={DATE_FORMAT}
        size="middle"
      />
      <Button type="primary" icon={<FilterOutlined />} onClick={applyFilters} size="middle">
        Apply
      </Button>
    </Space>
  );

  return (
    <div>
      <PageHeader title="Stock Ledger" subtitle="Stock movement history and running balances">
        <Button icon={<DownloadOutlined />} onClick={handleExport}>
          Export to Excel
        </Button>
      </PageHeader>

      <Card bodyStyle={{ padding: 0 }}>
        <DataTable
          key={refreshKey}
          columns={columns}
          fetchFunction={fetchStockLedger}
          rowKey="id"
          searchPlaceholder="Search by item, reference, warehouse..."
          exportFileName="Stock_Ledger"
          showExport={false}
          toolbar={filterToolbar}
          scroll={{ x: 2000 }}
        />
      </Card>
    </div>
  );
};

export default StockLedger;
