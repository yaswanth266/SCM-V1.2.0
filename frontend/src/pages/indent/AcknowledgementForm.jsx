import React, { useState, useEffect } from 'react';
import {
  Button, Select, Space, Card, Row, Col, message, Descriptions, Divider,
  Form, Input, InputNumber, Table, Typography, Tag, Spin, Empty
} from 'antd';
import {
  ArrowLeftOutlined, CheckCircleOutlined, InboxOutlined
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import BarcodeScanner from '../../components/BarcodeScanner';
import api from '../../config/api';
import { formatDate, formatDateTime, formatNumber, getErrorMessage } from '../../utils/helpers';

const { Text } = Typography;
const { TextArea } = Input;

const AcknowledgementForm = () => {
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [pendingIndents, setPendingIndents] = useState([]);
  const [selectedIndent, setSelectedIndent] = useState(null);
  const [indentDetail, setIndentDetail] = useState(null);
  const [loadingIndent, setLoadingIndent] = useState(false);
  const [scannedItems, setScannedItems] = useState([]);
  const [ackItems, setAckItems] = useState([]);

  useEffect(() => {
    fetchPendingIndents();
  }, []);

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
    } catch {
      // silent
    }
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

      let priorByLine = {};
      try {
        const ackRes = await api.get(`/indent/indents/${indentId}/acknowledgements`);
        const priorAcks = ackRes.data || [];
        for (const a of priorAcks) {
          if (Array.isArray(a.items)) {
            for (const ai of a.items) {
              const k = ai.indent_item_id || ai.item_id;
              if (!k) continue;
              priorByLine[k] = (priorByLine[k] || 0) + Number(ai.received_qty || 0);
            }
          }
        }
      } catch (_e) {
        // silent
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
      await api.post('/indent/acknowledgements', payload);
      message.success('Acknowledgement recorded successfully');
      navigate('/indent/acknowledgement');
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Acknowledge Goods Receipt"
        subtitle="Field staff goods receipt acknowledgement"
      >
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/indent/acknowledgement')}>
            Back
          </Button>
          <Button
            type="primary"
            icon={<CheckCircleOutlined />}
            onClick={handleSubmitAck}
            loading={submitting}
            disabled={!selectedIndent}
          >
            Confirm Acknowledgement
          </Button>
        </Space>
      </PageHeader>

      <Card bordered={false} style={{ marginBottom: 16 }}>
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
      </Card>
    </div>
  );
};

export default AcknowledgementForm;
