import React, { useState, useEffect } from 'react';
import {
  Button, Modal, Drawer, Form, Input, Select, Space, Popconfirm, message, Tabs, Tag, Divider, Switch,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, TeamOutlined, SafetyOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const ENTITY_TYPES = [
  { label: 'Item Category', value: 'item_category' },
  { label: 'Item', value: 'item' },
  { label: 'UOM', value: 'uom' },
  { label: 'Warehouse', value: 'warehouse' },
  { label: 'Indent Type', value: 'indent_type' },
];
const ACTIONS = [
  { label: 'View', value: 'view' },
  { label: 'Create', value: 'create' },
  { label: 'Approve', value: 'approve' },
  { label: 'Indent', value: 'indent' },
  { label: 'Consume', value: 'consume' },
];

const UserGroups = () => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRow, setEditingRow] = useState(null);
  const [form] = Form.useForm();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeGroup, setActiveGroup] = useState(null);
  const [members, setMembers] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [users, setUsers] = useState([]);

  const fetchRows = async () => {
    setLoading(true);
    try {
      const res = await api.get('/masters/user-groups');
      setRows(res.data || []);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchRows(); }, []);

  const loadUsers = async () => {
    try {
      // BUG-FE-082: filter to active users so deactivated accounts don't show
      // up in the picker (they can't act on the group anyway).
      const res = await api.get('/users', { params: { page_size: 500, is_active: true } });
      const items = res.data?.items || res.data?.data || res.data || [];
      setUsers(items.map((u) => ({
        // BUG-FE-137: drop the trailing " · " when email is missing — users
        // without emails were showing as "alice · " which looks broken.
        label: u.email ? `${u.username} · ${u.email}` : u.username,
        value: u.id,
      })));
    } catch { /* silent */ }
  };

  const handleAdd = () => {
    setEditingRow(null);
    form.resetFields();
    form.setFieldsValue({ is_active: true });
    setModalOpen(true);
  };

  const handleEdit = (r) => {
    setEditingRow(r);
    form.setFieldsValue(r);
    setModalOpen(true);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/masters/user-groups/${id}`);
      message.success('Group deactivated');
      fetchRows();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (editingRow) {
        await api.put(`/masters/user-groups/${editingRow.id}`, values);
        message.success('Group updated');
      } else {
        await api.post('/masters/user-groups', values);
        message.success('Group created');
      }
      setModalOpen(false);
      fetchRows();
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    }
  };

  const openGroupDrawer = async (record) => {
    setActiveGroup(record);
    setDrawerOpen(true);
    await loadUsers();
    try {
      const [mRes, pRes] = await Promise.all([
        api.get(`/masters/user-groups/${record.id}/members`),
        api.get(`/masters/user-groups/${record.id}/permissions`),
      ]);
      setMembers(mRes.data || []);
      setPermissions(pRes.data || []);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const saveMembers = async (userIds) => {
    try {
      await api.put(`/masters/user-groups/${activeGroup.id}/members`, { user_ids: userIds });
      message.success('Members saved');
      const res = await api.get(`/masters/user-groups/${activeGroup.id}/members`);
      setMembers(res.data || []);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const savePermissions = async (nextPermissions) => {
    // BUG-FE-080: refuse rows whose entity_id refers to a non-existent
    // entity. We can only check positive integers locally — let the server
    // do the FK lookup if available, but at least reject obvious garbage so
    // the user gets feedback before the round-trip.
    for (const p of nextPermissions) {
      if (p.entity_id != null && (!Number.isInteger(Number(p.entity_id)) || Number(p.entity_id) <= 0)) {
        message.error(`Invalid entity_id "${p.entity_id}" for ${p.entity_type}`);
        return;
      }
      if (!p.entity_type) {
        message.error('Each permission needs an entity type');
        return;
      }
      if (!p.action) {
        message.error('Each permission needs an action');
        return;
      }
    }
    try {
      await api.put(
        `/masters/user-groups/${activeGroup.id}/permissions`,
        nextPermissions.map((p) => ({
          entity_type: p.entity_type,
          entity_id: p.entity_id != null && p.entity_id !== '' ? Number(p.entity_id) : null,
          action: p.action,
        })),
      );
      message.success('Permissions saved');
      const res = await api.get(`/masters/user-groups/${activeGroup.id}/permissions`);
      setPermissions(res.data || []);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  return (
    <div>
      <PageHeader title="User Groups" subtitle="Logical groups (e.g. AP-108-ERC, AP-108-OPS) + member & permission mapping">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Add Group</Button>
      </PageHeader>

      <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
        <thead>
          <tr>
            {['#', 'Code', 'Name', 'Description', 'Active', 'Actions'].map((h) => (
              <th key={h} style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #eee' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={6} style={{ padding: 12 }}>Loading...</td></tr>}
          {!loading && rows.length === 0 && <tr><td colSpan={6} style={{ padding: 12 }}>No groups yet.</td></tr>}
          {rows.map((r, i) => (
            <tr key={r.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
              <td style={{ padding: 8 }}>{i + 1}</td>
              <td style={{ padding: 8 }}><code>{r.code}</code></td>
              <td style={{ padding: 8 }}>{r.name}</td>
              <td style={{ padding: 8 }}>{r.description || '-'}</td>
              <td style={{ padding: 8 }}><StatusTag status={r.is_active ? 'active' : 'inactive'} /></td>
              <td style={{ padding: 8 }}>
                <Space>
                  <Button size="small" icon={<TeamOutlined />} onClick={() => openGroupDrawer(r)}>Members & Perms</Button>
                  <Button size="small" icon={<EditOutlined />} onClick={() => handleEdit(r)} />
                  <Popconfirm title="Deactivate?" onConfirm={() => handleDelete(r.id)}>
                    <Button size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Modal
        title={editingRow ? 'Edit Group' : 'Add Group'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="code" label="Code" rules={[{ required: true, message: 'Code is required' }]}>
            <Input placeholder="e.g. AP-108-ERC" />
          </Form.Item>
          <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="e.g. Andhra Pradesh - 108 Emergency Response Center" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
          {/* BUG-FE-078: expose Active toggle so users can re-activate or
              deactivate a group from the same modal. */}
          <Form.Item name="is_active" label="Active" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={activeGroup ? `${activeGroup.code} · ${activeGroup.name}` : 'Group'}
        open={drawerOpen}
        width={720}
        onClose={() => setDrawerOpen(false)}
        destroyOnHidden
      >
        <Tabs
          items={[
            {
              key: 'members',
              label: <span><TeamOutlined /> Members ({members.length})</span>,
              children: (
                <MemberEditor
                  users={users}
                  currentUserIds={members.map((m) => m.user_id)}
                  onSave={saveMembers}
                />
              ),
            },
            {
              key: 'perms',
              label: <span><SafetyOutlined /> Permissions ({permissions.length})</span>,
              children: (
                <PermissionEditor
                  permissions={permissions}
                  onSave={savePermissions}
                />
              ),
            },
          ]}
        />
      </Drawer>
    </div>
  );
};


const MemberEditor = ({ users, currentUserIds, onSave }) => {
  const [selected, setSelected] = useState(currentUserIds);
  // BUG-FE-079: dep on `currentUserIds.join(',')` re-allocates the same string
  // identity every render, so the effect re-fires unnecessarily. Use a stable
  // signature derived from sorted ids instead.
  const sig = [...currentUserIds].sort().join(',');
  useEffect(() => { setSelected(currentUserIds); }, [sig]);
  return (
    <div>
      <Select
        mode="multiple"
        options={users}
        value={selected}
        onChange={setSelected}
        style={{ width: '100%' }}
        showSearch
        optionFilterProp="label"
        placeholder="Select users..."
        maxTagCount={10}
      />
      <div style={{ marginTop: 16 }}>
        <Button type="primary" onClick={() => onSave(selected)}>Save Members</Button>
      </div>
    </div>
  );
};


const PermissionEditor = ({ permissions, onSave }) => {
  const [rows, setRows] = useState(permissions);
  // BUG-FE-081: dep was `permissions.length` so swapping a row's
  // entity_type/action without changing length would keep stale state.
  // Use a stable signature of the contents instead.
  const sig = JSON.stringify(
    permissions.map((p) => `${p.entity_type}|${p.entity_id ?? ''}|${p.action}`)
  );
  useEffect(() => { setRows(permissions); }, [sig]);

  const add = () => setRows([...rows, { entity_type: 'item_category', entity_id: null, action: 'view' }]);
  const remove = (i) => setRows(rows.filter((_, idx) => idx !== i));
  const update = (i, key, v) => setRows(rows.map((r, idx) => idx === i ? { ...r, [key]: v } : r));

  return (
    <div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Entity Type', 'Entity Id (blank = all)', 'Action', ''].map((h) => (
              <th key={h} style={{ padding: 8, textAlign: 'left', borderBottom: '1px solid #eee' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td style={{ padding: 4 }}>
                <Select
                  value={r.entity_type}
                  options={ENTITY_TYPES}
                  onChange={(v) => update(i, 'entity_type', v)}
                  style={{ width: '100%' }}
                />
              </td>
              <td style={{ padding: 4 }}>
                <Input
                  type="number"
                  value={r.entity_id ?? ''}
                  onChange={(e) => update(i, 'entity_id', e.target.value ? Number(e.target.value) : null)}
                  placeholder="all"
                />
              </td>
              <td style={{ padding: 4 }}>
                <Select
                  value={r.action}
                  options={ACTIONS}
                  onChange={(v) => update(i, 'action', v)}
                  style={{ width: '100%' }}
                />
              </td>
              <td style={{ padding: 4 }}>
                <Button danger size="small" onClick={() => remove(i)}>Remove</Button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={4} style={{ padding: 12 }}>No permissions — click "Add Row".</td></tr>}
        </tbody>
      </table>
      <Divider />
      <Space>
        <Button icon={<PlusOutlined />} onClick={add}>Add Row</Button>
        <Button type="primary" onClick={() => onSave(rows)}>Save Permissions</Button>
      </Space>
    </div>
  );
};


export default UserGroups;

