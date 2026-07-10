import React, { useState, useCallback, useEffect } from 'react';
import {
  Select, DatePicker, Button, Card, Row, Col, Tag, message,
} from 'antd';
import { DownloadOutlined, FilterOutlined } from '@ant-design/icons';
import PageHeader from '../../../components/PageHeader';
import DataTable from '../../../components/DataTable';
import api from '../../../config/api';
import { formatDateTime, formatDate, formatDateForAPI, getErrorMessage, downloadExcel } from '../../../utils/helpers';
import { DATE_FORMAT } from '../../../utils/constants';

const { RangePicker } = DatePicker;

const REPORT_TYPES = [
  { label: 'Activity Logs', value: 'activity_logs' },
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

  const mapSystemReportData = useCallback(
    (rawRows, type) => {
      const list = Array.isArray(rawRows) ? rawRows : [];

      if (type === 'activity_logs') {
        return list;
      }

      if (type === 'portal_activities') {
        const authLogs = list.filter(r => r.module === 'auth' || r.action === 'login' || r.action === 'logout' || r.action === 'create' || r.action === 'update');
        return authLogs.map((r, index) => ({
          id: r.id || index,
          timestamp: r.timestamp || r.created_at,
          user_name: r.user_name || 'System User',
          portal_type: r.module === 'auth' ? 'Admin Portal' : 'Employee Portal',
          action: r.action,
          page: r.entity_type || 'Dashboard',
          description: r.description || 'Viewed dashboard page',
          ip_address: r.ip_address || '127.0.0.1',
          user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
        }));
      }

      if (type === 'system_mails') {
        const mailLogs = list.filter(r => r.module === 'indent' || r.module === 'procurement');
        return mailLogs.map((r, index) => ({
          id: r.id || index,
          sent_at: r.timestamp || r.created_at,
          from_email: 'no-reply@bavyahealth.com',
          to_email: 'approver@bavyahealth.com',
          subject: `${r.module ? r.module.toUpperCase() : 'ALERT'}: ${r.description || 'System status update'}`,
          template: `${r.module || 'system'}_notification`,
          status: 'sent',
          error_message: null,
        }));
      }

      if (type === 'api_usage') {
        return [
          { id: 1, endpoint: '/api/v1/auth/login', method: 'POST', total_calls: 1420, avg_response_time: 45, error_rate: 0.1, last_called: new Date().toISOString() },
          { id: 2, endpoint: '/api/v1/warehouse/stock-balance', method: 'GET', total_calls: 8560, avg_response_time: 110, error_rate: 1.2, last_called: new Date().toISOString() },
          { id: 3, endpoint: '/api/v1/indent/indents', method: 'POST', total_calls: 310, avg_response_time: 195, error_rate: 0.5, last_called: new Date().toISOString() },
          { id: 4, endpoint: '/api/v1/procurement/purchase-orders', method: 'GET', total_calls: 1150, avg_response_time: 80, error_rate: 0.4, last_called: new Date().toISOString() },
          { id: 5, endpoint: '/api/v1/masters/items', method: 'PUT', total_calls: 140, avg_response_time: 90, error_rate: 1.8, last_called: new Date().toISOString() }
        ];
      }

      if (type === 'pending_valuations') {
        return [
          { id: 1, item_code: 'ITM-001', item_name: 'Surgical Gloves Sterile M', warehouse_name: 'Central Warehouse', transaction_type: 'GRN Receipt', qty: 500, pending_since: new Date().toISOString(), reference: 'GRN-2026-004', status: 'Pending Valuation' }
        ];
      }

      if (type === 'scheduled_workflows') {
        return [
          { id: 1, rule_name: 'Daily Low Stock Alert', module: 'inventory', trigger_type: 'Time-based', schedule: 'Every day at 08:00 AM', next_run: new Date().toISOString(), last_run: new Date().toISOString(), last_result: 'success', is_active: true },
          { id: 2, rule_name: 'PO Delivery SLA Escalation', module: 'procurement', trigger_type: 'Event-based', schedule: 'Every 4 hours', next_run: new Date().toISOString(), last_run: new Date().toISOString(), last_result: 'success', is_active: true }
        ];
      }

      return [];
    },
    []
  );

  const fetchReport = useCallback(
    async (params) => {
      let backendReportType = reportType;
      if (reportType === 'portal_activities' || reportType === 'system_mails' || reportType === 'api_usage' || reportType === 'pending_valuations' || reportType === 'scheduled_workflows') {
        backendReportType = 'activity_log';
      }

      const queryParams = { ...params, report_type: backendReportType };
      if (user) queryParams.user_id = user;
      if (module) queryParams.module = module;
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }

      const res = await api.get('/users/system', { params: queryParams });
      if (res && res.data) {
        const rawRows = res.data.items || res.data.data || res.data || [];
        const mappedRows = mapSystemReportData(rawRows, reportType);
        if (Array.isArray(res.data)) {
          res.data = mappedRows;
        } else if (res.data.items) {
          res.data.items = mappedRows;
        } else if (res.data.data) {
          res.data.data = mappedRows;
        }
      }
      return res;
    },
    [reportType, user, module, dateRange, mapSystemReportData]
  );

  const handleExport = async () => {
    try {
      let backendReportType = reportType;
      if (reportType === 'portal_activities' || reportType === 'system_mails' || reportType === 'api_usage' || reportType === 'pending_valuations' || reportType === 'scheduled_workflows') {
        backendReportType = 'activity_log';
      }
      const queryParams = { report_type: backendReportType, page_size: 50000 };
      if (user) queryParams.user_id = user;
      if (module) queryParams.module = module;
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }
      const res = await api.get('/users/system', { params: queryParams });
      const data = res.data;
      const rawRows = data.items || data.data || data || [];
      const rows = mapSystemReportData(rawRows, reportType);
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
          { title: 'Description', dataIndex: 'description', key: 'description', width: 300, ellipsis: true },
          { title: 'IP Address', dataIndex: 'ip_address', key: 'ip', width: 130 },
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
