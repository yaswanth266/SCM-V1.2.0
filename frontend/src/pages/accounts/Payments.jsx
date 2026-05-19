import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Divider,
  Typography, Tooltip, Tag, Switch,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  DollarOutlined, BankOutlined, WalletOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatDate, formatCurrency, getErrorMessage, formatDateForAPI,
} from '../../utils/helpers';
import { DATE_FORMAT, PAYMENT_MODES } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const PAYMENT_TYPE_OPTIONS = [
  { label: 'Make Payment', value: 'pay' },
];

const Payments = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingPayment, setEditingPayment] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterPaymentType, setFilterPaymentType] = useState(undefined);
  const [filterPaymentMode, setFilterPaymentMode] = useState(undefined);
  const [filterDateRange, setFilterDateRange] = useState(null);

  // Lookups
  const [vendors, setVendors] = useState([]);
  const [projects, setProjects] = useState([]);
  const [poOptions, setPoOptions] = useState([]);
  const [invoiceOptions, setInvoiceOptions] = useState([]);

  // Form state
  const [paymentType, setPaymentType] = useState('pay');
  const [partyType, setPartyType] = useState('vendor');
  const [selectedPartyId, setSelectedPartyId] = useState(null);
  const [isAdvance, setIsAdvance] = useState(false);

  const loadLookups = useCallback(async () => {
    try {
      const [vendorRes, projRes] = await Promise.allSettled([
        api.get('/masters/vendors', { params: { page_size: 200, status: 'active' } }),
        api.get('/masters/projects', { params: { page_size: 200 } }),
      ]);
      if (vendorRes.status === 'fulfilled') {
        const d = vendorRes.value.data;
        const items = d.items || d.data || d || [];
        setVendors(items.map((v) => ({ label: `[${v.vendor_code || v.code}] ${v.name}`, value: v.id })));
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

  const loadInvoicesForParty = useCallback(async (partyId, pType) => {
    if (!partyId) {
      setInvoiceOptions([]);
      return;
    }
    try {
      const params = {
        page_size: 100,
        party_id: partyId,
        status_in: 'unpaid,partially_paid,overdue',
      };
      params.invoice_type = 'purchase';
      const res = await api.get('/accounts/invoices', { params });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setInvoiceOptions(items.map((inv) => {
        const balance = inv.balance_amount != null
          ? inv.balance_amount
          : (inv.grand_total || 0) - (inv.paid_amount || 0);
        return {
          label: `${inv.invoice_number} | Total: ${formatCurrency(inv.grand_total)} | Balance: ${formatCurrency(balance)}`,
          value: inv.id,
          invoice: inv,
          balance,
        };
      }));
    } catch {
      setInvoiceOptions([]);
    }
  }, []);

  const loadPOOptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/procurement/purchase-orders', {
        params: { page_size: 50, search },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setPoOptions(items.map((po) => ({
        label: `${po.po_number} - ${po.vendor_name || ''}`,
        value: po.id,
      })));
    } catch {
      // silent
    }
  }, []);

  const fetchPayments = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterPaymentType) qp.payment_type = filterPaymentType;
      if (filterPaymentMode) qp.payment_mode = filterPaymentMode;
      if (filterDateRange && filterDateRange[0]) {
        qp.date_from = formatDateForAPI(filterDateRange[0]);
        qp.date_to = formatDateForAPI(filterDateRange[1]);
      }
      return await api.get('/accounts/payments', { params: qp });
    },
    [filterPaymentType, filterPaymentMode, filterDateRange]
  );

  const handleAdd = () => {
    setEditingPayment(null);
    setPaymentType('pay');
    setPartyType('vendor');
    setSelectedPartyId(null);
    setIsAdvance(false);
    setInvoiceOptions([]);
    form.resetFields();
    form.setFieldsValue({
      payment_type: 'pay',
      payment_date: dayjs(),
      payment_mode: 'bank_transfer',
      is_advance: false,
    });
    loadLookups();
    loadPOOptions();
    setDrawerOpen(true);
  };

  const handleEdit = async (record) => {
    setEditingPayment(record);
    loadLookups();
    loadPOOptions();
    try {
      const res = await api.get(`/accounts/payments/${record.id}`);
      const data = res.data;
      setPaymentType(data.payment_type || 'pay');
      setPartyType(data.party_type || 'vendor');
      setIsAdvance(data.is_advance || false);
      setSelectedPartyId(data.party_id);
      form.setFieldsValue({
        ...data,
        payment_date: data.payment_date ? dayjs(data.payment_date) : null,
      });
      if (data.party_id) {
        loadInvoicesForParty(data.party_id, data.party_type || 'vendor');
      }
    } catch (err) {
      message.error(getErrorMessage(err));
      return;
    }
    setDrawerOpen(true);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/accounts/payments/${id}`);
      message.success('Payment deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handlePartyChange = (partyId) => {
    setSelectedPartyId(partyId);
    form.setFieldsValue({ invoice_id: undefined });
    loadInvoicesForParty(partyId, partyType);
  };

  const handleInvoiceSelect = (invoiceId) => {
    if (!invoiceId) return;
    const found = invoiceOptions.find((o) => o.value === invoiceId);
    if (found && found.balance > 0) {
      form.setFieldsValue({ amount: found.balance });
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      const payload = {
        ...values,
        payment_type: paymentType,
        party_type: partyType,
        payment_date: formatDateForAPI(values.payment_date),
        is_advance: isAdvance,
      };

      if (editingPayment) {
        await api.put(`/accounts/payments/${editingPayment.id}`, payload);
        message.success('Payment updated');
      } else {
        await api.post('/accounts/payments', payload);
        message.success('Payment recorded');
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingPayment(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const columns = [
    {
      title: 'Payment Number',
      dataIndex: 'payment_number',
      key: 'payment_number',
      width: 160,
      sorter: true,
      fixed: 'left',
      render: (text) => <Text strong>{text}</Text>,
    },
    {
      title: 'Type',
      dataIndex: 'payment_type',
      key: 'payment_type',
      width: 110,
      render: (val) => (
        <Tag color={val === 'receive' ? 'green' : 'blue'} icon={val === 'receive' ? <WalletOutlined /> : <BankOutlined />}>
          {val === 'receive' ? 'Receive' : 'Pay'}
        </Tag>
      ),
    },
    {
      title: 'Party',
      dataIndex: 'party_name',
      key: 'party_name',
      width: 200,
      ellipsis: true,
      render: (val, r) => val || r.vendor_name || '-',
    },
    {
      title: 'Invoice Ref',
      dataIndex: 'invoice_number',
      key: 'invoice_ref',
      width: 150,
      render: (val, r) => val || r.invoice_ref || '-',
    },
    {
      title: 'Payment Date',
      dataIndex: 'payment_date',
      key: 'payment_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      width: 140,
      align: 'right',
      sorter: true,
      render: (v) => <Text strong>{formatCurrency(v)}</Text>,
    },
    {
      title: 'Mode',
      dataIndex: 'payment_mode',
      key: 'payment_mode',
      width: 130,
      render: (val) => {
        const found = PAYMENT_MODES.find((m) => m.value === val);
        return found ? found.label : (val || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      },
    },
    {
      title: 'Advance',
      dataIndex: 'is_advance',
      key: 'is_advance',
      width: 90,
      align: 'center',
      render: (val) => val ? <Tag color="purple">Advance</Tag> : <Text type="secondary">-</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleEdit(record)} />
          </Tooltip>
          {(record.status === 'draft') && (
            <>
              <Tooltip title="Edit">
                <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
              </Tooltip>
              <Popconfirm title="Delete this payment?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <Select
        placeholder="Payment Type"
        allowClear
        style={{ width: 140 }}
        value={filterPaymentType}
        onChange={(v) => { setFilterPaymentType(v); setRefreshKey((k) => k + 1); }}
        options={PAYMENT_TYPE_OPTIONS}
      />
      <Select
        placeholder="Mode"
        allowClear
        style={{ width: 140 }}
        value={filterPaymentMode}
        onChange={(v) => { setFilterPaymentMode(v); setRefreshKey((k) => k + 1); }}
        options={PAYMENT_MODES}
      />
      <DatePicker.RangePicker
        value={filterDateRange}
        onChange={(v) => { setFilterDateRange(v); setRefreshKey((k) => k + 1); }}
        format={DATE_FORMAT}
        placeholder={['From Date', 'To Date']}
        style={{ width: 240 }}
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="Payments" subtitle="Record and manage payments">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          Record Payment
        </Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchPayments}
        rowKey="id"
        searchPlaceholder="Search by payment number, party..."
        exportFileName="payments"
        toolbar={toolbar}
        scroll={{ x: 1500 }}
      />

      {/* Record / Edit Drawer */}
      <Drawer
        title={editingPayment ? `Edit Payment ${editingPayment.payment_number}` : 'Record Payment'}
        width={700}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setEditingPayment(null); form.resetFields(); setInvoiceOptions([]); }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); setEditingPayment(null); form.resetFields(); }}>
              Cancel
            </Button>
            <Button type="primary" onClick={handleSubmit} loading={submitting}>
              {editingPayment ? 'Update Payment' : 'Record Payment'}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item
                name="party_id"
                label="Vendor"
                rules={[{ required: true, message: 'Required' }]}
              >
                <Select
                  options={vendors}
                  placeholder="Select vendor"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  onChange={handlePartyChange}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={24}>
              <Form.Item name="invoice_id" label="Invoice (shows unpaid/partial invoices)">
                <Select
                  options={invoiceOptions}
                  placeholder={selectedPartyId ? 'Select invoice (optional)' : 'Select a party first'}
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  disabled={!selectedPartyId || isAdvance}
                  onChange={handleInvoiceSelect}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="po_id" label="PO Link">
                <Select
                  options={poOptions}
                  placeholder="Link to PO"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  onSearch={loadPOOptions}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="project_id" label="Project">
                <Select options={projects} placeholder="Project" allowClear showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
          </Row>

          <Divider />

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="amount" label="Amount" rules={[{ required: true, message: 'Required' }]}>
                <InputNumber
                  min={0.01}
                  style={{ width: '100%' }}
                  formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
                  parser={(v) => v.replace(/,/g, '')}
                  placeholder="0.00"
                  prefix={<DollarOutlined />}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="payment_mode" label="Payment Mode" rules={[{ required: true, message: 'Required' }]}>
                <Select options={PAYMENT_MODES} placeholder="Select mode" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="payment_date" label="Payment Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="reference_number" label="Reference Number">
                <Input placeholder="Cheque no. / UTR / Txn ID" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="bank_account" label="Bank Account">
                <Input placeholder="Bank account details" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="is_advance" label="Advance Payment" valuePropName="checked">
                <Switch
                  checked={isAdvance}
                  onChange={(v) => {
                    setIsAdvance(v);
                    if (v) form.setFieldsValue({ invoice_id: undefined });
                  }}
                  checkedChildren="Yes"
                  unCheckedChildren="No"
                />
              </Form.Item>
            </Col>
          </Row>

          <Divider />

          <Form.Item name="remarks" label="Remarks">
            <TextArea rows={2} placeholder="Payment notes..." />
          </Form.Item>
        </Form>

        {/* Quick info panel */}
        {invoiceOptions.length > 0 && selectedPartyId && !isAdvance && (
          <Card size="small" title="Outstanding Invoices Summary" style={{ marginTop: 16, background: '#fffbe6' }}>
            <Row gutter={16}>
              <Col span={8}>
                <Text type="secondary">Total Invoices</Text>
                <div><Text strong>{invoiceOptions.length}</Text></div>
              </Col>
              <Col span={8}>
                <Text type="secondary">Total Outstanding</Text>
                <div>
                  <Text strong style={{ color: '#f5222d' }}>
                    {formatCurrency(invoiceOptions.reduce((sum, o) => sum + (o.balance || 0), 0))}
                  </Text>
                </div>
              </Col>
              <Col span={8}>
                <Text type="secondary">Advance Balance</Text>
                <div><Text strong style={{ color: '#52c41a' }}>{formatCurrency(0)}</Text></div>
              </Col>
            </Row>
          </Card>
        )}
      </Drawer>
    </div>
  );
};

export default Payments;

