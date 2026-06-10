import React, { useState, useEffect } from 'react';
import {
  Card, Form, Input, InputNumber, Select, Switch, Space, Button, message, Row, Col, Tabs, Spin,
} from 'antd';
import { ArrowLeftOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat',
  'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh',
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Lakshadweep', 'Puducherry'
];

const VendorForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formErrors, setFormErrors] = useState([]);

  // Dropdown options
  const [vendorTypeOptions, setVendorTypeOptions] = useState([]);
  const [vendorCategoryOptions, setVendorCategoryOptions] = useState([]);

  const loadLookups = async () => {
    try {
      const [typeRes, catRes] = await Promise.all([
        api.get('/masters/vendor-types', { params: { page_size: 200 } }),
        api.get('/masters/vendor-categories', { params: { page_size: 200 } })
      ]);
      const types = typeRes.data?.items || typeRes.data?.data || typeRes.data || [];
      const cats = catRes.data?.items || catRes.data?.data || catRes.data || [];

      setVendorTypeOptions(types.filter(t => t.status !== 'inactive').map(t => ({ label: t.name, value: t.id })));
      setVendorCategoryOptions(cats.filter(c => c.status !== 'inactive').map(c => ({ label: c.name, value: c.id })));
    } catch (err) {
      console.error('Failed to load lookups', err);
    }
  };

  const fetchVendor = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/masters/vendors/${id}`);
      const data = res.data;
      form.setFieldsValue({
        ...data,
        status: data.is_active === false ? 'inactive' : 'active',
        vendor_type_ids: (data.vendor_types || []).map(t => t.id),
        vendor_category_id: data.vendor_category_id || data.vendor_category?.id
      });
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/masters/vendors');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLookups();
    if (!isNew) {
      fetchVendor();
    } else {
      form.setFieldsValue({
        status: 'active',
        country: 'India',
        is_transport_vendor: false,
        is_active: true
      });
    }
  }, [id, isNew]);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const payload = {
        ...values,
        is_active: values.status === 'inactive' ? false : true,
      };

      setSubmitting(true);
      if (isNew) {
        await api.post('/masters/vendors', payload);
        message.success('Vendor created successfully');
      } else {
        await api.put(`/masters/vendors/${id}`, payload);
        message.success('Vendor updated successfully');
      }
      navigate('/masters/vendors');
    } catch (err) {
      if (err.errorFields) {
        setFormErrors(err.errorFields);
        message.error('Please correct errors before saving');
        return;
      }
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const hasTabErrors = (tabKey) => {
    const tabFields = {
      basic: ['vendor_code', 'name', 'contact_person', 'email', 'phone', 'alt_phone', 'status'],
      address: ['address_line1', 'address_line2', 'city', 'state', 'pincode', 'country'],
      tax_bank: ['gst_number', 'pan_number', 'bank_name', 'bank_account', 'bank_ifsc'],
      terms: ['payment_terms_days', 'credit_limit', 'vendor_type_ids', 'vendor_category_id', 'is_transport_vendor']
    };
    const errors = formErrors.map(e => e.name[0]);
    return errors.some(e => tabFields[tabKey].includes(e));
  };

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}><Spin size="large" /></div>;
  }

  return (
    <div>
      <PageHeader title={isNew ? 'Create Vendor' : 'Edit Vendor'} subtitle="Manage supplier contact and financial parameters">
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/masters/vendors')}>Back to Vendors</Button>
          <Button type="primary" onClick={handleSubmit} loading={submitting}>
            {isNew ? 'Create' : 'Save'}
          </Button>
        </Space>
      </PageHeader>
      <Card>
        <Form
          form={form}
          layout="vertical"
          scrollToFirstError={true}
          onFieldsChange={() => {
            setFormErrors(form.getFieldsError().filter(f => f.errors.length > 0));
          }}
        >
          <Tabs
            defaultActiveKey="basic"
            items={[
              {
                key: 'basic',
                label: (
                  <Space>
                    <span>Basic</span>
                    {hasTabErrors('basic') && (
                      <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 13 }} />
                    )}
                  </Space>
                ),
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item
                          name="vendor_code"
                          label="Vendor Code"
                          rules={[
                            { required: true, message: 'Vendor Code is required' },
                            { pattern: /^[A-Za-z0-9-_]+$/, message: 'Vendor Code must be alphanumeric without spaces' }
                          ]}
                        >
                          <Input placeholder="e.g. VND-001" style={{ textTransform: 'uppercase' }} onChange={(e) => form.setFieldsValue({ vendor_code: e.target.value.toUpperCase() })} />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item
                          name="name"
                          label="Vendor Name"
                          rules={[
                            { required: true, message: 'Vendor Name is required' },
                            { min: 3, message: 'Name must be at least 3 characters' },
                            { max: 100, message: 'Name must not exceed 100 characters' }
                          ]}
                        >
                          <Input placeholder="Enter vendor name" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="contact_person" label="Contact Person">
                          <Input placeholder="Contact person name" />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="email" label="Email" rules={[{ type: 'email', message: 'Please enter a valid email address' }]}>
                          <Input placeholder="email@example.com" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="phone" label="Phone" rules={[{ pattern: /^[0-9+\-\s()]{6,20}$/, message: 'Please enter a valid phone number (6-20 digits)' }]}>
                          <Input placeholder="Phone number" />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="alt_phone" label="Alt Phone" rules={[{ pattern: /^[0-9+\-\s()]{6,20}$/, message: 'Please enter a valid alternate phone number' }]}>
                          <Input placeholder="Alternate phone" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item name="status" label="Status" initialValue="active">
                      <Select
                        options={[
                          { label: 'Active', value: 'active' },
                          { label: 'Inactive', value: 'inactive' },
                        ]}
                      />
                    </Form.Item>
                  </>
                ),
              },
              {
                key: 'address',
                label: (
                  <Space>
                    <span>Address</span>
                    {hasTabErrors('address') && (
                      <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 13 }} />
                    )}
                  </Space>
                ),
                children: (
                  <>
                    <Form.Item name="address_line1" label="Address Line 1">
                      <Input placeholder="Street address" />
                    </Form.Item>
                    <Form.Item name="address_line2" label="Address Line 2">
                      <Input placeholder="Apartment, suite, etc." />
                    </Form.Item>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item name="city" label="City">
                          <Input placeholder="City" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="state" label="State">
                          <Select placeholder="Select state" allowClear showSearch options={STATES.map((s) => ({ label: s, value: s }))} />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="pincode" label="Pincode" rules={[{ pattern: /^[0-9]{5,10}$/, message: 'Pincode must be between 5 and 10 digits' }]}>
                          <Input placeholder="Pincode" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Form.Item name="country" label="Country" initialValue="India">
                      <Input placeholder="Country" />
                    </Form.Item>
                  </>
                ),
              },
              {
                key: 'tax_bank',
                label: (
                  <Space>
                    <span>Tax & Bank</span>
                    {hasTabErrors('tax_bank') && (
                      <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 13 }} />
                    )}
                  </Space>
                ),
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item
                          name="gst_number"
                          label="GST Number"
                          rules={[{ pattern: /^[0-9]{2}[A-Z0-9]{10}[A-Z0-9]{3}$/, message: 'Enter a valid 15-character GSTIN' }]}
                        >
                          <Input placeholder="GSTIN" style={{ textTransform: 'uppercase' }} onChange={(e) => form.setFieldsValue({ gst_number: e.target.value.toUpperCase() })} />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item
                          name="pan_number"
                          label="PAN Number"
                          rules={[{ pattern: /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, message: 'Enter a valid 10-character PAN number' }]}
                        >
                          <Input placeholder="PAN" style={{ textTransform: 'uppercase' }} onChange={(e) => form.setFieldsValue({ pan_number: e.target.value.toUpperCase() })} />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item name="bank_name" label="Bank Name">
                          <Input placeholder="Bank name" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item
                          name="bank_account"
                          label="Bank Account No"
                          rules={[{ pattern: /^[0-9]{9,18}$/, message: 'Bank Account Number must be between 9 and 18 numeric digits' }]}
                        >
                          <Input placeholder="Account number" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item
                          name="bank_ifsc"
                          label="Bank IFSC"
                          rules={[{ pattern: /^[A-Z]{4}0[A-Z0-9]{6}$/, message: 'Enter a valid 11-character IFSC code' }]}
                        >
                          <Input placeholder="IFSC code" style={{ textTransform: 'uppercase' }} onChange={(e) => form.setFieldsValue({ bank_ifsc: e.target.value.toUpperCase() })} />
                        </Form.Item>
                      </Col>
                    </Row>
                  </>
                ),
              },
              {
                key: 'terms',
                label: (
                  <Space>
                    <span>Terms</span>
                    {hasTabErrors('terms') && (
                      <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 13 }} />
                    )}
                  </Space>
                ),
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="payment_terms_days" label="Payment Terms (days)">
                          <InputNumber
                            min={0}
                            max={365}
                            step={1}
                            style={{ width: '100%' }}
                            placeholder="e.g. 30"
                          />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="credit_limit" label="Credit Limit">
                          <InputNumber min={0} step={100} style={{ width: '100%' }} placeholder="0.00" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="vendor_type_ids" label="Vendor Types">
                          <Select
                            mode="multiple"
                            placeholder="Select vendor types"
                            options={vendorTypeOptions}
                            allowClear
                            showSearch
                            optionFilterProp="label"
                            maxTagCount="responsive"
                          />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="vendor_category_id" label="Vendor Category">
                          <Select
                            placeholder="Select vendor category"
                            options={vendorCategoryOptions}
                            allowClear
                            showSearch
                            optionFilterProp="label"
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="is_transport_vendor" label="Transport Vendor" valuePropName="checked">
                          <Switch />
                        </Form.Item>
                      </Col>
                    </Row>
                  </>
                ),
              },
            ]}
          />
        </Form>
      </Card>
    </div>
  );
};

export default VendorForm;
