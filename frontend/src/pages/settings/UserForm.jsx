import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Button, Form, Input, Select, Space, Row, Col,
  message, Card, Divider, Spin,
} from 'antd';
import {
  ArrowLeftOutlined, SaveOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';
import useAuthStore from '../../store/authStore';

const USER_TYPES = [
  { label: 'Admin', value: 'admin' },
  { label: 'Manager', value: 'manager' },
  { label: 'Staff', value: 'staff' },
  { label: 'Viewer', value: 'viewer' },
  { label: 'Warehouse User', value: 'warehouse_user' },
  { label: 'Field Staff', value: 'field_staff' },
];

const UserForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const currentUser = useAuthStore((s) => s.user);

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [editingUser, setEditingUser] = useState(null);

  // Lookups
  const [roles, setRoles] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [projects, setProjects] = useState([]);

  const fetchLookups = useCallback(async () => {
    try {
      const [roleRes, whRes, projRes] = await Promise.allSettled([
        api.get('/settings/roles', { params: { page_size: 200 } }),
        api.get('/masters/warehouses', { params: { page_size: 500 } }),
        api.get('/masters/projects', { params: { page_size: 500 } }),
      ]);
      if (roleRes.status === 'fulfilled') {
        const d = roleRes.value.data;
        setRoles((d.items || d.data || d || []).map((r) => ({ label: `${r.code || r.name} - ${r.name}`, value: r.id })));
      }
      if (whRes.status === 'fulfilled') {
        const d = whRes.value.data;
        setWarehouses((d.items || d.data || d || []).map((w) => ({ label: w.name, value: w.id })));
      }
      if (projRes.status === 'fulfilled') {
        const d = projRes.value.data;
        setProjects((d.items || d.data || d || []).map((p) => ({ label: p.name, value: p.id })));
      }
    } catch { /* silent */ }
  }, []);

  const fetchUser = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/settings/users/${id}`);
      const data = res.data;
      setEditingUser(data);
      form.setFieldsValue({
        ...data,
        role_ids: data.roles?.map((r) => typeof r === 'object' ? r.id : r) || data.role_ids || [],
        warehouse_ids: data.warehouses?.map((w) => typeof w === 'object' ? w.id : w) || data.warehouse_ids || [],
        project_ids: data.projects?.map((p) => typeof p === 'object' ? p.id : p) || data.project_ids || [],
      });
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/settings/users');
    } finally {
      setLoading(false);
    }
  }, [id, form, navigate]);

  useEffect(() => {
    fetchLookups();
    if (!isNew) {
      fetchUser();
    } else {
      form.setFieldsValue({ is_active: true, user_type: 'staff' });
    }
  }, [id]);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      if (!isNew && editingUser) {
        const payload = { ...values };
        if (!payload.password) delete payload.password;
        await api.put(`/settings/users/${editingUser.auth_user_id || editingUser.id}`, payload);
        message.success('User updated successfully');
      } else {
        await api.post('/settings/users', values);
        message.success('User created successfully');
      }
      navigate('/settings/users');
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}>
        <Spin size="large" />
      </div>
    );
  }

  const isSelf = editingUser && currentUser && editingUser.id === currentUser.id;

  return (
    <div>
      <PageHeader
        title={isNew ? 'Add User' : `Edit User: ${editingUser?.full_name || editingUser?.username || ''}`}
        subtitle={isNew ? 'Create a new user account' : 'Edit user account details'}
      >
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/settings/users')}>
            Back to Users
          </Button>
        </Space>
      </PageHeader>

      <Card>
        <Form form={form} layout="vertical">
          <Divider orientation="left" plain>Account Information</Divider>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item name="employee_code" label="Employee Code">
                <Input placeholder="e.g. EMP-001" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                name="username"
                label="Username"
                rules={[
                  { required: true, message: 'Username is required' },
                  { pattern: /^[a-zA-Z0-9_]{3,50}$/, message: 'Only letters, numbers, underscore (3-50 chars)' },
                ]}
              >
                <Input placeholder="Enter username" disabled={!isNew} maxLength={50} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item
                name="first_name"
                label="First Name"
                rules={[
                  { required: true, message: 'First name is required' },
                  { max: 100, message: 'Max 100 characters' },
                ]}
              >
                <Input placeholder="Enter first name" maxLength={100} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="last_name" label="Last Name">
                <Input placeholder="Enter last name" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item
                name="email"
                label="Email"
                rules={[
                  { required: true, message: 'Email is required' },
                  { type: 'email', message: 'Enter a valid email' },
                ]}
              >
                <Input placeholder="Enter email" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="designation" label="Designation">
                <Input placeholder="Enter designation" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item
                name="phone"
                label="Phone"
                rules={[{ pattern: /^[0-9+\-\s()]{6,20}$/, message: 'Enter a valid phone number (6-20 digits)' }]}
              >
                <Input placeholder="Enter phone number" maxLength={20} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              {isNew && (
                <Form.Item
                  name="password"
                  label="Password"
                  rules={[
                    { required: true, message: 'Password is required' },
                    { min: 8, message: 'Password must be at least 8 characters' },
                    {
                      validator: (_, value) => {
                        if (!value) return Promise.resolve();
                        if (!/[A-Z]/.test(value)) return Promise.reject(new Error('Must include an uppercase letter'));
                        if (!/[a-z]/.test(value)) return Promise.reject(new Error('Must include a lowercase letter'));
                        if (!/\d/.test(value)) return Promise.reject(new Error('Must include a digit'));
                        if (!/[!@#$%^&*(),.?":{}|<>]/.test(value)) return Promise.reject(new Error('Must include a special character'));
                        return Promise.resolve();
                      },
                    },
                  ]}
                >
                  <Input.Password placeholder="Enter password" />
                </Form.Item>
              )}
              {!isNew && (
                <Form.Item
                  name="password"
                  label="New Password (leave blank to keep)"
                  rules={[
                    { min: 8, message: 'Password must be at least 8 characters' },
                    {
                      validator: (_, value) => {
                        if (!value) return Promise.resolve();
                        if (!/[A-Z]/.test(value)) return Promise.reject(new Error('Must include an uppercase letter'));
                        if (!/[a-z]/.test(value)) return Promise.reject(new Error('Must include a lowercase letter'));
                        if (!/\d/.test(value)) return Promise.reject(new Error('Must include a digit'));
                        if (!/[!@#$%^&*(),.?":{}|<>]/.test(value)) return Promise.reject(new Error('Must include a special character'));
                        return Promise.resolve();
                      },
                    },
                  ]}
                >
                  <Input.Password placeholder="Leave blank to keep current" />
                </Form.Item>
              )}
            </Col>
          </Row>

          <Divider orientation="left" plain>Role & Access</Divider>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item name="user_type" label="User Type" rules={[{ required: true }]}>
                <Select placeholder="Select user type" options={USER_TYPES} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="department" label="Department">
                <Input placeholder="Enter department" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="role_ids" label="Roles">
            <Select
              mode="multiple"
              placeholder="Select roles"
              options={roles}
              showSearch
              optionFilterProp="label"
              allowClear
              // BUG-AUTH-069 fix: prevent self-demotion via UI
              disabled={isSelf}
            />
          </Form.Item>
          <Form.Item name="warehouse_ids" label="Assigned Warehouses">
            <Select
              mode="multiple"
              placeholder="Select warehouses"
              options={warehouses}
              showSearch
              optionFilterProp="label"
              allowClear
            />
          </Form.Item>
          <Form.Item name="project_ids" label="Assigned Projects">
            <Select
              mode="multiple"
              placeholder="Select projects"
              options={projects}
              showSearch
              optionFilterProp="label"
              allowClear
            />
          </Form.Item>

          <Divider orientation="left" plain>Status</Divider>
          <Form.Item name="is_active" label="Status" rules={[{ required: true }]}>
            <Select
              // BUG-AUTH-069 fix: do not let admins disable themselves.
              disabled={isSelf}
              options={[
                { label: 'Active', value: true },
                { label: 'Inactive', value: false },
              ]}
            />
          </Form.Item>
        </Form>

        <Divider />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={() => navigate('/settings/users')}>Cancel</Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSubmit} loading={submitting}>
            {isNew ? 'Create User' : 'Update User'}
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default UserForm;
