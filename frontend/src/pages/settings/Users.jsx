import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, Tag,
  Popconfirm, message, Modal, Form, Input, Typography,
} from 'antd';
import {
  PlusOutlined, EditOutlined,
  DownloadOutlined, LockOutlined, StopOutlined, CheckCircleOutlined,
  SyncOutlined, SafetyCertificateOutlined,
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
// USER_TYPES kept here for the user-type filter dropdown in the toolbar

const deduplicatePositions = (positions) => {
  if (!Array.isArray(positions)) return [];
  const unique = [];
  const seenRoleIds = new Set();
  const seenRoleNames = new Set();
  for (const p of positions) {
    if (!p) continue;
    if (typeof p !== 'object') {
      unique.push(p);
      continue;
    }
    const roleId = p.role_id;
    const roleName = (p.role_name || p.role_code || p.name || p.position_name || '').trim().toLowerCase();
    if (roleId != null) {
      if (seenRoleIds.has(roleId)) continue;
      seenRoleIds.add(roleId);
      if (roleName) seenRoleNames.add(roleName);
      unique.push(p);
    } else if (roleName) {
      if (seenRoleNames.has(roleName)) continue;
      seenRoleNames.add(roleName);
      unique.push(p);
    } else {
      unique.push(p);
    }
  }
  return unique;
};

const Users = () => {
  const { Text } = Typography;
  const navigate = useNavigate();

  // BUG-AUTH-069 fix: read the logged-in user
  const currentUser = useAuthStore((s) => s.user);
  const rolesList = currentUser?.roles || [];
  const isAdmin = rolesList.some(r => {
    const code = typeof r === 'object' ? r.code : r;
    return code === 'admin' || code === 'super_admin';
  });
  const [resetForm] = Form.useForm();
  const [resetModal, setResetModal] = useState(false);
  const [resetUserId, setResetUserId] = useState(null);
  const [filterType, setFilterType] = useState(undefined);
  const [filterRole, setFilterRole] = useState(undefined);
  const [filterDept, setFilterDept] = useState(undefined);
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [refreshKey, setRefreshKey] = useState(0);
  const [roles, setRoles] = useState([]);

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
      const [roleRes] = await Promise.allSettled([
        api.get('/settings/roles', { params: { page_size: 200 } }),
      ]);
      if (roleRes.status === 'fulfilled') {
        const d = roleRes.value.data;
        setRoles((d.items || d.data || d || []).map((r) => ({ label: `${r.code || r.name} - ${r.name}`, value: r.id })));
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
    navigate('/settings/users/new');
  };

  const handleEdit = (record) => {
    navigate(`/settings/users/${record.auth_user_id || record.id}`);
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
        'Position': (u.positions && Array.isArray(u.positions))
          ? deduplicatePositions(u.positions).map((p) => (typeof p === 'object' ? (p.name || p.position_name || '') : p)).join(' | ')
          : (u.position_name || ''),
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
      key: 'position_name',
      width: 220,
      render: (_, record) => {
        // Handle positions array (future backend support for multiple positions)
        if (record.positions && Array.isArray(record.positions) && record.positions.length > 0) {
          const uniquePositions = deduplicatePositions(record.positions);
          return (
            <Space size={[0, 4]} wrap>
              {uniquePositions.map((p, i) => {
                const label = typeof p === 'object' ? (p.name || p.position_name || '') : p;
                return label ? <Tag key={i} color="blue">{label}</Tag> : null;
              })}
            </Space>
          );
        }
        // Handle pipe-separated position_name
        const val = record.position_name || record.designation || '-';
        if (val.includes('|')) {
          const parts = val.split('|').map((s) => s.trim()).filter(Boolean);
          if (parts.length > 1) {
            return (
              <Space size={[0, 4]} wrap>
                {parts.map((p, i) => <Tag key={i} color="blue">{p}</Tag>)}
              </Space>
            );
          }
        }
        return val;
      },
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
            onClick={() => navigate(`/settings/users/${record.auth_user_id || record.id}`)}
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

