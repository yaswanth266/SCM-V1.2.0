import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Form, Space, Button, Select, InputNumber, Row, Col, Spin, Tooltip, message
} from 'antd';
import { ArrowLeftOutlined, PlusOutlined, DeleteOutlined, SaveOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import PageHeader from '../../../components/PageHeader';
import ItemSelector from '../../../components/ItemSelector';
import api from '../../../config/api';
import { getErrorMessage } from '../../../utils/helpers';

const ProjectIndentTemplateForm = ({ templateType, title }) => {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [projects, setProjects] = useState([]);
  const [uoms, setUoms] = useState([]);

  // Fetch Lookups
  const loadLookups = useCallback(async () => {
    try {
      const [projRes, uomRes] = await Promise.allSettled([
        api.get('/masters/projects', { params: { page_size: 500 } }),
        api.get('/masters/uom', { params: { page_size: 500 } }),
      ]);

      if (projRes.status === 'fulfilled') {
        const data = projRes.value.data?.items || projRes.value.data?.data || projRes.value.data || [];
        setProjects(data.map((p) => ({ label: p.name || p.project_name, value: p.id })));
      }

      if (uomRes.status === 'fulfilled') {
        const data = uomRes.value.data?.items || uomRes.value.data?.data || uomRes.value.data || [];
        setUoms(data.map((u) => ({ label: `${u.name} (${u.abbreviation || ''})`, value: u.id })));
      }
    } catch (err) {
      console.error('Failed to load lookups', err);
    }
  }, []);

  const fetchTemplateForProject = useCallback(async (pId) => {
    if (!pId) {
      form.setFieldsValue({ items: [{ item_id: undefined, quantity: 1, uom_id: undefined }] });
      return;
    }

    setLoading(true);
    try {
      const res = await api.get('/masters/project-indent-templates', {
        params: { project_id: pId, template_type: templateType }
      });
      const data = res.data;
      if (data) {
        form.setFieldsValue({
          items: (data.items || []).map((c) => ({
            item_id: c.item_id,
            quantity: Number(c.quantity) || 1,
            uom_id: c.uom_id,
          })),
        });
        message.info(`Loaded existing template configuration for this project`);
      } else {
        form.setFieldsValue({
          items: [{ item_id: undefined, quantity: 1, uom_id: undefined }],
        });
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [form, templateType]);

  useEffect(() => {
    loadLookups();
    if (projectId) {
      const pId = Number(projectId);
      form.setFieldsValue({ project_id: pId });
      fetchTemplateForProject(pId);
    } else {
      form.setFieldsValue({
        project_id: undefined,
        items: [{ item_id: undefined, quantity: 1, uom_id: undefined }],
      });
    }
  }, [templateType, projectId, loadLookups, fetchTemplateForProject, form]);

  const handleItemChange = (val, itemObj, index) => {
    if (itemObj) {
      const currentItems = form.getFieldValue('items') || [];
      const isDuplicate = currentItems.some((item, idx) => item?.item_id === val && idx !== index);
      if (isDuplicate) {
        message.warning('Item already exists in the template. Please update its quantity.');
        currentItems[index] = {
          ...currentItems[index],
          item_id: undefined,
          uom_id: undefined,
        };
        form.setFieldsValue({ items: currentItems });
        return;
      }
      currentItems[index] = {
        ...currentItems[index],
        item_id: val,
        uom_id: itemObj.primary_uom_id || undefined,
      };
      form.setFieldsValue({ items: currentItems });
    }
  };

  const handleBack = () => {
    const routeType = templateType === 'consumables' ? 'ap104-consumables' : 'ap104-install';
    navigate(`/inventory/masters/${routeType}`);
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (!values.items || values.items.length === 0) {
        message.error('At least one item is required in the template');
        return;
      }

      const itemIds = values.items.map(item => item.item_id).filter(Boolean);
      const uniqueItemIds = new Set(itemIds);
      if (itemIds.length !== uniqueItemIds.size) {
        message.error('Duplicate items are not allowed in the template');
        return;
      }

      const payload = {
        project_id: values.project_id,
        template_type: templateType,
        items: values.items.map((c) => ({
          item_id: c.item_id,
          quantity: c.quantity,
          uom_id: c.uom_id || null,
        })),
      };

      setSubmitting(true);
      await api.post('/masters/project-indent-templates', payload);
      message.success('Project indent template configured successfully');
      handleBack();
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <PageHeader title={title} subtitle="Configure fixed items and quantities for this project">
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={handleBack}>Back to List</Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSubmit} loading={submitting}>
            Save Template
          </Button>
        </Space>
      </PageHeader>
      <Card>
        <Spin spinning={loading}>
          <Form form={form} layout="vertical">
            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Form.Item
                  name="project_id"
                  label="Select Project"
                  rules={[{ required: true, message: 'Please select a project' }]}
                >
                  <Select
                    placeholder="Select project to configure template"
                    options={projects}
                    showSearch
                    optionFilterProp="label"
                    onChange={(val) => fetchTemplateForProject(val)}
                    disabled={!!projectId}
                  />
                </Form.Item>
              </Col>
            </Row>

            <div style={{ marginTop: 24 }}>
              <span style={{ fontWeight: 'bold', fontSize: 16 }}>Template Items & Quantities</span>
              <div style={{ marginTop: 12 }}>
                <Form.List
                  name="items"
                  rules={[
                    {
                      validator: async (_, names) => {
                        if (!names || names.length < 1) {
                          return Promise.reject(new Error('At least one item is required'));
                        }
                      },
                    },
                  ]}
                >
                  {(fields, { add, remove }) => (
                    <>
                      {fields.map(({ key, name, ...restField }, index) => (
                        <Row key={key} gutter={16} align="middle" style={{ marginBottom: 12 }}>
                          <Col xs={24} md={12}>
                            <Form.Item
                              {...restField}
                              name={[name, 'item_id']}
                              rules={[{ required: true, message: 'Select an item' }]}
                              style={{ margin: 0 }}
                            >
                              <ItemSelector
                                placeholder="Search item..."
                                onChange={(val, itemObj) => handleItemChange(val, itemObj, index)}
                                extraParams={{
                                  item_type: templateType === 'consumables' ? 'consumable' : 'asset'
                                }}
                              />
                            </Form.Item>
                          </Col>
                          <Col xs={12} md={5}>
                            <Form.Item
                              {...restField}
                              name={[name, 'quantity']}
                              rules={[{ required: true, message: 'Enter quantity' }]}
                              style={{ margin: 0 }}
                            >
                              <InputNumber
                                placeholder="Quantity"
                                min={0.001}
                                style={{ width: '100%' }}
                              />
                            </Form.Item>
                          </Col>
                          <Col xs={10} md={5}>
                            <Form.Item
                              {...restField}
                              name={[name, 'uom_id']}
                              rules={[{ required: true, message: 'Select UOM' }]}
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
                          <Col xs={2} md={2} style={{ textAlign: 'center' }}>
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
                          Add Item to Template
                        </Button>
                      </Form.Item>
                    </>
                  )}
                </Form.List>
              </div>
            </div>
          </Form>
        </Spin>
      </Card>
    </div>
  );
};

export default ProjectIndentTemplateForm;
