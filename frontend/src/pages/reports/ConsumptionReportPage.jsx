import React, { useState, useCallback, useEffect } from 'react';
import {
  Select, DatePicker, Button, Card, Row, Col, Tag, message,
} from 'antd';
import { DownloadOutlined, FilterOutlined } from '@ant-design/icons';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell,
} from 'recharts';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import api from '../../config/api';
import { formatCurrency, formatNumber, formatDate, formatDateForAPI, getErrorMessage, downloadExcel } from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { RangePicker } = DatePicker;

const CHART_COLORS = ['#eb2f96', '#52c41a', '#fa8c16', '#f5222d', '#722ed1', '#13c2c2', '#eb2f96', '#faad14'];

const REPORT_TYPES = [
  { label: 'Consumption by Customer', value: 'by_customer' },
  { label: 'Consumption by Item', value: 'by_item' },
  { label: 'Consumption by Category', value: 'by_category' },
  { label: 'Consumption by Field Staff', value: 'by_field_staff' },
  { label: 'Consumption Summary', value: 'summary' },
  { label: 'Consumption Return History', value: 'return_history' },
  { label: 'Order Fulfilment by Item', value: 'fulfilment_by_item' },
];

const ConsumptionReportPage = () => {
  const [reportType, setReportType] = useState('summary');
  const [dateRange, setDateRange] = useState(null);
  const [customer, setCustomer] = useState(undefined);
  const [category, setCategory] = useState(undefined);
  const [refreshKey, setRefreshKey] = useState(0);
  const [customers, setCustomers] = useState([]);
  const [categories, setCategories] = useState([]);
  const [chartData, setChartData] = useState([]);

  useEffect(() => {
    fetchLookups();
  }, []);

  // RPT-3 fix: fetchChartData wrapped in useCallback to prevent infinite loop
  const fetchChartData = useCallback(async () => {
    try {
      const queryParams = { report_type: reportType, chart: true };
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }
      if (customer) queryParams.customer_id = customer;
      if (category) queryParams.category_id = category;
      const res = await api.get('/reports/consumption/chart', { params: queryParams });
      const data = res.data;
      setChartData(data.chart_data || data.items || data.data || data || []);
    } catch {
      setChartData([]);
    }
  }, [reportType, dateRange, customer, category]);

  useEffect(() => {
    fetchChartData();
  }, [fetchChartData, refreshKey]);

  const fetchLookups = async () => {
    try {
      const [cRes, catRes] = await Promise.allSettled([
        api.get('/masters/customers', { params: { page_size: 500 } }),
        api.get('/masters/categories', { params: { page_size: 500 } }),
      ]);
      if (cRes.status === 'fulfilled') {
        const d = cRes.value.data;
        setCustomers((d.items || d.data || d || []).map((c) => ({ label: c.name, value: c.id })));
      }
      if (catRes.status === 'fulfilled') {
        const d = catRes.value.data;
        setCategories((d.items || d.data || d || []).map((c) => ({ label: c.name, value: c.id })));
      }
    } catch { /* silent */ }
  };

  const fetchReport = useCallback(
    async (params) => {
      const queryParams = { ...params, report_type: reportType };
      if (customer) queryParams.customer_id = customer;
      if (category) queryParams.category_id = category;
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }
      return await api.get('/reports/consumption', { params: queryParams });
    },
    [reportType, customer, category, dateRange]
  );

  const handleExport = async () => {
    try {
      const queryParams = { report_type: reportType, page_size: 50000 };
      if (customer) queryParams.customer_id = customer;
      if (category) queryParams.category_id = category;
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }
      const res = await api.get('/reports/consumption', { params: queryParams });
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
      downloadExcel(exportData, `consumption_${reportType}`, REPORT_TYPES.find((r) => r.value === reportType)?.label || reportType);
      message.success('Export completed');
    } catch (err) { message.error(getErrorMessage(err)); }
  };

  const getColumns = () => {
    switch (reportType) {
      case 'by_customer':
        return [
          { title: 'Customer', dataIndex: 'customer_name', key: 'customer', width: 200, ellipsis: true },
          { title: 'Total Items', dataIndex: 'total_items', key: 'items', width: 100, align: 'right' },
          { title: 'Total Qty', dataIndex: 'total_qty', key: 'qty', width: 110, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Total Value', dataIndex: 'total_value', key: 'value', width: 150, align: 'right', render: (v) => formatCurrency(v), sorter: true },
          { title: 'Returns', dataIndex: 'return_count', key: 'returns', width: 90, align: 'right' },
          { title: 'Net Value', dataIndex: 'net_value', key: 'net', width: 150, align: 'right', render: (v) => formatCurrency(v) },
        ];

      case 'by_item':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Category', dataIndex: 'category_name', key: 'category', width: 150 },
          { title: 'Total Qty', dataIndex: 'total_qty', key: 'qty', width: 110, align: 'right', render: (v) => formatNumber(v), sorter: true },
          { title: 'Avg Rate', dataIndex: 'avg_rate', key: 'avg_rate', width: 120, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Total Value', dataIndex: 'total_value', key: 'value', width: 150, align: 'right', render: (v) => formatCurrency(v), sorter: true },
          { title: 'Customers', dataIndex: 'customer_count', key: 'customers', width: 100, align: 'right' },
        ];

      case 'by_category':
        return [
          { title: 'Category', dataIndex: 'category_name', key: 'category', width: 200 },
          { title: 'Item Count', dataIndex: 'item_count', key: 'items', width: 100, align: 'right' },
          { title: 'Total Qty', dataIndex: 'total_qty', key: 'qty', width: 110, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Total Value', dataIndex: 'total_value', key: 'value', width: 150, align: 'right', render: (v) => formatCurrency(v), sorter: true },
          { title: '% of Total', dataIndex: 'pct_of_total', key: 'pct', width: 100, align: 'right', render: (v) => v != null ? `${Number(v).toFixed(1)}%` : '-' },
        ];

      case 'by_field_staff':
        return [
          { title: 'Staff Name', dataIndex: 'staff_name', key: 'staff', width: 180, ellipsis: true },
          { title: 'Employee Code', dataIndex: 'employee_code', key: 'emp_code', width: 130 },
          { title: 'Total Entries', dataIndex: 'total_entries', key: 'entries', width: 110, align: 'right' },
          { title: 'Total Qty', dataIndex: 'total_qty', key: 'qty', width: 110, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Total Value', dataIndex: 'total_value', key: 'value', width: 150, align: 'right', render: (v) => formatCurrency(v), sorter: true },
          { title: 'Customers Served', dataIndex: 'customer_count', key: 'customers', width: 130, align: 'right' },
        ];

      case 'summary':
        return [
          { title: 'Date', dataIndex: 'consumption_date', key: 'date', width: 110, render: (v) => formatDate(v), sorter: true },
          { title: 'Entry #', dataIndex: 'entry_number', key: 'entry', width: 140 },
          { title: 'Customer', dataIndex: 'customer_name', key: 'customer', width: 180, ellipsis: true },
          { title: 'Item', dataIndex: 'item_name', key: 'item', width: 180, ellipsis: true },
          { title: 'Qty', dataIndex: 'qty', key: 'qty', width: 80, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Rate', dataIndex: 'rate', key: 'rate', width: 110, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Amount', dataIndex: 'amount', key: 'amount', width: 130, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Staff', dataIndex: 'staff_name', key: 'staff', width: 140 },
        ];

      case 'return_history':
        return [
          { title: 'Return Date', dataIndex: 'return_date', key: 'date', width: 110, render: (v) => formatDate(v), sorter: true },
          { title: 'Return #', dataIndex: 'return_number', key: 'return_no', width: 140 },
          { title: 'Original Entry', dataIndex: 'original_entry', key: 'original', width: 140 },
          { title: 'Customer', dataIndex: 'customer_name', key: 'customer', width: 180, ellipsis: true },
          { title: 'Item', dataIndex: 'item_name', key: 'item', width: 180, ellipsis: true },
          { title: 'Return Qty', dataIndex: 'return_qty', key: 'qty', width: 100, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Reason', dataIndex: 'reason', key: 'reason', width: 200, ellipsis: true },
        ];

      case 'fulfilment_by_item':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Ordered Qty', dataIndex: 'ordered_qty', key: 'ordered', width: 110, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Delivered Qty', dataIndex: 'delivered_qty', key: 'delivered', width: 110, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Pending Qty', dataIndex: 'pending_qty', key: 'pending', width: 110, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Fulfilment %', dataIndex: 'fulfilment_pct', key: 'pct', width: 110, align: 'right', render: (v) => {
            const val = Number(v);
            let color = '#52c41a';
            if (val < 50) color = '#f5222d';
            else if (val < 80) color = '#fa8c16';
            return <span style={{ color, fontWeight: 600 }}>{val.toFixed(0)}%</span>;
          }},
        ];

      default:
        return [];
    }
  };

  const showChart = ['by_category', 'by_customer', 'by_item'].includes(reportType) && chartData.length > 0;

  return (
    <div>
      <PageHeader
        title="Consumption Reports"
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
              placeholder="Customer"
              allowClear
              style={{ width: '100%' }}
              value={customer}
              onChange={setCustomer}
              options={customers}
              showSearch
              optionFilterProp="label"
            />
          </Col>
          <Col xs={24} sm={12} md={4}>
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
          <Col xs={24} sm={12} md={6}>
            <RangePicker style={{ width: '100%' }} value={dateRange} onChange={setDateRange} format={DATE_FORMAT} />
          </Col>
          <Col xs={24} sm={6} md={3}>
            <Button type="primary" icon={<FilterOutlined />} onClick={() => setRefreshKey((k) => k + 1)} block>Apply</Button>
          </Col>
        </Row>
      </Card>

      {showChart && (
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={24} lg={reportType === 'by_category' ? 12 : 24}>
            <Card title={`${REPORT_TYPES.find((r) => r.value === reportType)?.label || ''} - Chart`} bordered={false} size="small">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={chartData.slice(0, 15)}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis />
                  <Tooltip formatter={(val) => formatCurrency(val)} />
                  <Bar dataKey="value" name="Value" fill="#eb2f96" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Col>
          {reportType === 'by_category' && (
            <Col xs={24} lg={12}>
              <Card title="Category Distribution" bordered={false} size="small">
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie
                      data={chartData.slice(0, 8)}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={90}
                      paddingAngle={3}
                      dataKey="value"
                      label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                    >
                      {chartData.slice(0, 8).map((_, i) => (
                        <Cell key={`cell-${i}`} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(val) => formatCurrency(val)} />
                  </PieChart>
                </ResponsiveContainer>
              </Card>
            </Col>
          )}
        </Row>
      )}

      <DataTable
        key={`${reportType}_${refreshKey}`}
        columns={getColumns()}
        fetchFunction={fetchReport}
        rowKey="id"
        searchPlaceholder="Search..."
        exportFileName={`consumption_${reportType}`}
        scroll={{ x: 1100 }}
      />
    </div>
  );
};

export default ConsumptionReportPage;
