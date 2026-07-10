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
  { label: 'Requisition Volume by Project', value: 'project_volume' },
  { label: 'Turnaround Time (TAT) SLA Analysis', value: 'tat_sla' },
  { label: 'Line-Item Fill Rate Analysis', value: 'fill_rate' },
  { label: 'Emergency vs Routine Indents', value: 'emergency_trend' },
];

const IndentReports = () => {
  const [reportType, setReportType] = useState('project_volume');
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
          }
          
          if (ind.approved_date) {
            const raiseTime = new Date(ind.indent_date).getTime();
            const approveTime = new Date(ind.approved_date).getTime();
            const diffDays = Math.max(0, (approveTime - raiseTime) / (1000 * 3600 * 24));
            monthMap[monthStr].raiseToApproveSum += diffDays;
            monthMap[monthStr].raiseToApproveCount += 1;
          }

          if (ind.status === 'fulfilled' || ind.status === 'partially_fulfilled') {
            if (ind.approved_date && ind.updated_at) {
              const approveTime = new Date(ind.approved_date).getTime();
              const issueTime = new Date(ind.updated_at).getTime();
              const diffDays = Math.max(0, (issueTime - approveTime) / (1000 * 3600 * 24));
              monthMap[monthStr].approveToIssueSum += diffDays;
              monthMap[monthStr].approveToIssueCount += 1;
            }
          }
        });
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
    if (reportType === 'project_volume') {
      return [
        { title: 'Project / Cost-Center', dataIndex: 'name', key: 'name' },
        { title: 'Total Indents Raised', dataIndex: 'count', key: 'count', align: 'right' },
        { title: 'Total Line Items Requested', dataIndex: 'itemsCount', key: 'itemsCount', align: 'right' },
      ];
    } else if (reportType === 'tat_sla') {
      return [
        { title: 'Month', dataIndex: 'month', key: 'month' },
        { title: 'Avg Approval Time (Days)', dataIndex: 'raiseToApprove', key: 'raiseToApprove', align: 'right', render: (v) => `${v} days` },
        { title: 'Avg Warehouse Issue Time (Days)', dataIndex: 'approveToIssue', key: 'approveToIssue', align: 'right', render: (v) => `${v} days` },
        { title: 'SLA Target limit', dataIndex: 'slaTarget', key: 'slaTarget', align: 'right', render: (v) => `${v} days` },
      ];
    } else if (reportType === 'fill_rate') {
      return [
        { title: 'Material Category', dataIndex: 'category', key: 'category' },
        { title: 'Requested Qty', dataIndex: 'requested', key: 'requested', align: 'right' },
        { title: 'Issued Qty', dataIndex: 'issued', key: 'issued', align: 'right' },
        { 
          title: 'Fill Rate (%)', 
          key: 'pct', 
          align: 'right',
          render: (_, r) => {
            const pct = ((r.issued / r.requested) * 100).toFixed(1);
            return <span style={{ fontWeight: 600, color: pct > 90 ? '#52c41a' : '#fa8c16' }}>{pct}%</span>;
          }
        },
      ];
    } else {
      return [
        { title: 'Month', dataIndex: 'month', key: 'month' },
        { title: 'Routine Indents', dataIndex: 'routine', key: 'routine', align: 'right' },
        { title: 'Emergency Indents', dataIndex: 'emergency', key: 'emergency', align: 'right' },
      ];
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
          <Spin size="large" tip="Aggregating report data..." />
        </div>
      ) : (
        <>
          {/* Recharts Graphical Analysis */}
          <Card style={{ marginBottom: 24, borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.03)' }}>
           <div style={{ height: '350px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
             {data.length > 0 ? (
               <ResponsiveContainer width="100%" height="100%">
                 {reportType === 'project_volume' ? (
                   <BarChart data={data}>
                     <CartesianGrid strokeDasharray="3 3" vertical={false} />
                     <XAxis dataKey="name" tickLine={false} />
                     <YAxis tickLine={false} />
                     <Tooltip />
                     <Legend />
                     <Bar dataKey="count" name="Total Indents Raised" fill="#481890" radius={[4, 4, 0, 0]} />
                     <Bar dataKey="itemsCount" name="Total Items Requested" fill="#fa8c16" radius={[4, 4, 0, 0]} />
                   </BarChart>
                 ) : reportType === 'tat_sla' ? (
                   <LineChart data={data}>
                     <CartesianGrid strokeDasharray="3 3" />
                     <XAxis dataKey="month" />
                     <YAxis />
                     <Tooltip />
                     <Legend />
                     <Line type="monotone" dataKey="raiseToApprove" name="Approval Delay (Days)" stroke="#fa8c16" strokeWidth={2} activeDot={{ r: 8 }} />
                     <Line type="monotone" dataKey="approveToIssue" name="Issuance Delay (Days)" stroke="#481890" strokeWidth={2} />
                     <Line type="monotone" dataKey="slaTarget" name="SLA Target Limit (Days)" stroke="#f5222d" strokeDasharray="5 5" />
                   </LineChart>
                 ) : reportType === 'fill_rate' ? (
                   <BarChart data={data}>
                     <CartesianGrid strokeDasharray="3 3" vertical={false} />
                     <XAxis dataKey="category" tickLine={false} />
                     <YAxis tickLine={false} />
                     <Tooltip />
                     <Legend />
                     <Bar dataKey="requested" name="Requested Qty" fill="#fa8c16" radius={[4, 4, 0, 0]} />
                     <Bar dataKey="issued" name="Issued Qty" fill="#52c41a" radius={[4, 4, 0, 0]} />
                   </BarChart>
                 ) : (
                   <BarChart data={data} stackOffset="expand">
                     <CartesianGrid strokeDasharray="3 3" vertical={false} />
                     <XAxis dataKey="month" tickLine={false} />
                     <YAxis tickLine={false} />
                     <Tooltip />
                     <Legend />
                     <Bar dataKey="routine" name="Routine Indents" stackId="a" fill="#481890" />
                     <Bar dataKey="emergency" name="Emergency Indents" stackId="a" fill="#f5222d" />
                   </BarChart>
                 )}
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
