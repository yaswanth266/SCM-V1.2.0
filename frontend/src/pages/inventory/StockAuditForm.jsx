import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Button, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, Row, Col, Table, Card, Descriptions, Divider,
  Typography, Tooltip, Tag, Alert, Statistic, Spin, App
} from 'antd';
import {
  ArrowLeftOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  SendOutlined, CheckOutlined, CloseCircleOutlined,
  ArrowUpOutlined, ArrowDownOutlined, AuditOutlined, ExclamationCircleOutlined
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatDate, formatDateTime, formatCurrency, formatNumber, getErrorMessage,
  formatDateForAPI
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const AUDIT_TYPES = [
  { label: 'Full Audit', value: 'full' },
  { label: 'Partial Audit', value: 'partial' },
  { label: 'Cycle Count', value: 'cycle_count' },
];

const AUDIT_STATUSES = [
  { label: 'Draft', value: 'draft' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Pending Approval', value: 'pending_approval' },
  { label: 'Approved', value: 'approved' },
  { label: 'Completed', value: 'completed' },
  { label: 'Cancelled', value: 'cancelled' },
];

const StockAuditForm = () => {
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
  const [auditItems, setAuditItems] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);

  // Load lookups
  useEffect(() => {
    const loadLookups = async () => {
      try {
        const res = await api.get('/masters/warehouses', { params: { page_size: 200 } });
        const d = res.data;
        const items = d.items || d.data || d || [];
        setWarehouses(items.map((w) => ({
          label: w.name || w.warehouse_name,
          value: w.id,
        })));
      } catch {
        // silent
      }
    };
    loadLookups();
  }, []);

  // --- Fetch existing record ---
  const fetchRecord = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/inventory/stock-audits/${id}`);
      const data = res.data;
      setRecordData(data);
      form.setFieldsValue({
        warehouse_id: data.warehouse_id,
        audit_date: data.audit_date ? dayjs(data.audit_date) : dayjs(),
        audit_type: data.audit_type || 'full',
        remarks: data.remarks,
      });
      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_code: item.item_code || '',
        item_name: item.item_name || '',
        batch: item.batch || '',
        location: item.location || '',
        rack: item.rack || '',
        bin: item.bin || '',
        uom: item.uom || '',
        system_qty: item.system_qty || 0,
        physical_qty: item.physical_qty,
        variance: item.variance || 0,
        variance_value: item.variance_value || 0,
        valuation_rate: item.valuation_rate || 0,
        remarks: item.remarks || '',
      }));
      setAuditItems(items);

      const queryParams = new URLSearchParams(location.search);
      if (queryParams.get('edit') === 'true' && (data.status === 'draft' || data.status === 'in_progress')) {
        setEditMode(true);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/inventory/stock-audit');
    } finally {
      setLoading(false);
    }
  }, [id, form, location.search, navigate, message]);

  // Init
  useEffect(() => {
    if (!isNew) {
      fetchRecord();
    } else {
      form.setFieldsValue({
        audit_date: dayjs(),
        audit_type: 'full',
      });
      setAuditItems([]);
    }
  }, [id, isNew, fetchRecord, form]);

  // Auto-populate items for a warehouse
  const populateWarehouseItems = async (warehouseId) => {
    if (!warehouseId) {
      setAuditItems([]);
      return;
    }
    setLoadingItems(true);
    try {
      const res = await api.get('/inventory/stock-balance', {
        params: { warehouse_id: warehouseId, page_size: 200 },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      const mapped = items.map((item, idx) => {
        const sysQty = item.total_qty || item.available_qty || 0;
        return {
          key: item.id || Date.now() + idx,
          item_id: item.item_id,
          item_code: item.item_code || '',
          item_name: item.item_name || '',
          batch: item.batch || '',
          location: item.location || '',
          rack: item.rack || '',
          bin: item.bin || '',
          uom: item.uom || item.uom_name || '',
          uom_id: item.uom_id || item.primary_uom_id || null,
          system_qty: sysQty,
          physical_qty: sysQty,
          variance: 0,
          variance_value: 0,
          valuation_rate: item.valuation_rate || 0,
          remarks: '',
        };
      });
      setAuditItems(mapped);
      if (mapped.length > 0) {
        message.success(`Loaded ${mapped.length} items from stock`);
      } else {
        message.info('No stock found for this warehouse');
      }
    } catch (err) {
      message.error(getErrorMessage(err));
      setAuditItems([]);
    } finally {
      setLoadingItems(false);
    }
  };

  // Update audit item
  const updateAuditItem = (key, field, value) => {
    setAuditItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        const updated = { ...item, [field]: value };
        if (field === 'physical_qty') {
          const phys = value ?? 0;
          const sys = updated.system_qty || 0;
          updated.variance = phys - sys;
          updated.variance_value = updated.variance * (updated.valuation_rate || 0);
        }
        return updated;
      })
    );
  };

  // Variance summary
  const getVarianceSummary = (items) => {
    const total = items.length;
    const counted = items.filter((i) => i.physical_qty !== null && i.physical_qty !== undefined).length;
    const matched = items.filter((i) => i.physical_qty !== null && i.variance === 0).length;
    const varianceItems = items.filter((i) => i.physical_qty !== null && i.variance !== 0);
    const varianceCount = varianceItems.length;
    const totalVarianceValue = varianceItems.reduce((s, i) => s + Math.abs(i.variance_value || 0), 0);
    const positiveVariance = varianceItems.filter((i) => i.variance > 0).length;
    const negativeVariance = varianceItems.filter((i) => i.variance < 0).length;
    return { total, counted, matched, varianceCount, totalVarianceValue, positiveVariance, negativeVariance };
  };

  // --- Actions ---
  const handleAction = async (action, successMsg) => {
    try {
      if (action === 'approve') {
        await api.post(`/inventory/audits/${id}/adjust`);
      } else {
        await api.put(`/inventory/stock-audits/${id}/${action}`);
      }
      message.success(successMsg);
      fetchRecord();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleDelete = async () => {
    try {
      await api.delete(`/inventory/stock-audits/${id}`);
      message.success('Audit deleted');
      navigate('/inventory/stock-audit');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // --- Submit ---
  const handleSubmit = async (submitAction = 'draft') => {
    try {
      const values = await form.validateFields();
      if (auditItems.length === 0) {
        message.error('No items to audit. Select a warehouse to populate items.');
        return;
      }
      setSubmitting(true);

      let status = 'draft';
      if (submitAction === 'in_progress') status = 'in_progress';
      if (submitAction === 'submit_approval') status = 'pending_approval';

      const payload = {
        ...values,
        audit_date: formatDateForAPI(values.audit_date),
        status,
        items: auditItems.map((item) => ({
          item_id: item.item_id,
          item_code: item.item_code,
          item_name: item.item_name,
          batch: item.batch,
          location: item.location,
          rack: item.rack,
          bin: item.bin,
          uom: item.uom,
          uom_id: item.uom_id,
          system_qty: item.system_qty,
          physical_qty: item.physical_qty ?? item.system_qty ?? 0,
          variance: item.variance,
          variance_value: item.variance_value,
          valuation_rate: item.valuation_rate,
          remarks: item.remarks,
        })),
      };

      if (!isNew) {
        await api.put(`/inventory/stock-audits/${id}`, payload);
        message.success('Audit updated successfully');
        setEditMode(false);
        fetchRecord();
      } else {
        const res = await api.post('/inventory/stock-audits', payload);
        const newId = res.data?.id;
        message.success('Audit created successfully');
        if (newId) {
          navigate(`/inventory/stock-audit/${newId}`);
        } else {
          navigate('/inventory/stock-audit');
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
      { title: 'Item Code', dataIndex: 'item_code', width: 100 },
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
      { title: 'Batch', dataIndex: 'batch', width: 80, render: (val) => val || '-' },
      { title: 'Location', dataIndex: 'location', width: 80, render: (val) => val || '-' },
      {
        title: 'System Qty',
        dataIndex: 'system_qty',
        width: 90,
        align: 'right',
        render: (val) => formatNumber(val || 0),
      },
      {
        title: 'Physical Qty',
        dataIndex: 'physical_qty',
        width: 100,
        align: 'right',
        render: (val) => {
          if (val === null || val === undefined) return <Text type="secondary">Not counted</Text>;
          return <Text strong>{formatNumber(val)}</Text>;
        },
      },
      {
        title: 'Variance',
        dataIndex: 'variance',
        width: 90,
        align: 'right',
        render: (val) => {
          if (!val || val === 0) return <Text type="secondary">0</Text>;
          if (val > 0) return <Text style={{ color: '#52c41a' }}>+{formatNumber(val)}</Text>;
          return <Text style={{ color: '#f5222d' }}>{formatNumber(val)}</Text>;
        },
      },
      {
        title: 'Variance Value',
        dataIndex: 'variance_value',
        width: 110,
        align: 'right',
        render: (val) => {
          if (!val || val === 0) return <Text type="secondary">-</Text>;
          const color = val > 0 ? '#52c41a' : '#f5222d';
          return <Text style={{ color }}>{formatCurrency(val)}</Text>;
        },
      },
      { title: 'Remarks', dataIndex: 'remarks', width: 120, render: (val) => val || '-' },
    ];

    const vs = getVarianceSummary(recordData.items || []);

    return (
      <div>
        <PageHeader
          title={recordData.audit_number || `Audit #${id}`}
          subtitle="Stock Audit Details"
        >
          <Space>
            {(recordData.status === 'draft' || recordData.status === 'in_progress') && (
              <>
                <Button icon={<EditOutlined />} onClick={() => setEditMode(true)} type="primary">
                  Edit
                </Button>
                <Popconfirm title="Submit audit for approval?" onConfirm={() => handleAction('submit', 'Submitted for approval')}>
                  <Button type="default" icon={<SendOutlined />}>Submit for Approval</Button>
                </Popconfirm>
              </>
            )}
            {recordData.status === 'draft' && (
              <Popconfirm title="Delete this audit?" onConfirm={handleDelete} okButtonProps={{ danger: true }}>
                <Button danger icon={<DeleteOutlined />}>Delete</Button>
              </Popconfirm>
            )}
            {recordData.status === 'pending_approval' && (
              <>
                <Popconfirm title="Approve adjustments and apply to stock ledger?" onConfirm={() => handleAction('approve', 'Adjustments approved and applied')}>
                  <Button type="primary" icon={<CheckOutlined />}>Approve Adjustments</Button>
                </Popconfirm>
                <Popconfirm title="Reject this audit?" onConfirm={() => handleAction('reject', 'Audit rejected')}>
                  <Button danger icon={<CloseCircleOutlined />}>Reject</Button>
                </Popconfirm>
              </>
            )}
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/inventory/stock-audit')}>
              Back
            </Button>
          </Space>
        </PageHeader>

        <Card style={{ marginBottom: 16 }}>
          <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }} bordered>
            <Descriptions.Item label="Audit No">{recordData.audit_number}</Descriptions.Item>
            <Descriptions.Item label="Warehouse">{recordData.warehouse_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Audit Date">{formatDate(recordData.audit_date)}</Descriptions.Item>
            <Descriptions.Item label="Audit Type">
              {AUDIT_TYPES.find((t) => t.value === recordData.audit_type)?.label || recordData.audit_type}
            </Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={recordData.status} /></Descriptions.Item>
            <Descriptions.Item label="Created By">{recordData.created_by || '-'}</Descriptions.Item>
            <Descriptions.Item label="Created At" span={2}>{formatDateTime(recordData.created_at)}</Descriptions.Item>
            <Descriptions.Item label="Remarks">{recordData.remarks || '-'}</Descriptions.Item>
          </Descriptions>
        </Card>

        <Card size="small" style={{ marginBottom: 16, background: '#fafafa' }}>
          <Row gutter={16}>
            <Col span={4}><Statistic title="Total Items" value={vs.total} /></Col>
            <Col span={4}><Statistic title="Matched" value={vs.matched} valueStyle={{ color: '#52c41a' }} /></Col>
            <Col span={4}>
              <Statistic title="Variance Items" value={vs.varianceCount} valueStyle={{ color: vs.varianceCount > 0 ? '#fa8c16' : undefined }} />
            </Col>
            <Col span={6}>
              <Statistic title="Total Variance Value" value={formatCurrency(vs.totalVarianceValue)} valueStyle={{ color: '#fa8c16' }} />
            </Col>
            <Col span={3}><Statistic title="Surplus" value={vs.positiveVariance} prefix={<ArrowUpOutlined />} valueStyle={{ color: '#52c41a' }} /></Col>
            <Col span={3}><Statistic title="Shortage" value={vs.negativeVariance} prefix={<ArrowDownOutlined />} valueStyle={{ color: '#f5222d' }} /></Col>
          </Row>
        </Card>

        <Card title="Audit Items">
          <Table
            columns={viewItemColumns}
            dataSource={recordData.items || []}
            rowKey="id"
            pagination={false}
            scroll={{ x: 1000 }}
            size="small"
            rowClassName={(record) => {
              if (record.physical_qty === null || record.physical_qty === undefined) return '';
              if (record.variance > 0) return 'audit-row-surplus';
              if (record.variance < 0) return 'audit-row-shortage';
              return 'audit-row-matched';
            }}
          />
        </Card>

        <style>{`
          .audit-row-surplus { background-color: #f6ffed !important; }
          .audit-row-surplus:hover > td { background-color: #d9f7be !important; }
          .audit-row-shortage { background-color: #fff1f0 !important; }
          .audit-row-shortage:hover > td { background-color: #ffccc7 !important; }
          .audit-row-matched { background-color: #fff !important; }
        `}</style>
      </div>
    );
  }

  // --- EDIT / CREATE MODE ---
  const auditItemColumns = [
    { title: '#', width: 35, render: (_, __, idx) => idx + 1 },
    { title: 'Item Code', dataIndex: 'item_code', width: 100 },
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
    { title: 'Batch', dataIndex: 'batch', width: 80, render: (val) => val || '-' },
    { title: 'Location', dataIndex: 'location', width: 80, render: (val) => val || '-' },
    { title: 'Rack', dataIndex: 'rack', width: 60, render: (val) => val || '-' },
    { title: 'Bin', dataIndex: 'bin', width: 60, render: (val) => val || '-' },
    {
      title: 'System Qty',
      dataIndex: 'system_qty',
      width: 90,
      align: 'right',
      render: (val) => <Text type="secondary">{formatNumber(val || 0)}</Text>,
    },
    {
      title: 'Physical Qty',
      dataIndex: 'physical_qty',
      width: 100,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateAuditItem(record.key, 'physical_qty', v)}
          style={{ width: '100%' }}
          size="small"
          placeholder="Count"
        />
      ),
    },
    {
      title: 'Variance',
      dataIndex: 'variance',
      width: 90,
      align: 'right',
      render: (val) => {
        if (val === 0 || val === null || val === undefined) {
          return <Text type="secondary">0</Text>;
        }
        if (val > 0) {
          return (
            <Text style={{ color: '#52c41a' }}>
              <ArrowUpOutlined /> +{formatNumber(val)}
            </Text>
          );
        }
        return (
          <Text style={{ color: '#f5222d' }}>
            <ArrowDownOutlined /> {formatNumber(val)}
          </Text>
        );
      },
    },
    {
      title: 'Variance Value',
      dataIndex: 'variance_value',
      width: 110,
      align: 'right',
      render: (val) => {
        if (!val || val === 0) return <Text type="secondary">-</Text>;
        const color = val > 0 ? '#52c41a' : '#f5222d';
        return <Text style={{ color }}>{formatCurrency(val)}</Text>;
      },
    },
    {
      title: 'Remarks',
      dataIndex: 'remarks',
      width: 120,
      render: (val, record) => (
        <Input
          value={val}
          onChange={(e) => updateAuditItem(record.key, 'remarks', e.target.value)}
          size="small"
          placeholder="Note..."
        />
      ),
    },
  ];

  const drawerVarianceSummary = getVarianceSummary(auditItems);

  return (
    <div>
      <PageHeader
        title={isNew ? 'Create Stock Audit' : `Edit Stock Audit`}
        subtitle="Manage physical stock audit details"
      >
        <Space>
          <Button onClick={() => handleSubmit('in_progress')} loading={submitting}>
            Save In Progress
          </Button>
          <Button onClick={() => handleSubmit('draft')} loading={submitting}>
            Save Draft
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
                navigate('/inventory/stock-audit');
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
            <Col span={8}>
              <Form.Item
                name="warehouse_id"
                label="Warehouse"
                rules={[{ required: true, message: 'Select warehouse' }]}
              >
                <Select
                  placeholder="Select warehouse"
                  options={warehouses}
                  showSearch
                  optionFilterProp="label"
                  onChange={(val) => populateWarehouseItems(val)}
                  disabled={!isNew}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="audit_date"
                label="Audit Date"
                rules={[{ required: true, message: 'Select date' }]}
              >
                <DatePicker format={DATE_FORMAT} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="audit_type"
                label="Audit Type"
                rules={[{ required: true, message: 'Select audit type' }]}
              >
                <Select options={AUDIT_TYPES} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item name="remarks" label="Remarks">
                <TextArea rows={2} placeholder="Audit notes..." />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      {auditItems.length > 0 && (
        <Card size="small" style={{ marginBottom: 16, background: '#fafafa' }}>
          <Row gutter={16}>
            <Col span={4}>
              <Statistic title="Total Items" value={drawerVarianceSummary.total} />
            </Col>
            <Col span={4}>
              <Statistic title="Counted" value={drawerVarianceSummary.counted} valueStyle={{ color: '#eb2f96' }} />
            </Col>
            <Col span={4}>
              <Statistic title="Matched" value={drawerVarianceSummary.matched} valueStyle={{ color: '#52c41a' }} />
            </Col>
            <Col span={4}>
              <Statistic
                title="Variance Items"
                value={drawerVarianceSummary.varianceCount}
                valueStyle={{ color: drawerVarianceSummary.varianceCount > 0 ? '#fa8c16' : undefined }}
              />
            </Col>
            <Col span={4}>
              <Statistic
                title="Surplus"
                value={drawerVarianceSummary.positiveVariance}
                prefix={<ArrowUpOutlined />}
                valueStyle={{ color: '#52c41a' }}
              />
            </Col>
            <Col span={4}>
              <Statistic
                title="Shortage"
                value={drawerVarianceSummary.negativeVariance}
                prefix={<ArrowDownOutlined />}
                valueStyle={{ color: '#f5222d' }}
              />
            </Col>
          </Row>
          {drawerVarianceSummary.totalVarianceValue > 0 && (
            <Alert
              message={`Total Variance Value: ${formatCurrency(drawerVarianceSummary.totalVarianceValue)}`}
              type="warning"
              showIcon
              icon={<ExclamationCircleOutlined />}
              style={{ marginTop: 12 }}
            />
          )}
        </Card>
      )}

      <Card title="Audit Items">
        <Table
          columns={auditItemColumns}
          dataSource={auditItems}
          rowKey="key"
          pagination={auditItems.length > 50 ? { pageSize: 50, showSizeChanger: true } : false}
          scroll={{ x: 1200 }}
          size="small"
          loading={loadingItems}
          rowClassName={(record) => {
            if (record.physical_qty === null || record.physical_qty === undefined) return '';
            if (record.variance > 0) return 'audit-row-surplus';
            if (record.variance < 0) return 'audit-row-shortage';
            return 'audit-row-matched';
          }}
        />
      </Card>

      <style>{`
        .audit-row-surplus { background-color: #f6ffed !important; }
        .audit-row-surplus:hover > td { background-color: #d9f7be !important; }
        .audit-row-shortage { background-color: #fff1f0 !important; }
        .audit-row-shortage:hover > td { background-color: #ffccc7 !important; }
        .audit-row-matched { background-color: #fff !important; }
      `}</style>
    </div>
  );
};

export default StockAuditForm;
