import React, { useState, useCallback, useEffect } from 'react';
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
  const [refreshKey, setRefreshKey] = useState(0);
  const [filterStatus, setFilterStatus] = useState(undefined);

  // Acknowledge drawer
  const [ackDrawerOpen, setAckDrawerOpen] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [pendingIndents, setPendingIndents] = useState([]);
  const [selectedIndent, setSelectedIndent] = useState(null);
  const [indentDetail, setIndentDetail] = useState(null);
  const [loadingIndent, setLoadingIndent] = useState(false);
  const [scannedItems, setScannedItems] = useState([]);
  const [ackItems, setAckItems] = useState([]);

  // Detail view
  const [detailRecord, setDetailRecord] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Confirmation after ack
  const [confirmationVisible, setConfirmationVisible] = useState(false);
  const [confirmationData, setConfirmationData] = useState(null);

  const fetchAcknowledgements = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      return await api.get('/indent/acknowledgements', { params: qp });
    },
    [filterStatus]
  );

  const fetchPendingIndents = async () => {
    try {
      const res = await api.get('/indent/indents', { params: { page_size: 100, pending_acknowledgement: true } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setPendingIndents(items.map((i) => ({
        label: `${i.indent_number} - ${i.warehouse_name || i.warehouse || ''} (${formatDate(i.indent_date)})`,
        value: i.id,
        record: i,
      })));
    } catch { /* silent */ }
  };

  const handleOpenAckDrawer = () => {
    form.resetFields();
    setSelectedIndent(null);
    setIndentDetail(null);
    setScannedItems([]);
    setAckItems([]);
    fetchPendingIndents();
    setAckDrawerOpen(true);
  };

  const handleIndentSelect = async (indentId) => {
    setSelectedIndent(indentId);
    if (!indentId) {
      setIndentDetail(null);
      setAckItems([]);
      return;
    }
    setLoadingIndent(true);
    try {
      const res = await api.get(`/indent/indents/${indentId}`);
      const data = res.data;
      setIndentDetail(data);

      // BUG-FE-IND-017 — fetch any prior acknowledgements so the user can
      // see how much of each line was already received and only enter the
      // delta. Previously the form started at received_qty=0 and a partial
      // ack could be (mis-)submitted as if it were the first/only one,
      // making the very first ack get treated as final by the FE.
      let priorByLine = {};
      try {
        const ackRes = await api.get(`/indent/indents/${indentId}/acknowledgements`);
        const priorAcks = ackRes.data || [];
        for (const a of priorAcks) {
          // Some endpoints return a nested items array; legacy ones don't.
          if (Array.isArray(a.items)) {
            for (const ai of a.items) {
              const k = ai.indent_item_id || ai.item_id;
              if (!k) continue;
              priorByLine[k] = (priorByLine[k] || 0) + Number(ai.received_qty || 0);
            }
          }
        }
      } catch (_e) {
        // If we can't load prior acks (perm, 404, network), fall through
        // with an empty map — same shape as before.
      }

      const items = (data.items || []).map((item) => {
        const target = Number(item.approved_qty || item.requested_qty || 0);
        const already = Number(priorByLine[item.id] || 0);
        const remaining = Math.max(0, target - already);
        return {
          ...item,
          already_received_qty: already,
          remaining_qty: remaining,
          received_qty: 0,
          remarks: '',
        };
      });
      setAckItems(items);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoadingIndent(false);
    }
  };

  const handleBarcodeScan = (scanResult) => {
    setScannedItems((prev) => [...prev, scanResult]);
    message.success(`Scanned: ${scanResult.value}`);

    // Try to auto-match scanned barcode to an item
    const matchedIdx = ackItems.findIndex(
      (item) => (item.item?.barcode === scanResult.value) || (item.item?.item_code === scanResult.value) || (item.item_code === scanResult.value)
    );
    if (matchedIdx >= 0) {
      setAckItems((prev) =>
        prev.map((item, idx) =>
          idx === matchedIdx ? { ...item, received_qty: (item.received_qty || 0) + 1 } : item
        )
      );
      message.info(`Matched item: ${ackItems[matchedIdx].item?.item_name || ackItems[matchedIdx].item_name || 'Unknown'} - qty incremented`);
    }
  };

  const handleSubmitAck = async () => {
    try {
      const values = await form.validateFields();
      const validItems = ackItems.filter((item) => item.received_qty > 0);
      if (validItems.length === 0) {
        message.error('Please enter received quantity for at least one item');
        return;
      }
      setSubmitting(true);
      const payload = {
        indent_id: selectedIndent,
        remarks: values.remarks || '',
        scan_timestamp: new Date().toISOString(),
        items: validItems.map((item) => ({
          indent_item_id: item.id,
          item_id: item.item_id,
          received_qty: item.received_qty,
          remarks: item.remarks || '',
        })),
        scanned_barcodes: scannedItems.map((s) => ({
          value: s.value,
          timestamp: s.timestamp,
          mode: s.mode,
        })),
      };
      const res = await api.post('/indent/acknowledgements', payload);
      message.success('Acknowledgement recorded successfully');
      setConfirmationData({
        ...res.data,
        indent_number: indentDetail?.indent_number,
        items: validItems,
        scanned_count: scannedItems.length,
        timestamp: new Date().toISOString(),
      });
      setConfirmationVisible(true);
      setAckDrawerOpen(false);
      form.resetFields();
      setSelectedIndent(null);
      setIndentDetail(null);
      setScannedItems([]);
      setAckItems([]);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
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

      {/* Acknowledge Drawer */}
      <Drawer
        title="Acknowledge Goods Receipt"
        width={900}
        open={ackDrawerOpen}
        onClose={() => { setAckDrawerOpen(false); form.resetFields(); setSelectedIndent(null); setIndentDetail(null); setScannedItems([]); setAckItems([]); }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setAckDrawerOpen(false); form.resetFields(); }}>Cancel</Button>
            <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleSubmitAck} loading={submitting} disabled={!selectedIndent}>
              Confirm Acknowledgement
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item label="Select Indent" required>
            <Select
              placeholder="Select pending indent..."
              value={selectedIndent}
              onChange={handleIndentSelect}
              options={pendingIndents}
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
            />
          </Form.Item>
        </Form>

        {loadingIndent ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : indentDetail ? (
          <>
            <Card size="small" style={{ marginBottom: 16 }}>
              <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }}>
                <Descriptions.Item label="Indent #">{indentDetail.indent_number}</Descriptions.Item>
                <Descriptions.Item label="Warehouse">{indentDetail.warehouse_name || '-'}</Descriptions.Item>
                <Descriptions.Item label="Required Date">{formatDate(indentDetail.required_date)}</Descriptions.Item>
              </Descriptions>
            </Card>

            <Card size="small" title="Scan Received Goods" style={{ marginBottom: 16 }}>
              <BarcodeScanner
                onScan={handleBarcodeScan}
                placeholder="Scan barcode of received goods..."
                allowManual
              />
              {scannedItems.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <Text type="secondary">{scannedItems.length} item(s) scanned</Text>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                    {scannedItems.map((s, idx) => (
                      <Tag key={idx} color="blue">{s.value}</Tag>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            <Divider orientation="left">Received Items</Divider>
            <Table
              dataSource={ackItems}
              rowKey={(r) => r.id || r.item_id}
              size="small"
              pagination={false}
              scroll={{ x: 700 }}
              columns={[
                { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
                { title: 'Item', width: 200, render: (_, r) => r.item?.item_name || r.item_name || '-' },
                { title: 'UOM', dataIndex: 'uom', width: 80, render: (v) => v || '-' },
                { title: 'Approved Qty', dataIndex: 'approved_qty', width: 110, align: 'right', render: (v, r) => formatNumber(v || r.requested_qty) },
                {
                  title: 'Received Qty',
                  dataIndex: 'received_qty',
                  width: 130,
                  render: (val, record, idx) => (
                    <InputNumber
                      min={0}
                      max={record.approved_qty || record.requested_qty}
                      value={val}
                      onChange={(v) => {
                        setAckItems((prev) =>
                          prev.map((item, i) => (i === idx ? { ...item, received_qty: v } : item))
                        );
                      }}
                      style={{ width: '100%' }}
                    />
                  ),
                },
                {
                  title: 'Remarks',
                  dataIndex: 'remarks',
                  width: 180,
                  render: (val, record, idx) => (
                    <Input
                      value={val}
                      onChange={(e) => {
                        setAckItems((prev) =>
                          prev.map((item, i) => (i === idx ? { ...item, remarks: e.target.value } : item))
                        );
                      }}
                      placeholder="Remarks"
                    />
                  ),
                },
              ]}
            />

            <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
              <Form.Item name="remarks" label="Overall Remarks">
                <TextArea rows={2} placeholder="Any remarks about the receipt..." />
              </Form.Item>
            </Form>
          </>
        ) : (
          <Empty description="Select a pending indent to acknowledge receipt" />
        )}
      </Drawer>

      {/* Confirmation Modal */}
      <Modal
        title={<Space><CheckCircleOutlined style={{ color: '#52c41a', fontSize: 20 }} /> Acknowledgement Confirmed</Space>}
        open={confirmationVisible}
        onOk={() => setConfirmationVisible(false)}
        onCancel={() => setConfirmationVisible(false)}
        cancelButtonProps={{ style: { display: 'none' } }}
        okText="Close"
        width={500}
      >
        {confirmationData && (
          <div>
            <Descriptions size="small" column={1} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="Indent #">{confirmationData.indent_number || '-'}</Descriptions.Item>
              <Descriptions.Item label="Acknowledged At">{formatDateTime(confirmationData.timestamp)}</Descriptions.Item>
              <Descriptions.Item label="Items Received">{confirmationData.items?.length || 0}</Descriptions.Item>
              <Descriptions.Item label="Barcodes Scanned">{confirmationData.scanned_count || 0}</Descriptions.Item>
              <Descriptions.Item label="Total Received Qty">
                {formatNumber(confirmationData.items?.reduce((sum, i) => sum + (i.received_qty || 0), 0) || 0)}
              </Descriptions.Item>
            </Descriptions>
            <Table
              dataSource={confirmationData.items || []}
              rowKey={(r) => r.id || r.item_id}
              size="small"
              pagination={false}
              columns={[
                { title: 'Item', render: (_, r) => r.item?.item_name || r.item_name || '-' },
                { title: 'Received', dataIndex: 'received_qty', align: 'right', render: (v) => formatNumber(v) },
              ]}
            />
          </div>
        )}
      </Modal>
    </div>
  );
};

export default Acknowledgement;

