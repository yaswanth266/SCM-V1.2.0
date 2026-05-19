import React, { useState, useCallback } from 'react';
import {
  Button, Modal, Form, Input, InputNumber, Select, Space,
  Popconfirm, message, Card, Descriptions, Typography, Tooltip, Tag,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  CheckCircleOutlined, CloseCircleOutlined, SwapOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatDate, formatCurrency, getErrorMessage,
} from '../../utils/helpers';

const { TextArea } = Input;
const { Text } = Typography;

const REASON_OPTIONS = [
  { label: 'Goods Returned', value: 'goods_returned' },
  { label: 'Defective Goods', value: 'defective_goods' },
  { label: 'Price Adjustment', value: 'price_adjustment' },
  { label: 'Short Supply', value: 'short_supply' },
  { label: 'Billing Error', value: 'billing_error' },
  { label: 'Discount Given', value: 'discount_given' },
  { label: 'Other', value: 'other' },
];

const CreditNotes = () => {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCN, setEditingCN] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Lookups
  const [invoiceOptions, setInvoiceOptions] = useState([]);
  const [selectedInvoice, setSelectedInvoice] = useState(null);

  // Filter
  const [filterStatus, setFilterStatus] = useState(undefined);

  const loadInvoiceOptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/accounts/invoices', {
        params: { page_size: 50, search },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setInvoiceOptions(items.map((inv) => ({
        label: `${inv.invoice_number} | ${inv.party_name || ''} | ${formatCurrency(inv.grand_total || 0)}`,
        value: inv.id,
        invoice: inv,
      })));
    } catch {
      setInvoiceOptions([]);
    }
  }, []);

  const fetchCreditNotes = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      return await api.get('/accounts/credit-notes', { params: qp });
    },
    [filterStatus]
  );

  const handleAdd = () => {
    setEditingCN(null);
    setSelectedInvoice(null);
    form.resetFields();
    loadInvoiceOptions();
    setModalOpen(true);
  };

  const handleEdit = async (record) => {
    setEditingCN(record);
    loadInvoiceOptions();
    try {
      const res = await api.get(`/accounts/credit-notes/${record.id}`);
      const data = res.data;
      form.setFieldsValue({
        invoice_id: data.invoice_id,
        amount: data.amount,
        reason: data.reason,
        remarks: data.remarks,
      });
      if (data.invoice) {
        setSelectedInvoice(data.invoice);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
      return;
    }
    setModalOpen(true);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/accounts/credit-notes/${id}`);
      message.success('Credit note deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleInvoiceSelect = (invoiceId) => {
    if (!invoiceId) {
      setSelectedInvoice(null);
      return;
    }
    const found = invoiceOptions.find((o) => o.value === invoiceId);
    if (found && found.invoice) {
      setSelectedInvoice(found.invoice);
      // Pre-fill amount with the balance
      const balance = found.invoice.balance_amount != null
        ? found.invoice.balance_amount
        : (found.invoice.grand_total || 0) - (found.invoice.paid_amount || 0);
      form.setFieldsValue({ amount: balance > 0 ? balance : found.invoice.grand_total || 0 });
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      const payload = {
        ...values,
      };

      if (editingCN) {
        await api.put(`/accounts/credit-notes/${editingCN.id}`, payload);
        message.success('Credit note updated');
      } else {
        await api.post('/accounts/credit-notes', payload);
        message.success('Credit note created');
      }
      setModalOpen(false);
      form.resetFields();
      setEditingCN(null);
      setSelectedInvoice(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAction = async (id, action) => {
    try {
      await api.post(`/accounts/credit-notes/${id}/${action}`);
      const labels = {
        issue: 'issued',
        adjust: 'adjusted against invoice',
        cancel: 'cancelled',
      };
      message.success(`Credit note ${labels[action] || action}`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'CN Number',
      dataIndex: 'cn_number',
      key: 'cn_number',
      width: 160,
      sorter: true,
      fixed: 'left',
      render: (text) => <Text strong>{text}</Text>,
    },
    {
      title: 'Invoice Ref',
      dataIndex: 'invoice_number',
      key: 'invoice_number',
      width: 160,
      render: (val, r) => val || r.invoice_ref || '-',
    },
    {
      title: 'Party',
      dataIndex: 'party_name',
      key: 'party_name',
      width: 200,
      ellipsis: true,
      render: (val, r) => val || r.vendor_name || r.customer_name || '-',
    },
    {
      title: 'CN Date',
      dataIndex: 'cn_date',
      key: 'cn_date',
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
      render: (v) => <Text strong style={{ color: '#f5222d' }}>{formatCurrency(v)}</Text>,
    },
    {
      title: 'Reason',
      dataIndex: 'reason',
      key: 'reason',
      width: 160,
      render: (val) => {
        const found = REASON_OPTIONS.find((r) => r.value === val);
        return found ? found.label : (val || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View / Edit">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleEdit(record)} />
          </Tooltip>
          {(record.status === 'draft') && (
            <>
              <Tooltip title="Issue">
                <Popconfirm title="Issue this credit note?" onConfirm={() => handleAction(record.id, 'issue')}>
                  <Button type="link" size="small" style={{ color: '#52c41a' }} icon={<CheckCircleOutlined />} />
                </Popconfirm>
              </Tooltip>
              <Tooltip title="Edit">
                <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
              </Tooltip>
              <Popconfirm title="Delete this credit note?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
          {(record.status === 'issued' || record.status === 'active') && (
            <>
              <Tooltip title="Adjust against Invoice">
                <Popconfirm title="Adjust this credit note against the linked invoice?" onConfirm={() => handleAction(record.id, 'adjust')}>
                  <Button type="link" size="small" style={{ color: '#eb2f96' }} icon={<SwapOutlined />} />
                </Popconfirm>
              </Tooltip>
              <Tooltip title="Cancel">
                <Popconfirm title="Cancel this credit note?" onConfirm={() => handleAction(record.id, 'cancel')} okButtonProps={{ danger: true }}>
                  <Button type="link" size="small" danger icon={<CloseCircleOutlined />} />
                </Popconfirm>
              </Tooltip>
            </>
          )}
        </Space>
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 150 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Draft', value: 'draft' },
          { label: 'Issued', value: 'issued' },
          { label: 'Adjusted', value: 'adjusted' },
          { label: 'Cancelled', value: 'cancelled' },
        ]}
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="Credit Notes" subtitle="Manage credit and debit notes">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          Create Credit Note
        </Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchCreditNotes}
        rowKey="id"
        searchPlaceholder="Search by CN number, invoice, party..."
        exportFileName="credit_notes"
        toolbar={toolbar}
        scroll={{ x: 1300 }}
      />

      {/* Create / Edit Modal */}
      <Modal
        title={editingCN ? `Edit Credit Note ${editingCN.cn_number || ''}` : 'Create Credit Note'}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setEditingCN(null); form.resetFields(); setSelectedInvoice(null); }}
        onOk={handleSubmit}
        confirmLoading={submitting}
        okText={editingCN ? 'Update' : 'Create'}
        width={600}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="invoice_id"
            label="Select Invoice"
            rules={[{ required: true, message: 'Please select an invoice' }]}
          >
            <Select
              options={invoiceOptions}
              placeholder="Search and select invoice..."
              showSearch
              optionFilterProp="label"
              allowClear
              onChange={handleInvoiceSelect}
              onSearch={loadInvoiceOptions}
            />
          </Form.Item>

          {selectedInvoice && (
            <Card size="small" style={{ marginBottom: 16, background: '#f9f9f9' }}>
              <Descriptions size="small" column={2}>
                <Descriptions.Item label="Invoice">{selectedInvoice.invoice_number}</Descriptions.Item>
                <Descriptions.Item label="Party">{selectedInvoice.party_name || '-'}</Descriptions.Item>
                <Descriptions.Item label="Grand Total">{formatCurrency(selectedInvoice.grand_total)}</Descriptions.Item>
                <Descriptions.Item label="Balance">
                  <Text style={{ color: '#f5222d' }}>
                    {formatCurrency(
                      selectedInvoice.balance_amount != null
                        ? selectedInvoice.balance_amount
                        : (selectedInvoice.grand_total || 0) - (selectedInvoice.paid_amount || 0)
                    )}
                  </Text>
                </Descriptions.Item>
                <Descriptions.Item label="Status"><StatusTag status={selectedInvoice.status} /></Descriptions.Item>
                <Descriptions.Item label="Date">{formatDate(selectedInvoice.invoice_date)}</Descriptions.Item>
              </Descriptions>
            </Card>
          )}

          <Form.Item
            name="amount"
            label="Credit Note Amount"
            rules={[
              { required: true, message: 'Required' },
              {
                validator: (_, value) => {
                  if (value && selectedInvoice && value > (selectedInvoice.grand_total || 0)) {
                    return Promise.reject('Amount cannot exceed invoice grand total');
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <InputNumber
              min={0.01}
              style={{ width: '100%' }}
              formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
              parser={(v) => v.replace(/,/g, '')}
              placeholder="0.00"
            />
          </Form.Item>

          <Form.Item
            name="reason"
            label="Reason"
            rules={[{ required: true, message: 'Required' }]}
          >
            <Select
              options={REASON_OPTIONS}
              placeholder="Select reason"
            />
          </Form.Item>

          <Form.Item name="remarks" label="Remarks">
            <TextArea rows={3} placeholder="Additional details..." />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default CreditNotes;

