import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Badge, Button, Modal, Form, Select, DatePicker, Input, InputNumber, Switch, Slider, Space, Spin, message, Row, Col, Divider, Alert, Tooltip, Empty } from 'antd';
import {
  SendOutlined,
  DollarCircleOutlined,
  StarFilled,
  InfoCircleOutlined,
  SolutionOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  AuditOutlined,
  SearchOutlined
} from '@ant-design/icons';
import api from '../../config/api';
import dayjs from 'dayjs';
import { useLocation } from 'react-router-dom';

const { Option } = Select;

// Specialized logistics metadata parsers
const parseAddress = (addr) => {
  if (addr && addr.startsWith('PICKUP: ')) {
    const parts = addr.split(' | DROPOFF: ');
    return { pickup: parts[0].replace('PICKUP: ', ''), dropoff: parts[1] || '' };
  }
  return { pickup: '', dropoff: addr || '' };
};

const parseInstructions = (inst) => {
  if (inst && inst.startsWith('ITEMS_DESC: ')) {
    const parts = inst.split(' | WEIGHT: ');
    const weightVol = parts[1] ? parts[1].split(' | VOLUME: ') : ['', ''];
    return {
      desc: parts[0].replace('ITEMS_DESC: ', ''),
      weight: weightVol[0] || '',
      volume: weightVol[1] || ''
    };
  }
  return { desc: inst || '', weight: '', volume: '' };
};

export default function LogisticsRfq() {
  const location = useLocation();
  const [loading, setLoading] = useState(true);
  const [rfqs, setRfqs] = useState([]);
  const [masters, setMasters] = useState(null);
  const [mdos, setMdos] = useState([]);
  const [showPublisher, setShowPublisher] = useState(false);
  const [selectedSdoIds, setSelectedSdoIds] = useState([]);
  const [form] = Form.useForm();
  
  // Award Modal state
  const [awardingRfq, setAwardingRfq] = useState(null);
  const [selectedQuoteId, setSelectedQuoteId] = useState(null);
  const [awardRemarks, setAwardRemarks] = useState('');

  // RFQ Selection state
  const [selectedRfqId, setSelectedRfqId] = useState(null);
  const [hasInitializedRfq, setHasInitializedRfq] = useState(false);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [rfqRes, masterRes, mdoRes] = await Promise.all([
        api.get('/logistics/rfq'),
        api.get('/logistics/masters'),
        api.get('/logistics/mdo')
      ]);
      const loadedRfqs = rfqRes.data || [];
      setRfqs(loadedRfqs);
      setMasters(masterRes.data);
      
      const loadedMdos = mdoRes.data || [];
      setMdos(loadedMdos);

      // Auto-select the latest RFQ on initial load
      if (loadedRfqs.length > 0 && !hasInitializedRfq) {
        const sorted = [...loadedRfqs].sort((a, b) => b.id - a.id);
        setSelectedRfqId(sorted[0].id);
        setHasInitializedRfq(true);
      }

      if (location.state && location.state.openPublisher) {
        const approved = loadedMdos.filter(m => m.dispatch_type === 'THIRD_PARTY' && m.status === 'DRAFT');
        if (approved.length > 0) {
          approved.sort((a, b) => b.id - a.id);
          const latestMdo = approved[0];
          
          setShowPublisher(true);
          setTimeout(() => {
            form.setFieldsValue({ mdoId: latestMdo.id });
            const ids = latestMdo.sdos.map(s => s.id);
            setSelectedSdoIds(ids);
            
            const addr = parseAddress(latestMdo.delivery_address);
            const inst = parseInstructions(latestMdo.special_instructions);
            const briefDesc = inst.desc ? (inst.desc.length > 30 ? inst.desc.substring(0, 30) + '...' : inst.desc) : 'Outbound Logistics';
            
            form.setFieldsValue({
              title: `Consolidated Bidding: ${briefDesc}`,
              pickup_location: addr.pickup || 'Origin Warehouse',
              dropoff_location: addr.dropoff || 'Client Store Destination',
              logistics_weight: inst.weight ? parseFloat(inst.weight) : (latestMdo.total_weight_kg || 0),
              logistics_volume: inst.volume ? parseFloat(inst.volume) : (latestMdo.total_volume_cft || 0),
              items_description: inst.desc || 'SCM Materials',
              expected_delivery_date: latestMdo.required_delivery_date ? dayjs(latestMdo.required_delivery_date) : null,
              scope_penalties: 'Standard penalty rate of 2% per day applies for delivery delays.'
            });
          }, 100);
        }
      }
    } catch (err) {
      console.error(err);
      message.error("Failed to load RFQ bidding registers.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [location.state]);

  const handleMdoSelectionChange = (mdoId) => {
    const selectedMdo = mdos.find(m => m.id === mdoId);
    if (selectedMdo) {
      const ids = selectedMdo.sdos.map(s => s.id);
      setSelectedSdoIds(ids);
      
      const addr = parseAddress(selectedMdo.delivery_address);
      const inst = parseInstructions(selectedMdo.special_instructions);
      const briefDesc = inst.desc ? (inst.desc.length > 30 ? inst.desc.substring(0, 30) + '...' : inst.desc) : 'Outbound Logistics';
      
      form.setFieldsValue({
        title: `Consolidated Bidding: ${briefDesc}`,
        pickup_location: addr.pickup || 'Origin Warehouse',
        dropoff_location: addr.dropoff || 'Client Store Destination',
        logistics_weight: inst.weight ? parseFloat(inst.weight) : (selectedMdo.total_weight_kg || 0),
        logistics_volume: inst.volume ? parseFloat(inst.volume) : (selectedMdo.total_volume_cft || 0),
        items_description: inst.desc || 'SCM Materials',
        expected_delivery_date: selectedMdo.required_delivery_date ? dayjs(selectedMdo.required_delivery_date) : null,
        scope_penalties: 'Standard penalty rate of 2% per day applies for delivery delays.'
      });
    }
  };

  const handlePublishRfq = async (values) => {
    try {
      setLoading(true);
      
      const compiledDescription = `Pick Up Location: ${values.pickup_location || 'Origin Warehouse'}\nDrop Off Location: ${values.dropoff_location || 'Client Drop Site'}\nLogistics Weight: ${values.logistics_weight || 0} KG\nLogistics Volume: ${values.logistics_volume || 0} CFT\nExpected Delivery Date: ${values.expected_delivery_date ? dayjs(values.expected_delivery_date).format('DD/MM/YYYY') : 'Not specified'}\nItems Description: ${values.items_description || 'SCM Materials'}\n\nExtra Scope & Penalties:\n${values.scope_penalties || 'None specified.'}`;

      const payload = {
        title: values.title,
        description: compiledDescription,
        deadline: dayjs(values.deadline).toISOString(),
        expected_delivery_date: values.expected_delivery_date ? dayjs(values.expected_delivery_date).toISOString() : null,
        mdoId: values.mdoId,
        sdoIds: selectedSdoIds,
        invitedVendorIds: values.invitedVendorIds,
        paymentTerms: values.paymentTerms || '30 days net credit',
        advancePercentage: values.advancePercentage !== undefined ? values.advancePercentage : 0,
        insuranceRequired: !!values.insuranceRequired,
        criteriaPrice: values.criteriaPrice !== undefined ? values.criteriaPrice : 40,
        criteriaRating: values.criteriaRating !== undefined ? values.criteriaRating : 30,
        criteriaTimeline: values.criteriaTimeline !== undefined ? values.criteriaTimeline : 30
      };

      await api.post('/logistics/rfq', payload);
      message.success("B2B freight RFQ campaign successfully published!");
      setShowPublisher(false);
      setSelectedSdoIds([]);
      form.resetFields();
      setHasInitializedRfq(false);
      await fetchData();
    } catch (err) {
      console.error(err);
      message.error("Failed to publish RFQ campaign.");
      setLoading(false);
    }
  };

  const handleAwardQuote = async () => {
    if (!selectedQuoteId) {
      message.warning("Please choose the winning quotation!");
      return;
    }
    try {
      setLoading(true);
      await api.post(`/logistics/rfq/${awardingRfq.id}/select`, {
        rfqId: awardingRfq.id,
        responseId: selectedQuoteId,
        remarks: awardRemarks || 'Best competitive rate rating criteria fit.'
      });
      message.success("Bid awarded successfully! Service Order contract generated.");
      setAwardingRfq(null);
      setSelectedQuoteId(null);
      setAwardRemarks('');
      await fetchData();
    } catch (err) {
      console.error(err);
      message.error("Failed to finalize contract award.");
      setLoading(false);
    }
  };

  if (loading && rfqs.length === 0) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <Spin size="large" tip="Entering B2B Bidding desk..." />
      </div>
    );
  }

  // Filter all third-party plans that can raise RFQs
  const approvedMdos = mdos.filter(m => m.dispatch_type === 'THIRD_PARTY');

  return (
    <div style={{ padding: '24px', minHeight: '100vh' }}>
      
      {/* Main Campaign Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontWeight: 700, fontSize: '20px' }}>Carrier Freight Bidding Desk</h2>
          <p style={{ color: '#64748b', fontSize: '13px', margin: '4px 0 0 0' }}>
            Publish B2B freight requests, invite qualified transporters, compare rate sheets with auto-computed score matrices, and award POs.
          </p>
        </div>
        <div>
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={() => setShowPublisher(true)}
            style={{ borderRadius: '6px', fontWeight: 'bold' }}
          >
            Publish Freight Campaign (RFQ)
          </Button>
        </div>
      </div>

      {/* RFQ Selection Search Card */}
      <Card 
        style={{ 
          marginBottom: '24px', 
          borderRadius: '8px', 
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
          background: '#ffffff',
          border: '1px solid #e2e8f0'
        }}
      >
        <Row gutter={16} align="middle">
          <Col xs={24} md={12}>
            <span style={{ fontWeight: 600, fontSize: '13px', display: 'block', marginBottom: '8px', color: '#475569' }}>
              Select Freight RFQ Campaign to Compare carrier proposals
            </span>
            <Select
              style={{ width: '100%' }}
              placeholder="Search or Select RFQ number..."
              value={selectedRfqId || undefined}
              onChange={val => setSelectedRfqId(val)}
              showSearch
              allowClear
              optionFilterProp="children"
              suffixIcon={<SearchOutlined style={{ color: '#94a3b8' }} />}
            >
              {rfqs.map(rfq => (
                <Option key={rfq.id} value={rfq.id}>
                  {rfq.rfq_number} - {rfq.title}
                </Option>
              ))}
            </Select>
          </Col>
          {selectedRfqId && (() => {
            const current = rfqs.find(r => r.id === selectedRfqId);
            if (!current) return null;
            return (
              <Col xs={24} md={12}>
                <div style={{ paddingLeft: '16px', borderLeft: '2px solid #e2e8f0' }}>
                  <span style={{ fontSize: '11px', color: '#64748b', display: 'block', textTransform: 'uppercase', fontWeight: 600, letterSpacing: '0.5px' }}>
                    Active RFQ Campaign Metadata
                  </span>
                  <div style={{ marginTop: '6px', fontSize: '13px', color: '#334155' }}>
                    <strong>MDO Reference:</strong> <span style={{ fontFamily: 'monospace', color: '#0f766e' }}>{current.mdo_number || 'N/A'}</span>
                    <Divider type="vertical" />
                    <strong>Advance Ratio:</strong> <span style={{ color: '#0f766e' }}>{current.advance_payment_percentage}%</span>
                    <Divider type="vertical" />
                    <strong>Insurance:</strong> <Tag color={current.insurance_required ? 'blue' : 'warning'} style={{ margin: 0, fontSize: '11px' }}>{current.insurance_required ? 'Required' : 'Optional'}</Tag>
                  </div>
                </div>
              </Col>
            );
          })()}
        </Row>
      </Card>

      {/* Campaign Publisher Modal */}
      <Modal
        title={<span style={{ fontSize: '14px', fontWeight: 'bold' }}>PUBLISH NEW FREIGHT BIDDING INVITATION (RFQ)</span>}
        open={showPublisher}
        onCancel={() => setShowPublisher(false)}
        width={800}
        footer={null}
        styles={{ body: { padding: '20px' } }}
      >
        <Form 
          form={form} 
          layout="vertical" 
          onFinish={handlePublishRfq}
          initialValues={{
            paymentTerms: '30 days net credit',
            advancePercentage: 20,
            insuranceRequired: true,
            criteriaPrice: 40,
            criteriaRating: 30,
            criteriaTimeline: 30
          }}
        >
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="mdoId" label="Approved MDO Dispatch Plan" rules={[{ required: true }]}>
                <Select placeholder="Select approved plan" onChange={handleMdoSelectionChange}>
                  {approvedMdos.map(m => (
                    <Option key={m.id} value={m.id}>{m.mdo_number} - {m.warehouse_name}</Option>
                  ))}
                </Select>
              </Form.Item>
              {approvedMdos.length === 0 && (
                <Alert message="⚠️ No Third-Party Dispatch Plans available. Ensure a Third-Party plan is constructed in the Dispatch plans ledger." type="warning" showIcon style={{ marginBottom: '12px' }} />
              )}
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="title" label="RFQ Campaign Title" rules={[{ required: true }]}>
                <Input placeholder="E.g. Steel Rod Outbound - Surat monsoon campaign" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item
                name="deadline"
                label={<span style={{ color: '#4f46e5', fontWeight: 600 }}>Bidding Response Deadline</span>}
                rules={[
                  { required: true, message: 'Bidding response deadline is required' },
                  () => ({
                    validator(_, value) {
                      if (!value) return Promise.resolve();
                      if (value.isBefore(dayjs())) {
                        return Promise.reject(new Error('Deadline must be in the future'));
                      }
                      return Promise.resolve();
                    },
                  }),
                ]}
              >
                <DatePicker showTime style={{ width: '100%' }} disabledDate={d => d && d.isBefore(dayjs(), 'day')} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="expected_delivery_date"
                dependencies={['deadline']}
                label={
                  <span style={{ color: '#0f766e', fontWeight: 600 }}>
                    📦 Expected Delivery Date
                  </span>
                }
                rules={[
                  { required: true, message: 'Expected delivery date is required' },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      if (!value) return Promise.resolve();
                      const deadline = getFieldValue('deadline');
                      if (deadline && value.isBefore(deadline, 'day')) {
                        return Promise.reject(new Error('Expected delivery date must be after the bidding response deadline'));
                      }
                      return Promise.resolve();
                    },
                  }),
                ]}
                tooltip="The date by which delivery must be completed. Carriers must plan their operations around this."
              >
                <DatePicker
                  style={{ width: '100%' }}
                  disabledDate={d => {
                    const deadline = form.getFieldValue('deadline');
                    if (deadline) {
                      return d && d.isBefore(deadline, 'day');
                    }
                    return d && d.isBefore(dayjs(), 'day');
                  }}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="paymentTerms" label="Credit Net Terms">
                <Input />
              </Form.Item>
            </Col>
            <Col xs={12} md={6}>
              <Form.Item name="advancePercentage" label="Advance Payment %">
                <InputNumber min={0} max={100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={6}>
              <Form.Item name="insuranceRequired" label="Insurance Required" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="scope_penalties" label="Special Scope & Penalties">
                <Input.TextArea placeholder="Standard penalty rate of 2% per day applies for delivery delays." rows={2} />
              </Form.Item>
            </Col>
          </Row>

          <Divider style={{ margin: '12px 0' }} />
          <span style={{ fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', display: 'block', marginBottom: '12px', color: '#0284c7' }}>
            Cargo & Routing Metadata
          </span>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="pickup_location" label="Pick Up Location" rules={[{ required: true, message: 'Pick Up Location is required' }]}>
                <Input placeholder="Loading dock..." />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="dropoff_location" label="Drop Off Location" rules={[{ required: true, message: 'Drop Off Location is required' }]}>
                <Input placeholder="Destination store..." />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={12} md={6}>
              <Form.Item name="logistics_weight" label="Logistics Weight (KG)" rules={[{ required: true, message: 'Weight is required' }]}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={6}>
              <Form.Item name="logistics_volume" label="Logistics Volume (CFT)" rules={[{ required: true, message: 'Volume is required' }]}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="items_description" label="Items Description" rules={[{ required: true, message: 'Items Description is required' }]}>
                <Input.TextArea placeholder="Describe items..." rows={2} />
              </Form.Item>
            </Col>
          </Row>

          {/* Evaluation score Weights sliders */}
          <Divider />
          <span style={{ fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', display: 'block', marginBottom: '12px', color: '#64748b' }}>
            Auto-Evaluation Criteria Weight Settings
          </span>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item name="criteriaPrice" label="💲 Price weight ratio">
                <Slider min={0} max={100} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="criteriaRating" label="⭐ Rating weight ratio">
                <Slider min={0} max={100} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="criteriaTimeline" label="⏰ Timeline weight ratio">
                <Slider min={0} max={100} />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="invitedVendorIds" label="Invite Transport Carriers" rules={[{ required: true }]}>
            <Select mode="multiple" placeholder="Select carriers">
              {masters?.carriers.map(c => (
                <Option key={c.vendor_id} value={c.vendor_id}>{c.vendor_name} (★ {c.rating.toFixed(1)})</Option>
              ))}
            </Select>
          </Form.Item>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
            <Button onClick={() => setShowPublisher(false)}>Cancel</Button>
            <Button type="primary" htmlType="submit">Publish Campaign</Button>
          </div>
        </Form>
      </Modal>

      {/* COORDINATOR BIDS EVALUATION VIEW */}
      <Row gutter={[16, 16]}>
        {selectedRfqId ? (
          (() => {
            const rfq = rfqs.find(r => r.id === selectedRfqId);
            if (!rfq) return null;
            const quotes = rfq.responses || [];
            
            return (
              <Col xs={24} key={rfq.id}>
                <Card 
                  style={{ borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}
                  title={
                    <span>
                      <Tag color="cyan">{rfq.rfq_number}</Tag> {rfq.title}
                    </span>
                  }
                  extra={
                    <Space>
                      <Tag color={rfq.status === 'CLOSED' ? 'default' : 'success'}>{rfq.status}</Tag>
                      {rfq.status !== 'CLOSED' && quotes.length > 0 && (
                        <Button 
                          type="primary" 
                          size="small" 
                          icon={<SolutionOutlined />} 
                          onClick={() => setAwardingRfq(rfq)}
                        >
                          Award & Select Quote
                        </Button>
                      )}
                    </Space>
                  }
                >
                  <Row gutter={16} style={{ fontSize: '12px', color: '#64748b', fontFamily: 'monospace', marginBottom: '12px' }}>
                    <Col xs={12} md={6}>Deadline: <strong>{dayjs(rfq.response_deadline).format('DD/MM/YYYY HH:mm')}</strong></Col>
                    <Col xs={12} md={6}>Carrier Load: <strong>{(rfq.total_estimated_weight_kg / 1000).toFixed(2)} Ton</strong></Col>
                    <Col xs={12} md={6}>Advance Required: <strong>{rfq.advance_payment_percentage}%</strong></Col>
                    <Col xs={12} md={6}>Vehicle Required: <strong style={{ color: '#0284c7' }}>{rfq.vehicle_type_required}</strong></Col>
                  </Row>

                  {/* Quotes received list table */}
                  <div style={{ padding: '10px', borderRadius: '6px', border: '1px solid #e2e8f0', background: '#f8fafc' }}>
                    <span style={{ fontSize: '10px', textTransform: 'uppercase', color: '#64748b', display: 'block', marginBottom: '8px', fontFamily: 'monospace' }}>
                      Carrier Bids Filed ({quotes.length})
                    </span>
                    <Table
                      dataSource={quotes}
                      pagination={false}
                      rowKey="id"
                      columns={[
                        { title: 'Quote No', dataIndex: 'response_number', key: 'qno', render: t => <span style={{ fontFamily: 'monospace', color: '#0284c7' }}>{t}</span> },
                        { title: 'Carrier Name', dataIndex: 'vendor_name', key: 'cname', render: t => <span style={{ fontWeight: 'semibold' }}>{t}</span> },
                        { title: 'Quoted Price', dataIndex: 'total_quoted_price', key: 'price', render: p => <span style={{ fontFamily: 'monospace', fontWeight: 'bold' }}>₹{p.toLocaleString()}</span> },
                        { title: 'Evaluation Score', dataIndex: 'evaluation_score', key: 'score', render: s => <span style={{ fontFamily: 'monospace', color: '#d97706', fontWeight: 'bold' }}>{parseFloat(s).toFixed(1)}/100</span> },
                        { title: 'Advance', dataIndex: 'advance_payment_percentage', key: 'adv', render: a => <span style={{ fontFamily: 'monospace' }}>{a}%</span> },
                        { title: 'Remarks', dataIndex: 'vendor_remarks', key: 'rem' },
                        { title: 'Status', dataIndex: 'status', key: 'st', render: s => <Tag color={s === 'SELECTED' ? 'success' : 'default'}>{s}</Tag> }
                      ]}
                      locale={{ emptyText: <span style={{ color: '#64748b', fontSize: '11px', fontFamily: 'monospace' }}>Transporters are evaluating invitations. No quotes filed yet...</span> }}
                    />
                  </div>
                </Card>
              </Col>
            );
          })()
        ) : (
          <Col xs={24}>
            <Card style={{ borderRadius: '8px', border: '1px dashed #cbd5e1', background: '#f8fafc', padding: '40px 0', textAlign: 'center' }}>
              <Empty 
                description={
                  <span style={{ color: '#64748b', fontSize: '14px' }}>
                    Select a freight RFQ campaign above to evaluate carrier quotations and award contracts.
                  </span>
                }
              />
            </Card>
          </Col>
        )}
      </Row>

      {/* Award selection Modal drawer */}
      <Modal
        title={<span style={{ fontSize: '14px', fontWeight: 'bold' }}>SELECT WINNING CARRIER PROPOSAL</span>}
        open={!!awardingRfq}
        onCancel={() => { setAwardingRfq(null); setSelectedQuoteId(null); }}
        onOk={handleAwardQuote}
        okText="Award Bid & Generate SO"
        styles={{ body: { padding: '20px' } }}
      >
        <Form layout="vertical">
          <Form.Item label="Select Transporter Quote" required>
            <Select placeholder="Choose quote" onChange={val => setSelectedQuoteId(val)}>
              {awardingRfq?.responses.map(q => (
                <Option key={q.id} value={q.id}>
                  {q.vendor_name} - ₹{q.total_quoted_price.toLocaleString()} (Score: {q.evaluation_score?.toFixed(1)}/100)
                </Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item label="Selection/Award Remarks">
            <Input.TextArea placeholder="Pen down selection notes..." value={awardRemarks} onChange={e => setAwardRemarks(e.target.value)} rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
