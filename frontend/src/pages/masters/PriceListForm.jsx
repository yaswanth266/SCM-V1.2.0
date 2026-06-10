import React, { useState, useEffect } from 'react';
import {
  Card, Form, Input, Select, Switch, Space, Button, message, Row, Col, DatePicker, Spin,
} from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const PriceListForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const fetchPriceList = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/masters/price-lists/${id}`);
      const data = res.data;

      const parseDay = (v) => {
        if (!v) return null;
        const ymd = String(v).slice(0, 10);
        const d = dayjs(ymd, 'YYYY-MM-DD', true);
        return d.isValid() ? d : null;
      };

      form.setFieldsValue({
        ...data,
        valid_from: parseDay(data.valid_from),
        valid_to: parseDay(data.valid_to),
        status: data.status || 'active',
      });
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/masters/price-lists');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isNew) {
      fetchPriceList();
    } else {
      form.setFieldsValue({
        status: 'active',
        currency: 'INR',
        is_default: false,
        type: 'selling',
      });
    }
  }, [id, isNew]);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const payload = {
        ...values,
        valid_from: values.valid_from ? values.valid_from.format('YYYY-MM-DD') : null,
        valid_to: values.valid_to ? values.valid_to.format('YYYY-MM-DD') : null,
      };

      setSubmitting(true);
      if (isNew) {
        await api.post('/masters/price-lists', payload);
        message.success('Price list created successfully');
      } else {
        await api.put(`/masters/price-lists/${id}`, payload);
        message.success('Price list updated successfully');
      }
      navigate('/masters/price-lists');
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}><Spin size="large" /></div>;
  }

  return (
    <div>
      <PageHeader title={isNew ? 'Create Price List' : 'Edit Price List'} subtitle="Configure buying or selling price list parameters">
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/masters/price-lists')}>Back to Price Lists</Button>
          <Button type="primary" onClick={handleSubmit} loading={submitting}>
            {isNew ? 'Create' : 'Save'}
          </Button>
        </Space>
      </PageHeader>
      <Card>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Price List Name" rules={[{ required: true, message: 'Required' }]}>
            <Input placeholder="e.g. Standard Selling" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="type" label="Type" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  options={[
                    { label: 'Buying', value: 'buying' },
                    { label: 'Selling', value: 'selling' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="currency" label="Currency" initialValue="INR">
                <Select
                  options={[
                    { label: 'INR', value: 'INR' },
                    { label: 'USD', value: 'USD' },
                    { label: 'EUR', value: 'EUR' },
                    { label: 'GBP', value: 'GBP' },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="valid_from" label="Valid From">
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="valid_to" label="Valid To">
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="is_default" label="Default Price List" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="status" label="Status" initialValue="active">
                <Select
                  options={[
                    { label: 'Active', value: 'active' },
                    { label: 'Inactive', value: 'inactive' },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} placeholder="Description" />
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};

export default PriceListForm;
