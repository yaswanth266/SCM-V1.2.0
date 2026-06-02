import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Drawer, Form, Input, Select, Space, Row, Col, Tag,
  Popconfirm, message, Modal, Divider, Tabs, Card, Typography, Table,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  DownloadOutlined, LockOutlined, StopOutlined, CheckCircleOutlined,
  UserOutlined, SyncOutlined, SafetyCertificateOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { getErrorMessage, downloadExcel } from '../../utils/helpers';
import useAuthStore from '../../store/authStore';

const USER_TYPES = [
  { label: 'Admin', value: 'admin' },
  { label: 'Manager', value: 'manager' },
  { label: 'Staff', value: 'staff' },
  { label: 'Viewer', value: 'viewer' },
  { label: 'Warehouse User', value: 'warehouse_user' },
  { label: 'Field Staff', value: 'field_staff' },
];

const Users = () => {
  const { Text } = Typography;

  // BUG-AUTH-069 fix: read the logged-in user so the drawer can disable
  // privileged toggles when editing yourself (the backend already refuses
  // these changes, but the UI used to let admins try and then surface a
  // confusing 403).
  const currentUser = useAuthStore((s) => s.user);
  const rolesList = currentUser?.roles || [];
  const isAdmin = rolesList.some(r => {
    const code = typeof r === 'object' ? r.code : r;
    return code === 'admin' || code === 'super_admin';
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [form] = Form.useForm();
  const [resetForm] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [resetModal, setResetModal] = useState(false);
  const [resetUserId, setResetUserId] = useState(null);
  const [filterType, setFilterType] = useState(undefined);
  const [filterRole, setFilterRole] = useState(undefined);
  const [filterDept, setFilterDept] = useState(undefined);
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [refreshKey, setRefreshKey] = useState(0);
  const [roles, setRoles] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [projects, setProjects] = useState([]);
  const [departments, setDepartments] = useState([]);

  // New sub-tab mapping states
  const [activeSubTab, setActiveSubTab] = useState('list');
  const [selectedRoleId, setSelectedRoleId] = useState(undefined);
  const [selectedUserIds, setSelectedUserIds] = useState([]);
  const [mappingSearch, setMappingSearch] = useState('');
  const [mappingSubmitting, setMappingSubmitting] = useState(false);
  const [allUsers, setAllUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);

  useEffect(() => {
    fetchLookups();
  }, []);

  const fetchAllUsers = async () => {
    setUsersLoading(true);
    try {
      const res = await api.get('/settings/users', { params: { page_size: 10000 } });
      const d = res.data;
      const items = d.items || d.data || d || [];
      setAllUsers(items);
    } catch (err) {
      message.error('Failed to load users for mapping');
    } finally {
      setUsersLoading(false);
    }
  };

  useEffect(() => {
    if (activeSubTab === 'mapping') {
      fetchAllUsers();
    }
  }, [activeSubTab, refreshKey]);

  const handleAssignRoleToUsers = async () => {
    if (!selectedRoleId) {
      message.error('Please select a role first');
      return;
    }
    if (selectedUserIds.length === 0) {
      message.error('Please select at least one user');
      return;
    }

    setMappingSubmitting(true);
    try {
      await Promise.all(selectedUserIds.map(async (userId) => {
        const userObj = allUsers.find(u => u.auth_user_id === userId || u.user_id === userId || u.id === userId);
        if (!userObj) return;

        const currentRoleIds = userObj.roles?.map(r => typeof r === 'object' ? r.id : r) || [];

        if (currentRoleIds.includes(selectedRoleId)) {
          return;
        }

        const updatedRoleIds = [...currentRoleIds, selectedRoleId];
        await api.post(`/settings/users/${userObj.auth_user_id || userObj.id || userId}/roles`, {
          role_ids: updatedRoleIds
        });
      }));

      message.success('Roles assigned and appended successfully');
      setSelectedUserIds([]);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err) || 'Failed to map roles');
    } finally {
      setMappingSubmitting(false);
    }
  };

  const fetchLookups = async () => {
    try {
      const [roleRes, whRes, projRes] = await Promise.allSettled([
        api.get('/settings/roles', { params: { page_size: 200 } }),
        // Admin form needs the FULL warehouse + project list (not the
        // calling admin's scope) so they can assign anyone anywhere. Pass
        // a flag the backend will recognise; if not, super_admin already
        // bypasses the scope gate via user_is_managerial.
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
  };

  const fetchUsers = useCallback(
    async (params) => {
      const queryParams = { ...params };
      if (filterType) queryParams.user_type = filterType;
      if (filterRole) queryParams.role_id = filterRole;
      if (filterDept) queryParams.department = filterDept;
      if (filterStatus) queryParams.status = filterStatus;
      const res = await api.get('/settings/users', { params: queryParams });
      return res;
    },
    [filterType, filterRole, filterDept, filterStatus]
  );

  const handleAdd = () => {
    setEditingUser(null);
    form.resetFields();
    form.setFieldsValue({ is_active: true, user_type: 'staff' });
    setDrawerOpen(true);
  };

  const handleEdit = (record) => {
    setEditingUser(record);
    form.setFieldsValue({
      ...record,
      role_ids: record.roles?.map((r) => typeof r === 'object' ? r.id : r) || record.role_ids || [],
      warehouse_ids: record.warehouses?.map((w) => typeof w === 'object' ? w.id : w) || record.warehouse_ids || [],
      // Project assignments were never being loaded into the form; the
      // dropdown showed blank even on edit, making it look like the user
      // had no projects when in fact they did.
      project_ids: record.projects?.map((p) => typeof p === 'object' ? p.id : p) || record.project_ids || [],
    });
    setDrawerOpen(true);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/settings/users/${id}`);
      // BUG-AUTH-067 fix: backend only soft-deletes (deactivates). The
      // previous "User deleted successfully" toast was misleading and led
      // admins to believe the row was hard-removed.
      message.success('User deactivated successfully');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleToggleStatus = async (record) => {
    if (!record.auth_user_id) {
      message.warning('This employee does not have a linked login user');
      return;
    }
    const newStatus = record.status === 'active' ? 'inactive' : 'active';
    try {
      await api.patch(`/settings/users/${record.auth_user_id}/status`, { status: newStatus });
      message.success(`User ${newStatus === 'active' ? 'activated' : 'deactivated'} successfully`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleResetPassword = (record) => {
    if (!record.auth_user_id) {
      message.warning('This employee does not have a linked login user');
      return;
    }
    setResetUserId(record.auth_user_id);
    resetForm.resetFields();
    setResetModal(true);
  };

  const handleSyncEmployees = async () => {
    try {
      const res = await api.post('/masters/employees/sync-api', null, { timeout: 180000 });
      const data = res.data || {};
      message.success(`HR sync completed. Fetched ${data.fetched || 0}, created ${data.created || 0}, updated ${data.updated || 0}, role links ${data.role_links_applied || 0}.`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleApplyPositionRole = async (record) => {
    try {
      const res = await api.post(`/settings/users/${record.employee_id || record.id}/apply-position-role`);
      message.success(res.data?.message || 'Position role applied');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleResetSubmit = async () => {
    try {
      const values = await resetForm.validateFields();
      await api.post(`/settings/users/${resetUserId}/reset-password`, { new_password: values.new_password });
      message.success('Password reset successfully');
      setResetModal(false);
      resetForm.resetFields();
      setResetUserId(null);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      if (editingUser) {
        const payload = { ...values };
        if (!payload.password) delete payload.password;
        await api.put(`/settings/users/${editingUser.auth_user_id || editingUser.id}`, payload);
        message.success('User updated successfully');
      } else {
        await api.post('/settings/users', values);
        message.success('User created successfully');
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingUser(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleExport = async () => {
    try {
      const res = await api.get('/settings/users', { params: { page_size: 10000 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      const exportData = items.map((u) => ({
        'Employee Code': u.employee_code || '',
        'Login Username': u.has_login ? u.username : '',
        'Full Name': u.full_name || '',
        'Email': u.email || '',
        'Phone': u.phone || '',
        'Position': u.position_name || '',
        'Department': u.department || '',
        'Position Role': u.role_name || '',
        'Roles': (u.roles || []).map((r) => typeof r === 'object' ? r.name : r).join(', '),
        'Login Enabled': u.login_enabled ? 'Yes' : 'No',
        'Status': u.status || (u.is_active ? 'active' : 'inactive'),
      }));
      downloadExcel(exportData, 'users', 'Users');
      // BUG-AUTH-072 fix: previously the export wrote PII to disk with no
      // audit trail. The backend listing GET is logged at the AuditMiddleware
      // level only as "GET /settings/users" — fire a semantic export-audit
      // ping so security can answer "who downloaded the user directory?".
      try {
        await api.post('/settings/users/audit-export', {
          row_count: items.length,
          export_type: 'user_directory',
        });
      } catch {
        /* audit failure must not block export */
      }
      message.success('Export completed');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'S.No',
      key: '_serial',
      width: 60,
      align: 'center',
      render: (_v, _r, index) => index + 1,
    },
    {
      title: 'Emp Code',
      dataIndex: 'employee_code',
      key: 'employee_code',
      width: 110,
      sorter: true,
      render: (val) => val || '-',
    },
    {
      title: 'Login User',
      dataIndex: 'username',
      key: 'username',
      width: 130,
      sorter: true,
      render: (val, record) => (record.has_login ? val : <Tag>NO LOGIN</Tag>),
    },
    {
      title: 'Full Name',
      key: 'full_name',
      width: 180,
      sorter: true,
      ellipsis: true,
      render: (_, record) => record.full_name || `${record.first_name || ''} ${record.last_name || ''}`.trim() || '-',
    },
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
      width: 200,
      ellipsis: true,
      render: (val) => val || '-',
    },
    {
      title: 'Phone',
      dataIndex: 'phone',
      key: 'phone',
      width: 130,
      render: (val) => val || '-',
    },
    {
      title: 'Position',
      dataIndex: 'position_name',
      key: 'position_name',
      width: 180,
      render: (val, record) => val || record.designation || '-',
    },
    {
      title: 'Department',
      dataIndex: 'department',
      key: 'department',
      width: 130,
      render: (val) => val || '-',
    },
    {
      title: 'Roles',
      key: 'roles',
      width: 180,
      render: (_, record) => {
        const roles = record.roles;
        if (roles && roles.length > 0) {
          return roles.map((r) => {
            const name = typeof r === 'object' ? r.name : r;
            const key = typeof r === 'object' ? r.id : r;
            return <Tag key={key} color="blue">{name}</Tag>;
          });
        }
        if (record.role_name) {
          return <Tag color="orange" title="Position-based Role">{record.role_name}</Tag>;
        }
        return '-';
      },
    },
    {
      title: 'Login',
      dataIndex: 'login_enabled',
      key: 'login_enabled',
      width: 100,
      render: (value, record) => (record.has_login ? <StatusTag status={value ? 'active' : 'inactive'} /> : <Tag>Not Created</Tag>),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status) => <StatusTag status={status} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
            title="Edit User"
          />
          {record.has_login && record.role_id && (
            <Button
              type="link"
              size="small"
              icon={<SafetyCertificateOutlined />}
              onClick={() => handleApplyPositionRole(record)}
              title="Apply Position Role"
            />
          )}
          <Button
            type="link"
            size="small"
            icon={<LockOutlined />}
            onClick={() => handleResetPassword(record)}
            title="Reset Password"
            disabled={!record.has_login}
          />
          <Button
            type="link"
            size="small"
            icon={record.status === 'active' ? <StopOutlined /> : <CheckCircleOutlined />}
            onClick={() => handleToggleStatus(record)}
            title={record.status === 'active' ? 'Deactivate' : 'Activate'}
            danger={record.status === 'active'}
            disabled={!record.has_login}
          />
        </Space>
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <Select
        placeholder="User Type"
        allowClear
        style={{ width: 140 }}
        value={filterType}
        onChange={(v) => { setFilterType(v); setRefreshKey((k) => k + 1); }}
        options={USER_TYPES}
      />
      <Select
        placeholder="Role"
        allowClear
        style={{ width: 150 }}
        value={filterRole}
        onChange={(v) => { setFilterRole(v); setRefreshKey((k) => k + 1); }}
        options={roles}
      />
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 120 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Active', value: 'active' },
          { label: 'Inactive', value: 'inactive' },
        ]}
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="User Management" subtitle="HR employee users with position-based role access">
        <Space>
          {isAdmin && (
            <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Add User</Button>
          )}
          <Button icon={<SyncOutlined />} onClick={handleSyncEmployees}>Sync HR API</Button>
          <Button icon={<DownloadOutlined />} onClick={handleExport}>Export</Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchUsers}
        rowKey="id"
        searchPlaceholder="Search by name, username, or email..."
        exportFileName="users"
        toolbar={toolbar}
        scroll={{ x: 1500 }}
      />

      {/* Add/Edit Drawer */}
      <Drawer
        title={editingUser ? 'Edit User' : 'Add User'}
        width={640}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setEditingUser(null); form.resetFields(); }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); setEditingUser(null); form.resetFields(); }}>Cancel</Button>
            <Button type="primary" onClick={handleSubmit} loading={submitting}>
              {editingUser ? 'Update' : 'Create'}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Divider orientation="left" plain>Account Information</Divider>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="employee_code" label="Employee Code">
                <Input placeholder="e.g. EMP-001" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="username" label="Username" rules={[{ required: true, message: 'Username is required' }, { pattern: /^[a-zA-Z0-9_]{3,50}$/, message: 'Only letters, numbers, underscore (3-50 chars)' }]}>
                <Input placeholder="Enter username" disabled={!!editingUser} maxLength={50} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="first_name" label="First Name" rules={[{ required: true, message: 'First name is required' }, { max: 100, message: 'Max 100 characters' }]}>
                <Input placeholder="Enter first name" maxLength={100} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="last_name" label="Last Name">
                <Input placeholder="Enter last name" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="email" label="Email" rules={[{ required: true, message: 'Email is required' }, { type: 'email', message: 'Enter a valid email' }]}>
                <Input placeholder="Enter email" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="designation" label="Designation">
                <Input placeholder="Enter designation" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="phone" label="Phone" rules={[{ pattern: /^[0-9+\-\s()]{6,20}$/, message: 'Enter a valid phone number (6-20 digits)' }]}>
                <Input placeholder="Enter phone number" maxLength={20} />
              </Form.Item>
            </Col>
            <Col span={12}>
              {!editingUser && (
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
              {editingUser && (
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
            <Col span={12}>
              <Form.Item name="user_type" label="User Type" rules={[{ required: true }]}>
                <Select placeholder="Select user type" options={USER_TYPES} />
              </Form.Item>
            </Col>
            <Col span={12}>
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
              // BUG-AUTH-069 fix: prevent self-demotion via UI. Backend
              // also enforces but disabling here gives an immediate signal.
              disabled={!!editingUser && currentUser && editingUser.id === currentUser.id}
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
              disabled={!!editingUser && currentUser && editingUser.id === currentUser.id}
              options={[
                { label: 'Active', value: true },
                { label: 'Inactive', value: false },
              ]}
            />
          </Form.Item>
        </Form>
      </Drawer>

      {/* Reset Password Modal */}
      <Modal
        title="Reset Password"
        open={resetModal}
        onCancel={() => { setResetModal(false); resetForm.resetFields(); setResetUserId(null); }}
        onOk={handleResetSubmit}
        okText="Reset Password"
        destroyOnHidden
      >
        <Form form={resetForm} layout="vertical">
          <Form.Item
            name="new_password"
            label="New Password"
            // BUG-AUTH-043 fix: align with backend ResetPassword schema
            // (min 8 + complexity). The previous min:6 was inconsistent
            // with the backend validator and caused confusing 422 errors.
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
            <Input.Password placeholder="Enter new password" />
          </Form.Item>
          <Form.Item
            name="confirm_password"
            label="Confirm Password"
            dependencies={['new_password']}
            rules={[
              { required: true, message: 'Confirm the password' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('new_password') === value) return Promise.resolve();
                  return Promise.reject(new Error('Passwords do not match'));
                },
              }),
            ]}
          >
            <Input.Password placeholder="Confirm new password" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Users;

