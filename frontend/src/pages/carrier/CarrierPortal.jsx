import React, { useEffect, useState } from 'react';
import {
  Layout, Card, Table, Tag, Button, Space, Modal, Form, Input, InputNumber,
  Select, message, Spin, Empty, Typography, Row, Col, Divider, Alert, Popconfirm, Descriptions, Tabs, DatePicker,
} from 'antd';
import { LogoutOutlined, SendOutlined, StopOutlined, EditOutlined, KeyOutlined, CheckCircleOutlined, WarningOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import useCarrierAuthStore from '../../store/carrierAuthStore';
import carrierApi from '../../config/carrierApi';
import { useNavigate } from 'react-router-dom';

const parseCampaignDescription = (desc) => {
  if (!desc) return { pickup: '', dropoff: '', weight: '', volume: '', items: '', extra: '' };
  const lines = desc.split('\n');
  const result = { pickup: '', dropoff: '', weight: '', volume: '', items: '', extra: '' };
  let readingExtra = false;
  const extraLines = [];

  lines.forEach(line => {
    if (line.startsWith('Pick Up Location: ')) {
      result.pickup = line.replace('Pick Up Location: ', '');
    } else if (line.startsWith('Drop Off Location: ')) {
      result.dropoff = line.replace('Drop Off Location: ', '');
    } else if (line.startsWith('Logistics Weight: ')) {
      result.weight = line.replace('Logistics Weight: ', '');
    } else if (line.startsWith('Logistics Volume: ')) {
      result.volume = line.replace('Logistics Volume: ', '');
    } else if (line.startsWith('Items Description: ')) {
      result.items = line.replace('Items Description: ', '');
    } else if (line.startsWith('Extra Scope & Penalties:')) {
      readingExtra = true;
    } else {
      if (readingExtra) {
        extraLines.push(line);
      }
    }
  });
  result.extra = extraLines.join('\n').trim();
  return result;
};

const { Header, Content } = Layout;
const { Title, Text } = Typography;

export default function CarrierPortal() {
  const { user, logout } = useCarrierAuthStore();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [rfqs, setRfqs] = useState([]);
  const [editingRfq, setEditingRfq] = useState(null);
  const [decliningRfq, setDecliningRfq] = useState(null);
  const [decReason, setDecReason] = useState('Fleet unavailable');
  const [form] = Form.useForm();
  const [pwForm] = Form.useForm();
  const [showPwModal, setShowPwModal] = useState(false);
  const [pwLoading, setPwLoading] = useState(false);

  // Service Orders state
  const [sos, setSos] = useState([]);
  const [soLoading, setSoLoading] = useState(false);
  const [acknowledgingSo, setAcknowledgingSo] = useState(null);
  const [ackForm] = Form.useForm();
  const [reportingVehicle, setReportingVehicle] = useState(null);
  const [submittingIssue, setSubmittingIssue] = useState(false);
  const [issueForm] = Form.useForm();

  const fetch = async () => {
    try {
      setLoading(true);
      const r = await carrierApi.get('/carrier/rfqs');
      setRfqs(r.data || []);
    } catch {
      message.error('Failed to load RFQ invitations');
    } finally {
      setLoading(false);
    }
  };

  const fetchSos = async () => {
    try {
      setSoLoading(true);
      const r = await carrierApi.get('/carrier/so');
      setSos(r.data || []);
    } catch {
      message.error('Failed to load Service Orders');
    } finally {
      setSoLoading(false);
    }
  };

  useEffect(() => {
    fetch();
    fetchSos();
  }, []);

  const submitAcknowledgement = async (values) => {
    try {
      const payload = {
        ...values,
        arrival_date: values.arrival_date ? values.arrival_date.format('YYYY-MM-DD') : null
      };
      await carrierApi.post(`/carrier/so/${acknowledgingSo.id}/acknowledge`, payload);
      message.success('Service Order contract acknowledged successfully!');
      setAcknowledgingSo(null);
      ackForm.resetFields();
      await fetchSos();
    } catch (e) {
      message.error(e?.response?.data?.message || e?.response?.data?.detail || 'Failed to acknowledge Service Order');
    }
  };

  const handleRaiseAlert = async (values) => {
    try {
      setSubmittingIssue(true);
      await carrierApi.post(`/carrier/so/vehicle/${reportingVehicle.id}/issue`, {
        issueDescription: values.issueDescription
      });
      message.warning("Driver transit alert filed and logged to control tower.");
      setReportingVehicle(null);
      issueForm.resetFields();
      await fetchSos();
    } catch (e) {
      message.error(e?.response?.data?.message || e?.response?.data?.detail || 'Failed to file vehicle alert');
    } finally {
      setSubmittingIssue(false);
    }
  };

  // Force change-password on first login
  useEffect(() => {
    if (user?.must_change_password) setShowPwModal(true);
  }, [user]);

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const openQuoteModal = (rfq) => {
    setEditingRfq(rfq);
    if (rfq.my_quote) {
      const veh = rfq.my_quote.vehicles?.[0] || {};
      form.setFieldsValue({
        totalQuotedPrice: rfq.my_quote.total_quoted_price,
        advancePercentage: rfq.my_quote.advance_payment_percentage,
        paymentTerms: rfq.my_quote.payment_terms || '30 days credit',
        remarks: rfq.my_quote.vendor_remarks || '',
        vehicleType: veh.vehicle_type || rfq.vehicle_type_required || 'Truck',
        registrationNo: veh.registration_no || '',
        driverName: veh.driver_name || '',
        driverMobile: veh.driver_mobile || '',
        driverLicense: veh.driver_license_no || '',
      });
    } else {
      form.setFieldsValue({
        totalQuotedPrice: 38000,
        advancePercentage: 20,
        paymentTerms: '30 days credit',
        remarks: '',
        vehicleType: rfq.vehicle_type_required || 'Truck',
        registrationNo: '',
        driverName: '',
        driverMobile: '',
        driverLicense: '',
      });
    }
  };

  const submitQuote = async (values) => {
    try {
      await carrierApi.post(`/carrier/rfqs/${editingRfq.id}/quote`, values);
      message.success(editingRfq.my_quote ? 'Quote updated' : 'Quote submitted');
      setEditingRfq(null);
      form.resetFields();
      await fetch();
    } catch (e) {
      message.error(e?.response?.data?.message || e?.response?.data?.detail || 'Failed to submit quote');
    }
  };

  const submitDecline = async () => {
    try {
      await carrierApi.post(`/carrier/rfqs/${decliningRfq.id}/decline`, { reason: decReason });
      message.info('Invitation declined');
      setDecliningRfq(null);
      setDecReason('Fleet unavailable');
      await fetch();
    } catch (e) {
      message.error(e?.response?.data?.message || e?.response?.data?.detail || 'Failed to decline invitation');
    }
  };

  const submitChangePassword = async (values) => {
    try {
      setPwLoading(true);
      await carrierApi.post('/carrier-auth/change-password', {
        current_password: values.current_password,
        new_password: values.new_password,
      });
      message.success('Password changed successfully!');
      setShowPwModal(false);
      pwForm.resetFields();
      await useCarrierAuthStore.getState().refreshMe();
    } catch (e) {
      // Backend http_exception_handler returns { message: "..." }, not { detail: "..." }
      const reason = e?.response?.data?.message || e?.response?.data?.detail || 'Failed to change password';
      message.error(reason);
    } finally {
      setPwLoading(false);
    }
  };

  const columns = [
    {
      title: 'RFQ #', dataIndex: 'rfq_number', key: 'rfq_number',
      render: (t) => <span style={{ fontFamily: 'monospace', color: '#0284c7', fontWeight: 'bold' }}>{t}</span>,
    },
    { title: 'Title', dataIndex: 'title', key: 'title', render: (t) => <strong>{t}</strong> },
    {
      title: 'Deadline', dataIndex: 'response_deadline', key: 'deadline',
      render: (t) => (t ? dayjs(t).format('DD/MM/YYYY HH:mm') : '—'),
    },
    {
      title: 'Weight (Tons)', dataIndex: 'total_estimated_weight_kg', key: 'wt',
      render: (kg) => `${(Number(kg || 0) / 1000).toFixed(2)}`,
    },
    { title: 'Vehicle', dataIndex: 'vehicle_type_required', key: 'veh' },
    {
      title: 'Status', dataIndex: 'status', key: 'st',
      render: (s, row) => {
        if (row.invitation?.response_status === 'DECLINED') return <Tag color="error">DECLINED</Tag>;
        if (s === 'CLOSED' && row.my_quote?.is_selected) return <Tag color="success">AWARDED TO YOU</Tag>;
        if (s === 'CLOSED') return <Tag color="default">CLOSED</Tag>;
        if (row.my_quote) return <Tag color="processing">QUOTED · ₹{row.my_quote.total_quoted_price.toLocaleString()}</Tag>;
        return <Tag color="warning">PENDING YOUR QUOTE</Tag>;
      },
    },
    {
      title: 'Actions', key: 'act',
      render: (_, row) => {
        const isOpen = row.status === 'PUBLISHED';
        const declined = row.invitation?.response_status === 'DECLINED';
        if (!isOpen) return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;
        if (declined) return <Text type="secondary" style={{ fontSize: 12 }}>You declined</Text>;
        return (
          <Space>
            <Button
              type="primary"
              size="small"
              icon={row.my_quote ? <EditOutlined /> : <SendOutlined />}
              onClick={() => openQuoteModal(row)}
            >
              {row.my_quote ? 'Edit Quote' : 'Submit Quote'}
            </Button>
            {!row.my_quote && (
              <Popconfirm
                title="Decline this invitation?"
                onConfirm={() => setDecliningRfq(row)}
                okText="Decline"
              >
                <Button danger size="small" icon={<StopOutlined />}>Decline</Button>
              </Popconfirm>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <Layout style={{ minHeight: '100vh', background: '#f8fafc' }}>
      <Header
        style={{
          background: '#fff',
          borderBottom: '1px solid #e2e8f0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0 24px',
          height: '64px',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <Title level={4} style={{ margin: 0, lineHeight: '1.2' }}>
            Carrier Portal — {user?.vendor_name || 'Transport Carrier'}
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Logged in as <strong style={{ color: '#1e293b' }}>{user?.username}</strong>
          </Text>
        </div>
        <Space>
          <Button icon={<KeyOutlined />} onClick={() => setShowPwModal(true)}>
            Change Password
          </Button>
          <Button danger icon={<LogoutOutlined />} onClick={handleLogout}>
            Logout
          </Button>
        </Space>
      </Header>
      <Content style={{ padding: 24 }}>
        {user?.must_change_password && (
          <Alert
            message="Please change your temporary password"
            description="For security, change the temporary password set by your coordinator before continuing to use the portal."
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}
        <Tabs
          defaultActiveKey="1"
          style={{ background: '#fff', padding: '24px', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}
          items={[
            {
              key: '1',
              label: <span style={{ fontWeight: 'bold', fontSize: '14px' }}>RFQ Invitations ({rfqs.length})</span>,
              children: (
                <div style={{ marginTop: '12px' }}>
                  {loading ? (
                    <div style={{ textAlign: 'center', padding: 40 }}>
                      <Spin tip="Loading invitations..." />
                    </div>
                  ) : rfqs.length === 0 ? (
                    <Empty description="No RFQ invitations yet. Sit tight — when a coordinator publishes a freight RFQ for your fleet, it will appear here." />
                  ) : (
                    <Table
                      dataSource={rfqs}
                      columns={columns}
                      rowKey="id"
                      pagination={{ pageSize: 10 }}
                      expandable={{
                        expandedRowRender: (r) => {
                          const details = parseCampaignDescription(r.description);
                          const isOldDesc = !details.pickup && !details.dropoff;
                          return (
                            <Descriptions size="small" column={2} bordered>
                              {isOldDesc ? (
                                <Descriptions.Item label="Description" span={2}>{r.description || '—'}</Descriptions.Item>
                              ) : (
                                <>
                                  <Descriptions.Item label="Pick Up Location">{details.pickup || '—'}</Descriptions.Item>
                                  <Descriptions.Item label="Drop Off Location">{details.dropoff || '—'}</Descriptions.Item>
                                  <Descriptions.Item label="Logistics Weight">{details.weight || '—'}</Descriptions.Item>
                                  <Descriptions.Item label="Logistics Volume">{details.volume || '—'}</Descriptions.Item>
                                  <Descriptions.Item label="Items Description" span={2}>{details.items || '—'}</Descriptions.Item>
                                  {details.extra && <Descriptions.Item label="Special Scope & Penalties" span={2}>{details.extra}</Descriptions.Item>}
                                </>
                              )}
                              <Descriptions.Item label="Payment Terms">{r.payment_terms || '—'}</Descriptions.Item>
                              <Descriptions.Item label="Advance %">{r.advance_payment_percentage || 0}%</Descriptions.Item>
                              <Descriptions.Item label="Insurance Required">{r.insurance_required ? 'Yes' : 'No'}</Descriptions.Item>
                              <Descriptions.Item label="Volume (CFT)">{r.total_estimated_volume_cft?.toFixed?.(1) || 0}</Descriptions.Item>
                              <Descriptions.Item label="SDOs in Scope">{r.sdo_count}</Descriptions.Item>
                              <Descriptions.Item label="Issued On">{r.issue_date ? dayjs(r.issue_date).format('DD/MM/YYYY') : '—'}</Descriptions.Item>
                            </Descriptions>
                          );
                        },
                      }}
                    />
                  )}
                </div>
              )
            },
            {
              key: '2',
              label: <span style={{ fontWeight: 'bold', fontSize: '14px' }}>Service Orders & Contracts ({sos.length})</span>,
              children: (
                <div style={{ marginTop: '12px' }}>
                  {soLoading ? (
                    <div style={{ textAlign: 'center', padding: 40 }}>
                      <Spin tip="Loading service orders..." />
                    </div>
                  ) : sos.length === 0 ? (
                    <Empty description="No Service Orders awarded yet. Once an RFQ bid is selected, your active contracts will appear here." />
                  ) : (
                    <Table
                      dataSource={sos}
                      rowKey="id"
                      pagination={{ pageSize: 10 }}
                      columns={[
                        {
                          title: 'SO Number',
                          dataIndex: 'so_number',
                          key: 'so_number',
                          render: (t) => <span style={{ fontFamily: 'monospace', color: '#0f766e', fontWeight: 'bold' }}>{t}</span>
                        },
                        {
                          title: 'Order Value',
                          dataIndex: 'total_order_value',
                          key: 'val',
                          render: (v) => <strong style={{ color: '#0f172a' }}>₹{v.toLocaleString()}</strong>
                        },
                        {
                          title: 'Advance Payment',
                          dataIndex: 'advance_payment_percentage',
                          key: 'adv',
                          render: (a, row) => <span>{a}% (₹{row.advance_payment_amount?.toLocaleString()})</span>
                        },
                        {
                          title: 'Payment Terms',
                          dataIndex: 'payment_terms',
                          key: 'terms'
                        },
                        {
                          title: 'Status',
                          dataIndex: 'status',
                          key: 'status',
                          render: (s, row) => {
                            if (s === 'CREATED' && !row.acknowledged_by_vendor) {
                              return <Tag color="warning">AWAITING ACKNOWLEDGMENT</Tag>;
                            }
                            if (s === 'ACKNOWLEDGED') {
                              return <Tag color="success">ACKNOWLEDGED</Tag>;
                            }
                            if (s === 'IN_PROGRESS') {
                              return <Tag color="processing">IN TRANSIT / PROGRESS</Tag>;
                            }
                            if (s === 'COMPLETED') {
                              return <Tag color="default">COMPLETED</Tag>;
                            }
                            return <Tag>{s}</Tag>;
                          }
                        },
                        {
                          title: 'Actions',
                          key: 'actions',
                          render: (_, row) => {
                            if (row.status === 'CREATED' && !row.acknowledged_by_vendor) {
                              return (
                                <Button
                                  type="primary"
                                  size="small"
                                  icon={<CheckCircleOutlined />}
                                  style={{ background: '#0f766e', borderColor: '#0f766e' }}
                                  onClick={() => setAcknowledgingSo(row)}
                                >
                                  Acknowledge
                                </Button>
                              );
                            }
                            return (
                              <Space style={{ color: '#16a34a', fontSize: '12px' }}>
                                <CheckCircleOutlined /> Acknowledged
                              </Space>
                            );
                          }
                        }
                      ]}
                      expandable={{
                        expandedRowRender: (so) => (
                          <div style={{ padding: '16px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                            <Descriptions title="Service Order Contract Details" size="small" bordered column={2}>
                              <Descriptions.Item label="Payment Terms">{so.payment_terms || '—'}</Descriptions.Item>
                              <Descriptions.Item label="Advance Ratio">{so.advance_payment_percentage}% (₹{so.advance_payment_amount?.toLocaleString()})</Descriptions.Item>
                              <Descriptions.Item label="Acknowledgment Status">
                                {so.acknowledged_by_vendor ? `Acknowledged at ${dayjs(so.acknowledged_at).format('DD/MM/YYYY HH:mm')}` : 'Awaiting Acknowledgment'}
                              </Descriptions.Item>
                              <Descriptions.Item label="Expected Arrival Date">
                                {so.arrival_date ? dayjs(so.arrival_date).format('DD/MM/YYYY') : '—'}
                              </Descriptions.Item>
                              {so.vendor_remarks && <Descriptions.Item label="Your Remarks" span={2}>{so.vendor_remarks}</Descriptions.Item>}
                            </Descriptions>
                            
                            <Divider style={{ margin: '16px 0' }} />
                            <span style={{ fontWeight: 600, fontSize: '13px', display: 'block', marginBottom: '8px', color: '#334155' }}>
                              Assigned Fleet Vehicles & Drivers
                            </span>
                            <Table
                              dataSource={so.vehicles}
                              rowKey="id"
                              pagination={false}
                              size="small"
                              columns={[
                                { title: 'Vehicle Type', dataIndex: 'vehicle_type' },
                                { title: 'Registration No', dataIndex: 'vehicle_registration_no', render: t => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{t}</span> },
                                { title: 'Driver Name', dataIndex: 'driver_name' },
                                { title: 'Driver Mobile', dataIndex: 'driver_mobile' },
                                { title: 'Vehicle Status', dataIndex: 'vehicle_status', render: s => <Tag color={s === 'DELIVERED' ? 'default' : s === 'SCHEDULED' ? 'warning' : 'processing'}>{s}</Tag> },
                                {
                                  title: 'Alert Status',
                                  key: 'alert_status',
                                  render: (_, v) => v.has_issues ? (
                                    <Tag color="error" icon={<WarningOutlined />} style={{ whiteSpace: 'normal', height: 'auto', padding: '4px 8px' }}>
                                      ALERT: {v.issue_description || 'Delay reported'}
                                    </Tag>
                                  ) : (
                                    <Tag color="success">NO ISSUES</Tag>
                                  )
                                },
                                {
                                  title: 'Action',
                                  key: 'alert_action',
                                  render: (_, v) => {
                                    const canRaise = so.acknowledged_by_vendor && v.vehicle_status !== 'DELIVERED' && v.vehicle_status !== 'CANCELLED';
                                    return (
                                      <Button
                                        danger
                                        type="primary"
                                        ghost
                                        size="small"
                                        icon={<WarningOutlined />}
                                        disabled={!canRaise}
                                        onClick={() => setReportingVehicle(v)}
                                      >
                                        Report Issue
                                      </Button>
                                    );
                                  }
                                }
                              ]}
                            />
                          </div>
                        )
                      }}
                    />
                  )}
                </div>
              )
            },
            {
              key: '3',
              label: <span style={{ fontWeight: 'bold', fontSize: '14px' }}>Transit Alerts</span>,
              children: (
                <div style={{ marginTop: '12px' }}>
                  {soLoading ? (
                    <div style={{ textAlign: 'center', padding: 40 }}>
                      <Spin tip="Loading fleet vehicles..." />
                    </div>
                  ) : sos.length === 0 ? (
                    <Empty description="No active Service Orders to track. Once an order is acknowledged, active vehicles will appear here to report transit alerts." />
                  ) : (() => {
                    const flatVehicles = [];
                    sos.forEach(so => {
                      if (so.vehicles) {
                        so.vehicles.forEach(v => {
                          flatVehicles.push({
                            ...v,
                            so_number: so.so_number,
                            acknowledged_by_vendor: so.acknowledged_by_vendor,
                            so_id: so.id
                          });
                        });
                      }
                    });

                    if (flatVehicles.length === 0) {
                      return <Empty description="No fleet vehicles assigned to active Service Orders." />;
                    }

                    return (
                      <Table
                        dataSource={flatVehicles}
                        rowKey="id"
                        pagination={{ pageSize: 10 }}
                        columns={[
                          {
                            title: 'Service Order #',
                            dataIndex: 'so_number',
                            key: 'so_number',
                            render: (t) => <span style={{ fontFamily: 'monospace', color: '#0f766e', fontWeight: 'bold' }}>{t}</span>
                          },
                          { title: 'Vehicle Type', dataIndex: 'vehicle_type', key: 'type' },
                          {
                            title: 'Registration No',
                            dataIndex: 'vehicle_registration_no',
                            key: 'reg',
                            render: t => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{t}</span>
                          },
                          { title: 'Driver Name', dataIndex: 'driver_name', key: 'driver' },
                          { title: 'Driver Mobile', dataIndex: 'driver_mobile', key: 'mobile' },
                          {
                            title: 'Vehicle Status',
                            dataIndex: 'vehicle_status',
                            key: 'status',
                            render: s => <Tag color={s === 'DELIVERED' ? 'default' : s === 'SCHEDULED' ? 'warning' : 'processing'}>{s}</Tag>
                          },
                          {
                            title: 'Alert Status',
                            key: 'alert_status',
                            render: (_, v) => v.has_issues ? (
                              <Tag color="error" icon={<WarningOutlined />} style={{ whiteSpace: 'normal', height: 'auto', padding: '4px 8px' }}>
                                ALERT: {v.issue_description || 'Delay reported'}
                              </Tag>
                            ) : (
                              <Tag color="success">NO ISSUES</Tag>
                            )
                          },
                          {
                            title: 'Action',
                            key: 'alert_action',
                            render: (_, v) => {
                              const canRaise = v.acknowledged_by_vendor && v.vehicle_status !== 'DELIVERED' && v.vehicle_status !== 'CANCELLED';
                              return (
                                <Button
                                  danger
                                  type="primary"
                                  ghost
                                  size="small"
                                  icon={<WarningOutlined />}
                                  disabled={!canRaise}
                                  onClick={() => setReportingVehicle(v)}
                                >
                                  Report Issue
                                </Button>
                              );
                            }
                          }
                        ]}
                      />
                    );
                  })()}
                </div>
              )
            }
          ]}
        />
      </Content>

      {/* Quote modal */}
      <Modal
        title={editingRfq?.my_quote ? `Edit Quote — ${editingRfq?.rfq_number}` : `Submit Quote — ${editingRfq?.rfq_number}`}
        open={!!editingRfq}
        onCancel={() => setEditingRfq(null)}
        onOk={() => form.submit()}
        okText={editingRfq?.my_quote ? 'Update Quote' : 'Submit Quote'}
        width={720}
      >
        {editingRfq && (() => {
          const details = parseCampaignDescription(editingRfq.description);
          const isOld = !details.pickup && !details.dropoff;
          if (isOld) {
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '20px' }}>
                {editingRfq.expected_delivery_date && (
                  <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: '12px', padding: '14px' }}>
                    <span style={{ fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', color: '#d97706', display: 'block', marginBottom: '4px' }}>Expected Delivery Date</span>
                    <strong style={{ fontSize: '14px', color: '#b45309' }}>📅 {dayjs(editingRfq.expected_delivery_date).format('DD MMM YYYY')}</strong>
                  </div>
                )}
                {editingRfq.description && (
                  <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px' }}>
                    <span style={{ fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', color: '#64748b', display: 'block', marginBottom: '4px' }}>Campaign Description</span>
                    <p style={{ fontSize: '13px', color: '#334155', margin: 0 }}>{editingRfq.description}</p>
                  </div>
                )}
              </div>
            );
          }
          return (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '12px', padding: '16px', marginBottom: '20px' }}>
              <span style={{ fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', color: '#15803d', display: 'block', marginBottom: '8px' }}>Consignment Bidding details</span>
              <Row gutter={[12, 12]} style={{ fontSize: '13px', color: '#1e293b' }}>
                <Col xs={24} md={12}>
                  <strong>Pick Up Location:</strong> <span style={{ color: '#0f172a', fontWeight: 600 }}>{details.pickup || '—'}</span>
                </Col>
                <Col xs={24} md={12}>
                  <strong>Drop Off Location:</strong> <span style={{ color: '#0f172a', fontWeight: 600 }}>{details.dropoff || '—'}</span>
                </Col>
                <Col xs={12} md={6}>
                  <strong>Weight:</strong> <span style={{ color: '#4f46e5', fontWeight: 700 }}>{details.weight || '—'}</span>
                </Col>
                <Col xs={12} md={6}>
                  <strong>Volume:</strong> <span style={{ color: '#0284c7', fontWeight: 700 }}>{details.volume || '—'}</span>
                </Col>
                <Col xs={24} md={12}>
                  <strong>Items Description:</strong> <span style={{ color: '#475569', fontWeight: 500 }}>{details.items || '—'}</span>
                </Col>
                <Col xs={24} md={12}>
                  <strong>Expected Delivery Date:</strong> <span style={{ color: '#b45309', fontWeight: 700 }}>📅 {editingRfq.expected_delivery_date ? dayjs(editingRfq.expected_delivery_date).format('DD MMM YYYY') : '—'}</span>
                </Col>
                {details.extra && (
                  <Col span={24} style={{ borderTop: '1px dashed #bbf7d0', paddingTop: '8px', marginTop: '4px', fontSize: '12px', color: '#64748b' }}>
                    <strong>Special Scope & Penalties:</strong> {details.extra}
                  </Col>
                )}
              </Row>
            </div>
          );
        })()}
        <Form form={form} layout="vertical" onFinish={submitQuote}>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item
                name="totalQuotedPrice"
                label="Total Freight Quote (₹)"
                rules={[{ required: true, message: 'Required' }]}
              >
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="advancePercentage" label="Advance %">
                <InputNumber min={0} max={100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="paymentTerms" label="Payment Terms">
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="vehicleType" label="Vehicle Type">
                <Select
                  options={[
                    { value: 'Truck', label: 'Truck' },
                    { value: 'Container', label: 'Container' },
                    { value: 'Tempo', label: 'Tempo' },
                    { value: 'Flatbed Container', label: 'Flatbed Container' },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>
          <Divider style={{ margin: '12px 0' }}>Fleet & Driver</Divider>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="registrationNo" label="Vehicle Reg. No.">
                <Input placeholder="e.g. MH-04-GP-8844" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="driverName" label="Driver Name">
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="driverMobile" label="Driver Mobile">
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="driverLicense" label="Driver License">
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remarks" label="Remarks">
            <Input.TextArea rows={2} placeholder="Notes for the coordinator..." />
          </Form.Item>
        </Form>
      </Modal>

      {/* Decline modal */}
      <Modal
        title={`Decline ${decliningRfq?.rfq_number}`}
        open={!!decliningRfq}
        onCancel={() => setDecliningRfq(null)}
        onOk={submitDecline}
        okText="Decline Invitation"
        okButtonProps={{ danger: true }}
      >
        <p>Please provide a reason — coordinators may follow up to schedule future invitations.</p>
        <Input.TextArea
          value={decReason}
          onChange={(e) => setDecReason(e.target.value)}
          rows={3}
        />
      </Modal>

      {/* SO Acknowledgment Modal */}
      <Modal
        title={`Acknowledge Service Order Contract — ${acknowledgingSo?.so_number}`}
        open={!!acknowledgingSo}
        onCancel={() => setAcknowledgingSo(null)}
        onOk={() => ackForm.submit()}
        okText="Acknowledge Contract"
        width={500}
      >
        <Alert
          message="Contract Acknowledgement Commitment"
          description="By acknowledging this Service Order, you commit to providing the scheduled vehicle(s) and driver(s) for gating, loading, and transit delivery operations."
          type="info"
          showIcon
          style={{ marginBottom: '16px' }}
        />
        <Form form={ackForm} layout="vertical" onFinish={submitAcknowledgement}>
          <Form.Item
            name="arrival_date"
            label="Expected Arrival Date"
            rules={[
              { required: true, message: 'Please select expected arrival date!' },
              () => ({
                validator(_, value) {
                  if (!value) return Promise.resolve();
                  const deliveryDate = acknowledgingSo?.expected_delivery_date;
                  if (deliveryDate) {
                    const deadline = dayjs(deliveryDate).endOf('day');
                    if (!value.isBefore(deadline, 'day')) {
                      return Promise.reject(
                        new Error(
                          `Expected arrival date must be before the delivery deadline (${dayjs(deliveryDate).format('DD/MM/YYYY')})`
                        )
                      );
                    }
                  }
                  return Promise.resolve();
                },
              }),
            ]}
          >
            <DatePicker
              style={{ width: '100%' }}
              disabledDate={(d) => {
                const deliveryDate = acknowledgingSo?.expected_delivery_date;
                if (deliveryDate) {
                  return d && !d.isBefore(dayjs(deliveryDate), 'day');
                }
                return false;
              }}
              placeholder="Select your expected arrival date"
              format="DD/MM/YYYY"
            />
          </Form.Item>
          {acknowledgingSo?.expected_delivery_date && (
            <div
              style={{
                marginBottom: 16,
                padding: '8px 12px',
                background: '#fef3c7',
                border: '1px solid #fde68a',
                borderRadius: 6,
                fontSize: 12,
                color: '#92400e',
              }}
            >
              <strong>⏰ Expected Delivery Deadline:</strong>{' '}
              <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>
                {dayjs(acknowledgingSo.expected_delivery_date).format('DD/MM/YYYY')}
              </span>
              {' '}— Your arrival date must be <strong>before</strong> this date.
            </div>
          )}
          <Form.Item name="remarks" label="Transporter Confirmation Remarks">
            <Input.TextArea rows={3} placeholder="Add confirmation remarks, e.g. 'Driver notified and ready for gate-entry.'" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Change password modal */}
      <Modal
        title="Change Password"
        open={showPwModal}
        onCancel={() => !user?.must_change_password && setShowPwModal(false)}
        onOk={() => pwForm.submit()}
        okText="Change Password"
        okButtonProps={{ loading: pwLoading, disabled: pwLoading }}
        cancelButtonProps={user?.must_change_password ? { style: { display: 'none' } } : undefined}
        closable={!user?.must_change_password}
        maskClosable={!user?.must_change_password}
      >
        <Form form={pwForm} layout="vertical" onFinish={submitChangePassword}>
          <Form.Item name="current_password" label="Current Password" rules={[{ required: true, message: 'Current password is required' }]}>
            <Input.Password />
          </Form.Item>
          <Form.Item
            name="new_password"
            label="New Password"
            rules={[
              { required: true, message: 'New password is required' },
              { min: 8, message: 'At least 8 characters' },
              {
                pattern: /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d).+$/,
                message: 'Must include uppercase, lowercase, and a digit',
              },
            ]}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item
            name="confirm_password"
            label="Confirm New Password"
            dependencies={['new_password']}
            rules={[
              { required: true, message: 'Please confirm your new password' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('new_password') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('Passwords do not match'));
                },
              }),
            ]}
          >
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={
          <span style={{ color: '#ef4444', fontWeight: 'bold' }}>
            🚨 Report Transit Issue / Road Block — {reportingVehicle?.vehicle_registration_no}
          </span>
        }
        open={!!reportingVehicle}
        onCancel={() => {
          setReportingVehicle(null);
          issueForm.resetFields();
        }}
        onOk={() => issueForm.submit()}
        confirmLoading={submittingIssue}
        okText="Raise Transit Alert"
        okButtonProps={{ danger: true, icon: <WarningOutlined /> }}
        width={500}
      >
        <Alert
          message="Raise Warning Alert / Log Transit Incident"
          description="Filing a transit roadblock, mechanical breakdown, or incident will immediately alert the SCM coordinator control tower."
          type="warning"
          showIcon
          style={{ marginBottom: '16px' }}
        />
        <Form form={issueForm} layout="vertical" onFinish={handleRaiseAlert}>
          <Form.Item
            name="issueDescription"
            label={<span style={{ color: '#475569', fontWeight: 600 }}>Describe Issue / Delay</span>}
            rules={[{ required: true, message: 'Please enter issue description!' }]}
          >
            <Input.TextArea
              rows={4}
              placeholder="e.g. Engine breakdown at NH-48 toll plaza, tyre puncture near Valsad, roadblock due to landslide..."
            />
          </Form.Item>
        </Form>
      </Modal>
    </Layout>
  );
}
