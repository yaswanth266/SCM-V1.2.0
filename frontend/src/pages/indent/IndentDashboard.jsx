import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Row, Col, Statistic, Button, List, Tag, Spin, Space, Empty } from 'antd';
import {
  FileTextOutlined,
  ClockCircleOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  PlusOutlined,
  ArrowRightOutlined,
  NotificationOutlined,
} from '@ant-design/icons';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import api from '../../config/api';
import useAuthStore from '../../store/authStore';
import { formatNumber } from '../../utils/helpers';

const COLORS = ['#481890', '#fa8c16', '#52c41a', '#f5222d', '#1890ff'];

const IndentDashboard = () => {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [loading, setLoading] = useState(true);
  const [kpis, setKpis] = useState({});
  const [recentIndents, setRecentIndents] = useState([]);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      setLoading(true);
      // Fetch stats
      const statsRes = await api.get('/dashboard/stats');
      const stats = statsRes.data || {};

      // Fetch recent indents to display and calculate additional metrics
      const indentsRes = await api.get('/indent/indents', { params: { page_size: 5 } });
      const indentsList = indentsRes.data?.items || indentsRes.data || [];

      setKpis(stats);
      setRecentIndents(indentsList);
    } catch (error) {
      console.error('Failed to fetch indent dashboard stats:', error);
    } finally {
      setLoading(false);
    }
  };

  // Turnaround Time (TAT) visual trend data (mock/calculated averages based on standard SLA targets)
  const tatData = [
    { name: 'Draft -> Raised', average: 0.5, target: 1.0 },
    { name: 'Raised -> Approved', average: 1.2, target: 2.0 },
    { name: 'Approved -> Issued', average: 2.4, target: 3.0 },
    { name: 'Issued -> Acknowledged', average: 1.5, target: 2.0 },
  ];

  // Types distribution
  const routineCount = recentIndents.filter(i => i.indent_type === 'routine').length;
  const emergencyCount = recentIndents.filter(i => i.indent_type === 'emergency').length;
  const hasTypeData = routineCount > 0 || emergencyCount > 0;
  const typeData = [
    { name: 'Routine', value: routineCount },
    { name: 'Emergency', value: emergencyCount },
  ];

  const getStatusTag = (status) => {
    const map = {
      draft: { color: 'default', label: 'Draft' },
      pending_approval: { color: 'orange', label: 'Pending Approval' },
      approved: { color: 'green', label: 'Approved' },
      partially_fulfilled: { color: 'blue', label: 'Partially Fulfilled' },
      fulfilled: { color: 'cyan', label: 'Fulfilled' },
      rejected: { color: 'red', label: 'Rejected' },
      cancelled: { color: 'default', label: 'Cancelled' },
    };
    const conf = map[status] || { color: 'default', label: status };
    return <Tag color={conf.color}>{conf.label}</Tag>;
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <Spin size="large" tip="Loading Indent Dashboard..." />
      </div>
    );
  }

  const isFieldUser = kpis.scope === 'self';

  return (
    <div style={{ padding: '24px', background: '#F8F9FA', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '28px', color: '#1A1A1A', fontWeight: 600 }}>Indent Dashboard</h1>
          <p style={{ margin: 0, color: '#6C757D' }}>
            {isFieldUser 
              ? 'Real-time overview of your raised indents and SLA timelines.'
              : 'Enterprise-wide indent tracking, TAT analysis, and fulfillment metrics.'
            }
          </p>
        </div>
        <Space>
          <Button 
            type="primary" 
            icon={<PlusOutlined />} 
            onClick={() => navigate('/indent/indents/new')}
            style={{ background: '#481890', borderColor: '#481890', height: '40px', borderRadius: '6px' }}
          >
            Create Indent
          </Button>
        </Space>
      </div>

      {/* KPI Cards Row */}
      <Row gutter={[16, 16]} style={{ marginBottom: '24px' }}>
        <Col xs={24} sm={12} md={6}>
          <Card 
            hoverable 
            bodyStyle={{ padding: '20px' }}
            style={{ borderRadius: '8px', borderLeft: '4px solid #481890', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <Statistic
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>Total Indents</span>}
              value={isFieldUser ? (kpis.my_indents_total ?? 0) : (kpis.total_indents ?? 0)}
              prefix={<FileTextOutlined style={{ color: '#481890', marginRight: '8px' }} />}
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
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>Awaiting Approval</span>}
              value={isFieldUser ? (kpis.my_indents_pending_approval ?? 0) : (kpis.pending_indents ?? 0)}
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
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>Approved & Active</span>}
              value={isFieldUser ? (kpis.my_indents_approved ?? 0) : (kpis.approved_indents ?? 0)}
              prefix={<CheckCircleOutlined style={{ color: '#52c41a', marginRight: '8px' }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card 
            hoverable 
            bodyStyle={{ padding: '20px' }}
            style={{ borderRadius: '8px', borderLeft: '4px solid #f5222d', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <Statistic
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>Rejected / Cancelled</span>}
              value={isFieldUser ? ((kpis.my_indents_rejected ?? 0) + (kpis.my_indents_cancelled ?? 0)) : (kpis.rejected_indents ?? 0)}
              prefix={<CloseCircleOutlined style={{ color: '#f5222d', marginRight: '8px' }} />}
            />
          </Card>
        </Col>
      </Row>

      {/* Visual Analytics */}
      <Row gutter={[16, 16]} style={{ marginBottom: '24px' }}>
        {/* TAT Timeline Chart */}
        <Col xs={24} lg={16}>
          <Card 
            title="Turnaround Time (TAT) Latency per Stage" 
            style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <div style={{ height: '300px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={tatData} margin={{ top: 20, right: 30, left: 0, bottom: 0 }}>
                  <XAxis dataKey="name" stroke="#6C757D" fontSize={12} tickLine={false} />
                  <YAxis label={{ value: 'Days', angle: -90, position: 'insideLeft' }} stroke="#6C757D" tickLine={false} />
                  <Tooltip cursor={{ fill: 'rgba(72, 24, 144, 0.05)' }} />
                  <Legend />
                  <Bar dataKey="average" name="Average Speed (Days)" fill="#481890" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="target" name="SLA Target (Days)" fill="#fa8c16" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Col>

        {/* Indent Type Pie Chart */}
        <Col xs={24} lg={8}>
          <Card 
            title="Indent Requisition Type" 
            style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <div style={{ height: '300px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
              {hasTypeData ? (
                <>
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie
                        data={typeData}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={80}
                        paddingAngle={5}
                        dataKey="value"
                      >
                        {typeData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                  <div style={{ display: 'flex', gap: '16px', marginTop: '10px' }}>
                    {typeData.map((t, idx) => (
                      <div key={t.name} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <div style={{ width: '12px', height: '12px', borderRadius: '2px', background: COLORS[idx % COLORS.length] }} />
                        <span style={{ fontSize: '13px', color: '#495057' }}>{t.name} ({t.value})</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <Empty description="No indent type data available" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              )}
            </div>
          </Card>
        </Col>
      </Row>

      {/* Recent Activity / Quick Actions Row */}
      <Row gutter={[16, 16]}>
        {/* Recent Indents List */}
        <Col xs={24} md={16}>
          <Card 
            title="My Recent Indents" 
            extra={<Button type="link" onClick={() => navigate('/indent/indents')}>View All</Button>}
            style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            {recentIndents.length > 0 ? (
              <List
                itemLayout="horizontal"
                dataSource={recentIndents}
                renderItem={(item) => (
                  <List.Item
                    actions={[
                      <Button 
                        type="link" 
                        icon={<ArrowRightOutlined />} 
                        onClick={() => navigate(`/indent/indents/${item.id}`)}
                      />
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <Space>
                          <a onClick={() => navigate(`/indent/indents/${item.id}`)} style={{ fontWeight: 600, color: '#1A1A1A' }}>
                            {item.indent_number}
                          </a>
                          {getStatusTag(item.status)}
                          {item.indent_type === 'emergency' && <Tag color="red">Emergency</Tag>}
                        </Space>
                      }
                      description={
                        <div style={{ fontSize: '13px', color: '#6C757D' }}>
                          <span>Date: {item.indent_date}</span>
                          <span style={{ margin: '0 8px' }}>|</span>
                          <span>Items: {item.items?.length || 0}</span>
                          {item.project_name && (
                            <>
                              <span style={{ margin: '0 8px' }}>|</span>
                              <span>Project: {item.project_name}</span>
                            </>
                          )}
                        </div>
                      }
                    />
                  </List.Item>
                )}
              />
            ) : (
              <Empty description="No recent indents found." />
            )}
          </Card>
        </Col>

        {/* Quick Actions Panel */}
        <Col xs={24} md={8}>
          <Card 
            title="Quick SCM Actions" 
            style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <Button 
                type="primary" 
                icon={<PlusOutlined />} 
                onClick={() => navigate('/indent/indents/new')}
                block
                style={{ background: '#481890', borderColor: '#481890', height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
              >
                Raise New Indent
              </Button>
              <Button 
                icon={<NotificationOutlined />} 
                onClick={() => navigate('/indent/notifications')}
                block
                style={{ height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
              >
                View Indent Alerts
              </Button>
              <Button 
                icon={<FileTextOutlined />} 
                onClick={() => navigate('/indent/reports')}
                block
                style={{ height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
              >
                Indent SLA Reports
              </Button>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default IndentDashboard;
