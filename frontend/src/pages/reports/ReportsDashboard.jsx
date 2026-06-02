import React from 'react';
import { Row, Col, Card, Typography, Badge } from 'antd';
import {
  AppstoreOutlined, ShoppingCartOutlined, PieChartOutlined,
  DollarOutlined, BankOutlined, CarOutlined, SettingOutlined,
  FileTextOutlined, BarChartOutlined, LineChartOutlined,
  AuditOutlined, DatabaseOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';

const { Title, Text } = Typography;

const reportCategories = [
  {
    key: 'inventory',
    title: 'Inventory Reports',
    description: 'Stock summary, aging, valuation, ABC classification, expiry tracking and more',
    icon: <AppstoreOutlined style={{ fontSize: 36, color: '#eb2f96' }} />,
    color: '#e6f7ff',
    borderColor: '#eb2f96',
    path: '/reports/inventory',
    count: 17,
  },
  {
    key: 'procurement',
    title: 'Procurement Reports',
    description: 'Purchase orders, vendor analysis, GRN details, receive history',
    icon: <ShoppingCartOutlined style={{ fontSize: 36, color: '#52c41a' }} />,
    color: '#f6ffed',
    borderColor: '#52c41a',
    path: '/reports/procurement',
    count: 9,
  },
  {
    key: 'consumption',
    title: 'Consumption Reports',
    description: 'Consumption by customer, item, category, field staff, fulfilment analysis',
    icon: <PieChartOutlined style={{ fontSize: 36, color: '#fa8c16' }} />,
    color: '#fff7e6',
    borderColor: '#fa8c16',
    path: '/reports/consumption',
    count: 7,
  },
  {
    key: 'sales',
    title: 'Sales Reports',
    description: 'Invoice details, sales orders, delivery challans, receivables, payment tracking',
    icon: <DollarOutlined style={{ fontSize: 36, color: '#722ed1' }} />,
    color: '#f9f0ff',
    borderColor: '#722ed1',
    path: '/reports/sales',
    count: 8,
  },
  {
    key: 'accounts',
    title: 'Account Reports',
    description: 'Vendor balance, bill details, payables, purchase orders by vendor',
    icon: <BankOutlined style={{ fontSize: 36, color: '#13c2c2' }} />,
    color: '#e6fffb',
    borderColor: '#13c2c2',
    path: '/reports/accounts',
    count: 6,
  },
  {
    key: 'system',
    title: 'System Reports',
    description: 'Activity logs, audit trail, system mails, API usage, pending valuations',
    icon: <SettingOutlined style={{ fontSize: 36, color: '#2f54eb' }} />,
    color: '#f0f5ff',
    borderColor: '#2f54eb',
    path: '/reports/system',
    count: 6,
  },
];

const quickLinks = [
  { label: 'Stock Summary', path: '/reports/inventory', icon: <DatabaseOutlined /> },
  { label: 'PO Details', path: '/reports/procurement', icon: <FileTextOutlined /> },
  { label: 'Consumption Summary', path: '/reports/consumption', icon: <BarChartOutlined /> },
  { label: 'Invoice Details', path: '/reports/sales', icon: <LineChartOutlined /> },
  { label: 'Activity Logs', path: '/reports/system', icon: <AuditOutlined /> },
];

const ReportsDashboard = () => {
  const navigate = useNavigate();

  return (
    <div>
      <PageHeader title="Reports" subtitle="View and export reports across all modules" />

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        {reportCategories.map((cat) => (
          <Col xs={24} sm={12} lg={8} xl={6} key={cat.key}>
            <Card
              hoverable
              onClick={() => navigate(cat.path)}
              style={{
                borderLeft: `4px solid ${cat.borderColor}`,
                height: '100%',
              }}
              bodyStyle={{ padding: 20 }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                <div
                  style={{
                    width: 64,
                    height: 64,
                    borderRadius: 12,
                    backgroundColor: cat.color,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {cat.icon}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Title level={5} style={{ margin: 0 }}>{cat.title}</Title>
                    <Badge count={cat.count} style={{ backgroundColor: cat.borderColor }} />
                  </div>
                  <Text type="secondary" style={{ fontSize: 13, marginTop: 4, display: 'block' }}>
                    {cat.description}
                  </Text>
                </div>
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      <Card title="Quick Links - Most Used Reports" bordered={false}>
        <Row gutter={[16, 12]}>
          {quickLinks.map((link) => (
            <Col xs={12} sm={8} md={6} lg={4} key={link.label}>
              <Card
                size="small"
                hoverable
                onClick={() => navigate(link.path)}
                bodyStyle={{ textAlign: 'center', padding: '16px 8px' }}
              >
                <div style={{ fontSize: 24, color: '#eb2f96', marginBottom: 8 }}>{link.icon}</div>
                <Text style={{ fontSize: 13 }}>{link.label}</Text>
              </Card>
            </Col>
          ))}
        </Row>
      </Card>
    </div>
  );
};

export default ReportsDashboard;
