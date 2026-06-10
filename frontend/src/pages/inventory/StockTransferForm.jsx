import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Button, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, Row, Col, Table, Card, Descriptions, Divider,
  Typography, Tooltip, Tag, Steps, Spin, App
} from 'antd';
import {
  ArrowLeftOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  SendOutlined, CheckOutlined, MinusCircleOutlined, SwapOutlined,
  CarOutlined, InboxOutlined, CheckCircleFilled, ClockCircleFilled
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import WarehouseTree from '../../components/WarehouseTree';
import api from '../../config/api';
import {
  formatDate, formatDateTime, formatNumber, getErrorMessage,
  formatDateForAPI
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const TRANSFER_TYPES = [
  { label: 'Warehouse to Warehouse', value: 'warehouse_to_warehouse' },
  { label: 'Location to Location', value: 'location_to_location' },
  { label: 'Bin to Bin', value: 'bin_to_bin' },
];

const TRANSFER_STATUSES = [
  { label: 'Draft', value: 'draft' },
  { label: 'Pending Approval', value: 'pending_approval' },
  { label: 'Approved', value: 'approved' },
  { label: 'In Transit', value: 'in_transit' },
  { label: 'Received', value: 'received' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const STATUS_STEP_MAP = {
  draft: 0,
  pending_approval: 1,
  approved: 2,
  in_transit: 3,
  received: 4,
  completed: 5,
};

const StockTransferForm = () => {
  const { message } = App.useApp();
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isNew = !id || id === 'new';

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [recordData, setRecordData] = useState(null);
  const [editMode, setEditMode] = useState(isNew);

  // Form states
  const [transferItems, setTransferItems] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [uomOptions, setUomOptions] = useState([]);

  // --- Item Row Helpers ---
  const createEmptyItem = () => ({
    key: Date.now() + Math.random(),
    item_id: null,
    item_name: '',
    item_code: '',
    batch: '',
    batch_id: null,
    qty: 0,
    uom: '',
    uom_id: null,
    primary_uom_id: null,
    source_bin: undefined,
    source_bin_id: null,
    destination_bin: undefined,
    destination_bin_id: null,
  });

  const updateTransferItem = (key, field, value) => {
    setTransferItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        return { ...item, [field]: value };
      })
    );
  };

  const addTransferItemRow = () => {
    setTransferItems((prev) => [...prev, createEmptyItem()]);
  };

  const removeTransferItemRow = (key) => {
    setTransferItems((prev) => prev.filter((i) => i.key !== key));
  };

  // --- Lookups ---
  const loadLookups = useCallback(async () => {
    try {
      const [whRes, uomRes] = await Promise.allSettled([
        api.get('/masters/warehouses', { params: { page_size: 200 } }),
        api.get('/masters/uom', { params: { page_size: 200 } }),
      ]);
      if (whRes.status === 'fulfilled') {
        const d = whRes.value.data;
        const items = d.items || d.data || d || [];
        setWarehouses(items.map((w) => ({
          label: w.name || w.warehouse_name,
          value: w.id,
        })));
      }
      if (uomRes.status === 'fulfilled') {
        const u = uomRes.value.data;
        setUomOptions(
          (u.items || u.data || u || []).map((i) => ({
            label: i.name || i.uom_name || i.code,
            value: i.id,
          }))
        );
      }
    } catch {
      // silent
    }
  }, []);

  // --- Fetch existing record ---
  const fetchRecord = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/inventory/stock-transfers/${id}`);
      const data = res.data;
      setRecordData(data);
      form.setFieldsValue({
        source_warehouse_id: data.source_warehouse_id,
        destination_warehouse_id: data.destination_warehouse_id,
        transfer_date: data.transfer_date ? dayjs(data.transfer_date) : dayjs(),
        transfer_type: data.transfer_type || 'warehouse_to_warehouse',
        remarks: data.remarks,
      });
      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_name: item.item_name || '',
        item_code: item.item_code || '',
        batch: item.batch || '',
        batch_id: item.batch_id || null,
        qty: item.qty || 0,
        received_qty: item.received_qty || 0,
        uom: item.uom || '',
        uom_id: item.uom_id || null,
        primary_uom_id: item.primary_uom_id || null,
        source_bin: item.source_bin || undefined,
        source_bin_id: item.source_bin_id || null,
        destination_bin: item.destination_bin || undefined,
        destination_bin_id: item.destination_bin_id || null,
      }));
      setTransferItems(items.length > 0 ? items : [createEmptyItem()]);

      const queryParams = new URLSearchParams(location.search);
      if (queryParams.get('edit') === 'true' && data.status === 'draft') {
        setEditMode(true);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/inventory/stock-transfer');
    } finally {
      setLoading(false);
    }
  }, [id, form, location.search, navigate, message]);

  // Init
  useEffect(() => {
    loadLookups();
    if (!isNew) {
      fetchRecord();
    } else {
      form.setFieldsValue({
        transfer_date: dayjs(),
        transfer_type: 'warehouse_to_warehouse',
      });
      setTransferItems([createEmptyItem()]);
    }
  }, [id, isNew, fetchRecord, loadLookups, form]);

  // --- Actions ---
  const handleAction = async (action, successMsg) => {
    try {
      await api.post(`/inventory/stock-transfers/${id}/${action}`);
      message.success(successMsg);
      fetchRecord();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleDelete = async () => {
    try {
      await api.delete(`/inventory/stock-transfers/${id}`);
      message.success('Transfer deleted');
      navigate('/inventory/stock-transfer');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Submit ---
  const handleSubmit = async (submitAction = 'draft') => {
    try {
      const values = await form.validateFields();
      const validItems = transferItems.filter((i) => i.item_id && i.qty > 0);
      if (validItems.length === 0) {
        message.error('Please add at least one item with quantity');
        return;
      }
      if (
        values.transfer_type === 'bin_to_bin' &&
        values.source_warehouse_id !== values.destination_warehouse_id
      ) {
        message.error('bin_to_bin transfers require the same warehouse on both sides');
        return;
      }
      if (
        values.transfer_type !== 'bin_to_bin' &&
        values.source_warehouse_id === values.destination_warehouse_id
      ) {
        message.error('Source and destination warehouses must differ (use bin_to_bin for same-warehouse moves)');
        return;
      }
      setSubmitting(true);

      const payload = {
        source_warehouse_id: values.source_warehouse_id,
        destination_warehouse_id: values.destination_warehouse_id,
        transfer_date: formatDateForAPI(values.transfer_date),
        transfer_type: values.transfer_type || 'warehouse_to_warehouse',
        remarks: values.remarks,
        items: validItems.map((item) => ({
          item_id: item.item_id,
          batch_id: item.batch_id || null,
          qty: item.qty,
          uom_id: item.uom_id || item.primary_uom_id || 1,
          source_bin_id: item.source_bin_id || null,
          destination_bin_id: item.destination_bin_id || null,
        })),
      };

      let status = 'draft';
      if (submitAction === 'submit_approval') status = 'pending_approval';

      if (!isNew) {
        await api.put(`/inventory/stock-transfers/${id}`, payload);
        if (submitAction === 'submit_approval') {
          await api.post(`/inventory/stock-transfers/${id}/submit`);
        }
        message.success('Transfer updated successfully');
        setEditMode(false);
        fetchRecord();
      } else {
        const res = await api.post('/inventory/stock-transfers', payload);
        const newId = res.data?.id;
        if (submitAction === 'submit_approval' && newId) {
          await api.post(`/inventory/stock-transfers/${newId}/submit`);
        }
        message.success('Transfer created successfully');
        if (newId) {
          navigate(`/inventory/stock-transfer/${newId}`);
        } else {
          navigate('/inventory/stock-transfer');
        }
      }
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

  // --- VIEW MODE ---
  if (!isNew && recordData && !editMode) {
    const viewItemColumns = [
      { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
      { title: 'Item Code', dataIndex: 'item_code', width: 110 },
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
      { title: 'Batch', dataIndex: 'batch', width: 100, render: (val) => val || '-' },
      { title: 'Transferred Qty', dataIndex: 'qty', width: 120, align: 'right', render: (val) => formatNumber(val || 0) },
      {
        title: 'Received Qty',
        dataIndex: 'received_qty',
        width: 110,
        align: 'right',
        render: (val, record) => {
          const qty = record.qty || 0;
          const recv = val || 0;
          const color = recv < qty ? '#fa8c16' : recv === qty ? '#52c41a' : '#f5222d';
          return <Text style={{ color }}>{formatNumber(recv)}</Text>;
        },
      },
      { title: 'UOM', dataIndex: 'uom', width: 60 },
      { title: 'Source Bin', dataIndex: 'source_bin_name', width: 120, render: (val) => val || '-' },
      { title: 'Dest Bin', dataIndex: 'destination_bin_name', width: 120, render: (val) => val || '-' },
    ];

    return (
      <div>
        <PageHeader
          title={recordData.transfer_number || `Transfer #${id}`}
          subtitle="Stock Transfer Details"
        >
          <Space>
            {recordData.status === 'draft' && (
              <>
                <Button icon={<EditOutlined />} onClick={() => setEditMode(true)} type="primary">
                  Edit
                </Button>
                <Popconfirm title="Submit for approval?" onConfirm={() => handleAction('submit', 'Submitted for approval')}>
                  <Button type="default" icon={<SendOutlined />}>Submit for Approval</Button>
                </Popconfirm>
                <Popconfirm title="Delete this transfer?" onConfirm={handleDelete} okButtonProps={{ danger: true }}>
                  <Button danger icon={<DeleteOutlined />}>Delete</Button>
                </Popconfirm>
              </>
            )}
            {recordData.status === 'pending_approval' && (
              <Popconfirm title="Approve this transfer?" onConfirm={() => handleAction('approve', 'Transfer approved')}>
                <Button type="primary" icon={<CheckOutlined />}>Approve</Button>
              </Popconfirm>
            )}
            {recordData.status === 'approved' && (
              <Popconfirm title="Mark as dispatched?" onConfirm={() => handleAction('dispatch', 'Transfer dispatched')}>
                <Button type="primary" icon={<CarOutlined />}>Dispatch</Button>
              </Popconfirm>
            )}
            {recordData.status === 'in_transit' && (
              <Popconfirm title="Mark as received?" onConfirm={() => handleAction('receive', 'Transfer received')}>
                <Button type="primary" icon={<InboxOutlined />}>Receive</Button>
              </Popconfirm>
            )}
            {recordData.status === 'received' && (
              <Popconfirm title="Mark as complete?" onConfirm={() => handleAction('complete', 'Transfer completed')}>
                <Button type="primary" icon={<CheckCircleFilled />}>Complete</Button>
              </Popconfirm>
            )}
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/inventory/stock-transfer')}>
              Back
            </Button>
          </Space>
        </PageHeader>

        <Card style={{ marginBottom: 16 }}>
          <Steps
            current={STATUS_STEP_MAP[recordData.status] ?? 0}
            size="small"
            style={{ marginBottom: 24 }}
            items={[
              { title: 'Draft', icon: <EditOutlined /> },
              { title: 'Pending Approval', icon: <ClockCircleFilled /> },
              { title: 'Approved', icon: <CheckOutlined /> },
              { title: 'In Transit', icon: <CarOutlined /> },
              { title: 'Received', icon: <InboxOutlined /> },
              { title: 'Completed', icon: <CheckCircleFilled /> },
            ]}
          />

          <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }} bordered>
            <Descriptions.Item label="Transfer No">{recordData.transfer_number}</Descriptions.Item>
            <Descriptions.Item label="Transfer Date">{formatDate(recordData.transfer_date)}</Descriptions.Item>
            <Descriptions.Item label="Transfer Type">
              {TRANSFER_TYPES.find((t) => t.value === recordData.transfer_type)?.label || recordData.transfer_type}
            </Descriptions.Item>
            <Descriptions.Item label="Source Warehouse">{recordData.source_warehouse_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Dest Warehouse">{recordData.destination_warehouse_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={recordData.status} /></Descriptions.Item>
            <Descriptions.Item label="Created By">{recordData.created_by || '-'}</Descriptions.Item>
            <Descriptions.Item label="Created At">{formatDateTime(recordData.created_at)}</Descriptions.Item>
            <Descriptions.Item label="Remarks">{recordData.remarks || '-'}</Descriptions.Item>
          </Descriptions>
        </Card>

        <Card title="Transfer Items">
          <Table
            columns={viewItemColumns}
            dataSource={recordData.items || []}
            rowKey="id"
            pagination={false}
            scroll={{ x: 900 }}
            size="small"
            summary={(pageData) => {
              if (!pageData || pageData.length === 0) return null;
              const totalTransferred = pageData.reduce((s, i) => s + (i.qty || 0), 0);
              const totalReceived = pageData.reduce((s, i) => s + (i.received_qty || 0), 0);
              return (
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={4}>
                    <Text strong>Total</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={1} align="right">
                    <Text strong>{formatNumber(totalTransferred)}</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={2} align="right">
                    <Text strong>{formatNumber(totalReceived)}</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={3} colSpan={3} />
                </Table.Summary.Row>
              );
            }}
          />
        </Card>
      </div>
    );
  }

  // --- EDIT / CREATE MODE ---
  const transferItemColumns = [
    { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item',
      dataIndex: 'item_id',
      width: 200,
      render: (val, record) =>
        record.item_name && !isNew ? (
          <Tooltip title={record.item_name}>
            <Text ellipsis style={{ maxWidth: 180 }}>{record.item_name}</Text>
          </Tooltip>
        ) : (
          <ItemSelector
            value={val}
            onChange={(itemId, item) => {
              updateTransferItem(record.key, 'item_id', itemId);
              if (item) {
                updateTransferItem(record.key, 'item_name', item.item_name || item.name || '');
                updateTransferItem(record.key, 'item_code', item.item_code || item.code || '');
                updateTransferItem(record.key, 'uom', item.primary_uom?.name || item.primary_uom_name || '');
                updateTransferItem(record.key, 'uom_id', item.primary_uom_id || null);
              }
            }}
            style={{ width: '100%' }}
          />
        ),
    },
    {
      title: 'Batch',
      dataIndex: 'batch',
      width: 100,
      render: (val, record) => (
        <Input
          value={val}
          onChange={(e) => updateTransferItem(record.key, 'batch', e.target.value)}
          size="small"
          placeholder="Batch"
        />
      ),
    },
    {
      title: 'Qty',
      dataIndex: 'qty',
      width: 90,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateTransferItem(record.key, 'qty', v || 0)}
          style={{ width: '100%' }}
          size="small"
        />
      ),
    },
    {
      title: 'UOM',
      dataIndex: 'uom_id',
      width: 110,
      render: (val, record) => (
        <Select
          value={val}
          onChange={(v) => updateTransferItem(record.key, 'uom_id', v)}
          options={uomOptions}
          placeholder="UOM"
          size="small"
          style={{ width: '100%' }}
          showSearch
          optionFilterProp="label"
        />
      ),
    },
    {
      title: 'Source Bin',
      dataIndex: 'source_bin',
      width: 180,
      render: (val, record) => (
        <WarehouseTree
          value={val}
          onChange={(v) => {
            updateTransferItem(record.key, 'source_bin', v);
            let binId = null;
            if (typeof v === 'number' && Number.isFinite(v)) {
              binId = v;
            } else if (typeof v === 'string' && v.startsWith('bin-')) {
              const parsed = parseInt(v.split('-')[1], 10);
              binId = Number.isFinite(parsed) ? parsed : null;
            }
            updateTransferItem(record.key, 'source_bin_id', binId);
          }}
          placeholder="Source bin..."
          selectableLevel="bin"
        />
      ),
    },
    {
      title: 'Destination Bin',
      dataIndex: 'destination_bin',
      width: 180,
      render: (val, record) => (
        <WarehouseTree
          value={val}
          onChange={(v) => {
            updateTransferItem(record.key, 'destination_bin', v);
            let binId = null;
            if (typeof v === 'number' && Number.isFinite(v)) {
              binId = v;
            } else if (typeof v === 'string' && v.startsWith('bin-')) {
              const parsed = parseInt(v.split('-')[1], 10);
              binId = Number.isFinite(parsed) ? parsed : null;
            }
            updateTransferItem(record.key, 'destination_bin_id', binId);
          }}
          placeholder="Dest bin..."
          selectableLevel="bin"
        />
      ),
    },
    {
      title: '',
      width: 40,
      render: (_, record) => (
        transferItems.length > 1 ? (
          <Button
            type="text"
            danger
            icon={<MinusCircleOutlined />}
            size="small"
            onClick={() => removeTransferItemRow(record.key)}
          />
        ) : null
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={isNew ? 'Create Stock Transfer' : `Edit Stock Transfer`}
        subtitle="Manage inter-location stock transfer details"
      >
        <Space>
          <Button
            onClick={() => handleSubmit('draft')}
            loading={submitting}
          >
            Save as Draft
          </Button>
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={() => handleSubmit('submit_approval')}
            loading={submitting}
          >
            Submit for Approval
          </Button>
          <Button
            onClick={() => {
              if (isNew) {
                navigate('/inventory/stock-transfer');
              } else {
                setEditMode(false);
              }
            }}
          >
            Cancel
          </Button>
        </Space>
      </PageHeader>

      <Card style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="source_warehouse_id"
                label="Source Warehouse"
                rules={[{ required: true, message: 'Select source warehouse' }]}
              >
                <Select
                  placeholder="Select source warehouse"
                  options={warehouses}
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="destination_warehouse_id"
                label="Destination Warehouse"
                rules={[{ required: true, message: 'Select destination warehouse' }]}
              >
                <Select
                  placeholder="Select destination warehouse"
                  options={warehouses}
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                name="transfer_date"
                label="Transfer Date"
                rules={[{ required: true, message: 'Select date' }]}
              >
                <DatePicker format={DATE_FORMAT} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="transfer_type"
                label="Transfer Type"
                rules={[{ required: true, message: 'Select type' }]}
              >
                <Select options={TRANSFER_TYPES} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="remarks" label="Remarks">
                <TextArea rows={1} placeholder="Optional remarks..." />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      <Card title="Transfer Items">
        <Table
          columns={transferItemColumns}
          dataSource={transferItems}
          rowKey="key"
          pagination={false}
          scroll={{ x: 900 }}
          size="small"
          footer={() => (
            <Button
              type="dashed"
              icon={<PlusOutlined />}
              onClick={addTransferItemRow}
              block
            >
              Add Item
            </Button>
          )}
          summary={(pageData) => {
            if (!pageData || pageData.length === 0) return null;
            const totalQty = pageData.reduce((s, i) => s + (i.qty || 0), 0);
            return (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={3}>
                  <Text strong>Total</Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="right">
                  <Text strong>{formatNumber(totalQty)}</Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2} colSpan={4} />
              </Table.Summary.Row>
            );
          }}
        />
      </Card>
    </div>
  );
};

export default StockTransferForm;
