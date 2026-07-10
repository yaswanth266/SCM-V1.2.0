import React, { useState, useEffect } from 'react';
import { Card, Row, Col, Select, DatePicker, Button, Table, Tag, Space, Spin, Empty } from 'antd';
import { DownloadOutlined, FilterOutlined } from '@ant-design/icons';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from 'recharts';
import api from '../../config/api';
import PageHeader from '../../components/PageHeader';
import { downloadExcel } from '../../utils/helpers';

const { RangePicker } = DatePicker;

const REPORT_TYPES = [
  { label: 'Indent KPIs Report', value: 'indent_kpis' },
];

const IndentReports = () => {
  const [reportType, setReportType] = useState('indent_kpis');
  const [dateRange, setDateRange] = useState(null);
  const [project, setProject] = useState(undefined);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState([]);

  useEffect(() => {
    fetchProjects();
    loadReportData();
  }, [reportType, project, dateRange]);

  const fetchProjects = async () => {
    try {
      const res = await api.get('/procurement/material-requests', { params: { page_size: 500 } });
      const items = res.data?.items || [];
      const uniqProj = Array.from(new Set(items.map(i => i.project_id).filter(Boolean)));
      setProjects(uniqProj.map((id) => ({ label: `Project ${id}`, value: id })));
    } catch {
      // silent
    }
  };

  const loadReportData = async () => {
    setLoading(true);
    try {
      const res = await api.get('/indent/indents', { params: { page_size: 200 } });
      const indents = res.data?.items || res.data || [];

      let filtered = indents;
      if (project) {
        filtered = filtered.filter(ind => Number(ind.project_id) === Number(project));
      }
      if (dateRange && dateRange[0] && dateRange[1]) {
        const start = dateRange[0].startOf('day').toDate();
        const end = dateRange[1].endOf('day').toDate();
        filtered = filtered.filter(ind => {
          const dateVal = ind.indent_date || ind.created_at;
          if (!dateVal) return false;
          const d = new Date(dateVal);
          return d >= start && d <= end;
        });
      }

      if (filtered.length === 0) {
        setData([]);
        setLoading(false);
        return;
      }

<<<<<<< HEAD
      if (reportType === 'project_volume') {
        // Group by project
        const projMap = {};
        filtered.forEach(ind => {
          const pName = ind.project?.name || ind.project_name || `Project ${ind.project_id || 'Unknown'}`;
          if (!projMap[pName]) projMap[pName] = { name: pName, count: 0, itemsCount: 0 };
          projMap[pName].count += 1;
          projMap[pName].itemsCount += (ind.items?.length || 0);
        });
        setData(Object.values(projMap));
      } else if (reportType === 'tat_sla') {
        // Average TAT trend per month
        const monthMap = {};
        filtered.forEach(ind => {
          if (!ind.indent_date) return;
          const date = new Date(ind.indent_date);
          const monthStr = date.toLocaleString('default', { month: 'short', year: 'numeric' });
          if (!monthMap[monthStr]) {
            monthMap[monthStr] = { month: monthStr, raiseToApproveSum: 0, raiseToApproveCount: 0, approveToIssueSum: 0, approveToIssueCount: 0 };
=======
      if (reportType === 'indent_kpis') {
        const officeMap = {};
        indents.forEach(ind => {
          const officeName = ind.office_name || 'CENTRAL';
          if (!officeMap[officeName]) {
            officeMap[officeName] = {
              name: officeName,
              total: 0,
              pending: 0,
              approved: 0,
              rejected: 0,
            };
>>>>>>> e135500 (feat: implement dynamic barcode/QR mode switching, swap name/code layouts, and fix indent detail scoping bug)
          }
          officeMap[officeName].total += 1;
          if (['draft', 'pending_approval'].includes(ind.status)) {
            officeMap[officeName].pending += 1;
          } else if (['approved', 'partially_fulfilled', 'fulfilled'].includes(ind.status)) {
            officeMap[officeName].approved += 1;
          } else if (['rejected', 'cancelled'].includes(ind.status)) {
            officeMap[officeName].rejected += 1;
          }
        });
<<<<<<< HEAD
        const list = Object.values(monthMap).map(m => ({
          month: m.month,
          raiseToApprove: m.raiseToApproveCount > 0 ? parseFloat((m.raiseToApproveSum / m.raiseToApproveCount).toFixed(1)) : 0,
          approveToIssue: m.approveToIssueCount > 0 ? parseFloat((m.approveToIssueSum / m.approveToIssueCount).toFixed(1)) : 0,
          slaTarget: 3.0
        }));
        setData(list);
      } else if (reportType === 'fill_rate') {
        // Item category fill rates
        const catMap = {};
        filtered.forEach(ind => {
          (ind.items || []).forEach(item => {
            const catName = item.item?.category?.name || 'Consumables';
            if (!catMap[catName]) catMap[catName] = { category: catName, requested: 0, issued: 0 };
            catMap[catName].requested += parseFloat(item.requested_qty || 0);
            catMap[catName].issued += parseFloat(item.issued_qty || 0);
          });
        });
        setData(Object.values(catMap));
      } else {
        // Emergency trend
        const monthMap = {};
        filtered.forEach(ind => {
          if (!ind.indent_date) return;
          const date = new Date(ind.indent_date);
          const monthStr = date.toLocaleString('default', { month: 'short', year: 'numeric' });
          if (!monthMap[monthStr]) {
            monthMap[monthStr] = { month: monthStr, routine: 0, emergency: 0 };
          }
          if (ind.indent_type === 'urgent') {
            monthMap[monthStr].emergency += 1;
          } else {
            monthMap[monthStr].routine += 1;
          }
        });
        setData(Object.values(monthMap));
=======
        setData(Object.values(officeMap));
      } else {
        setData([]);
>>>>>>> e135500 (feat: implement dynamic barcode/QR mode switching, swap name/code layouts, and fix indent detail scoping bug)
      }
    } catch (e) {
      console.error('Failed to load indent reports:', e);
      setData([]);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = () => {
    const title = REPORT_TYPES.find(r => r.value === reportType)?.label || 'Report';
    downloadExcel(data, `indent_${reportType}`, title);
  };

  const getColumns = () => {
    if (reportType === 'indent_kpis') {
      return [
        { title: 'Office', dataIndex: 'name', key: 'name' },
        { title: 'Total Indents', dataIndex: 'total', key: 'total', align: 'right' },
        { title: 'Pending Approval', dataIndex: 'pending', key: 'pending', align: 'right' },
        { title: 'Approved & Active', dataIndex: 'approved', key: 'approved', align: 'right' },
        { title: 'Rejected / Cancelled', dataIndex: 'rejected', key: 'rejected', align: 'right' },
      ];
    } else {
      return [];
    }
  };

  return (
    <div style={{ padding: '24px' }}>
      <PageHeader
        title="Indent Requisition Reports"
        subtitle={REPORT_TYPES.find((r) => r.value === reportType)?.label || 'Select a report'}
      >
        <Button icon={<DownloadOutlined />} onClick={handleExport} style={{ borderRadius: '6px' }}>
          Export Excel
        </Button>
      </PageHeader>

      <Card size="small" style={{ marginBottom: 24, borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.02)' }}>
        <Row gutter={[16, 16]} align="middle">
          <Col xs={24} md={8}>
            <Select
              placeholder="Select Report"
              style={{ width: '100%' }}
              value={reportType}
              onChange={setReportType}
              options={REPORT_TYPES}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <Select
              placeholder="Filter Project"
              allowClear
              style={{ width: '100%' }}
              value={project}
              onChange={setProject}
              options={projects}
            />
          </Col>
          <Col xs={24} sm={12} md={6}>
            <RangePicker
              style={{ width: '100%' }}
              value={dateRange}
              onChange={setDateRange}
            />
          </Col>
          <Col xs={24} md={4}>
            <Button
              type="primary"
              icon={<FilterOutlined />}
              onClick={loadReportData}
              block
              style={{ background: '#481890', borderColor: '#481890', borderRadius: '6px' }}
            >
              Apply Filter
            </Button>
          </Col>
        </Row>
      </Card>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '100px' }}>
          <Spin size="large" tip="Aggregating report data...">
            <div style={{ minWidth: '150px' }} />
          </Spin>
        </div>
      ) : (
        <>
          {/* Recharts Graphical Analysis */}
          <Card style={{ marginBottom: 24, borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.03)' }}>
            <div style={{ height: '350px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
              {data.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  {reportType === 'indent_kpis' ? (
                    <BarChart data={data}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" tickLine={false} />
                      <YAxis tickLine={false} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="total" name="Total Indents" fill="#481890" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="pending" name="Pending Approval" fill="#fa8c16" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="approved" name="Approved & Active" fill="#52c41a" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="rejected" name="Rejected / Cancelled" fill="#f5222d" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  ) : null}
                </ResponsiveContainer>
              ) : (
                <Empty description="No report metrics available for the selected filters" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              )}
            </div>
          </Card>

          {/* Tabular Details */}
          <Card title="Report Details Table" style={{ borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.03)' }}>
            <Table
              dataSource={data.map((item, index) => ({ ...item, key: index }))}
              columns={getColumns()}
              pagination={false}
              size="middle"
            />
          </Card>
        </>
      )}
    </div>
  );
};

export default IndentReports;
