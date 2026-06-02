import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Modal,
  Divider, Typography, Tooltip, Tag, Switch, Tabs, Badge, Alert,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  ThunderboltOutlined, CheckOutlined, CloseCircleOutlined,
  SettingOutlined, SyncOutlined, PlayCircleOutlined,
  PauseCircleOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import WarehouseTree from '../../components/WarehouseTree';
import api from '../../config/api';
import {
  formatDate, formatDateTime, formatCurrency, formatNumber, getErrorMessage,
} from '../../utils/helpers';

const { Text } = Typography;

const REPLENISHMENT_TASK_STATUSES = [
  { label: 'Pending', value: 'pending' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const Replenishment = () => {
  // Rules state
  const [ruleDrawerOpen, setRuleDrawerOpen] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [ruleForm] = Form.useForm();
  const [ruleSubmitting, setRuleSubmitting] = useState(false);
  const [rulesRefreshKey, setRulesRefreshKey] = useState(0);

  // Tasks state
  const [tasksRefreshKey, setTasksRefreshKey] = useState(0);
  const [filterTaskStatus, setFilterTaskStatus] = useState(undefined);
  const [triggering, setTriggering] = useState(false);

  // View task detail
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [viewData, setViewData] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);

  // --- RULES ---
  const fetchRules = useCallback(
    async (params) => {
      return await api.get('/inventory/replenishment/rules', { params });
    },
    []
  );

  const handleAddRule = () => {
    setEditingRule(null);
    ruleForm.resetFields();
    ruleForm.setFieldsValue({ is_active: true });
    setRuleDrawerOpen(true);
  };

  const handleEditRule = async (record) => {
    setEditingRule(record);
    ruleForm.setFieldsValue({
      item_id: record.item_id,
      pick_bin: record.pick_bin,
      reserve_bin: record.reserve_bin,
      min_qty: record.min_qty,
      max_qty: record.max_qty,
      replenish_qty: record.replenish_qty,
      is_active: record.is_active !== false,
    });
    setRuleDrawerOpen(true);
  };

  const handleSubmitRule = async () => {
    try {
      const values = await ruleForm.validateFields();
      setRuleSubmitting(true);

      const payload = {
        pick_bin_id: values.pick_bin,
        reserve_bin_id: values.reserve_bin,
        item_id: values.item_id,
        pick_bin: values.pick_bin,
        reserve_bin: values.reserve_bin,
        min_qty: values.min_qty,
        max_qty: values.max_qty,
        replenish_qty: values.replenish_qty,
        is_active: values.is_active,
      };

      if (editingRule) {
        await api.put(`/inventory/replenishment/rules/${editingRule.id}`, payload);
        message.success('Rule updated');
      } else {
        await api.post('/inventory/replenishment/rules', payload);
        message.success('Rule created');
      }
      setRuleDrawerOpen(false);
      ruleForm.resetFields();
      setEditingRule(null);
      setRulesRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setRuleSubmitting(false);
    }
  };

  const handleDeleteRule = async (id) => {
    try {
      await api.delete(`/inventory/replenishment/rules/${id}`);
      message.success('Rule deleted');
      setRulesRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleToggleRule = async (record) => {
    try {
      await api.put(`/inventory/replenishment/rules/${record.id}`, {
        ...record,
        is_active: !record.is_active,
      });
      message.success(`Rule ${record.is_active ? 'deactivated' : 'activated'}`);
      setRulesRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- TASKS ---
  const fetchTasks = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterTaskStatus) qp.status = filterTaskStatus;
      return await api.get('/inventory/replenishment/tasks', { params: qp });
    },
    [filterTaskStatus]
  );

  const handleTriggerReplenishment = async () => {
    setTriggering(true);
    try {
      const res = await api.post('/inventory/replenishment/trigger');
      const data = res.data;
      const created = data.tasks_created || data.count || 0;
      if (created > 0) {
        message.success(`${created} replenishment task(s) created`);
      } else {
        message.info('No bins below minimum quantity. No tasks created.');
      }
      setTasksRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setTriggering(false);
    }
  };

  const handleTaskAction = async (id, action, successMsg) => {
    try {
      await api.put(`/inventory/replenishment/tasks/${id}/${action}`);
      message.success(successMsg);
      setTasksRefreshKey((k) => k + 1);
      if (viewModalOpen && viewData?.id === id) {
        const res = await api.get(`/inventory/replenishment/tasks/${id}`);
        setViewData(res.data);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleViewTask = async (record) => {
    setViewLoading(true);
    setViewModalOpen(true);
    try {
      const res = await api.get(`/inventory/replenishment/tasks/${record.id}`);
      setViewData(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
      setViewModalOpen(false);
    } finally {
      setViewLoading(false);
    }
  };

  // Rules columns
  const ruleColumns = [
    {
      title: 'Item Code',
      dataIndex: 'item_code',
      width: 110,
      sorter: true,
    },
    {
      title: 'Item Name',
      dataIndex: 'item_name',
      width: 180,
      render: (val) => (
        <Tooltip title={val}>
          <Text ellipsis style={{ maxWidth: 160 }}>{val || '-'}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Pick Bin',
      dataIndex: 'pick_bin_name',
      width: 140,
      render: (val) => val || '-',
    },
    {
      title: 'Reserve Bin',
      dataIndex: 'reserve_bin_name',
      width: 140,
      render: (val) => val || '-',
    },
    {
      title: 'Min Qty',
      dataIndex: 'min_qty',
      width: 80,
      align: 'right',
      render: (val) => formatNumber(val || 0),
    },
    {
      title: 'Max Qty',
      dataIndex: 'max_qty',
      width: 80,
      align: 'right',
      render: (val) => formatNumber(val || 0),
    },
    {
      title: 'Replenish Qty',
      dataIndex: 'replenish_qty',
      width: 110,
      align: 'right',
      render: (val) => <Text strong>{formatNumber(val || 0)}</Text>,
    },
    {
      title: 'Active',
      dataIndex: 'is_active',
      width: 80,
      align: 'center',
      render: (val, record) => (
        <Switch
          checked={val !== false}
          onChange={() => handleToggleRule(record)}
          size="small"
        />
      ),
    },
    {
      title: 'Current Qty',
      dataIndex: 'current_bin_qty',
      width: 100,
      align: 'right',
      render: (val, record) => {
        const qty = val || 0;
        const min = record.min_qty || 0;
        const color = qty <= min ? '#f5222d' : qty <= min * 1.5 ? '#fa8c16' : undefined;
        return <Text style={color ? { color } : undefined}>{formatNumber(qty)}</Text>;
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 110,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="Edit">
            <Button type="text" icon={<EditOutlined />} size="small" onClick={() => handleEditRule(record)} />
          </Tooltip>
          <Popconfirm title="Delete this rule?" onConfirm={() => handleDeleteRule(record.id)}>
            <Button type="text" danger icon={<DeleteOutlined />} size="small" />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  // Tasks columns
  const taskColumns = [
    {
      title: 'Task ID',
      dataIndex: 'task_number',
      width: 130,
      fixed: 'left',
      sorter: true,
      render: (val, record) => (
        <Button type="link" size="small" onClick={() => handleViewTask(record)}>
          {val || record.id}
        </Button>
      ),
    },
    {
      title: 'Item Code',
      dataIndex: 'item_code',
      width: 110,
    },
    {
      title: 'Item Name',
      dataIndex: 'item_name',
      width: 160,
      render: (val) => (
        <Tooltip title={val}>
          <Text ellipsis style={{ maxWidth: 140 }}>{val || '-'}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'From Bin',
      dataIndex: 'from_bin_name',
      width: 140,
      render: (val) => val || '-',
    },
    {
      title: 'To Bin',
      dataIndex: 'to_bin_name',
      width: 140,
      render: (val) => val || '-',
    },
    {
      title: 'Qty',
      dataIndex: 'qty',
      width: 80,
      align: 'right',
      render: (val) => <Text strong>{formatNumber(val || 0)}</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 120,
      render: (val) => <StatusTag status={val} />,
    },
    {
      title: 'Triggered At',
      dataIndex: 'created_at',
      width: 150,
      sorter: true,
      render: (val) => formatDateTime(val),
    },
    {
      title: 'Assigned To',
      dataIndex: 'assigned_to',
      width: 110,
      render: (val) => val || '-',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 140,
      fixed: 'right',
      render: (_, record) => {
        const st = (record.status || '').toLowerCase();
        return (
          <Space size="small">
            <Tooltip title="View">
              <Button type="text" icon={<EyeOutlined />} size="small" onClick={() => handleViewTask(record)} />
            </Tooltip>
            {st === 'pending' && (
              <Tooltip title="Start">
                <Popconfirm title="Start this task?" onConfirm={() => handleTaskAction(record.id, 'start', 'Task started')}>
                  <Button type="text" icon={<PlayCircleOutlined />} size="small" style={{ color: '#eb2f96' }} />
                </Popconfirm>
              </Tooltip>
            )}
            {st === 'in_progress' && (
              <Tooltip title="Complete">
                <Popconfirm title="Complete this task?" onConfirm={() => handleTaskAction(record.id, 'complete', 'Task completed')}>
                  <Button type="text" icon={<CheckOutlined />} size="small" style={{ color: '#52c41a' }} />
                </Popconfirm>
              </Tooltip>
            )}
            {(st === 'pending' || st === 'in_progress') && (
              <Tooltip title="Cancel">
                <Popconfirm title="Cancel this task?" onConfirm={() => handleTaskAction(record.id, 'cancel', 'Task cancelled')}>
                  <Button type="text" danger icon={<CloseCircleOutlined />} size="small" />
                </Popconfirm>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
  ];

  const taskFilterToolbar = (
    <Space wrap size="small" style={{ marginLeft: 12 }}>
      <Select
        placeholder="Status"
        options={REPLENISHMENT_TASK_STATUSES}
        value={filterTaskStatus}
        onChange={(val) => { setFilterTaskStatus(val); setTasksRefreshKey((k) => k + 1); }}
        allowClear
        style={{ width: 140 }}
        size="middle"
      />
    </Space>
  );

  const tabItems = [
    {
      key: 'rules',
      label: (
        <Space>
          <SettingOutlined />
          Rules Configuration
        </Space>
      ),
      children: (
        <Card bodyStyle={{ padding: 0 }}>
          <DataTable
            key={rulesRefreshKey}
            columns={ruleColumns}
            fetchFunction={fetchRules}
            rowKey="id"
            searchPlaceholder="Search rules..."
            exportFileName="Replenishment_Rules"
            toolbar={
              <Space style={{ marginLeft: 12 }}>
                <Button type="primary" icon={<PlusOutlined />} onClick={handleAddRule} size="middle">
                  Add Rule
                </Button>
              </Space>
            }
            scroll={{ x: 1200 }}
          />
        </Card>
      ),
    },
    {
      key: 'tasks',
      label: (
        <Space>
          <ThunderboltOutlined />
          Active Replenishments
        </Space>
      ),
      children: (
        <Card bodyStyle={{ padding: 0 }}>
          <DataTable
            key={tasksRefreshKey}
            columns={taskColumns}
            fetchFunction={fetchTasks}
            rowKey="id"
            searchPlaceholder="Search tasks..."
            exportFileName="Replenishment_Tasks"
            toolbar={
              <Space wrap style={{ marginLeft: 12 }}>
                {taskFilterToolbar}
              </Space>
            }
            scroll={{ x: 1300 }}
          />
        </Card>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Replenishment" subtitle="Bin replenishment rules and triggered tasks">
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          onClick={handleTriggerReplenishment}
          loading={triggering}
        >
          Trigger Replenishment
        </Button>
      </PageHeader>

      <Tabs defaultActiveKey="rules" items={tabItems} />

      {/* Rule Add/Edit Drawer */}
      <Drawer
        title={
          <Space>
            <SettingOutlined />
            {editingRule ? 'Edit Replenishment Rule' : 'Add Replenishment Rule'}
          </Space>
        }
        placement="right"
        width={560}
        open={ruleDrawerOpen}
        onClose={() => setRuleDrawerOpen(false)}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => setRuleDrawerOpen(false)}>Cancel</Button>
            <Button type="primary" onClick={handleSubmitRule} loading={ruleSubmitting}>
              {editingRule ? 'Update' : 'Create'}
            </Button>
          </Space>
        }
      >
        <Form form={ruleForm} layout="vertical">
          <Form.Item
            name="item_id"
            label="Item"
            rules={[{ required: true, message: 'Select an item' }]}
          >
            <ItemSelector placeholder="Select item for replenishment..." />
          </Form.Item>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="pick_bin"
                label="Pick Bin (Source)"
                rules={[{ required: true, message: 'Select pick bin' }]}
              >
                <WarehouseTree
                  placeholder="Select pick bin..."
                  selectableLevel="bin"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="reserve_bin"
                label="Reserve Bin (Source for Replenishment)"
                rules={[{ required: true, message: 'Select reserve bin' }]}
              >
                <WarehouseTree
                  placeholder="Select reserve bin..."
                  selectableLevel="bin"
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="min_qty"
                label="Min Qty"
                rules={[{ required: true, message: 'Enter min qty' }]}
              >
                <InputNumber min={0} style={{ width: '100%' }} placeholder="Min" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="max_qty"
                label="Max Qty"
                rules={[{ required: true, message: 'Enter max qty' }]}
              >
                <InputNumber min={0} style={{ width: '100%' }} placeholder="Max" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="replenish_qty"
                label="Replenish Qty"
                rules={[{ required: true, message: 'Enter replenish qty' }]}
              >
                <InputNumber min={1} style={{ width: '100%' }} placeholder="Qty" />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="is_active" label="Active" valuePropName="checked">
            <Switch />
          </Form.Item>

          <Alert
            message="How it works"
            description={
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                <li>When the Pick Bin stock falls below the Min Qty, a replenishment task is triggered.</li>
                <li>The task will move the Replenish Qty from the Reserve Bin to the Pick Bin.</li>
                <li>Max Qty is the upper capacity limit for the Pick Bin.</li>
              </ul>
            }
            type="info"
            showIcon
            style={{ marginTop: 8 }}
          />
        </Form>
      </Drawer>

      {/* View Task Modal */}
      <Modal
        title={
          viewData ? (
            <Space>
              <ThunderboltOutlined />
              <span>Replenishment Task: {viewData.task_number || viewData.id}</span>
              <StatusTag status={viewData.status} />
            </Space>
          ) : 'Task Detail'
        }
        open={viewModalOpen}
        onCancel={() => { setViewModalOpen(false); setViewData(null); }}
        width={700}
        loading={viewLoading}
        footer={
          viewData ? (
            <Space>
              {viewData.status === 'pending' && (
                <Popconfirm title="Start this task?" onConfirm={() => handleTaskAction(viewData.id, 'start', 'Task started')}>
                  <Button type="primary" icon={<PlayCircleOutlined />}>Start</Button>
                </Popconfirm>
              )}
              {viewData.status === 'in_progress' && (
                <Popconfirm title="Complete?" onConfirm={() => handleTaskAction(viewData.id, 'complete', 'Task completed')}>
                  <Button type="primary" icon={<CheckOutlined />}>Complete</Button>
                </Popconfirm>
              )}
              {(viewData.status === 'pending' || viewData.status === 'in_progress') && (
                <Popconfirm title="Cancel?" onConfirm={() => handleTaskAction(viewData.id, 'cancel', 'Task cancelled')}>
                  <Button danger icon={<CloseCircleOutlined />}>Cancel</Button>
                </Popconfirm>
              )}
              <Button onClick={() => setViewModalOpen(false)}>Close</Button>
            </Space>
          ) : null
        }
      >
        {viewData && (
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="Task ID">{viewData.task_number || viewData.id}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={viewData.status} /></Descriptions.Item>
            <Descriptions.Item label="Item Code">{viewData.item_code || '-'}</Descriptions.Item>
            <Descriptions.Item label="Item Name">{viewData.item_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="From Bin (Reserve)">{viewData.from_bin_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="To Bin (Pick)">{viewData.to_bin_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Quantity"><Text strong>{formatNumber(viewData.qty || 0)}</Text></Descriptions.Item>
            <Descriptions.Item label="UOM">{viewData.uom || '-'}</Descriptions.Item>
            <Descriptions.Item label="Triggered By">{viewData.triggered_by || 'System'}</Descriptions.Item>
            <Descriptions.Item label="Assigned To">{viewData.assigned_to || '-'}</Descriptions.Item>
            <Descriptions.Item label="Created At">{formatDateTime(viewData.created_at)}</Descriptions.Item>
            <Descriptions.Item label="Completed At">{viewData.completed_at ? formatDateTime(viewData.completed_at) : '-'}</Descriptions.Item>
            <Descriptions.Item label="Rule ID">{viewData.rule_id || '-'}</Descriptions.Item>
            <Descriptions.Item label="Remarks">{viewData.remarks || '-'}</Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </div>
  );
};

export default Replenishment;

