import React, { useState, useEffect, useCallback } from 'react';
import {
  Button, Form, Input, InputNumber, Select, Space, DatePicker,
  message, Row, Col, Table, Card, Descriptions, Divider,
  Typography, Tooltip, Spin, Popconfirm,
} from 'antd';
import {
  PlusOutlined, ArrowLeftOutlined, SendOutlined, EditOutlined,
  MinusCircleOutlined, SaveOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useParams, useNavigate } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import useAuthStore from '../../store/authStore';
import {
  formatDate, formatCurrency, getErrorMessage, formatDateForAPI,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

// Verhoeff checksum (UIDAI Aadhaar standard). 12 digits validate against
// the d/p/inv tables; any tampered digit fails. Without this we accept
// "111122223333" as valid which is obviously not a real Aadhaar.
const _verhoeff_d = [
  [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
  [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
  [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
  [9,8,7,6,5,4,3,2,1,0],
];
const _verhoeff_p = [
  [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
  [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
  [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
];
const isValidAadhaar = (raw) => {
  const s = String(raw || '').replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(s)) return false;
  let c = 0;
  const digits = s.split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) {
    c = _verhoeff_d[c][_verhoeff_p[i % 8][digits[i]]];
  }
  return c === 0;
};

const ConsumptionEntryForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  // Field staff shouldn't be entering rates — those come from FEFO/avg cost
  // on the backend. Lock the column for them; managers/operators can still
  // override (e.g. for reconciliation).
  const user = useAuthStore((s) => s.user);
  const userRoleCodes = (user?.roles || []).map(
    (r) => (r?.code || r?.role_code || '').toLowerCase()
  );
  const isFieldStaffOnly = userRoleCodes.length > 0
    && userRoleCodes.every((c) => ['field_staff', 'field_user', 'nurse'].includes(c));

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [entry, setEntry] = useState(null);
  const [editMode, setEditMode] = useState(isNew);

  // Items
  const [consumptionItems, setConsumptionItems] = useState([
    { key: Date.now(), item_id: null, item_name: '', batch_id: null, qty: 1, uom_id: null, uom: '', rate: 0, remarks: '' },
  ]);

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
        const list = (w.items || w.data || w || []).map((i) => ({ label: i.name || i.warehouse_name, value: i.id }));
        setWarehouses(list);
        if (list.length === 1) form.setFieldValue('warehouse_id', list[0].value);
      }
      if (projRes.status === 'fulfilled') {
        const p = projRes.value.data;
        const list = (p.items || p.data || p || []).map((i) => ({ label: i.name || i.project_name, value: i.id }));
        setProjects(list);
        if (list.length === 1) form.setFieldValue('project_id', list[0].value);
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
      fetchEntry();
    } else {
      form.setFieldsValue({
        consumption_date: dayjs(),
        source: 'web',
      });
    }
  }, [id]);

  const fetchEntry = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/consumption/entries/${id}`);
      const data = res.data;
      setEntry(data);
      form.setFieldsValue({
        ...data,
        consumption_date: data.consumption_date ? dayjs(data.consumption_date) : null,
      });
      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_name: item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.item_name || item.item.name}` : ''),
        batch_id: item.batch_id || null,
        qty: item.qty || item.quantity || 0,
        uom_id: item.uom_id || null,
        uom: item.uom || item.unit || '',
        rate: item.rate || 0,
        remarks: item.remarks || '',
      }));
      setConsumptionItems(items.length > 0 ? items : [
        { key: Date.now(), item_id: null, item_name: '', batch_id: null, qty: 1, uom_id: null, uom: '', rate: 0, remarks: '' },
      ]);
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/consumption/entry');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (submitAfterSave = false) => {
    try {
      const values = await form.validateFields();
      const validItems = consumptionItems.filter((item) => item.item_id);
      if (validItems.length === 0) {
        message.error('Please add at least one item');
        return;
      }
      setSubmitting(true);

      const payload = {
        ...values,
        consumption_date: formatDateForAPI(values.consumption_date),
        source: 'web',
        items: validItems.map((item) => ({
          item_id: item.item_id,
          batch_id: item.batch_id || null,
          qty: item.qty,
          uom_id: item.uom_id || null,
          rate: item.rate || 0,
          remarks: item.remarks || '',
        })),
      };

      if (isNew) {
        const res = await api.post('/consumption/entries', payload);
        const newId = res.data.id || res.data.data?.id;
        if (submitAfterSave && newId) {
          // BUG-ISS-123 — surface the real backend error (insufficient stock,
          // expired batch, etc.) instead of swallowing it under a fake
          // success message. Save succeeded, but submit failed — say so.
          try {
            await api.post(`/consumption/entries/${newId}/submit`);
            message.success('Consumption entry created and submitted');
          } catch (submitErr) {
            message.warning(`Saved as draft, but submit failed: ${getErrorMessage(submitErr)}`);
          }
        } else {
          message.success('Consumption entry created successfully');
        }
        navigate(`/consumption/entry/${newId}`);
      } else {
        await api.put(`/consumption/entries/${id}`, payload);
        if (submitAfterSave) {
          // BUG-ISS-123 — same fix on the update path: surface the real
          // backend error so the operator knows the entry is still draft.
          try {
            await api.post(`/consumption/entries/${id}/submit`);
            message.success('Consumption entry updated and submitted');
          } catch (submitErr) {
            message.warning(`Saved as draft, but submit failed: ${getErrorMessage(submitErr)}`);
          }
        } else {
          message.success('Consumption entry updated successfully');
        }
        setEditMode(false);
        fetchEntry();
      }
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitEntry = async () => {
    try {
      await api.post(`/consumption/entries/${id}/submit`);
      message.success('Consumption entry submitted');
      fetchEntry();
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // Item row management
  const addItemRow = () => {
    setConsumptionItems((prev) => [
      ...prev,
      { key: Date.now(), item_id: null, item_name: '', batch_id: null, qty: 1, uom_id: null, uom: '', rate: 0, remarks: '' },
    ]);
  };

  const removeItemRow = (key) => {
    setConsumptionItems((prev) => prev.filter((item) => item.key !== key));
  };

  const updateItemRow = (key, field, value) => {
    setConsumptionItems((prev) =>
      prev.map((item) => (item.key === key ? { ...item, [field]: value } : item))
    );
  };

  // Compute totals
  const computeTotal = () => {
    return consumptionItems.reduce((sum, item) => sum + (item.qty || 0) * (item.rate || 0), 0);
  };

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}><Spin size="large" /></div>;
  }

  // Detail / View mode for existing entry
  if (!isNew && entry && !editMode) {
    const entryItems = entry.items || [];
    const totalAmount = entryItems.reduce((sum, item) => sum + (item.qty || 0) * (item.rate || 0), 0);

    return (
      <div>
        <PageHeader title={entry.consumption_number || entry.entry_number || `Consumption #${id}`} subtitle="Consumption Entry Detail">
          <Space>
            {(entry.status === 'draft') && (
              <>
                <Button icon={<EditOutlined />} onClick={() => setEditMode(true)}>Edit</Button>
                <Button type="primary" icon={<SendOutlined />} onClick={handleSubmitEntry}>Submit</Button>
              </>
            )}
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/consumption/entry')}>Back</Button>
          </Space>
        </PageHeader>

        <Card>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="Entry Number">{entry.consumption_number || entry.entry_number || '-'}</Descriptions.Item>
            <Descriptions.Item label="Consumption Date">{formatDate(entry.consumption_date)}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={entry.status} /></Descriptions.Item>
            <Descriptions.Item label="Department">{entry.department || entry.department_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Warehouse">{entry.warehouse_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Project">{entry.project_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Cost Center">{entry.cost_center || '-'}</Descriptions.Item>
            <Descriptions.Item label="Source">{entry.source || '-'}</Descriptions.Item>
            <Descriptions.Item label="Created By">{entry.created_by_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Case ID">{entry.case_id || '-'}</Descriptions.Item>
            {/* BUG-ISS-050 — patient identifiers must only render to roles
                authorised to view clinical PII. Anyone else sees a redacted
                placeholder so the operator can still confirm the entry has
                a patient on file. */}
            <Descriptions.Item label="Patient Name">{
              (() => {
                try {
                  // Lazily resolve auth store; fall back to redaction if unavailable.
                  // eslint-disable-next-line global-require
                  const { default: useAuthStore } = require('../../store/authStore');
                  const has = useAuthStore.getState().hasPermission;
                  const allowed = has('consumption', 'view_pii') || has('clinical', 'view') || has('healthcare', 'view');
                  return entry.patient_name ? (allowed ? entry.patient_name : '••• (redacted)') : '-';
                } catch {
                  return entry.patient_name ? '••• (redacted)' : '-';
                }
              })()
            }</Descriptions.Item>
            <Descriptions.Item label="Patient Aadhaar">{entry.patient_aadhaar ? entry.patient_aadhaar : '-'}</Descriptions.Item>
            <Descriptions.Item label="Remarks" span={3}>{entry.remarks || '-'}</Descriptions.Item>
          </Descriptions>

          <Divider orientation="left">Items</Divider>
          <Table
            dataSource={entryItems}
            rowKey={(r) => r.id || r.item_id}
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
              { title: 'Item Code', width: 120, render: (_, r) => r.item_code || (r.item && r.item.item_code) || '-' },
              { title: 'Item Name', width: 220, render: (_, r) => r.item_name || (r.item && (r.item.item_name || r.item.name)) || '-' },
              { title: 'Qty', dataIndex: 'qty', width: 80, align: 'right', render: (v, r) => v || r.quantity || 0 },
              { title: 'UOM', dataIndex: 'uom', width: 80, render: (v, r) => v || r.unit || '-' },
              { title: 'Rate', dataIndex: 'rate', width: 100, align: 'right', render: (v) => formatCurrency(v) },
              { title: 'Amount', width: 120, align: 'right', render: (_, r) => formatCurrency((r.qty || 0) * (r.rate || 0)) },
              { title: 'Remarks', dataIndex: 'remarks', width: 160, ellipsis: true, render: (v) => v || '-' },
            ]}
            summary={() => (
              <Table.Summary fixed>
                <Table.Summary.Row>
                  <Table.Summary.Cell index={0} colSpan={6} align="right">
                    <Text strong>Total</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={6} align="right">
                    <Text strong>{formatCurrency(totalAmount)}</Text>
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={7} />
                </Table.Summary.Row>
              </Table.Summary>
            )}
          />
        </Card>
      </div>
    );
  }

  // Edit / Create mode
  const itemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item', dataIndex: 'item_id', width: 260,
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
      title: 'Qty', dataIndex: 'qty', width: 100,
      render: (val, record) => (
        <InputNumber min={0.01} value={val} onChange={(v) => updateItemRow(record.key, 'qty', v)} style={{ width: '100%' }} />
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
          showSearch
          optionFilterProp="label"
          allowClear
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Rate', dataIndex: 'rate', width: 110,
      render: (val, record) => (
        <InputNumber
          min={0}
          value={val}
          onChange={(v) => updateItemRow(record.key, 'rate', v)}
          style={{ width: '100%' }}
          precision={2}
          disabled={isFieldStaffOnly}
        />
      ),
    },
    {
      title: 'Amount', width: 110, align: 'right',
      render: (_, record) => <Text>{formatCurrency((record.qty || 0) * (record.rate || 0))}</Text>,
    },
    {
      title: 'Remarks', dataIndex: 'remarks', width: 150,
      render: (val, record) => (
        <Input value={val} onChange={(e) => updateItemRow(record.key, 'remarks', e.target.value)} placeholder="Remarks" />
      ),
    },
    {
      title: '', width: 40,
      render: (_, record) => consumptionItems.length > 1 ? (
        <Tooltip title="Remove"><MinusCircleOutlined style={{ color: '#ff4d4f', cursor: 'pointer', fontSize: 16 }} onClick={() => removeItemRow(record.key)} /></Tooltip>
      ) : null,
    },
  ];

  return (
    <div>
      <PageHeader title={isNew ? 'Create Consumption Entry' : `Edit ${entry?.consumption_number || entry?.entry_number || ''}`} subtitle={isNew ? 'Record material consumption' : 'Edit consumption entry'}>
        <Space>
          <Button onClick={() => navigate('/consumption/entry')} icon={<ArrowLeftOutlined />}>Back</Button>
          {!isNew && <Button onClick={() => setEditMode(false)}>Cancel Edit</Button>}
        </Space>
      </PageHeader>

      <Card>
        <Form form={form} layout="vertical">
          {/* Hidden registration so auto-filled warehouse_id/project_id flow
              through validateFields(). See IndentForm.jsx. */}
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
                  <Select options={warehouses} placeholder="Select warehouse" allowClear showSearch optionFilterProp="label" />
                </Form.Item>
              </Col>
            )}
            {projects.length > 1 && (
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="project_id" label="Project">
                  <Select options={projects} placeholder="Select project" allowClear showSearch optionFilterProp="label" />
                </Form.Item>
              </Col>
            )}
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="consumption_date" label="Consumption Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="department" label="Department (optional)">
                <Select options={departments} placeholder="Select department" allowClear showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="case_id" label="Case ID (optional)">
                <Input placeholder="e.g. OPD-12345" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12} md={8}>
              <Form.Item name="patient_name" label="Patient Name (optional)">
                <Input placeholder="Patient name" />
              </Form.Item>
            </Col>
          </Row>
          <details style={{ marginBottom: 12 }}>
            <summary style={{ cursor: 'pointer', color: '#7A6D66', fontSize: 13 }}>
              More fields (cost center, Aadhaar)
            </summary>
            <Row gutter={16} style={{ marginTop: 12 }}>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="cost_center" label="Cost Center">
                  <Input placeholder="Cost center" />
                </Form.Item>
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Form.Item name="patient_aadhaar" label="Patient Aadhaar"
                  rules={[
                    {
                      validator: (_, value) => {
                        if (!value) return Promise.resolve();
                        if (!/^\d{4}[\s-]?\d{4}[\s-]?\d{4}$/.test(value)) {
                          return Promise.reject(new Error('Enter as XXXX XXXX XXXX'));
                        }
                        if (!isValidAadhaar(value)) {
                          return Promise.reject(new Error('Aadhaar checksum failed'));
                        }
                        return Promise.resolve();
                      },
                    },
                  ]}
                >
                  <Input placeholder="XXXX XXXX XXXX" maxLength={14} />
                </Form.Item>
              </Col>
            </Row>
          </details>
          <Form.Item name="remarks" label="Remarks (optional)">
            <TextArea rows={2} placeholder="Any remarks..." />
          </Form.Item>
        </Form>

        <Divider orientation="left">Items</Divider>
        <Table
          dataSource={consumptionItems}
          columns={itemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 1000 }}
          footer={() => (
            <Button type="dashed" onClick={addItemRow} icon={<PlusOutlined />} block>Add Item</Button>
          )}
          summary={() => (
            <Table.Summary fixed>
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={5} align="right">
                  <Text strong>Total</Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={5} align="right">
                  <Text strong>{formatCurrency(computeTotal())}</Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={6} colSpan={2} />
              </Table.Summary.Row>
            </Table.Summary>
          )}
        />

        <Divider />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={() => navigate('/consumption/entry')}>Cancel</Button>
          <Button icon={<SaveOutlined />} onClick={() => handleSubmit(false)} loading={submitting}>Save as Draft</Button>
          <Button type="primary" icon={<SendOutlined />} onClick={() => handleSubmit(true)} loading={submitting}>Save &amp; Submit</Button>
        </div>
      </Card>
    </div>
  );
};

export default ConsumptionEntryForm;
