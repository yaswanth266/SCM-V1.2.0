import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Card, Select, DatePicker, Space, Typography, message, Tag, Tooltip, Row, Col,
} from 'antd';
import {
  DownloadOutlined, FilterOutlined, ReloadOutlined, SearchOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import useAuthStore from '../../store/authStore';
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
  const user = useAuthStore((s) => s.user);
  const [filterWarehouse, setFilterWarehouse] = useState(user?.warehouse_id || undefined);
  const [filterTransType, setFilterTransType] = useState('');
  const [filterDateRange, setFilterDateRange] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Lookups
  const [warehouses, setWarehouses] = useState([]);

  // Load lookups
  useEffect(() => {
    const loadLookups = async () => {
      try {
        const res = await api.get('/masters/warehouses', { params: { page_size: 200, exclude_virtual: true } });
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

  const handleResetFilters = () => {
    setFilterItem(undefined);
    setFilterWarehouse(undefined);
    setFilterTransType('');
    setFilterDateRange(null);
  };

  const filterCardStyle = {
    background: '#ffffff',
    borderRadius: '12px',
    border: '1px solid #e2e8f0',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)',
    marginBottom: '20px',
  };

  const labelStyle = {
    display: 'block',
    fontWeight: 600,
    color: '#475569',
    marginBottom: '6px',
    fontSize: '11px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  };

  return (
    <div>
      <PageHeader title="Stock Ledger" subtitle="Stock movement history and running balances">
        <Button
          type="primary"
          icon={<DownloadOutlined />}
          onClick={handleExport}
          style={{
            background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
            borderColor: '#10b981',
            borderRadius: '8px',
            fontWeight: 600,
            boxShadow: '0 4px 10px rgba(16, 185, 129, 0.15)',
            border: 'none',
            height: '36px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}
        >
          Export Ledger
        </Button>
      </PageHeader>

      <Card style={filterCardStyle} styles={{ body: { padding: '16px 20px' } }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <Space size={8}>
            <FilterOutlined style={{ color: '#4f46e5', fontSize: '16px' }} />
            <span style={{ fontWeight: 700, fontSize: '14px', color: '#0f172a' }}></span>
          </Space>
          {(filterItem || filterWarehouse || filterTransType || filterDateRange) && (
            <Button
              type="text"
              size="small"
              onClick={handleResetFilters}
              style={{ color: '#64748b', fontSize: '12px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}
            >
              <ReloadOutlined style={{ fontSize: '11px' }} /> Clear All
            </Button>
          )}
        </div>

        <Row gutter={[16, 12]}>
          <Col xs={24} sm={12} md={6}>
            <span style={labelStyle}>Item</span>
            <ItemSelector
              value={filterItem}
              onChange={(val) => setFilterItem(val)}
              placeholder="All items"
              style={{ width: '100%' }}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <span style={labelStyle}>Warehouse</span>
            <Select
              placeholder="All warehouses"
              options={warehouses}
              value={filterWarehouse}
              onChange={(val) => setFilterWarehouse(val)}
              allowClear
              style={{ width: '100%' }}
              showSearch
              optionFilterProp="label"
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <span style={labelStyle}>Transaction Type</span>
            <Select
              placeholder="All types"
              options={TRANSACTION_TYPES}
              value={filterTransType}
              onChange={(val) => setFilterTransType(val)}
              style={{ width: '100%' }}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <span style={labelStyle}>Posting Date Period</span>
            <RangePicker
              value={filterDateRange}
              onChange={(val) => setFilterDateRange(val)}
              format={DATE_FORMAT}
              style={{ width: '100%' }}
            />
          </Col>
        </Row>

        {/* Active tags bar */}
        {(filterItem || filterWarehouse || filterTransType || filterDateRange) && (
          <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px dashed #e2e8f0', display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
            <span style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase' }}>Active Filters:</span>
            {filterItem && (
              <Tag closable onClose={() => setFilterItem(undefined)} color="blue" style={{ borderRadius: '4px', fontWeight: 500 }}>
                Item Selected
              </Tag>
            )}
            {filterWarehouse && (
              <Tag closable onClose={() => setFilterWarehouse(undefined)} color="blue" style={{ borderRadius: '4px', fontWeight: 500 }}>
                Warehouse: {warehouses.find(w => w.value === filterWarehouse)?.label || filterWarehouse}
              </Tag>
            )}
            {filterTransType && (
              <Tag closable onClose={() => setFilterTransType('')} color="blue" style={{ borderRadius: '4px', fontWeight: 500 }}>
                Type: {getTransTypeLabel(filterTransType)}
              </Tag>
            )}
            {filterDateRange && filterDateRange[0] && (
              <Tag closable onClose={() => setFilterDateRange(null)} color="blue" style={{ borderRadius: '4px', fontWeight: 500 }}>
                Period: {dayjs(filterDateRange[0]).format('DD/MM/YYYY')} - {dayjs(filterDateRange[1]).format('DD/MM/YYYY')}
              </Tag>
            )}
          </div>
        )}
      </Card>

      <Card styles={{ body: { padding: 0 } }} style={{ borderRadius: '12px', overflow: 'hidden', border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)' }}>
        <DataTable
          key={refreshKey}
          columns={columns}
          fetchFunction={fetchStockLedger}
          extraParams={{
            item_id: filterItem,
            warehouse_id: filterWarehouse,
            transaction_type: filterTransType,
            date_from: filterDateRange?.[0] ? formatDateForAPI(filterDateRange[0]) : undefined,
            date_to: filterDateRange?.[1] ? formatDateForAPI(filterDateRange[1]) : undefined,
          }}
          rowKey="id"
          showSearch={true}
          searchPlaceholder="Search by item code, item name, reference..."
          exportFileName="Stock_Ledger"
          showExport={false}
          scroll={{ x: 2000 }}
        />
      </Card>
    </div>
  );
};

export default StockLedger;
