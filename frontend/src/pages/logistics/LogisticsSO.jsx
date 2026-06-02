import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Badge, Button, Form, Select, Input, InputNumber, Space, Spin, message, Row, Col, Divider, Steps, Alert, Tooltip, Rate, DatePicker } from 'antd';
import {
  CarOutlined,
  CheckCircleOutlined,
  AuditOutlined,
  WarningOutlined,
  InfoCircleOutlined,
  PlayCircleOutlined,
  FileDoneOutlined,
  EnvironmentOutlined
} from '@ant-design/icons';
import api from '../../config/api';
import dayjs from 'dayjs';
import { useLocation, useNavigate } from 'react-router-dom';

const { Option } = Select;
const { Step } = Steps;

export default function LogisticsSO() {
  const location = useLocation();
  const navigate = useNavigate();

  const pathname = location.pathname;
  const isGatingTab = pathname === '/logistics/so-gating';
  const isAcknowledgeTab = pathname === '/logistics/so-acknowledge';
  const isDefaultTab = pathname === '/logistics/so';

  const [loading, setLoading] = useState(true);
  const [sos, setSos] = useState([]);
  const [masters, setMasters] = useState(null);
  const [selectedSo, setSelectedSo] = useState(null);
  const [selectedVehicle, setSelectedVehicle] = useState(null);

  const [linkedDispatch, setLinkedDispatch] = useState(null);
  const [searchingDispatch, setSearchingDispatch] = useState(false);

  const [activeTransporterId, setActiveTransporterId] = useState(null);

  // Active role is dictated by the tab
  const activeRole = 'COORDINATOR';

  // Forms
  const [ackForm] = Form.useForm();
  const [gatingForm] = Form.useForm();
  const [issueForm] = Form.useForm();
  const [checkInForm] = Form.useForm();

  const fetchData = async () => {
    try {
      setLoading(true);
      const [soRes, masterRes] = await Promise.all([
        api.get('/logistics/so'),
        api.get('/logistics/masters')
      ]);
      setSos(soRes.data);
      setMasters(masterRes.data);

      if (masterRes.data?.carriers.length > 0 && !activeTransporterId) {
        setActiveTransporterId(masterRes.data.carriers[0].vendor_id);
      }

      // Sync selection states if active
      if (selectedSo) {
        const updatedSo = soRes.data.find(s => s.id === selectedSo.id);
        setSelectedSo(updatedSo || null);
        if (selectedVehicle && updatedSo) {
          const updatedVeh = updatedSo.vehicles.find(v => v.id === selectedVehicle.id);
          setSelectedVehicle(updatedVeh || null);
        }
      }
    } catch (err) {
      console.error(err);
      message.error("Failed to load B2B Service Orders registers.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Sync state from query parameters and sessionStorage on data load
  useEffect(() => {
    if (sos.length > 0) {
      const queryParams = new URLSearchParams(location.search);
      const querySoId = queryParams.get('soId');
      const queryVehicleId = queryParams.get('vehicleId');

      const storedSoId = sessionStorage.getItem('selectedSoId');
      const storedVehId = sessionStorage.getItem('selectedVehicleId');

      const targetSoId = querySoId ? parseInt(querySoId) : (storedSoId ? parseInt(storedSoId) : null);
      const targetVehId = queryVehicleId ? parseInt(queryVehicleId) : (storedVehId ? parseInt(storedVehId) : null);

      let matchedSo = sos.find(s => s.id === targetSoId);
      if (!matchedSo) {
        matchedSo = sos[0];
      }

      if (matchedSo) {
        setSelectedSo(matchedSo);
        let matchedVeh = matchedSo.vehicles?.find(v => v.id === targetVehId);
        if (!matchedVeh) {
          matchedVeh = matchedSo.vehicles?.[0] || null;
        }
        setSelectedVehicle(matchedVeh);
      }
    }
  }, [sos, location.search]);

  // Sync selection to search parameters and sessionStorage
  useEffect(() => {
    const findLinkedDispatch = async () => {
      if (!selectedVehicle || !selectedVehicle.vehicle_registration_no) {
        setLinkedDispatch(null);
        return;
      }
      setSearchingDispatch(true);
      try {
        // Search in outbound dispatch orders
        const res = await api.get('/outbound/dispatch-orders', { params: { page_size: 100 } });
        const items = res.data?.items || res.data?.data || [];
        const matched = items.find(d => 
          d.vehicle_number?.trim().toLowerCase() === selectedVehicle.vehicle_registration_no?.trim().toLowerCase()
        );
        
        if (matched) {
          setLinkedDispatch(matched);
        } else {
          // Fallback to warehouse dispatches
          const whRes = await api.get('/warehouse/dispatch', { params: { search: selectedVehicle.vehicle_registration_no } });
          const whItems = whRes.data?.items || whRes.data?.data || whRes.data || [];
          if (whItems.length > 0) {
            setLinkedDispatch(whItems[0]);
          } else {
            setLinkedDispatch(null);
          }
        }
      } catch (err) {
        console.error('Failed to find linked dispatch', err);
        setLinkedDispatch(null);
      } finally {
        setSearchingDispatch(false);
      }
    };
    findLinkedDispatch();
  }, [selectedVehicle]);
  const handleSelectSo = (record) => {
    setSelectedSo(record);
    const firstVeh = record.vehicles?.[0] || null;
    setSelectedVehicle(firstVeh);

    sessionStorage.setItem('selectedSoId', record.id);
    if (firstVeh) {
      sessionStorage.setItem('selectedVehicleId', firstVeh.id);
    } else {
      sessionStorage.removeItem('selectedVehicleId');
    }

    const searchParams = new URLSearchParams(location.search);
    searchParams.set('soId', record.id);
    if (firstVeh) {
      searchParams.set('vehicleId', firstVeh.id);
    } else {
      searchParams.delete('vehicleId');
    }
    navigate({ search: searchParams.toString() }, { replace: true });
  };

  const handleSelectVehicle = (v) => {
    setSelectedVehicle(v);
    sessionStorage.setItem('selectedVehicleId', v.id);

    const searchParams = new URLSearchParams(location.search);
    searchParams.set('vehicleId', v.id);
    navigate({ search: searchParams.toString() }, { replace: true });
  };

  const handleAcknowledgeSo = async (values) => {
    try {
      setLoading(true);
      await api.post(`/logistics/so/${selectedSo.id}/acknowledge`, {
        remarks: values.remarks || 'Acknowledged B2B freight dispatch terms. Vehicles active.',
        arrival_date: values.arrival_date ? values.arrival_date.format('YYYY-MM-DD') : null
      });
      message.success("Service Order contract successfully acknowledged!");
      ackForm.resetFields();
      await fetchData();
    } catch (err) {
      console.error(err);
      message.error("Failed to acknowledge Service Order.");
      setLoading(false);
    }
  };

  const handleGatingSubmit = async (values) => {
    try {
      setLoading(true);
      const payload = {
        nextStatus: values.nextStatus,
        gatePassNumber: values.gatePassNumber,
        lrNumber: values.lrNumber,
        ewayBillNumber: values.ewayBillNumber,
        podReceivedBy: values.podReceivedBy,
        podDocumentUrl: values.podDocumentUrl || '/pod_document_signed.pdf',
        feedbackText: values.feedbackText,
        ratingValue: values.ratingValue,
        delayMinutes: values.delayMinutes || 0,
        delayReasonText: values.delayReasonText
      };

      await api.post(`/logistics/so/vehicle/${selectedVehicle.id}/status`, payload);
      message.success(`Vehicle gating transitioned to ${values.nextStatus}!`);
      gatingForm.resetFields();
      await fetchData();
    } catch (err) {
      console.error(err);
      message.error("Failed to update vehicle checkpoint status.");
      setLoading(false);
    }
  };

  const handleLogIssue = async (values) => {
    try {
      setLoading(true);
      await api.post(`/logistics/so/vehicle/${selectedVehicle.id}/issue`, {
        issueDescription: values.issueDescription
      });
      message.warning("Driver transit alert filed and logged to control tower.");
      issueForm.resetFields();
      await fetchData();
    } catch (err) {
      console.error(err);
      message.error("Failed to file vehicle alert.");
      setLoading(false);
    }
  };

  const getVehicleStatusIndex = (status) => {
    if (['SCHEDULED', 'ARRIVED', 'LOADING'].includes(status)) return 0;
    if (status === 'DISPATCHED') return 1;
    if (status === 'IN_TRANSIT') return 2;
    if (status === 'DELIVERED' || status === 'COMPLETED') return 3;
    return 0;
  };

  const getStatusTag = (status) => {
    const colors = {
      'CREATED': 'blue',
      'ACKNOWLEDGED': 'purple',
      'IN_PROGRESS': 'cyan',
      'COMPLETED': 'success',
      'CANCELLED': 'error'
    };
    return <Tag color={colors[status] || 'default'}>{status}</Tag>;
  };

  const getVehicleStatusTag = (status) => {
    const colors = {
      'SCHEDULED': 'default',
      'ARRIVED': 'cyan',
      'LOADING': 'warning',
      'DISPATCHED': 'purple',
      'IN_TRANSIT': 'processing',
      'DELIVERED': 'success',
      'CANCELLED': 'error'
    };
    return <Tag color={colors[status] || 'default'}>{status}</Tag>;
  };

  // Filters SOs based on active simulation view
  const visibleSos = activeRole === 'TRANSPORTER'
    ? sos.filter(s => s.vendor_id === activeTransporterId)
    : sos;

  const carrierDetail = masters?.carriers.find(c => c.vendor_id === activeTransporterId);

  return (
    <div style={{ padding: '24px', background: 'radial-gradient(ellipse at top, #f8fafc 0%, #f1f5f9 80%)', minHeight: '100vh', color: '#334155', fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>
      
      {/* Main Header */}
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <h2 style={{ color: '#0f172a', margin: 0, fontWeight: 800, fontSize: '20px', letterSpacing: '-0.5px' }}>
            {isGatingTab && "Vehicle Gating & Progress Checkpoints"}
            {isAcknowledgeTab && "Acknowledge Delivery & Sign POD"}
            {isDefaultTab && "Logistics Service Orders"}
          </h2>
          <p style={{ color: '#475569', fontSize: '13px', margin: '4px 0 0 0', lineHeight: 1.5 }}>
            {isGatingTab && "Verify vehicle checkpoint logs, lorry receipts, gate pass entries, and delivery pod sign-offs."}
            {isAcknowledgeTab && "Record consignee receipt verification, carrier feedback scores, delay logs, and finalize POD sign-off."}
            {isDefaultTab && "Finalized B2B freight order contracts. Monitor vehicle dispatch progress, gate passes, and audit compliance metrics."}
          </p>
        </div>

      </div>

      <Row gutter={[16, 16]}>
        {/* Left Column: Service Orders Table */}
        <Col xs={24} lg={12}>
          <Card 
            title={<span style={{ color: '#0f172a', fontSize: '13px', fontWeight: 'bold', fontFamily: 'monospace' }}>B2B FREIGHT CONTRACTS ({visibleSos.length})</span>}
            style={{ background: '#ffffff', borderColor: '#e2e8f0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)' }}
          >
            <Table
              dataSource={visibleSos}
              rowKey="id"
              className="logistics-dark-table"
              pagination={{ pageSize: 6 }}
              onRow={(record) => ({
                onClick: () => handleSelectSo(record)
              })}
              rowClassName={(record) => selectedSo?.id === record.id ? 'logistics-selected-row' : ''}
              columns={[
                { title: 'SO Number', dataIndex: 'so_number', key: 'soNum', render: t => <span style={{ fontFamily: 'monospace', color: '#0284c7', fontWeight: 'bold' }}>{t}</span> },
                { title: 'Carrier Name', dataIndex: 'vendor_name', key: 'carrier', render: t => <span style={{ fontWeight: 'semibold', color: '#0f172a' }}>{t}</span> },
                { title: 'Order Value', dataIndex: 'total_order_value', key: 'val', render: v => <span style={{ fontFamily: 'monospace' }}>₹{v.toLocaleString()}</span> },
                { title: 'Status', dataIndex: 'status', key: 'st', render: s => getStatusTag(s) }
              ]}
              locale={{ emptyText: <span style={{ color: '#64748b', fontSize: '12px', fontFamily: 'monospace' }}>No service order contracts generated. Ensure an RFQ is awarded.</span> }}
            />
          </Card>
        </Col>

        {/* Right Column: Dynamic Tab View */}
        <Col xs={24} lg={12}>
          {selectedSo ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              


              {/* Tab: Gating Checkpoints */}
              {isGatingTab && (
                <>
                  <Card
                    style={{ background: '#ffffff', borderColor: '#e2e8f0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)' }}
                    title={<span style={{ color: '#0f172a', fontSize: '13px', fontWeight: 'bold', fontFamily: 'monospace' }}>VEHICLES TIMELINE</span>}
                  >
                    <div style={{ display: 'flex', gap: '10px', overflowX: 'auto', paddingBottom: '10px', marginBottom: '16px' }}>
                      {selectedSo.vehicles?.map(v => (
                        <div
                           key={v.id}
                           onClick={() => handleSelectVehicle(v)}
                           style={{
                             padding: '12px',
                             background: selectedVehicle?.id === v.id ? '#e0f2fe' : '#f8fafc',
                             border: selectedVehicle?.id === v.id ? '1px solid #0284c7' : '1px solid #cbd5e1',
                             borderRadius: '6px',
                             cursor: 'pointer',
                             minWidth: '180px',
                             transition: 'all 0.2s'
                           }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                            <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#0f172a', fontFamily: 'monospace' }}>
                              <CarOutlined /> {v.vehicle_registration_no || 'TBD'}
                            </span>
                            {v.has_issues && <Tag color="error" style={{ margin: 0 }}>ALERT</Tag>}
                          </div>
                          <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '8px' }}>Driver: {v.driver_name}</div>
                          <div>{getVehicleStatusTag(v.vehicle_status)}</div>
                        </div>
                      ))}
                    </div>

                    {selectedVehicle ? (
                      <div style={{ background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #cbd5e1' }}>
                        <div style={{ overflowX: 'auto', paddingBottom: '12px', marginBottom: '20px' }}>
                          <Steps 
                            size="small" 
                            current={getVehicleStatusIndex(selectedVehicle.vehicle_status)}
                            style={{ minWidth: '450px' }}
                          >
                            <Step title={<span style={{ color: '#334155', fontSize: '11px', fontWeight: 600 }}>Gate Entry</span>} description={<span style={{ fontSize: '9px', color: '#64748b' }}>Check-In</span>} />
                            <Step title={<span style={{ color: '#334155', fontSize: '11px', fontWeight: 600 }}>Dispatched</span>} description={<span style={{ fontSize: '9px', color: '#64748b' }}>LR/Eway</span>} />
                            <Step title={<span style={{ color: '#334155', fontSize: '11px', fontWeight: 600 }}>In Transit</span>} description={<span style={{ fontSize: '9px', color: '#64748b' }}>Live GPS</span>} />
                            <Step title={<span style={{ color: '#334155', fontSize: '11px', fontWeight: 600 }}>Acknowledged</span>} description={<span style={{ fontSize: '9px', color: '#64748b' }}>POD Sign</span>} />
                          </Steps>
                        </div>

                        <Row gutter={[16, 12]} style={{ fontSize: '12px', color: '#334155' }}>
                          <Col xs={12}>Driver Mobile: <strong style={{ color: '#0f172a', fontFamily: 'monospace' }}>{selectedVehicle.driver_mobile}</strong></Col>
                          <Col xs={12}>Vehicle Type: <strong style={{ color: '#0284c7' }}>{selectedVehicle.vehicle_type}</strong></Col>
                          {selectedVehicle.gate_pass_number && <Col xs={12}>Gate Pass: <strong style={{ color: '#059669', fontFamily: 'monospace' }}>{selectedVehicle.gate_pass_number}</strong></Col>}
                          {selectedVehicle.lr_number && <Col xs={12}>Lorry Receipt: <strong style={{ color: '#4f46e5', fontFamily: 'monospace' }}>{selectedVehicle.lr_number}</strong></Col>}
                          {selectedVehicle.eway_bill_number && <Col xs={12}>Eway Bill: <strong style={{ color: '#e11d48', fontFamily: 'monospace' }}>{selectedVehicle.eway_bill_number}</strong></Col>}
                        </Row>
                      </div>
                    ) : (
                      <div style={{ color: '#64748b', fontSize: '12px', textAlign: 'center', padding: '20px' }}>
                        Select a vehicle above to monitor gating milestones...
                      </div>
                    )}
                  </Card>

                  {/* Inline Gating Progress Checkpoint Form */}
                  {selectedVehicle && (
                    <Card
                      style={{ background: '#ffffff', borderColor: '#e2e8f0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)' }}
                      title={
                        <span style={{ color: '#0f172a', fontSize: '13px', fontWeight: 'bold', fontFamily: 'monospace' }}>
                          🏁 ACTIVE GATING STEP: {selectedVehicle.vehicle_status}
                        </span>
                      }
                    >
                      {!selectedSo.acknowledged_by_vendor ? (
                        <Alert
                          message="Gating Updates Locked"
                          description="Gating updates are locked until the Transporter acknowledges the contract deed."
                          type="warning"
                          showIcon
                          style={{ width: '100%' }}
                        />
                      ) : (
                        <>
                          {selectedVehicle.vehicle_status === 'SCHEDULED' && (
                            <div>
                              <Form form={checkInForm} layout="vertical" onFinish={async (values) => {
                                try {
                                  setLoading(true);
                                  await api.post(`/logistics/so/vehicle/${selectedVehicle.id}/status`, {
                                    nextStatus: 'ARRIVED',
                                    gatePassNumber: values.gatePassNumber || null,
                                  });
                                  message.success(`Vehicle checked-in successfully! Status → ARRIVED`);
                                  checkInForm.resetFields();
                                  await fetchData();
                                } catch (err) {
                                  console.error(err);
                                  message.error('Failed to check-in vehicle.');
                                  setLoading(false);
                                }
                              }}>
                                <Form.Item name="gatePassNumber" label="Gate Pass Number" rules={[{ required: true, message: 'Please enter Gate Pass Number!' }]}>
                                  <Input placeholder={`e.g. GP-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`} style={{ fontFamily: 'monospace' }} />
                                </Form.Item>
                                <Alert message="This will mark the vehicle as ARRIVED and log the gate entry timestamp." type="info" showIcon style={{ marginBottom: '16px' }} />
                                <Button type="primary" htmlType="submit" icon={<CheckCircleOutlined />} block loading={loading}>
                                  Confirm Check-In (Mark as ARRIVED)
                                </Button>
                              </Form>
                            </div>
                          )}

                          {selectedVehicle.vehicle_status === 'ARRIVED' && (
                            <div>
                              <Form form={gatingForm} layout="vertical" onFinish={async (values) => {
                                await handleGatingSubmit({ ...values, nextStatus: 'DISPATCHED' });
                              }} initialValues={{
                                lrNumber: `LR-MUM-${Math.floor(10000 + Math.random() * 90000)}`,
                                ewayBillNumber: `EW-2026-${Math.floor(100000 + Math.random() * 900000)}`
                              }}>
                                <Form.Item name="lrNumber" label="Lorry Receipt (LR) Number" rules={[{ required: true }]}>
                                  <Input placeholder="E.g. LR-2026-9812" />
                                </Form.Item>
                                <Form.Item name="ewayBillNumber" label="E-Way Bill Number" rules={[{ required: true }]}>
                                  <Input placeholder="E.g. EW-2026-928122" />
                                </Form.Item>
                                <Button type="primary" htmlType="submit" icon={<AuditOutlined />} block loading={loading}>
                                  Complete Loading & Dispatch
                                </Button>
                              </Form>
                            </div>
                          )}

                          {selectedVehicle.vehicle_status === 'DISPATCHED' && (
                            <div>
                              <Alert 
                                message="Vehicle Dispatched & In Transit" 
                                description="The vehicle has been successfully loaded and dispatched. Live GPS transit tracking is active."
                                type="info" 
                                showIcon 
                              />
                            </div>
                          )}

                          {selectedVehicle.vehicle_status === 'IN_TRANSIT' && (
                            <div>
                              <Alert 
                                message="Awaiting Delivery Acknowledgment" 
                                description={
                                  <div>
                                    <p>Vehicle is currently in transit. To finalize delivery, verify the consignee receipt, and sign the POD, please go to the Acknowledge Delivery tab.</p>
                                    <Button type="primary" size="small" style={{ marginTop: '8px' }} onClick={() => navigate(`/logistics/so-acknowledge?soId=${selectedSo.id}&vehicleId=${selectedVehicle.id}`)}>
                                      Go to Acknowledge Delivery & Sign POD
                                    </Button>
                                  </div>
                                }
                                type="info" 
                                showIcon 
                                style={{ marginBottom: '16px' }}
                              />
                            </div>
                          )}

                          {(selectedVehicle.vehicle_status === 'DELIVERED' || selectedVehicle.vehicle_status === 'COMPLETED') && (
                            <Alert
                              message="✓ Consignment Acknowledged"
                              description={
                                <div style={{ fontSize: '12px' }}>
                                  <p style={{ margin: '4px 0' }}>Vehicle has completed the gating loop and reached the destination successfully.</p>
                                  {selectedVehicle.pod_received_by && <p style={{ margin: '4px 0' }}>POD Signed By: <strong>{selectedVehicle.pod_received_by}</strong></p>}
                                  {selectedVehicle.rating_value && <p style={{ margin: '4px 0' }}>Feedback: <Rate disabled defaultValue={selectedVehicle.rating_value} style={{ fontSize: '12px' }} /></p>}
                                </div>
                              }
                              type="success"
                              showIcon
                            />
                          )}
                        </>
                      )}
                    </Card>
                  )}
                </>
              )}

              {/* Tab: Acknowledge Delivery */}
              {isAcknowledgeTab && (
                <>
                  <Card
                    style={{ background: '#ffffff', borderColor: '#e2e8f0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)' }}
                    title={<span style={{ color: '#0f172a', fontSize: '13px', fontWeight: 'bold', fontFamily: 'monospace' }}>VEHICLES REGISTER</span>}
                  >
                    <div style={{ display: 'flex', gap: '10px', overflowX: 'auto', paddingBottom: '10px', marginBottom: '16px' }}>
                      {selectedSo.vehicles?.map(v => (
                        <div
                           key={v.id}
                           onClick={() => handleSelectVehicle(v)}
                           style={{
                             padding: '12px',
                             background: selectedVehicle?.id === v.id ? '#e0f2fe' : '#f8fafc',
                             border: selectedVehicle?.id === v.id ? '1px solid #0284c7' : '1px solid #cbd5e1',
                             borderRadius: '6px',
                             cursor: 'pointer',
                             minWidth: '180px',
                             transition: 'all 0.2s'
                           }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                            <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#0f172a', fontFamily: 'monospace' }}>
                              <CarOutlined /> {v.vehicle_registration_no || 'TBD'}
                            </span>
                            {v.has_issues && <Tag color="error" style={{ margin: 0 }}>ALERT</Tag>}
                          </div>
                          <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '8px' }}>Driver: {v.driver_name}</div>
                          <div>{getVehicleStatusTag(v.vehicle_status)}</div>
                        </div>
                      ))}
                    </div>

                    {selectedVehicle ? (
                      <div style={{ background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #cbd5e1' }}>
                        <div style={{ overflowX: 'auto', paddingBottom: '12px', marginBottom: '20px' }}>
                          <Steps 
                            size="small" 
                            current={getVehicleStatusIndex(selectedVehicle.vehicle_status)}
                            style={{ minWidth: '450px' }}
                          >
                            <Step title={<span style={{ color: '#334155', fontSize: '11px', fontWeight: 600 }}>Gate Entry</span>} />
                            <Step title={<span style={{ color: '#334155', fontSize: '11px', fontWeight: 600 }}>Dispatched</span>} />
                            <Step title={<span style={{ color: '#334155', fontSize: '11px', fontWeight: 600 }}>In Transit</span>} />
                            <Step title={<span style={{ color: '#334155', fontSize: '11px', fontWeight: 600 }}>Acknowledged</span>} />
                          </Steps>
                        </div>

                        <Row gutter={[16, 12]} style={{ fontSize: '12px', color: '#334155' }}>
                          <Col xs={12}>Driver Mobile: <strong style={{ color: '#0f172a', fontFamily: 'monospace' }}>{selectedVehicle.driver_mobile}</strong></Col>
                          <Col xs={12}>Vehicle Type: <strong style={{ color: '#0284c7' }}>{selectedVehicle.vehicle_type}</strong></Col>
                          {selectedVehicle.gate_pass_number && <Col xs={12}>Gate Pass: <strong style={{ color: '#059669', fontFamily: 'monospace' }}>{selectedVehicle.gate_pass_number}</strong></Col>}
                          {selectedVehicle.lr_number && <Col xs={12}>Lorry Receipt: <strong style={{ color: '#4f46e5', fontFamily: 'monospace' }}>{selectedVehicle.lr_number}</strong></Col>}
                          {selectedVehicle.eway_bill_number && <Col xs={12}>Eway Bill: <strong style={{ color: '#e11d48', fontFamily: 'monospace' }}>{selectedVehicle.eway_bill_number}</strong></Col>}
                        </Row>
                      </div>
                    ) : (
                      <div style={{ color: '#64748b', fontSize: '12px', textAlign: 'center', padding: '20px' }}>
                        Select a vehicle above to acknowledge delivery...
                      </div>
                    )}
                  </Card>

                  {selectedVehicle && (
                    <Card
                      style={{ background: '#ffffff', borderColor: '#e2e8f0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)' }}
                      title={
                        <span style={{ color: '#0f172a', fontSize: '13px', fontWeight: 'bold', fontFamily: 'monospace' }}>
                          📝 SCM UNIVERSAL DELIVERY ACKNOWLEDGEMENT
                        </span>
                      }
                    >
                      {searchingDispatch ? (
                        <div style={{ textAlign: 'center', padding: '30px' }}>
                          <Spin tip="Locating associated SCM Dispatch Order..." />
                        </div>
                      ) : linkedDispatch ? (
                        <div style={{ padding: '8px' }}>
                          {linkedDispatch.status === 'acknowledged' ? (
                            <Alert
                              message={<span style={{ fontWeight: 600 }}>Consignment Fully Acknowledged & Verified!</span>}
                              description={
                                <div style={{ marginTop: '8px', fontSize: '12px' }}>
                                  <p>This shipment was securely signed off and verified using our geofenced Touch-Signature portal.</p>
                                  <div style={{ background: '#f0fdf4', padding: '12px', borderRadius: '6px', border: '1px solid #bbf7d0', marginBottom: '16px' }}>
                                    <Row gutter={[16, 8]}>
                                      <Col span={12}>Dispatch ID: <strong>{linkedDispatch.dispatch_number || linkedDispatch.dispatch_id}</strong></Col>
                                      <Col span={12}>Status: <Tag color="success">Acknowledged</Tag></Col>
                                      <Col span={12}>Receiver Name: <strong>{linkedDispatch.delivery_acknowledged_by_name || 'N/A'}</strong></Col>
                                      <Col span={12}>Date: <strong>{linkedDispatch.delivery_acknowledged_at ? dayjs(linkedDispatch.delivery_acknowledged_at).format('DD/MM/YYYY HH:mm') : 'N/A'}</strong></Col>
                                      <Col span={24}>Delivery Remarks: <em>{linkedDispatch.delivery_remarks || 'None'}</em></Col>
                                    </Row>
                                  </div>
                                  <Button 
                                    type="default" 
                                    icon={<EyeOutlined />} 
                                    onClick={() => navigate(`/logistics/dispatch-orders/${linkedDispatch.dispatch_id || linkedDispatch.id}/acknowledge`)}
                                    block
                                    style={{ height: '40px', fontWeight: 'bold' }}
                                  >
                                    View Digital POD & Signature Evidence
                                  </Button>
                                </div>
                              }
                              type="success"
                              showIcon
                            />
                          ) : (
                            <Alert
                              message={<span style={{ fontWeight: 600 }}>Linked SCM Dispatch Order Found!</span>}
                              description={
                                <div style={{ marginTop: '8px' }}>
                                  <p>We have successfully matched this vehicle to active SCM dispatch <strong>{linkedDispatch.dispatch_number || linkedDispatch.dispatch_id}</strong>. Receipt verification must be completed via the new Universal Evidence-Based Flow.</p>
                                  <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '6px', border: '1px solid #cbd5e1', marginBottom: '16px', fontSize: '12px' }}>
                                    <Row gutter={[16, 8]}>
                                      <Col span={12}>Dispatch ID: <strong style={{ color: '#481890' }}>{linkedDispatch.dispatch_number || linkedDispatch.dispatch_id}</strong></Col>
                                      <Col span={12}>Status: <Tag color="orange">{linkedDispatch.status}</Tag></Col>
                                      <Col span={12}>Destination Type: <strong>{linkedDispatch.destination_type || 'USER'}</strong></Col>
                                      <Col span={12}>Shipment Type: <strong>{linkedDispatch.dispatch_type || 'THIRD_PARTY'}</strong></Col>
                                    </Row>
                                  </div>
                                  <Button 
                                    type="primary" 
                                    icon={<CheckCircleOutlined />} 
                                    onClick={() => navigate(`/logistics/dispatch-orders/${linkedDispatch.dispatch_id || linkedDispatch.id}/acknowledge`)}
                                    block
                                    style={{ backgroundColor: '#481890', borderColor: '#481890', height: '40px', fontWeight: 'bold' }}
                                  >
                                    Proceed to Universal Receipt Acknowledgment & Sign POD
                                  </Button>
                                </div>
                              }
                              type="success"
                              showIcon
                            />
                          )}
                        </div>
                      ) : (
                        <div style={{ padding: '8px' }}>
                          <Alert
                            message="No Active SCM Dispatch Order Linked"
                            description={
                              <div style={{ marginTop: '8px' }}>
                                <p>This vehicle (<strong>{selectedVehicle.vehicle_registration_no}</strong>) does not have a linked warehouse dispatch plan registered under SCM outbound.</p>
                                <p style={{ fontSize: '11px', color: '#64748b' }}>To proceed, please create a new dispatch order using this vehicle registration number so that receipt confirmation can be completed via the secure geofenced Touch-Signature portal.</p>
                                <Space size="middle" style={{ marginTop: '12px', display: 'flex', flexWrap: 'wrap' }}>
                                  <Button 
                                    type="primary" 
                                    ghost
                                    onClick={() => navigate(`/logistics/dispatch-orders/new?vehicle=${selectedVehicle.vehicle_registration_no}`)}
                                  >
                                    Create Dispatch & Acknowledge
                                  </Button>
                                </Space>
                              </div>
                            }
                            type="warning"
                            showIcon
                            style={{ marginBottom: '20px' }}
                          />
                        </div>
                      )}
                    </Card>
                  )}
                </>
              )}



              {/* Tab: Default / Overview tab */}
              {isDefaultTab && (
                <>
                  <Card
                    style={{ background: '#ffffff', borderColor: '#e2e8f0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)' }}
                    title={<span style={{ color: '#0f172a', fontSize: '13px', fontWeight: 'bold', fontFamily: 'monospace' }}>CONTRACT DEED: {selectedSo.so_number}</span>}
                  >
                    <Row gutter={[16, 12]} style={{ fontSize: '12px', color: '#334155' }}>
                      <Col xs={12}>
                        <div style={{ color: '#64748b', textTransform: 'uppercase', fontSize: '10px', fontFamily: 'monospace' }}>Freight Vendor</div>
                        <strong style={{ color: '#0f172a' }}>{selectedSo.vendor_name}</strong>
                      </Col>
                      <Col xs={12}>
                        <div style={{ color: '#64748b', textTransform: 'uppercase', fontSize: '10px', fontFamily: 'monospace' }}>Total PO Value</div>
                        <strong style={{ color: '#059669', fontFamily: 'monospace' }}>₹{selectedSo.total_order_value.toLocaleString()}</strong>
                      </Col>
                      <Col xs={12}>
                        <div style={{ color: '#64748b', textTransform: 'uppercase', fontSize: '10px', fontFamily: 'monospace' }}>Advance Terms</div>
                        <span>{selectedSo.advance_payment_percentage}% Advance ({selectedSo.advance_paid ? 'PAID' : 'PENDING'})</span>
                      </Col>
                      <Col xs={12}>
                        <div style={{ color: '#64748b', textTransform: 'uppercase', fontSize: '10px', fontFamily: 'monospace' }}>Payment Terms</div>
                        <span>{selectedSo.payment_terms || '30 days net credit'}</span>
                      </Col>
                      {selectedSo.expected_delivery_date && (
                        <Col xs={24}>
                          <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: '6px', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                            <span style={{ fontSize: '18px' }}>📦</span>
                            <div>
                              <div style={{ color: '#64748b', textTransform: 'uppercase', fontSize: '10px', fontFamily: 'monospace', fontWeight: 600 }}>Expected Delivery Date</div>
                              <strong style={{ color: '#0f766e', fontSize: '14px', fontFamily: 'monospace' }}>
                                {dayjs(selectedSo.expected_delivery_date).format('DD MMM YYYY')}
                              </strong>
                              <span style={{ color: '#64748b', fontSize: '11px', marginLeft: '8px' }}>
                                ({dayjs(selectedSo.expected_delivery_date).diff(dayjs(), 'day')} days remaining)
                              </span>
                            </div>
                          </div>
                        </Col>
                      )}
                      <Col xs={24}>
                        <Divider style={{ borderTop: '1px solid #e2e8f0', margin: '8px 0' }} />
                        <div style={{ color: '#64748b', textTransform: 'uppercase', fontSize: '10px', fontFamily: 'monospace', marginBottom: '4px' }}>Acknowledge status</div>
                        {selectedSo.acknowledged_by_vendor ? (
                          <Space direction="vertical" size={4}>
                            <Tag color="success">✓ Acknowledged by Transporter ({dayjs(selectedSo.acknowledged_at).format('DD/MM/YYYY HH:mm')})</Tag>
                            {selectedSo.arrival_date && (
                              <div style={{ color: '#0f172a', fontWeight: 'semibold', fontSize: '11px', marginTop: '4px' }}>
                                📅 Expected Arrival: <strong>{dayjs(selectedSo.arrival_date).format('DD/MM/YYYY')}</strong>
                              </div>
                            )}
                          </Space>
                        ) : (
                          <Tag color="warning">⚠️ Awaiting Transporter Acknowledgment</Tag>
                        )}
                      </Col>
                    </Row>
                  </Card>

                  <Card
                    style={{ background: '#ffffff', borderColor: '#e2e8f0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)' }}
                    title={<span style={{ color: '#0f172a', fontSize: '13px', fontWeight: 'bold', fontFamily: 'monospace' }}>VEHICLE ASSIGNMENTS & MILITARY TIMELINE</span>}
                  >
                    <div style={{ display: 'flex', gap: '10px', overflowX: 'auto', paddingBottom: '10px', marginBottom: '16px' }}>
                      {selectedSo.vehicles?.map(v => (
                        <div
                           key={v.id}
                           onClick={() => handleSelectVehicle(v)}
                           style={{
                             padding: '12px',
                             background: selectedVehicle?.id === v.id ? '#e0f2fe' : '#f8fafc',
                             border: selectedVehicle?.id === v.id ? '1px solid #0284c7' : '1px solid #cbd5e1',
                             borderRadius: '6px',
                             cursor: 'pointer',
                             minWidth: '180px',
                             transition: 'all 0.2s'
                           }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                            <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#0f172a', fontFamily: 'monospace' }}>
                              <CarOutlined /> {v.vehicle_registration_no || 'TBD'}
                            </span>
                            {v.has_issues && <Tag color="error" style={{ margin: 0 }}>ALERT</Tag>}
                          </div>
                          <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '8px' }}>Driver: {v.driver_name}</div>
                          <div>{getVehicleStatusTag(v.vehicle_status)}</div>
                        </div>
                      ))}
                    </div>

                    {selectedVehicle ? (
                      <div style={{ background: '#f8fafc', padding: '16px', borderRadius: '8px', border: '1px solid #cbd5e1' }}>
                        <div style={{ overflowX: 'auto', paddingBottom: '12px', marginBottom: '20px' }}>
                          <Steps size="small" current={getVehicleStatusIndex(selectedVehicle.vehicle_status)}>
                            <Step title={<span style={{ color: '#334155', fontSize: '11px', fontWeight: 600 }}>Gate Entry</span>} />
                            <Step title={<span style={{ color: '#334155', fontSize: '11px', fontWeight: 600 }}>Dispatched</span>} />
                            <Step title={<span style={{ color: '#334155', fontSize: '11px', fontWeight: 600 }}>In Transit</span>} />
                            <Step title={<span style={{ color: '#334155', fontSize: '11px', fontWeight: 600 }}>Acknowledged</span>} />
                          </Steps>
                        </div>

                        {selectedVehicle.has_issues && (
                          <Alert
                            message="🚨 Transit Incident Active"
                            description={selectedVehicle.issue_description || 'Carrier reported delay in transit.'}
                            type="error"
                            showIcon
                            style={{ marginBottom: '16px' }}
                          />
                        )}

                        {!selectedSo.acknowledged_by_vendor ? (
                          <Alert
                            message="Workflow Operations Locked"
                            description="Gating updates and transit incident filing are locked until the Transporter acknowledges the contract deed."
                            type="warning"
                            showIcon
                            style={{ width: '100%' }}
                          />
                        ) : (
                          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                            <Button type="primary" onClick={() => navigate(`/logistics/so-gating?soId=${selectedSo.id}&vehicleId=${selectedVehicle.id}`)}>
                              Go to Checkpoint updates
                            </Button>
                            {selectedVehicle.vehicle_status === 'IN_TRANSIT' && activeRole === 'TRANSPORTER' && (
                              <Tooltip title="Simulate satellite update">
                                <Button type="dashed" icon={<EnvironmentOutlined />} onClick={async () => {
                                  try {
                                    setLoading(true);
                                    await api.post(`/logistics/so/vehicle/${selectedVehicle.id}/status`, { nextStatus: 'IN_TRANSIT' });
                                    message.success("GPS satellite coordinate feed pinged successfully!");
                                    await fetchData();
                                  } catch (err) {
                                    console.error(err);
                                    message.error("Failed to ping satellite coords.");
                                    setLoading(false);
                                  }
                                }}>
                                  Ping GPS Loc
                                </Button>
                              </Tooltip>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ color: '#64748b', fontSize: '12px', textAlign: 'center', padding: '20px' }}>
                        Select a vehicle above to monitor gating milestones...
                      </div>
                    )}
                  </Card>
                </>
              )}

            </div>
          ) : (
            <div style={{
              background: '#ffffff',
              border: '1px solid #cbd5e1',
              borderRadius: '12px',
              boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)',
              padding: '40px',
              textAlign: 'center',
              color: '#64748b'
            }}>
              <InfoCircleOutlined style={{ fontSize: '32px', marginBottom: '12px', color: '#0284c7' }} />
              <h4>Select a Service Order contract from the ledger desk to load the live gating milestones.</h4>
            </div>
          )}
        </Col>
      </Row>

      {/* Custom Styles */}
      <style>{`
        .logistics-dark-table .ant-table {
          background: #ffffff !important;
          color: #334155 !important;
        }
        .logistics-dark-table .ant-table-thead > tr > th {
          background: #f1f5f9 !important;
          color: #475569 !important;
          border-bottom: 1px solid #cbd5e1 !important;
          font-family: monospace;
          text-transform: uppercase;
          font-size: 11px;
          letter-spacing: 0.5px;
        }
        .logistics-dark-table .ant-table-tbody > tr > td {
          border-bottom: 1px solid #f1f5f9 !important;
          background: #ffffff !important;
          color: #334155 !important;
          cursor: pointer;
        }
        .logistics-dark-table .ant-table-tbody > tr:hover > td {
          background: #f8fafc !important;
        }
        .logistics-selected-row td {
          background: #f0f9ff !important;
          border-left: 3px solid #0284c7 !important;
        }
        .logistics-dark-table .ant-pagination-item {
          background: #ffffff !important;
          border-color: #cbd5e1 !important;
        }
        .logistics-dark-table .ant-pagination-item-active a {
          color: #4f46e5 !important;
        }
        .logistics-dark-table .ant-pagination-item a {
          color: #475569 !important;
        }
        .logistics-dark-table .ant-pagination-prev .ant-pagination-item-link,
        .logistics-dark-table .ant-pagination-next .ant-pagination-item-link {
          background: #ffffff !important;
          border-color: #cbd5e1 !important;
          color: #334155 !important;
        }
      `}</style>
    </div>
  );
}
