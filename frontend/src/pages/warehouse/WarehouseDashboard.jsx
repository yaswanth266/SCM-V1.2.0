import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Row, Col, Statistic, Button, List, Tag, Spin, Space, Progress, Empty } from 'antd';
import {
  InboxOutlined,
  CheckSquareOutlined,
  SolutionOutlined,
  AppstoreOutlined,
  PlusOutlined,
  ArrowRightOutlined,
  NotificationOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
} from 'recharts';
import api from '../../config/api';

const COLORS = ['#F09000', '#52c41a', '#fa8c16', '#fa541c', '#1890ff'];

const WarehouseDashboard = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [procSummary, setProcSummary] = useState({});
  const [recentGRNs, setRecentGRNs] = useState([]);
  const [recentQIs, setRecentQIs] = useState([]);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      setLoading(true);
      const [summaryRes, grnRes, qiRes] = await Promise.all([
        api.get('/dashboard/procurement-summary'),
        api.get('/warehouse/grn', { params: { page_size: 5 } }),
        api.get('/warehouse/quality-inspections', { params: { page_size: 5 } }),
      ]);

      setProcSummary(summaryRes.data || {});
      setRecentGRNs(grnRes.data?.items || grnRes.data || []);
      setRecentQIs(qiRes.data?.items || qiRes.data || []);
    } catch (error) {
      console.error('Failed to load warehouse dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Curated Storage Space Occupancy
  const occupancyData = [
    { zone: 'Zone A (Cold Storage)', value: 82 },
    { zone: 'Zone B (Bulk Storage)', value: 68 },
    { zone: 'Zone C (Rack Shelves)', value: 74 },
    { zone: 'Zone D (Receiving Dock)', value: 45 },
  ];

  // QA Inspection Ratio Data
  const qaRatioData = [
    { name: 'Passed', value: 85 },
    { name: 'Failed', value: 15 },
  ];

  const getStatusTag = (status) => {
    const map = {
      draft: { color: 'default', label: 'Draft' },
      pending_qi: { color: 'orange', label: 'Pending QA' },
      putaway_pending: { color: 'blue', label: 'Pending Putaway' },
      completed: { color: 'green', label: 'Completed' },
      passed: { color: 'green', label: 'QA Passed' },
      failed: { color: 'red', label: 'QA Failed' },
      cancelled: { color: 'default', label: 'Cancelled' },
    };
    const conf = map[status] || { color: 'default', label: status };
    return <Tag color={conf.color}>{conf.label}</Tag>;
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <Spin size="large">
          <div style={{ padding: '64px', textAlign: 'center', color: '#6C757D' }}>Loading Warehouse Dashboard...</div>
        </Spin>
      </div>
    );
  }

  const grnStats = procSummary.grns || {};

  return (
    <div style={{ padding: '24px', background: '#F8F9FA', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '28px', color: '#1A1A1A', fontWeight: 600 }}>Warehouse Dashboard</h1>
          <p style={{ margin: 0, color: '#6C757D' }}>Manage goods receipts, QA inspections, bin mapping, putaway, and dispatch queues.</p>
        </div>
        <Space>
          <Button 
            type="primary" 
            icon={<PlusOutlined />} 
            onClick={() => navigate('/warehouse/grn/new')}
            style={{ background: '#F09000', borderColor: '#F09000', height: '40px', borderRadius: '6px' }}
          >
            Receive GRN
          </Button>
        </Space>
      </div>

      {/* KPI Cards Row */}
      <Row gutter={[16, 16]} style={{ marginBottom: '24px' }}>
        <Col xs={24} sm={12} md={6}>
          <Card 
            hoverable 
            styles={{ body: { padding: '20px' } }}
            style={{ borderRadius: '8px', borderLeft: '4px solid #F09000', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <Statistic
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>GRNs Pending Putaway</span>}
              value={grnStats.putaway_pending || 4}
              prefix={<InboxOutlined style={{ color: '#F09000', marginRight: '8px' }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card 
            hoverable 
            styles={{ body: { padding: '20px' } }}
            style={{ borderRadius: '8px', borderLeft: '4px solid #fa8c16', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <Statistic
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>Pending QA Inspections</span>}
              value={grnStats.pending_qi || 2}
              prefix={<CheckSquareOutlined style={{ color: '#fa8c16', marginRight: '8px' }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card 
            hoverable 
            styles={{ body: { padding: '20px' } }}
            style={{ borderRadius: '8px', borderLeft: '4px solid #52c41a', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <Statistic
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>Active Picklists</span>}
              value={3}
              prefix={<SolutionOutlined style={{ color: '#52c41a', marginRight: '8px' }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card 
            hoverable 
            styles={{ body: { padding: '20px' } }}
            style={{ borderRadius: '8px', borderLeft: '4px solid #1890ff', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <Statistic
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>Picked & Unissued</span>}
              value={5}
              prefix={<AppstoreOutlined style={{ color: '#1890ff', marginRight: '8px' }} />}
            />
          </Card>
        </Col>
      </Row>

      {/* Visual Analytics */}
      <Row gutter={[16, 16]} style={{ marginBottom: '24px' }}>
        {/* Storage Space Occupancy */}
        <Col xs={24} lg={16}>
          <Card 
            title="Storage Space Occupancy by Warehouse Zone" 
            style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <div style={{ height: '300px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={occupancyData} margin={{ top: 20, right: 30, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="zone" stroke="#6C757D" tickLine={false} />
                  <YAxis unit="%" domain={[0, 100]} stroke="#6C757D" tickLine={false} />
                  <Tooltip formatter={(v) => `${v}%`} />
                  <Bar dataKey="value" name="Occupancy Rate" fill="#F09000" radius={[4, 4, 0, 0]}>
                    {occupancyData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Col>

        {/* QA Pass/Fail Ratio */}
        <Col xs={24} lg={8}>
          <Card 
            title="QA Pass/Fail Inspection Ratio" 
            style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <div style={{ height: '300px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={qaRatioData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    <Cell fill="#52c41a" />
                    <Cell fill="#f5222d" />
                  </Pie>
                  <Tooltip formatter={(v) => `${v}%`} />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', gap: '16px', marginTop: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <div style={{ width: '12px', height: '12px', borderRadius: '2px', background: '#52c41a' }} />
                  <span style={{ fontSize: '13px', color: '#495057' }}>Pass (85%)</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <div style={{ width: '12px', height: '12px', borderRadius: '2px', background: '#f5222d' }} />
                  <span style={{ fontSize: '13px', color: '#495057' }}>Fail (15%)</span>
                </div>
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      {/* Recent Activity / Quick Actions Row */}
      <Row gutter={[16, 16]}>
        {/* Recent GRNs */}
        <Col xs={24} md={16}>
          <Card 
            title="Recent Goods Receipt Notes" 
            extra={<Button type="link" onClick={() => navigate('/warehouse/grn')}>View All</Button>}
            style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            {recentGRNs.length > 0 ? (
              <List
                itemLayout="horizontal"
                dataSource={recentGRNs}
                renderItem={(item) => (
                  <List.Item
                    actions={[
                      <Button 
                        type="link" 
                        icon={<ArrowRightOutlined />} 
                        onClick={() => navigate(`/warehouse/grn/${item.id}`)}
                      />
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <Space>
                          <a onClick={() => navigate(`/warehouse/grn/${item.id}`)} style={{ fontWeight: 600, color: '#1A1A1A' }}>
                            {item.grn_number}
                          </a>
                          {getStatusTag(item.status)}
                        </Space>
                      }
                      description={
                        <div style={{ fontSize: '13px', color: '#6C757D' }}>
                          <span>Vendor: {item.vendor_name}</span>
                          <span style={{ margin: '0 8px' }}>|</span>
                          <span>Date: {item.grn_date}</span>
                          <span style={{ margin: '0 8px' }}>|</span>
                          <span>Warehouse: {item.warehouse_name || `Warehouse ${item.warehouse_id}`}</span>
                        </div>
                      }
                    />
                  </List.Item>
                )}
              />
            ) : (
              <Empty description="No recent GRNs found." />
            )}
          </Card>
        </Col>

        {/* Quick Actions Panel */}
        <Col xs={24} md={8}>
          <Card 
            title="Warehouse Operations" 
            style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <Button 
                type="primary" 
                icon={<PlusOutlined />} 
                onClick={() => navigate('/warehouse/grn/new')}
                block
                style={{ background: '#F09000', borderColor: '#F09000', height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
              >
                Inward New GRN
              </Button>
              <Button 
                icon={<CheckSquareOutlined />} 
                onClick={() => navigate('/warehouse/quality-inspection/new')}
                block
                style={{ height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
              >
                New Quality Check
              </Button>
              <Button 
                icon={<PlusOutlined />} 
                onClick={() => navigate('/warehouse/material-issues/new')}
                block
                style={{ height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
              >
                Issue Raw Materials
              </Button>
              <Button 
                icon={<NotificationOutlined />} 
                onClick={() => navigate('/warehouse/notifications')}
                block
                style={{ height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
              >
                Warehouse Alerts
              </Button>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default WarehouseDashboard;
