import React, { useState, useEffect } from 'react';
import {
  Card, Form, Input, InputNumber, Select, Button, Row, Col,
  message, Spin, Divider, Table, Space, Popconfirm, Switch, Upload,
  Typography, Modal,
} from 'antd';
import {
  SaveOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const { Title, Text } = Typography;

const SystemSettings = () => {
  const [loading, setLoading] = useState(true);
  const [generalForm] = Form.useForm();
  const [emailForm] = Form.useForm();
  const [numberForm] = Form.useForm();
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);
  const [savingNumber, setSavingNumber] = useState(false);
  const [numberSeries, setNumberSeries] = useState([]);
  const [editingNumber, setEditingNumber] = useState(null);
  const [numberModal, setNumberModal] = useState(false);

  useEffect(() => {
    fetchSettings();
    fetchNumberSeries();
  }, []);

  const fetchSettings = async () => {
    setLoading(true);
    try {
      const res = await api.get('/settings/system');
      const data = res.data;
      const settings = data.settings || data.data || data || {};
      generalForm.setFieldsValue({
        company_name: settings.company_name || '',
        company_logo: settings.company_logo || '',
        fiscal_year_start: settings.fiscal_year_start || 'april',
        date_format: settings.date_format || 'DD/MM/YYYY',
        currency: settings.currency || 'INR',
        timezone: settings.timezone || 'Asia/Kolkata',
        language: settings.language || 'en',
      });
      // BUG-AUTH-111 fix: never bind the plaintext smtp_password into the
      // form value. Backend now returns "***" for credential keys (BUG-
      // AUTH-109), so we explicitly leave the field blank and only PUT the
      // password when an admin actually types a new one.
      emailForm.setFieldsValue({
        smtp_host: settings.smtp_host || '',
        smtp_port: settings.smtp_port || 587,
        smtp_username: settings.smtp_username || '',
        smtp_password: '',
        from_email: settings.from_email || '',
        from_name: settings.from_name || '',
        smtp_ssl: settings.smtp_ssl || false,
      });
    } catch (err) {
      // BUG-AUTH-117 fix: previously this catch was silent so admins on a
      // misconfigured system never knew the GET failed — they'd save default
      // values and overwrite production settings. Surface a non-blocking
      // warning so the admin knows the form is showing defaults.
      const status = err?.response?.status;
      if (status === 403) {
        message.warning('You do not have permission to view system settings.');
      } else if (status && status >= 500) {
        message.error(getErrorMessage(err) || 'Failed to load system settings');
      } else if (status !== 404) {
        // Don't spam on the bootstrap 404 of an empty system_settings row.
        message.warning(getErrorMessage(err) || 'Could not load saved settings; showing defaults');
      }
    } finally {
      setLoading(false);
    }
  };

  const fetchNumberSeries = async () => {
    try {
      const res = await api.get('/settings/number-series', { params: { page_size: 200 } });
      const data = res.data;
      setNumberSeries(data.items || data.data || data || []);
    } catch {
      setNumberSeries([]);
    }
  };

  const handleSaveGeneral = async () => {
    try {
      const values = await generalForm.validateFields();
      setSavingGeneral(true);
      await api.put('/settings/system/general', values);
      message.success('General settings saved successfully');
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSavingGeneral(false);
    }
  };

  const handleSaveEmail = async () => {
    try {
      const values = await emailForm.validateFields();
      setSavingEmail(true);
      // BUG-AUTH-111 fix: don't overwrite stored smtp_password when admin
      // leaves it blank (input wasn't pre-filled from server).
      if (!values.smtp_password) {
        delete values.smtp_password;
      }
      await api.put('/settings/system/email', values);
      message.success('Email settings saved successfully');
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSavingEmail(false);
    }
  };

  const handleSaveNumber = async () => {
    try {
      const values = await numberForm.validateFields();
      setSavingNumber(true);
      if (editingNumber) {
        await api.put(`/settings/number-series/${editingNumber.id}`, values);
        message.success('Number series updated');
      } else {
        await api.post('/settings/number-series', values);
        message.success('Number series created');
      }
      setNumberModal(false);
      numberForm.resetFields();
      setEditingNumber(null);
      fetchNumberSeries();
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSavingNumber(false);
    }
  };

  const handleDeleteNumber = async (id) => {
    try {
      await api.delete(`/settings/number-series/${id}`);
      message.success('Number series deleted');
      fetchNumberSeries();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleEditNumber = (record) => {
    setEditingNumber(record);
    numberForm.setFieldsValue(record);
    setNumberModal(true);
  };

  const handleAddNumber = () => {
    setEditingNumber(null);
    numberForm.resetFields();
    numberForm.setFieldsValue({ pad_length: 5, current_number: 0 });
    setNumberModal(true);
  };

  const numberColumns = [
    { title: 'Prefix', dataIndex: 'prefix', key: 'prefix', width: 120 },
    { title: 'Module', dataIndex: 'module', key: 'module', width: 130, render: (v) => v ? v.charAt(0).toUpperCase() + v.slice(1) : '-' },
    { title: 'Document Type', dataIndex: 'document_type', key: 'document_type', width: 160, render: (v) => v ? v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '-' },
    { title: 'Current Number', dataIndex: 'current_number', key: 'current_number', width: 130, align: 'right' },
    { title: 'Pad Length', dataIndex: 'pad_length', key: 'pad_length', width: 100, align: 'right' },
    {
      title: 'Preview', key: 'preview', width: 150,
      render: (_, record) => {
        const next = (record.current_number || 0) + 1;
        return <Text code>{record.prefix}{String(next).padStart(record.pad_length || 5, '0')}</Text>;
      },
    },
    {
      title: 'Actions', key: 'actions', width: 100,
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEditNumber(record)} />
          <Popconfirm
            title="Delete this number series?"
            onConfirm={() => handleDeleteNumber(record.id)}
            okText="Delete"
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
      <PageHeader title="System Settings" subtitle="Configure system-wide settings" />

      <Spin spinning={loading}>
        {/* Number Series Section */}
        <Card
          title="Number Series"
          bordered={false}
          style={{ marginBottom: 24 }}
          extra={
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleAddNumber}>
              Add Series
            </Button>
          }
        >
          <Table
            columns={numberColumns}
            dataSource={numberSeries}
            rowKey="id"
            size="small"
            pagination={false}
            scroll={{ x: 800 }}
          />
        </Card>

        {/* General Settings */}
        <Card
          title="General Settings"
          bordered={false}
          style={{ marginBottom: 24 }}
          extra={
            <Button type="primary" icon={<SaveOutlined />} onClick={handleSaveGeneral} loading={savingGeneral}>
              Save General
            </Button>
          }
        >
          <Form form={generalForm} layout="vertical">
            <Row gutter={16}>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="company_name" label="Company Name" rules={[{ required: true }]}>
                  <Input placeholder="Enter company name" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="fiscal_year_start" label="Fiscal Year Start">
                  <Select
                    options={[
                      { label: 'January', value: 'january' },
                      { label: 'April', value: 'april' },
                      { label: 'July', value: 'july' },
                      { label: 'October', value: 'october' },
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="date_format" label="Date Format">
                  <Select
                    options={[
                      { label: 'DD/MM/YYYY', value: 'DD/MM/YYYY' },
                      { label: 'MM/DD/YYYY', value: 'MM/DD/YYYY' },
                      { label: 'YYYY-MM-DD', value: 'YYYY-MM-DD' },
                      { label: 'DD-MMM-YYYY', value: 'DD-MMM-YYYY' },
                    ]}
                  />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={16}>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="currency" label="Default Currency">
                  <Select
                    showSearch
                    options={[
                      { label: 'INR - Indian Rupee', value: 'INR' },
                      { label: 'USD - US Dollar', value: 'USD' },
                      { label: 'EUR - Euro', value: 'EUR' },
                      { label: 'GBP - British Pound', value: 'GBP' },
                      { label: 'AED - UAE Dirham', value: 'AED' },
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="timezone" label="Timezone">
                  <Select
                    showSearch
                    options={[
                      { label: 'Asia/Kolkata (IST)', value: 'Asia/Kolkata' },
                      { label: 'UTC', value: 'UTC' },
                      { label: 'America/New_York (EST)', value: 'America/New_York' },
                      { label: 'Europe/London (GMT)', value: 'Europe/London' },
                      { label: 'Asia/Dubai (GST)', value: 'Asia/Dubai' },
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="language" label="Language">
                  <Select
                    options={[
                      { label: 'English', value: 'en' },
                      { label: 'Hindi', value: 'hi' },
                    ]}
                  />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={16}>
              <Col xs={24} sm={12}>
                <Form.Item
                  name="company_logo"
                  label="Company Logo URL"
                  // BUG-AUTH-115 fix: the company_logo value is rendered
                  // back as an <img src=...>; rejecting javascript:/data:
                  // URLs at the form layer is defense-in-depth on top of
                  // backend sanitization.
                  rules={[
                    {
                      validator: (_, value) => {
                        if (!value) return Promise.resolve();
                        const v = String(value).trim().toLowerCase();
                        if (v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:text/html')) {
                          return Promise.reject(new Error('Logo URL must be http(s) or a relative path'));
                        }
                        if (!/^(https?:\/\/|\/)/i.test(v)) {
                          return Promise.reject(new Error('Logo URL must start with http://, https:// or /'));
                        }
                        return Promise.resolve();
                      },
                    },
                  ]}
                >
                  <Input placeholder="https://example.com/logo.png" />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>

        {/* Email Settings */}
        <Card
          title="Email Settings (SMTP)"
          bordered={false}
          style={{ marginBottom: 24 }}
          extra={
            <Button type="primary" icon={<SaveOutlined />} onClick={handleSaveEmail} loading={savingEmail}>
              Save Email
            </Button>
          }
        >
          <Form form={emailForm} layout="vertical">
            <Row gutter={16}>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="smtp_host" label="SMTP Host" rules={[{ required: true }]}>
                  <Input placeholder="e.g. smtp.gmail.com" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={4}>
                <Form.Item name="smtp_port" label="Port" rules={[{ required: true }]}>
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder="587" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={4}>
                <Form.Item name="smtp_ssl" label="Use SSL/TLS" valuePropName="checked">
                  <Switch />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={16}>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="smtp_username" label="Username" rules={[{ required: true }]}>
                  <Input placeholder="SMTP username" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="smtp_password" label="Password" extra="Leave blank to keep existing">
                  <Input.Password placeholder="Enter only to change" autoComplete="new-password" />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={16}>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="from_email" label="From Email" rules={[{ required: true, type: 'email' }]}>
                  <Input placeholder="noreply@company.com" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="from_name" label="From Name">
                  <Input placeholder="Company Name" />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>
      </Spin>

      {/* Number Series Modal */}
      <Modal
        title={editingNumber ? 'Edit Number Series' : 'Add Number Series'}
        open={numberModal}
        onCancel={() => { setNumberModal(false); setEditingNumber(null); numberForm.resetFields(); }}
        onOk={handleSaveNumber}
        confirmLoading={savingNumber}
        okText={editingNumber ? 'Update' : 'Create'}
        destroyOnHidden
      >
        <Form form={numberForm} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="prefix" label="Prefix" rules={[{ required: true, message: 'Prefix is required' }, { max: 20, message: 'Prefix must be at most 20 characters' }]}>
                <Input placeholder="e.g. PO-" maxLength={20} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="module" label="Module" rules={[{ required: true }]}>
                <Select
                  placeholder="Select module"
                  options={[
                    { label: 'Masters', value: 'masters' },
                    { label: 'Procurement', value: 'procurement' },
                    { label: 'Warehouse', value: 'warehouse' },
                    { label: 'Inventory', value: 'inventory' },
                    { label: 'Outbound', value: 'outbound' },
                    { label: 'Indent', value: 'indent' },
                    { label: 'Consumption', value: 'consumption' },
                    { label: 'Accounts', value: 'accounts' },
                    { label: 'Assets', value: 'assets' },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="document_type" label="Document Type" rules={[{ required: true }]}>
                <Select
                  placeholder="Select type"
                  options={[
                    { label: 'Purchase Order', value: 'purchase_order' },
                    { label: 'Material Request', value: 'material_request' },
                    { label: 'Quotation', value: 'quotation' },
                    { label: 'GRN', value: 'grn' },
                    { label: 'Sales Order', value: 'sales_order' },
                    { label: 'Invoice', value: 'invoice' },
                    { label: 'Delivery Order', value: 'delivery_order' },
                    { label: 'Stock Transfer', value: 'stock_transfer' },
                    { label: 'Stock Audit', value: 'stock_audit' },
                    { label: 'Indent', value: 'indent' },
                    { label: 'Consumption Entry', value: 'consumption_entry' },
                    { label: 'Payment', value: 'payment' },
                    { label: 'Credit Note', value: 'credit_note' },
                    { label: 'Asset', value: 'asset' },
                    { label: 'Gate Entry', value: 'gate_entry' },
                    { label: 'Quality Inspection', value: 'quality_inspection' },
                    { label: 'Putaway', value: 'putaway' },
                    { label: 'Wave', value: 'wave' },
                    { label: 'Item', value: 'item' },
                  ]}
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="current_number" label="Current Number">
                <InputNumber min={0} style={{ width: '100%' }} placeholder="0" />
              </Form.Item>
            </Col>
          </Row>
          {/* BUG-AUTH-118 fix: cap pad_length at 8 (was 10) so that even the
              longest prefix combined with the padded sequence cannot
              overflow the VARCHAR(50) document_number column downstream.
              Prefix input is also bounded explicitly. */}
          <Form.Item name="pad_length" label="Pad Length" rules={[{ required: true }, { type: 'number', min: 1, max: 8, message: 'Pad length must be between 1 and 8' }]}>
            <InputNumber min={1} max={8} style={{ width: '100%' }} placeholder="5" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default SystemSettings;

