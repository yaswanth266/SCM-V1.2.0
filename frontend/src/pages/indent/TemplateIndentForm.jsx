import React, { useState, useEffect, useCallback } from 'react';
import {
  Button, Form, Input, InputNumber, Select, Space, DatePicker,
  Row, Col, Table, Card, Descriptions, Divider,
  Typography, Tag, Spin, Popconfirm, App,
} from 'antd';
import {
  ArrowLeftOutlined, SendOutlined, EditOutlined,
  CloseCircleOutlined, SaveOutlined, CheckCircleOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useParams, useNavigate } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatDate, getErrorMessage, formatDateForAPI,
  handleFormValidationFailed,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';
import useAuthStore from '../../store/authStore';

const { TextArea } = Input;

const INDENT_STATUS_FLOW = ['draft', 'pending_approval', 'approved', 'partially_fulfilled', 'fulfilled'];

const TemplateIndentForm = ({ title = "Template Indent" }) => {
  const { message } = App.useApp();
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [form] = Form.useForm();
  const user = useAuthStore((s) => s.user);
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [indent, setIndent] = useState(null);
  const [editMode, setEditMode] = useState(isNew);

  // Templates list for the selected project
  const [availableTemplates, setAvailableTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState(null);

  // Items loaded from template
  const [indentItems, setIndentItems] = useState([]);

  // Lookups
  const [warehouses, setWarehouses] = useState([]);
  const [projects, setProjects] = useState([]);
  const [vehicles, setVehicles] = useState([]);

  const loadLookups = useCallback(async () => {
    const uid = user?.id;
    try {
      const [whRes, projRes, vehRes] = await Promise.allSettled([
        api.get('/masters/warehouses', { params: { page_size: 200, user_id: uid, exclude_virtual: true } }),
        api.get('/masters/projects', { params: { page_size: 200, user_id: uid } }),
        api.get('/masters/vehicles', { params: { is_active: true } }),
      ]);

      if (whRes.status === 'fulfilled') {
        const w = whRes.value.data;
        const whList = (w.items || w.data || w || []).map((i) => ({ label: i.name || i.warehouse_name, value: i.id }));
        setWarehouses(whList);
        if (isNew) {
          if (whList.length === 1) {
            form.setFieldValue('warehouse_id', whList[0].value);
          } else if (uid && user?.warehouse_id) {
            form.setFieldValue('warehouse_id', user.warehouse_id);
          }
        }
      }

      if (projRes.status === 'fulfilled') {
        const p = projRes.value.data;
        const projList = (p.items || p.data || p || []).map((i) => ({ label: i.name || i.project_name, value: i.id }));
        setProjects(projList);
        if (isNew && projList.length === 1) {
          form.setFieldValue('project_id', projList[0].value);
          fetchTemplatesForProject(projList[0].value);
        }
      }

      if (vehRes.status === 'fulfilled') {
        const v = vehRes.value.data || [];
        setVehicles(v);
      }
    } catch { /* silent */ }
  }, [user, isNew, form]);

  const fetchTemplatesForProject = async (projectId) => {
    if (!projectId) {
      setAvailableTemplates([]);
      setSelectedTemplate(null);
      setIndentItems([]);
      form.setFieldValue('template_id', undefined);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get(`/masters/project-indent-templates/by-project/${projectId}`);
      const templatesList = res.data || [];
      setAvailableTemplates(templatesList);
      if (templatesList.length === 0) {
        message.warning('No templates configured for this project in Template Master!');
        setSelectedTemplate(null);
        setIndentItems([]);
        form.setFieldValue('template_id', undefined);
      } else if (templatesList.length === 1 && isNew) {
        // Auto select single template
        const t = templatesList[0];
        form.setFieldValue('template_id', t.id);
        handleTemplateSelect(t.id, templatesList);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleTemplateSelect = (templateId, templateArray = availableTemplates) => {
    const matched = templateArray.find((t) => t.id === templateId);
    if (matched) {
      setSelectedTemplate(matched);
      setIndentItems((matched.items || []).map((item, idx) => ({
        key: item.id || idx,
        item_id: item.item_id,
        item_code: item.item_code,
        item_name: item.item_name || `[${item.item_code}] ${item.item_name || ''}`,
        requested_qty: Number(item.quantity),
        uom_id: item.uom_id,
        uom: item.uom_name || '',
        remarks: 'Fixed template item',
      })));
      message.success(`Loaded items for template '${matched.template_name}'`);
    } else {
      setSelectedTemplate(null);
      setIndentItems([]);
    }
  };

  const fetchIndent = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/indent/indents/${id}`);
      const data = res.data;
      setIndent(data);
      form.setFieldsValue({
        ...data,
        indent_date: data.indent_date ? dayjs(data.indent_date) : null,
        required_date: data.required_date ? dayjs(data.required_date) : null,
        template_id: data.template_id,
      });

      if (data.project_id) {
        fetchTemplatesForProject(data.project_id);
      }

      const items = (data.items || []).map((item, idx) => ({
        key: item.id || idx,
        item_id: item.item_id,
        item_name: item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.item_name || item.item.name}` : ''),
        item_code: item.item_code,
        requested_qty: item.requested_qty || item.qty || 0,
        uom_id: item.uom_id || null,
        uom: item.uom || item.unit || '',
        remarks: item.remarks || '',
      }));
      setIndentItems(items);
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/indent/template-indents');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLookups();
    if (!isNew) {
      fetchIndent();
    } else {
      form.setFieldsValue({
        indent_type: 'regular',
        indent_date: dayjs(),
        required_date: dayjs().add(7, 'day'),
      });
    }
  }, [id]);

  const handleVehicleChange = (val) => {
    const matched = vehicles.find((v) => v.vehicle_code === val);
    if (matched) {
      form.setFieldsValue({ vehicle_number: matched.vehicle_number });
    } else {
      form.setFieldsValue({ vehicle_number: '' });
    }
  };

  const handleSubmit = async (submitForApproval = false) => {
    if (submitting) return;
    try {
      const values = await form.validateFields();
      if (indentItems.length === 0) {
        message.error('Please select a valid template with items first');
        return;
      }

      const matchedTmpl = availableTemplates.find((t) => t.id === values.template_id);

      setSubmitting(true);
      const payload = {
        warehouse_id: values.warehouse_id,
        indent_type: 'regular',
        template_type: 'dp_project',
        template_id: values.template_id,
        template_name: matchedTmpl ? matchedTmpl.template_name : undefined,
        indent_date: formatDateForAPI(values.indent_date),
        required_date: formatDateForAPI(values.required_date),
        project_id: values.project_id,
        vehicle_code: values.vehicle_code || null,
        vehicle_number: values.vehicle_number || null,
        remarks: values.remarks || '',
        items: indentItems.map((item) => ({
          item_id: item.item_id,
          requested_qty: item.requested_qty,
          uom_id: item.uom_id || null,
          remarks: item.remarks || '',
        })),
      };

      let targetId = id;
      if (isNew) {
        const res = await api.post('/indent/indents', payload);
        targetId = res.data.id || res.data.data?.id;
      } else {
        await api.put(`/indent/indents/${id}`, payload);
      }

      if (submitForApproval && targetId) {
        await api.post(`/indent/indents/${targetId}/submit`);
        message.success(isNew ? 'Indent created and submitted' : 'Indent updated and submitted');
      } else {
        message.success(isNew ? 'Indent saved as draft' : 'Indent updated successfully');
      }

      if (isNew) {
        navigate(`/indent/template-indents/${targetId}`);
      } else {
        setEditMode(false);
        fetchIndent();
      }
    } catch (err) {
      if (err.errorFields) {
        handleFormValidationFailed(err);
        return;
      }
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitForApproval = async () => {
    try {
      await api.post(`/indent/indents/${id}/submit`);
      message.success('Indent submitted for approval');
      fetchIndent();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleApprove = async () => {
    try {
      await api.post(`/indent/indents/${id}/approve`);
      message.success('Indent approved');
      fetchIndent();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleReject = async () => {
    try {
      await api.post(`/indent/indents/${id}/reject`);
      message.success('Indent rejected');
      fetchIndent();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}><Spin size="large" /></div>;
  }

  // Detail / View Mode
  if (!isNew && indent && !editMode) {
    const statusIdx = INDENT_STATUS_FLOW.indexOf(indent.status);

    return (
      <div>
        <PageHeader title={indent.indent_number || `Indent #${id}`} subtitle={`${title} Detail`}>
          <Space>
            {indent.status === 'draft' && (
              <>
                <Button icon={<EditOutlined />} onClick={() => setEditMode(true)}>Edit</Button>
                <Button type="primary" icon={<SendOutlined />} onClick={handleSubmitForApproval}>Submit for Approval</Button>
              </>
            )}
            {indent.status === 'pending_approval' && indent.can_approve_now === true && indent.raised_by !== user?.id && (
              <>
                <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleApprove}>Approve</Button>
                <Popconfirm title="Reject this indent?" onConfirm={handleReject} okButtonProps={{ danger: true }}>
                  <Button danger icon={<CloseCircleOutlined />}>Reject</Button>
                </Popconfirm>
              </>
            )}
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/indent/template-indents')}>Back</Button>
          </Space>
        </PageHeader>

        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {INDENT_STATUS_FLOW.map((s, idx) => {
              const isCurrent = s === indent.status;
              const isPast = idx < statusIdx;
              return (
                <Tag key={s} color={indent.status === 'cancelled' || indent.status === 'rejected' ? 'default' : isCurrent ? 'blue' : isPast ? 'green' : 'default'}
                  style={{ padding: '4px 12px', fontSize: 13 }}>
                  {s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </Tag>
              );
            })}
            {indent.status === 'cancelled' && <Tag color="red" style={{ padding: '4px 12px', fontSize: 13 }}>Cancelled</Tag>}
            {indent.status === 'rejected' && <Tag color="red" style={{ padding: '4px 12px', fontSize: 13 }}>Rejected</Tag>}
          </div>
        </Card>

        <Card style={{ borderRadius: 12 }}>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="Indent Number">{indent.indent_number || '-'}</Descriptions.Item>
            <Descriptions.Item label="Indent Date">{formatDate(indent.indent_date)}</Descriptions.Item>
            <Descriptions.Item label="Required Date">{formatDate(indent.required_date)}</Descriptions.Item>
            <Descriptions.Item label="Warehouse">{indent.warehouse_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Project">{indent.project_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Template Name">
              {indent.template_name ? <Tag color="blue">{indent.template_name}</Tag> : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Vehicle Code">{indent.vehicle_code || '-'}</Descriptions.Item>
            <Descriptions.Item label="Vehicle Number">{indent.vehicle_number || '-'}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={indent.status} /></Descriptions.Item>
            <Descriptions.Item label="Created By">{indent.created_by_name || indent.raised_by_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Remarks" span={3}>{indent.remarks || '-'}</Descriptions.Item>
          </Descriptions>

          <Divider orientation="left">Fixed Items List</Divider>
          <Table
            dataSource={indentItems}
            rowKey="key"
            size="small"
            pagination={false}
            columns={[
              { title: '#', width: 50, render: (_, __, idx) => idx + 1 },
              { title: 'Item Code', width: 150, render: (_, r) => r.item_code || '-' },
              { title: 'Item Name', render: (_, r) => r.item_name || '-' },
              { title: 'Fixed Qty', dataIndex: 'requested_qty', width: 120, align: 'right' },
              { title: 'UOM', dataIndex: 'uom', width: 100 },
              { title: 'Remarks', dataIndex: 'remarks' },
            ]}
          />
        </Card>
      </div>
    );
  }

  // Create / Edit Mode
  return (
    <div>
      <PageHeader title={isNew ? `Create Template Indent` : `Edit ${indent?.indent_number || ''}`} subtitle={isNew ? `Create a new template-based fixed indent` : `Edit indent`}>
        <Space>
          <Button onClick={() => navigate('/indent/template-indents')} icon={<ArrowLeftOutlined />}>Back</Button>
          {!isNew && <Button onClick={() => setEditMode(false)}>Cancel Edit</Button>}
          <Button type="primary" icon={<SaveOutlined />} onClick={() => handleSubmit(false)} loading={submitting}>
            Save Draft
          </Button>
          <Button type="primary" icon={<SendOutlined />} onClick={() => handleSubmit(true)} loading={submitting}>
            Submit for Approval
          </Button>
        </Space>
      </PageHeader>

      <Card style={{ borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} sm={12} md={6}>
              <Form.Item name="project_id" label="Project" rules={[{ required: true, message: 'Project is required' }]}>
                <Select
                  options={projects}
                  placeholder="Select project"
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  disabled={!isNew}
                  onChange={(val) => fetchTemplatesForProject(val)}
                />
              </Form.Item>
            </Col>

            <Col xs={24} sm={12} md={6}>
              <Form.Item name="template_id" label="Template Name" rules={[{ required: true, message: 'Template Name is required' }]}>
                <Select
                  placeholder={availableTemplates.length > 0 ? "Select template name" : "Select project first"}
                  allowClear
                  showSearch
                  disabled={!isNew || availableTemplates.length === 0}
                  onChange={(val) => handleTemplateSelect(val)}
                  options={availableTemplates.map((t) => ({ label: t.template_name, value: t.id }))}
                />
              </Form.Item>
            </Col>

            <Col xs={24} sm={12} md={6}>
              <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true, message: 'Warehouse is required' }]}>
                  <Select options={warehouses} placeholder="Select warehouse" allowClear showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
            
            <Col xs={24} sm={12} md={6}>
              <Form.Item
                name="required_date"
                label="Required Date"
                rules={[
                  { required: true, message: 'Required Date is mandatory' },
                  {
                    validator: (_, value) => {
                      if (value && value.isBefore(dayjs(), 'day')) {
                        return Promise.reject(new Error('Required Date must be a future date'));
                      }
                      return Promise.resolve();
                    }
                  }
                ]}
              >
                <DatePicker
                  style={{ width: '100%' }}
                  format={DATE_FORMAT}
                  disabledDate={(current) => current && current.isBefore(dayjs(), 'day')}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="vehicle_code" label="Vehicle Code">
                <Select
                  placeholder="Select vehicle code"
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  onChange={handleVehicleChange}
                  options={vehicles.map((v) => ({ label: v.vehicle_code, value: v.vehicle_code }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="vehicle_number" label="Vehicle Number">
                <Input placeholder="Auto-populated from code" disabled style={{ color: 'rgba(0, 0, 0, 0.85)', backgroundColor: '#fafafa' }} />
              </Form.Item>
            </Col>
          </Row>

          <Divider orientation="left">Fixed Items List (Auto-Fetched from Template)</Divider>
          <Table
            dataSource={indentItems}
            rowKey="key"
            size="small"
            pagination={false}
            columns={[
              { title: '#', width: 50, render: (_, __, idx) => idx + 1 },
              { title: 'Item Code', width: 150, render: (_, r) => r.item_code || '-' },
              { title: 'Item Name', render: (_, r) => r.item_name || '-' },
              { title: 'Quantity (Fixed)', dataIndex: 'requested_qty', width: 150, align: 'right', render: (q) => <strong>{q}</strong> },
              { title: 'UOM', dataIndex: 'uom', width: 100 },
              { title: 'Remarks', dataIndex: 'remarks' },
            ]}
            style={{ marginBottom: 24 }}
          />

          <Row gutter={16}>
            <Col xs={24}>
              <Form.Item name="remarks" label="Remarks (optional)">
                <TextArea rows={2} placeholder="Any remarks..." />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>
    </div>
  );
};

export default TemplateIndentForm;
