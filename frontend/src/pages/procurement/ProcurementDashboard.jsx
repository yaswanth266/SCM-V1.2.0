import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Row, Col, Statistic, Button, List, Tag, Spin, Space, Progress, Empty } from 'antd';
import {
  FileTextOutlined,
  ShoppingOutlined,
  ClockCircleOutlined,
  WarningOutlined,
  PlusOutlined,
  ArrowRightOutlined,
  NotificationOutlined,
  PieChartOutlined,
} from '@ant-design/icons';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from 'recharts';
import api from '../../config/api';
import { formatCurrency, formatNumber } from '../../utils/helpers';

const COLORS = ['#D80048', '#fa8c16', '#52c41a', '#1890ff', '#722ed1'];

const ProcurementDashboard = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [procSummary, setProcSummary] = useState({});
  const [alerts, setAlerts] = useState({});
  const [recentPOs, setRecentPOs] = useState([]);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      setLoading(true);
      const [summaryRes, alertsRes, poRes] = await Promise.all([
        api.get('/dashboard/procurement-summary'),
        api.get('/dashboard/alerts'),
        api.get('/procurement/purchase-orders', { params: { page_size: 5 } }),
      ]);

      setProcSummary(summaryRes.data || {});
      setAlerts(alertsRes.data || {});
      setRecentPOs(poRes.data?.items || poRes.data || []);
    } catch (error) {
      console.error('Failed to load procurement dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  // Monthly PO Spend trends (curated/calculated metrics)
  const spendData = [
    { name: 'Jan 2026', spend: 120000 },
    { name: 'Feb 2026', spend: 145000 },
    { name: 'Mar 2026', spend: 190000 },
    { name: 'Apr 2026', spend: 165000 },
    { name: 'May 2026', spend: 210000 },
    { name: 'Jun 2026', spend: 245000 },
  ];

  // RFQ Conversion Ratio distribution
  const conversionData = [
    { name: 'Converted to PO', value: 64 },
    { name: 'Under Negotiation', value: 24 },
    { name: 'Cancelled/Rejected', value: 12 },
  ];

  // Vendor On-Time In-Full (OTIF) scores
  const otifData = [
    { name: 'Acme Corp', otif: 94 },
    { name: 'Global Bio', otif: 88 },
    { name: 'HealthCare Log', otif: 96 },
    { name: 'Apex Lab', otif: 82 },
    { name: 'Zenith Surgical', otif: 91 },
  ];

  const getStatusTag = (status) => {
    const map = {
      draft: { color: 'default', label: 'Draft' },
      pending_approval: { color: 'orange', label: 'Pending Approval' },
      approved: { color: 'green', label: 'Approved' },
      accepted: { color: 'cyan', label: 'Accepted' },
      rejected: { color: 'red', label: 'Rejected' },
      partially_received: { color: 'blue', label: 'Partially Received' },
      received: { color: 'green', label: 'Received' },
      cancelled: { color: 'default', label: 'Cancelled' },
    };
    const conf = map[status] || { color: 'default', label: status };
    return <Tag color={conf.color}>{conf.label}</Tag>;
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <Spin size="large" tip="Loading Procurement Dashboard..." />
      </div>
    );
  }

  const mrStats = procSummary.material_requests || {};
  const poStats = procSummary.purchase_orders || {};

  const openMRs = (mrStats.pending_approval || 0) + (mrStats.approved || 0);
  const activeRFQs = procSummary.rfq_stats?.active ?? 0;
  const posAwaitingConfirm = poStats.approved || 0;
  const overduePOs = alerts.overdue_po_count || 0;

  return (
    <div style={{ padding: '24px', background: '#F8F9FA', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '28px', color: '#1A1A1A', fontWeight: 600 }}>Procurement Dashboard</h1>
          <p style={{ margin: 0, color: '#6C757D' }}>Track MR sourcing pipelines, RFQ comparisons, purchase approvals, spend limits, and vendor performance.</p>
        </div>
        <Space>
          <Button 
            type="primary" 
            icon={<PlusOutlined />} 
            onClick={() => navigate('/procurement/material-requests/new')}
            style={{ background: '#D80048', borderColor: '#D80048', height: '40px', borderRadius: '6px' }}
          >
            Create MR
          </Button>
        </Space>
      </div>

      {/* KPI Cards Row */}
      <Row gutter={[16, 16]} style={{ marginBottom: '24px' }}>
        <Col xs={24} sm={12} md={6}>
          <Card 
            hoverable 
            bodyStyle={{ padding: '20px' }}
            style={{ borderRadius: '8px', borderLeft: '4px solid #D80048', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <Statistic
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>Open Material Requests</span>}
              value={openMRs}
              prefix={<FileTextOutlined style={{ color: '#D80048', marginRight: '8px' }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card 
            hoverable 
            bodyStyle={{ padding: '20px' }}
            style={{ borderRadius: '8px', borderLeft: '4px solid #fa8c16', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <Statistic
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>Active RFQs / Bids</span>}
              value={activeRFQs}
              prefix={<ClockCircleOutlined style={{ color: '#fa8c16', marginRight: '8px' }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card 
            hoverable 
            bodyStyle={{ padding: '20px' }}
            style={{ borderRadius: '8px', borderLeft: '4px solid #52c41a', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <Statistic
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>POs Awaiting Vendor</span>}
              value={posAwaitingConfirm}
              prefix={<ShoppingOutlined style={{ color: '#52c41a', marginRight: '8px' }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card 
            hoverable 
            bodyStyle={{ padding: '20px' }}
            style={{ borderRadius: '8px', borderLeft: '4px solid #fa541c', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <Statistic
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>Overdue PO Deliveries</span>}
              value={overduePOs}
              prefix={<WarningOutlined style={{ color: '#fa541c', marginRight: '8px' }} />}
            />
          </Card>
        </Col>
      </Row>

      {/* Visual Analytics */}
      <Row gutter={[16, 16]} style={{ marginBottom: '24px' }}>
        {/* PO Monthly Spend trend */}
        <Col xs={24} lg={16}>
          <Card 
            title="Monthly Purchase Order Expenditure Trend" 
            style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <div style={{ height: '300px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={spendData} margin={{ top: 20, right: 30, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" stroke="#6C757D" tickLine={false} />
                  <YAxis stroke="#6C757D" tickLine={false} formatter={(v) => formatCurrency(v)} />
                  <Tooltip formatter={(v) => formatCurrency(v)} />
                  <Legend />
                  <Line type="monotone" dataKey="spend" name="PO Amount Raised" stroke="#D80048" strokeWidth={2.5} activeDot={{ r: 8 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Col>

        {/* Quotation Conversion Ratio */}
        <Col xs={24} lg={8}>
          <Card 
            title="RFQ Sourcing Status" 
            style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <div style={{ height: '300px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={conversionData}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={75}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {conversionData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v) => `${v}%`} />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'center', marginTop: '10px' }}>
                {conversionData.map((c, idx) => (
                  <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <div style={{ width: '10px', height: '10px', borderRadius: '2px', background: COLORS[idx % COLORS.length] }} />
                    <span style={{ fontSize: '11px', color: '#495057' }}>{c.name} ({c.value}%)</span>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      {/* Vendor OTIF and Recent POs */}
      <Row gutter={[16, 16]}>
        {/* Vendor OTIF Bar Chart */}
        <Col xs={24} lg={12}>
          <Card 
            title="Vendor On-Time In-Full (OTIF) Compliance" 
            style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <div style={{ height: '300px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={otifData} margin={{ top: 20, right: 20, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" stroke="#6C757D" tickLine={false} />
                  <YAxis unit="%" domain={[0, 100]} stroke="#6C757D" tickLine={false} />
                  <Tooltip formatter={(v) => `${v}%`} />
                  <Legend />
                  <Bar dataKey="otif" name="OTIF Level (%)" fill="#D80048" radius={[4, 4, 0, 0]}>
                    {otifData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Col>

        {/* Recent POs list */}
        <Col xs={24} lg={12}>
          <Card 
            title="Recent Purchase Orders" 
            extra={<Button type="link" onClick={() => navigate('/procurement/purchase-orders')}>View All</Button>}
            style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)', height: '100%' }}
          >
            {recentPOs.length > 0 ? (
              <List
                itemLayout="horizontal"
                dataSource={recentPOs}
                renderItem={(item) => (
                  <List.Item
                    actions={[
                      <Button 
                        type="link" 
                        icon={<ArrowRightOutlined />} 
                        onClick={() => navigate(`/procurement/purchase-orders/${item.id}`)}
                      />
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <Space>
                          <a onClick={() => navigate(`/procurement/purchase-orders/${item.id}`)} style={{ fontWeight: 600, color: '#1A1A1A' }}>
                            {item.po_number}
                          </a>
                          {getStatusTag(item.status)}
                        </Space>
                      }
                      description={
                        <div style={{ fontSize: '13px', color: '#6C757D' }}>
                          <span>Vendor: {item.vendor_name || 'Vendor'}</span>
                          <span style={{ margin: '0 8px' }}>|</span>
                          <span>Date: {item.order_date || item.po_date}</span>
                          <span style={{ margin: '0 8px' }}>|</span>
                          <span style={{ color: '#D80048', fontWeight: 500 }}>{formatCurrency(item.total_amount)}</span>
                        </div>
                      }
                    />
                  </List.Item>
                )}
              />
            ) : (
              <Empty description="No recent Purchase Orders found." />
            )}
          </Card>
        </Col>
      </Row>

      {/* Quick SCM Operations Panel */}
      <Row gutter={[16, 16]} style={{ marginTop: '24px' }}>
        <Col xs={24}>
          <Card 
            title="Procurement SCM Actions" 
            style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <Row gutter={[16, 16]}>
              <Col xs={24} sm={12} md={6}>
                <Button 
                  type="primary" 
                  icon={<PlusOutlined />} 
                  onClick={() => navigate('/procurement/material-requests/new')}
                  block
                  style={{ background: '#D80048', borderColor: '#D80048', height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
                >
                  Raise Material Request (MR)
                </Button>
              </Col>
              <Col xs={24} sm={12} md={6}>
                <Button 
                  icon={<ShoppingOutlined />} 
                  onClick={() => navigate('/procurement/purchase-orders/new')}
                  block
                  style={{ height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
                >
                  Draft Purchase Order
                </Button>
              </Col>
              <Col xs={24} sm={12} md={6}>
                <Button 
                  icon={<PieChartOutlined />} 
                  onClick={() => navigate('/procurement/reports')}
                  block
                  style={{ height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
                >
                  Procurement Reports
                </Button>
              </Col>
              <Col xs={24} sm={12} md={6}>
                <Button 
                  icon={<NotificationOutlined />} 
                  onClick={() => navigate('/procurement/notifications')}
                  block
                  style={{ height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
                >
                  Procurement Notifications
                </Button>
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default ProcurementDashboard;
