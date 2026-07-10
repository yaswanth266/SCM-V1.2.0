import React, { useState, useCallback, useEffect } from 'react';
import {
  Select, DatePicker, Button, Space, Card, Row, Col, Tag, message,
} from 'antd';
import useAuthStore from '../../../store/authStore';
import {
  DownloadOutlined, PrinterOutlined, FilterOutlined, ReloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../../components/PageHeader';
import DataTable from '../../../components/DataTable';
import api from '../../../config/api';
import { formatCurrency, formatNumber, formatDate, formatDateForAPI, getErrorMessage, downloadExcel } from '../../../utils/helpers';
import { DATE_FORMAT } from '../../../utils/constants';

const { RangePicker } = DatePicker;

const REPORT_TYPES = [
  { label: 'Stock Summary Report', value: 'stock_summary' },
  { label: 'Stock Movement Report', value: 'stock_movement' },
  { label: 'Low Stock Report', value: 'low_stock' },
  { label: 'Expiry Report', value: 'expiry' },
];

const InventoryReports = () => {
  const user = useAuthStore((s) => s.user);
  const [reportType, setReportType] = useState('stock_summary');
  const [warehouse, setWarehouse] = useState(user?.warehouse_id || undefined);
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
        api.get('/masters/warehouses', { params: { page_size: 500, exclude_virtual: true } }),
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
      if (reportType === 'stock_summary') {
        queryParams.group_by_warehouse = true;
      }
      if (warehouse) queryParams.warehouse_id = warehouse;
      if (category) queryParams.category_id = category;
      if (item) queryParams.item_id = item;
      if (project) queryParams.project_id = project;
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }
      const res = await api.get('/inventory/reports', { params: queryParams });
      return res;
    },
    [reportType, warehouse, category, item, project, dateRange]
  );

  const handleExport = async () => {
    try {
      const queryParams = { report_type: reportType, page_size: 50000 };
      if (reportType === 'stock_summary') {
        queryParams.group_by_warehouse = true;
      }
      if (warehouse) queryParams.warehouse_id = warehouse;
      if (category) queryParams.category_id = category;
      if (item) queryParams.item_id = item;
      if (project) queryParams.project_id = project;
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }
      const res = await api.get('/inventory/reports', { params: queryParams });
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
          { title: 'Item Name', dataIndex: 'name', key: 'name', width: 200, ellipsis: true },
          { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 150 },
          { title: 'Total Qty', dataIndex: 'total_qty', key: 'total_qty', width: 100, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Available Qty', dataIndex: 'available_qty', key: 'available_qty', width: 115, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Reserved Qty', dataIndex: 'reserved_qty', key: 'reserved_qty', width: 115, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Stock Value', dataIndex: 'stock_value', key: 'stock_value', width: 120, align: 'right', render: (v) => formatCurrency(v) },
        ];

      case 'stock_movement':
        return [
          { title: 'Date', dataIndex: 'posting_date', key: 'posting_date', width: 160, render: (v) => formatDate(v) },
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse_name', width: 150 },
          { title: 'Transaction Type', dataIndex: 'transaction_type', key: 'transaction_type', width: 140 },
          { title: 'Quantity In', dataIndex: 'qty_in', key: 'qty_in', width: 110, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Quantity Out', dataIndex: 'qty_out', key: 'qty_out', width: 110, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Balance Qty', dataIndex: 'balance_qty', key: 'balance_qty', width: 110, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Rate', dataIndex: 'rate', key: 'rate', width: 100, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Ref Type', dataIndex: 'reference_type', key: 'reference_type', width: 120 },
          { title: 'Ref Number', dataIndex: 'reference_number', key: 'reference_number', width: 150 },
        ];

      case 'low_stock':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'name', key: 'name', width: 200, ellipsis: true },
          { title: 'Available Qty', dataIndex: 'available_qty', key: 'available_qty', width: 120, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Reorder Level', dataIndex: 'reorder_level', key: 'reorder_level', width: 120, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Safety Stock', dataIndex: 'safety_stock', key: 'safety_stock', width: 110, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Reorder Qty', dataIndex: 'reorder_qty', key: 'reorder_qty', width: 110, align: 'right', render: (v) => formatNumber(v) },
        ];

      case 'expiry':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Batch Number', dataIndex: 'batch_number', key: 'batch', width: 140 },
          { title: 'Expiry Date', dataIndex: 'expiry_date', key: 'expiry_date', width: 110, render: (v) => formatDate(v) },
          { title: 'Available Qty', dataIndex: 'available_qty', key: 'available_qty', width: 120, align: 'right', render: (v) => formatNumber(v) },
        ];

      default:
        return [];
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
        rowKey={(record) => {
          if (reportType === 'expiry') {
            return `${record.batch_id || ''}_${record.item_id || ''}`;
          }
          if (reportType === 'stock_summary') {
            return `${record.id || ''}_${record.warehouse_id || ''}`;
          }
          return record.id || record.batch_id || record.item_id || Math.random().toString();
        }}
        searchPlaceholder="Search report data..."
        exportFileName={`inventory_${reportType}`}
        scroll={{ x: 1200 }}
      />
    </div>
  );
};

export default InventoryReports;
