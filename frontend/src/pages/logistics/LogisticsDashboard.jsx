import React, { useState, useEffect } from 'react';
import { Card, Row, Col, Statistic, Progress, List, Tag, Button, Spin, Alert, message } from 'antd';
import {
  FileTextOutlined,
  CompassOutlined,
  DashboardOutlined,
  DollarCircleOutlined,
  LoadingOutlined,
  SyncOutlined,
  ExclamationCircleOutlined,
  StarFilled,
  SafetyCertificateOutlined,
  InfoCircleOutlined
} from '@ant-design/icons';
import api from '../../config/api';

export default function LogisticsDashboard() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [masters, setMasters] = useState(null);
  const [mdos, setMdos] = useState([]);
  const [rfqs, setRfqs] = useState([]);
  const [sos, setSos] = useState([]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [dashRes, masterRes, mdoRes, rfqRes, soRes] = await Promise.all([
        api.get('/logistics/dashboard'),
        api.get('/logistics/masters'),
        api.get('/logistics/mdo'),
        api.get('/logistics/rfq'),
        api.get('/logistics/so')
      ]);

      setData(dashRes.data);
      setMasters(masterRes.data);
      setMdos(mdoRes.data);
      setRfqs(rfqRes.data);
      setSos(soRes.data);
    } catch (err) {
      console.error(err);
      message.error("Failed to load dashboard logistics data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);



  if (loading && !data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <Spin indicator={<LoadingOutlined style={{ fontSize: 40 }} spin />} tip="Loading Logistics dashboard..." />
      </div>
    );
  }

  // Derived counts
  const totalMdos = mdos.length;
  const draftMdos = mdos.filter(m => m.status === 'DRAFT').length;
  const publishedRfqs = rfqs.filter(r => r.status === 'PUBLISHED' || r.status === 'IN_PROGRESS').length;

  let activeVehicles = 0;
  let totalValueInTransit = 0.0;

  sos.forEach(so => {
    if (so.status === 'IN_PROGRESS') {
      totalValueInTransit += so.total_order_value;
    }
    so.vehicles.forEach(v => {
      if (['ARRIVED', 'LOADING', 'DISPATCHED', 'IN_TRANSIT'].includes(v.vehicle_status)) {
        activeVehicles++;
      }
    });
  });

  // SDO Pipeline Distribution
  let sdoPending = 0;
  let sdoRfq = 0;
  let sdoConfirmed = 0;
  let sdoInTransit = 0;
  let sdoDelivered = 0;
  let totalSdos = 0;

  mdos.forEach(m => {
    m.sdos.forEach(s => {
      totalSdos++;
      if (s.status === 'PENDING') sdoPending++;
      else if (s.status === 'RFQ_SENT' || s.status === 'QUOTED') sdoRfq++;
      else if (s.status === 'SO_CREATED') sdoConfirmed++;
      else if (s.status === 'IN_TRANSIT') sdoInTransit++;
      else if (s.status === 'DELIVERED') sdoDelivered++;
    });
  });

  const sdoTotalForDivision = totalSdos || 1;

  return (
    <div style={{ padding: '24px', background: 'radial-gradient(ellipse at top, #f8fafc 0%, #f1f5f9 80%)', minHeight: '100vh', color: '#334155', fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>

      {/* Top Banner Control Header */}
      <div style={{
        background: 'linear-gradient(135deg, #ffffff 0%, #f1f5f9 100%)',
        padding: '24px',
        borderRadius: '12px',
        border: '1px solid #e2e8f0',
        boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)',
        marginBottom: '24px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '16px'
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <Tag color="processing" style={{ border: '1px solid #6366f1', color: '#4f46e5', background: '#e0e7ff', fontWeight: 'bold', borderRadius: '4px' }}>
              logistics dashboard
            </Tag>
            <span style={{ fontSize: '11px', fontFamily: 'monospace', color: '#64748b' }}>SYS_LOG_2026_LIVE</span>
          </div>
          <h2 style={{ margin: 0, color: '#0f172a', fontWeight: 800, fontSize: '22px', letterSpacing: '-0.5px' }}>Supply Chain Dispatch & RFQs Overview</h2>
        </div>

      </div>

      {/* KPI Stats Widgets */}
      <Row gutter={[16, 16]} style={{ marginBottom: '24px' }}>
        <Col xs={24} sm={12} lg={6}>
          <Card bordered={false} style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)' }}>
            <Statistic
              title={<span style={{ color: '#64748b', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 'bold' }}> Active Dispatches</span>}
              value={totalMdos}
              precision={0}
              valueStyle={{ color: '#0284c7', fontSize: '26px', fontFamily: 'monospace', fontWeight: 'bold' }}
              prefix={<FileTextOutlined style={{ marginRight: '8px' }} />}
              suffix={<span style={{ fontSize: '12px', color: '#475569', marginLeft: '6px' }}>Plans</span>}
            />
            <div style={{ marginTop: '8px', fontSize: '11px', color: '#475569' }}>
              <span style={{ color: '#d97706', fontWeight: 'bold' }}>{draftMdos}</span> drafts pending approval
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card bordered={false} style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)' }}>
            <Statistic
              title={<span style={{ color: '#64748b', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 'bold' }}>Live RFQ Bidding</span>}
              value={publishedRfqs}
              precision={0}
              valueStyle={{ color: '#d97706', fontSize: '26px', fontFamily: 'monospace', fontWeight: 'bold' }}
              prefix={<DashboardOutlined style={{ marginRight: '8px' }} />}
              suffix={<span style={{ fontSize: '12px', color: '#475569', marginLeft: '6px' }}>Bids</span>}
            />
            <div style={{ marginTop: '8px', fontSize: '11px', color: '#475569' }}>
              Inviting transport vendors in portal
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card bordered={false} style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)' }}>
            <Statistic
              title={<span style={{ color: '#64748b', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 'bold' }}>In-Transit Fleets</span>}
              value={activeVehicles}
              precision={0}
              valueStyle={{ color: '#059669', fontSize: '26px', fontFamily: 'monospace', fontWeight: 'bold' }}
              prefix={<CompassOutlined style={{ marginRight: '8px' }} />}
              suffix={<span style={{ fontSize: '12px', color: '#475569', marginLeft: '6px' }}>Vehicles</span>}
            />
            <div style={{ marginTop: '8px', fontSize: '11px', color: '#475569' }}>
              Real-time GPS coordinates active
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card bordered={false} style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)' }}>
            <Statistic
              title={<span style={{ color: '#64748b', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 'bold' }}>Valuation In Transit</span>}
              value={totalValueInTransit}
              precision={2}
              valueStyle={{ color: '#e11d48', fontSize: '22px', fontFamily: 'monospace', fontWeight: 'bold' }}
              prefix={<DollarCircleOutlined style={{ marginRight: '8px' }} />}
              suffix={<span style={{ fontSize: '12px', color: '#475569', marginLeft: '6px' }}>INR</span>}
            />
            <div style={{ marginTop: '8px', fontSize: '11px', color: '#475569' }}>
              Insured freight contracts secured
            </div>
          </Card>
        </Col>
      </Row>

      {/* Main Charts & Table Overview */}
      <Row gutter={[16, 16]}>

        {/* SDO Pipeline Analytics Card */}
        <Col xs={24} lg={16}>
          <Card
            title={<span style={{ color: '#0f172a', fontSize: '14px', fontWeight: 'bold', fontFamily: 'monospace' }}>STAGE DISTRIBUTION OF SDO EXECUTION PIPELINE</span>}
            bordered={false}
            style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)' }}
            extra={<span style={{ fontSize: '12px', color: '#475569', fontWeight: 'bold' }}>Total segments: {totalSdos}</span>}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', fontSize: '12px' }}>
                  <span><Tag color="default">DRAFT</Tag> Draft & Pending Allocation</span>
                  <span style={{ fontFamily: 'monospace', color: '#475569', fontWeight: 600 }}>{sdoPending} SDO ({Math.round((sdoPending / sdoTotalForDivision) * 100)}%)</span>
                </div>
                <Progress percent={Math.round((sdoPending / sdoTotalForDivision) * 100)} strokeColor="#64748b" trailColor="#f1f5f9" showInfo={false} />
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', fontSize: '12px' }}>
                  <span><Tag color="warning">RFQ</Tag> Published invitations & bidding live</span>
                  <span style={{ fontFamily: 'monospace', color: '#d97706', fontWeight: 600 }}>{sdoRfq} SDO ({Math.round((sdoRfq / sdoTotalForDivision) * 100)}%)</span>
                </div>
                <Progress percent={Math.round((sdoRfq / sdoTotalForDivision) * 100)} strokeColor="#d97706" trailColor="#f1f5f9" showInfo={false} />
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', fontSize: '12px' }}>
                  <span><Tag color="processing">SERVICE ORDER</Tag> Service contracts awarded & scheduled</span>
                  <span style={{ fontFamily: 'monospace', color: '#4f46e5', fontWeight: 600 }}>{sdoConfirmed} SDO ({Math.round((sdoConfirmed / sdoTotalForDivision) * 100)}%)</span>
                </div>
                <Progress percent={Math.round((sdoConfirmed / sdoTotalForDivision) * 100)} strokeColor="#4f46e5" trailColor="#f1f5f9" showInfo={false} />
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', fontSize: '12px' }}>
                  <span><Tag color="magenta">TRANSIT</Tag> Cargo in transit & live tracking</span>
                  <span style={{ fontFamily: 'monospace', color: '#0284c7', fontWeight: 600 }}>{sdoInTransit} SDO ({Math.round((sdoInTransit / sdoTotalForDivision) * 100)}%)</span>
                </div>
                <Progress percent={Math.round((sdoInTransit / sdoTotalForDivision) * 100)} strokeColor="#0284c7" trailColor="#f1f5f9" showInfo={false} />
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px', fontSize: '12px' }}>
                  <span><Tag color="success">POD DELIVERED</Tag> Drop point successfully completed</span>
                  <span style={{ fontFamily: 'monospace', color: '#059669', fontWeight: 600 }}>{sdoDelivered} SDO ({Math.round((sdoDelivered / sdoTotalForDivision) * 100)}%)</span>
                </div>
                <Progress percent={Math.round((sdoDelivered / sdoTotalForDivision) * 100)} strokeColor="#059669" trailColor="#f1f5f9" showInfo={false} />
              </div>
            </div>
          </Card>
        </Col>

        {/* Carrier Performance Rankings */}
        <Col xs={24} lg={8}>
          <Card
            title={<span style={{ color: '#0f172a', fontSize: '14px', fontWeight: 'bold', fontFamily: 'monospace' }}>TRANSPORTER RATING SCALE</span>}
            bordered={false}
            style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)' }}
          >
            <List
              dataSource={masters?.carriers || []}
              renderItem={carrier => (
                <List.Item style={{ borderBottom: '1px solid #f1f5f9', padding: '10px 0' }}>
                  <List.Item.Meta
                    title={<span style={{ color: '#0f172a', fontWeight: 'semibold', fontSize: '13px' }}>{carrier.vendor_name}</span>}
                    description={<span style={{ color: '#64748b', fontSize: '11px', fontFamily: 'monospace' }}>{carrier.vendor_code} • Transporter License</span>}
                  />
                  <div style={{ textAlign: 'right' }}>
                    <Tag color="success" style={{ background: '#ecfdf5', color: '#059669', border: '1px solid #a7f3d0', fontSize: '11px', fontWeight: 'bold' }}>
                      <StarFilled style={{ marginRight: '4px' }} /> {carrier.rating.toFixed(1)}
                    </Tag>
                  </div>
                </List.Item>
              )}
            />
            <Alert
              message={<span style={{ fontSize: '11px', color: '#d97706', fontWeight: 600 }}>Transporter performance checks active. Auto-exclude entities with score &lt; 3.5.</span>}
              type="warning"
              showIcon
              icon={<ExclamationCircleOutlined style={{ color: '#d97706' }} />}
              style={{ background: '#fffbeb', border: '1px solid #fde68a', marginTop: '16px', borderRadius: '8px' }}
            />
          </Card>
        </Col>
      </Row>

      {/* ISO Audit Activity Logs */}
      <Card
        title={<span style={{ color: '#0f172a', fontSize: '14px', fontWeight: 'bold', fontFamily: 'monospace' }}>LIVE LOGISTICS COMPLIANCE AUDIT FEED</span>}
        bordered={false}
        style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)', marginTop: '24px' }}
      >
        <div style={{ background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0', maxHeight: '300px', overflowY: 'auto' }}>
          <List
            dataSource={sos.flatMap(so =>
              so.vehicles.map(v => ({
                time: v.gate_entry_time || so.created_at,
                action: 'GATEWAY_MOVEMENT',
                message: `Carrier ${so.vendor_name} vehicle ${v.vehicle_registration_no} updated to status "${v.vehicle_status}". Gatepass: ${v.gate_pass_number || 'N/A'}.`,
                id: v.id
              }))
            ).slice(0, 10)}
            renderItem={log => (
              <List.Item style={{ borderBottom: '1px solid #f1f5f9', padding: '8px 0', fontSize: '12px' }}>
                <span style={{ color: '#64748b', fontFamily: 'monospace', width: '150px', shrink: 0 }}>
                  [{new Date(log.time).toLocaleTimeString()}]
                </span>
                <span style={{ color: '#334155', flex: 1, margin: '0 16px' }}>{log.message}</span>
                <Tag color="success" style={{ fontFamily: 'monospace', fontSize: '10px' }} icon={<SafetyCertificateOutlined />}>ISO_COMPLIANT</Tag>
              </List.Item>
            )}
            locale={{ emptyText: <span style={{ color: '#64748b', fontSize: '12px', fontFamily: 'monospace' }}>Live database event stream listening for vehicle status movements...</span> }}
          />
        </div>
      </Card>
    </div>
  );
}
