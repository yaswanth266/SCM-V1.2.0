import React, { useState, useCallback, useEffect } from 'react';
import {
  Select, DatePicker, Button, Card, Row, Col, message,
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
  { label: 'Vendor Balance Summary', value: 'vendor_balance' },
  { label: 'Bill Details', value: 'bill_details' },
  { label: 'Vendor Credit Details', value: 'vendor_credit' },
  { label: 'Payable Summary', value: 'payable_summary' },
  { label: 'Payable Details', value: 'payable_details' },
  { label: 'Purchase Order Details', value: 'po_details' },
  { label: 'Purchases by Vendor', value: 'purchases_by_vendor' },
];

const AccountsReports = () => {
  const [reportType, setReportType] = useState('vendor_balance');
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
      return await api.get('/reports/accounts', { params: queryParams });
    },
    [reportType, vendor, dateRange]
  );

  const handleExport = async () => {
    // BUG-FIN-104: snapshot the report_type AND its columns BEFORE the async
    // fetch starts. If the user switches report mid-flight the export still
    // uses the columns/labels matching the data that came back.
    const exportType = reportType;
    const exportLabel = REPORT_TYPES.find((r) => r.value === exportType)?.label || exportType;
    const exportCols = getColumns();
    try {
      const queryParams = { report_type: exportType, page_size: 50000 };
      if (vendor) queryParams.vendor_id = vendor;
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }
      const res = await api.get('/reports/accounts', { params: queryParams });
      const data = res.data;
      const rows = data.items || data.data || data || [];
      // BUG-FIN-105: render currency / date columns the way the on-screen
      // table does so the XLSX matches what the user sees rather than dumping
      // raw ISO strings + decimals.
      const isCurrencyKey = (k) =>
        typeof k === 'string' && /(amount|total|balance|paid|outstanding|tax|gross|net|value|grand_total)/i.test(k);
      const isDateKey = (k) =>
        typeof k === 'string' && /(date|_at|due|expiry)/i.test(k);
      const exportData = rows.map((row) => {
        const exp = {};
        exportCols.forEach((c) => {
          if (c.dataIndex && c.title) {
            const key = typeof c.dataIndex === 'string' ? c.dataIndex : c.dataIndex.join('.');
            let val = typeof c.dataIndex === 'string' ? row[c.dataIndex] : (c.dataIndex || []).reduce((o, k) => (o ? o[k] : undefined), row);
            if (val != null) {
              if (isCurrencyKey(key)) val = formatCurrency(val);
              else if (isDateKey(key)) val = formatDate(val);
            }
            exp[typeof c.title === 'string' ? c.title : key] = val;
          }
        });
        return exp;
      });
      downloadExcel(exportData, `accounts_${exportType}`, exportLabel);
      message.success('Export completed');
    } catch (err) { message.error(getErrorMessage(err)); }
  };

  const getColumns = () => {
    switch (reportType) {
      case 'vendor_balance':
        return [
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 200, ellipsis: true },
          { title: 'Contact', dataIndex: 'contact_person', key: 'contact', width: 150 },
          { title: 'Total Billed', dataIndex: 'total_billed', key: 'billed', width: 150, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Total Paid', dataIndex: 'total_paid', key: 'paid', width: 150, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Credits', dataIndex: 'credit_amount', key: 'credits', width: 130, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Balance Due', dataIndex: 'balance_due', key: 'balance', width: 150, align: 'right', render: (v) => <span style={{ color: v > 0 ? '#f5222d' : '#52c41a', fontWeight: 600 }}>{formatCurrency(v)}</span>, sorter: true },
          { title: 'Overdue Amount', dataIndex: 'overdue_amount', key: 'overdue', width: 140, align: 'right', render: (v) => formatCurrency(v) },
        ];

      case 'bill_details':
        return [
          { title: 'Bill #', dataIndex: 'bill_number', key: 'bill', width: 140, sorter: true },
          { title: 'Date', dataIndex: 'bill_date', key: 'date', width: 110, render: (v) => formatDate(v), sorter: true },
          { title: 'Due Date', dataIndex: 'due_date', key: 'due', width: 110, render: (v) => formatDate(v) },
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 180, ellipsis: true },
          { title: 'PO #', dataIndex: 'po_number', key: 'po', width: 130 },
          { title: 'Amount', dataIndex: 'amount', key: 'amount', width: 140, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Tax', dataIndex: 'tax_amount', key: 'tax', width: 110, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Total', dataIndex: 'total_amount', key: 'total', width: 140, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Paid', dataIndex: 'paid_amount', key: 'paid', width: 120, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Balance', dataIndex: 'balance', key: 'balance', width: 130, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Status', dataIndex: 'status', key: 'status', width: 110, render: (v) => <StatusTag status={v} /> },
        ];

      case 'vendor_credit':
        return [
          { title: 'Credit #', dataIndex: 'credit_number', key: 'credit', width: 140, sorter: true },
          { title: 'Date', dataIndex: 'credit_date', key: 'date', width: 110, render: (v) => formatDate(v) },
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 180, ellipsis: true },
          { title: 'Bill #', dataIndex: 'bill_number', key: 'bill', width: 130 },
          { title: 'Reason', dataIndex: 'reason', key: 'reason', width: 200, ellipsis: true },
          { title: 'Amount', dataIndex: 'amount', key: 'amount', width: 140, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Applied', dataIndex: 'applied_amount', key: 'applied', width: 130, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Balance', dataIndex: 'balance', key: 'balance', width: 130, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Status', dataIndex: 'status', key: 'status', width: 100, render: (v) => <StatusTag status={v} /> },
        ];

      case 'payable_summary':
        return [
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 200, ellipsis: true },
          { title: 'Current', dataIndex: 'current_amount', key: 'current', width: 130, align: 'right', render: (v) => formatCurrency(v) },
          { title: '1-30 Days', dataIndex: 'days_1_30', key: 'd30', width: 120, align: 'right', render: (v) => formatCurrency(v) },
          { title: '31-60 Days', dataIndex: 'days_31_60', key: 'd60', width: 120, align: 'right', render: (v) => formatCurrency(v) },
          { title: '61-90 Days', dataIndex: 'days_61_90', key: 'd90', width: 120, align: 'right', render: (v) => formatCurrency(v) },
          { title: '90+ Days', dataIndex: 'days_90_plus', key: 'd90p', width: 120, align: 'right', render: (v) => <span style={{ color: v > 0 ? '#f5222d' : undefined }}>{formatCurrency(v)}</span> },
          { title: 'Total', dataIndex: 'total', key: 'total', width: 140, align: 'right', render: (v) => formatCurrency(v), sorter: true },
        ];

      case 'payable_details':
        return [
          { title: 'Bill #', dataIndex: 'bill_number', key: 'bill', width: 140 },
          { title: 'Date', dataIndex: 'bill_date', key: 'date', width: 110, render: (v) => formatDate(v) },
          { title: 'Due Date', dataIndex: 'due_date', key: 'due', width: 110, render: (v) => formatDate(v) },
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 180, ellipsis: true },
          { title: 'Bill Amount', dataIndex: 'bill_amount', key: 'amount', width: 140, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Paid', dataIndex: 'paid_amount', key: 'paid', width: 120, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Balance', dataIndex: 'balance', key: 'balance', width: 130, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Days Overdue', dataIndex: 'days_overdue', key: 'overdue_days', width: 110, align: 'right', render: (v) => v > 0 ? <span style={{ color: '#f5222d', fontWeight: 600 }}>{v}</span> : '-' },
          { title: 'Status', dataIndex: 'status', key: 'status', width: 110, render: (v) => <StatusTag status={v} /> },
        ];

      case 'po_details':
        return [
          { title: 'PO #', dataIndex: 'po_number', key: 'po', width: 140, sorter: true },
          { title: 'Date', dataIndex: 'po_date', key: 'date', width: 110, render: (v) => formatDate(v), sorter: true },
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 180, ellipsis: true },
          { title: 'Amount', dataIndex: 'amount', key: 'amount', width: 140, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Tax', dataIndex: 'tax_amount', key: 'tax', width: 110, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Total', dataIndex: 'total_amount', key: 'total', width: 140, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Billed', dataIndex: 'billed_amount', key: 'billed', width: 130, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Status', dataIndex: 'status', key: 'status', width: 120, render: (v) => <StatusTag status={v} /> },
        ];

      case 'purchases_by_vendor':
        return [
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 200, ellipsis: true },
          { title: 'Total POs', dataIndex: 'total_pos', key: 'pos', width: 100, align: 'right' },
          { title: 'Total Bills', dataIndex: 'total_bills', key: 'bills', width: 100, align: 'right' },
          { title: 'Purchase Amount', dataIndex: 'purchase_amount', key: 'purchase', width: 150, align: 'right', render: (v) => formatCurrency(v), sorter: true },
          { title: 'Paid Amount', dataIndex: 'paid_amount', key: 'paid', width: 150, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Balance', dataIndex: 'balance', key: 'balance', width: 140, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Last Purchase', dataIndex: 'last_purchase_date', key: 'last', width: 120, render: (v) => formatDate(v) },
        ];

      default:
        return [];
    }
  };

  return (
    <div>
      <PageHeader
        title="Account Reports"
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
        exportFileName={`accounts_${reportType}`}
        scroll={{ x: 1200 }}
      />
    </div>
  );
};

export default AccountsReports;
