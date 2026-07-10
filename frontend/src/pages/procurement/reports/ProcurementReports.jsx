import React, { useState, useCallback, useEffect } from 'react';
import {
  Select, DatePicker, Button, Card, Row, Col, Tag, message,
} from 'antd';
import { DownloadOutlined, FilterOutlined } from '@ant-design/icons';
import PageHeader from '../../../components/PageHeader';
import DataTable from '../../../components/DataTable';
import StatusTag from '../../../components/StatusTag';
import api from '../../../config/api';
import { formatCurrency, formatNumber, formatDate, formatDateForAPI, getErrorMessage, downloadExcel } from '../../../utils/helpers';
import { DATE_FORMAT } from '../../../utils/constants';

const { RangePicker } = DatePicker;

const REPORT_TYPES = [
  { label: 'PO Summary Report', value: 'po_summary' },
  { label: 'Vendor Performance Report', value: 'vendor_performance' },
];

const ProcurementReports = () => {
  const [reportType, setReportType] = useState('po_summary');
  const [vendor, setVendor] = useState(undefined);
  const [dateRange, setDateRange] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [vendors, setVendors] = useState([]);

  useEffect(() => {
    fetchLookups();
  }, []);

  const fetchLookups = async () => {
    try {
      const res = await api.get('/masters/vendors', { params: { page_size: 500 } });
      const d = res.data;
      setVendors((d.items || d.data || d || []).map((v) => ({ label: v.name, value: v.id })));
    } catch { /* silent */ }
  };

  const fetchReport = useCallback(
    async (params) => {
      const queryParams = { ...params, report_type: reportType };
      if (vendor) queryParams.vendor_id = vendor;
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }
      return await api.get('/procurement/reports', { params: queryParams });
    },
    [reportType, vendor, dateRange]
  );

  const handleExport = async () => {
    try {
      const queryParams = { report_type: reportType, page_size: 50000 };
      if (vendor) queryParams.vendor_id = vendor;
      if (dateRange && dateRange[0]) {
        queryParams.date_from = formatDateForAPI(dateRange[0]);
        queryParams.date_to = formatDateForAPI(dateRange[1]);
      }
      const res = await api.get('/procurement/reports', { params: queryParams });
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
      downloadExcel(exportData, `procurement_${reportType}`, REPORT_TYPES.find((r) => r.value === reportType)?.label || reportType);
      message.success('Export completed');
    } catch (err) { message.error(getErrorMessage(err)); }
  };

  const getColumns = () => {
    switch (reportType) {
      case 'po_summary':
        return [
          { title: 'PO Number', dataIndex: 'po_number', key: 'po_number', width: 150, sorter: true },
          { title: 'Date', dataIndex: 'po_date', key: 'po_date', width: 120, render: (v) => formatDate(v), sorter: true },
          { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 250, ellipsis: true },
          { title: 'Grand Total', dataIndex: 'grand_total', key: 'grand_total', width: 150, align: 'right', render: (v) => formatCurrency(v), sorter: true },
          { title: 'Status', dataIndex: 'status', key: 'status', width: 120, render: (v) => <StatusTag status={v} /> },
        ];

      case 'vendor_performance':
        return [
          { title: 'Vendor Code', dataIndex: 'vendor_code', key: 'vendor_code', width: 150, sorter: true },
          { title: 'Vendor Name', dataIndex: 'name', key: 'name', width: 250, ellipsis: true },
          { title: 'Rating', dataIndex: 'rating', key: 'rating', width: 120, align: 'right', render: (v) => v != null ? Number(v).toFixed(1) : '-' },
          { title: 'Total POs', dataIndex: 'total_pos', key: 'total_pos', width: 120, align: 'right', render: (v) => formatNumber(v) },
          { title: 'Total Amount', dataIndex: 'total_amount', key: 'total_amount', width: 180, align: 'right', render: (v) => formatCurrency(v), sorter: true },
        ];

      default:
        return [];
    }
  };

  return (
    <div>
      <PageHeader
        title="Procurement Reports"
        subtitle={REPORT_TYPES.find((r) => r.value === reportType)?.label || 'Select a report'}
      >
        <Button icon={<DownloadOutlined />} onClick={handleExport}>Export to Excel</Button>
      </PageHeader>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={[12, 12]} align="middle">
          <Col xs={24} sm={12} md={6}>
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
          <Col xs={24} sm={12} md={5}>
            <Select
              placeholder="Vendor"
              allowClear
              style={{ width: '100%' }}
              value={vendor}
              onChange={setVendor}
              options={vendors}
              showSearch
              optionFilterProp="label"
            />
          </Col>
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
        searchPlaceholder="Search..."
        exportFileName={`procurement_${reportType}`}
        scroll={{ x: 1200 }}
      />
    </div>
  );
};

export default ProcurementReports;
