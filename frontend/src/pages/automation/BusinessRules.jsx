import React, { useEffect, useState } from 'react';
import {
  Card, Table, Button, Modal, Form, Input, Select, Switch, Space, Tag,
  message, Drawer, Popconfirm, Empty, Tabs, Tooltip,
} from 'antd';
import {
  PlusOutlined, ThunderboltOutlined, DeleteOutlined, EditOutlined,
  FireOutlined, HistoryOutlined, ReloadOutlined, CheckCircleOutlined,
  CloseCircleOutlined, MinusCircleOutlined,
} from '@ant-design/icons';
import api from '../../config/api';
import { formatDateTime, getErrorMessage } from '../../utils/helpers';

const { TextArea } = Input;

const STATUS_TAGS = {
  success: <Tag color="green" icon={<CheckCircleOutlined />}>success</Tag>,
  skipped: <Tag color="default" icon={<MinusCircleOutlined />}>skipped</Tag>,
  failed: <Tag color="red" icon={<CloseCircleOutlined />}>failed</Tag>,
};

// Curated starter templates so admins don't stare at a blank textarea.
const TEMPLATES = [
  {
    label: 'Auto-reorder when stock ≤ reorder level',
    rule: {
      name: 'Auto-reorder critical SKUs',
      description: 'When stock falls to or below the reorder level, draft an indent to the same warehouse.',
      trigger_event: 'stock.balance_changed',
      condition_json: JSON.stringify({
        and: [
          { gt: { reorder_level: 0 } },
          { lte_field: { available_qty: 'reorder_level' } },
        ],
      }, null, 2),
      action_type: 'create_indent',
      action_config: JSON.stringify({
        warehouse_id_field: 'warehouse_id',
        item_id_field: 'item_id',
        qty_field: 'reorder_qty',
        request_type: 'auto_reorder',
        remarks: 'Auto-reorder for {{item_name}} ({{item_code}}) — available {{available_qty}}, reorder at {{reorder_level}}',
        dedupe: true,
      }, null, 2),
    },
  },
  {
    label: 'Notify on stock-out (available = 0)',
    rule: {
      name: 'Stock-out alert',
      description: 'Notify warehouse manager (user 1) when an item hits zero.',
      trigger_event: 'stock.balance_changed',
      condition_json: JSON.stringify({ eq: { available_qty: 0 } }, null, 2),
      action_type: 'notify',
      action_config: JSON.stringify({
        user_id: 1,
        title: 'Stock-out: {{item_name}}',
        body: '{{item_code}} hit zero in warehouse {{warehouse_id}}.',
      }, null, 2),
    },
  },
  {
    label: 'Notify when batch posts qty_in (receipt)',
    rule: {
      name: 'GRN receipt alert',
      description: 'Notify on every receipt over 100 units.',
      trigger_event: 'stock.balance_changed',
      condition_json: JSON.stringify({
        and: [
          { eq: { transaction_type: 'goods_receipt' } },
          { gte: { qty_in: 100 } },
        ],
      }, null, 2),
      action_type: 'notify',
      action_config: JSON.stringify({
        user_id: 1,
        title: 'Large receipt — {{item_name}}',
        body: 'Received {{qty_in}} of {{item_code}} into warehouse {{warehouse_id}}.',
      }, null, 2),
    },
  },
];

const BusinessRules = () => {
  const [rules, setRules] = useState([]);
  const [meta, setMeta] = useState({ events: [], actions: [], operators: [] });
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();
  const [executions, setExecutions] = useState([]);
  const [historyDrawer, setHistoryDrawer] = useState(null); // rule id

  const fetchRules = async () => {
    setLoading(true);
    try {
      const [r, m] = await Promise.allSettled([
        api.get('/automation/rules'),
        api.get('/automation/rules/meta/events'),
      ]);
      if (r.status === 'fulfilled') setRules(r.value.data?.results || []);
      if (m.status === 'fulfilled') setMeta(m.value.data || { events: [], actions: [], operators: [] });
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchRules(); }, []);

  const openCreate = (template) => {
    setEditing(null);
    form.resetFields();
    if (template) {
      form.setFieldsValue({ ...template, is_active: true });
    } else {
      form.setFieldsValue({
        name: '',
        description: '',
        trigger_event: 'stock.balance_changed',
        condition_json: '{}',
        action_type: 'notify',
        action_config: '{}',
        is_active: true,
      });
    }
    setModalOpen(true);
  };

  const openEdit = (rec) => {
    setEditing(rec);
    form.setFieldsValue({
      name: rec.name,
      description: rec.description,
      trigger_event: rec.trigger_event,
      condition_json: rec.condition_json,
      action_type: rec.action_type,
      action_config: rec.action_config,
      is_active: rec.is_active,
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    try {
      const v = await form.validateFields();
      // Validate JSON
      try { JSON.parse(v.condition_json); } catch (e) {
        message.error('condition_json: ' + e.message);
        return;
      }
      try { JSON.parse(v.action_config); } catch (e) {
        message.error('action_config: ' + e.message);
        return;
      }
      if (editing) {
        await api.put(`/automation/rules/${editing.id}`, v);
        message.success('Rule updated');
      } else {
        await api.post('/automation/rules', v);
        message.success('Rule created');
      }
      setModalOpen(false);
      fetchRules();
    } catch (err) {
      if (err?.errorFields) return;
      message.error(getErrorMessage(err));
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/automation/rules/${id}`);
      message.success('Rule deleted');
      fetchRules();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleToggle = async (rec) => {
    try {
      await api.put(`/automation/rules/${rec.id}`, { is_active: !rec.is_active });
      fetchRules();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const openHistory = async (rec) => {
    setHistoryDrawer(rec);
    try {
      const res = await api.get(`/automation/rules/${rec.id}/executions`, {
        params: { limit: 50 },
      });
      setExecutions(res.data?.results || []);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleFire = async (rec) => {
    Modal.confirm({
      title: 'Fire test event?',
      content: 'Sends a synthetic event with empty context. Useful for sanity-checking the action handler. Won\'t use real data.',
      onOk: async () => {
        try {
          const res = await api.post('/automation/rules/fire', {
            event_name: rec.trigger_event,
            context: {},
          });
          Modal.info({
            title: 'Fire result',
            content: <pre style={{ fontSize: 11 }}>{JSON.stringify(res.data, null, 2)}</pre>,
            width: 600,
          });
          fetchRules();
        } catch (err) {
          message.error(getErrorMessage(err));
        }
      },
    });
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      render: (n, r) => (
        <div>
          <div style={{ fontWeight: 600 }}>{n}</div>
          {r.description && <div style={{ fontSize: 11, color: '#7A6D66' }}>{r.description}</div>}
        </div>
      ),
    },
    {
      title: 'Trigger',
      dataIndex: 'trigger_event',
      render: (e) => <Tag color="purple" style={{ fontFamily: 'monospace' }}>{e}</Tag>,
    },
    {
      title: 'Action',
      dataIndex: 'action_type',
      render: (a) => <Tag color="blue">{a}</Tag>,
    },
    {
      title: 'Active',
      width: 80,
      align: 'center',
      render: (_, r) => (
        <Switch checked={r.is_active} onChange={() => handleToggle(r)} size="small" />
      ),
    },
    {
      title: 'Fires',
      width: 80,
      align: 'right',
      render: (_, r) => (
        <Tooltip title={r.last_fired_at ? `Last fired ${formatDateTime(r.last_fired_at)}` : 'Never fired'}>
          <Tag style={{ fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums' }}>
            {r.fire_count || 0}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: '',
      width: 200,
      align: 'right',
      render: (_, r) => (
        <Space size="small">
          <Tooltip title="Execution history">
            <Button size="small" icon={<HistoryOutlined />} onClick={() => openHistory(r)} />
          </Tooltip>
          <Tooltip title="Fire test event">
            <Button size="small" icon={<FireOutlined />} onClick={() => handleFire(r)} />
          </Tooltip>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>Edit</Button>
          <Popconfirm title="Delete this rule?" onConfirm={() => handleDelete(r.id)} okButtonProps={{ danger: true }}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 12,
        marginBottom: 16,
      }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>
            <ThunderboltOutlined style={{ marginRight: 8, color: '#F09000' }} />
            Business Rules
          </h2>
          <div style={{ color: '#7A6D66', fontSize: 13 }}>
            Declarative auto-actions: when an event happens AND conditions match, run an action.
            Currently fires on stock changes; more event hooks coming.
          </div>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchRules}>Refresh</Button>
          <Select
            placeholder="Use template..."
            style={{ width: 280 }}
            allowClear
            onChange={(idx) => idx != null && openCreate(TEMPLATES[idx].rule)}
            options={TEMPLATES.map((t, i) => ({ value: i, label: t.label }))}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openCreate(null)}>
            New rule
          </Button>
        </Space>
      </div>

      <Card>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={rules}
          loading={loading}
          pagination={{ pageSize: 25 }}
          locale={{
            emptyText: <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No business rules yet. Pick a template above to start."
            />,
          }}
        />
      </Card>

      <Modal
        title={editing ? `Edit rule — ${editing.name}` : 'New business rule'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleSave}
        okText="Save"
        width={760}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="e.g. Auto-reorder critical SKUs" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input placeholder="One-liner — what does this rule do?" />
          </Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Form.Item name="trigger_event" label="Trigger event" rules={[{ required: true }]}>
              <Select
                options={(meta.events || []).map((e) => ({ value: e.name, label: e.name }))}
              />
            </Form.Item>
            <Form.Item name="action_type" label="Action" rules={[{ required: true }]}>
              <Select
                options={(meta.actions || []).map((a) => ({ value: a.name, label: a.name }))}
              />
            </Form.Item>
          </div>
          <Form.Item
            name="condition_json"
            label={
              <Space>
                Condition (JSON)
                <Tooltip
                  title={
                    <span>
                      Operators: {(meta.operators || []).join(', ')}.
                      Use <code>and</code>/<code>or</code> to combine.
                      <br />
                      <code>lte_field</code> compares two context fields.
                    </span>
                  }
                >
                  <span style={{ color: '#A89A92', cursor: 'help' }}>(?)</span>
                </Tooltip>
              </Space>
            }
            rules={[{ required: true }]}
          >
            <TextArea
              rows={6}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
              placeholder='{"lte_field": {"available_qty": "reorder_level"}}'
            />
          </Form.Item>
          <Form.Item
            name="action_config"
            label={
              <Space>
                Action config (JSON)
                <Tooltip
                  title={
                    <pre style={{ fontSize: 11, margin: 0, color: '#fff' }}>
                      {JSON.stringify(meta.actions, null, 2)}
                    </pre>
                  }
                >
                  <span style={{ color: '#A89A92', cursor: 'help' }}>(?)</span>
                </Tooltip>
              </Space>
            }
            rules={[{ required: true }]}
          >
            <TextArea
              rows={8}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
          </Form.Item>
          <Form.Item name="is_active" label="Active" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={historyDrawer ? `Executions — ${historyDrawer.name}` : ''}
        open={!!historyDrawer}
        onClose={() => setHistoryDrawer(null)}
        width={760}
      >
        {executions.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No executions yet." />
        ) : (
          <Table
            rowKey="id"
            dataSource={executions}
            pagination={false}
            columns={[
              {
                title: 'Fired',
                dataIndex: 'fired_at',
                width: 170,
                render: (t) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{formatDateTime(t)}</span>,
              },
              {
                title: 'Status',
                dataIndex: 'status',
                width: 110,
                render: (s) => STATUS_TAGS[s] || <Tag>{s}</Tag>,
              },
              {
                title: 'Result / error',
                render: (_, r) => (
                  <pre style={{
                    margin: 0, fontSize: 11, whiteSpace: 'pre-wrap',
                    color: r.error ? '#D80048' : '#241A17',
                  }}>
                    {r.error || r.result || '—'}
                  </pre>
                ),
              },
            ]}
          />
        )}
      </Drawer>
    </div>
  );
};

export default BusinessRules;

