import React, { useState, useEffect } from 'react';
import { Card, Row, Col, Table, Spin, Select, Space, Tag, Typography, Empty } from 'antd';
import {
  CarOutlined, CheckCircleOutlined, RocketOutlined,
  ClockCircleOutlined, BarChartOutlined,
} from '@ant-design/icons';
import {
  PieChart, Pie, Cell, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  Legend, ResponsiveContainer,
} from 'recharts';
import PageHeader from '../../components/PageHeader';
import StatCard from '../../components/StatCard';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { formatDate, formatCurrency, getErrorMessage } from '../../utils/helpers';

const { Text } = Typography;

const CHART_COLORS = ['#eb2f96', '#52c41a', '#fa8c16', '#f5222d', '#722ed1', '#13c2c2', '#fa541c', '#eb2f96'];

const FleetDashboard = () => {
  const [loading, setLoading] = useState(true);
  const [dashData, setDashData] = useState(null);
  const [activeShipments, setActiveShipments] = useState([]);
  const [period, setPeriod] = useState('month');

  useEffect(() => {
    fetchDashboardData();
  }, [period]);

  const fetchDashboardData = async () => {
    setLoading(true);
    try {
      const [summaryRes, shipmentsRes, chartsRes] = await Promise.allSettled([
        api.get('/logistics/fleet-dashboard/summary', { params: { period } }),
        api.get('/logistics/fleet-dashboard/active-shipments', { params: { page_size: 50 } }),
        api.get('/logistics/fleet-dashboard/charts', { params: { period } }),
      ]);

      if (summaryRes.status === 'fulfilled') {
        setDashData((prev) => ({ ...prev, summary: summaryRes.value.data }));
      }
      if (shipmentsRes.status === 'fulfilled') {
        const s = shipmentsRes.value.data;
        setActiveShipments(s.items || s.data || s || []);
      }
      if (chartsRes.status === 'fulfilled') {
        setDashData((prev) => ({ ...prev, charts: chartsRes.value.data }));
      }
    } catch { /* silent */ }
    finally { setLoading(false); }
  };

  const summary = dashData?.summary || {};
  const charts = dashData?.charts || {};

  // Default chart data if API returns empty
  const deliveryPerformance = charts.delivery_performance || [
    { name: 'On Time', value: summary.on_time_deliveries || 0 },
    { name: 'Delayed', value: summary.delayed_deliveries || 0 },
  ];

  const costTrend = charts.cost_trend || [];
  const vendorPerformance = charts.vendor_performance || [];
  const shipmentsByType = charts.shipments_by_type || [];

  const activeColumns = [
    {
      title: 'Order #',
      dataIndex: 'order_number',
      key: 'order_number',
      width: 140,
    },
    { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 160, render: (v, r) => v || r.vendor || '-' },
    { title: 'Vehicle #', dataIndex: 'vehicle_number', key: 'vehicle', width: 130, render: (v) => v || '-' },
    { title: 'Destination', dataIndex: 'destination', key: 'dest', width: 160, ellipsis: true, render: (v) => v || '-' },
    { title: 'Dispatch Date', dataIndex: 'dispatch_date', key: 'dispatch', width: 120, render: (v) => formatDate(v) },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (s) => <StatusTag status={s} />,
    },
    { title: 'Driver', dataIndex: 'driver_name', key: 'driver', width: 130, render: (v) => v || '-' },
    { title: 'Docket #', dataIndex: 'docket_number', key: 'docket', width: 140, render: (v) => v || '-' },
  ];

  if (loading) {
    return (
      <div>
        <PageHeader title="Fleet Dashboard" subtitle="Overview of fleet and logistics operations" />
        <div style={{ textAlign: 'center', padding: 100 }}><Spin size="large" /></div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Fleet Dashboard" subtitle="Overview of fleet and logistics operations">
        <Select
          value={period}
          onChange={setPeriod}
          style={{ width: 140 }}
          options={[
            { label: 'This Week', value: 'week' },
            { label: 'This Month', value: 'month' },
            { label: 'This Quarter', value: 'quarter' },
            { label: 'This Year', value: 'year' },
          ]}
        />
      </PageHeader>

      {/* Summary Cards */}
      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={12} md={6}>
          <StatCard
            icon={<RocketOutlined />}
            iconColor="#eb2f96"
            iconBg="#e6f7ff"
            value={summary.active_shipments || 0}
            label="Active Shipments"
            trend={summary.active_shipments_trend}
            trendLabel="vs last period"
          />
        </Col>
        <Col xs={24} sm={12} md={6}>
          <StatCard
            icon={<CheckCircleOutlined />}
            iconColor="#52c41a"
            iconBg="#f6ffed"
            value={summary.delivered_today || 0}
            label="Delivered Today"
            trend={summary.delivered_today_trend}
            trendLabel="vs yesterday"
          />
        </Col>
        <Col xs={24} sm={12} md={6}>
          <StatCard
            icon={<CarOutlined />}
            iconColor="#722ed1"
            iconBg="#f9f0ff"
            value={summary.in_transit || 0}
            label="In Transit"
          />
        </Col>
        <Col xs={24} sm={12} md={6}>
          <StatCard
            icon={<ClockCircleOutlined />}
            iconColor="#fa8c16"
            iconBg="#fff7e6"
            value={summary.pending_pickup || 0}
            label="Pending Pickup"
          />
        </Col>
      </Row>

      {/* Charts Row 1 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={24} md={12}>
          <Card title="Delivery Performance" size="small">
            {deliveryPerformance.some((d) => d.value > 0) ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={deliveryPerformance}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    dataKey="value"
                    label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                  >
                    {deliveryPerformance.map((entry, idx) => (
                      <Cell key={idx} fill={idx === 0 ? '#52c41a' : '#f5222d'} />
                    ))}
                  </Pie>
                  <RechartsTooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <Empty description="No delivery data" style={{ padding: 60 }} />
            )}
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title="Transport Cost Trend" size="small">
            {costTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={costTrend}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="period" />
                  <YAxis />
                  <RechartsTooltip formatter={(value) => formatCurrency(value)} />
                  <Legend />
                  <Line type="monotone" dataKey="cost" stroke="#eb2f96" strokeWidth={2} name="Transport Cost" />
                  <Line type="monotone" dataKey="budget" stroke="#fa8c16" strokeWidth={2} strokeDasharray="5 5" name="Budget" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <Empty description="No cost trend data" style={{ padding: 60 }} />
            )}
          </Card>
        </Col>
      </Row>

      {/* Charts Row 2 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={24} md={12}>
          <Card title="Vendor Performance Comparison" size="small">
            {vendorPerformance.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={vendorPerformance}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="vendor_name" />
                  <YAxis />
                  <RechartsTooltip />
                  <Legend />
                  <Bar dataKey="on_time" fill="#52c41a" name="On Time" />
                  <Bar dataKey="delayed" fill="#f5222d" name="Delayed" />
                  <Bar dataKey="total" fill="#eb2f96" name="Total Deliveries" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <Empty description="No vendor performance data" style={{ padding: 60 }} />
            )}
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card title="Shipments by Type" size="small">
            {shipmentsByType.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={shipmentsByType}
                    cx="50%"
                    cy="50%"
                    outerRadius={100}
                    dataKey="count"
                    label={({ name, count }) => `${name}: ${count}`}
                  >
                    {shipmentsByType.map((entry, idx) => (
                      <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <RechartsTooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <Empty description="No shipment type data" style={{ padding: 60 }} />
            )}
          </Card>
        </Col>
      </Row>

      {/* Active Shipments Table */}
      <Card title="Active Shipments" size="small">
        <Table
          dataSource={activeShipments}
          columns={activeColumns}
          // BUG-ISS-130 — fall back to other unique-ish fields when an aggregated
          // row has no `id` (e.g. summary rows from the backend), so React
          // doesn't warn or de-dup the wrong rows.
          rowKey={(row) =>
            row?.id ??
            row?.order_number ??
            row?.docket_number ??
            row?.lr_number ??
            JSON.stringify(row || {})
          }
          size="small"
          pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t, r) => `${r[0]}-${r[1]} of ${t}` }}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: <Empty description="No active shipments" /> }}
        />
      </Card>
    </div>
  );
};

export default FleetDashboard;
