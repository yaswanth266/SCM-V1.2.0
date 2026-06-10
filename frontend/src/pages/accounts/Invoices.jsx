import React, { useState, useCallback, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, DatePicker, Switch, Card, Tabs, Typography, Tooltip, Popconfirm, message
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  PrinterOutlined, WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatDate, formatCurrency, getErrorMessage, formatDateForAPI,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { Text } = Typography;

const Invoices = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('purchase');
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterOverdue, setFilterOverdue] = useState(false);
  const [filterDateRange, setFilterDateRange] = useState(null);

  // Honor deep-link: /accounts/invoices?new=1&po_id=X
  useEffect(() => {
    const wantNew = searchParams.get('new');
    const incomingPoId = searchParams.get('po_id');
    if (wantNew) {
      if (incomingPoId) {
        navigate(`/accounts/invoices/new?po_id=${incomingPoId}`);
      } else {
        navigate('/accounts/invoices/new');
      }
    }
  }, [searchParams, navigate]);

  const fetchInvoices = useCallback(
    async (params) => {
      const qp = { ...params, invoice_type: activeTab };
      if (filterStatus) qp.status = filterStatus;
      if (filterOverdue) qp.overdue = true;
      if (filterDateRange && filterDateRange[0]) {
        qp.date_from = formatDateForAPI(filterDateRange[0]);
        qp.date_to = formatDateForAPI(filterDateRange[1]);
      }
      return await api.get('/accounts/invoices', { params: qp });
    },
    [activeTab, filterStatus, filterOverdue, filterDateRange]
  );

  const handleDelete = async (id) => {
    try {
      await api.delete(`/accounts/invoices/${id}`);
      message.success('Invoice deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handlePrint = async (record) => {
    try {
      const res = await api.get(`/accounts/invoices/${record.id}/print`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const w = window.open(url, '_blank');
      if (w) w.print();
    } catch (err) {
      try {
        const fallbackRes = await api.get(`/accounts/invoices/${record.id}/print`, { responseType: 'blob' });
        const fallbackUrl = URL.createObjectURL(new Blob([fallbackRes.data], { type: 'application/pdf' }));
        window.open(fallbackUrl, '_blank');
      } catch {
        message.error('Failed to download invoice');
      }
    }
  };

  const columns = [
    {
      title: 'Invoice Number',
      dataIndex: 'invoice_number',
      key: 'invoice_number',
      width: 160,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => navigate(`/accounts/invoices/${record.id}`)}>{text}</a>,
    },
    {
      title: 'Vendor',
      dataIndex: 'party_name',
      key: 'party_name',
      width: 200,
      ellipsis: true,
      render: (val, r) => val || r.vendor_name || r.customer_name || '-',
    },
    {
      title: 'Invoice Date',
      dataIndex: 'invoice_date',
      key: 'invoice_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Due Date',
      dataIndex: 'due_date',
      key: 'due_date',
      width: 120,
      sorter: true,
      render: (v, record) => {
        const isOverdue = v && dayjs(v).isBefore(dayjs(), 'day') &&
          record.status !== 'paid' && record.status !== 'cancelled';
        return (
          <Text style={isOverdue ? { color: '#f5222d', fontWeight: 600 } : undefined}>
            {formatDate(v)}
            {isOverdue && <WarningOutlined style={{ marginLeft: 4, color: '#f5222d' }} />}
          </Text>
        );
      },
    },
    {
      title: 'Subtotal',
      dataIndex: 'subtotal',
      key: 'subtotal',
      width: 120,
      align: 'right',
      render: (v) => formatCurrency(v),
    },
    {
      title: 'Tax',
      dataIndex: 'tax_amount',
      key: 'tax_amount',
      width: 100,
      align: 'right',
      render: (v) => formatCurrency(v),
    },
    {
      title: 'Grand Total',
      dataIndex: 'grand_total',
      key: 'grand_total',
      width: 130,
      align: 'right',
      sorter: true,
      render: (v) => <Text strong>{formatCurrency(v)}</Text>,
    },
    {
      title: 'Paid',
      dataIndex: 'paid_amount',
      key: 'paid_amount',
      width: 120,
      align: 'right',
      render: (v) => <Text style={{ color: '#52c41a' }}>{formatCurrency(v || 0)}</Text>,
    },
    {
      title: 'Balance',
      dataIndex: 'balance_amount',
      key: 'balance_amount',
      width: 120,
      align: 'right',
      render: (v, record) => {
        const balance = v != null ? v : (record.grand_total || 0) - (record.paid_amount || 0);
        return <Text style={balance > 0 ? { color: '#f5222d', fontWeight: 600 } : undefined}>{formatCurrency(balance)}</Text>;
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 140,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => navigate(`/accounts/invoices/${record.id}`)} />
          </Tooltip>
          {(record.status === 'draft' || record.status === 'unpaid') && (
            <Tooltip title="Edit">
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => navigate(`/accounts/invoices/${record.id}?edit=true`)} />
            </Tooltip>
          )}
          <Tooltip title="Print">
            <Button type="link" size="small" icon={<PrinterOutlined />} onClick={() => handlePrint(record)} />
          </Tooltip>
          {record.status === 'draft' && (
            <Popconfirm title="Delete this invoice?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
              <Button type="link" size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 160 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Draft', value: 'draft' },
          { label: 'Unpaid', value: 'unpaid' },
          { label: 'Partially Paid', value: 'partially_paid' },
          { label: 'Paid', value: 'paid' },
          { label: 'Overdue', value: 'overdue' },
          { label: 'Cancelled', value: 'cancelled' },
        ]}
      />
      <DatePicker.RangePicker
        value={filterDateRange}
        onChange={(v) => { setFilterDateRange(v); setRefreshKey((k) => k + 1); }}
        format={DATE_FORMAT}
        placeholder={['From Date', 'To Date']}
        style={{ width: 240 }}
      />
      <Switch
        checked={filterOverdue}
        onChange={(v) => { setFilterOverdue(v); setRefreshKey((k) => k + 1); }}
        checkedChildren="Overdue"
        unCheckedChildren="All"
      />
    </Space>
  );

  const tabItems = [
    { key: 'purchase', label: 'Purchase Invoices' },
  ];

  return (
    <div>
      <PageHeader title="Invoices" subtitle="Manage purchase and sales invoices">
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/accounts/invoices/new')}>
          Create Invoice
        </Button>
      </PageHeader>

      <Card bodyStyle={{ paddingBottom: 0 }}>
        <Tabs
          activeKey={activeTab}
          onChange={(key) => {
            setActiveTab(key);
            setFilterStatus(undefined);
            setFilterOverdue(false);
            setFilterDateRange(null);
            setRefreshKey((k) => k + 1);
          }}
          items={tabItems}
        />
      </Card>

      <div style={{ marginTop: 16 }}>
        <DataTable
          key={`${activeTab}-${refreshKey}`}
          columns={columns}
          fetchFunction={fetchInvoices}
          rowKey="id"
          searchPlaceholder="Search by invoice number, party..."
          exportFileName={`${activeTab}_invoices`}
          toolbar={toolbar}
          scroll={{ x: 1700 }}
        />
      </div>
    </div>
  );
};

export default Invoices;
