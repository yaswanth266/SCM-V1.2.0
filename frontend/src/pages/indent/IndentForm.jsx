import React, { useState, useEffect, useCallback } from 'react';
import {
  Button, Form, Input, InputNumber, Select, Space, DatePicker,
  message, Row, Col, Table, Card, Descriptions, Divider,
  Typography, Tooltip, Tag, Spin, Popconfirm, Upload,
} from 'antd';
import {
  PlusOutlined, ArrowLeftOutlined, SendOutlined, EditOutlined,
  CloseCircleOutlined, MinusCircleOutlined, SaveOutlined,
  CheckCircleOutlined, PaperClipOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useParams, useNavigate } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import {
  formatDate, formatCurrency, getErrorMessage, formatDateForAPI,
  handleFormValidationFailed,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

// IND-2/IND-3 fix: match Indents.jsx drawer — same types, same status flow
const INDENT_TYPES = [
  { label: 'Regular', value: 'regular' },
  { label: 'Urgent', value: 'urgent' },
];

const INDENT_STATUS_FLOW = ['draft', 'pending_approval', 'approved', 'partially_fulfilled', 'fulfilled'];

const IndentForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [indent, setIndent] = useState(null);
  const [editMode, setEditMode] = useState(isNew);

  // Items
  const [indentItems, setIndentItems] = useState([
    { key: Date.now(), item_id: null, item_name: '', requested_qty: 1, uom_id: null, uom: '', remarks: '' },
  ]);

  // Attachments — required at submit per MoM 2026-04-19 §6. `pendingFiles`
  // are picked but not yet uploaded (we defer upload until we have an
  // indent_id). `existingAttachments` are files already on the server (when
  // editing an existing draft).
  const [pendingFiles, setPendingFiles] = useState([]);
  const [existingAttachments, setExistingAttachments] = useState([]);

  // Lookups
  const [departments, setDepartments] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [projects, setProjects] = useState([]);
  const [uoms, setUoms] = useState([]);

  const loadLookups = useCallback(async () => {
    try {
      const [deptRes, whRes, projRes, uomRes] = await Promise.allSettled([
        api.get('/masters/departments', { params: { page_size: 200 } }),
        api.get('/masters/warehouses', { params: { page_size: 200 } }),
        api.get('/masters/projects', { params: { page_size: 200 } }),
        api.get('/masters/uom', { params: { page_size: 200 } }),
      ]);
      if (deptRes.status === 'fulfilled') {
        const d = deptRes.value.data;
        const items = d.items || d.data || d || [];
        setDepartments(items.map((i) => ({ label: i.name, value: i.name })));
      }
      if (whRes.status === 'fulfilled') {
        const w = whRes.value.data;
        const whList = (w.items || w.data || w || []).map((i) => ({ label: i.name || i.warehouse_name, value: i.id }));
        setWarehouses(whList);
        // Auto-pick warehouse when the user has only one assigned — saves
        // a click and prevents picking a warehouse they don't belong to.
        if (isNew && whList.length === 1) {
          form.setFieldValue('warehouse_id', whList[0].value);
        }
      }
      if (projRes.status === 'fulfilled') {
        const p = projRes.value.data;
        const projList = (p.items || p.data || p || []).map((i) => ({ label: i.name || i.project_name, value: i.id }));
        setProjects(projList);
        // Same auto-pick for project — backend now scopes /masters/projects
        // by user_projects, so a single-project user sees exactly one option.
        if (isNew && projList.length === 1) {
          form.setFieldValue('project_id', projList[0].value);
        }
      }
      if (uomRes.status === 'fulfilled') {
        const u = uomRes.value.data;
        const items = u.items || u.data || u || [];
        setUoms(items.map((i) => ({ label: `${i.name} (${i.abbreviation || ''})`, value: i.id })));
      }
    } catch {
      // silent
    }
  }, []);

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
      });
      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_name: item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.item_name || item.item.name}` : ''),
        requested_qty: item.requested_qty || item.qty || 0,
        uom_id: item.uom_id || null,
        uom: item.uom || item.unit || '',
        remarks: item.remarks || '',
      }));
      setIndentItems(items.length > 0 ? items : [{ key: Date.now(), item_id: null, item_name: '', requested_qty: 1, uom_id: null, uom: '', remarks: '' }]);
      // Load existing attachments so the user knows the doc requirement is met.
      try {
        const attRes = await api.get('/attachments', {
          params: { entity_type: 'indent', entity_id: id },
        });
        const rows = Array.isArray(attRes.data)
          ? attRes.data
          : (attRes.data?.results || attRes.data?.items || []);
        setExistingAttachments(rows);
      } catch {
        setExistingAttachments([]);
      }
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/indent/indents');
    } finally {
      setLoading(false);
    }
  };

  // Upload all staged files for a given indent id. Returns true on success.
  const uploadPendingFiles = async (indentId) => {
    for (const fileWrapper of pendingFiles) {
      const file = fileWrapper.originFileObj || fileWrapper;
      const fd = new FormData();
      fd.append('file', file);
      fd.append('entity_type', 'indent');
      fd.append('entity_id', String(indentId));
      await api.post('/attachments/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
    }
  };

  const handleSubmit = async (submitForApproval = false) => {
    // BUG-FE-IND-001 — guard against double-fire. The button's `loading`
    // prop disables it visually, but a quick double-click can still queue
    // two handlers before the first setSubmitting(true) propagates. Refuse
    // re-entry while the previous submit is in-flight.
    if (submitting) return;
    try {
      const values = await form.validateFields();
      // Ensure warehouse_id is present (required by backend)
      if (!values.warehouse_id) {
        message.error('Warehouse is required');
        return;
      }
      const validItems = indentItems.filter((item) => item.item_id);
      if (validItems.length === 0) {
        message.error('Please add at least one item');
        const tbl = document.querySelector('.ant-table');
        if (tbl) {
          tbl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          tbl.style.border = '1.5px dashed #FF4D4F';
          tbl.style.backgroundColor = '#FFF2F0';
          setTimeout(() => {
            tbl.style.border = '';
            tbl.style.backgroundColor = '';
          }, 3000);
        }
        return;
      }
      // Validate each item has required fields
      for (const item of validItems) {
        if (!item.requested_qty || item.requested_qty <= 0) {
          message.error('Each item must have a requested quantity greater than 0');
          const rowInputs = document.querySelectorAll('.ant-input-number');
          rowInputs.forEach((inp) => {
            const val = parseFloat(inp.querySelector('input')?.value || '0');
            if (val <= 0 || isNaN(val)) {
              inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
              inp.style.border = '1.5px solid #FF4D4F';
              inp.style.backgroundColor = '#FFF2F0';
              setTimeout(() => {
                inp.style.border = '';
                inp.style.backgroundColor = '';
              }, 3000);
            }
          });
          return;
        }
      }
      setSubmitting(true);

      const payload = {
        warehouse_id: values.warehouse_id,
        indent_type: values.indent_type || 'regular',
        indent_date: formatDateForAPI(values.indent_date),
        required_date: formatDateForAPI(values.required_date),
        department: values.department || null,
        project_id: values.project_id || null,
        remarks: values.remarks || '',
        items: validItems.map((item) => ({
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

      // Upload any newly-picked attachments now that we have an indent id.
      if (pendingFiles.length > 0 && targetId) {
        try {
          await uploadPendingFiles(targetId);
          setPendingFiles([]);
        } catch (err) {
          message.error(`Attachment upload failed: ${getErrorMessage(err)}`);
          // Don't promote to "submitted" if upload failed — backend would 400
          // anyway, and the user expects a single clear error.
          if (isNew) navigate(`/indent/indents/${targetId}`);
          else fetchIndent();
          return;
        }
      }

      if (submitForApproval && targetId) {
        try {
          await api.post(`/indent/indents/${targetId}/submit`);
          message.success(
            isNew
              ? 'Indent created and submitted for approval'
              : 'Indent updated and submitted for approval'
          );
        } catch (err) {
          // Surface the real reason (400 attachment, 429 cap, etc.) instead
          // of swallowing it as "please submit manually".
          message.error(getErrorMessage(err));
        }
      } else {
        message.success(
          isNew ? 'Indent saved as draft' : 'Indent updated successfully'
        );
      }

      if (isNew) {
        navigate(`/indent/indents/${targetId}`);
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

  // Item row management
  const addItemRow = () => {
    setIndentItems((prev) => [
      ...prev,
      { key: Date.now(), item_id: null, item_name: '', requested_qty: 1, uom_id: null, uom: '', remarks: '' },
    ]);
  };

  const removeItemRow = (key) => {
    setIndentItems((prev) => prev.filter((item) => item.key !== key));
  };

  const updateItemRow = (key, field, value) => {
    setIndentItems((prev) =>
      prev.map((item) => (item.key === key ? { ...item, [field]: value } : item))
    );
  };

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}><Spin size="large" /></div>;
  }

  // Detail / View mode for existing indent
  if (!isNew && indent && !editMode) {
    const indentItemsList = indent.items || [];
    const statusIdx = INDENT_STATUS_FLOW.indexOf(indent.status);

    return (
      <div>
        <PageHeader title={indent.indent_number || `Indent #${id}`} subtitle="Indent Detail">
          <Space>
            {indent.status === 'draft' && (
              <>
                <Button icon={<EditOutlined />} onClick={() => setEditMode(true)}>Edit</Button>
                <Button type="primary" icon={<SendOutlined />} onClick={handleSubmitForApproval}>Submit for Approval</Button>
              </>
            )}
            {indent.status === 'pending_approval' && (
              <>
                <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleApprove}>Approve</Button>
                <Popconfirm title="Reject this indent?" onConfirm={handleReject} okButtonProps={{ danger: true }}>
                  <Button danger icon={<CloseCircleOutlined />}>Reject</Button>
                </Popconfirm>
              </>
            )}
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/indent/indents')}>Back</Button>
          </Space>
        </PageHeader>

        {/* Status Flow */}
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

        <Card>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="Indent Number">{indent.indent_number || '-'}</Descriptions.Item>
            <Descriptions.Item label="Indent Date">{formatDate(indent.indent_date)}</Descriptions.Item>
            <Descriptions.Item label="Required Date">{formatDate(indent.required_date)}</Descriptions.Item>
            <Descriptions.Item label="Indent Type">
              {INDENT_TYPES.find((t) => t.value === indent.indent_type)?.label || indent.indent_type || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Department">{indent.department || indent.department_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Warehouse">{indent.warehouse_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Project">{indent.project_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={indent.status} /></Descriptions.Item>
            <Descriptions.Item label="Created By">{indent.created_by_name || indent.requested_by_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Remarks" span={3}>{indent.remarks || '-'}</Descriptions.Item>
          </Descriptions>

          <Divider orientation="left">Items</Divider>
          <Table
            dataSource={indentItemsList}
            rowKey={(r) => r.id || r.item_id}
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
              { title: 'Item Code', width: 120, render: (_, r) => r.item_code || (r.item && r.item.item_code) || '-' },
              { title: 'Item Name', width: 220, render: (_, r) => r.item_name || (r.item && (r.item.item_name || r.item.name)) || '-' },
              { title: 'Requested Qty', dataIndex: 'requested_qty', width: 120, align: 'right', render: (v, r) => v || r.qty || 0 },
              { title: 'UOM', dataIndex: 'uom', width: 80, render: (v, r) => v || r.unit || '-' },
              { title: 'Approved Qty', dataIndex: 'approved_qty', width: 120, align: 'right', render: (v) => v != null ? v : '-' },
              { title: 'Remarks', dataIndex: 'remarks', width: 200, ellipsis: true, render: (v) => v || '-' },
            ]}
          />

          <Divider orientation="left">Supporting Documents</Divider>
          {existingAttachments.length === 0 ? (
            <Text type="secondary">No attachments</Text>
          ) : (
            <div>
              {existingAttachments.map((a) => (
                <Tag
                  key={a.id}
                  icon={<PaperClipOutlined />}
                  color="blue"
                  style={{ marginBottom: 4 }}
                >
                  <a href={a.file_path || a.url} target="_blank" rel="noreferrer">
                    {a.file_name}
                  </a>
                </Tag>
              ))}
            </div>
          )}
        </Card>
      </div>
    );
  }

  // Edit / Create mode
  const itemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item', dataIndex: 'item_id', width: 280,
      render: (val, record) => (
        <ItemSelector
          value={val}
          onChange={(itemId, item) => {
            updateItemRow(record.key, 'item_id', itemId);
            if (item) {
              updateItemRow(record.key, 'item_name', item.item_name || item.name || '');
              updateItemRow(record.key, 'uom_id', item.primary_uom_id || null);
              updateItemRow(record.key, 'uom', item.primary_uom?.name || item.primary_uom_name || '');
            }
          }}
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Requested Qty', dataIndex: 'requested_qty', width: 120,
      render: (val, record) => (
        <InputNumber min={0.01} value={val} onChange={(v) => updateItemRow(record.key, 'requested_qty', v)} style={{ width: '100%' }} />
      ),
    },
    {
      title: 'UOM', dataIndex: 'uom_id', width: 140,
      render: (val, record) => (
        <Select
          value={val}
          onChange={(v) => updateItemRow(record.key, 'uom_id', v)}
          options={uoms}
          placeholder="Select UOM"
          optionFilterProp="label"
          allowClear
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Remarks', dataIndex: 'remarks', width: 200,
      render: (val, record) => (
        <Input value={val} onChange={(e) => updateItemRow(record.key, 'remarks', e.target.value)} placeholder="Remarks" />
      ),
    },
    {
      title: '', width: 40,
      render: (_, record) => indentItems.length > 1 ? (
        <Tooltip title="Remove"><MinusCircleOutlined style={{ color: '#ff4d4f', cursor: 'pointer', fontSize: 16 }} onClick={() => removeItemRow(record.key)} /></Tooltip>
      ) : null,
    },
  ];

  return (
    <div>
      <PageHeader title={isNew ? 'Create Indent' : `Edit ${indent?.indent_number || ''}`} subtitle={isNew ? 'Create a new indent' : 'Edit indent'}>
        <Space>
          <Button onClick={() => navigate('/indent/indents')} icon={<ArrowLeftOutlined />}>Back</Button>
          {!isNew && <Button onClick={() => setEditMode(false)}>Cancel Edit</Button>}
        </Space>
      </PageHeader>

      <Card>
        <Form form={form} layout="vertical" scrollToFirstError={true}>
          {/* indent_type and indent_date are kept in form state as hidden fields
              — defaulted to "regular" / today so the field user never has to
              touch them. Urgent flag is exposed as a single inline checkbox. */}
          <Form.Item name="indent_type" hidden><Input /></Form.Item>
          <Form.Item name="indent_date" hidden><DatePicker /></Form.Item>
          {/* warehouse_id and project_id auto-fill from user_warehouses /
              user_projects when the user has exactly one of each. Keep them
              as hidden Form.Items in that case so validateFields() still
              returns the value — without this, gating the picker out of the
              JSX entirely caused the field to disappear from the validated
              payload and the submit handler to error with "Warehouse is
              required". */}
          {warehouses.length <= 1 && (
            <Form.Item name="warehouse_id" hidden><Input /></Form.Item>
          )}
          {projects.length <= 1 && (
            <Form.Item name="project_id" hidden><Input /></Form.Item>
          )}

          <Row gutter={16}>
            {warehouses.length > 1 && (
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true, message: 'Warehouse is required' }]}>
                  <Select options={warehouses} placeholder="Select warehouse" allowClear optionFilterProp="label" />
                </Form.Item>
              </Col>
            )}
            {projects.length > 1 && (
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="project_id" label="Project">
                  <Select options={projects} placeholder="Select project" allowClear optionFilterProp="label" />
                </Form.Item>
              </Col>
            )}
            <Col xs={24} sm={12} md={8}>
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
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="department" label="Department (optional)">
                <Select options={departments} placeholder="Select department" allowClear optionFilterProp="label" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24}>
              <Form.Item name="remarks" label="Remarks (optional)">
                <TextArea rows={2} placeholder="Any remarks..." />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item style={{ marginBottom: 8 }}>
            <Button
              type={form.getFieldValue('indent_type') === 'urgent' ? 'primary' : 'default'}
              danger={form.getFieldValue('indent_type') === 'urgent'}
              size="small"
              onClick={() => {
                const cur = form.getFieldValue('indent_type');
                form.setFieldValue('indent_type', cur === 'urgent' ? 'regular' : 'urgent');
                // force re-render of the toggle label
                setIndentItems((prev) => [...prev]);
              }}
            >
              {form.getFieldValue('indent_type') === 'urgent' ? '⚡ Urgent' : 'Mark as urgent'}
            </Button>
          </Form.Item>

          <Form.Item
            label={
              <span>
                Supporting Documents{' '}
                <Text type="secondary" style={{ fontSize: 12 }}>
                  (optional)
                </Text>
              </span>
            }
          >
            {existingAttachments.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                {existingAttachments.map((a) => (
                  <Tag
                    key={a.id}
                    icon={<PaperClipOutlined />}
                    color="blue"
                    style={{ marginBottom: 4 }}
                  >
                    <a href={a.file_path || a.url} target="_blank" rel="noreferrer">
                      {a.file_name}
                    </a>
                  </Tag>
                ))}
              </div>
            )}
            <Upload
              fileList={pendingFiles}
              beforeUpload={(file) => {
                // Stage only — actual upload happens after we have indent id.
                if (file.size / 1024 / 1024 > 10) {
                  message.error('File must be smaller than 10 MB');
                  return Upload.LIST_IGNORE;
                }
                return false;
              }}
              onChange={({ fileList }) => setPendingFiles(fileList)}
              onRemove={(file) => {
                setPendingFiles((prev) => prev.filter((f) => f.uid !== file.uid));
              }}
              multiple
              accept=".pdf,.jpg,.jpeg,.png,.gif,.bmp,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt"
            >
              <Button icon={<PaperClipOutlined />}>
                Attach prescription / order / supporting doc
              </Button>
            </Upload>
          </Form.Item>
        </Form>

        <Divider orientation="left">Items</Divider>
        <Table
          dataSource={indentItems}
          columns={itemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 900 }}
          footer={() => (
            <Button type="dashed" onClick={addItemRow} icon={<PlusOutlined />} block>Add Item</Button>
          )}
        />

        <Divider />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={() => navigate('/indent/indents')}>Cancel</Button>
          <Button icon={<SaveOutlined />} onClick={() => handleSubmit(false)} loading={submitting}>Save as Draft</Button>
          <Button type="primary" icon={<SendOutlined />} onClick={() => handleSubmit(true)} loading={submitting}>Save &amp; Submit</Button>
        </div>
      </Card>
    </div>
  );
};

export default IndentForm;
