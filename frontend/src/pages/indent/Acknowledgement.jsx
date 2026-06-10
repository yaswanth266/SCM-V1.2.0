import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, Card, Row, Col, message, Descriptions, Divider,
  Form, Input, InputNumber, Table, Typography, Tag, Spin, Empty, Modal,
  Drawer,
} from 'antd';
import {
  CheckCircleOutlined, EyeOutlined, ScanOutlined,
  ArrowLeftOutlined, InboxOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import BarcodeScanner from '../../components/BarcodeScanner';
import api from '../../config/api';
import {
  formatDate, formatDateTime, formatNumber, getErrorMessage,
} from '../../utils/helpers';

const { Text, Title } = Typography;
const { TextArea } = Input;

const Acknowledgement = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);
  const [filterStatus, setFilterStatus] = useState(undefined);

  // Detail view
  const [detailRecord, setDetailRecord] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchAcknowledgements = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      return await api.get('/indent/acknowledgements', { params: qp });
    },
    [filterStatus]
  );

  const handleOpenAckDrawer = () => {
    navigate('/indent/acknowledgement/new');
  };

  const handleViewDetail = async (record) => {
    setDetailLoading(true);
    setDetailRecord(null);
    try {
      const res = await api.get(`/indent/acknowledgements/${record.id}`);
      setDetailRecord(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  };

  const columns = [
    {
      title: 'Indent #',
      dataIndex: 'indent_number',
      key: 'indent_number',
      width: 150,
      sorter: true,
      render: (v, r) => <a onClick={() => handleViewDetail(r)}>{v || r.indent?.indent_number || '-'}</a>,
    },
    { title: 'Warehouse', dataIndex: 'warehouse_name', key: 'warehouse', width: 160, render: (v, r) => v || r.warehouse || '-' },
    { title: 'Acknowledged By', dataIndex: 'acknowledged_by_name', key: 'ack_by', width: 160, render: (v, r) => v || r.acknowledged_by || '-' },
    { title: 'Acknowledged At', dataIndex: 'acknowledged_at', key: 'ack_at', width: 170, sorter: true, render: (v) => formatDateTime(v) },
    {
      title: 'Items Received',
      dataIndex: 'received_items_count',
      key: 'count',
      width: 130,
      align: 'right',
      render: (v) => v || '-',
    },
    {
      title: 'Total Received Qty',
      dataIndex: 'total_received_qty',
      key: 'recv_qty',
      width: 150,
      align: 'right',
      render: (v) => formatNumber(v),
    },
    { title: 'Status', dataIndex: 'status', key: 'status', width: 120, render: (s) => <StatusTag status={s || 'received'} /> },
    {
      title: 'Actions',
      key: 'actions',
      width: 80,
      render: (_, record) => (
        <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleViewDetail(record)} />
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 150 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Received', value: 'received' },
          { label: 'Partial', value: 'partial' },
          { label: 'Completed', value: 'completed' },
        ]}
      />
    </Space>
  );

  // DETAIL VIEW
  if (detailLoading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (detailRecord) {
    const ackDetailItems = detailRecord.items || [];
    return (
      <div>
        <PageHeader title={`Acknowledgement - ${detailRecord.indent_number || detailRecord.indent?.indent_number || ''}`} subtitle="Acknowledgement Detail">
          <Button icon={<ArrowLeftOutlined />} onClick={() => setDetailRecord(null)}>Back to List</Button>
        </PageHeader>
        <Card>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="Indent #">{detailRecord.indent_number || detailRecord.indent?.indent_number || '-'}</Descriptions.Item>
            <Descriptions.Item label="Warehouse">{detailRecord.warehouse_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={detailRecord.status || 'received'} /></Descriptions.Item>
            <Descriptions.Item label="Acknowledged By">{detailRecord.acknowledged_by_name || detailRecord.acknowledged_by || '-'}</Descriptions.Item>
            <Descriptions.Item label="Acknowledged At">{formatDateTime(detailRecord.acknowledged_at)}</Descriptions.Item>
            <Descriptions.Item label="Scan Timestamp">{formatDateTime(detailRecord.scan_timestamp)}</Descriptions.Item>
            <Descriptions.Item label="Remarks" span={3}>{detailRecord.remarks || '-'}</Descriptions.Item>
          </Descriptions>

          <Divider orientation="left">Received Items</Divider>
          <Table
            dataSource={ackDetailItems}
            rowKey={(r) => r.id || r.item_id}
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
              { title: 'Item Code', dataIndex: 'item_code', key: 'code', width: 120, render: (v, r) => v || r.item?.item_code || '-' },
              { title: 'Item Name', dataIndex: 'item_name', key: 'name', width: 200, render: (v, r) => v || r.item?.item_name || '-' },
              { title: 'UOM', dataIndex: 'uom', key: 'uom', width: 80, render: (v) => v || '-' },
              { title: 'Approved Qty', dataIndex: 'approved_qty', key: 'aq', width: 120, align: 'right', render: (v) => formatNumber(v) },
              { title: 'Received Qty', dataIndex: 'received_qty', key: 'rq', width: 120, align: 'right', render: (v) => <Text strong>{formatNumber(v)}</Text> },
              { title: 'Remarks', dataIndex: 'remarks', key: 'rem', width: 200, ellipsis: true, render: (v) => v || '-' },
            ]}
          />

          {detailRecord.scanned_barcodes && detailRecord.scanned_barcodes.length > 0 && (
            <>
              <Divider orientation="left">Scanned Barcodes</Divider>
              <Table
                dataSource={detailRecord.scanned_barcodes}
                rowKey={(r, idx) => idx}
                size="small"
                pagination={false}
                columns={[
                  { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
                  { title: 'Barcode Value', dataIndex: 'value', key: 'val', width: 200 },
                  { title: 'Scanned At', dataIndex: 'timestamp', key: 'ts', width: 180, render: (v) => formatDateTime(v) },
                  { title: 'Mode', dataIndex: 'mode', key: 'mode', width: 100, render: (v) => <Tag>{v || 'scan'}</Tag> },
                ]}
              />
            </>
          )}
        </Card>
      </div>
    );
  }

  // LIST VIEW
  return (
    <div>
      <PageHeader title="Acknowledgement" subtitle="Field staff goods receipt acknowledgement">
        <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleOpenAckDrawer}>Acknowledge Receipt</Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchAcknowledgements}
        rowKey="id"
        searchPlaceholder="Search by indent number..."
        exportFileName="acknowledgements"
        toolbar={toolbar}
        scroll={{ x: 1200 }}
      />


    </div>
  );
};

export default Acknowledgement;

