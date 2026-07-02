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
  Cell,
  PieChart,
  Pie,
} from 'recharts';
import api from '../../config/api';
import PageHeader from '../../components/PageHeader';
import { downloadExcel } from '../../utils/helpers';

const { RangePicker } = DatePicker;

const REPORT_TYPES = [
  { label: 'Putaway Turnaround Logs', value: 'putaway_efficiency' },
  { label: 'Pick Rate & SLA Violations', value: 'pick_sla' },
  { label: 'QA Pass/Fail & Vendor Rejection Log', value: 'qa_log' },
  { label: 'Gate Entry & Inwarding Logistics Log', value: 'gate_log' },
];

const COLORS = ['#F09000', '#52c41a', '#fa8c16', '#fa541c', '#1890ff'];

const WarehouseReports = () => {
  const [reportType, setReportType] = useState('putaway_efficiency');
  const [dateRange, setDateRange] = useState(null);
  const [warehouse, setWarehouse] = useState(undefined);
  const [warehouses, setWarehouses] = useState([]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState([]);

  useEffect(() => {
    fetchWarehouses();
    loadReportData();
  }, [reportType]);

  const fetchWarehouses = async () => {
    try {
      const res = await api.get('/warehouse/warehouses', { params: { page_size: 100 } });
      const items = res.data?.items || res.data || [];
      setWarehouses(items.map(w => ({ label: w.name, value: w.id })));
    } catch {
      // silent fallback
    }
  };

  const loadReportData = async () => {
    setLoading(true);
    try {
      if (reportType === 'putaway_efficiency') {
        const res = await api.get('/warehouse/putaways', { params: { page_size: 200 } });
        const putaways = res.data?.items || res.data || [];
        if (putaways.length === 0) {
          setData([]);
          setLoading(false);
          return;
        }
        
        // Group by month of completed_at
        const monthMap = {};
        putaways.forEach(p => {
          if (p.status !== 'completed' || !p.completed_at || !p.started_at) return;
          const date = new Date(p.completed_at);
          const monthStr = date.toLocaleString('default', { month: 'short', year: 'numeric' });
          if (!monthMap[monthStr]) {
            monthMap[monthStr] = { name: monthStr, totalHours: 0, count: 0, itemsPutaway: 0 };
          }
          const start = new Date(p.started_at).getTime();
          const end = new Date(p.completed_at).getTime();
          const hours = Math.max(0, (end - start) / (1000 * 3600));
          monthMap[monthStr].totalHours += hours;
          monthMap[monthStr].count += 1;
          monthMap[monthStr].itemsPutaway += (p.completed_items || p.total_items || 0);
        });
        const list = Object.values(monthMap).map(m => ({
          name: m.name,
          avgHours: parseFloat((m.totalHours / m.count).toFixed(1)),
          targetHours: 8.0,
          itemsPutaway: m.itemsPutaway
        }));
        setData(list);
      } else if (reportType === 'pick_sla') {
        const res = await api.get('/outbound/picking-orders', { params: { page_size: 200 } });
        const picks = res.data?.items || res.data || [];
        if (picks.length === 0) {
          setData([]);
          setLoading(false);
          return;
        }

        const zoneMap = {};
        picks.forEach(p => {
          const zone = p.warehouse_name || 'Main Zone';
          if (!zoneMap[zone]) {
            zoneMap[zone] = { zone, totalPicks: 0, breachedPicks: 0 };
          }
          zoneMap[zone].totalPicks += 1;
          if (p.status === 'completed' && p.completed_at && p.assigned_at) {
            const durationHrs = (new Date(p.completed_at).getTime() - new Date(p.assigned_at).getTime()) / (1000 * 3600);
            if (durationHrs > 4.0) { // SLA breach if > 4 hours
              zoneMap[zone].breachedPicks += 1;
            }
          } else if (p.status !== 'completed' && p.created_at) {
            const pendingHrs = (new Date().getTime() - new Date(p.created_at).getTime()) / (1000 * 3600);
            if (pendingHrs > 24.0) {
              zoneMap[zone].breachedPicks += 1;
            }
          }
        });
        const list = Object.values(zoneMap).map(z => ({
          zone: z.zone,
          totalPicks: z.totalPicks,
          breachedPicks: z.breachedPicks,
          compliance: parseFloat(((z.totalPicks - z.breachedPicks) / z.totalPicks * 100).toFixed(1))
        }));
        setData(list);
      } else if (reportType === 'qa_log') {
        const res = await api.get('/warehouse/quality-inspections', { params: { page_size: 200 } });
        const inspections = res.data?.items || res.data || [];
        if (inspections.length === 0) {
          setData([]);
          setLoading(false);
          return;
        }

        const vendorMap = {};
        inspections.forEach(qi => {
          const vendor = qi.vendor_name || qi.grn?.vendor_name || 'Vendor';
          if (!vendorMap[vendor]) {
            vendorMap[vendor] = { vendor, passed: 0, failed: 0, totalInspected: 0 };
          }
          vendorMap[vendor].totalInspected += 1;
          if (qi.overall_result === 'pass') {
            vendorMap[vendor].passed += 1;
          } else if (qi.overall_result === 'fail') {
            vendorMap[vendor].failed += 1;
          } else {
            vendorMap[vendor].passed += 1;
          }
        });
        setData(Object.values(vendorMap));
      } else {
        const res = await api.get('/warehouse/gate-entries', { params: { page_size: 200 } });
        const entries = res.data?.items || res.data || [];
        if (entries.length === 0) {
          setData([]);
          setLoading(false);
          return;
        }

        const dateMap = {};
        entries.forEach(e => {
          if (!e.created_at) return;
          const dateStr = new Date(e.created_at).toISOString().split('T')[0];
          if (!dateMap[dateStr]) {
            dateMap[dateStr] = { date: dateStr, entries: 0, waitSum: 0, maxWait: 0 };
          }
          dateMap[dateStr].entries += 1;
          
          if (e.gate_in_time) {
            const raised = new Date(e.created_at).getTime();
            const gateIn = new Date(e.gate_in_time).getTime();
            const waitMins = Math.max(0, (gateIn - raised) / (1000 * 60));
            dateMap[dateStr].waitSum += waitMins;
            if (waitMins > dateMap[dateStr].maxWait) {
              dateMap[dateStr].maxWait = waitMins;
            }
          }
        });
        const list = Object.values(dateMap).map(d => ({
          date: d.date,
          entries: d.entries,
          avgWaitMins: d.entries > 0 ? Math.round(d.waitSum / d.entries) : 0,
          maxWaitMins: Math.round(d.maxWait)
        }));
        setData(list);
      }
    } catch (err) {
      console.error('Failed to load warehouse report data:', err);
      setData([]);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = () => {
    const title = REPORT_TYPES.find(r => r.value === reportType)?.label || 'Report';
    downloadExcel(data, `warehouse_${reportType}`, title);
  };

  const getColumns = () => {
    if (reportType === 'putaway_efficiency') {
      return [
        { title: 'Period', dataIndex: 'name', key: 'name' },
        { title: 'Avg Putaway TAT (Hours)', dataIndex: 'avgHours', key: 'avgHours', align: 'right', render: (v) => `${v} hrs` },
        { title: 'SLA Target TAT', dataIndex: 'targetHours', key: 'targetHours', align: 'right', render: (v) => `${v} hrs` },
        { title: 'Items Putaway', dataIndex: 'itemsPutaway', key: 'itemsPutaway', align: 'right' },
      ];
    } else if (reportType === 'pick_sla') {
      return [
        { title: 'Storage Zone', dataIndex: 'zone', key: 'zone' },
        { title: 'Total Picks', dataIndex: 'totalPicks', key: 'totalPicks', align: 'right' },
        { title: 'SLA Breached Picks', dataIndex: 'breachedPicks', key: 'breachedPicks', align: 'right', render: (v) => <span style={{ color: v > 15 ? '#f5222d' : '#fa8c16' }}>{v}</span> },
        { 
          title: 'SLA Compliance Rate', 
          dataIndex: 'compliance', 
          key: 'compliance', 
          align: 'right', 
          render: (v) => <span style={{ fontWeight: 600, color: v > 90 ? '#52c41a' : '#fa8c16' }}>{v}%</span> 
        },
      ];
    } else if (reportType === 'qa_log') {
      return [
        { title: 'Vendor Name', dataIndex: 'vendor', key: 'vendor' },
        { title: 'Inspected Batches', dataIndex: 'totalInspected', key: 'totalInspected', align: 'right' },
        { title: 'Passed Batches', dataIndex: 'passed', key: 'passed', align: 'right', render: (v) => <span style={{ color: '#52c41a' }}>{v}</span> },
        { title: 'Failed Batches', dataIndex: 'failed', key: 'failed', align: 'right', render: (v) => <span style={{ color: v > 0 ? '#f5222d' : 'inherit' }}>{v}</span> },
        { 
          title: 'Rejection Rate (%)', 
          key: 'rejection_rate', 
          align: 'right',
          render: (_, r) => {
            const rate = ((r.failed / r.totalInspected) * 100).toFixed(1);
            return <span style={{ fontWeight: 600, color: rate > 10 ? '#f5222d' : 'inherit' }}>{rate}%</span>;
          }
        },
      ];
    } else {
      return [
        { title: 'Date', dataIndex: 'date', key: 'date' },
        { title: 'Total Vehicles Registered', dataIndex: 'entries', key: 'entries', align: 'right' },
        { title: 'Average Yard Wait Time', dataIndex: 'avgWaitMins', key: 'avgWaitMins', align: 'right', render: (v) => `${v} mins` },
        { title: 'Max Yard Wait Time', dataIndex: 'maxWaitMins', key: 'maxWaitMins', align: 'right', render: (v) => `${v} mins` },
      ];
    }
  };

  return (
    <div style={{ padding: '24px' }}>
      <PageHeader
        title="Warehouse Logistics & SLA Reports"
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
              placeholder="Filter Warehouse"
              allowClear
              style={{ width: '100%' }}
              value={warehouse}
              onChange={setWarehouse}
              options={warehouses}
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
              style={{ background: '#F09000', borderColor: '#F09000', borderRadius: '6px' }}
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
          {/* Graphical Analysis */}
          <Card style={{ marginBottom: 24, borderRadius: '8px', boxShadow: '0 2px 8px rgba(0,0,0,0.03)' }}>
           <div style={{ height: '350px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
             {data.length > 0 ? (
               <ResponsiveContainer width="100%" height="100%">
                 {reportType === 'putaway_efficiency' ? (
                   <LineChart data={data}>
                     <CartesianGrid strokeDasharray="3 3" />
                     <XAxis dataKey="name" stroke="#6C757D" tickLine={false} />
                     <YAxis label={{ value: 'Hours', angle: -90, position: 'insideLeft' }} stroke="#6C757D" tickLine={false} />
                     <Tooltip />
                     <Legend />
                     <Line type="monotone" dataKey="avgHours" name="Avg Putaway TAT (Hrs)" stroke="#F09000" strokeWidth={2.5} activeDot={{ r: 8 }} />
                     <Line type="monotone" dataKey="targetHours" name="SLA SLA Limit (Hrs)" stroke="#f5222d" strokeDasharray="5 5" strokeWidth={1.5} />
                   </LineChart>
                 ) : reportType === 'pick_sla' ? (
                   <BarChart data={data}>
                     <CartesianGrid strokeDasharray="3 3" vertical={false} />
                     <XAxis dataKey="zone" stroke="#6C757D" tickLine={false} />
                     <YAxis stroke="#6C757D" tickLine={false} />
                     <Tooltip />
                     <Legend />
                     <Bar dataKey="totalPicks" name="Total Picks" fill="#F09000" radius={[4, 4, 0, 0]} />
                     <Bar dataKey="breachedPicks" name="SLA Breaches" fill="#fa541c" radius={[4, 4, 0, 0]} />
                   </BarChart>
                 ) : reportType === 'qa_log' ? (
                   <BarChart data={data}>
                     <CartesianGrid strokeDasharray="3 3" vertical={false} />
                     <XAxis dataKey="vendor" stroke="#6C757D" tickLine={false} />
                     <YAxis stroke="#6C757D" tickLine={false} />
                     <Tooltip />
                     <Legend />
                     <Bar dataKey="passed" name="Accepted Batches" fill="#52c41a" stackId="a" />
                     <Bar dataKey="failed" name="Rejected Batches" fill="#f5222d" stackId="a" />
                   </BarChart>
                 ) : (
                   <LineChart data={data}>
                     <CartesianGrid strokeDasharray="3 3" />
                     <XAxis dataKey="date" stroke="#6C757D" tickLine={false} />
                     <YAxis label={{ value: 'Minutes', angle: -90, position: 'insideLeft' }} stroke="#6C757D" tickLine={false} />
                     <Tooltip />
                     <Legend />
                     <Line type="monotone" dataKey="avgWaitMins" name="Avg Wait (Mins)" stroke="#F09000" strokeWidth={2} />
                     <Line type="monotone" dataKey="maxWaitMins" name="Max Wait (Mins)" stroke="#fa541c" strokeWidth={2} />
                   </LineChart>
                 )}
               </ResponsiveContainer>
             ) : (
               <Empty description="No report metrics available for the selected filters" image={Empty.PRESENTED_IMAGE_SIMPLE} />
             )}
           </div>
          </Card>

          {/* Details Table */}
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

export default WarehouseReports;
