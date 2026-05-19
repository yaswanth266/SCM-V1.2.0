import React, { useState, useCallback, useEffect } from 'react';
import {
  Select, DatePicker, Button, Card, Row, Col, Tag, message,
} from 'antd';
import { DownloadOutlined, FilterOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { formatCurrency, formatNumber, formatDate, formatDateForAPI, getErrorMessage, downloadExcel } from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { RangePicker } = DatePicker;

const REPORT_TYPES = [
  { label: 'PO Details', value: 'po_details' },
  { label: 'PO by Vendor', value: 'po_by_vendor' },
  { label: 'Active POs', value: 'active_pos' },
  { label: 'Purchases by Item', value: 'purchases_by_item' },
  { label: 'Purchases by Category', value: 'purchases_by_category' },
  { label: 'Receive History', value: 'receive_history' },
  { label: 'GRN Details', value: 'grn_details' },
  { label: 'Vendor Balance Summary', value: 'vendor_balance' },
  { label: 'Payments Made', value: 'payments_made' },
];

const ProcurementReports = () => {
  const [reportType, setReportType] = useState('po_details');
  const [vendor, setVendor] = useState(undefined);
  const [dateRange, setDateRange] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [vendors, setVendors] = useState([]);

  useEffect(() => {
    fetchLookups();
  }, []);

  const fetchLookups = async () => {
    try {
      const res = await api.get('/masters/vendors', { params: { page_size: 500 } });
      const d = res.data;
      setVendors((d.items || d.data || d || []).map((v) => ({ label: v.name, value: v.id })));
    } catch { /* silent */ }
  };

  const fetchReport = useCallback(
    async (params) => {
      const queryParams = { ...params, report_type: reportType };
      if (vendor) queryParams.vendor_id = vendor;
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }
      return await api.get('/reports/procurement', { params: queryParams });
    },
    [reportType, vendor, dateRange]
  );

  const handleExport = async () => {
    try {
      const queryParams = { report_type: reportType, page_size: 50000 };
      if (vendor) queryParams.vendor_id = vendor;
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }
      const res = await api.get('/reports/procurement', { params: queryParams });
      const data = res.data;
      const rows = data.items || data.data || data || [];
      const cols = getColumns();
      const exportData = rows.map((row) => {
        const exp = {};
        cols.forEach((c) => {
          if (c.dataIndex && c.title) {
            const key = typeof c.dataIndex === 'string' ? c.dataIndex : c.dataIndex.join('.');
            let val = typeof c.dataIndex === 'string' ? row[c.dataIndex] : (c.dataIndex || []).reduce((o, k) => (o ? o[k] : undefined), row);
            exp[typeof c.title === 'string' ? c.title : key] = val;
          }
        });
        return exp;
      });
      downloadExcel(exportData, `procurement_${reportType}`, REPORT_TYPES.find((r) => r.value === reportType)?.label || reportType);
      message.success('Export completed');
    } catch (err) { message.error(getErrorMessage(err)); }
  };

  const getColumns = () => {
    switch (reportType) {
      case 'po_details':
        return [
          { title: 'PO Number', dataIndex: 'po_number', key: 'po_number', width: 140, sorter: true },
          { title: 'Date', dataIndex: 'po_date', key: 'po_date', width: 110, render: (v) => formatDate(v), sorter: true },
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 180, ellipsis: true },
          { title: 'Item', dataIndex: 'item_name', key: 'item', width: 180, ellipsis: true },
          { title: 'Qty', dataIndex: 'qty', key: 'qty', width: 80, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Rate', dataIndex: 'rate', key: 'rate', width: 110, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Amount', dataIndex: 'amount', key: 'amount', width: 130, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Tax', dataIndex: 'tax_amount', key: 'tax', width: 110, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Total', dataIndex: 'total_amount', key: 'total', width: 130, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Status', dataIndex: 'status', key: 'status', width: 110, render: (v) => <StatusTag status={v} /> },
        ];

      case 'po_by_vendor':
        return [
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 200, ellipsis: true },
          { title: 'Total POs', dataIndex: 'total_pos', key: 'total_pos', width: 100, align: 'right' },
          { title: 'Total Amount', dataIndex: 'total_amount', key: 'total_amount', width: 150, align: 'right', render: (v) => formatCurrency(v), sorter: true },
          { title: 'Paid Amount', dataIndex: 'paid_amount', key: 'paid', width: 150, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Balance', dataIndex: 'balance', key: 'balance', width: 150, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Last PO Date', dataIndex: 'last_po_date', key: 'last_po', width: 120, render: (v) => formatDate(v) },
        ];

      case 'active_pos':
        return [
          { title: 'PO Number', dataIndex: 'po_number', key: 'po_number', width: 140 },
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 180, ellipsis: true },
          { title: 'Date', dataIndex: 'po_date', key: 'date', width: 110, render: (v) => formatDate(v) },
          { title: 'Total Amount', dataIndex: 'total_amount', key: 'total', width: 140, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Received %', dataIndex: 'received_pct', key: 'received_pct', width: 110, align: 'right', render: (v) => v != null ? `${Number(v).toFixed(0)}%` : '-' },
          { title: 'Status', dataIndex: 'status', key: 'status', width: 120, render: (v) => <StatusTag status={v} /> },
          { title: 'Expected Date', dataIndex: 'expected_date', key: 'expected', width: 120, render: (v) => formatDate(v) },
        ];

      case 'purchases_by_item':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Total Qty', dataIndex: 'total_qty', key: 'total_qty', width: 110, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Avg Rate', dataIndex: 'avg_rate', key: 'avg_rate', width: 120, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Total Amount', dataIndex: 'total_amount', key: 'total', width: 150, align: 'right', render: (v) => formatCurrency(v), sorter: true },
          { title: 'Vendors', dataIndex: 'vendor_count', key: 'vendors', width: 80, align: 'right' },
        ];

      case 'purchases_by_category':
        return [
          { title: 'Category', dataIndex: 'category_name', key: 'category', width: 200 },
          { title: 'Item Count', dataIndex: 'item_count', key: 'items', width: 100, align: 'right' },
          { title: 'Total Qty', dataIndex: 'total_qty', key: 'total_qty', width: 110, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Total Amount', dataIndex: 'total_amount', key: 'total', width: 150, align: 'right', render: (v) => formatCurrency(v), sorter: true },
          { title: '% of Total', dataIndex: 'pct_of_total', key: 'pct', width: 100, align: 'right', render: (v) => v != null ? `${Number(v).toFixed(1)}%` : '-' },
        ];

      case 'receive_history':
        return [
          { title: 'GRN Number', dataIndex: 'grn_number', key: 'grn', width: 140 },
          { title: 'PO Number', dataIndex: 'po_number', key: 'po', width: 140 },
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 180, ellipsis: true },
          { title: 'Received Date', dataIndex: 'received_date', key: 'date', width: 120, render: (v) => formatDate(v), sorter: true },
          { title: 'Item', dataIndex: 'item_name', key: 'item', width: 180, ellipsis: true },
          { title: 'Ordered Qty', dataIndex: 'ordered_qty', key: 'ordered', width: 100, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Received Qty', dataIndex: 'received_qty', key: 'received', width: 100, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Status', dataIndex: 'status', key: 'status', width: 110, render: (v) => <StatusTag status={v} /> },
        ];

      case 'grn_details':
        return [
          { title: 'GRN Number', dataIndex: 'grn_number', key: 'grn', width: 140, sorter: true },
          { title: 'Date', dataIndex: 'grn_date', key: 'date', width: 110, render: (v) => formatDate(v) },
          { title: 'PO Number', dataIndex: 'po_number', key: 'po', width: 140 },
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 180, ellipsis: true },
          { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 150 },
          { title: 'Item', dataIndex: 'item_name', key: 'item', width: 180, ellipsis: true },
          { title: 'Qty', dataIndex: 'qty', key: 'qty', width: 80, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Amount', dataIndex: 'amount', key: 'amount', width: 130, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Status', dataIndex: 'status', key: 'status', width: 110, render: (v) => <StatusTag status={v} /> },
        ];

      case 'vendor_balance':
        return [
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 200, ellipsis: true },
          { title: 'Total Billed', dataIndex: 'total_billed', key: 'billed', width: 150, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Total Paid', dataIndex: 'total_paid', key: 'paid', width: 150, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Balance Due', dataIndex: 'balance_due', key: 'balance', width: 150, align: 'right', render: (v) => <span style={{ color: v > 0 ? '#f5222d' : '#52c41a', fontWeight: 600 }}>{formatCurrency(v)}</span>, sorter: true },
          { title: 'Overdue', dataIndex: 'overdue_amount', key: 'overdue', width: 140, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Credit Limit', dataIndex: 'credit_limit', key: 'credit', width: 130, align: 'right', render: (v) => formatCurrency(v) },
        ];

      case 'payments_made':
        return [
          { title: 'Payment #', dataIndex: 'payment_number', key: 'payment', width: 140, sorter: true },
          { title: 'Date', dataIndex: 'payment_date', key: 'date', width: 110, render: (v) => formatDate(v), sorter: true },
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 180, ellipsis: true },
          { title: 'Bill #', dataIndex: 'bill_number', key: 'bill', width: 130 },
          { title: 'Amount', dataIndex: 'amount', key: 'amount', width: 140, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Mode', dataIndex: 'payment_mode', key: 'mode', width: 120 },
          { title: 'Reference', dataIndex: 'reference', key: 'ref', width: 150 },
          { title: 'Status', dataIndex: 'status', key: 'status', width: 100, render: (v) => <StatusTag status={v} /> },
        ];

      default:
        return [];
    }
  };

  return (
    <div>
      <PageHeader
        title="Procurement Reports"
        subtitle={REPORT_TYPES.find((r) => r.value === reportType)?.label || 'Select a report'}
      >
        <Button icon={<DownloadOutlined />} onClick={handleExport}>Export to Excel</Button>
      </PageHeader>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={[12, 12]} align="middle">
          <Col xs={24} sm={12} md={6}>
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
          <Col xs={24} sm={12} md={5}>
            <Select
              placeholder="Vendor"
              allowClear
              style={{ width: '100%' }}
              value={vendor}
              onChange={setVendor}
              options={vendors}
              showSearch
              optionFilterProp="label"
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <RangePicker style={{ width: '100%' }} value={dateRange} onChange={setDateRange} format={DATE_FORMAT} />
          </Col>
          <Col xs={24} sm={6} md={3}>
            <Button type="primary" icon={<FilterOutlined />} onClick={() => setRefreshKey((k) => k + 1)} block>Apply</Button>
          </Col>
        </Row>
      </Card>

      <DataTable
        key={`${reportType}_${refreshKey}`}
        columns={getColumns()}
        fetchFunction={fetchReport}
        rowKey="id"
        searchPlaceholder="Search..."
        exportFileName={`procurement_${reportType}`}
        scroll={{ x: 1200 }}
      />
    </div>
  );
};

export default ProcurementReports;
