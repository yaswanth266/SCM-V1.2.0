import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Form, Space, Button, Select, Input, InputNumber, Row, Col, Spin, Tooltip, App
} from 'antd';
import { ArrowLeftOutlined, PlusOutlined, DeleteOutlined, SaveOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import PageHeader from '../../../components/PageHeader';
import ItemSelector from '../../../components/ItemSelector';
import api from '../../../config/api';
import { getErrorMessage } from '../../../utils/helpers';

const ProjectIndentTemplateForm = ({ title = "Template Master for DP Project" }) => {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const { id } = useParams();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [projects, setProjects] = useState([]);
  const [uoms, setUoms] = useState([]);
  const [existingProjectItems, setExistingProjectItems] = useState(new Map());

  const fetchExistingProjectItems = useCallback(async (projectId, currentTemplateId = id) => {
    if (!projectId) {
      setExistingProjectItems(new Map());
      return new Map();
    }
    try {
      const res = await api.get(`/masters/project-indent-templates/by-project/${projectId}`);
      const templates = res.data || [];
      const itemMap = new Map();
      templates.forEach((tmpl) => {
        if (currentTemplateId && Number(tmpl.id) === Number(currentTemplateId)) {
          return;
        }
        (tmpl.items || []).forEach((item) => {
          if (item.item_id) {
            itemMap.set(item.item_id, {
              templateId: tmpl.id,
              templateName: tmpl.template_name,
              itemCode: item.item_code,
              itemName: item.item_name,
            });
          }
        });
      });
      setExistingProjectItems(itemMap);
      return itemMap;
    } catch (err) {
      console.error('Failed to fetch existing project items', err);
      return new Map();
    }
  }, [id]);

  const loadLookups = useCallback(async () => {
    try {
      const [projRes, uomRes] = await Promise.allSettled([
        api.get('/masters/projects', { params: { page_size: 500 } }),
        api.get('/masters/uom', { params: { page_size: 500 } }),
      ]);

      if (projRes.status === 'fulfilled') {
        const data = projRes.value.data?.items || projRes.value.data?.data || projRes.value.data || [];
        const projList = data.map((p) => ({ label: `${p.name} (${p.code || ''})`, value: p.id }));
        setProjects(projList);

        if (!id && projList.length === 1) {
          form.setFieldValue('project_id', projList[0].value);
          fetchExistingProjectItems(projList[0].value);
        }
      }

      if (uomRes.status === 'fulfilled') {
        const data = uomRes.value.data?.items || uomRes.value.data?.data || uomRes.value.data || [];
        setUoms(data.map((u) => ({ label: `${u.name} (${u.abbreviation || ''})`, value: u.id })));
      }
    } catch (err) {
      console.error('Failed to load lookups', err);
    }
  }, [id, form, fetchExistingProjectItems]);

  const fetchTemplateById = useCallback(async (templateId) => {
    if (!templateId || templateId === 'new') return;
    setLoading(true);
    try {
      const res = await api.get(`/masters/project-indent-templates/${templateId}`);
      const data = res.data;
      if (data) {
        form.setFieldsValue({
          project_id: data.project_id,
          template_name: data.template_name,
          items: (data.items || []).map((c) => ({
            item_id: c.item_id,
            quantity: Number(c.quantity) || 1,
            uom_id: c.uom_id,
          })),
        });
        if (data.project_id) {
          await fetchExistingProjectItems(data.project_id, templateId);
        }
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [form, fetchExistingProjectItems]);

  useEffect(() => {
    loadLookups();
    if (id && id !== 'new') {
      fetchTemplateById(id);
    } else {
      form.setFieldsValue({
        project_id: undefined,
        template_name: '',
        items: [{ item_id: undefined, quantity: 1, uom_id: undefined }],
      });
    }
  }, [id, loadLookups, fetchTemplateById, form]);

  const handleProjectChange = async (projectId) => {
    form.setFieldValue('project_id', projectId);
    const itemMap = await fetchExistingProjectItems(projectId);

    const currentItems = form.getFieldValue('items') || [];
    let hasConflict = false;
    const updatedItems = currentItems.filter((item) => {
      if (item?.item_id && itemMap.has(item.item_id)) {
        const conflict = itemMap.get(item.item_id);
        const itemLabel = conflict.itemCode ? `[${conflict.itemCode}] ${conflict.itemName || ''}` : `Item #${item.item_id}`;
        message.error(`Item ${itemLabel} is already added in template "${conflict.templateName}" for this project! It has been removed from the list.`);
        hasConflict = true;
        return false;
      }
      return true;
    });

    if (hasConflict) {
      form.setFieldsValue({ items: updatedItems.length > 0 ? updatedItems : [{ item_id: undefined, quantity: 1, uom_id: undefined }] });
    }
  };

  const handleItemChange = (val, itemObj, index, remove, fieldsLength) => {
    const currentItems = form.getFieldValue('items') || [];

    if (!val) {
      currentItems[index] = {
        ...currentItems[index],
        item_id: undefined,
        uom_id: undefined,
      };
      form.setFieldsValue({ items: currentItems });
      return;
    }

    const itemLabel = itemObj
      ? `[${itemObj.item_code || itemObj.code || ''}] ${itemObj.item_name || itemObj.name || ''}`
      : `Item #${val}`;

    // 1. Check if item is already added in another template for this project
    if (existingProjectItems.has(val)) {
      const conflict = existingProjectItems.get(val);
      message.error(`Item ${itemLabel} is already added in template "${conflict.templateName}" for this project!`);
      if (fieldsLength > 1 && remove) {
        remove(index);
      } else {
        currentItems[index] = {
          ...currentItems[index],
          item_id: undefined,
          uom_id: undefined,
        };
        form.setFieldsValue({ items: currentItems });
      }
      return;
    }

    // 2. Check if item is already added in this current template form
    const isDuplicate = currentItems.some((item, idx) => item?.item_id === val && idx !== index);
    if (isDuplicate) {
      message.error(`Item ${itemLabel} is already added in this template!`);
      if (fieldsLength > 1 && remove) {
        remove(index);
      } else {
        currentItems[index] = {
          ...currentItems[index],
          item_id: undefined,
          uom_id: undefined,
        };
        form.setFieldsValue({ items: currentItems });
      }
      return;
    }

    currentItems[index] = {
      ...currentItems[index],
      item_id: val,
      uom_id: itemObj?.primary_uom_id || currentItems[index]?.uom_id || undefined,
    };
    form.setFieldsValue({ items: currentItems });
  };

  const handleBack = () => {
    navigate('/inventory/masters/project-templates');
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (!values.items || values.items.length === 0) {
        message.error('At least one item is required in the template');
        return;
      }

      const validItems = values.items.filter((item) => item && item.item_id);
      if (validItems.length === 0) {
        message.error('Please select at least one valid item for the template');
        return;
      }

      const itemIds = validItems.map((item) => item.item_id);
      const uniqueItemIds = new Set(itemIds);
      if (itemIds.length !== uniqueItemIds.size) {
        message.error('Duplicate items are not allowed in the template');
        return;
      }

      for (const item of validItems) {
        if (existingProjectItems.has(item.item_id)) {
          const conflict = existingProjectItems.get(item.item_id);
          const itemLabel = conflict.itemCode ? `[${conflict.itemCode}] ${conflict.itemName || ''}` : `Item #${item.item_id}`;
          message.error(`Item ${itemLabel} is already added in template "${conflict.templateName}" for this project!`);
          return;
        }
      }

      const payload = {
        ...(id && id !== 'new' ? { id: Number(id) } : {}),
        project_id: values.project_id,
        template_name: values.template_name.trim(),
        template_type: 'dp_project',
        items: validItems.map((c) => ({
          item_id: c.item_id,
          quantity: c.quantity,
          uom_id: c.uom_id || null,
        })),
      };

      setSubmitting(true);
      await api.post('/masters/project-indent-templates', payload);
      message.success('Template Master saved successfully');
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
      <PageHeader title={title} subtitle="Create or edit master item template for DP projects">
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={handleBack}>Back to List</Button>
          <Button type="primary" icon={<SaveOutlined />} onClick={handleSubmit} loading={submitting}>
            Save Template
          </Button>
        </Space>
      </PageHeader>
      <Card style={{ borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
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
                    placeholder="Select project"
                    options={projects}
                    showSearch
                    optionFilterProp="label"
                    onChange={handleProjectChange}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item
                  name="template_name"
                  label="Template Name"
                  rules={[{ required: true, message: 'Template Name is mandatory' }]}
                >
                  <Input placeholder="Enter unique template name (e.g. Consumables Pack A, Install Kit 1)" />
                </Form.Item>
              </Col>
            </Row>

            <div style={{ marginTop: 24 }}>
              <span style={{ fontWeight: 'bold', fontSize: 16 }}>Template Items & Fixed Quantities</span>
              <p style={{ color: '#8c8c8c', fontSize: 13, marginTop: 4 }}>
                Note: Each item can only be part of one template per project.
              </p>
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
                  {(fields, { add, remove }) => {
                    const currentFormItems = form.getFieldValue('items') || [];
                    const priorInProject = Array.from(existingProjectItems.keys());

                    return (
                      <>
                        {fields.map(({ key, name, ...restField }, index) => {
                          const selectedInOtherRows = currentFormItems
                            .map((item, idx) => (idx !== index ? item?.item_id : null))
                            .filter(Boolean);
                          const excludeIds = [...priorInProject, ...selectedInOtherRows];

                          return (
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
                                    excludeIds={excludeIds}
                                    onChange={(val, itemObj) => handleItemChange(val, itemObj, index, remove, fields.length)}
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
                          );
                        })}
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
                    );
                  }}
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
