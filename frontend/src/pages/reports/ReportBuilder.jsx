import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Card, Row, Col, Select, Button, Table, Tag, Space, Modal, Form, Input, message, Tabs, Switch, Popconfirm, Empty, Tooltip, InputNumber,
} from 'antd';
import {
  PlayCircleOutlined, SaveOutlined, ReloadOutlined, EyeOutlined, DeleteOutlined, ApartmentOutlined, FilterOutlined, DownloadOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { formatCurrency, getErrorMessage, downloadExcel } from '../../utils/helpers';

const FILTER_OPS = [
  { value: 'eq', label: '=' },
  { value: 'ne', label: '≠' },
  { value: 'in', label: 'in' },
  { value: 'not_in', label: 'not in' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'between', label: 'between' },
  { value: 'ilike', label: 'contains' },
  { value: 'is_null', label: 'is null' },
  { value: 'is_not_null', label: 'not null' },
];

function FilterEditor({ schema, value = [], onChange }) {
  const filterableFields = schema?.filterable || [];

  const update = (i, patch) => {
    const next = value.map((row, idx) => idx === i ? { ...row, ...patch } : row);
    onChange(next);
  };
  const remove = (i) => onChange(value.filter((_, idx) => idx !== i));
  const add = () => onChange([...value, { field: filterableFields[0] || '', op: 'eq', value: '' }]);

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {value.map((f, i) => {
        const noValue = f.op === 'is_null' || f.op === 'is_not_null';
        return (
          <Space key={i}>
            <Select value={f.field} onChange={(v) => update(i, { field: v })} style={{ width: 200 }}
              options={filterableFields.map((d) => ({ value: d, label: d }))} />
            <Select value={f.op} onChange={(v) => update(i, { op: v })} style={{ width: 130 }} options={FILTER_OPS} />
            {!noValue && (
              <Input
                style={{ width: 240 }}
                value={typeof f.value === 'object' ? JSON.stringify(f.value) : f.value}
                onChange={(e) => update(i, { value: e.target.value })}
                placeholder={f.op === 'in' || f.op === 'not_in' || f.op === 'between' ? 'JSON array e.g. [1,2,3]' : 'value'}
              />
            )}
            <Button danger icon={<DeleteOutlined />} size="small" onClick={() => remove(i)} />
          </Space>
        );
      })}
      <Button icon={<FilterOutlined />} size="small" onClick={add}>Add Filter</Button>
    </Space>
  );
}

function tryParseValue(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    try { return JSON.parse(t); } catch { return v; }
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  // BUG-FIN-152: keep ISO date / datetime strings intact. The backend
  // accepts YYYY-MM-DD and YYYY-MM-DDTHH:mm:ss, so don't try to coerce.
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(t)) {
    return t;
  }
  return v;
}

export default function ReportBuilder() {
  const [schemaMap, setSchemaMap] = useState({});
  const [savedReports, setSavedReports] = useState([]);
  const [loading, setLoading] = useState(false);

  // Builder state
  const [sourceTable, setSourceTable] = useState(undefined);
  const [dimensions, setDimensions] = useState([]);
  const [measures, setMeasures] = useState([]);
  const [filters, setFilters] = useState([]);
  const [limit, setLimit] = useState(500);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);

  // Save modal
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveForm] = Form.useForm();

  // Initial load
  useEffect(() => {
    api.get('/reports-v2/schema').then((r) => setSchemaMap(r.data || {})).catch(() => {});
    refreshSaved();
  }, []);

  const refreshSaved = async () => {
    try {
      const r = await api.get('/reports-v2/definitions');
      setSavedReports(r.data || []);
    } catch (e) { /* silent */ }
  };

  const currentSchema = schemaMap[sourceTable];

  const sourceOptions = useMemo(
    () => Object.keys(schemaMap).map((k) => ({ value: k, label: schemaMap[k].label || k })),
    [schemaMap],
  );

  const runPreview = useCallback(async () => {
    if (!sourceTable) { message.warning('Pick a source table first'); return; }
    setRunning(true);
    try {
      const cleanFilters = filters.map((f) => ({
        field: f.field,
        op: f.op,
        value: ['is_null', 'is_not_null'].includes(f.op) ? null : tryParseValue(f.value),
      }));
      const r = await api.post('/reports-v2/preview', {
        source_table: sourceTable, dimensions, measures, filters: cleanFilters,
      }, { params: { limit } });
      setResult(r.data);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setRunning(false); }
  }, [sourceTable, dimensions, measures, filters, limit]);

  const loadSaved = (saved) => {
    setSourceTable(saved.source_table);
    setDimensions(saved.dimensions || []);
    setMeasures(saved.measures || []);
    setFilters(saved.filters || []);
    setResult(null);
  };

  const submitSave = async () => {
    // BUG-FIN-156: explicitly guard against an empty source_table — even
    // though the trigger button is disabled when none is chosen, a user can
    // still hit the modal via the keyboard while the form is loading.
    if (!sourceTable) {
      message.error('Please choose a source table before saving the report');
      return;
    }
    try {
      const v = await saveForm.validateFields();
      await api.post('/reports-v2/definitions', {
        ...v,
        source_table: sourceTable,
        dimensions,
        measures,
        filters: filters.map((f) => ({
          field: f.field, op: f.op,
          value: ['is_null', 'is_not_null'].includes(f.op) ? null : tryParseValue(f.value),
        })),
      });
      message.success('Saved');
      setSaveOpen(false);
      saveForm.resetFields();
      refreshSaved();
    } catch (e) {
      if (e?.errorFields) return;
      message.error(getErrorMessage(e));
    }
  };

  const deleteSaved = async (id) => {
    try {
      await api.delete(`/reports-v2/definitions/${id}`);
      message.success('Deleted');
      refreshSaved();
    } catch (e) { message.error(getErrorMessage(e)); }
  };

  // Result rendering
  const resultColumns = useMemo(() => {
    if (!result?.rows?.length) return [];
    const allKeys = Object.keys(result.rows[0]);
    return allKeys.map((k) => ({
      title: k,
      dataIndex: k,
      align: typeof result.rows[0][k] === 'number' ? 'right' : 'left',
      render: (v) => {
        if (typeof v === 'number') {
          return v % 1 === 0 ? v.toLocaleString() : v.toFixed(2);
        }
        return v == null ? '—' : String(v);
      },
    }));
  }, [result]);

  return (
    <div>
      <PageHeader
        title="Report Builder"
        subtitle="Configurable pivot reports across stock, consumption, POs, invoices, and stock balance"
      />
      <Row gutter={16}>
        <Col span={6}>
          <Card title="Saved Reports" size="small" style={{ marginBottom: 16 }}>
            {savedReports.length === 0 ? <Empty description="No saved reports yet" /> : savedReports.map((s) => (
              <div key={s.id} style={{ borderBottom: '1px solid #f0f0f0', padding: '8px 0' }}>
                <div><strong>{s.name}</strong> {s.is_shared ? <Tag color="blue">shared</Tag> : null}</div>
                <div style={{ color: '#888', fontSize: 12 }}>{s.source_table} • {(s.dimensions || []).length} dims • {(s.measures || []).length} measures</div>
                <Space size="small" style={{ marginTop: 4 }}>
                  <Button size="small" icon={<EyeOutlined />} onClick={() => loadSaved(s)}>Load</Button>
                  {s.is_mine && (
                    <Popconfirm title="Delete this saved report?" onConfirm={() => deleteSaved(s.id)}>
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  )}
                </Space>
              </div>
            ))}
          </Card>
        </Col>

        <Col span={18}>
          <Card title="Builder">
            <Form layout="vertical">
              <Row gutter={16}>
                <Col span={8}>
                  <Form.Item label="Source">
                    <Select
                      placeholder="Pick a fact table"
                      value={sourceTable}
                      onChange={(v) => { setSourceTable(v); setDimensions([]); setMeasures([]); setFilters([]); setResult(null); }}
                      options={sourceOptions}
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="Dimensions (group by)">
                    <Select
                      mode="multiple"
                      disabled={!currentSchema}
                      value={dimensions}
                      onChange={setDimensions}
                      options={(currentSchema?.dimensions || []).map((d) => ({ value: d, label: d }))}
                      placeholder="Pick fields to group by"
                    />
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item label="Measures (aggregations)">
                    <Select
                      mode="multiple"
                      disabled={!currentSchema}
                      value={measures}
                      onChange={setMeasures}
                      options={(currentSchema?.measures || []).map((m) => ({ value: m, label: m }))}
                      placeholder="Pick measures to compute"
                    />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item label="Filters">
                <FilterEditor schema={currentSchema} value={filters} onChange={setFilters} />
              </Form.Item>
              <Space>
                <InputNumber min={1} max={10000} value={limit} onChange={setLimit} addonBefore="Limit" />
                <Button type="primary" icon={<PlayCircleOutlined />} onClick={runPreview} loading={running}>Run Preview</Button>
                <Button icon={<SaveOutlined />} onClick={() => setSaveOpen(true)} disabled={!sourceTable}>Save Report</Button>
                {/* BUG-FIN-153: Export the current preview as XLSX. */}
                <Button
                  icon={<DownloadOutlined />}
                  disabled={!result?.rows?.length}
                  onClick={() => {
                    try {
                      const fname = `report_${sourceTable || 'export'}_${new Date().toISOString().slice(0, 10)}`;
                      downloadExcel(result.rows, fname, sourceTable || 'Report');
                    } catch (e) { message.error(getErrorMessage(e)); }
                  }}
                >
                  Export
                </Button>
              </Space>
            </Form>
          </Card>

          <Card title="Result" style={{ marginTop: 16 }}>
            {!result ? <Empty description="Run a preview to see results" /> : (
              <>
                <Row gutter={16} style={{ marginBottom: 16 }}>
                  <Col><Tag color="blue">{result.row_count} rows</Tag></Col>
                  {result.limit_applied && <Col><Tag color="orange">Limit reached ({result.limit_applied}). Refine filters.</Tag></Col>}
                  {Object.entries(result.totals || {}).map(([m, v]) => v != null && (
                    <Col key={m}><strong>{m}:</strong> {typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v}</Col>
                  ))}
                </Row>
                <Table
                  rowKey={(r, i) => i}
                  size="small"
                  dataSource={result.rows}
                  columns={resultColumns}
                  pagination={{ pageSize: 50 }}
                  scroll={{ x: 1000 }}
                />
              </>
            )}
          </Card>
        </Col>
      </Row>

      <Modal title="Save Report" open={saveOpen} onCancel={() => setSaveOpen(false)} onOk={submitSave}>
        <Form form={saveForm} layout="vertical">
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="e.g. Consumption by Department × Month" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="is_shared" label="Share with team" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
