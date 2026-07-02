import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Row, Col, Statistic, Button, Table, Tag, Spin, Space, Progress, Empty } from 'antd';
import {
  InboxOutlined,
  DollarOutlined,
  WarningOutlined,
  HourglassOutlined,
  PlusOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  Cell,
  PieChart,
  Pie,
} from 'recharts';
import api from '../../config/api';
import { formatCurrency, formatNumber } from '../../utils/helpers';

const COLORS = ['#900078', '#481890', '#fa8c16', '#fa541c', '#1677ff'];

const InventoryDashboard = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState({});
  const [alerts, setAlerts] = useState({});
  const [warehouseDistribution, setWarehouseDistribution] = useState([]);

  useEffect(() => {
    fetchInventoryData();
  }, []);

  const fetchInventoryData = async () => {
    try {
      setLoading(true);
      const [sumRes, alertsRes, whRes] = await Promise.all([
        api.get('/inventory/stock-balance/summary'),
        api.get('/dashboard/alerts'),
        api.get('/inventory/reports', { params: { report_type: 'warehouse_balance', page_size: 100 } }),
      ]);

      setSummary(sumRes.data || {});
      setAlerts(alertsRes.data || {});

      // Process warehouse balance reports to get total value per warehouse
      const whBalances = whRes.data?.items || whRes.data || [];
      const whMap = {};
      whBalances.forEach(item => {
        const whName = item.warehouse_name || 'Other';
        const val = Number(item.value || 0);
        whMap[whName] = (whMap[whName] || 0) + val;
      });
      const whData = Object.entries(whMap).map(([name, value]) => ({
        name,
        value: Math.round(value),
      })).sort((a, b) => b.value - a.value).slice(0, 5); // top 5 warehouses
      
      setWarehouseDistribution(whData);

    } catch (error) {
      console.error('Failed to fetch inventory dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  const lowStockColumns = [
    { title: 'Item Code', dataIndex: 'item_code', key: 'item_code' },
    { title: 'Item Name', dataIndex: 'name', key: 'item_name', ellipsis: true },
    { title: 'Reorder Level', dataIndex: 'reorder_level', key: 'reorder_level', align: 'right', render: (v) => formatNumber(v) },
    { 
      title: 'Available Qty', 
      dataIndex: 'available_qty', 
      key: 'available_qty', 
      align: 'right', 
      render: (v, r) => (
        <span style={{ color: '#f5222d', fontWeight: 600 }}>
          {formatNumber(v)}
        </span>
      ) 
    },
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <Spin size="large" tip="Loading Inventory Dashboard..." />
      </div>
    );
  }

  return (
    <div style={{ padding: '24px', background: '#F8F9FA', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '28px', color: '#1A1A1A', fontWeight: 600 }}>Inventory Dashboard</h1>
          <p style={{ margin: 0, color: '#6C757D' }}>Monitor stock levels, expiry timelines, safety limits, and valuations.</p>
        </div>
        <Space>
          <Button 
            type="primary" 
            icon={<PlusOutlined />} 
            onClick={() => navigate('/inventory/stock-transfer/new')}
            style={{ background: '#900078', borderColor: '#900078', height: '40px', borderRadius: '6px' }}
          >
            Stock Transfer
          </Button>
        </Space>
      </div>

      {/* KPI Cards Row */}
      <Row gutter={[16, 16]} style={{ marginBottom: '24px' }}>
        <Col xs={24} sm={12} md={6}>
          <Card 
            hoverable 
            bodyStyle={{ padding: '20px' }}
            style={{ borderRadius: '8px', borderLeft: '4px solid #900078', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <Statistic
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>Total Stock Value</span>}
              value={summary.total_stock_value ?? 0}
              precision={2}
              formatter={(val) => formatCurrency(val)}
              prefix={<DollarOutlined style={{ color: '#900078', marginRight: '8px' }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} md={6}>
          <Card 
            hoverable 
            bodyStyle={{ padding: '20px' }}
            style={{ borderRadius: '8px', borderLeft: '4px solid #481890', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <Statistic
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>Active SKUs</span>}
              value={summary.total_items ?? 0}
              prefix={<InboxOutlined style={{ color: '#481890', marginRight: '8px' }} />}
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
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>Low-Stock Warnings</span>}
              value={summary.low_stock_alerts || alerts.low_stock_count || 0}
              prefix={<WarningOutlined style={{ color: '#fa8c16', marginRight: '8px' }} />}
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
              title={<span style={{ color: '#6C757D', fontWeight: 500 }}>Expiring Soon (FEFO)</span>}
              value={summary.expiring_soon || alerts.expiring_count || 0}
              prefix={<HourglassOutlined style={{ color: '#fa541c', marginRight: '8px' }} />}
            />
          </Card>
        </Col>
      </Row>

      {/* Charts Row */}
      <Row gutter={[16, 16]} style={{ marginBottom: '24px' }}>
        {/* Stock Valuation by Warehouse */}
        <Col xs={24} lg={16}>
          <Card 
            title="Stock Value Distribution by Warehouse" 
            style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <div style={{ height: '300px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
              {warehouseDistribution.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={warehouseDistribution} margin={{ top: 20, right: 30, left: 10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" stroke="#6C757D" tickLine={false} />
                    <YAxis tickLine={false} />
                    <Tooltip formatter={(value) => formatCurrency(value)} />
                    <Bar dataKey="value" name="Stock Value" fill="#900078" radius={[4, 4, 0, 0]}>
                      {warehouseDistribution.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <Empty description="No warehouse stock value distribution data available" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              )}
            </div>
          </Card>
        </Col>

        {/* Safety Stock Compliance Ratio */}
        <Col xs={24} lg={8}>
          <Card 
            title="Safety Stock Health" 
            style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <div style={{ height: '300px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '16px' }}>
              <Progress
                type="dashboard"
                percent={Math.max(0, Math.round(((summary.total_items - (summary.low_stock_alerts || 0)) / (summary.total_items || 1)) * 100))}
                strokeColor={{ '0%': '#fa8c16', '100%': '#900078' }}
                width={150}
              />
              <div style={{ marginTop: '24px', textAlign: 'center' }}>
                <span style={{ fontSize: '15px', color: '#495057', fontWeight: 500 }}>
                  {summary.total_items - (summary.low_stock_alerts || 0)} / {summary.total_items} SKUs
                </span>
                <p style={{ color: '#6C757D', margin: '4px 0 0', fontSize: '13px' }}>
                  Items are safely stocked above their reorder points.
                </p>
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      {/* Critical Lists and Actions */}
      <Row gutter={[16, 16]}>
        {/* Critical Low Stock Items */}
        <Col xs={24} md={16}>
          <Card 
            title="Critical Low-Stock Items" 
            extra={<Button type="link" onClick={() => navigate('/inventory/stock-balance')}>View Stock Balance</Button>}
            style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            {alerts.low_stock?.length > 0 ? (
              <Table
                dataSource={alerts.low_stock.slice(0, 5).map(item => ({ ...item, key: item.id }))}
                columns={lowStockColumns}
                pagination={false}
                size="middle"
              />
            ) : (
              <Empty description="No low-stock items detected!" />
            )}
          </Card>
        </Col>

        {/* Quick Actions Panel */}
        <Col xs={24} md={8}>
          <Card 
            title="Inventory Operations" 
            style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <Button 
                type="primary" 
                icon={<PlusOutlined />} 
                onClick={() => navigate('/inventory/stock-transfer/new')}
                block
                style={{ background: '#900078', borderColor: '#900078', height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
              >
                New Stock Transfer
              </Button>
              <Button 
                icon={<ArrowRightOutlined />} 
                onClick={() => navigate('/inventory/stock-audit')}
                block
                style={{ height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
              >
                Perform Stock Audit
              </Button>
              <Button 
                icon={<ArrowRightOutlined />} 
                onClick={() => navigate('/inventory/replenishment')}
                block
                style={{ height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', borderRadius: '6px' }}
              >
                Run Replenishment Tool
              </Button>
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default InventoryDashboard;
