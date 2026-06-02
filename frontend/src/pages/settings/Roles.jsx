import React, { useState, useEffect } from 'react';
import {
  Button, Card, Row, Col, List, Input, Checkbox, Space, message,
  Modal, Form, Typography, Divider, Popconfirm, Spin, Tag,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, SaveOutlined, CheckOutlined,
  RightOutlined, DownOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';
import { MODULE_NAVS } from '../../utils/moduleNavs';

const { Title, Text } = Typography;

const MODULE_ORDER = [
  'masters', 'procurement', 'warehouse', 'inventory', 'logistics', 'outbound',
  'indent', 'consumption', 'approvals', 'accounts', 'assets', 'reports',
  'settings', 'healthcare', 'compliance', 'documents', 'mrp', 'alerts', 'dashboard',
];

const slugify = (value) => String(value || '')
  .toLowerCase()
  .replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const permissionKeyForTab = (moduleKey, tab) => {
  const parts = String(tab.path || '').split('?')[0].split('/').filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]}-${parts[1]}`;
  }
  return `${moduleKey}-${slugify(tab.label)}`;
};

const PERMISSION_MODULES = MODULE_ORDER.map((key) => {
  const nav = MODULE_NAVS[key];
  if (nav) {
    const seen = new Set();
    return {
      key,
      label: nav.label,
      children: (nav.tabs || [])
        .map((tab) => ({
          key: permissionKeyForTab(key, tab),
          label: tab.label,
        }))
        .filter((row) => {
          if (row.key === key || seen.has(row.key)) return false;
          seen.add(row.key);
          return true;
        }),
    };
  }
  return { key, label: key.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), children: [] };
});

const PERMISSION_ROWS = PERMISSION_MODULES.flatMap((mod) => [
  { ...mod, level: 0 },
  ...(mod.children || []).map((child) => ({
    ...child,
    parentKey: mod.key,
    moduleLabel: mod.label,
    level: 1,
  })),
]);

const PERMISSION_ACTIONS = [
  { key: 'view', label: 'View' },
  { key: 'create', label: 'Create' },
  { key: 'edit', label: 'Edit' },
  { key: 'delete', label: 'Delete' },
  { key: 'approve', label: 'Approve' },
  { key: 'export', label: 'Export' },
];

const Roles = () => {
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedRole, setSelectedRole] = useState(null);
  const [permissions, setPermissions] = useState({});
  const [saving, setSaving] = useState(false);
  const [roleModal, setRoleModal] = useState(false);
  const [editingRole, setEditingRole] = useState(null);
  const [form] = Form.useForm();
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const [expandedModules, setExpandedModules] = useState({});

  const toggleModule = (moduleKey) => {
    setExpandedModules((prev) => ({
      ...prev,
      [moduleKey]: !prev[moduleKey],
    }));
  };

  const visibleRows = PERMISSION_ROWS.filter((row) => {
    if (row.level === 0) return true;
    return !!expandedModules[row.parentKey];
  });

  useEffect(() => {
    fetchRoles();
  }, []);

  const fetchRoles = async () => {
    setLoading(true);
    try {
      const res = await api.get('/settings/roles', { params: { include_inactive: true } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setRoles(items);
      if (items.length > 0 && !selectedRole) {
        setSelectedRole(items[0]);
        fetchPermissions(items[0].id);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const fetchPermissions = async (roleId) => {
    setPermissionsLoading(true);
    try {
      const res = await api.get(`/settings/roles/${roleId}/permissions`);
      const data = res.data;
      const perms = data.permissions || data.data || data || [];
      const permMap = {};
      PERMISSION_ROWS.forEach((row) => {
        permMap[row.key] = {};
        PERMISSION_ACTIONS.forEach((act) => {
          permMap[row.key][act.key] = false;
        });
      });
      if (Array.isArray(perms)) {
        perms.forEach((p) => {
          const moduleKey = String(p.module || '').toLowerCase();
          if (permMap[moduleKey]) {
            if (p.actions && Array.isArray(p.actions)) {
              p.actions.forEach((a) => {
                if (permMap[moduleKey][a] !== undefined) {
                  permMap[moduleKey][a] = true;
                }
              });
            }
            if (p.action && permMap[moduleKey][p.action] !== undefined) {
              permMap[moduleKey][p.action] = true;
            }
          }
        });
      }
      setPermissions(permMap);
    } catch {
      const permMap = {};
      PERMISSION_ROWS.forEach((row) => {
        permMap[row.key] = {};
        PERMISSION_ACTIONS.forEach((act) => {
          permMap[row.key][act.key] = false;
        });
      });
      setPermissions(permMap);
    } finally {
      setPermissionsLoading(false);
    }
  };

  const handleSelectRole = (role) => {
    setSelectedRole(role);
    fetchPermissions(role.id);
  };

  const handleAddRole = () => {
    setEditingRole(null);
    form.resetFields();
    setRoleModal(true);
  };

  const handleEditRole = (role) => {
    setEditingRole(role);
    form.setFieldsValue({ name: role.name, description: role.description });
    setRoleModal(true);
  };

  const handleDeleteRole = async (roleId) => {
    try {
      await api.delete(`/settings/roles/${roleId}`);
      message.success('Role deleted successfully');
      if (selectedRole?.id === roleId) {
        setSelectedRole(null);
        setPermissions({});
      }
      fetchRoles();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleRoleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editingRole) {
        await api.put(`/settings/roles/${editingRole.id}`, values);
        message.success('Role updated successfully');
      } else {
        await api.post('/settings/roles', values);
        message.success('Role created successfully');
      }
      setRoleModal(false);
      form.resetFields();
      setEditingRole(null);
      fetchRoles();
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    }
  };

  const handlePermissionChange = (module, action, checked) => {
    setPermissions((prev) => ({
      ...prev,
      [module]: {
        ...prev[module],
        [action]: checked,
      },
    }));
  };

  const handleSelectAllRow = (module, checked) => {
    setPermissions((prev) => {
      const moduleDef = PERMISSION_MODULES.find((mod) => mod.key === module);
      const updatedState = { ...prev };
      const targetKeys = [module, ...((moduleDef?.children || []).map((child) => child.key))];
      PERMISSION_ACTIONS.forEach((act) => {
        targetKeys.forEach((key) => {
          updatedState[key] = { ...(updatedState[key] || {}), [act.key]: checked };
        });
      });
      return updatedState;
    });
  };

  const handleSelectAllColumn = (action, checked) => {
    setPermissions((prev) => {
      const updated = { ...prev };
      PERMISSION_ROWS.forEach((row) => {
        updated[row.key] = { ...updated[row.key], [action]: checked };
      });
      return updated;
    });
  };

  const isRowAllChecked = (module) => {
    const moduleDef = PERMISSION_MODULES.find((mod) => mod.key === module);
    const targetKeys = [module, ...((moduleDef?.children || []).map((child) => child.key))];
    return targetKeys.every((key) => PERMISSION_ACTIONS.every((act) => permissions[key]?.[act.key]));
  };

  const isRowSomeChecked = (module) => {
    const moduleDef = PERMISSION_MODULES.find((mod) => mod.key === module);
    const targetKeys = [module, ...((moduleDef?.children || []).map((child) => child.key))];
    return targetKeys.some((key) => PERMISSION_ACTIONS.some((act) => permissions[key]?.[act.key])) && !isRowAllChecked(module);
  };

  const isColAllChecked = (action) => {
    return PERMISSION_ROWS.every((row) => permissions[row.key]?.[action]);
  };

  const isColSomeChecked = (action) => {
    return PERMISSION_ROWS.some((row) => permissions[row.key]?.[action]) && !isColAllChecked(action);
  };

  const handleSavePermissions = async () => {
    if (!selectedRole) return;
    setSaving(true);
    try {
      const permArray = [];
      PERMISSION_ROWS.forEach((mod) => {
        const actions = [];
        PERMISSION_ACTIONS.forEach((act) => {
          if (permissions[mod.key]?.[act.key]) {
            actions.push(act.key);
          }
        });
        if (actions.length > 0) {
          permArray.push({ module: mod.key, actions });
        }
      });
      PERMISSION_MODULES.forEach((mod) => {
        const childActions = new Set();
        (mod.children || []).forEach((child) => {
          PERMISSION_ACTIONS.forEach((act) => {
            if (permissions[child.key]?.[act.key]) childActions.add(act.key);
          });
        });
        if (childActions.size > 0 && !permArray.some((p) => p.module === mod.key)) {
          permArray.push({ module: mod.key, actions: Array.from(childActions) });
        }
      });
      await api.put(`/settings/roles/${selectedRole.id}/permissions`, { permissions: permArray });
      message.success('Permissions saved successfully');
      // BUG-AUTH-089 fix: refetch the canonical permission set from the
      // server. Without this, the UI keeps the in-memory checkbox state and
      // any backend-side adjustments (e.g. permissions silently dropped
      // because a code was unknown) are invisible until the page is reloaded.
      fetchPermissions(selectedRole.id);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader title="Roles & Permissions" subtitle="Manage roles and their access permissions" />

      <Row gutter={16}>
        {/* Left Panel: Roles List */}
        <Col xs={24} lg={7}>
          <Card
            title="Roles"
            size="small"
            extra={
              <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleAddRole}>
                Add Role
              </Button>
            }
          >
            <Spin spinning={loading}>
              <List
                size="small"
                dataSource={roles}
                renderItem={(role) => (
                  <List.Item
                    key={role.id}
                    onClick={() => handleSelectRole(role)}
                    style={{
                      cursor: 'pointer',
                      backgroundColor: selectedRole?.id === role.id ? '#e6f7ff' : undefined,
                      padding: '8px 12px',
                      borderLeft: selectedRole?.id === role.id ? '3px solid #eb2f96' : '3px solid transparent',
                    }}
                    actions={[
                      <Button
                        key="edit"
                        type="text"
                        size="small"
                        icon={<EditOutlined />}
                        onClick={(e) => { e.stopPropagation(); handleEditRole(role); }}
                      />,
                      <Popconfirm
                        key="delete"
                        title="Delete this role?"
                        onConfirm={(e) => { e?.stopPropagation(); handleDeleteRole(role.id); }}
                        okText="Delete"
                        okButtonProps={{ danger: true }}
                      >
                        <Button
                          type="text"
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </Popconfirm>,
                    ]}
                  >
                    <List.Item.Meta
                      title={<Text strong={selectedRole?.id === role.id}>{role.name}</Text>}
                      description={<Text type="secondary" style={{ fontSize: 12 }}>{role.description || 'No description'}</Text>}
                    />
                  </List.Item>
                )}
                locale={{ emptyText: 'No roles found' }}
              />
            </Spin>
          </Card>
        </Col>

        {/* Right Panel: Permission Matrix */}
        <Col xs={24} lg={17}>
          <Card
            title={selectedRole ? `Permissions: ${selectedRole.name}` : 'Select a role'}
            size="small"
            extra={
              selectedRole && (
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  onClick={handleSavePermissions}
                  loading={saving}
                >
                  Save Changes
                </Button>
              )
            }
          >
            <Spin spinning={permissionsLoading}>
              {selectedRole ? (
                <div style={{ overflowX: 'auto' }}>
                  <table className="permissions-table" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: '12px 12px', borderBottom: '2px solid #f0f0f0', width: 260, fontWeight: 600 }}>
                          Module / Tab
                        </th>
                        {PERMISSION_ACTIONS.map((act) => (
                          <th key={act.key} style={{ textAlign: 'center', padding: '12px 12px', borderBottom: '2px solid #f0f0f0', fontWeight: 600, minWidth: 80 }}>
                            <div style={{ marginBottom: 6 }}>{act.label}</div>
                            <Checkbox
                              checked={isColAllChecked(act.key)}
                              indeterminate={isColSomeChecked(act.key)}
                              onChange={(e) => handleSelectAllColumn(act.key, e.target.checked)}
                              style={{ fontSize: 11 }}
                            />
                          </th>
                        ))}
                        <th style={{ textAlign: 'center', padding: '12px 12px', borderBottom: '2px solid #f0f0f0', fontWeight: 600, minWidth: 80 }}>
                          Select All
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <style>{`
                        .permissions-table {
                          width: 100%;
                          border-collapse: separate !important;
                          border-spacing: 0;
                        }
                        .permissions-module-title-cell {
                          transition: all 0.2s ease;
                        }
                        .permissions-module-title-cell.clickable:hover {
                          background-color: #fdf2f4;
                          color: #D80048;
                        }
                        .permissions-module-title-cell.clickable:hover .anticon {
                          color: #D80048 !important;
                        }
                        
                        /* Premium Checkbox overrides to eliminate circular shape & elevate visibility */
                        .permissions-table .ant-checkbox-inner {
                          width: 18px !important;
                          height: 18px !important;
                          border: 1.8px solid #c1a8b0 !important; /* High contrast brand-tinted outline */
                          border-radius: 4px !important; /* Clean modern rounded-square instead of complete circle */
                          background-color: #ffffff !important;
                          transition: all 0.2s cubic-bezier(0.12, 0.4, 0.29, 1.46) !important;
                        }
                        
                        /* Micro-scale and color feedback on hover */
                        .permissions-table .ant-checkbox-wrapper:hover .ant-checkbox-inner,
                        .permissions-table .ant-checkbox:hover .ant-checkbox-inner {
                          border-color: #b70051 !important;
                          background-color: #fff5f8 !important;
                          box-shadow: 0 0 0 3px rgba(183, 0, 81, 0.15) !important;
                          transform: scale(1.08);
                        }
                        
                        /* Solid filled active state */
                        .permissions-table .ant-checkbox-checked .ant-checkbox-inner {
                          background-color: #b70051 !important;
                          border-color: #b70051 !important;
                        }
                        
                        /* Crisp checkmark scaling inside the checkbox */
                        .permissions-table .ant-checkbox-checked .ant-checkbox-inner::after {
                          width: 5.5px !important;
                          height: 9.5px !important;
                          border: 2px solid #ffffff !important;
                          border-top: 0 !important;
                          border-left: 0 !important;
                          left: 4.25px !important;
                          top: 0.75px !important;
                        }
                        
                        /* Premium Indeterminate styling */
                        .permissions-table .ant-checkbox-indeterminate .ant-checkbox-inner {
                          background-color: #ffffff !important;
                          border-color: #b70051 !important;
                        }
                        .permissions-table .ant-checkbox-indeterminate .ant-checkbox-inner::after {
                          background-color: #b70051 !important;
                          height: 3px !important;
                          border-radius: 1px !important;
                        }
                        
                        /* Premium row highlight backdrops */
                        .permissions-table tbody tr {
                          transition: background-color 0.15s ease;
                        }
                        .permissions-table tbody tr:hover {
                          background-color: #fcf6f8 !important; /* Gentle brand-pink tint across the row */
                        }
                        
                        /* Indent secondary hover cell background to guide user selection visually */
                        .permissions-table tbody td:not(.permissions-module-title-cell) {
                          transition: background-color 0.15s ease;
                        }
                        .permissions-table tbody td:not(.permissions-module-title-cell):hover {
                          background-color: rgba(183, 0, 81, 0.05) !important;
                        }
                      `}</style>
                      {visibleRows.map((mod, idx) => {
                        const hasChildren = mod.children && mod.children.length > 0;
                        const isExpanded = !!expandedModules[mod.key];
                        return (
                          <tr key={mod.key} style={{ backgroundColor: idx % 2 === 0 ? '#fafafa' : '#fff' }}>
                            <td
                                className={`permissions-module-title-cell ${mod.level === 0 && hasChildren ? 'clickable' : ''}`}
                                onClick={mod.level === 0 && hasChildren ? () => toggleModule(mod.key) : undefined}
                                style={{
                                  padding: mod.level === 0 ? '12px 12px' : '9px 12px 9px 32px',
                                  borderBottom: '1px solid #f0f0f0',
                                  fontWeight: mod.level === 0 ? 600 : 400,
                                  color: mod.level === 0 ? undefined : 'rgba(0,0,0,0.72)',
                                  cursor: mod.level === 0 && hasChildren ? 'pointer' : 'default',
                                  userSelect: 'none',
                                }}
                            >
                              {mod.level === 0 && hasChildren ? (
                                isExpanded ? (
                                  <DownOutlined style={{ marginRight: 8, fontSize: 10, color: 'rgba(0,0,0,0.45)', verticalAlign: 'middle' }} />
                                ) : (
                                  <RightOutlined style={{ marginRight: 8, fontSize: 10, color: 'rgba(0,0,0,0.45)', verticalAlign: 'middle' }} />
                                )
                              ) : null}
                              {mod.level === 1 ? (
                                <span>
                                  <span style={{ color: 'rgba(0,0,0,0.35)', marginRight: 8 }}>-</span>
                                  {mod.label}
                                </span>
                              ) : (
                                <span style={{ verticalAlign: 'middle' }}>{mod.label}</span>
                              )}
                            </td>
                            {PERMISSION_ACTIONS.map((act) => (
                              <td key={act.key} style={{ textAlign: 'center', padding: 0, borderBottom: '1px solid #f0f0f0' }}>
                                <Checkbox
                                  checked={permissions[mod.key]?.[act.key] || false}
                                  onChange={(e) => handlePermissionChange(mod.key, act.key, e.target.checked)}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    width: '100%',
                                    height: '100%',
                                    padding: '12px 8px',
                                    cursor: 'pointer',
                                  }}
                                />
                              </td>
                            ))}
                            <td style={{ textAlign: 'center', padding: 0, borderBottom: '1px solid #f0f0f0' }}>
                              <Checkbox
                                checked={isRowAllChecked(mod.key)}
                                indeterminate={isRowSomeChecked(mod.key)}
                                onChange={(e) => handleSelectAllRow(mod.key, e.target.checked)}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  width: '100%',
                                  height: '100%',
                                  padding: '12px 8px',
                                  cursor: 'pointer',
                                }}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: 60, color: '#999' }}>
                  Select a role from the left panel to manage its permissions
                </div>
              )}
            </Spin>
          </Card>
        </Col>
      </Row>

      {/* Add/Edit Role Modal */}
      <Modal
        title={editingRole ? 'Edit Role' : 'Add Role'}
        open={roleModal}
        onCancel={() => { setRoleModal(false); setEditingRole(null); form.resetFields(); }}
        onOk={handleRoleSubmit}
        okText={editingRole ? 'Update' : 'Create'}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Role Name" rules={[{ required: true, message: 'Role name is required' }]}>
            <Input placeholder="e.g. Warehouse Manager" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} placeholder="Describe this role" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Roles;

