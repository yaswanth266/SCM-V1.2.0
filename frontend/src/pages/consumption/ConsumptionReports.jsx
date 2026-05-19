import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Row, Col, Select, Space, DatePicker, Table, Typography,
  Spin, Empty, Button, Segmented, Tag,
} from 'antd';
import {
  BarChartOutlined, PieChartOutlined, LineChartOutlined,
  DownloadOutlined, FilterOutlined,
} from '@ant-design/icons';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  Legend, ResponsiveContainer,
} from 'recharts';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import StatCard from '../../components/StatCard';
import api from '../../config/api';
import {
  formatDate, formatCurrency, formatNumber, getErrorMessage,
  formatDateForAPI, downloadExcel,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { Text, Title } = Typography;
const { RangePicker } = DatePicker;

const CHART_COLORS = ['#eb2f96', '#52c41a', '#fa8c16', '#f5222d', '#722ed1', '#13c2c2', '#fa541c', '#eb2f96', '#2f54eb', '#faad14'];

const PERIOD_OPTIONS = [
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' },
  { label: 'Quarterly', value: 'quarterly' },
];

const ConsumptionReports = () => {
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('monthly');
  const [dateRange, setDateRange] = useState([dayjs().subtract(3, 'month'), dayjs()]);
  const [filterProject, setFilterProject] = useState(undefined);
  const [filterDepartment, setFilterDepartment] = useState(undefined);
  const [filterCategory, setFilterCategory] = useState(undefined);

  const [summaryData, setSummaryData] = useState({});
  const [trendData, setTrendData] = useState([]);
  const [topItemsData, setTopItemsData] = useState([]);
  const [departmentData, setDepartmentData] = useState([]);
  const [projectData, setProjectData] = useState([]);
  const [detailedData, setDetailedData] = useState([]);

  const [projects, setProjects] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    loadLookups();
  }, []);

  useEffect(() => {
    fetchReportData();
  }, [period, dateRange, filterProject, filterDepartment, filterCategory]);

  const loadLookups = async () => {
    try {
      const [projRes, deptRes, catRes] = await Promise.allSettled([
        api.get('/masters/projects', { params: { page_size: 200 } }),
        api.get('/masters/departments', { params: { page_size: 200 } }),
        api.get('/masters/categories', { params: { page_size: 200 } }),
      ]);
      if (projRes.status === 'fulfilled') {
        const p = projRes.value.data;
        setProjects((p.items || p.data || p || []).map((i) => ({ label: i.name || i.project_name, value: i.id })));
      }
      if (deptRes.status === 'fulfilled') {
        const d = deptRes.value.data;
        setDepartments((d.items || d.data || d || []).map((i) => ({ label: i.name, value: i.id })));
      }
      if (catRes.status === 'fulfilled') {
        const c = catRes.value.data;
        setCategories((c.items || c.data || c || []).map((i) => ({ label: i.name || i.category_name, value: i.id })));
      }
    } catch { /* silent */ }
  };

  const fetchReportData = async () => {
    setLoading(true);
    try {
      const params = {
        period,
        date_from: dateRange && dateRange[0] ? formatDateForAPI(dateRange[0]) : undefined,
        date_to: dateRange && dateRange[1] ? formatDateForAPI(dateRange[1]) : undefined,
        project_id: filterProject || undefined,
        department_id: filterDepartment || undefined,
        category_id: filterCategory || undefined,
      };

      // Clean undefined params
      Object.keys(params).forEach((k) => {
        if (params[k] === undefined) delete params[k];
      });

      const [summaryRes, trendRes, topItemsRes, deptRes, projRes, detailRes] = await Promise.allSettled([
        api.get('/consumption/reports/summary', { params }),
        api.get('/consumption/reports/trend', { params }),
        api.get('/consumption/reports/top-items', { params: { ...params, limit: 10 } }),
        api.get('/consumption/reports/by-department', { params }),
        api.get('/consumption/reports/by-project', { params }),
        api.get('/consumption/reports/detailed', { params: { ...params, page_size: 100 } }),
      ]);

      if (summaryRes.status === 'fulfilled') setSummaryData(summaryRes.value.data || {});
      if (trendRes.status === 'fulfilled') setTrendData(trendRes.value.data?.items || trendRes.value.data?.data || trendRes.value.data || []);
      if (topItemsRes.status === 'fulfilled') setTopItemsData(topItemsRes.value.data?.items || topItemsRes.value.data?.data || topItemsRes.value.data || []);
      if (deptRes.status === 'fulfilled') setDepartmentData(deptRes.value.data?.items || deptRes.value.data?.data || deptRes.value.data || []);
      if (projRes.status === 'fulfilled') setProjectData(projRes.value.data?.items || projRes.value.data?.data || projRes.value.data || []);
      if (detailRes.status === 'fulfilled') {
        const d = detailRes.value.data;
        setDetailedData(d.items || d.data || d || []);
      }
    } catch (err) {
      console.error('Report fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleExportDetailed = () => {
    if (detailedData.length === 0) return;
    const exportData = detailedData.map((row) => ({
      'Entry #': row.entry_number || '-',
      'Date': formatDate(row.consumption_date),
      'Project': row.project_name || '-',
      'Department': row.department_name || '-',
      'Item Code': row.item_code || '-',
      'Item Name': row.item_name || '-',
      'Qty': row.qty || 0,
      'UOM': row.uom || '-',
      'Rate': row.rate || 0,
      'Amount': row.amount || 0,
    }));
    downloadExcel(exportData, 'consumption_report');
  };

  const detailedColumns = [
    { title: 'Entry #', dataIndex: 'entry_number', key: 'entry', width: 140 },
    { title: 'Date', dataIndex: 'consumption_date', key: 'date', width: 110, render: (v) => formatDate(v) },
    { title: 'Project', dataIndex: 'project_name', key: 'proj', width: 140, render: (v) => v || '-' },
    { title: 'Department', dataIndex: 'department_name', key: 'dept', width: 140, render: (v) => v || '-' },
    { title: 'Item Code', dataIndex: 'item_code', key: 'code', width: 120, render: (v) => v || '-' },
    { title: 'Item Name', dataIndex: 'item_name', key: 'name', width: 200, ellipsis: true, render: (v) => v || '-' },
    { title: 'Qty', dataIndex: 'qty', key: 'qty', width: 80, align: 'right', render: (v) => formatNumber(v) },
    { title: 'UOM', dataIndex: 'uom', key: 'uom', width: 70, render: (v) => v || '-' },
    { title: 'Rate', dataIndex: 'rate', key: 'rate', width: 100, align: 'right', render: (v) => formatCurrency(v) },
    { title: 'Amount', dataIndex: 'amount', key: 'amount', width: 120, align: 'right', render: (v, r) => formatCurrency(v || (r.qty || 0) * (r.rate || 0)) },
  ];

  return (
    <div>
      <PageHeader title="Consumption Reports" subtitle="Consumption analytics and reporting" />

      {/* Filters */}
      <Card style={{ marginBottom: 16 }}>
        <Row gutter={[16, 12]} align="middle">
          <Col>
            <Text strong style={{ marginRight: 8 }}>Period:</Text>
            <Segmented options={PERIOD_OPTIONS} value={period} onChange={setPeriod} />
          </Col>
          <Col>
            <RangePicker
              format={DATE_FORMAT}
              value={dateRange}
              onChange={setDateRange}
              style={{ width: 260 }}
              allowClear
            />
          </Col>
          <Col>
            <Select
              placeholder="Project"
              allowClear
              style={{ width: 160 }}
              value={filterProject}
              onChange={setFilterProject}
              options={projects}
              showSearch
              optionFilterProp="label"
            />
          </Col>
          <Col>
            <Select
              placeholder="Department"
              allowClear
              style={{ width: 160 }}
              value={filterDepartment}
              onChange={setFilterDepartment}
              options={departments}
              showSearch
              optionFilterProp="label"
            />
          </Col>
          <Col>
            <Select
              placeholder="Item Category"
              allowClear
              style={{ width: 160 }}
              value={filterCategory}
              onChange={setFilterCategory}
              options={categories}
              showSearch
              optionFilterProp="label"
            />
          </Col>
        </Row>
      </Card>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
      ) : (
        <>
          {/* Summary Cards */}
          <Row gutter={16} style={{ marginBottom: 24 }}>
            <Col xs={24} sm={12} md={6}>
              <StatCard
                icon={<BarChartOutlined />}
                iconColor="#eb2f96"
                iconBg="#e6f7ff"
                value={formatNumber(summaryData.total_consumed || 0)}
                label="Total Consumed (Qty)"
                trend={summaryData.consumed_trend}
                trendLabel="vs previous period"
              />
            </Col>
            <Col xs={24} sm={12} md={6}>
              <StatCard
                icon={<LineChartOutlined />}
                iconColor="#52c41a"
                iconBg="#f6ffed"
                value={formatCurrency(summaryData.total_value || 0)}
                label="Total Value"
                trend={summaryData.value_trend}
                trendLabel="vs previous period"
              />
            </Col>
            <Col xs={24} sm={12} md={6}>
              <StatCard
                icon={<PieChartOutlined />}
                iconColor="#fa8c16"
                iconBg="#fff7e6"
                value={summaryData.top_item || '-'}
                label="Top Consumed Item"
              />
            </Col>
            <Col xs={24} sm={12} md={6}>
              <StatCard
                icon={<FilterOutlined />}
                iconColor="#722ed1"
                iconBg="#f9f0ff"
                value={summaryData.top_department || '-'}
                label="Top Department"
              />
            </Col>
          </Row>

          {/* Charts Row 1 */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={24} md={24}>
              <Card title="Consumption Trend" size="small">
                {trendData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={trendData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="period" />
                      <YAxis yAxisId="left" />
                      <YAxis yAxisId="right" orientation="right" />
                      <RechartsTooltip />
                      <Legend />
                      <Line yAxisId="left" type="monotone" dataKey="total_qty" stroke="#eb2f96" strokeWidth={2} name="Total Qty" />
                      <Line yAxisId="right" type="monotone" dataKey="total_value" stroke="#52c41a" strokeWidth={2} name="Total Value" />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <Empty description="No trend data available" style={{ padding: 60 }} />
                )}
              </Card>
            </Col>
          </Row>

          {/* Charts Row 2 */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={24} md={12}>
              <Card title="Top 10 Items by Consumption" size="small">
                {topItemsData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={350}>
                    <BarChart data={topItemsData} layout="vertical" margin={{ left: 80 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" />
                      <YAxis type="category" dataKey="item_name" width={80} tick={{ fontSize: 11 }} />
                      <RechartsTooltip />
                      <Legend />
                      <Bar dataKey="total_qty" fill="#eb2f96" name="Total Qty" />
                      <Bar dataKey="total_value" fill="#52c41a" name="Total Value" />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <Empty description="No item data available" style={{ padding: 60 }} />
                )}
              </Card>
            </Col>
            <Col xs={24} md={12}>
              <Card title="Consumption by Department" size="small">
                {departmentData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={350}>
                    <PieChart>
                      <Pie
                        data={departmentData}
                        cx="50%"
                        cy="50%"
                        outerRadius={120}
                        dataKey="total_value"
                        label={({ department_name, percent }) => `${department_name || 'Other'}: ${(percent * 100).toFixed(0)}%`}
                      >
                        {departmentData.map((entry, idx) => (
                          <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                        ))}
                      </Pie>
                      <RechartsTooltip formatter={(value) => formatCurrency(value)} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <Empty description="No department data available" style={{ padding: 60 }} />
                )}
              </Card>
            </Col>
          </Row>

          {/* Charts Row 3 */}
          <Row gutter={16} style={{ marginBottom: 16 }}>
            <Col xs={24}>
              <Card title="Consumption by Project" size="small">
                {projectData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={projectData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="project_name" />
                      <YAxis />
                      <RechartsTooltip formatter={(value, name) => [name === 'total_value' ? formatCurrency(value) : formatNumber(value), name === 'total_value' ? 'Value' : 'Qty']} />
                      <Legend />
                      <Bar dataKey="total_qty" fill="#eb2f96" name="Total Qty" />
                      <Bar dataKey="total_value" fill="#fa8c16" name="Total Value" />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <Empty description="No project data available" style={{ padding: 60 }} />
                )}
              </Card>
            </Col>
          </Row>

          {/* Detailed Table */}
          <Card
            title="Detailed Consumption Data"
            size="small"
            extra={
              <Button icon={<DownloadOutlined />} onClick={handleExportDetailed} disabled={detailedData.length === 0}>
                Export to Excel
              </Button>
            }
          >
            <Table
              dataSource={detailedData}
              columns={detailedColumns}
              rowKey={(r) => r.id || `${r.entry_number}_${r.item_code}`}
              size="small"
              pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t, r) => `${r[0]}-${r[1]} of ${t}` }}
              scroll={{ x: 1400 }}
              locale={{ emptyText: <Empty description="No data for selected filters" /> }}
              summary={(pageData) => {
                if (pageData.length === 0) return null;
                const totalQty = pageData.reduce((s, r) => s + (r.qty || 0), 0);
                const totalAmt = pageData.reduce((s, r) => s + (r.amount || (r.qty || 0) * (r.rate || 0)), 0);
                return (
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0} colSpan={6}><Text strong>Page Total</Text></Table.Summary.Cell>
                    <Table.Summary.Cell index={6} align="right"><Text strong>{formatNumber(totalQty)}</Text></Table.Summary.Cell>
                    <Table.Summary.Cell index={7} />
                    <Table.Summary.Cell index={8} />
                    <Table.Summary.Cell index={9} align="right"><Text strong>{formatCurrency(totalAmt)}</Text></Table.Summary.Cell>
                  </Table.Summary.Row>
                );
              }}
            />
          </Card>
        </>
      )}
    </div>
  );
};

export default ConsumptionReports;
