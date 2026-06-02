import React, { useState, useCallback, useEffect } from 'react';
import {
  Select, DatePicker, Button, Card, Row, Col, Tag, message,
} from 'antd';
import { DownloadOutlined, FilterOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import api from '../../config/api';
import { formatDateTime, formatDate, formatDateForAPI, getErrorMessage, downloadExcel } from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { RangePicker } = DatePicker;

const REPORT_TYPES = [
  { label: 'Activity Logs & Audit Trail', value: 'activity_logs' },
  { label: 'System Mails', value: 'system_mails' },
  { label: 'Portal Activities', value: 'portal_activities' },
  { label: 'API Usage', value: 'api_usage' },
  { label: 'Pending Inventory Valuations', value: 'pending_valuations' },
  { label: 'Scheduled Workflow Rules/Actions', value: 'scheduled_workflows' },
];

const ACTION_COLORS = {
  create: 'green',
  update: 'blue',
  delete: 'red',
  login: 'cyan',
  logout: 'default',
  approve: 'purple',
  reject: 'orange',
  export: 'geekblue',
  print: 'default',
  view: 'default',
};

const SystemReports = () => {
  const [reportType, setReportType] = useState('activity_logs');
  const [dateRange, setDateRange] = useState(null);
  const [user, setUser] = useState(undefined);
  const [module, setModule] = useState(undefined);
  const [refreshKey, setRefreshKey] = useState(0);
  const [users, setUsers] = useState([]);

  const MODULE_OPTIONS = [
    { label: 'Masters', value: 'masters' },
    { label: 'Procurement', value: 'procurement' },
    { label: 'Warehouse', value: 'warehouse' },
    { label: 'Inventory', value: 'inventory' },
    { label: 'Outbound', value: 'outbound' },
    { label: 'Indent', value: 'indent' },
    { label: 'Consumption', value: 'consumption' },
    { label: 'Approvals', value: 'approvals' },
    { label: 'Accounts', value: 'accounts' },
    { label: 'Assets', value: 'assets' },
    { label: 'Settings', value: 'settings' },
    { label: 'Auth', value: 'auth' },
  ];

  useEffect(() => {
    fetchLookups();
  }, []);

  const fetchLookups = async () => {
    try {
      const res = await api.get('/settings/users', { params: { page_size: 500 } });
      const d = res.data;
      setUsers((d.items || d.data || d || []).map((u) => ({ label: u.full_name || u.username, value: u.id })));
    } catch { /* silent */ }
  };

  const fetchReport = useCallback(
    async (params) => {
      const queryParams = { ...params, report_type: reportType };
      if (user) queryParams.user_id = user;
      if (module) queryParams.module = module;
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }
      return await api.get('/reports/system', { params: queryParams });
    },
    [reportType, user, module, dateRange]
  );

  const handleExport = async () => {
    try {
      const queryParams = { report_type: reportType, page_size: 50000 };
      if (user) queryParams.user_id = user;
      if (module) queryParams.module = module;
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }
      const res = await api.get('/reports/system', { params: queryParams });
      const data = res.data;
      const rows = data.items || data.data || data || [];
      const cols = getColumns();
      const exportData = rows.map((row) => {
        const exp = {};
        cols.forEach((c) => {
          if (c.dataIndex && c.title) {
            const key = typeof c.dataIndex === 'string' ? c.dataIndex : c.dataIndex.join('.');
            let val = typeof c.dataIndex === 'string' ? row[c.dataIndex] : (c.dataIndex || []).reduce((o, k) => (o ? o[k] : undefined), row);
            exp[typeof c.title === 'string' ? c.title : key] = val;
          }
        });
        return exp;
      });
      downloadExcel(exportData, `system_${reportType}`, REPORT_TYPES.find((r) => r.value === reportType)?.label || reportType);
      message.success('Export completed');
    } catch (err) { message.error(getErrorMessage(err)); }
  };

  const getColumns = () => {
    switch (reportType) {
      case 'activity_logs':
        return [
          { title: 'Timestamp', dataIndex: 'timestamp', key: 'timestamp', width: 170, render: (v) => formatDateTime(v), sorter: true },
          { title: 'User', dataIndex: 'user_name', key: 'user', width: 150 },
          { title: 'Module', dataIndex: 'module', key: 'module', width: 120, render: (v) => <Tag>{v ? v.charAt(0).toUpperCase() + v.slice(1) : '-'}</Tag> },
          { title: 'Action', dataIndex: 'action', key: 'action', width: 100, render: (v) => <Tag color={ACTION_COLORS[v] || 'default'}>{v ? v.charAt(0).toUpperCase() + v.slice(1) : '-'}</Tag> },
          { title: 'Entity', dataIndex: 'entity_type', key: 'entity', width: 130 },
          { title: 'Entity ID', dataIndex: 'entity_id', key: 'entity_id', width: 110 },
          { title: 'Description', dataIndex: 'description', key: 'description', width: 300, ellipsis: true },
          { title: 'IP Address', dataIndex: 'ip_address', key: 'ip', width: 130 },
        ];

      case 'system_mails':
        return [
          { title: 'Sent At', dataIndex: 'sent_at', key: 'sent_at', width: 170, render: (v) => formatDateTime(v), sorter: true },
          { title: 'From', dataIndex: 'from_email', key: 'from', width: 180 },
          { title: 'To', dataIndex: 'to_email', key: 'to', width: 200 },
          { title: 'Subject', dataIndex: 'subject', key: 'subject', width: 300, ellipsis: true },
          { title: 'Template', dataIndex: 'template', key: 'template', width: 140 },
          { title: 'Status', dataIndex: 'status', key: 'status', width: 100, render: (v) => {
            const color = v === 'sent' ? 'green' : v === 'failed' ? 'red' : v === 'queued' ? 'orange' : 'default';
            return <Tag color={color}>{v ? v.charAt(0).toUpperCase() + v.slice(1) : '-'}</Tag>;
          }},
          { title: 'Error', dataIndex: 'error_message', key: 'error', width: 200, ellipsis: true, render: (v) => v || '-' },
        ];

      case 'portal_activities':
        return [
          { title: 'Timestamp', dataIndex: 'timestamp', key: 'timestamp', width: 170, render: (v) => formatDateTime(v), sorter: true },
          { title: 'User', dataIndex: 'user_name', key: 'user', width: 150 },
          { title: 'Portal', dataIndex: 'portal_type', key: 'portal', width: 120 },
          { title: 'Action', dataIndex: 'action', key: 'action', width: 120, render: (v) => <Tag color={ACTION_COLORS[v] || 'default'}>{v || '-'}</Tag> },
          { title: 'Page', dataIndex: 'page', key: 'page', width: 180, ellipsis: true },
          { title: 'Description', dataIndex: 'description', key: 'description', width: 300, ellipsis: true },
          { title: 'IP Address', dataIndex: 'ip_address', key: 'ip', width: 130 },
          { title: 'Browser', dataIndex: 'user_agent', key: 'browser', width: 200, ellipsis: true },
        ];

      case 'api_usage':
        return [
          { title: 'Endpoint', dataIndex: 'endpoint', key: 'endpoint', width: 250, ellipsis: true },
          { title: 'Method', dataIndex: 'method', key: 'method', width: 80, render: (v) => {
            const colorMap = { GET: 'green', POST: 'blue', PUT: 'orange', DELETE: 'red', PATCH: 'purple' };
            return <Tag color={colorMap[v] || 'default'}>{v}</Tag>;
          }},
          { title: 'Total Calls', dataIndex: 'total_calls', key: 'calls', width: 110, align: 'right', sorter: true },
          { title: 'Avg Response (ms)', dataIndex: 'avg_response_time', key: 'avg_time', width: 150, align: 'right', render: (v) => v != null ? `${Number(v).toFixed(0)} ms` : '-' },
          { title: 'Error Rate', dataIndex: 'error_rate', key: 'error_rate', width: 110, align: 'right', render: (v) => {
            const color = v > 5 ? '#f5222d' : v > 1 ? '#fa8c16' : '#52c41a';
            return <span style={{ color, fontWeight: 600 }}>{Number(v).toFixed(1)}%</span>;
          }},
          { title: 'Last Called', dataIndex: 'last_called', key: 'last_called', width: 170, render: (v) => formatDateTime(v) },
        ];

      case 'pending_valuations':
        return [
          { title: 'Item Code', dataIndex: 'item_code', key: 'item_code', width: 130 },
          { title: 'Item Name', dataIndex: 'item_name', key: 'item_name', width: 200, ellipsis: true },
          { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 150 },
          { title: 'Transaction Type', dataIndex: 'transaction_type', key: 'type', width: 140 },
          { title: 'Qty', dataIndex: 'qty', key: 'qty', width: 80, align: 'right' },
          { title: 'Pending Since', dataIndex: 'pending_since', key: 'since', width: 170, render: (v) => formatDateTime(v), sorter: true },
          { title: 'Reference', dataIndex: 'reference', key: 'ref', width: 150 },
          { title: 'Status', dataIndex: 'status', key: 'status', width: 110, render: (v) => <Tag color="orange">{v || 'Pending'}</Tag> },
        ];

      case 'scheduled_workflows':
        return [
          { title: 'Rule Name', dataIndex: 'rule_name', key: 'rule', width: 200, ellipsis: true },
          { title: 'Module', dataIndex: 'module', key: 'module', width: 120, render: (v) => <Tag>{v || '-'}</Tag> },
          { title: 'Trigger', dataIndex: 'trigger_type', key: 'trigger', width: 130 },
          { title: 'Schedule', dataIndex: 'schedule', key: 'schedule', width: 150 },
          { title: 'Next Run', dataIndex: 'next_run', key: 'next_run', width: 170, render: (v) => formatDateTime(v), sorter: true },
          { title: 'Last Run', dataIndex: 'last_run', key: 'last_run', width: 170, render: (v) => formatDateTime(v) },
          { title: 'Last Result', dataIndex: 'last_result', key: 'result', width: 110, render: (v) => {
            const color = v === 'success' ? 'green' : v === 'failed' ? 'red' : 'default';
            return <Tag color={color}>{v ? v.charAt(0).toUpperCase() + v.slice(1) : '-'}</Tag>;
          }},
          { title: 'Active', dataIndex: 'is_active', key: 'active', width: 80, render: (v) => v ? <Tag color="green">Yes</Tag> : <Tag>No</Tag> },
        ];

      default:
        return [];
    }
  };

  return (
    <div>
      <PageHeader
        title="System Reports"
        subtitle={REPORT_TYPES.find((r) => r.value === reportType)?.label || 'Select a report'}
      >
        <Button icon={<DownloadOutlined />} onClick={handleExport}>Export to Excel</Button>
      </PageHeader>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={[12, 12]} align="middle">
          <Col xs={24} sm={12} md={5}>
            <Select
              placeholder="Select Report"
              style={{ width: '100%' }}
              value={reportType}
              onChange={(v) => { setReportType(v); setRefreshKey((k) => k + 1); }}
              options={REPORT_TYPES}
              showSearch
              optionFilterProp="label"
            />
          </Col>
          {reportType === 'activity_logs' && (
            <>
              <Col xs={24} sm={12} md={4}>
                <Select
                  placeholder="User"
                  allowClear
                  style={{ width: '100%' }}
                  value={user}
                  onChange={setUser}
                  options={users}
                  showSearch
                  optionFilterProp="label"
                />
              </Col>
              <Col xs={24} sm={12} md={4}>
                <Select
                  placeholder="Module"
                  allowClear
                  style={{ width: '100%' }}
                  value={module}
                  onChange={setModule}
                  options={MODULE_OPTIONS}
                  showSearch
                  optionFilterProp="label"
                />
              </Col>
            </>
          )}
          <Col xs={24} sm={12} md={6}>
            <RangePicker style={{ width: '100%' }} value={dateRange} onChange={setDateRange} format={DATE_FORMAT} />
          </Col>
          <Col xs={24} sm={6} md={3}>
            <Button type="primary" icon={<FilterOutlined />} onClick={() => setRefreshKey((k) => k + 1)} block>Apply</Button>
          </Col>
        </Row>
      </Card>

      <DataTable
        key={`${reportType}_${refreshKey}`}
        columns={getColumns()}
        fetchFunction={fetchReport}
        rowKey="id"
        searchPlaceholder="Search logs..."
        exportFileName={`system_${reportType}`}
        scroll={{ x: 1200 }}
      />
    </div>
  );
};

export default SystemReports;
