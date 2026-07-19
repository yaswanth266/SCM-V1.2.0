import React, { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Select, Space, Badge } from 'antd';
import { PlusOutlined, EyeOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { formatDate, formatDateTime, formatNumber, exportGlobalToExcel, printGlobalToPDF } from '../../utils/helpers';

const MaterialAcknowledgementList = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchAcknowledgements = useCallback(
    async (params) => {
      return await api.get('/indent/material-acknowledgements', { params });
    },
    []
  );

  const columns = [
    {
      title: 'Ack Number',
      dataIndex: 'acknowledgement_number',
      key: 'ack_number',
      width: 160,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a onClick={() => navigate(`/indent/material-acknowledgement/${record.id}`)}>{text}</a>
      ),
    },
    {
      title: 'Vehicle Issue',
      dataIndex: 'vehicle_issue_number',
      key: 'vehicle_issue_number',
      width: 160,
      render: (v) => v || '-',
    },
    {
      title: 'Vehicle Code',
      dataIndex: 'vehicle_code',
      key: 'vehicle_code',
      width: 130,
      render: (v) => v || '-',
    },
    {
      title: 'Vehicle Number',
      dataIndex: 'vehicle_number',
      key: 'vehicle_number',
      width: 130,
      render: (v) => v || '-',
    },
    {
      title: 'Acknowledged By',
      dataIndex: 'acknowledged_by_name',
      key: 'ack_by',
      width: 160,
      render: (v, r) => v || r.acknowledged_by || '-',
    },
    {
      title: 'Acknowledged At',
      dataIndex: 'acknowledged_at',
      key: 'ack_at',
      width: 170,
      sorter: true,
      render: (v) => formatDateTime(v),
    },
    {
      title: 'Total Received Qty',
      dataIndex: 'total_received_qty',
      key: 'recv_qty',
      width: 150,
      align: 'right',
      render: (v) => formatNumber(v),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 80,
      fixed: 'right',
      render: (_, record) => (
        <Button
          type="link"
          size="small"
          icon={<EyeOutlined />}
          onClick={() => navigate(`/indent/material-acknowledgement/${record.id}`)}
        />
      ),
    },
  ];

  return (
    <div style={{ padding: '24px' }}>
      <PageHeader title="Material Acknowledgements" subtitle="Manage vehicle material receipt acknowledgements">
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/indent/material-acknowledgement/new')}>
          Acknowledge Vehicle Material
        </Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchAcknowledgements}
        rowKey="id"
        searchPlaceholder="Search acknowledgements..."
        exportFileName="material_acknowledgements"
        scroll={{ x: 1100 }}
        onExport={(data) => exportGlobalToExcel(data, 'material_acknowledgement')}
        onPrint={(data) => printGlobalToPDF(data, 'material_acknowledgement')}
      />
    </div>
  );
};

export default MaterialAcknowledgementList;
