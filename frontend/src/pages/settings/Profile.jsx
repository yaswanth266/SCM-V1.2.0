import React, { useEffect, useState } from 'react';
import { Card, Row, Col, Avatar, Tag, Descriptions, Button, Spin } from 'antd';
import {
  MailOutlined,
  PhoneOutlined,
  UserOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import useAuthStore from '../../store/authStore';
import { formatDateTime, formatDate, getInitials } from '../../utils/helpers';

const Profile = () => {
  const { user, refreshUser } = useAuthStore();
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await refreshUser();
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    refreshUser();
  }, []);

  if (!user) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <Spin size="large" tip="Loading profile..." />
      </div>
    );
  }

  const initials = getInitials(user.full_name || user.username);
  const statusColor = user.status === 'active' || user.is_active ? 'success' : 'error';
  const statusText = user.status === 'active' || user.is_active ? 'Active' : 'Inactive';

  return (
    <div style={{ padding: '0 8px' }}>
      <PageHeader
        title="My Profile"
        subtitle="View and manage your account information"
        extra={[
          <Button
            key="sync"
            icon={<SyncOutlined spin={syncing} />}
            onClick={handleSync}
            loading={syncing}
            type="primary"
            style={{
              borderRadius: '6px',
              background: 'linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)',
              border: 'none',
              boxShadow: '0 2px 4px rgba(37, 99, 235, 0.3)',
            }}
          >
            Sync Account Details
          </Button>
        ]}
      />

      {/* Profile Banner */}
      <div style={{
        background: 'linear-gradient(135deg, #F0F4F8 0%, #D9E2EC 100%)',
        height: '140px',
        borderRadius: '12px 12px 0 0',
        position: 'relative',
        marginBottom: '60px',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.1)'
      }}>
        <div style={{
          position: 'absolute',
          bottom: '-45px',
          left: '32px',
          display: 'flex',
          alignItems: 'flex-end',
          gap: '16px'
        }}>
          <Avatar
            size={100}
            style={{
              backgroundColor: '#3B82F6',
              border: '4px solid #fff',
              fontSize: '36px',
              fontWeight: 'bold',
              boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)'
            }}
          >
            {initials}
          </Avatar>
          <div style={{ marginBottom: '8px' }}>
            <h2 style={{ margin: 0, fontSize: '24px', fontWeight: '700', color: '#111827' }}>
              {user.full_name || 'User Name'}
            </h2>
            <p style={{ margin: 0, color: '#4B5563', fontWeight: '500' }}>
              {user.designation || 'No Designation'}
            </p>
          </div>
        </div>
      </div>

      <Row gutter={[24, 24]}>
        {/* Left Side: General and Contact Info */}
        <Col xs={24} md={12}>
          <Card
            title="General Information"
            bordered={false}
            style={{
              borderRadius: '8px',
              boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
              height: '100%',
            }}
            headStyle={{ borderBottom: '1px solid #F3F4F6', fontWeight: '600' }}
          >
            <Descriptions column={1} size="middle" bordered={false}>
              <Descriptions.Item label={<span><UserOutlined style={{ marginRight: 8, color: '#2563EB' }} /> Username</span>}>
                <span style={{ fontWeight: '500', color: '#1F2937' }}>{user.username}</span>
              </Descriptions.Item>
              <Descriptions.Item label={<span><MailOutlined style={{ marginRight: 8, color: '#2563EB' }} /> Email Address</span>}>
                <span style={{ color: '#1F2937' }}>{user.email || 'N/A'}</span>
              </Descriptions.Item>
              <Descriptions.Item label={<span><PhoneOutlined style={{ marginRight: 8, color: '#2563EB' }} /> Phone Number</span>}>
                <span style={{ color: '#1F2937' }}>{user.phone || 'N/A'}</span>
              </Descriptions.Item>
              <Descriptions.Item label={<span><CalendarOutlined style={{ marginRight: 8, color: '#2563EB' }} /> Member Since</span>}>
                <span style={{ color: '#1F2937' }}>{user.created_at ? formatDate(user.created_at) : 'N/A'}</span>
              </Descriptions.Item>
              <Descriptions.Item label={<span><CheckCircleOutlined style={{ marginRight: 8, color: '#2563EB' }} /> Status</span>}>
                <Tag color={statusColor} style={{ borderRadius: '4px', fontWeight: '600' }}>
                  {statusText}
                </Tag>
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>

        {/* Right Side: Employment Profile */}
        <Col xs={24} md={12}>
          <Card
            title="Employment Profile"
            bordered={false}
            style={{
              borderRadius: '8px',
              boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
              height: '100%',
            }}
            headStyle={{ borderBottom: '1px solid #F3F4F6', fontWeight: '600' }}
          >
            <Descriptions column={1} size="middle" bordered={false}>
              <Descriptions.Item label="Employee Code">
                <span style={{ fontWeight: '600', color: '#111827' }}>{user.employee_code || 'N/A'}</span>
              </Descriptions.Item>
              <Descriptions.Item label="Department">
                <span style={{ color: '#374151' }}>{user.department || 'N/A'}</span>
              </Descriptions.Item>
              <Descriptions.Item label="User Type">
                <Tag color="cyan" style={{ textTransform: 'capitalize', fontWeight: '500' }}>
                  {user.user_type || 'employee'}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Last Login">
                <span style={{ color: '#374151' }}>{user.last_login ? formatDateTime(user.last_login) : 'Never'}</span>
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default Profile;
