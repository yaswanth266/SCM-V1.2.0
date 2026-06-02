import React, { useState, useEffect } from 'react';
import { Card, Table, Tag, Badge, Spin, Typography, message, Button, Modal, Form, Input, InputNumber, Space, Tooltip } from 'antd';
import {
  CarOutlined,
  StarFilled,
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  KeyOutlined,
  UserOutlined,
  LockOutlined,
  MailOutlined,
  PhoneOutlined,
  EnvironmentFilled
} from '@ant-design/icons';
import api from '../../config/api';

const { Title, Paragraph } = Typography;

export default function LogisticsMaster() {
  const [loading, setLoading] = useState(true);
  const [carriersLoading, setCarriersLoading] = useState(false);
  const [masters, setMasters] = useState(null);
  const [carriers, setCarriers] = useState([]);

  // Carrier CRUD state
  const [carrierModalVisible, setCarrierModalVisible] = useState(false);
  const [editingCarrier, setEditingCarrier] = useState(null);
  const [carrierForm] = Form.useForm();

  // Login credentials state
  const [loginModalVisible, setLoginModalVisible] = useState(false);
  const [loginCarrier, setLoginCarrier] = useState(null);
  const [loginForm] = Form.useForm();

  const fetchMasters = async () => {
    try {
      setLoading(true);
      const res = await api.get('/logistics/masters');
      setMasters(res.data);
    } catch (err) {
      console.error(err);
      message.error("Failed to load Master Data.");
    } finally {
      setLoading(false);
    }
  };

  const fetchCarriers = async () => {
    try {
      setCarriersLoading(true);
      const res = await api.get('/logistics/carriers');
      setCarriers(res.data);
    } catch (err) {
      console.error(err);
      message.error("Failed to load carriers directory.");
    } finally {
      setCarriersLoading(false);
    }
  };

  useEffect(() => {
    fetchMasters();
    fetchCarriers();
  }, []);

  const handleOpenCarrierModal = (carrier = null) => {
    setEditingCarrier(carrier);
    if (carrier) {
      carrierForm.setFieldsValue({
        name: carrier.vendor_name,
        vendor_code: carrier.vendor_code,
        contact_person: carrier.contact_person,
        phone: carrier.mobile,
        email: carrier.email,
        address: carrier.address,
        rating: carrier.rating,
      });
    } else {
      carrierForm.resetFields();
    }
    setCarrierModalVisible(true);
  };

  const handleSaveCarrier = async (values) => {
    try {
      setCarriersLoading(true);
      if (editingCarrier) {
        // Update existing carrier
        await api.put(`/logistics/carriers/${editingCarrier.vendor_id}`, values);
        message.success("Transport carrier updated successfully!");
      } else {
        // Create new carrier
        await api.post('/logistics/carriers', values);
        message.success("New transport carrier registered!");
      }
      setCarrierModalVisible(false);
      fetchCarriers();
    } catch (err) {
      console.error(err);
      message.error(err.response?.data?.detail || "Failed to save carrier details.");
    } finally {
      setCarriersLoading(false);
    }
  };

  const handleDeactivateCarrier = async (vendorId) => {
    Modal.confirm({
      title: 'Are you sure you want to deactivate this carrier?',
      content: 'This will also disable their portal login credentials if they have one.',
      okText: 'Yes, Deactivate',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          setCarriersLoading(true);
          await api.delete(`/logistics/carriers/${vendorId}`);
          message.success("Carrier deactivated successfully.");
          fetchCarriers();
        } catch (err) {
          console.error(err);
          message.error("Failed to deactivate carrier.");
        } finally {
          setCarriersLoading(false);
        }
      }
    });
  };

  const handleOpenLoginModal = (carrier) => {
    setLoginCarrier(carrier);
    if (carrier.login) {
      loginForm.setFieldsValue({
        username: carrier.login.username,
        email: carrier.email,
      });
    } else {
      loginForm.resetFields();
      loginForm.setFieldsValue({
        email: carrier.email,
        full_name: carrier.contact_person,
        phone: carrier.mobile,
      });
    }
    setLoginModalVisible(true);
  };

  const handleSaveLogin = async (values) => {
    try {
      setCarriersLoading(true);
      if (loginCarrier.login) {
        // Update password/credentials
        await api.put(`/logistics/carriers/${loginCarrier.vendor_id}/login`, {
          new_password: values.password,
          email: values.email,
        });
        message.success("Carrier portal login credentials reset!");
      } else {
        // Create portal login
        await api.post(`/logistics/carriers/${loginCarrier.vendor_id}/login`, {
          username: values.username,
          password: values.password,
          email: values.email,
          full_name: values.full_name,
          phone: values.phone,
        });
        message.success("Carrier portal user account successfully created!");
      }
      setLoginModalVisible(false);
      fetchCarriers();
    } catch (err) {
      console.error(err);
      message.error(err.response?.data?.detail || "Failed to configure login account.");
    } finally {
      setCarriersLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <Spin size="large" tip="Loading Master Registries..." />
      </div>
    );
  }


  // Column definitions for Carriers
  const carrierColumns = [
    { title: 'Carrier Code', dataIndex: 'vendor_code', key: 'code', render: text => <span style={{ fontFamily: 'monospace', color: '#64748b' }}>{text}</span> },
    {
      title: 'Name',
      dataIndex: 'vendor_name',
      key: 'name',
      render: (text, record) => (
        <Space direction="vertical" size={2}>
          <span style={{ fontWeight: 'bold', color: record.is_active ? 'inherit' : '#94a3b8' }}>{text}</span>
          {!record.is_active && <Tag color="red">Inactive</Tag>}
        </Space>
      )
    },
    { title: 'Contact Person', dataIndex: 'contact_person', key: 'contact' },
    { title: 'Mobile', dataIndex: 'mobile', key: 'mobile', render: text => <span style={{ fontFamily: 'monospace' }}>{text}</span> },
    { title: 'Email', dataIndex: 'email', key: 'email' },
    {
      title: 'Rating',
      dataIndex: 'rating',
      key: 'rating',
      render: rating => (
        <Tag color="success" style={{ background: 'rgba(52, 211, 153, 0.1)', color: '#059669', border: '1px solid #10b981', fontSize: '11px', fontWeight: 'bold' }}>
          <StarFilled style={{ marginRight: '4px' }} /> {parseFloat(rating || 0).toFixed(1)}
        </Tag>
      )
    },
    {
      title: 'Portal Credentials',
      dataIndex: 'login',
      key: 'portal_login',
      render: (login, record) => {
        if (login) {
          return (
            <Tooltip title={`Last login: ${login.last_login ? new Date(login.last_login).toLocaleString() : 'Never'}`}>
              <Tag color="success" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <UserOutlined /> {login.username}
              </Tag>
            </Tooltip>
          );
        }
        return <Tag color="warning">No Access Configured</Tag>;
      }
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space size="middle">
          <Tooltip title="Edit Profile">
            <Button
              type="text"
              icon={<EditOutlined style={{ color: '#0284c7' }} />}
              onClick={() => handleOpenCarrierModal(record)}
            />
          </Tooltip>

          <Tooltip title={record.login ? "Manage Login / Reset Password" : "Provision Portal Access"}>
            <Button
              type="text"
              icon={<KeyOutlined style={{ color: record.login ? '#16a34a' : '#d97706' }} />}
              onClick={() => handleOpenLoginModal(record)}
            />
          </Tooltip>

          {record.is_active && (
            <Tooltip title="Deactivate Carrier">
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => handleDeactivateCarrier(record.vendor_id)}
              />
            </Tooltip>
          )}
        </Space>
      )
    }
  ];

  return (
    <div style={{ padding: '24px', minHeight: '100vh' }}>

      {/* Banner Title */}
      <div style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <Title level={2} style={{ margin: 0, fontWeight: 700 }}>Logistics Master </Title>
          <Paragraph style={{ color: '#64748b', fontSize: '14px', margin: '4px 0 0 0' }}>
            Third Party transporter fleet carriers register.
          </Paragraph>
        </div>
      </div>

      <Card variant="borderless" style={{ borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }} title={<span><CarOutlined /> Third party logistics Carriers</span>}>
        <Spin spinning={carriersLoading}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => handleOpenCarrierModal()}
              style={{ borderRadius: '6px', fontWeight: 'bold' }}
            >
              Register Carrier
            </Button>
          </div>
          <Table
            dataSource={carriers}
            columns={carrierColumns}
            rowKey="vendor_id"
            pagination={{ pageSize: 10 }}
          />
        </Spin>
      </Card>

      {/* Add / Edit Carrier Modal */}
      <Modal
        title={
          <span style={{ fontSize: '15px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <CarOutlined style={{ color: '#0284c7' }} />
            {editingCarrier ? `Edit Transporter: ${editingCarrier.vendor_name}` : 'Register New Transporter Fleet Carrier'}
          </span>
        }
        open={carrierModalVisible}
        onCancel={() => setCarrierModalVisible(false)}
        footer={null}
        width={650}
        styles={{ body: { padding: '24px' } }}
      >
        <Form
          form={carrierForm}
          layout="vertical"
          onFinish={handleSaveCarrier}
          initialValues={{ rating: 4.0 }}
        >
          <Form.Item
            name="name"
            label="Carrier Name / Business Title"
            rules={[{ required: true, message: 'Please enter business name' }]}
          >
            <Input prefix={<UserOutlined />} placeholder="E.g. SpeedForce Freight Systems" />
          </Form.Item>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <Form.Item
              name="vendor_code"
              label="Carrier Code (Slug)"
              tooltip="Leave empty to auto-slugify from name"
            >
              <Input placeholder="E.g. VND-SPEEDFORCE" />
            </Form.Item>

            <Form.Item
              name="contact_person"
              label="Contact Representative"
              rules={[{ required: true, message: 'Please enter contact person name' }]}
            >
              <Input placeholder="E.g. Rajesh Kumar" />
            </Form.Item>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <Form.Item
              name="email"
              label="Business Email"
              rules={[{ required: true, type: 'email', message: 'Please enter a valid email address' }]}
            >
              <Input prefix={<MailOutlined />} placeholder="E.g. logistics@speedforce.com" />
            </Form.Item>

            <Form.Item
              name="phone"
              label="Mobile Line"
              rules={[{ required: true, message: 'Please enter mobile line' }]}
            >
              <Input prefix={<PhoneOutlined />} placeholder="E.g. +91 9876543210" />
            </Form.Item>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '16px' }}>
            <Form.Item
              name="address"
              label="Headquarters Address"
            >
              <Input prefix={<EnvironmentFilled />} placeholder="City, State, Zip" />
            </Form.Item>

            <Form.Item
              name="rating"
              label="Compliance Rating (1 - 5)"
            >
              <InputNumber min={1.0} max={5.0} step={0.1} style={{ width: '100%' }} />
            </Form.Item>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '16px' }}>
            <Button onClick={() => setCarrierModalVisible(false)} style={{ borderRadius: '6px' }}>Cancel</Button>
            <Button type="primary" htmlType="submit" style={{ borderRadius: '6px' }}>Save Details</Button>
          </div>
        </Form>
      </Modal>

      {/* Provision / Update Login Credentials Modal */}
      <Modal
        title={
          <span style={{ fontSize: '15px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <KeyOutlined style={{ color: '#d97706' }} />
            {loginCarrier?.login ? 'Reset Portal Password' : 'Configure Carrier Portal Account'}
          </span>
        }
        open={loginModalVisible}
        onCancel={() => setLoginModalVisible(false)}
        footer={null}
        width={480}
        styles={{ body: { padding: '24px' } }}
      >
        <div style={{ marginBottom: '16px', background: 'rgba(217, 119, 6, 0.05)', border: '1px solid rgba(217, 119, 6, 0.2)', padding: '12px', borderRadius: '6px', fontSize: '12px', color: '#b45309' }}>
          <strong>Carrier portal accounts</strong> allow external transporters to securely login, view pending RFQ campaigns, and submit rate quotations directly.
        </div>

        <Form form={loginForm} layout="vertical" onFinish={handleSaveLogin}>
          {!loginCarrier?.login && (
            <Form.Item
              name="username"
              label="Username"
              rules={[{ required: true, message: 'Please define a username' }]}
            >
              <Input prefix={<UserOutlined />} placeholder="E.g. speedforce_portal" />
            </Form.Item>
          )}

          <Form.Item
            name="email"
            label="Notification Email"
            rules={[{ required: true, type: 'email', message: 'Please input contact email' }]}
          >
            <Input prefix={<MailOutlined />} placeholder="E.g. logistics@speedforce.com" />
          </Form.Item>

          <Form.Item
            name="password"
            label={loginCarrier?.login ? 'New Password' : 'Password'}
            rules={[{ required: true, message: 'Password is required' }]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="Define secure passcode" />
          </Form.Item>

          {!loginCarrier?.login && (
            <>
              <Form.Item name="full_name" hidden><Input /></Form.Item>
              <Form.Item name="phone" hidden><Input /></Form.Item>
            </>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '16px' }}>
            <Button onClick={() => setLoginModalVisible(false)} style={{ borderRadius: '6px' }}>Cancel</Button>
            <Button type="primary" htmlType="submit" style={{ borderRadius: '6px' }}>
              {loginCarrier?.login ? 'Reset Password' : 'Activate Portal User'}
            </Button>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
