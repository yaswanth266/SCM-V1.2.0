import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, Switch, Card,
  Popconfirm, message, Row, Col, Table, Divider, Typography, Tooltip, Tag,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, MinusCircleOutlined,
  ArrowUpOutlined, ArrowDownOutlined, CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const { Text } = Typography;

const MODULE_OPTIONS = [
  { label: 'Procurement', value: 'procurement' },
  { label: 'Indent', value: 'indent' },
  { label: 'Warehouse', value: 'warehouse' },
];

const DOC_TYPE_MAP = {
  procurement: [
    { label: 'Material Request', value: 'material_request' },
    { label: 'Purchase Order', value: 'purchase_order' },
    { label: 'Quotation', value: 'quotation' },
    { label: 'Auto Reorder', value: 'auto_reorder' },
  ],
  indent: [
    { label: 'Indent', value: 'indent' },
    { label: 'Indent Return', value: 'indent_return' },
  ],
  warehouse: [
    { label: 'Stock Transfer', value: 'stock_transfer' },
    { label: 'GRN', value: 'grn' },
    { label: 'Stock Adjustment', value: 'stock_adjustment' },
  ],
};

const WorkflowConfig = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Approval levels
  const [levels, setLevels] = useState([]);

  // Lookups
  const [roles, setRoles] = useState([]);
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [docTypeOptions, setDocTypeOptions] = useState([]);

  // Selected module for filtering doc types
  const [selectedModule, setSelectedModule] = useState(null);

  const loadLookups = useCallback(async () => {
    try {
      const [rolesRes, usersRes, projRes] = await Promise.allSettled([
        api.get('/settings/roles', { params: { page_size: 200 } }),
        api.get('/settings/users', { params: { page_size: 200, is_active: true } }),
        api.get('/masters/projects', { params: { page_size: 200 } }),
      ]);
      if (rolesRes.status === 'fulfilled') {
        const d = rolesRes.value.data;
        const items = d.items || d.data || d || [];
        setRoles(items.map((r) => ({ label: r.name || r.role_name, value: r.id || r.name })));
      }
      if (usersRes.status === 'fulfilled') {
        const d = usersRes.value.data;
        const items = d.items || d.data || d || [];
        // BUG-MISC-022 — backend User model has first_name/last_name, not
        // full_name. The previous label always fell back to username because
        // full_name was undefined.
        setUsers(items.map((u) => {
          const composed = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
          const display = u.full_name || composed || u.name || u.username;
          return {
            label: `${display} (${u.email || ''})`,
            value: u.id,
          };
        }));
      }
      if (projRes.status === 'fulfilled') {
        const d = projRes.value.data;
        const items = d.items || d.data || d || [];
        setProjects(items.map((p) => ({ label: p.name || p.project_name, value: p.id })));
      }
    } catch {
      // silent
    }
  }, []);

  const fetchWorkflows = useCallback(
    async (params) => {
      return await api.get('/approvals/workflows', { params });
    },
    []
  );

  const createEmptyLevel = (levelNum) => ({
    key: Date.now() + Math.random(),
    level_number: levelNum || 1,
    approver_type: 'role', // role or user
    approver_role: null,
    approver_user: null,
    min_amount: 0,
    max_amount: null,
    auto_approve_after_days: null,
    send_email: true,
    send_notification: true,
    // Wave 1-4 additions — exposed via the "Advanced" expand row.
    requires_all: false,
    escalation_user_id: null,
    escalation_after_hours: 0,
    department: null,
    category: null,
    request_type: null,
    condition_json: null,
  });

  const handleAdd = () => {
    setEditingWorkflow(null);
    setSelectedModule(null);
    setDocTypeOptions([]);
    form.resetFields();
    setLevels([createEmptyLevel(1)]);
    loadLookups();
    setDrawerOpen(true);
  };

  const handleEdit = async (record) => {
    setEditingWorkflow(record);
    loadLookups();
    try {
      const res = await api.get(`/approvals/workflows/${record.id}`);
      const data = res.data;

      const mod = data.module;
      setSelectedModule(mod);
      setDocTypeOptions(DOC_TYPE_MAP[mod] || []);

      form.setFieldsValue({
        name: data.name,
        module: data.module,
        document_type: data.document_type,
        project_id: data.project_id,
      });

      const wfLevels = (data.levels || data.approval_levels || []).map((lvl, idx) => ({
        key: lvl.id || Date.now() + idx,
        level_number: lvl.level_number || lvl.level || lvl.sequence || idx + 1,
        approver_type: lvl.approver_user || lvl.approver_user_id ? 'user' : 'role',
        approver_role: lvl.approver_role || lvl.approver_role_id || null,
        approver_user: lvl.approver_user || lvl.approver_user_id || null,
        min_amount: lvl.min_amount || 0,
        max_amount: lvl.max_amount || null,
        auto_approve_after_days: lvl.auto_approve_after_days || null,
        send_email: lvl.send_email !== false,
        send_notification: lvl.send_notification !== false,
        // Wave 1-4 fields
        requires_all: !!lvl.requires_all,
        escalation_user_id: lvl.escalation_user_id || null,
        escalation_after_hours: lvl.escalation_after_hours || 0,
        department: lvl.department || null,
        category: lvl.category || null,
        request_type: lvl.request_type || null,
        condition_json: lvl.condition_json || null,
      }));
      setLevels(wfLevels.length > 0 ? wfLevels : [createEmptyLevel(1)]);
    } catch (err) {
      message.error(getErrorMessage(err));
      return;
    }
    setDrawerOpen(true);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/approvals/workflows/${id}`);
      message.success('Workflow deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleToggleActive = async (record) => {
    try {
      await api.put(`/approvals/workflows/${record.id}`, {
        is_active: !record.is_active,
      });
      message.success(`Workflow ${record.is_active ? 'deactivated' : 'activated'}`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleModuleChange = (mod) => {
    setSelectedModule(mod);
    setDocTypeOptions(DOC_TYPE_MAP[mod] || []);
    form.setFieldsValue({ document_type: undefined });
  };

  // Level management
  const addLevel = () => {
    const nextNum = levels.length > 0 ? Math.max(...levels.map((l) => l.level_number)) + 1 : 1;
    setLevels((prev) => [...prev, createEmptyLevel(nextNum)]);
  };

  const removeLevel = (key) => {
    setLevels((prev) => {
      const filtered = prev.filter((l) => l.key !== key);
      // Re-number levels
      return filtered.map((l, idx) => ({ ...l, level_number: idx + 1 }));
    });
  };

  const updateLevel = (key, field, value) => {
    setLevels((prev) =>
      prev.map((l) => {
        if (l.key !== key) return l;
        const updated = { ...l, [field]: value };
        // Reset role/user when type changes
        if (field === 'approver_type') {
          updated.approver_role = null;
          updated.approver_user = null;
        }
        return updated;
      })
    );
  };

  const moveLevelUp = (index) => {
    if (index === 0) return;
    setLevels((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next.map((l, idx) => ({ ...l, level_number: idx + 1 }));
    });
  };

  const moveLevelDown = (index) => {
    if (index >= levels.length - 1) return;
    setLevels((prev) => {
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next.map((l, idx) => ({ ...l, level_number: idx + 1 }));
    });
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (levels.length === 0) {
        message.error('Please add at least one approval level');
        return;
      }

      // Validate levels
      for (let i = 0; i < levels.length; i++) {
        const lvl = levels[i];
        if (lvl.approver_type === 'role' && !lvl.approver_role) {
          message.error(`Level ${i + 1}: Please select an approver role`);
          return;
        }
        if (lvl.approver_type === 'user' && !lvl.approver_user) {
          message.error(`Level ${i + 1}: Please select an approver user`);
          return;
        }
      }

      setSubmitting(true);

      const payload = {
        ...values,
        is_active: true,
        levels: levels.map((lvl) => ({
          level_number: lvl.level_number,
          level: lvl.level_number,  // backend accepts both shapes; send both for safety
          approver_role: lvl.approver_type === 'role' ? lvl.approver_role : null,
          approver_user: lvl.approver_type === 'user' ? lvl.approver_user : null,
          approver_role_id: lvl.approver_type === 'role' ? lvl.approver_role : null,
          approver_user_id: lvl.approver_type === 'user' ? lvl.approver_user : null,
          min_amount: lvl.min_amount || 0,
          max_amount: lvl.max_amount || null,
          auto_approve_after_days: lvl.auto_approve_after_days || null,
          send_email: lvl.send_email,
          send_notification: lvl.send_notification,
          // Wave 1-4 — passed through to the engine
          requires_all: !!lvl.requires_all,
          escalation_user_id: lvl.escalation_user_id || null,
          escalation_after_hours: lvl.escalation_after_hours || 0,
          department: lvl.department || null,
          category: lvl.category || null,
          request_type: lvl.request_type || null,
          condition_json: lvl.condition_json || null,
        })),
      };

      if (editingWorkflow) {
        await api.put(`/approvals/workflows/${editingWorkflow.id}`, payload);
        message.success('Workflow updated');
      } else {
        await api.post('/approvals/workflows', payload);
        message.success('Workflow created');
      }

      setDrawerOpen(false);
      form.resetFields();
      setEditingWorkflow(null);
      setLevels([]);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const levelColumns = [
    {
      title: 'Level',
      width: 55,
      align: 'center',
      render: (_, record) => (
        <Tag color="blue">{record.level_number}</Tag>
      ),
    },
    {
      title: 'Approver Type',
      width: 120,
      dataIndex: 'approver_type',
      render: (val, record) => (
        <Select
          value={val}
          onChange={(v) => updateLevel(record.key, 'approver_type', v)}
          style={{ width: '100%' }}
          size="small"
          options={[
            { label: 'By Role', value: 'role' },
            { label: 'By User', value: 'user' },
          ]}
        />
      ),
    },
    {
      title: 'Approver',
      width: 200,
      render: (_, record) =>
        record.approver_type === 'role' ? (
          <Select
            value={record.approver_role}
            onChange={(v) => updateLevel(record.key, 'approver_role', v)}
            options={roles}
            placeholder="Select role"
            showSearch
            optionFilterProp="label"
            allowClear
            style={{ width: '100%' }}
            size="small"
          />
        ) : (
          <Select
            value={record.approver_user}
            onChange={(v) => updateLevel(record.key, 'approver_user', v)}
            options={users}
            placeholder="Select user"
            showSearch
            optionFilterProp="label"
            allowClear
            style={{ width: '100%' }}
            size="small"
          />
        ),
    },
    {
      title: 'Min Amount',
      dataIndex: 'min_amount',
      width: 110,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateLevel(record.key, 'min_amount', v)}
          style={{ width: '100%' }}
          size="small"
          formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
          parser={(v) => v.replace(/,/g, '')}
        />
      ),
    },
    {
      title: 'Max Amount',
      dataIndex: 'max_amount',
      width: 110,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateLevel(record.key, 'max_amount', v)}
          style={{ width: '100%' }}
          size="small"
          placeholder="Unlimited"
          formatter={(v) => v ? `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''}
          parser={(v) => v.replace(/,/g, '')}
        />
      ),
    },
    {
      title: 'Auto-Approve (days)',
      dataIndex: 'auto_approve_after_days',
      width: 130,
      render: (val, record) => (
        <InputNumber
          min={0}
          max={365}
          value={val}
          onChange={(v) => updateLevel(record.key, 'auto_approve_after_days', v)}
          style={{ width: '100%' }}
          size="small"
          placeholder="Never"
        />
      ),
    },
    {
      title: 'Email',
      dataIndex: 'send_email',
      width: 65,
      align: 'center',
      render: (val, record) => (
        <Switch
          size="small"
          checked={val}
          onChange={(v) => updateLevel(record.key, 'send_email', v)}
        />
      ),
    },
    {
      title: 'Notify',
      dataIndex: 'send_notification',
      width: 65,
      align: 'center',
      render: (val, record) => (
        <Switch
          size="small"
          checked={val}
          onChange={(v) => updateLevel(record.key, 'send_notification', v)}
        />
      ),
    },
    {
      title: '',
      width: 90,
      render: (_, record, index) => (
        <Space size="small">
          <Tooltip title="Move Up">
            <Button
              type="text"
              size="small"
              icon={<ArrowUpOutlined />}
              disabled={index === 0}
              onClick={() => moveLevelUp(index)}
            />
          </Tooltip>
          <Tooltip title="Move Down">
            <Button
              type="text"
              size="small"
              icon={<ArrowDownOutlined />}
              disabled={index >= levels.length - 1}
              onClick={() => moveLevelDown(index)}
            />
          </Tooltip>
          {levels.length > 1 && (
            <MinusCircleOutlined
              style={{ color: '#ff4d4f', cursor: 'pointer' }}
              onClick={() => removeLevel(record.key)}
            />
          )}
        </Space>
      ),
    },
  ];

  const columns = [
    {
      title: 'Workflow Name',
      dataIndex: 'name',
      key: 'name',
      width: 220,
      sorter: true,
      render: (text, record) => (
        <a onClick={() => handleEdit(record)}>{text}</a>
      ),
    },
    {
      title: 'Module',
      dataIndex: 'module',
      key: 'module',
      width: 140,
      render: (val) => (
        <Tag color="blue">
          {(val || '').charAt(0).toUpperCase() + (val || '').slice(1)}
        </Tag>
      ),
    },
    {
      title: 'Document Type',
      dataIndex: 'document_type',
      key: 'document_type',
      width: 180,
      render: (val) => (val || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    },
    {
      title: 'Project',
      dataIndex: 'project_name',
      key: 'project',
      width: 160,
      ellipsis: true,
      render: (val) => val || '-',
    },
    {
      title: 'Levels',
      key: 'levels_count',
      width: 80,
      align: 'center',
      render: (_, record) => (
        <Tag color="geekblue">{record.levels_count || record.levels?.length || 0}</Tag>
      ),
    },
    {
      title: 'Active',
      dataIndex: 'is_active',
      key: 'is_active',
      width: 100,
      align: 'center',
      render: (val, record) => (
        <Switch
          checked={val}
          onChange={() => handleToggleActive(record)}
          checkedChildren={<CheckCircleOutlined />}
          unCheckedChildren={<CloseCircleOutlined />}
        />
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 140,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="Edit">
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          </Tooltip>
          <Popconfirm
            title="Delete this workflow?"
            onConfirm={() => handleDelete(record.id)}
            okButtonProps={{ danger: true }}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Workflow Configuration" subtitle="Manage approval workflows and levels">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          Create Workflow
        </Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchWorkflows}
        rowKey="id"
        searchPlaceholder="Search by workflow name, module..."
        exportFileName="approval_workflows"
        scroll={{ x: 1100 }}
      />

      {/* Create / Edit Drawer */}
      <Drawer
        title={editingWorkflow ? `Edit Workflow: ${editingWorkflow.name}` : 'Create Approval Workflow'}
        width={1050}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setEditingWorkflow(null);
          form.resetFields();
          setLevels([]);
          setSelectedModule(null);
        }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); setEditingWorkflow(null); form.resetFields(); setLevels([]); }}>
              Cancel
            </Button>
            <Button type="primary" onClick={handleSubmit} loading={submitting}>
              {editingWorkflow ? 'Update Workflow' : 'Create Workflow'}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="name"
                label="Workflow Name"
                rules={[{ required: true, message: 'Required' }]}
              >
                <Input placeholder="e.g. PO Approval > 50K" />
              </Form.Item>
            </Col>
            <Col span={5}>
              <Form.Item
                name="module"
                label="Module"
                rules={[{ required: true, message: 'Required' }]}
              >
                <Select
                  options={MODULE_OPTIONS}
                  placeholder="Select module"
                  onChange={handleModuleChange}
                />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                name="document_type"
                label="Document Type"
                rules={[{ required: true, message: 'Required' }]}
              >
                <Select
                  options={docTypeOptions}
                  placeholder={selectedModule ? 'Select document type' : 'Select module first'}
                  disabled={!selectedModule}
                />
              </Form.Item>
            </Col>
            <Col span={5}>
              <Form.Item name="project_id" label="Project (Optional)">
                <Select
                  options={projects}
                  placeholder="All projects"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                />
              </Form.Item>
            </Col>
          </Row>
        </Form>

        <Divider orientation="left">Approval Levels</Divider>

        <Table
          dataSource={levels}
          columns={levelColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 1000 }}
          expandable={{
            expandRowByClick: false,
            rowExpandable: () => true,
            expandedRowRender: (record) => (
              <div style={{
                padding: '12px 16px',
                background: '#FBF7F4',
                borderRadius: 8,
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: 12,
              }}>
                <div>
                  <div style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: '#7A6D66',
                    textTransform: 'uppercase',
                    letterSpacing: '.06em',
                    marginBottom: 4,
                  }}>Parallel approvers</div>
                  <Switch
                    checked={!!record.requires_all}
                    onChange={(v) => updateLevel(record.key, 'requires_all', v)}
                  />
                  <span style={{ marginLeft: 8, fontSize: 12, color: '#54463F' }}>
                    {record.requires_all
                      ? 'ALL eligible approvers must approve'
                      : 'First approver wins'}
                  </span>
                </div>

                <div>
                  <div style={{
                    fontSize: 11, fontWeight: 700, color: '#7A6D66',
                    textTransform: 'uppercase', letterSpacing: '.06em',
                    marginBottom: 4,
                  }}>Escalate to (after SLA)</div>
                  <Select
                    value={record.escalation_user_id}
                    onChange={(v) => updateLevel(record.key, 'escalation_user_id', v)}
                    options={users}
                    placeholder="No fallback approver"
                    showSearch
                    optionFilterProp="label"
                    allowClear
                    style={{ width: '100%' }}
                    size="small"
                  />
                </div>

                <div>
                  <div style={{
                    fontSize: 11, fontWeight: 700, color: '#7A6D66',
                    textTransform: 'uppercase', letterSpacing: '.06em',
                    marginBottom: 4,
                  }}>SLA (hours)</div>
                  <InputNumber
                    min={0}
                    max={720}
                    value={record.escalation_after_hours}
                    onChange={(v) => updateLevel(record.key, 'escalation_after_hours', v || 0)}
                    placeholder="0 = no SLA"
                    style={{ width: '100%' }}
                    size="small"
                  />
                </div>

                <div>
                  <div style={{
                    fontSize: 11, fontWeight: 700, color: '#7A6D66',
                    textTransform: 'uppercase', letterSpacing: '.06em',
                    marginBottom: 4,
                  }}>Department filter</div>
                  <Input
                    value={record.department || ''}
                    onChange={(e) => updateLevel(record.key, 'department', e.target.value || null)}
                    placeholder="e.g. MMU-Krishna"
                    size="small"
                  />
                </div>

                <div>
                  <div style={{
                    fontSize: 11, fontWeight: 700, color: '#7A6D66',
                    textTransform: 'uppercase', letterSpacing: '.06em',
                    marginBottom: 4,
                  }}>Category filter</div>
                  <Input
                    value={record.category || ''}
                    onChange={(e) => updateLevel(record.key, 'category', e.target.value || null)}
                    placeholder="e.g. drug, equipment"
                    size="small"
                  />
                </div>

                <div>
                  <div style={{
                    fontSize: 11, fontWeight: 700, color: '#7A6D66',
                    textTransform: 'uppercase', letterSpacing: '.06em',
                    marginBottom: 4,
                  }}>Request type filter</div>
                  <Select
                    value={record.request_type}
                    onChange={(v) => updateLevel(record.key, 'request_type', v || null)}
                    placeholder="Any"
                    allowClear
                    style={{ width: '100%' }}
                    size="small"
                    options={[
                      { value: 'regular', label: 'Regular' },
                      { value: 'urgent', label: 'Urgent' },
                      { value: 'auto_reorder', label: 'Auto Reorder' },
                    ]}
                  />
                </div>

                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={{
                    fontSize: 11, fontWeight: 700, color: '#7A6D66',
                    textTransform: 'uppercase', letterSpacing: '.06em',
                    marginBottom: 4,
                  }}>
                    Custom rule (JSON) — advanced; supports {`{eq, in, range}`}
                  </div>
                  <Input.TextArea
                    rows={2}
                    value={record.condition_json || ''}
                    onChange={(e) => updateLevel(record.key, 'condition_json', e.target.value || null)}
                    placeholder='e.g. {"in": {"vendor_id": [42, 88]}}'
                    style={{ fontFamily: 'monospace', fontSize: 12 }}
                  />
                </div>

                <div style={{ gridColumn: '1 / -1', fontSize: 11, color: '#A89A92' }}>
                  Filters AND together. Leave blank for "no constraint." A level only routes if every non-blank filter matches the submission context.
                </div>
              </div>
            ),
          }}
          footer={() => (
            <Button type="dashed" onClick={addLevel} icon={<PlusOutlined />} block>
              Add Approval Level
            </Button>
          )}
        />

        <div style={{ marginTop: 16, padding: 12, background: '#f6f8fa', borderRadius: 6 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Approval levels are executed in order. Each level must be approved before the next level is triggered.
            If an amount range is specified, the level only applies when the document amount falls within that range.
            Auto-approve automatically approves after the specified number of days if no action is taken.
          </Text>
        </div>
      </Drawer>
    </div>
  );
};

export default WorkflowConfig;

