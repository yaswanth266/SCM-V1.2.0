import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Card, Form, Input, InputNumber, Select, DatePicker, Button, Space, message, Spin,
} from 'antd';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

// BUG-FIN-150: previously this page was a "under development" stub. The
// router exposes /accounts/payments/new and /accounts/payments/:id, so any
// click on Edit/New from the Payments list landed on a dead page. This
// implementation talks to the existing POST /accounts/payments and the
// new PUT /accounts/payments/{id} endpoint (BUG-FIN-037).

const { Option } = Select;

const PaymentForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [vendors, setVendors] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [partyType, setPartyType] = useState('vendor');

  const isEdit = Boolean(id);

  useEffect(() => {
    api.get('/masters/vendors', { params: { page_size: 200, status: 'active' } })
      .then((r) => setVendors(r.data.items || r.data.data || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isEdit) return;
    setLoading(true);
    api.get(`/accounts/payments/${id}`)
      .then((r) => {
        const p = r.data || {};
        form.setFieldsValue({
          ...p,
          payment_date: p.payment_date ? dayjs(p.payment_date) : null,
        });
        if (p.party_type) setPartyType(p.party_type);
      })
      .catch((e) => message.error(getErrorMessage(e)))
      .finally(() => setLoading(false));
  }, [id, isEdit, form]);

  const fetchInvoices = async (party_id) => {
    if (!party_id) { setInvoices([]); return; }
    try {
      const params = {
        party_type: partyType, party_id,
        status_in: 'submitted,partially_paid,overdue',  // BUG-FIN-047
        page_size: 100,
      };
      const r = await api.get('/accounts/invoices', { params });
      setInvoices(r.data.items || r.data.data || []);
    } catch { /* silent */ }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload = {
        ...values,
        party_type: partyType,
        payment_date: values.payment_date ? values.payment_date.format('YYYY-MM-DD') : undefined,
      };
      if (isEdit) {
        await api.put(`/accounts/payments/${id}`, payload);
        message.success('Payment updated');
      } else {
        await api.post('/accounts/payments', payload);
        message.success('Payment recorded');
      }
      navigate('/accounts/payments');
    } catch (e) {
      if (e?.errorFields) return;
      message.error(getErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <PageHeader title={isEdit ? 'Edit Payment' : 'Record Payment'} />
      <Card>
        <Spin spinning={loading}>
          <Form form={form} layout="vertical" initialValues={{ payment_type: 'pay', payment_mode: 'bank_transfer', party_type: 'vendor' }}>
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
              <Space size={12} wrap>
                <Form.Item name="payment_type" label="Type" rules={[{ required: true }]} style={{ minWidth: 150 }}>
                  <Select disabled={isEdit}>
                    <Option value="pay">Pay (vendor)</Option>
                    <Option value="receive">Receive (customer)</Option>
                  </Select>
                </Form.Item>
                <Form.Item label="Party" name="party_id" rules={[{ required: true }]} style={{ minWidth: 280 }}>
                  <Select
                    showSearch
                    optionFilterProp="children"
                    placeholder="Select vendor / customer"
                    onChange={fetchInvoices}
                    disabled={isEdit}
                  >
                    {vendors.map((v) => <Option key={v.id} value={v.id}>{v.name}</Option>)}
                  </Select>
                </Form.Item>
              </Space>
              <Space size={12} wrap>
                <Form.Item name="invoice_id" label="Invoice (optional)" style={{ minWidth: 280 }}>
                  <Select allowClear placeholder="Allocate to invoice" disabled={isEdit}>
                    {invoices.map((i) => (
                      <Option key={i.id} value={i.id}>
                        {i.invoice_number} — Bal {i.balance_amount}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
                <Form.Item name="amount" label="Amount" rules={[{ required: true, type: 'number', min: 0.01 }]} style={{ minWidth: 180 }}>
                  <InputNumber min={0.01} step={0.01} style={{ width: '100%' }} disabled={isEdit} />
                </Form.Item>
                <Form.Item name="payment_date" label="Date" rules={[{ required: true }]} style={{ minWidth: 180 }}>
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Space>
              <Space size={12} wrap>
                <Form.Item name="payment_mode" label="Mode" rules={[{ required: true }]} style={{ minWidth: 180 }}>
                  <Select>
                    <Option value="cash">Cash</Option>
                    <Option value="bank_transfer">Bank Transfer</Option>
                    <Option value="cheque">Cheque</Option>
                    <Option value="upi">UPI</Option>
                    <Option value="dd">DD</Option>
                    <Option value="advance">Advance</Option>
                  </Select>
                </Form.Item>
                <Form.Item name="reference_number" label="Reference #" style={{ minWidth: 220 }}>
                  <Input placeholder="UTR / cheque #" />
                </Form.Item>
                <Form.Item name="bank_account" label="Bank A/c" style={{ minWidth: 220 }}>
                  <Input />
                </Form.Item>
              </Space>
              <Form.Item name="remarks" label="Remarks">
                <Input.TextArea rows={2} />
              </Form.Item>
              <Space>
                <Button type="primary" loading={submitting} onClick={handleSubmit}>
                  {isEdit ? 'Update Payment' : 'Record Payment'}
                </Button>
                <Button onClick={() => navigate('/accounts/payments')}>Cancel</Button>
              </Space>
            </Space>
          </Form>
        </Spin>
      </Card>
    </div>
  );
};

export default PaymentForm;
