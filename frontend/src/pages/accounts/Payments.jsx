import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, Popconfirm, message, Card, Tooltip, Tag, DatePicker, Typography
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  BankOutlined, WalletOutlined
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatDate, formatCurrency, getErrorMessage, formatDateForAPI
} from '../../utils/helpers';
import { DATE_FORMAT, PAYMENT_MODES } from '../../utils/constants';

const { Text } = Typography;

const PAYMENT_TYPE_OPTIONS = [
  { label: 'Make Payment', value: 'pay' },
];

const Payments = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterPaymentType, setFilterPaymentType] = useState(undefined);
  const [filterPaymentMode, setFilterPaymentMode] = useState(undefined);
  const [filterDateRange, setFilterDateRange] = useState(null);

  const fetchPayments = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterPaymentType) qp.payment_type = filterPaymentType;
      if (filterPaymentMode) qp.payment_mode = filterPaymentMode;
      if (filterDateRange && filterDateRange[0]) {
        qp.date_from = formatDateForAPI(filterDateRange[0]);
        qp.date_to = formatDateForAPI(filterDateRange[1]);
      }
      return await api.get('/accounts/payments', { params: qp });
    },
    [filterPaymentType, filterPaymentMode, filterDateRange]
  );

  const handleDelete = async (id) => {
    try {
      await api.delete(`/accounts/payments/${id}`);
      message.success('Payment deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'Payment Number',
      dataIndex: 'payment_number',
      key: 'payment_number',
      width: 160,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => navigate(`/accounts/payments/${record.id}`)}>{text}</a>,
    },
    {
      title: 'Type',
      dataIndex: 'payment_type',
      key: 'payment_type',
      width: 110,
      render: (val) => (
        <Tag color={val === 'receive' ? 'green' : 'blue'} icon={val === 'receive' ? <WalletOutlined /> : <BankOutlined />}>
          {val === 'receive' ? 'Receive' : 'Pay'}
        </Tag>
      ),
    },
    {
      title: 'Party',
      dataIndex: 'party_name',
      key: 'party_name',
      width: 200,
      ellipsis: true,
      render: (val, r) => val || r.vendor_name || '-',
    },
    {
      title: 'Invoice Ref',
      dataIndex: 'invoice_number',
      key: 'invoice_ref',
      width: 150,
      render: (val, r) => val || r.invoice_ref || '-',
    },
    {
      title: 'Payment Date',
      dataIndex: 'payment_date',
      key: 'payment_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      key: 'amount',
      width: 140,
      align: 'right',
      sorter: true,
      render: (v) => <Text strong>{formatCurrency(v)}</Text>,
    },
    {
      title: 'Mode',
      dataIndex: 'payment_mode',
      key: 'payment_mode',
      width: 130,
      render: (val) => {
        const found = PAYMENT_MODES.find((m) => m.value === val);
        return found ? found.label : (val || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      },
    },
    {
      title: 'Advance',
      dataIndex: 'is_advance',
      key: 'is_advance',
      width: 90,
      align: 'center',
      render: (val) => val ? <Tag color="purple">Advance</Tag> : <Text type="secondary">-</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 120,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Tooltip title="View">
            <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => navigate(`/accounts/payments/${record.id}`)} />
          </Tooltip>
          {(record.status === 'draft') && (
            <>
              <Tooltip title="Edit">
                <Button type="link" size="small" icon={<EditOutlined />} onClick={() => navigate(`/accounts/payments/${record.id}`)} />
              </Tooltip>
              <Popconfirm title="Delete this payment?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <Select
        placeholder="Payment Type"
        allowClear
        style={{ width: 140 }}
        value={filterPaymentType}
        onChange={(v) => { setFilterPaymentType(v); setRefreshKey((k) => k + 1); }}
        options={PAYMENT_TYPE_OPTIONS}
      />
      <Select
        placeholder="Mode"
        allowClear
        style={{ width: 140 }}
        value={filterPaymentMode}
        onChange={(v) => { setFilterPaymentMode(v); setRefreshKey((k) => k + 1); }}
        options={PAYMENT_MODES}
      />
      <DatePicker.RangePicker
        value={filterDateRange}
        onChange={(v) => { setFilterDateRange(v); setRefreshKey((k) => k + 1); }}
        format={DATE_FORMAT}
        placeholder={['From Date', 'To Date']}
        style={{ width: 240 }}
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="Payments" subtitle="Record and manage payments">
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/accounts/payments/new')}>
          Record Payment
        </Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchPayments}
        rowKey="id"
        searchPlaceholder="Search by payment number, party..."
        exportFileName="payments"
        toolbar={toolbar}
        scroll={{ x: 1500 }}
      />
    </div>
  );
};

export default Payments;
