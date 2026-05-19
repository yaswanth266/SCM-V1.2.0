import React, { useState } from 'react';
import { Card, Form, Input, Button, message, Alert, Space } from 'antd';
import { LockOutlined, CheckCircleOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const ChangePassword = () => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (values) => {
    setLoading(true);
    setSuccess(false);
    try {
      await api.post('/auth/change-password', {
        current_password: values.current_password,
        new_password: values.new_password,
      });
      message.success('Password changed successfully');
      setSuccess(true);
      form.resetFields();
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <PageHeader title="Change Password" subtitle="Update your login password" />
      <Card style={{ maxWidth: 480 }}>
        {success && (
          <Alert
            message="Password Updated"
            description="Your password has been changed. Use the new password on your next login."
            type="success"
            icon={<CheckCircleOutlined />}
            showIcon
            closable
            style={{ marginBottom: 24 }}
            onClose={() => setSuccess(false)}
          />
        )}
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          requiredMark="optional"
        >
          <Form.Item
            name="current_password"
            label="Current Password"
            rules={[{ required: true, message: 'Enter your current password' }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="Current password"
              size="large"
            />
          </Form.Item>

          <Form.Item
            name="new_password"
            label="New Password"
            // BUG-AUTH-052 fix: align complexity rules with backend
            // ChangePassword schema (matches the broader special-character
            // set !@#$%^&*(),.?":{}|<> the server enforces). Previously the
            // frontend regex required one of @$!%*?&# only, so passwords
            // like "Goodpass1," passed the form but failed at the API.
            rules={[
              { required: true, message: 'Enter a new password' },
              { min: 8, message: 'Password must be at least 8 characters' },
              { max: 128, message: 'Password must be at most 128 characters' },
              {
                validator: (_, value) => {
                  if (!value) return Promise.resolve();
                  if (!/[A-Z]/.test(value)) return Promise.reject(new Error('Must include an uppercase letter'));
                  if (!/[a-z]/.test(value)) return Promise.reject(new Error('Must include a lowercase letter'));
                  if (!/\d/.test(value)) return Promise.reject(new Error('Must include a digit'));
                  if (!/[!@#$%^&*(),.?":{}|<>]/.test(value)) return Promise.reject(new Error('Must include a special character'));
                  return Promise.resolve();
                },
              },
            ]}
            hasFeedback
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="New password"
              size="large"
            />
          </Form.Item>

          <Form.Item
            name="confirm_password"
            label="Confirm New Password"
            dependencies={['new_password']}
            rules={[
              { required: true, message: 'Confirm your new password' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('new_password') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('Passwords do not match'));
                },
              }),
            ]}
            hasFeedback
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="Re-enter new password"
              size="large"
            />
          </Form.Item>

          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" loading={loading} size="large">
                Update Password
              </Button>
              <Button onClick={() => form.resetFields()} size="large">
                Reset
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};

export default ChangePassword;
