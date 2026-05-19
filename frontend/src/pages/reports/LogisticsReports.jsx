import React, { useState, useCallback, useEffect } from 'react';
import {
  Select, DatePicker, Button, Card, Row, Col, Tag, message,
} from 'antd';
import { DownloadOutlined, FilterOutlined } from '@ant-design/icons';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  LineChart, Line, PieChart, Pie, Cell,
} from 'recharts';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { formatCurrency, formatNumber, formatDate, formatDateForAPI, getErrorMessage, downloadExcel } from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { RangePicker } = DatePicker;

const CHART_COLORS = ['#eb2f96', '#52c41a', '#fa8c16', '#f5222d', '#722ed1', '#13c2c2', '#eb2f96', '#faad14'];

const REPORT_TYPES = [
  { label: 'Transport Requirement', value: 'transport_requirement' },
  { label: 'Vendor Quotation Comparison', value: 'vendor_quotation_comparison' },
  { label: 'Fleet Utilization', value: 'fleet_utilization' },
  { label: 'Shipment Tracking', value: 'shipment_tracking' },
  { label: 'Delivery Performance', value: 'delivery_performance' },
  { label: 'Vendor Rating', value: 'vendor_rating' },
  { label: 'Transport Cost Analysis', value: 'transport_cost' },
];

const LogisticsReports = () => {
  const [reportType, setReportType] = useState('transport_requirement');
  const [vendor, setVendor] = useState(undefined);
  const [dateRange, setDateRange] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [vendors, setVendors] = useState([]);
  const [chartData, setChartData] = useState([]);

  useEffect(() => {
    fetchLookups();
  }, []);

  useEffect(() => {
    fetchChartData();
  }, [reportType, dateRange, refreshKey]);

  const fetchLookups = async () => {
    try {
      const res = await api.get('/masters/vendors', { params: { page_size: 500, vendor_type: 'logistics' } });
      const d = res.data;
      setVendors((d.items || d.data || d || []).map((v) => ({ label: v.name, value: v.id })));
    } catch { /* silent */ }
  };

  const fetchChartData = async () => {
    try {
      const queryParams = { report_type: reportType, chart: true };
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }
      const res = await api.get('/reports/logistics/chart', { params: queryParams });
      const data = res.data;
      setChartData(data.chart_data || data.items || data.data || data || []);
    } catch {
      setChartData([]);
    }
  };

  const fetchReport = useCallback(
    async (params) => {
      const queryParams = { ...params, report_type: reportType };
      if (vendor) queryParams.vendor_id = vendor;
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }
      return await api.get('/reports/logistics', { params: queryParams });
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
      const res = await api.get('/reports/logistics', { params: queryParams });
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
      downloadExcel(exportData, `logistics_${reportType}`, REPORT_TYPES.find((r) => r.value === reportType)?.label || reportType);
      message.success('Export completed');
    } catch (err) { message.error(getErrorMessage(err)); }
  };

  const getColumns = () => {
    switch (reportType) {
      case 'transport_requirement':
        return [
          { title: 'TR #', dataIndex: 'tr_number', key: 'tr', width: 140, sorter: true },
          { title: 'Date', dataIndex: 'required_date', key: 'date', width: 110, render: (v) => formatDate(v), sorter: true },
          { title: 'Origin', dataIndex: 'origin', key: 'origin', width: 150 },
          { title: 'Destination', dataIndex: 'destination', key: 'destination', width: 150 },
          { title: 'Vehicle Type', dataIndex: 'vehicle_type', key: 'vehicle_type', width: 120 },
          { title: 'Weight (Kg)', dataIndex: 'weight', key: 'weight', width: 110, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Distance (Km)', dataIndex: 'distance', key: 'distance', width: 120, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Est. Cost', dataIndex: 'estimated_cost', key: 'est_cost', width: 130, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Status', dataIndex: 'status', key: 'status', width: 110, render: (v) => <StatusTag status={v} /> },
        ];

      case 'vendor_quotation_comparison':
        return [
          { title: 'TR #', dataIndex: 'tr_number', key: 'tr', width: 130 },
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 180, ellipsis: true },
          { title: 'Quoted Amount', dataIndex: 'quoted_amount', key: 'quoted', width: 140, align: 'right', render: (v) => formatCurrency(v), sorter: true },
          { title: 'Transit Days', dataIndex: 'transit_days', key: 'transit', width: 110, align: 'right' },
          { title: 'Vehicle Type', dataIndex: 'vehicle_type', key: 'vehicle', width: 120 },
          { title: 'Validity', dataIndex: 'validity_date', key: 'validity', width: 110, render: (v) => formatDate(v) },
          { title: 'Rank', dataIndex: 'rank', key: 'rank', width: 70, align: 'center', render: (v) => <Tag color={v === 1 ? 'green' : v === 2 ? 'blue' : 'default'}>{v}</Tag> },
          { title: 'Selected', dataIndex: 'is_selected', key: 'selected', width: 90, render: (v) => v ? <Tag color="green">Yes</Tag> : <Tag>No</Tag> },
        ];

      case 'fleet_utilization':
        return [
          { title: 'Vehicle #', dataIndex: 'vehicle_number', key: 'vehicle', width: 130 },
          { title: 'Vehicle Type', dataIndex: 'vehicle_type', key: 'type', width: 120 },
          { title: 'Total Trips', dataIndex: 'total_trips', key: 'trips', width: 100, align: 'right', sorter: true },
          { title: 'Total Distance', dataIndex: 'total_distance', key: 'distance', width: 130, align: 'right', render: (v) => `${formatNumber(v)} Km` },
          { title: 'Total Weight', dataIndex: 'total_weight', key: 'weight', width: 120, align: 'right', render: (v) => `${formatNumber(v)} Kg` },
          { title: 'Utilization %', dataIndex: 'utilization_pct', key: 'utilization', width: 120, align: 'right', render: (v) => {
            const color = v >= 80 ? '#52c41a' : v >= 50 ? '#fa8c16' : '#f5222d';
            return <span style={{ color, fontWeight: 600 }}>{Number(v).toFixed(0)}%</span>;
          }, sorter: true },
          { title: 'Avg Cost/Trip', dataIndex: 'avg_cost_per_trip', key: 'avg_cost', width: 130, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Status', dataIndex: 'status', key: 'status', width: 100, render: (v) => <StatusTag status={v} /> },
        ];

      case 'shipment_tracking':
        return [
          { title: 'Shipment #', dataIndex: 'shipment_number', key: 'shipment', width: 140, sorter: true },
          { title: 'TO #', dataIndex: 'to_number', key: 'to', width: 130 },
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 170, ellipsis: true },
          { title: 'Origin', dataIndex: 'origin', key: 'origin', width: 130 },
          { title: 'Destination', dataIndex: 'destination', key: 'dest', width: 130 },
          { title: 'Dispatch Date', dataIndex: 'dispatch_date', key: 'dispatch', width: 120, render: (v) => formatDate(v) },
          { title: 'Expected Delivery', dataIndex: 'expected_delivery', key: 'expected', width: 130, render: (v) => formatDate(v) },
          { title: 'Actual Delivery', dataIndex: 'actual_delivery', key: 'actual', width: 130, render: (v) => formatDate(v) },
          { title: 'Status', dataIndex: 'status', key: 'status', width: 110, render: (v) => <StatusTag status={v} /> },
        ];

      case 'delivery_performance':
        return [
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 200, ellipsis: true },
          { title: 'Total Deliveries', dataIndex: 'total_deliveries', key: 'total', width: 130, align: 'right' },
          { title: 'On-Time', dataIndex: 'on_time_count', key: 'on_time', width: 100, align: 'right' },
          { title: 'Late', dataIndex: 'late_count', key: 'late', width: 80, align: 'right', render: (v) => <span style={{ color: v > 0 ? '#f5222d' : undefined }}>{v}</span> },
          { title: 'On-Time %', dataIndex: 'on_time_pct', key: 'on_time_pct', width: 100, align: 'right', render: (v) => {
            const color = v >= 90 ? '#52c41a' : v >= 70 ? '#fa8c16' : '#f5222d';
            return <span style={{ color, fontWeight: 600 }}>{Number(v).toFixed(0)}%</span>;
          }, sorter: true },
          { title: 'Avg Delay (Days)', dataIndex: 'avg_delay_days', key: 'avg_delay', width: 130, align: 'right', render: (v) => v > 0 ? v.toFixed(1) : '-' },
          { title: 'Damage Rate %', dataIndex: 'damage_rate', key: 'damage', width: 120, align: 'right', render: (v) => `${Number(v).toFixed(1)}%` },
        ];

      case 'vendor_rating':
        return [
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 200, ellipsis: true },
          { title: 'Total Shipments', dataIndex: 'total_shipments', key: 'shipments', width: 130, align: 'right' },
          { title: 'On-Time %', dataIndex: 'on_time_pct', key: 'on_time', width: 100, align: 'right', render: (v) => `${Number(v).toFixed(0)}%` },
          { title: 'Damage Rate', dataIndex: 'damage_rate', key: 'damage', width: 110, align: 'right', render: (v) => `${Number(v).toFixed(1)}%` },
          { title: 'Avg Cost / Km', dataIndex: 'avg_cost_per_km', key: 'cost_km', width: 120, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Rating', dataIndex: 'rating', key: 'rating', width: 80, align: 'center', render: (v) => {
            const color = v >= 4 ? 'green' : v >= 3 ? 'orange' : 'red';
            return <Tag color={color}>{Number(v).toFixed(1)}</Tag>;
          }, sorter: true },
          { title: 'Rank', dataIndex: 'rank', key: 'rank', width: 70, align: 'center' },
        ];

      case 'transport_cost':
        return [
          { title: 'Period', dataIndex: 'period', key: 'period', width: 120 },
          { title: 'Route', dataIndex: 'route', key: 'route', width: 200 },
          { title: 'Shipments', dataIndex: 'shipment_count', key: 'count', width: 100, align: 'right' },
          { title: 'Total Cost', dataIndex: 'total_cost', key: 'total_cost', width: 140, align: 'right', render: (v) => formatCurrency(v), sorter: true },
          { title: 'Avg Cost', dataIndex: 'avg_cost', key: 'avg_cost', width: 130, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Cost / Km', dataIndex: 'cost_per_km', key: 'cost_km', width: 110, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'Cost / Kg', dataIndex: 'cost_per_kg', key: 'cost_kg', width: 110, align: 'right', render: (v) => formatCurrency(v) },
          { title: 'vs Prev Period', dataIndex: 'change_pct', key: 'change', width: 120, align: 'right', render: (v) => {
            if (v == null) return '-';
            const color = v > 0 ? '#f5222d' : '#52c41a';
            return <span style={{ color, fontWeight: 600 }}>{v > 0 ? '+' : ''}{Number(v).toFixed(1)}%</span>;
          }},
        ];

      default:
        return [];
    }
  };

  const showChart = ['fleet_utilization', 'delivery_performance', 'transport_cost', 'vendor_rating'].includes(reportType) && chartData.length > 0;

  return (
    <div>
      <PageHeader
        title="Logistics Reports"
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

      {showChart && (
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          {(reportType === 'transport_cost' || reportType === 'fleet_utilization') && (
            <Col xs={24}>
              <Card title={`${REPORT_TYPES.find((r) => r.value === reportType)?.label || ''} - Trend`} bordered={false} size="small">
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={chartData.slice(0, 20)}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="value" name={reportType === 'transport_cost' ? 'Cost' : 'Utilization %'} fill="#eb2f96" radius={[4, 4, 0, 0]} />
                    {reportType === 'transport_cost' && <Bar dataKey="prev_value" name="Previous Period" fill="#bfbfbf" radius={[4, 4, 0, 0]} />}
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            </Col>
          )}
          {(reportType === 'delivery_performance' || reportType === 'vendor_rating') && (
            <Col xs={24} lg={14}>
              <Card title="Performance Overview" bordered={false} size="small">
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={chartData.slice(0, 10)} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" domain={[0, 100]} />
                    <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="on_time_pct" name="On-Time %" fill="#52c41a" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            </Col>
          )}
          {(reportType === 'delivery_performance' || reportType === 'vendor_rating') && (
            <Col xs={24} lg={10}>
              <Card title="Distribution" bordered={false} size="small">
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie
                      data={chartData.slice(0, 6)}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={90}
                      paddingAngle={3}
                      dataKey="value"
                      label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                    >
                      {chartData.slice(0, 6).map((_, i) => (
                        <Cell key={`cell-${i}`} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
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
        exportFileName={`logistics_${reportType}`}
        scroll={{ x: 1200 }}
      />
    </div>
  );
};

export default LogisticsReports;
