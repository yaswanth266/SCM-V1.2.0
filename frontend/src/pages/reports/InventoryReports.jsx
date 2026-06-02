import React, { useState, useCallback, useEffect } from 'react';
import {
  Select, DatePicker, Button, Space, Card, Row, Col, Tag, message,
} from 'antd';
import {
  DownloadOutlined, PrinterOutlined, FilterOutlined, ReloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import api from '../../config/api';
import { formatCurrency, formatNumber, formatDate, formatDateForAPI, getErrorMessage, downloadExcel } from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { RangePicker } = DatePicker;

const REPORT_TYPES = [
  { label: 'Stock Summary', value: 'stock_summary' },
  { label: 'Stock Detail', value: 'stock_detail' },
  { label: 'Inventory Aging Summary', value: 'inventory_aging' },
  { label: 'Inventory Valuation Summary', value: 'inventory_valuation' },
  { label: 'Inventory Turnover By Qty', value: 'turnover_qty' },
  { label: 'Inventory Turnover By Amount', value: 'turnover_amount' },
  { label: 'FIFO Cost Lot Tracking', value: 'fifo_cost' },
  { label: 'ABC Classification', value: 'abc_classification' },
  { label: 'Batch Details', value: 'batch_details' },
  { label: 'Serial Number Details', value: 'serial_details' },
  { label: 'Warehouse-wise Balance', value: 'warehouse_balance' },
  { label: 'Category-wise Balance per Project', value: 'category_project_balance' },
  { label: 'Reorder Level Report', value: 'reorder_level' },
  { label: 'Expiry / FEFO Report', value: 'expiry_fefo' },
  { label: 'Dead Stock', value: 'dead_stock' },
  { label: 'Inventory Adjustment Summary', value: 'adjustment_summary' },
  { label: 'Transit Stock Details', value: 'committed_stock' },
];

const InventoryReports = () => {
  const [reportType, setReportType] = useState('stock_summary');
  const [warehouse, setWarehouse] = useState(undefined);
  const [category, setCategory] = useState(undefined);
  const [dateRange, setDateRange] = useState(null);
  const [item, setItem] = useState(undefined);
  const [project, setProject] = useState(undefined);
  const [refreshKey, setRefreshKey] = useState(0);
  const [warehouses, setWarehouses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [items, setItems] = useState([]);
  const [projects, setProjects] = useState([]);

  useEffect(() => {
    fetchLookups();
  }, []);

  const fetchLookups = async () => {
    try {
      const [wRes, cRes, iRes] = await Promise.allSettled([
        api.get('/masters/warehouses', { params: { page_size: 500 } }),
        api.get('/masters/categories', { params: { page_size: 500 } }),
        api.get('/masters/items', { params: { page_size: 500 } }),
      ]);
      if (wRes.status === 'fulfilled') {
        const d = wRes.value.data;
        setWarehouses((d.items || d.data || d || []).map((w) => ({ label: w.name, value: w.id })));
      }
      if (cRes.status === 'fulfilled') {
        const d = cRes.value.data;
        setCategories((d.items || d.data || d || []).map((c) => ({ label: c.name, value: c.id })));
      }
      if (iRes.status === 'fulfilled') {
        const d = iRes.value.data;
        setItems((d.items || d.data || d || []).map((i) => ({ label: `${i.item_code} - ${i.name}`, value: i.id })));
      }
    } catch {
      // silent
    }
  };

  const fetchReport = useCallback(
    async (params) => {
      const queryParams = { ...params, report_type: reportType };
      if (warehouse) queryParams.warehouse_id = warehouse;
      if (category) queryParams.category_id = category;
      if (item) queryParams.item_id = item;
      if (project) queryParams.project_id = project;
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }
      const res = await api.get('/reports/inventory', { params: queryParams });
      return res;
    },
    [reportType, warehouse, category, item, project, dateRange]
  );

  const handleExport = async () => {
    try {
      const queryParams = { report_type: reportType, page_size: 50000 };
      if (warehouse) queryParams.warehouse_id = warehouse;
      if (category) queryParams.category_id = category;
      if (item) queryParams.item_id = item;
      if (project) queryParams.project_id = project;
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }
      const res = await api.get('/reports/inventory', { params: queryParams });
      const data = res.data;
      const rows = data.items || data.data || data || [];
      const cols = getColumns();
      const exportData = rows.map((row) => {
        const exp = {};
        cols.forEach((c) => {
          if (c.dataIndex && c.title) {
            const key = typeof c.dataIndex === 'string' ? c.dataIndex : c.dataIndex.join('.');
            let val = row;
            if (typeof c.dataIndex === 'string') {
              val = row[c.dataIndex];
            } else if (Array.isArray(c.dataIndex)) {
              val = c.dataIndex.reduce((o, k) => (o ? o[k] : undefined), row);
            }
            exp[typeof c.title === 'string' ? c.title : key] = val;
          }
        });
        return exp;
      });
      const label = REPORT_TYPES.find((r) => r.value === reportType)?.label || reportType;
      downloadExcel(exportData, `inventory_${reportType}`, label);
      message.success('Export completed');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const applyFilters = () => {
    setRefreshKey((k) => k + 1);
  };

  const getColumns = () => {
    switch (reportType) {
      case 'stock_summary':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130, sorter: true },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 150 },
          { title: 'Quantity', dataIndex: 'qty', key: 'qty', width: 100, align: 'right', render: (v) => formatNumber(v) },
          { title: 'UOM', dataIndex: 'uom', key: 'uom', width: 80 },
          { title: 'Value', dataIndex: 'value', key: 'value', width: 130, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Reorder Level', dataIndex: 'reorder_level', key: 'reorder_level', width: 120, align: 'right', render: (v) => formatNumber(v) },
          {
            title: 'Status', key: 'stock_status', width: 100,
            render: (_, r) => {
              if (r.qty <= 0) return <Tag color="red">Out of Stock</Tag>;
              if (r.reorder_level && r.qty <= r.reorder_level) return <Tag color="orange">Low Stock</Tag>;
              return <Tag color="green">In Stock</Tag>;
            },
          },
        ];

      case 'inventory_aging':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Total Qty', dataIndex: 'qty', key: 'qty', width: 100, align: 'right', render: (v) => formatNumber(v) },
          { title: '0-30 Days', dataIndex: 'days_0_30', key: 'days_0_30', width: 100, align: 'right', render: (v) => formatNumber(v) },
          { title: '31-60 Days', dataIndex: 'days_31_60', key: 'days_31_60', width: 100, align: 'right', render: (v) => formatNumber(v) },
          { title: '61-90 Days', dataIndex: 'days_61_90', key: 'days_61_90', width: 100, align: 'right', render: (v) => formatNumber(v) },
          {
            title: '90+ Days', dataIndex: 'days_90_plus', key: 'days_90_plus', width: 100, align: 'right',
            render: (v) => <span style={{ color: v > 0 ? '#f5222d' : undefined, fontWeight: v > 0 ? 600 : 400 }}>{formatNumber(v)}</span>,
          },
          { title: 'Total Value', dataIndex: 'total_value', key: 'total_value', width: 130, align: 'right', render: (v) => formatCurrency(v) },
        ];

      case 'abc_classification':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Annual Consumption Value', dataIndex: 'annual_value', key: 'annual_value', width: 180, align: 'right', render: (v) => formatCurrency(v), sorter: true },
          {
            title: 'Class', dataIndex: 'classification', key: 'classification', width: 80, align: 'center',
            render: (v) => {
              const colorMap = { A: 'red', B: 'orange', C: 'green' };
              return <Tag color={colorMap[v] || 'default'} style={{ fontWeight: 700 }}>{v}</Tag>;
            },
          },
          { title: 'Cumulative %', dataIndex: 'cumulative_pct', key: 'cumulative_pct', width: 120, align: 'right', render: (v) => v != null ? `${Number(v).toFixed(1)}%` : '-' },
          { title: 'Item %', dataIndex: 'item_pct', key: 'item_pct', width: 100, align: 'right', render: (v) => v != null ? `${Number(v).toFixed(1)}%` : '-' },
        ];

      case 'expiry_fefo':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Batch', dataIndex: 'batch_number', key: 'batch', width: 120 },
          { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 150 },
          { title: 'Expiry Date', dataIndex: 'expiry_date', key: 'expiry_date', width: 120, render: (v) => formatDate(v), sorter: true },
          {
            title: 'Days to Expiry', dataIndex: 'days_to_expiry', key: 'days_to_expiry', width: 130, align: 'right',
            render: (v) => {
              if (v == null) return '-';
              let color = '#52c41a';
              if (v < 0) color = '#f5222d';
              else if (v <= 30) color = '#fa8c16';
              else if (v <= 90) color = '#faad14';
              return <span style={{ color, fontWeight: 600 }}>{v < 0 ? `Expired (${Math.abs(v)} days)` : `${v} days`}</span>;
            },
            sorter: true,
          },
          { title: 'Quantity', dataIndex: 'qty', key: 'qty', width: 100, align: 'right', render: (v) => formatNumber(v) },
          {
            title: 'Status', key: 'expiry_status', width: 100,
            render: (_, r) => {
              if (r.days_to_expiry < 0) return <Tag color="red">Expired</Tag>;
              if (r.days_to_expiry <= 30) return <Tag color="orange">Expiring Soon</Tag>;
              return <Tag color="green">OK</Tag>;
            },
          },
        ];

      case 'inventory_valuation':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130, sorter: true },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 150 },
          { title: 'Quantity', dataIndex: 'qty', key: 'qty', width: 100, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Avg Cost', dataIndex: 'avg_cost', key: 'avg_cost', width: 120, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Total Value', dataIndex: 'total_value', key: 'total_value', width: 140, align: 'right', render: (v) => formatCurrency(v), sorter: true },
          { title: 'Category', dataIndex: 'category_name', key: 'category', width: 140 },
        ];

      case 'turnover_qty':
      case 'turnover_amount':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Opening', dataIndex: 'opening', key: 'opening', width: 110, align: 'right', render: (v) => reportType === 'turnover_amount' ? formatCurrency(v) : formatNumber(v) },
          { title: 'Inward', dataIndex: 'inward', key: 'inward', width: 110, align: 'right', render: (v) => reportType === 'turnover_amount' ? formatCurrency(v) : formatNumber(v) },
          { title: 'Outward', dataIndex: 'outward', key: 'outward', width: 110, align: 'right', render: (v) => reportType === 'turnover_amount' ? formatCurrency(v) : formatNumber(v) },
          { title: 'Closing', dataIndex: 'closing', key: 'closing', width: 110, align: 'right', render: (v) => reportType === 'turnover_amount' ? formatCurrency(v) : formatNumber(v) },
          { title: 'Turnover Ratio', dataIndex: 'turnover_ratio', key: 'turnover_ratio', width: 130, align: 'right', render: (v) => v != null ? Number(v).toFixed(2) : '-' },
        ];

      case 'fifo_cost':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Lot / Batch', dataIndex: 'lot_number', key: 'lot', width: 120 },
          { title: 'Receipt Date', dataIndex: 'receipt_date', key: 'receipt_date', width: 120, render: (v) => formatDate(v) },
          { title: 'Qty', dataIndex: 'qty', key: 'qty', width: 80, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Unit Cost', dataIndex: 'unit_cost', key: 'unit_cost', width: 120, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Total Cost', dataIndex: 'total_cost', key: 'total_cost', width: 130, align: 'right', render: (v) => formatCurrency(v) },
        ];

      case 'batch_details':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Batch Number', dataIndex: 'batch_number', key: 'batch', width: 140 },
          { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 150 },
          { title: 'Mfg Date', dataIndex: 'mfg_date', key: 'mfg_date', width: 110, render: (v) => formatDate(v) },
          { title: 'Expiry Date', dataIndex: 'expiry_date', key: 'expiry_date', width: 110, render: (v) => formatDate(v) },
          { title: 'Quantity', dataIndex: 'qty', key: 'qty', width: 100, align: 'right', render: (v) => formatNumber(v) },
        ];

      case 'serial_details':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Serial Number', dataIndex: 'serial_number', key: 'serial', width: 160 },
          { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 150 },
          { title: 'Status', dataIndex: 'status', key: 'status', width: 100, render: (v) => <Tag color={v === 'active' ? 'green' : 'default'}>{v || '-'}</Tag> },
          { title: 'Received Date', dataIndex: 'received_date', key: 'received_date', width: 120, render: (v) => formatDate(v) },
        ];

      case 'warehouse_balance':
        return [
          { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 180 },
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Quantity', dataIndex: 'qty', key: 'qty', width: 100, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Value', dataIndex: 'value', key: 'value', width: 130, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'UOM', dataIndex: 'uom', key: 'uom', width: 80 },
        ];

      case 'category_project_balance':
        return [
          { title: 'Category', dataIndex: 'category_name', key: 'category', width: 160 },
          { title: 'Project', dataIndex: 'project_name', key: 'project', width: 160 },
          { title: 'Item Count', dataIndex: 'item_count', key: 'item_count', width: 110, align: 'right' },
          { title: 'Total Qty', dataIndex: 'total_qty', key: 'total_qty', width: 110, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Total Value', dataIndex: 'total_value', key: 'total_value', width: 140, align: 'right', render: (v) => formatCurrency(v) },
        ];

      case 'reorder_level':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 150 },
          { title: 'Current Qty', dataIndex: 'current_qty', key: 'current_qty', width: 110, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Reorder Level', dataIndex: 'reorder_level', key: 'reorder_level', width: 120, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Safety Stock', dataIndex: 'safety_stock', key: 'safety_stock', width: 110, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Reorder Qty', dataIndex: 'reorder_qty', key: 'reorder_qty', width: 110, align: 'right', render: (v) => formatNumber(v) },
          {
            title: 'Status', key: 'reorder_status', width: 120,
            render: (_, r) => {
              if (r.current_qty <= 0) return <Tag color="red">Out of Stock</Tag>;
              if (r.current_qty <= (r.safety_stock || 0)) return <Tag color="red">Critical</Tag>;
              if (r.current_qty <= (r.reorder_level || 0)) return <Tag color="orange">Reorder</Tag>;
              return <Tag color="green">OK</Tag>;
            },
          },
        ];

      case 'dead_stock':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 150 },
          { title: 'Quantity', dataIndex: 'qty', key: 'qty', width: 100, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Value', dataIndex: 'value', key: 'value', width: 130, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Last Movement', dataIndex: 'last_movement_date', key: 'last_movement', width: 130, render: (v) => formatDate(v) },
          { title: 'Days Idle', dataIndex: 'days_idle', key: 'days_idle', width: 100, align: 'right', render: (v) => <span style={{ color: '#f5222d', fontWeight: 600 }}>{v}</span> },
        ];

      case 'adjustment_summary':
        return [
          { title: 'Date', dataIndex: 'adjustment_date', key: 'date', width: 120, render: (v) => formatDate(v), sorter: true },
          { title: 'Adjustment #', dataIndex: 'adjustment_number', key: 'adj_no', width: 150 },
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 150 },
          { title: 'Adj Qty', dataIndex: 'adjusted_qty', key: 'adj_qty', width: 100, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Reason', dataIndex: 'reason', key: 'reason', width: 180, ellipsis: true },
          { title: 'Adjusted By', dataIndex: 'adjusted_by', key: 'adjusted_by', width: 130 },
        ];

      case 'committed_stock':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 150 },
          { title: 'Available Qty', dataIndex: 'available_qty', key: 'available', width: 120, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Transit Qty', dataIndex: 'transit_qty', key: 'committed', width: 120, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Ordered Qty', dataIndex: 'ordered_qty', key: 'ordered', width: 120, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Net Available', dataIndex: 'net_available', key: 'net', width: 120, align: 'right', render: (v) => formatNumber(v) },
        ];

      case 'stock_detail':
      default:
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130, sorter: true },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Category', dataIndex: 'category_name', key: 'category', width: 140 },
          { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 150 },
          { title: 'Batch', dataIndex: 'batch_number', key: 'batch', width: 120 },
          { title: 'Quantity', dataIndex: 'qty', key: 'qty', width: 100, align: 'right', render: (v) => formatNumber(v) },
          { title: 'UOM', dataIndex: 'uom', key: 'uom', width: 80 },
          { title: 'Rate', dataIndex: 'rate', key: 'rate', width: 110, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Value', dataIndex: 'value', key: 'value', width: 130, align: 'right', render: (v) => formatCurrency(v) },
        ];
    }
  };

  return (
    <div>
      <PageHeader
        title="Inventory Reports"
        subtitle={REPORT_TYPES.find((r) => r.value === reportType)?.label || 'Select a report'}
      >
        <Button icon={<DownloadOutlined />} onClick={handleExport}>Export to Excel</Button>
      </PageHeader>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={[12, 12]} align="middle">
          <Col xs={24} sm={12} md={8} lg={6}>
            <Select
              placeholder="Select Report"
              style={{ width: '100%' }}
              value={reportType}
              onChange={(v) => { setReportType(v); setRefreshKey((k) => k + 1); }}
              options={REPORT_TYPES}
              showSearch
              optionFilterProp="label"
            />
          </Col>
          <Col xs={24} sm={12} md={8} lg={4}>
            <Select
              placeholder="Warehouse"
              allowClear
              style={{ width: '100%' }}
              value={warehouse}
              onChange={setWarehouse}
              options={warehouses}
              showSearch
              optionFilterProp="label"
            />
          </Col>
          <Col xs={24} sm={12} md={8} lg={4}>
            <Select
              placeholder="Category"
              allowClear
              style={{ width: '100%' }}
              value={category}
              onChange={setCategory}
              options={categories}
              showSearch
              optionFilterProp="label"
            />
          </Col>
          <Col xs={24} sm={12} md={8} lg={4}>
            <Select
              placeholder="Item"
              allowClear
              style={{ width: '100%' }}
              value={item}
              onChange={setItem}
              options={items}
              showSearch
              optionFilterProp="label"
            />
          </Col>
          <Col xs={24} sm={12} md={8} lg={4}>
            <RangePicker
              style={{ width: '100%' }}
              value={dateRange}
              onChange={setDateRange}
              format={DATE_FORMAT}
            />
          </Col>
          <Col xs={24} sm={12} md={4} lg={2}>
            <Button type="primary" icon={<FilterOutlined />} onClick={applyFilters} block>Apply</Button>
          </Col>
        </Row>
      </Card>

      <DataTable
        key={`${reportType}_${refreshKey}`}
        columns={getColumns()}
        fetchFunction={fetchReport}
        rowKey="id"
        searchPlaceholder="Search report data..."
        exportFileName={`inventory_${reportType}`}
        scroll={{ x: 1200 }}
      />
    </div>
  );
};

export default InventoryReports;
