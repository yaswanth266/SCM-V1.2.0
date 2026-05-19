import React, { useEffect, useState, useCallback } from 'react';
import {
  Card, Table, Button, Tag, Space, Modal, Form, Input, Select, Upload, message, Drawer, Tabs, Popconfirm, Switch, Tooltip,
} from 'antd';
import {
  FileTextOutlined, UploadOutlined, EditOutlined, ReloadOutlined, PlusOutlined,
  DeleteOutlined, EyeOutlined, ApiOutlined, GoldOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const CATEGORIES = ['contract', 'license', 'invoice', 'po', 'grn', 'qi', 'sop', 'other'];

function GroupsTab() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState({ search: '', category: undefined });
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm();
  const [versionsDrawer, setVersionsDrawer] = useState(null);
  const [uploading, setUploading] = useState(false);
  // BUG-HC-120 fix: hold the change-note in React state instead of a DOM
  // lookup via document.getElementById('upload-note'). The previous code
  // pulled the note value out of the dialog by id, which fails if antd
  // re-mounts or scopes inputs differently across versions, and is also a
  // React anti-pattern (state of an input in an uncontrolled DOM lookup).
  const [uploadNote, setUploadNote] = useState('');

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/documents/groups', { params: { page, page_size: 25, ...filter } });
      setRows(r.data?.data || r.data?.items || []);
      setTotal(r.data?.total || r.data?.count || (r.data?.data || []).length);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, [page, filter]);

  useEffect(() => { fetch(); }, [fetch]);

  const handleCreate = async () => {
    try {
      const v = await createForm.validateFields();
      await api.post('/documents/groups', v);
      message.success('Document group created');
      setCreateOpen(false);
      createForm.resetFields();
      fetch();
    } catch (e) {
      if (e?.errorFields) return;
      message.error(getErrorMessage(e));
    }
  };

  const handleArchive = async (id) => {
    try {
      await api.delete(`/documents/groups/${id}`);
      message.success('Archived');
      fetch();
    } catch (e) { message.error(getErrorMessage(e)); }
  };

  const openVersions = async (group) => {
    try {
      const r = await api.get(`/documents/groups/${group.id}`);
      setVersionsDrawer(r.data);
    } catch (e) { message.error(getErrorMessage(e)); }
  };

  const uploadVersion = async (file, changeNote) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('change_note', changeNote || '');
      const r = await api.post(`/documents/groups/${versionsDrawer.id}/new-version`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      message.success(`Version ${r.data.version_number} uploaded`);
      openVersions({ id: versionsDrawer.id });
      fetch();
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setUploading(false); }
  };

  const cols = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: 'Name', dataIndex: 'name', render: (v) => <strong>{v}</strong> },
    { title: 'Category', dataIndex: 'category', render: (v) => v ? <Tag>{v}</Tag> : '—', width: 120 },
    { title: 'Source', key: 's', render: (_, r) => r.source_type ? `${r.source_type} #${r.source_id || '—'}` : '—' },
    { title: 'Latest', dataIndex: 'current_version_number', render: (v) => <Tag color="blue">v{v || 0}</Tag>, width: 80 },
    { title: 'Updated', dataIndex: 'updated_at', width: 160, render: (v) => v?.replace('T', ' ').slice(0, 16) },
    {
      title: 'Actions', key: 'x', width: 200,
      render: (_, row) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => openVersions(row)}>Versions</Button>
          <Popconfirm title="Archive this document?" onConfirm={() => handleArchive(row.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Input.Search
          placeholder="Search by name…"
          allowClear
          style={{ width: 280 }}
          onSearch={(v) => { setPage(1); setFilter((f) => ({ ...f, search: v })); }}
        />
        <Select allowClear placeholder="Category" style={{ width: 180 }} value={filter.category}
          onChange={(v) => { setPage(1); setFilter((f) => ({ ...f, category: v })); }}>
          {CATEGORIES.map((c) => <Select.Option key={c} value={c}>{c}</Select.Option>)}
        </Select>
        <Button icon={<ReloadOutlined />} onClick={fetch}>Refresh</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>New Document</Button>
      </Space>
      <Card>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={rows}
          columns={cols}
          size="small"
          pagination={{ current: page, total, pageSize: 25, onChange: setPage, showSizeChanger: false }}
        />
      </Card>

      <Modal
        title="Create Document"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={handleCreate}
      >
        <Form form={createForm} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="e.g. Vendor License — ABC Pharma" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="category" label="Category">
            <Select allowClear>
              {CATEGORIES.map((c) => <Select.Option key={c} value={c}>{c}</Select.Option>)}
            </Select>
          </Form.Item>
          <Form.Item name="source_type" label="Source Type (optional)">
            <Input placeholder="e.g. vendor, purchase_order" />
          </Form.Item>
          <Form.Item name="source_id" label="Source ID (optional)">
            <Input type="number" />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={versionsDrawer ? `${versionsDrawer.name} — Version History` : 'Versions'}
        open={!!versionsDrawer}
        onClose={() => setVersionsDrawer(null)}
        width={720}
      >
        {versionsDrawer && (
          <>
            <Space style={{ marginBottom: 16 }}>
              <Upload
                beforeUpload={(file) => {
                  setUploadNote('');
                  Modal.confirm({
                    title: 'Upload as new version?',
                    content: (
                      <Form layout="vertical">
                        <Form.Item label="Change note">
                          <Input.TextArea
                            rows={2}
                            placeholder="What changed?"
                            defaultValue=""
                            onChange={(e) => setUploadNote(e.target.value)}
                          />
                        </Form.Item>
                      </Form>
                    ),
                    onOk: () => {
                      // BUG-HC-120 fix: read the note from React state, not
                      // the DOM. setUploadNote was kept in scope above.
                      uploadVersion(file, uploadNote || '');
                    },
                  });
                  return false;
                }}
                showUploadList={false}
              >
                <Button type="primary" icon={<UploadOutlined />} loading={uploading}>Upload New Version</Button>
              </Upload>
            </Space>
            <Table
              rowKey="id"
              dataSource={versionsDrawer.versions || []}
              size="small"
              pagination={false}
              columns={[
                { title: 'v', dataIndex: 'version_number', width: 50, render: (v) => <Tag color="blue">v{v}</Tag> },
                { title: 'File', dataIndex: 'file_name' },
                { title: 'Size', dataIndex: 'file_size', width: 100, render: (v) => `${Math.round((v || 0) / 1024)} KB` },
                {
                  title: 'Current', dataIndex: 'is_current_version', width: 90,
                  render: (v) => v ? <Tag color="green">CURRENT</Tag> : null,
                },
                { title: 'Note', dataIndex: 'change_note', ellipsis: true },
                {
                  // BUG-HC-119 fix: the static /uploads mount is disabled,
                  // so a raw href={v.file_path} 404s. Route the download
                  // through the authenticated API base so cookies/Bearer
                  // tokens come along; for legacy absolute URLs
                  // (http(s)://...) we keep the original href.
                  title: '', key: 'd', width: 100,
                  render: (_, v) => {
                    if (!v.file_path) return null;
                    const isAbsolute = /^https?:\/\//i.test(v.file_path);
                    const apiBase = (api?.defaults?.baseURL || '').replace(/\/api\/v1\/?$/, '');
                    const href = isAbsolute ? v.file_path : `${apiBase}${v.file_path}`;
                    return <a href={href} target="_blank" rel="noreferrer">Download</a>;
                  },
                },
              ]}
            />
          </>
        )}
      </Drawer>
    </div>
  );
}

function TemplatesTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const [previewOpen, setPreviewOpen] = useState(null);
  const [previewBody, setPreviewBody] = useState('');
  // BUG-HC-121 fix: keep a *per-template* context map so editing the JSON
  // for template A doesn't bleed into template B's preview the next time
  // the user opens it. The single shared `contextStr` previously made it
  // impossible to keep distinct sample contexts across templates without
  // re-typing on every open.
  const DEFAULT_CTX = '{\n  "name": "ABC Pharma",\n  "po_number": "PO-00010"\n}';
  const [contextByTemplate, setContextByTemplate] = useState({});
  // Currently-edited context buffer for the preview modal.
  const [contextStr, setContextStr] = useState(DEFAULT_CTX);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/documents/templates');
      setRows(r.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ template_type: 'email', is_active: true });
    setOpen(true);
  };

  const openEdit = (row) => {
    setEditing(row);
    form.setFieldsValue(row);
    setOpen(true);
  };

  const submit = async () => {
    try {
      const v = await form.validateFields();
      if (editing) {
        await api.put(`/documents/templates/${editing.id}`, v);
        message.success('Updated');
      } else {
        await api.post('/documents/templates', v);
        message.success('Created');
      }
      setOpen(false);
      fetch();
    } catch (e) {
      if (e?.errorFields) return;
      message.error(getErrorMessage(e));
    }
  };

  const remove = async (id) => {
    try {
      await api.delete(`/documents/templates/${id}`);
      message.success('Deactivated');
      fetch();
    } catch (e) { message.error(getErrorMessage(e)); }
  };

  const preview = async (row) => {
    setPreviewOpen(row);
    // BUG-HC-121 fix: load the saved per-template context (or the default).
    const savedCtx = contextByTemplate[row.id] || DEFAULT_CTX;
    setContextStr(savedCtx);
    try {
      const ctx = JSON.parse(savedCtx);
      const r = await api.post(`/documents/templates/${row.id}/render`, ctx);
      setPreviewBody(r.data?.body || '');
    } catch (e) { message.error(getErrorMessage(e)); }
  };

  // BUG-HC-121 fix: persist the user's edits back to the per-template map
  // when they re-render so the next "Preview" reopens with their values.
  const handleContextChange = (val) => {
    setContextStr(val);
    if (previewOpen?.id) {
      setContextByTemplate((m) => ({ ...m, [previewOpen.id]: val }));
    }
  };

  const cols = [
    { title: 'Name', dataIndex: 'name', render: (v, r) => <span><strong>{v}</strong> {r.is_active ? null : <Tag>inactive</Tag>}</span> },
    { title: 'Type', dataIndex: 'template_type', width: 100, render: (v) => <Tag color="blue">{v}</Tag> },
    { title: 'Module', dataIndex: 'module', width: 140 },
    {
      title: 'Placeholders', dataIndex: 'placeholders', ellipsis: true,
      render: (v) => v && v.length ? v.map((p) => <Tag key={p}>{`{${p}}`}</Tag>) : '—',
    },
    {
      title: 'Actions', key: 'x', width: 200,
      render: (_, row) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => preview(row)}>Preview</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>Edit</Button>
          {/* BUG-HC-122 fix: the API endpoint soft-deletes (deactivates) the
              template — surface that fact in the button + confirmation copy
              so the user is not surprised that the row is still in the list
              after "deleting". */}
          <Popconfirm
            title="Deactivate this template?"
            description="The template will be hidden from new dispatches but kept in the audit trail."
            onConfirm={() => remove(row.id)}
            okText="Deactivate"
          >
            <Button size="small" danger icon={<DeleteOutlined />} title="Deactivate (soft delete)" /></Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={fetch}>Refresh</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>New Template</Button>
      </Space>
      <Card>
        <Table rowKey="id" loading={loading} dataSource={rows} columns={cols} size="small" pagination={{ pageSize: 20 }} />
      </Card>

      <Modal
        title={editing ? `Edit Template — ${editing.name}` : 'New Template'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={submit}
        width={760}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input />
          </Form.Item>
          <Form.Item name="template_type" label="Type" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="email">Email</Select.Option>
              <Select.Option value="text">Text</Select.Option>
              <Select.Option value="html">HTML</Select.Option>
              <Select.Option value="pdf">PDF</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="module" label="Module">
            <Input placeholder="e.g. procurement, indent, grn" />
          </Form.Item>
          <Form.Item name="subject_template" label="Subject (for emails)">
            <Input placeholder="PO {po_number} — Approval Required" />
          </Form.Item>
          <Form.Item
            name="body_template"
            label={
              <Tooltip title="Use {variable} or {nested.path} syntax — they get substituted from the render context">
                Body <ApiOutlined />
              </Tooltip>
            }
            rules={[{ required: true }]}>
            <Input.TextArea rows={8} placeholder={"Dear {vendor.name},\n\nPO {po_number} for ₹{amount} has been approved.\n\nRegards,\n{user.name}"} />
          </Form.Item>
          <Form.Item name="is_active" label="Active" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={previewOpen ? `Preview — ${previewOpen.name}` : 'Preview'}
        open={!!previewOpen}
        onCancel={() => setPreviewOpen(null)}
        footer={null}
        width={780}
      >
        <Form layout="vertical">
          <Form.Item label="Render Context (JSON)">
            <Input.TextArea
              rows={5}
              value={contextStr}
              onChange={(e) => handleContextChange(e.target.value)}
            />
          </Form.Item>
          <Button onClick={() => preview(previewOpen)}>Re-render</Button>
        </Form>
        <Card title="Rendered Output" style={{ marginTop: 16 }}>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{previewBody || '(no output)'}</pre>
        </Card>
      </Modal>
    </div>
  );
}

function TransitionRulesTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/documents/transition-rules');
      setRows(r.data || []);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ requires_e_sign: true, is_active: true });
    setOpen(true);
  };

  const openEdit = (row) => {
    setEditing(row);
    form.setFieldsValue(row);
    setOpen(true);
  };

  const submit = async () => {
    try {
      const v = await form.validateFields();
      // BUG-HC-123 fix: client-side guard that mirrors the backend check —
      // requires_attachment=true demands an attachment_category.
      if (v.requires_attachment && !(v.attachment_category && v.attachment_category.trim())) {
        message.error('Please select an attachment_category when "Require attachment" is on.');
        return;
      }
      if (editing) {
        await api.put(`/documents/transition-rules/${editing.id}`, v);
        message.success('Updated');
      } else {
        await api.post('/documents/transition-rules', v);
        message.success('Created');
      }
      setOpen(false);
      fetch();
    } catch (e) {
      if (e?.errorFields) return;
      message.error(getErrorMessage(e));
    }
  };

  const remove = async (id) => {
    try {
      await api.delete(`/documents/transition-rules/${id}`);
      message.success('Deleted');
      fetch();
    } catch (e) { message.error(getErrorMessage(e)); }
  };

  const cols = [
    { title: 'Module', dataIndex: 'module', width: 120 },
    { title: 'Source', dataIndex: 'source_type', width: 160 },
    { title: 'From', dataIndex: 'from_state', width: 130, render: (v) => v ? <Tag>{v}</Tag> : <Tag>any</Tag> },
    { title: '→', width: 30, align: 'center', render: () => '→' },
    { title: 'To', dataIndex: 'to_state', width: 140, render: (v) => <Tag color="blue">{v}</Tag> },
    { title: 'E-Sign', dataIndex: 'requires_e_sign', width: 90, render: (v) => v ? <Tag color="red">Required</Tag> : '—' },
    { title: 'Attachment', dataIndex: 'requires_attachment', width: 110, render: (v, r) => v ? <Tag color="orange">{r.attachment_category || 'any'}</Tag> : '—' },
    { title: 'Active', dataIndex: 'is_active', width: 80, render: (v) => v ? <Tag color="green">on</Tag> : <Tag>off</Tag> },
    {
      title: 'Actions', key: 'x', width: 140,
      render: (_, row) => (
        <Space>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>Edit</Button>
          <Popconfirm title="Delete?" onConfirm={() => remove(row.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={fetch}>Refresh</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>New Rule</Button>
      </Space>
      <Card>
        <Table rowKey="id" loading={loading} dataSource={rows} columns={cols} size="small" pagination={{ pageSize: 25 }} />
      </Card>

      <Modal
        title={editing ? `Edit Rule #${editing.id}` : 'New Transition Rule'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={submit}
        width={680}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="module" label="Module" rules={[{ required: true }]}>
            <Input placeholder="procurement, indent, accounts, …" />
          </Form.Item>
          <Form.Item name="source_type" label="Source Type" rules={[{ required: true }]}>
            <Input placeholder="purchase_order, indent, invoice, …" />
          </Form.Item>
          <Form.Item name="from_state" label="From State (blank = any)">
            <Input placeholder="draft / pending_approval / …" />
          </Form.Item>
          <Form.Item name="to_state" label="To State" rules={[{ required: true }]}>
            <Input placeholder="approved / submitted / completed" />
          </Form.Item>
          <Form.Item name="requires_e_sign" label="Require e-signature" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="requires_attachment" label="Require attachment" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="attachment_category" label="Attachment category (optional)">
            <Input placeholder="contract, license, signed_invoice, …" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="is_active" label="Active" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export default function Documents() {
  return (
    <div>
      <PageHeader
        title="Document Management"
        subtitle="Versioned documents, reusable templates, and state-transition compliance rules"
      />
      <Tabs
        defaultActiveKey="docs"
        items={[
          { key: 'docs', label: <span><FileTextOutlined /> Documents</span>, children: <GroupsTab /> },
          { key: 'tpl', label: <span><GoldOutlined /> Templates</span>, children: <TemplatesTab /> },
          { key: 'rules', label: <span><ApiOutlined /> Transition Rules</span>, children: <TransitionRulesTab /> },
        ]}
      />
    </div>
  );
}
