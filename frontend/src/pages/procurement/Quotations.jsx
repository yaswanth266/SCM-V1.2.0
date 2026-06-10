import React, { useState, useCallback } from 'react';
import {
  Button, Select, Space, Popconfirm, message, Tag, Typography
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  SendOutlined
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatDate, formatCurrency, getErrorMessage
} from '../../utils/helpers';

const { Text } = Typography;

const Quotations = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);

  const fetchQuotations = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      return await api.get('/procurement/quotations', { params: qp });
    },
    [filterStatus]
  );

  const handleAdd = () => {
    navigate('/procurement/quotations/new');
  };

  const handleEdit = (record) => {
    navigate(`/procurement/quotations/${record.id}?edit=true`);
  };

  const handleViewQuotation = (record) => {
    navigate(`/procurement/quotations/${record.id}`);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/procurement/quotations/${id}`);
      message.success('Quotation deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSendToVendor = async (id) => {
    try {
      await api.post(`/procurement/quotations/${id}/submit`);
      message.success('Quotation sent to vendor');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'RFQ No',
      dataIndex: 'rfq_number',
      key: 'rfq_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => handleViewQuotation(record)}>{text || record.rfq_number}</a>,
    },
    {
      title: 'MR Ref',
      dataIndex: 'mr_number',
      key: 'mr',
      width: 130,
      render: (v, r) => v || r.mr_reference || '-',
    },
    {
      title: 'Vendor',
      dataIndex: 'vendor_name',
      key: 'vendor',
      width: 200,
      ellipsis: true,
      render: (v, r) => v || r.vendor || '-',
    },
    {
      title: 'Quotation Date',
      dataIndex: 'quotation_date',
      key: 'quotation_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Valid Until',
      dataIndex: 'valid_until',
      key: 'valid_until',
      width: 120,
      render: (v) => {
        if (!v) return '-';
        const isExpired = dayjs(v).isBefore(dayjs());
        return <Text type={isExpired ? 'danger' : undefined}>{formatDate(v)}</Text>;
      },
    },
    {
      title: 'Amount',
      dataIndex: 'total_amount',
      key: 'total_amount',
      width: 120,
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
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (s, record) => {
        if (s === 'submitted' && (!record.grand_total || record.grand_total === 0)) {
          return <Tag style={{ color: '#fff', backgroundColor: '#fa8c16', borderColor: '#fa8c16' }}>Awaiting Vendor</Tag>;
        }
        return <StatusTag status={s} />;
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleViewQuotation(record)} />
          {(record.status === 'draft' || record.status === 'pending') && (
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          )}
          {record.status === 'draft' && (
            <Popconfirm
              title="Send this quotation to the vendor?"
              onConfirm={() => handleSendToVendor(record.id)}
              okText="Send"
              cancelText="Cancel"
            >
              <Button type="link" size="small" icon={<SendOutlined />} />
            </Popconfirm>
          )}
          {record.status === 'draft' && (
            <Popconfirm title="Delete this quotation?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
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
        style={{ width: 140 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Draft', value: 'draft' },
          { label: 'Submitted', value: 'submitted' },
          { label: 'Accepted', value: 'accepted' },
          { label: 'Rejected', value: 'rejected' },
          { label: 'Expired', value: 'expired' },
        ]}
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="RFQs" subtitle="Manage RFQs and Vendor Quotations">
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            Create RFQ
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchQuotations}
        rowKey="id"
        searchPlaceholder="Search by RFQ/quotation number or vendor..."
        exportFileName="quotations"
        toolbar={toolbar}
        scroll={{ x: 1500 }}
      />
    </div>
  );
};

export default Quotations;
