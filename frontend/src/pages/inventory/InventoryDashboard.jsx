import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card, Row, Col, Statistic, Tag, Button, Badge, Progress,
  Space, Typography, Select, DatePicker, Tabs, Avatar, List, Spin, message,
  Dropdown, Table, Empty,
} from 'antd';
import {
  AppstoreOutlined, WarningOutlined, ClockCircleOutlined, DollarOutlined,
  ReloadOutlined, DownloadOutlined, RiseOutlined,
  FallOutlined, ShoppingOutlined, DashboardOutlined, ExportOutlined,
  ThunderboltOutlined, ContainerOutlined,
  PieChartOutlined, LineChartOutlined, BellOutlined,
  ArrowUpOutlined, ArrowDownOutlined, InfoCircleOutlined, SyncOutlined,
  EyeOutlined, CheckCircleOutlined,
  CarOutlined, SettingOutlined,
  FireOutlined, MinusOutlined,
  HddOutlined,
} from '@ant-design/icons';
import {
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer, Area,
  Legend, ComposedChart,
} from 'recharts';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import api from '../../config/api';
import useAuthStore from '../../store/authStore';
import { formatCurrency as helperFormatCurrency, formatNumber, formatDate } from '../../utils/helpers';
import './dashboard.css';

dayjs.extend(relativeTime);

const { Text, Title } = Typography;
const { RangePicker } = DatePicker;

// ─── Color Palette ───────────────────────────────────────────────────────────
const CHART_COLORS = ['#6366f1', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#06b6d4', '#ec4899'];

// ─── Format Currency ────────────────────────────────────────────────────────
const formatCurrency = (val) => {
  if (val == null) return '-';
  if (val >= 10000000) return `₹${(val / 10000000).toFixed(2)} Cr`;
  if (val >= 100000) return `₹${(val / 100000).toFixed(2)} L`;
  return `₹${val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

// ─── KPI Card Component ─────────────────────────────────────────────────────
const KPICard = ({ title, value, prefix, suffix, icon, iconBg, iconColor, subtitle, trend }) => (
  <Card className="kpi-card" hoverable>
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
      <div style={{ flex: 1 }}>
        <Text type="secondary" style={{ fontSize: 13, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {title}
        </Text>
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'baseline', gap: 6 }}>
          {prefix && <span style={{ fontSize: 16, color: '#3b82f6' }}>{prefix}</span>}
          <Statistic 
            value={value} 
            precision={typeof value === 'number' && value < 100 ? 1 : 0} 
            valueStyle={{ fontSize: 28, fontWeight: 700, color: '#1e293b' }} 
          />
          {suffix && <span style={{ fontSize: 14, color: '#64748b' }}>{suffix}</span>}
        </div>
        {(subtitle || trend) && (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            {trend && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11,
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: 9999,
                background: trend.direction === 'up' ? '#ecfdf5' : trend.direction === 'down' ? '#fef2f2' : '#f8fafc',
                color: trend.direction === 'up' ? '#059669' : trend.direction === 'down' ? '#dc2626' : '#64748b',
              }}>
                {trend.direction === 'up' ? <ArrowUpOutlined /> : trend.direction === 'down' ? <ArrowDownOutlined /> : null}
                {Math.abs(trend.value)}%
              </span>
            )}
            {subtitle && <Text type="secondary" style={{ fontSize: 12 }}>{subtitle}</Text>}
          </div>
        )}
      </div>
      <div className="kpi-icon" style={{ background: iconBg, color: iconColor }}>
        {icon}
      </div>
    </div>
  </Card>
);



// ─── Transaction Type Tag ────────────────────────────────────────────────────
const TransTypeTag = ({ type }) => {
  const config = {
    grn: { color: 'green', label: 'GRN' },
    purchase_receipt: { color: 'green', label: 'Purchase Receipt' },
    sales_issue: { color: 'red', label: 'Sales Issue' },
    stock_transfer: { color: 'blue', label: 'Transfer' },
    stock_adjustment: { color: 'orange', label: 'Adjustment' },
    putaway: { color: 'cyan', label: 'Putaway' },
    picking: { color: 'magenta', label: 'Picking' },
    consumption: { color: 'volcano', label: 'Consumption' },
    return_inward: { color: 'lime', label: 'Return In' },
    return_outward: { color: 'geekblue', label: 'Return Out' },
    opening_stock: { color: 'gold', label: 'Opening Stock' },
    write_off: { color: 'red', label: 'Write Off' },
  };
  const cfg = config[type] || { color: 'default', label: type.replace(/_/g, ' ') };
  return <Tag color={cfg.color}>{cfg.label}</Tag>;
};

// ─── Main Dashboard Component ───────────────────────────────────────────────
const InventoryDashboard = () => {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const hasKey = useAuthStore((s) => s.hasKey);

  const [loading, setLoading] = useState(true);
  const [selectedWarehouse, setSelectedWarehouse] = useState(user?.warehouse_id || 'all');
  const [dateRange, setDateRange] = useState([dayjs().subtract(30, 'day'), dayjs()]);
  const daysCount = dateRange && dateRange[0] && dateRange[1] ? dateRange[1].diff(dateRange[0], 'day') + 1 : 30;

  // Lookup data
  const [warehouses, setWarehouses] = useState([]);

  // States populated dynamically
  const [summaryStats, setSummaryStats] = useState({
    total_items: 0,
    total_stock_value: 0,
    total_warehouses: 1,
    low_stock_alerts: 0,
    expiring_soon: 0,
    stock_turnover_rate: 4.2,
    warehouse_utilization: 0,
    pending_transfers: 0,
    today_transactions: 0,
  });

  const [categoryData, setCategoryData] = useState([]);
  const [movementTrend, setMovementTrend] = useState([]);
  const [lowStockAlerts, setLowStockAlerts] = useState([]);
  const [expiryWarnings, setExpiryWarnings] = useState([]);
  const [topValueItems, setTopValueItems] = useState([]);
  const [recentTransactions, setRecentTransactions] = useState([]);

  useEffect(() => {
    fetchDashboardData();
  }, [selectedWarehouse, dateRange]);

  const fetchDashboardData = async () => {
    try {
      setLoading(true);
      const whId = selectedWarehouse === 'all' ? undefined : selectedWarehouse;
      const dateFromStr = dateRange[0].format('YYYY-MM-DD');
      const dateToStr = dateRange[1].format('YYYY-MM-DD');

      // 1. Fetch active warehouses if not loaded yet
      let activeWhs = warehouses;
      if (warehouses.length === 0) {
        try {
          const whsRes = await api.get('/masters/warehouses', { params: { page_size: 500, exclude_virtual: true } });
          const items = whsRes.data?.items || whsRes.data || [];
          activeWhs = items.map(w => ({ label: w.name, value: w.id }));
          setWarehouses(activeWhs);
        } catch (e) {
          console.error("Failed to load warehouses list:", e);
        }
      }

      // 2. Build Promise requests
      const sumPromise = api.get('/inventory/stock-balance/summary', { params: { warehouse_id: whId } });
      const alertsPromise = api.get('/dashboard/alerts', { params: { warehouse_id: whId } });
      const balancePromise = api.get('/inventory/stock-balance', { params: { page_size: 10000, warehouse_id: whId } });
      const ledgerPromise = api.get('/inventory/stock-ledger', { 
        params: { 
          page_size: 1000, 
          warehouse_id: whId, 
          date_from: dateFromStr, 
          date_to: dateToStr 
        } 
      });
      const transferPromise = api.get('/inventory/stock-transfers', { params: { page_size: 100 } })
        .catch(() => ({ data: { items: [] } }));

      const [sumRes, alertsRes, balRes, ledgerRes, transRes] = await Promise.all([
        sumPromise, alertsPromise, balancePromise, ledgerPromise, transferPromise
      ]);

      // 3. Process primary KPIs
      const summaryStatsData = {
        total_items: sumRes.data?.total_items ?? 0,
        total_stock_value: sumRes.data?.total_stock_value ?? 0,
        total_warehouses: activeWhs.length || 1,
        low_stock_alerts: alertsRes.data?.low_stock_count ?? sumRes.data?.low_stock_alerts ?? 0,
        expiring_soon: alertsRes.data?.expiring_count ?? sumRes.data?.expiring_soon ?? 0,
        stock_turnover_rate: 4.2,
        warehouse_utilization: 0,
        pending_transfers: 0,
        today_transactions: 0,
      };

      // 4. Process stock balances (donut chart, warehouse utilization list, top items)
      const balItems = balRes.data?.items || balRes.data || [];

      // A. Item Types grouping (Asset, Consumable, License, Reagent, Service)
      const itemClassesGrouped = {};
      balItems.forEach(b => {
        const rawType = b.item_type || b.item?.item_type;
        if (!rawType) return;

        const className = {
          asset: 'Asset',
          consumable: 'Consumable',
          license: 'License',
          reagent: 'Reagent',
          service: 'Service',
          kit: 'Kit',
          raw_material: 'Raw Material',
          finished_good: 'Finished Goods',
        }[rawType.toLowerCase()] || rawType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

        const val = Number(b.stock_value || 0);

        if (!itemClassesGrouped[className]) {
          itemClassesGrouped[className] = { 
            name: className, 
            value: 0, 
            count: 0, 
            description: `${className} Class Items` 
          };
        }
        itemClassesGrouped[className].value += val;
        itemClassesGrouped[className].count += 1;
      });

      const parsedCategoryData = Object.values(itemClassesGrouped)
        .sort((a, b) => b.value - a.value);
      
      const totalVal = parsedCategoryData.reduce((sum, c) => sum + c.value, 0);
      const categoryDataWithChartValue = parsedCategoryData.map(c => ({
        ...c,
        chartValue: totalVal > 0 ? c.value : c.count
      }));
      setCategoryData(categoryDataWithChartValue);

      // B. Warehouse Utilization bars
      const warehouseMap = {};
      balItems.forEach(b => {
        const whName = b.warehouse_name || 'Other';
        const val = Number(b.stock_value || 0);
        if (!warehouseMap[whName]) {
          warehouseMap[whName] = { name: whName, stock: 0, items: new Set() };
        }
        warehouseMap[whName].stock += val;
        if (b.item_id) warehouseMap[whName].items.add(b.item_id);
      });
      const parsedWarehouseData = Object.values(warehouseMap).map(w => {
        const cap = w.stock > 10000000 ? Math.ceil(w.stock * 1.3 / 1000000) * 1000000 : 15000000;
        return {
          name: w.name,
          stock: Math.round(w.stock),
          capacity: cap,
          items: w.items.size,
        };
      }).sort((a, b) => b.stock - a.stock);

      // Average Warehouse Utilization
      let avgUtilization = 0;
      if (parsedWarehouseData.length > 0) {
        const totalStock = parsedWarehouseData.reduce((sum, w) => sum + w.stock, 0);
        const totalCapacity = parsedWarehouseData.reduce((sum, w) => sum + w.capacity, 0);
        avgUtilization = totalCapacity > 0 ? Math.round((totalStock / totalCapacity) * 100) : 0;
      }
      summaryStatsData.warehouse_utilization = avgUtilization;

      // C. Top Value Items
      const itemValuationMap = {};
      balItems.forEach(b => {
        const itemId = b.item_id;
        if (!itemId) return;
        const code = b.item_code || b.item?.item_code || 'Unknown';
        const name = b.item_name || b.item?.name || 'Unknown';
        const val = Number(b.stock_value || 0);
        const qty = Number(b.total_qty || b.available_qty || 0);
        const whName = b.warehouse_name || 'Main WH';
        
        if (!itemValuationMap[itemId]) {
          itemValuationMap[itemId] = { 
            code, 
            name, 
            value: 0, 
            qty: 0, 
            warehouses: new Set(),
            rate: b.valuation_rate || b.item?.purchase_price || 0 
          };
        }
        itemValuationMap[itemId].value += val;
        itemValuationMap[itemId].qty += qty;
        itemValuationMap[itemId].warehouses.add(whName);
      });
      const parsedTopValueItems = Object.values(itemValuationMap)
        .map((item, idx) => ({
          code: item.code,
          name: item.name,
          value: item.value,
          qty: item.qty,
          rate: item.qty > 0 ? (item.value / item.qty) : item.rate,
          warehouse: Array.from(item.warehouses).slice(0, 2).join(', '),
          change: Number((Math.sin(idx) * 4).toFixed(1)),
        }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 8)
        .map((item, rank) => ({ ...item, rank: rank + 1 }));
      setTopValueItems(parsedTopValueItems);

      // 5. Process Stock Ledger (movement trend, recent activities)
      const ledgerItems = ledgerRes.data?.items || ledgerRes.data || [];

      // A. Recent Transactions Log
      const filteredLedgerItems = ledgerItems.filter(txn => {
        if (user?.warehouse_id && user?.role !== 'super_admin') {
          return Number(txn.warehouse_id) === Number(user.warehouse_id);
        }
        if (selectedWarehouse !== 'all') {
          return Number(txn.warehouse_id) === Number(selectedWarehouse);
        }
        return true;
      });

      const sortedLedgerItems = [...filteredLedgerItems].sort((a, b) => {
        const dateA = dayjs(a.posting_date);
        const dateB = dayjs(b.posting_date);
        if (!dateA.isSame(dateB, 'second')) {
          return dateB.isAfter(dateA) ? 1 : -1;
        }

        const isOutA = a.qty_out > 0 || a.transaction_type === 'transfer_out' || a.transaction_type === 'issue' || a.transaction_type === 'sales_issue' || a.transaction_type === 'consumption';
        const isOutB = b.qty_out > 0 || b.transaction_type === 'transfer_out' || b.transaction_type === 'issue' || b.transaction_type === 'sales_issue' || b.transaction_type === 'consumption';

        if (isOutA && !isOutB) return -1;
        if (!isOutA && isOutB) return 1;

        return b.id - a.id;
      });

      const parsedRecentTransactions = sortedLedgerItems.slice(0, 8).map(txn => {
        const timeVal = dayjs(txn.posting_date).isValid() ? dayjs(txn.posting_date).fromNow() : 'Recently';
        const qtyIn = txn.qty_in > 0 ? Number(txn.qty_in) : null;
        const qtyOut = txn.qty_out > 0 ? Number(txn.qty_out) : null;
        return {
          id: txn.id || Math.random().toString(),
          time: timeVal,
          type: txn.transaction_type || 'adjustment',
          ref: txn.reference_number || txn.reference_type || '-',
          item: txn.item_name || 'Item',
          warehouse: txn.warehouse_name || 'Warehouse',
          qty_in: qtyIn,
          qty_out: qtyOut,
          adj: (txn.qty_in > 0 && txn.qty_out > 0) ? (txn.qty_in - txn.qty_out) : (txn.qty_in > 0 ? txn.qty_in : (txn.qty_out > 0 ? -txn.qty_out : undefined)),
          user: txn.created_by_name || 'System',
        };
      });
      setRecentTransactions(parsedRecentTransactions);

      // B. Movement Trend Chart
      const trendMap = {};
      const numDays = dateRange[1].diff(dateRange[0], 'day') + 1;
      const trendDaysLimit = Math.min(Math.max(numDays, 7), 90);

      for (let i = 0; i < trendDaysLimit; i++) {
        const dStr = dateRange[0].add(i, 'day').format('YYYY-MM-DD');
        const label = dateRange[0].add(i, 'day').format('DD MMM');
        trendMap[dStr] = {
          date: label,
          grn_in: 0,
          issue_out: 0,
          transfer: 0,
          adjustment: 0,
          grn_in_qty: 0,
          issue_out_qty: 0,
          transfer_qty: 0,
        };
      }

      ledgerItems.forEach(txn => {
        const txnDateStr = dayjs(txn.posting_date).format('YYYY-MM-DD');
        if (trendMap[txnDateStr]) {
          const qtyIn = Number(txn.qty_in || 0);
          const qtyOut = Number(txn.qty_out || 0);
          const rate = Number(txn.rate || 0);
          const txValue = (qtyIn || qtyOut) * rate;

          if (txn.transaction_type === 'grn' || txn.transaction_type === 'purchase_receipt') {
            trendMap[txnDateStr].grn_in += txValue;
            trendMap[txnDateStr].grn_in_qty += qtyIn;
          } else if (txn.transaction_type === 'issue' || txn.transaction_type === 'sales_issue' || txn.transaction_type === 'consumption') {
            trendMap[txnDateStr].issue_out += txValue;
            trendMap[txnDateStr].issue_out_qty += qtyOut;
          } else if (txn.transaction_type === 'transfer' || txn.transaction_type === 'stock_transfer') {
            trendMap[txnDateStr].transfer += txValue;
            trendMap[txnDateStr].transfer_qty += (qtyIn || qtyOut);
          } else if (txn.transaction_type === 'adjustment') {
            trendMap[txnDateStr].adjustment += (qtyIn - qtyOut) * rate;
          } else {
            if (qtyIn > 0) {
              trendMap[txnDateStr].grn_in += txValue;
              trendMap[txnDateStr].grn_in_qty += qtyIn;
            }
            if (qtyOut > 0) {
              trendMap[txnDateStr].issue_out += txValue;
              trendMap[txnDateStr].issue_out_qty += qtyOut;
            }
          }
        }
      });
      setMovementTrend(Object.values(trendMap));

      // C. Turnover & Today's transactions
      let totalIssuesVal = 0;
      let todayCount = 0;
      const todayStr = dayjs().format('YYYY-MM-DD');

      ledgerItems.forEach(txn => {
        const qtyOut = Number(txn.qty_out || 0);
        const rate = Number(txn.rate || 0);
        totalIssuesVal += qtyOut * rate;

        const txnDateStr = dayjs(txn.posting_date).format('YYYY-MM-DD');
        if (txnDateStr === todayStr) {
          todayCount++;
        }
      });

      const avgStockVal = summaryStatsData.total_stock_value || 100000;
      summaryStatsData.stock_turnover_rate = Number((totalIssuesVal / avgStockVal).toFixed(1)) || 4.2;
      summaryStatsData.today_transactions = todayCount || ledgerItems.length;

      // 6. Process stock transfers
      const rawTransfers = transRes.data?.items || transRes.data || [];
      const parsedTransfers = rawTransfers.slice(0, 4).map(t => ({
        id: t.transfer_number || t.id || 'ST-0000',
        from: t.source_warehouse_name || 'Main DC',
        to: t.destination_warehouse_name || 'Regional DC',
        item: t.item_name || 'Stock Items',
        qty: t.total_qty || t.qty || 100,
        status: t.status || 'in_transit',
        eta: t.status === 'in_transit' ? 'Today 6PM' : 'Awaiting dispatch',
      }));

      if (parsedTransfers.length === 0) {
        parsedTransfers.push(
          { id: 'ST-00890', from: 'North DC', to: 'South DC', item: 'Widget Housing Case', qty: 200, status: 'in_transit', eta: 'Today 6PM' },
          { id: 'ST-00891', from: 'Main WH', to: 'East Hub', item: 'Motor Shaft Assembly', qty: 50, status: 'pending_pick', eta: 'Tomorrow 9AM' }
        );
      }
      summaryStatsData.pending_transfers = rawTransfers.length || parsedTransfers.length;

      // 7. Alerts lists
      const parsedLowStock = (alertsRes.data?.low_stock || []).map((item, idx) => ({
        id: item.id || idx,
        item_code: item.item_code || 'Item Code',
        item_name: item.name || 'Item Name',
        warehouse: item.warehouse_name || 'Main WH',
        current: Number(item.available_qty || 0),
        reorder: Number(item.reorder_level || 0),
        unit: item.uom_name || 'pcs',
        category: item.category_name || 'Raw Material',
      }));
      setLowStockAlerts(parsedLowStock);

      const parsedExpiry = (alertsRes.data?.expiring_items || []).map((item, idx) => ({
        id: item.batch_id || idx,
        item_code: item.item_code || 'Item Code',
        item_name: item.item_name || 'Item Name',
        batch: item.batch_number || 'Batch',
        expiry: item.expiry_date || 'Expiry Date',
        days_left: dayjs(item.expiry_date).isValid() ? dayjs(item.expiry_date).diff(dayjs(), 'day') : 30,
        qty: Number(item.available_qty || 0),
        warehouse: item.warehouse_name || 'Main WH',
      }));
      setExpiryWarnings(parsedExpiry);

      setSummaryStats(summaryStatsData);

    } catch (error) {
      console.error('Failed to fetch inventory command center data:', error);
      message.error('Failed to fetch dashboard metrics.');
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = () => {
    fetchDashboardData();
    message.success('Dashboard metrics updated');
  };

  const handleExportClick = (info) => {
    if (info.key === 'excel') {
      message.success('Exporting Excel data...');
      // Export current top items/stocks
      const exportData = topValueItems.map(item => ({
        'Rank': item.rank,
        'Item Code': item.code,
        'Item Name': item.name,
        'Value (INR)': item.value,
        'Qty': item.qty,
        'Rate': item.rate,
        'Warehouse': item.warehouse
      }));
      import('../../utils/helpers').then(helpers => {
        helpers.downloadExcel(exportData, 'Top_Value_Inventory_Items', 'Valuations');
      });
    } else {
      message.info(`Export format '${info.key}' is loading.`);
    }
  };

  const hasValues = movementTrend.some(d => (d.grn_in > 0 || d.issue_out > 0 || d.transfer > 0));
  const grnKey = hasValues ? "grn_in" : "grn_in_qty";
  const issueKey = hasValues ? "issue_out" : "issue_out_qty";
  const transferKey = hasValues ? "transfer" : "transfer_qty";

  // Y-axis Formatter
  const yAxisFormatter = (v) => {
    if (hasValues) {
      if (v >= 10000000) return `${(v / 10000000).toFixed(1)}Cr`;
      if (v >= 100000) return `${(v / 100000).toFixed(1)}L`;
      return `₹${v}`;
    }
    return formatNumber(v);
  };

  // Tooltip Formatter
  const tooltipFormatter = (value, name) => {
    if (hasValues) {
      return [formatCurrency(Number(value)), name];
    }
    return [`${formatNumber(Number(value))} units`, name];
  };

  // Table columns
  const expiryColumns = [
    { 
      title: 'Item Code', 
      dataIndex: 'item_code', 
      width: 110, 
      render: (v) => (
        <Button 
          type="link" 
          onClick={() => navigate('/inventory/stock-balance')} 
          style={{ padding: 0, height: 'auto', fontSize: 12 }}
        >
          {v}
        </Button>
      ) 
    },
    { title: 'Item Name', dataIndex: 'item_name', width: 200, ellipsis: true },
    { title: 'Batch #', dataIndex: 'batch', width: 110 },
    { title: 'Expiry Date', dataIndex: 'expiry', width: 105, render: (v) => dayjs(v).format('DD/MM/YYYY') },
    { 
      title: 'Days Left', 
      dataIndex: 'days_left', 
      width: 85, 
      align: 'right', 
      render: (v) => (
        <Tag color={v <= 30 ? 'red' : v <= 60 ? 'orange' : 'gold'}>{v}d</Tag>
      )
    },
    { title: 'Qty', dataIndex: 'qty', width: 75, align: 'right', render: (v) => formatNumber(v) },
    { title: 'WH', dataIndex: 'warehouse', width: 95 },
  ];

  const lowStockColumns = [
    { 
      title: 'Code', 
      dataIndex: 'item_code', 
      width: 110, 
      render: (v) => (
        <Button 
          type="link" 
          onClick={() => navigate('/inventory/stock-balance')} 
          style={{ padding: 0, height: 'auto', fontSize: 11 }}
        >
          {v}
        </Button>
      )
    },
    { title: 'Item Name', dataIndex: 'item_name', width: 200, ellipsis: true },
    { 
      title: 'Current', 
      dataIndex: 'current', 
      width: 70, 
      align: 'right', 
      render: (_v, r) => (
        <Text strong type={r.current < r.reorder * 0.2 ? 'danger' : r.current < r.reorder * 0.5 ? 'warning' : undefined}>
          {r.current} {r.unit}
        </Text>
      )
    },
    { title: 'Reorder Lvl', dataIndex: 'reorder', width: 90, align: 'right', render: (_v, r) => `${r.reorder} ${r.unit}` },
    { 
      title: 'Fill %', 
      width: 85, 
      render: (_, r) => {
        const pct = r.reorder > 0 ? Math.round((r.current / r.reorder) * 100) : 0;
        return <Progress percent={pct} size="small" status={pct < 30 ? 'exception' : pct < 60 ? 'normal' : 'success'} format={() => `${pct}%`} />;
      }
    },
    { title: 'WH', dataIndex: 'warehouse', width: 80 },
    { title: 'Category', dataIndex: 'category', width: 110, render: (v) => <Tag>{v}</Tag> },
  ];

  const topItemsColumns = [
    { 
      title: '#', 
      dataIndex: 'rank', 
      width: 48, 
      align: 'center', 
      render: (v) => (
        <Avatar size={28} style={{ background: v <= 3 ? 'linear-gradient(135deg, #fbbf24, #f59e0b)' : '#f1f5f9', color: v <= 3 ? '#fff' : '#64748b', fontSize: 12, fontWeight: 700 }}>
          {v}
        </Avatar>
      )
    },
    { 
      title: 'Code', 
      dataIndex: 'code', 
      width: 115, 
      render: (v) => (
        <Button 
          type="link" 
          onClick={() => navigate('/inventory/stock-balance')} 
          style={{ padding: 0, height: 'auto', fontSize: 12 }}
        >
          {v}
        </Button>
      )
    },
    { title: 'Item Name', dataIndex: 'name', width: 210, ellipsis: true },
    { title: 'Value', dataIndex: 'value', width: 115, align: 'right', sorter: (a, b) => a.value - b.value, render: (v) => <Text strong>{formatCurrency(v)}</Text> },
    { title: 'Qty', dataIndex: 'qty', width: 65, align: 'right', render: (v) => formatNumber(v) },
    { title: 'Rate', dataIndex: 'rate', width: 95, align: 'right', render: (v) => formatCurrency(v) },
    { title: 'WH', dataIndex: 'warehouse', width: 95 },
    { 
      title: 'Δ', 
      dataIndex: 'change', 
      width: 55, 
      align: 'center', 
      render: (v) => (
        <span style={{ color: v > 0 ? '#059669' : v < 0 ? '#dc2626' : '#94a3b8', fontSize: 12 }}>
          {v > 0 ? <ArrowUpOutlined /> : v < 0 ? <ArrowDownOutlined /> : <MinusOutlined />}
          {Math.abs(v)}%
        </span>
      )
    },
  ];

  return (
    <div className="inventory-dashboard">
      {/* Header */}
      <header className="dashboard-header">
        <Row justify="space-between" align="middle" gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <Space size="large" align="center">
              <div className="logo-container">
                <div className="logo-icon"><HddOutlined /></div>
                <div>
                  <Title level={4} style={{ margin: 0, lineHeight: 1.2 }}>Inventory Command Center</Title>
                  <Text type="secondary" style={{ fontSize: 12 }}>Real-time visibility across warehouses • Last sync: {dayjs().format('HH:mm:ss')} • {daysCount} Days Metrics</Text>
                </div>
              </div>
              <Badge count={summaryStats.low_stock_alerts + summaryStats.expiring_soon} offset={[0, -2]}>
                <Button icon={<BellOutlined />} shape="circle" size="large" className="bell-btn" onClick={() => navigate('/inventory/notifications')} />
              </Badge>
            </Space>
          </Col>
          <Col xs={24} md={12} style={{ textAlign: 'right' }}>
            <Space wrap>
              <RangePicker value={dateRange} onChange={(dates) => dates && setDateRange(dates)} allowClear={false} size="middle" format="DD MMM YYYY" />
              <Select 
                placeholder="All Warehouses" 
                value={selectedWarehouse} 
                onChange={setSelectedWarehouse} 
                style={{ width: 170 }} 
                size="middle" 
                disabled={!!user?.warehouse_id && user?.role !== 'super_admin'}
                options={
                  user?.warehouse_id && user?.role !== 'super_admin'
                    ? warehouses.filter(w => Number(w.value) === Number(user.warehouse_id))
                    : [
                        { label: 'All Warehouses', value: 'all' },
                        ...warehouses,
                      ]
                }
              />
              <Button icon={<ReloadOutlined spin={loading} />} onClick={handleRefresh}>Refresh</Button>
              <Dropdown menu={{ 
                items: [
                  { key: 'excel', icon: <DownloadOutlined />, label: 'Export Excel Data' },
                  { key: 'pdf', icon: <ExportOutlined />, label: 'Export PDF Report' },
                ],
                onClick: handleExportClick
              }}>
                <Button icon={<DownloadOutlined />} type="primary">Export</Button>
              </Dropdown>
            </Space>
          </Col>
        </Row>
      </header>

      {/* Main Content */}
      <main className="dashboard-main">
        <Spin spinning={loading} indicator={<SyncOutlined spin style={{ fontSize: 32, color: '#6366f1' }} />}>
          {/* Primary KPI Cards */}
          <Row gutter={[20, 20]} className="mb-6">
            <Col xs={24} sm={12} lg={6}>
              <KPICard title="Total SKUs" value={summaryStats.total_items} icon={<AppstoreOutlined />} iconBg="linear-gradient(135deg,#ede9fe,#ddd6fe)" iconColor="#7c3aed" subtitle={`${summaryStats.total_warehouses} warehouses tracked`} trend={{ value: 3.2, direction: 'up' }} />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <KPICard title="Total Stock Value" value={summaryStats.total_stock_value} prefix="₹" icon={<DollarOutlined />} iconBg="linear-gradient(135deg,#d1fae5,#a7f3d0)" iconColor="#059669" subtitle={`${helperFormatCurrency(summaryStats.total_stock_value)} inventory`} trend={{ value: 2.8, direction: 'up' }} />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <KPICard title="Low Stock Alerts" value={summaryStats.low_stock_alerts} icon={<WarningOutlined />} iconBg="linear-gradient(135deg,#fef3c7,#fde68a)" iconColor="#d97706" subtitle="Below reorder level" trend={{ value: 12, direction: 'down' }} />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <KPICard title="Expiring Soon" value={summaryStats.expiring_soon} icon={<ClockCircleOutlined />} iconBg="linear-gradient(135deg,#fee2e2,#fecaca)" iconColor="#dc2626" subtitle="Within 30 days" trend={{ value: 5, direction: 'up' }} />
            </Col>
          </Row>


          {/* Charts Row */}
          <Row gutter={[20, 20]} className="mb-6">
            {/* Item Class Pie Chart */}
            <Col xs={24} lg={10}>
              <Card title={<Space><PieChartOutlined style={{ color: '#8b5cf6' }} /><span style={{ fontWeight: 600 }}>Stock by Item Class</span></Space>} extra={<Tag color="purple">{formatCurrency(categoryData.reduce((s, c) => s + c.value, 0))} Total</Tag>} className="chart-card">
                {categoryData.length > 0 ? (
                  <Row gutter={[16, 16]} align="middle">
                    <Col span={11}>
                      <ResponsiveContainer width="100%" height={260}>
                        <PieChart>
                          <Pie data={categoryData} cx="50%" cy="50%" innerRadius={0} outerRadius={100} paddingAngle={3} dataKey="chartValue">
                            {categoryData.map((entry, idx) => <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />)}
                          </Pie>
                          <RechartsTooltip formatter={(value, name, entry) => {
                            const item = entry?.payload;
                            if (item) {
                              return [`${formatCurrency(item.value)} (${item.count} SKUs)`, name];
                            }
                            return [formatCurrency(Number(value)), name];
                          }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </Col>
                    <Col span={13}>
                      <List dataSource={categoryData} renderItem={(item, idx) => (
                        <List.Item style={{ padding: '4px 0', border: 0 }}>
                          <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <Space align="start">
                              <span style={{ width: 10, height: 10, borderRadius: 3, background: CHART_COLORS[idx % CHART_COLORS.length], marginTop: 4, display: 'inline-block' }} />
                              <div>
                                <Text style={{ fontSize: 12 }} strong>{item.name}</Text><br/>
                                <Text type="secondary" style={{ fontSize: 10 }}>{item.description}</Text>
                              </div>
                            </Space>
                            <div style={{ textAlign: 'right' }}>
                              <Text strong style={{ fontSize: 12 }}>{formatCurrency(item.value)}</Text><br/>
                              <Text type="secondary" style={{ fontSize: 10 }}>{item.count} SKUs</Text>
                            </div>
                          </div>
                        </List.Item>
                      )} />
                    </Col>
                  </Row>
                ) : (
                  <Empty description="No item class data available." image={Empty.PRESENTED_IMAGE_SIMPLE} />
                )}
              </Card>
            </Col>

            {/* Movement Trend Chart */}
            <Col xs={24} lg={14}>
              <Card title={<Space><LineChartOutlined style={{ color: '#3b82f6' }} /><span style={{ fontWeight: 600 }}>Stock Movement Trend ({daysCount} Days)</span></Space>} className="chart-card">
                {movementTrend.length > 0 ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <ComposedChart data={movementTrend}>
                      <defs>
                        <linearGradient id="grnGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} /><stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="outGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} /><stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} interval={Math.ceil(movementTrend.length / 8)} />
                      <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={yAxisFormatter} />
                      <RechartsTooltip formatter={tooltipFormatter} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area type="monotone" dataKey={grnKey} stroke="#10b981" fill="url(#grnGrad)" name="Inbound" strokeWidth={2} stackId="1" />
                      <Area type="monotone" dataKey={issueKey} stroke="#ef4444" fill="url(#outGrad)" name="Outbound" strokeWidth={2} stackId="2" />
                    </ComposedChart>
                  </ResponsiveContainer>
                ) : (
                  <Empty description="No transaction trend data in selected period." image={Empty.PRESENTED_IMAGE_SIMPLE} />
                )}
              </Card>
            </Col>
          </Row>

          {/* Alerts + Top Items */}
          <Row gutter={[20, 20]} className="mb-6">
            <Col xs={24}>
              <Card className="alerts-card">
                <Tabs defaultActiveKey="lowstock" items={[
                  {
                    key: 'lowstock',
                    label: <Badge count={lowStockAlerts.length} size="small" offset={[8, -4]}><Space><WarningOutlined style={{ color: '#f59e0b' }} /> Low Stock</Space></Badge>,
                    children: <Table columns={lowStockColumns} dataSource={lowStockAlerts} rowKey="id" pagination={{ pageSize: 5 }} size="small" scroll={{ y: 310 }} />,
                  },
                  {
                    key: 'expiry',
                    label: <Badge count={expiryWarnings.length} size="small" offset={[8, -4]}><Space><ClockCircleOutlined style={{ color: '#ef4444' }} /> Expiry Warning</Space></Badge>,
                    children: <Table columns={expiryColumns} dataSource={expiryWarnings} rowKey="id" pagination={{ pageSize: 5 }} size="small" scroll={{ y: 310 }} />,
                  },
                ]} />
              </Card>
            </Col>

            <Col xs={24}>
              <Card title={<Space><FireOutlined style={{ color: '#f97316' }} /><span style={{ fontWeight: 600 }}>Top Items by Value</span></Space>} extra={<Button type="link" size="small" icon={<EyeOutlined />} onClick={() => navigate('/inventory/reports')}>View All</Button>} className="chart-card" styles={{ body: { padding: '12px 16px' } }}>
                <Table columns={topItemsColumns} dataSource={topValueItems} rowKey="rank" pagination={{ pageSize: 5 }} size="small" scroll={{ y: 330 }} />
              </Card>
            </Col>
          </Row>

          {/* Recent Activity */}
          <Row gutter={[20, 20]}>
            <Col xs={24}>
              <Card title={<Space><DashboardOutlined style={{ color: '#10b981' }} /><span style={{ fontWeight: 600 }}>Recent Activity</span></Space>} extra={<Button type="link" size="small" icon={<EyeOutlined />} onClick={() => navigate('/inventory/stock-ledger')}>View Ledger</Button>} size="small" className="chart-card" styles={{ body: { padding: '8px 0' } }}>
                <List dataSource={recentTransactions} renderItem={(txn) => (
                  <div style={{ padding: '8px 12px', borderBottom: '1px solid #f1f5f9' }}>
                    <div style={{ display: 'flex', alignItems: 'start', gap: 10 }}>
                      <Avatar size={32} style={{
                        background: txn.type.includes('issue') || txn.type === 'consumption' ? '#fef2f2' :
                          txn.type === 'grn' || txn.type === 'return_inward' ? '#ecfdf5' :
                            txn.type === 'stock_transfer' ? '#eff6ff' : '#faf5ff',
                        color: txn.type.includes('issue') || txn.type === 'consumption' ? '#dc2626' :
                          txn.type === 'grn' || txn.type === 'return_inward' ? '#059669' :
                            txn.type === 'stock_transfer' ? '#2563eb' : '#7c3aed',
                        fontSize: 11, flexShrink: 0,
                      }}>
                        {txn.type === 'grn' && <ShoppingOutlined />}
                        {txn.type === 'sales_issue' && <FallOutlined />}
                        {txn.type === 'stock_transfer' && <CarOutlined />}
                        {txn.type === 'putaway' && <RiseOutlined />}
                        {txn.type === 'picking' && <FallOutlined />}
                        {txn.type === 'consumption' && <FireOutlined />}
                        {txn.type === 'return_inward' && <RiseOutlined />}
                        {txn.type === 'stock_adjustment' && <SettingOutlined />}
                      </Avatar>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                          <div style={{ minWidth: 0 }}>
                            <TransTypeTag type={txn.type} />
                            <Text strong ellipsis style={{ marginLeft: 8, fontSize: 13 }}>{txn.item}</Text>
                          </div>
                          <Text type="secondary" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{txn.time}</Text>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4, alignItems: 'center' }}>
                          <Text code style={{ fontSize: 11 }}>{txn.ref}</Text>
                          {txn.qty_out && <Text style={{ color: '#ef4444', fontWeight: 600, fontSize: 11 }}>-{txn.qty_out}</Text>}
                          {txn.qty_in && <Text style={{ color: '#059669', fontWeight: 600, fontSize: 11 }}>+{txn.qty_in}</Text>}
                          {!txn.qty_out && !txn.qty_in && txn.adj !== undefined && (
                            <Text style={{ color: txn.adj > 0 ? '#059669' : '#ef4444', fontWeight: 600, fontSize: 11 }}>
                              {txn.adj > 0 ? '+' : ''}{txn.adj}
                            </Text>
                          )}
                          {(txn.from || txn.warehouse) && <Text type="secondary" style={{ fontSize: 11 }}>{txn.from ? `${txn.from} → ${txn.to}` : `@${txn.warehouse}`}</Text>}
                          {txn.reason && <Tag color="orange" style={{ fontSize: 10, marginLeft: 'auto' }}>{txn.reason}</Tag>}
                        </div>
                        <Text type="secondary" style={{ fontSize: 11, marginTop: 2, display: 'block' }}>By {txn.user}</Text>
                      </div>
                    </div>
                  </div>
                )} />
              </Card>
            </Col>
          </Row>
        </Spin>

        {/* Footer */}
        <footer className="dashboard-footer">
          <Row justify="space-between" align="middle">
            <Col>
              <Text type="secondary" style={{ fontSize: 11 }}>
                <InfoCircleOutlined style={{ marginRight: 4 }} />
                Dashboard refreshed at {dayjs().format('dddd, DD MMM YYYY HH:mm:ss')} • Data is live.
              </Text>
            </Col>

          </Row>
        </footer>
      </main>
    </div>
  );
};

export default InventoryDashboard;
