import React, { useEffect, useState } from 'react';
import {
  Card, Table, Button, Modal, Form, Select, DatePicker, Input, Tag,
  Space, message, Popconfirm, Tabs, Empty,
} from 'antd';
import {
  PlusOutlined, UserSwitchOutlined, DeleteOutlined, ClockCircleOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import api from '../../config/api';
import { formatDateTime, getErrorMessage } from '../../utils/helpers';
import useAuthStore from '../../store/authStore';

const { TextArea } = Input;
const { RangePicker } = DatePicker;

// Modules a delegation can scope to (must match backend `module` field).
const MODULE_OPTIONS = [
  { value: '',             label: 'All modules' },
  { value: 'procurement',  label: 'Procurement' },
  { value: 'indent',       label: 'Indent' },
  { value: 'warehouse',    label: 'Warehouse' },
  { value: 'inventory',    label: 'Inventory' },
];

const Delegations = () => {
  const { user } = useAuthStore();
  const [tab, setTab] = useState('outgoing');
  const [outgoing, setOutgoing] = useState([]);
  const [incoming, setIncoming] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [out, inc, usr] = await Promise.allSettled([
        api.get('/approvals/delegations', { params: { direction: 'mine_outgoing' } }),
        api.get('/approvals/delegations', { params: { direction: 'mine_incoming' } }),
        api.get('/users/lookup', { params: { page_size: 200 } }),
      ]);
      if (out.status === 'fulfilled') setOutgoing(out.value.data?.results || []);
      if (inc.status === 'fulfilled') setIncoming(inc.value.data?.results || []);
      if (usr.status === 'fulfilled') {
        const data = usr.value.data;
        const list = Array.isArray(data) ? data : (data?.results || data?.items || []);
        setUsers(list);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, []);

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      const [from, to] = values.window || [];
      if (!from || !to) {
        message.error('Pick a delegation window');
        return;
      }
      setSubmitting(true);
      await api.post('/approvals/delegations', {
        delegatee_id: values.delegatee_id,
        valid_from: from.toISOString(),
        valid_to: to.toISOString(),
        scope_module: values.scope_module || null,
        reason: values.reason || null,
      });
      message.success('Delegation created');
      setModalOpen(false);
      form.resetFields();
      fetchAll();
    } catch (err) {
      if (err?.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevoke = async (id) => {
    try {
      await api.delete(`/approvals/delegations/${id}`);
      message.success('Delegation revoked');
      fetchAll();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const renderStatus = (rec) => {
    const now = dayjs();
    const from = dayjs(rec.valid_from);
    const to = dayjs(rec.valid_to);
    if (!rec.is_active) return <Tag>Revoked</Tag>;
    if (now.isBefore(from)) return <Tag color="blue">Scheduled</Tag>;
    if (now.isAfter(to)) return <Tag>Expired</Tag>;
    return <Tag color="green">Active</Tag>;
  };

  const outgoingColumns = [
    {
      title: 'Delegated to',
      dataIndex: 'delegatee_name',
      render: (name, rec) => (
        <span>
          <ArrowRightOutlined style={{ color: '#D80048', marginRight: 6 }} />
          {name || `User #${rec.delegatee_id}`}
        </span>
      ),
    },
    {
      title: 'Window',
      render: (_, rec) => (
        <span style={{ fontFamily: 'monospace', fontSize: 12.5 }}>
          {formatDateTime(rec.valid_from)} → {formatDateTime(rec.valid_to)}
        </span>
      ),
    },
    {
      title: 'Scope',
      dataIndex: 'scope_module',
      render: (m) => m
        ? <Tag color="purple">{m}</Tag>
        : <Tag color="default">All modules</Tag>,
    },
    {
      title: 'Reason',
      dataIndex: 'reason',
      ellipsis: true,
      render: (t) => t || <span style={{ color: '#A89A92' }}>—</span>,
    },
    { title: 'Status', render: (_, rec) => renderStatus(rec) },
    {
      title: '',
      width: 80,
      render: (_, rec) => rec.is_active ? (
        <Popconfirm
          title="Revoke this delegation?"
          description="The delegatee will immediately stop seeing approvals on your behalf."
          okText="Revoke"
          okButtonProps={{ danger: true }}
          onConfirm={() => handleRevoke(rec.id)}
        >
          <Button danger size="small" icon={<DeleteOutlined />}>Revoke</Button>
        </Popconfirm>
      ) : null,
    },
  ];

  const incomingColumns = [
    {
      title: 'On behalf of',
      dataIndex: 'delegator_name',
      render: (name, rec) => (
        <span>
          <UserSwitchOutlined style={{ color: '#481890', marginRight: 6 }} />
          {name || `User #${rec.delegator_id}`}
        </span>
      ),
    },
    {
      title: 'Window',
      render: (_, rec) => (
        <span style={{ fontFamily: 'monospace', fontSize: 12.5 }}>
          {formatDateTime(rec.valid_from)} → {formatDateTime(rec.valid_to)}
        </span>
      ),
    },
    {
      title: 'Scope',
      dataIndex: 'scope_module',
      render: (m) => m
        ? <Tag color="purple">{m}</Tag>
        : <Tag color="default">All modules</Tag>,
    },
    { title: 'Status', render: (_, rec) => renderStatus(rec) },
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Approval Delegations</h2>
          <div style={{ color: '#7A6D66', fontSize: 13 }}>
            Hand off your incoming approvals to a colleague while you're away.
            They can act on your behalf for the chosen window.
          </div>
        </div>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setModalOpen(true)}
        >
          New delegation
        </Button>
      </div>

      <Card>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'outgoing',
              label: `Delegated by me (${outgoing.length})`,
              children: outgoing.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="You haven't delegated any approvals yet."
                />
              ) : (
                <Table
                  rowKey="id"
                  dataSource={outgoing}
                  columns={outgoingColumns}
                  pagination={false}
                  loading={loading}
                />
              ),
            },
            {
              key: 'incoming',
              label: `Acting on behalf of others (${incoming.length})`,
              children: incoming.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="No one has delegated approvals to you."
                />
              ) : (
                <Table
                  rowKey="id"
                  dataSource={incoming}
                  columns={incomingColumns}
                  pagination={false}
                  loading={loading}
                />
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={
          <span>
            <UserSwitchOutlined style={{ marginRight: 8, color: '#D80048' }} />
            Delegate my approvals
          </span>
        }
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={handleCreate}
        okText="Delegate"
        confirmLoading={submitting}
        destroyOnHidden
        width={520}
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="delegatee_id"
            label="Delegate to"
            rules={[{ required: true, message: 'Pick a colleague' }]}
          >
            <Select
              showSearch
              placeholder="Search users by name…"
              optionFilterProp="label"
              options={users
                .filter((u) => u.id !== user?.id)
                .map((u) => ({
                  value: u.id,
                  label: `${u.full_name || u.username || u.email} ${u.email ? '· ' + u.email : ''}`,
                }))}
            />
          </Form.Item>
          <Form.Item
            name="window"
            label="Window"
            rules={[{ required: true, message: 'Pick a date range' }]}
          >
            <RangePicker
              showTime={{ format: 'HH:mm' }}
              format="DD/MM/YYYY HH:mm"
              style={{ width: '100%' }}
              disabledDate={(d) => d && d < dayjs().startOf('day').subtract(1, 'day')}
            />
          </Form.Item>
          <Form.Item name="scope_module" label="Scope (optional)">
            <Select
              placeholder="All modules"
              allowClear
              options={MODULE_OPTIONS.filter((o) => o.value !== '').map((o) => ({
                value: o.value,
                label: o.label,
              }))}
            />
          </Form.Item>
          <Form.Item name="reason" label="Reason (optional)">
            <TextArea
              rows={2}
              placeholder="e.g. on leave 22-25 Apr"
              maxLength={500}
            />
          </Form.Item>
          <div
            style={{
              padding: '10px 12px',
              background: '#FFEAD2',
              color: '#B87A00',
              borderRadius: 8,
              fontSize: 12.5,
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
            }}
          >
            <ClockCircleOutlined style={{ marginTop: 2 }} />
            <span>
              The delegate can act on your incoming approvals for the chosen window.
              Audit logs still record the actor's real name (the delegate), not yours.
            </span>
          </div>
        </Form>
      </Modal>
    </div>
  );
};

export default Delegations;

