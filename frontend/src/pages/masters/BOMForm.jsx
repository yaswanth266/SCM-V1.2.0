import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Form, Input, Space, Button, Switch, message, Select, InputNumber, Row, Col, Spin, Tooltip
} from 'antd';
import { ArrowLeftOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const documentTypeOptions = [
  { label: 'Indent', value: 'Indent' },
  { label: 'Material issue', value: 'Material issue' },
];

const BOMForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [projects, setProjects] = useState([]);
  const [uoms, setUoms] = useState([]);
  const [departments, setDepartments] = useState([]);

  // Fetch Lookups
  const loadLookups = useCallback(async () => {
    try {
      const [projRes, uomRes, deptRes] = await Promise.allSettled([
        api.get('/masters/org-projects', { params: { page_size: 500 } }),
        api.get('/masters/uom', { params: { page_size: 500 } }),
        api.get('/masters/departments'),
      ]);

      if (projRes.status === 'fulfilled') {
        const data = projRes.value.data?.items || projRes.value.data?.data || projRes.value.data || [];
        setProjects(data.map((p) => ({ label: `[${p.code}] ${p.name}`, value: p.id })));
      }

      if (uomRes.status === 'fulfilled') {
        const data = uomRes.value.data?.items || uomRes.value.data?.data || uomRes.value.data || [];
        setUoms(data.map((u) => ({ label: `${u.name} (${u.abbreviation || ''})`, value: u.id })));
      }

      if (deptRes.status === 'fulfilled') {
        const data = deptRes.value.data || [];
        setDepartments(data.map((d) => ({ label: d.name, value: d.value })));
      }
    } catch (err) {
      console.error('Failed to load lookups', err);
    }
  }, []);

  const fetchBOM = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/masters/boms/${id}`);
      const data = res.data;
      form.setFieldsValue({
        name: data.name,
        project_id: data.project_id,
        department: data.department || undefined,
        document_types: data.document_types,
        is_active: data.is_active,
        components: (data.components || []).map((c) => ({
          item_id: c.item_id,
          qty: c.qty,
          uom_id: c.uom_id,
        })),
      });
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/masters/boms');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLookups();
    if (!isNew) {
      fetchBOM();
    } else {
      form.setFieldsValue({
        is_active: true,
        components: [{ item_id: undefined, qty: 1, uom_id: undefined }],
      });
    }
  }, [id, isNew, loadLookups]);

  const handleItemChange = (val, itemObj, index) => {
    if (itemObj) {
      const currentComponents = form.getFieldValue('components') || [];
      currentComponents[index] = {
        ...currentComponents[index],
        item_id: val,
        uom_id: itemObj.primary_uom_id || undefined,
      };
      form.setFieldsValue({ components: currentComponents });
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      
      if (!values.components || values.components.length === 0) {
        message.error('At least one item component is required');
        return;
      }

      const payload = {
        name: values.name,
        project_id: values.project_id || null,
        department: values.department || null,
        document_types: values.document_types || [],
        components: values.components.map((c) => ({
          item_id: c.item_id,
          qty: c.qty,
          uom_id: c.uom_id || null,
        })),
        is_active: values.is_active !== false,
      };

      setSubmitting(true);
      if (isNew) {
        await api.post('/masters/boms', payload);
        message.success('BOM created successfully');
      } else {
        await api.put(`/masters/boms/${id}`, payload);
        message.success('BOM updated successfully');
      }
      navigate('/masters/boms');
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
      <PageHeader title={isNew ? 'Create BOM' : 'Edit BOM'} subtitle="Manage Bill of Materials definitions">
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/masters/boms')}>Back to BOMs</Button>
          <Button type="primary" onClick={handleSubmit} loading={submitting}>
            {isNew ? 'Create' : 'Save'}
          </Button>
        </Space>
      </PageHeader>
      <Card>
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={24}>
              <Form.Item
                name="name"
                label="BOM Name"
                rules={[{ required: true, message: 'Please enter BOM name' }]}
              >
                <Input placeholder="e.g. Paracetamol Kit, Cardiology Dept BOM" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="project_id" label="Project">
                <Select
                  placeholder="Select project (optional)"
                  options={projects}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="department" label="Department">
                <Select
                  placeholder="Select department (optional)"
                  options={departments}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="document_types"
                label="Document Types"
                rules={[{ required: true, type: 'array', min: 1, message: 'Please select at least one Document Type' }]}
              >
                <Select
                  mode="multiple"
                  placeholder="Select document types"
                  options={documentTypeOptions}
                  allowClear
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="is_active" label="Active Status" valuePropName="checked" initialValue={true}>
                <Switch checkedChildren="Active" unCheckedChildren="Inactive" />
              </Form.Item>
            </Col>
          </Row>

          <div style={{ marginTop: 24 }}>
            <span style={{ fontWeight: 'bold', fontSize: 16 }}>BOM Components</span>
            <div style={{ marginTop: 12 }}>
              <Form.List
                name="components"
                rules={[
                  {
                    validator: async (_, names) => {
                      if (!names || names.length < 1) {
                        return Promise.reject(new Error('At least one component item is required'));
                      }
                    },
                  },
                ]}
              >
                {(fields, { add, remove }) => (
                  <>
                    {fields.map(({ key, name, ...restField }, index) => (
                      <Row key={key} gutter={16} align="middle" style={{ marginBottom: 8 }}>
                        <Col span={12}>
                          <Form.Item
                            {...restField}
                            name={[name, 'item_id']}
                            rules={[{ required: true, message: 'Select an item' }]}
                            style={{ margin: 0 }}
                          >
                            <ItemSelector
                              placeholder="Search item..."
                              onChange={(val, itemObj) => handleItemChange(val, itemObj, index)}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={5}>
                          <Form.Item
                            {...restField}
                            name={[name, 'qty']}
                            rules={[{ required: true, message: 'Enter qty' }]}
                            style={{ margin: 0 }}
                          >
                            <InputNumber
                              placeholder="Qty"
                              min={0.001}
                              style={{ width: '100%' }}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={5}>
                          <Form.Item
                            {...restField}
                            name={[name, 'uom_id']}
                            rules={[{ required: true, message: 'UOM' }]}
                            style={{ margin: 0 }}
                          >
                            <Select
                              placeholder="UOM"
                              options={uoms}
                              showSearch
                              optionFilterProp="label"
                              style={{ width: '100%' }}
                            />
                          </Form.Item>
                        </Col>
                        <Col span={2} style={{ textAlign: 'center' }}>
                          {fields.length > 1 && (
                            <Tooltip title="Remove item">
                              <DeleteOutlined
                                onClick={() => remove(name)}
                                style={{ color: '#ff4d4f', cursor: 'pointer', fontSize: 16 }}
                              />
                            </Tooltip>
                          )}
                        </Col>
                      </Row>
                    ))}
                    <Form.Item style={{ marginTop: 12 }}>
                      <Button
                        type="dashed"
                        onClick={() => add()}
                        block
                        icon={<PlusOutlined />}
                      >
                        + Add Component Item
                      </Button>
                    </Form.Item>
                  </>
                )}
              </Form.List>
            </div>
          </div>
        </Form>
      </Card>
    </div>
  );
};

export default BOMForm;
