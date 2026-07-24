import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, Select, Space, Card, Row, Col, message, Descriptions, Divider,
  Form, Input, InputNumber, Table, Typography, Tag, Spin, Empty, Badge,
} from 'antd';
import {
  EyeOutlined, ScanOutlined,
  ArrowLeftOutlined, InboxOutlined, IdcardOutlined, UserOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatDate, formatDateTime, formatNumber, getErrorMessage,
} from '../../utils/helpers';

const { Text, Title } = Typography;

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
    {
      title: 'Employee Code',
      dataIndex: 'employee_code',
      key: 'emp_code',
      width: 140,
      render: (v) => v ? (
        <Tag icon={<IdcardOutlined />} color="blue" style={{ fontFamily: 'monospace' }}>{v}</Tag>
      ) : '-',
    },
    { title: 'Acknowledged By', dataIndex: 'acknowledged_by_name', key: 'ack_by', width: 160, render: (v, r) => v || r.acknowledged_by || '-' },
    { title: 'Acknowledged At', dataIndex: 'acknowledged_at', key: 'ack_at', width: 170, sorter: true, render: (v) => formatDateTime(v) },
    {
      title: 'Items Received',
      dataIndex: 'received_items_count',
      key: 'count',
      width: 130,
      align: 'right',
      render: (v, r) => {
        const count = v || (r.items ? r.items.length : 0);
        return count ? <Badge count={count} showZero color="#6366f1" /> : '-';
      },
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
    const employeeCode = detailRecord.employee_code;

    return (
      <div>
        <PageHeader
          title={`Acknowledgement — ${detailRecord.indent_number || detailRecord.indent?.indent_number || ''}`}
          subtitle="Acknowledgement Detail"
        >
          <Button icon={<ArrowLeftOutlined />} onClick={() => setDetailRecord(null)}>Back to List</Button>
        </PageHeader>
        <Card>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="Indent #">
              {detailRecord.indent_number || detailRecord.indent?.indent_number || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Warehouse">
              {detailRecord.warehouse_name || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Status">
              <StatusTag status={detailRecord.status || 'received'} />
            </Descriptions.Item>
            <Descriptions.Item label={<span><IdcardOutlined style={{ marginRight: 4, color: '#6366f1' }} />Employee Code</span>}>
              {employeeCode ? (
                <Tag color="blue" style={{ fontFamily: 'monospace', fontWeight: 600 }}>{employeeCode}</Tag>
              ) : '-'}
            </Descriptions.Item>
            <Descriptions.Item label={<span><UserOutlined style={{ marginRight: 4 }} />Acknowledged By</span>}>
              {detailRecord.acknowledged_by_name || detailRecord.acknowledged_by || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Acknowledged At">
              {formatDateTime(detailRecord.acknowledged_at)}
            </Descriptions.Item>
            <Descriptions.Item label="Scan Timestamp">
              {formatDateTime(detailRecord.scan_timestamp)}
            </Descriptions.Item>
            <Descriptions.Item label="Remarks" span={3}>
              {detailRecord.remarks || '-'}
            </Descriptions.Item>
          </Descriptions>

          <Divider orientation="left">
            <span style={{ color: '#6366f1', fontWeight: 600 }}>
              Received Items ({ackDetailItems.length})
            </span>
          </Divider>
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
              { title: 'UOM', dataIndex: 'uom', key: 'uom', width: 80, render: (v, r) => r.uom_name || r.uom || v || '-' },
              { title: 'Approved Qty', dataIndex: 'approved_qty', key: 'aq', width: 120, align: 'right', render: (v) => formatNumber(v) },
              {
                title: 'Received Qty',
                dataIndex: 'received_qty',
                key: 'rq',
                width: 120,
                align: 'right',
                render: (v) => <Text strong style={{ color: '#16a34a' }}>{formatNumber(v)}</Text>,
              },
              {
                title: 'Asset / Consumable Code',
                key: 'codes',
                width: 250,
                render: (_, record) => {
                  const codes = record.asset_codes || record.consumable_codes || record.serial_numbers || [];
                  if (!codes || codes.length === 0) return '-';
                  return (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', maxWidth: '300px' }}>
                      {codes.map((code) => (
                        <Tag color="cyan" key={code} style={{ fontFamily: 'monospace', margin: 0 }}>
                          {code}
                        </Tag>
                      ))}
                    </div>
                  );
                }
              },
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
      <PageHeader title="Acknowledgement" subtitle="Field staff goods receipt acknowledgement" />

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchAcknowledgements}
        rowKey="id"
        searchPlaceholder="Search by indent number..."
        exportFileName="acknowledgements"
        toolbar={toolbar}
        scroll={{ x: 1300 }}
      />
    </div>
  );
};

export default Acknowledgement;
