import React, { useState } from 'react';
import {
  Button, Input, Space, Card, Row, Col, message, Tag, Descriptions,
  Timeline, Typography, Select, Form, Modal, Spin, Empty, Divider,
} from 'antd';
import {
  SearchOutlined, ScanOutlined, EnvironmentOutlined,
  ClockCircleOutlined, CheckCircleOutlined, CarOutlined,
  LoadingOutlined, InboxOutlined, ArrowRightOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import relativeTime from 'dayjs/plugin/relativeTime';
import PageHeader from '../../components/PageHeader';
import BarcodeScanner from '../../components/BarcodeScanner';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { formatDateTime, getErrorMessage } from '../../utils/helpers';

dayjs.extend(duration);
dayjs.extend(relativeTime);

const { Text, Title } = Typography;
const { TextArea } = Input;

const SHIPMENT_STATUSES = [
  { label: 'Vehicle Assigned', value: 'vehicle_assigned', icon: <CarOutlined />, color: '#eb2f96' },
  { label: 'Loading', value: 'loading', icon: <LoadingOutlined />, color: '#fa8c16' },
  { label: 'Dispatched', value: 'dispatched', icon: <ArrowRightOutlined />, color: '#eb2f96' },
  { label: 'In Transit', value: 'in_transit', icon: <CarOutlined />, color: '#722ed1' },
  { label: 'Reached Destination', value: 'reached_destination', icon: <EnvironmentOutlined />, color: '#13c2c2' },
  { label: 'Unloading', value: 'unloading', icon: <InboxOutlined />, color: '#fa8c16' },
  { label: 'Delivered', value: 'delivered', icon: <CheckCircleOutlined />, color: '#52c41a' },
];

const STATUS_ORDER = SHIPMENT_STATUSES.map((s) => s.value);

const getStatusConfig = (status) => {
  return SHIPMENT_STATUSES.find((s) => s.value === status) || { label: status, icon: <ClockCircleOutlined />, color: '#8c8c8c' };
};

const ShipmentTracking = () => {
  const [searchValue, setSearchValue] = useState('');
  const [searchType, setSearchType] = useState('order_number');
  const [loading, setLoading] = useState(false);
  const [shipment, setShipment] = useState(null);
  const [trackingEvents, setTrackingEvents] = useState([]);

  // Update status
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateForm] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [scannedBarcode, setScannedBarcode] = useState(null);

  const handleSearch = async () => {
    if (!searchValue.trim()) {
      message.warning('Please enter a search value');
      return;
    }
    setLoading(true);
    setShipment(null);
    setTrackingEvents([]);
    try {
      const params = { [searchType]: searchValue.trim() };
      const res = await api.get('/logistics/shipment-tracking', { params });
      const data = res.data;
      setShipment(data.shipment || data);
      const events = data.tracking_events || data.events || data.timeline || [];
      setTrackingEvents(Array.isArray(events) ? events : []);
    } catch (err) {
      const msg = getErrorMessage(err);
      if (err.response?.status === 404) {
        message.warning('No shipment found for the given search criteria');
      } else {
        message.error(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateStatus = async () => {
    try {
      const values = await updateForm.validateFields();
      if (!scannedBarcode) {
        message.warning('Please scan a barcode first');
        return;
      }
      setSubmitting(true);
      // BUG-ISS-126 — backend route is POST /logistics/tracking with field
      // name `barcode_scanned` (not `barcode_value`). The old endpoint
      // /logistics/shipment-tracking/update-status was 404'ing silently.
      const payload = {
        transport_order_id: shipment.id || shipment.transport_order_id,
        status: values.status,
        location_description: values.location_description,
        barcode_scanned: scannedBarcode.value,
        status_timestamp: scannedBarcode.timestamp,
        remarks: values.remarks || '',
      };
      await api.post('/logistics/tracking', payload);
      message.success('Shipment status updated');
      setUpdateModalOpen(false);
      updateForm.resetFields();
      setScannedBarcode(null);
      // Refresh tracking data
      handleSearch();
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleBarcodeScan = (scanResult) => {
    setScannedBarcode(scanResult);
    message.success(`Barcode scanned: ${scanResult.value}`);
  };

  // Calculate duration between two timestamps
  const calcDuration = (from, to) => {
    if (!from || !to) return '-';
    const diff = dayjs(to).diff(dayjs(from));
    const dur = dayjs.duration(diff);
    const hours = Math.floor(dur.asHours());
    const minutes = dur.minutes();
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  // Get current status index
  const currentStatusIdx = shipment ? STATUS_ORDER.indexOf(shipment.current_status || shipment.status) : -1;

  // Build timeline items
  const timelineItems = trackingEvents.map((event, idx) => {
    const config = getStatusConfig(event.status);
    const eventStatusIdx = STATUS_ORDER.indexOf(event.status);
    const isCompleted = eventStatusIdx < currentStatusIdx;
    const isCurrent = eventStatusIdx === currentStatusIdx;

    let dotColor = '#d9d9d9'; // pending/gray
    if (isCompleted) dotColor = '#52c41a'; // green
    if (isCurrent) dotColor = '#eb2f96'; // blue

    const nextEvent = trackingEvents[idx + 1];
    const durationToNext = nextEvent ? calcDuration(event.timestamp, nextEvent.timestamp) : null;

    return {
      color: dotColor,
      dot: React.cloneElement(config.icon, { style: { fontSize: 16, color: dotColor } }),
      children: (
        <div style={{ paddingBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Text strong style={{ fontSize: 14, color: isCurrent ? '#eb2f96' : undefined }}>
              {config.label}
            </Text>
            {isCurrent && <Tag color="blue">Current</Tag>}
            {isCompleted && <Tag color="green">Completed</Tag>}
          </div>
          <div style={{ color: 'rgba(0,0,0,0.65)', fontSize: 13 }}>
            <ClockCircleOutlined style={{ marginRight: 4 }} />
            {formatDateTime(event.timestamp)}
          </div>
          {event.location_description && (
            <div style={{ color: 'rgba(0,0,0,0.65)', fontSize: 13 }}>
              <EnvironmentOutlined style={{ marginRight: 4 }} />
              {event.location_description}
            </div>
          )}
          {event.updated_by_name && (
            <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12, marginTop: 2 }}>
              Updated by: {event.updated_by_name || event.updated_by}
            </div>
          )}
          {event.barcode_value && (
            <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>
              <ScanOutlined style={{ marginRight: 4 }} />
              Barcode: {event.barcode_value}
            </div>
          )}
          {durationToNext && (
            <div style={{ color: 'rgba(0,0,0,0.35)', fontSize: 11, marginTop: 4, fontStyle: 'italic' }}>
              Duration to next status: {durationToNext}
            </div>
          )}
        </div>
      ),
    };
  });

  // Add pending statuses to timeline
  SHIPMENT_STATUSES.forEach((s) => {
    const exists = trackingEvents.find((e) => e.status === s.value);
    if (!exists) {
      const sIdx = STATUS_ORDER.indexOf(s.value);
      if (sIdx > currentStatusIdx) {
        timelineItems.push({
          color: '#d9d9d9',
          dot: React.cloneElement(s.icon, { style: { fontSize: 16, color: '#d9d9d9' } }),
          children: (
            <div style={{ paddingBottom: 8 }}>
              <Text type="secondary" style={{ fontSize: 14 }}>{s.label}</Text>
              <div style={{ color: 'rgba(0,0,0,0.25)', fontSize: 13 }}>Pending</div>
            </div>
          ),
        });
      }
    }
  });

  return (
    <div>
      <PageHeader title="Shipment Tracking" subtitle="Track shipments by transport order, docket, or LR number" />

      <Card style={{ marginBottom: 16 }}>
        <Row gutter={16} align="middle">
          <Col xs={24} sm={6}>
            <Select
              value={searchType}
              onChange={setSearchType}
              style={{ width: '100%' }}
              options={[
                { label: 'Transport Order #', value: 'order_number' },
                { label: 'Docket Number', value: 'docket_number' },
                { label: 'LR Number', value: 'lr_number' },
              ]}
            />
          </Col>
          <Col xs={24} sm={12}>
            <Input
              placeholder={`Enter ${searchType === 'order_number' ? 'transport order number' : searchType === 'docket_number' ? 'docket number' : 'LR number'}...`}
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              onPressEnter={handleSearch}
              prefix={<SearchOutlined />}
              size="large"
              allowClear
            />
          </Col>
          <Col xs={24} sm={6}>
            <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch} loading={loading} size="large" block>
              Track
            </Button>
          </Col>
        </Row>
      </Card>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
      ) : shipment ? (
        <>
          {/* Current Status Card */}
          <Card
            style={{
              marginBottom: 16,
              borderLeft: `4px solid ${getStatusConfig(shipment.current_status || shipment.status).color}`,
            }}
          >
            <Row gutter={24} align="middle">
              <Col xs={24} md={6}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 40, color: getStatusConfig(shipment.current_status || shipment.status).color }}>
                    {getStatusConfig(shipment.current_status || shipment.status).icon}
                  </div>
                  <Title level={4} style={{ margin: '8px 0 0', color: getStatusConfig(shipment.current_status || shipment.status).color }}>
                    {getStatusConfig(shipment.current_status || shipment.status).label}
                  </Title>
                </div>
              </Col>
              <Col xs={24} md={18}>
                <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }}>
                  <Descriptions.Item label="Order #">{shipment.order_number || '-'}</Descriptions.Item>
                  <Descriptions.Item label="Vendor">{shipment.vendor_name || '-'}</Descriptions.Item>
                  <Descriptions.Item label="Vehicle">{shipment.vehicle_number || '-'}</Descriptions.Item>
                  <Descriptions.Item label="Driver">{shipment.driver_name || '-'}</Descriptions.Item>
                  <Descriptions.Item label="Docket #">{shipment.docket_number || '-'}</Descriptions.Item>
                  <Descriptions.Item label="LR #">{shipment.lr_number || '-'}</Descriptions.Item>
                  <Descriptions.Item label="Dispatch">{shipment.dispatch_location || '-'}</Descriptions.Item>
                  <Descriptions.Item label="Destination">{shipment.destination || '-'}</Descriptions.Item>
                  <Descriptions.Item label="Dispatch Date">{formatDateTime(shipment.dispatch_date)}</Descriptions.Item>
                </Descriptions>
              </Col>
            </Row>
          </Card>

          {/* Status Progress */}
          <Card style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', overflow: 'auto', padding: '8px 0' }}>
              {SHIPMENT_STATUSES.map((s, idx) => {
                const sIdx = STATUS_ORDER.indexOf(s.value);
                const isCompleted = sIdx < currentStatusIdx;
                const isCurrent = sIdx === currentStatusIdx;
                const isPending = sIdx > currentStatusIdx;
                let bg = '#f5f5f5';
                let textColor = 'rgba(0,0,0,0.25)';
                let borderColor = '#d9d9d9';
                if (isCompleted) { bg = '#f6ffed'; textColor = '#52c41a'; borderColor = '#52c41a'; }
                if (isCurrent) { bg = '#e6f7ff'; textColor = '#eb2f96'; borderColor = '#eb2f96'; }
                return (
                  <React.Fragment key={s.value}>
                    <div style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 12px',
                      background: bg, borderRadius: 8, border: `1px solid ${borderColor}`, minWidth: 100, flex: 1,
                    }}>
                      <div style={{ fontSize: 20, color: textColor, marginBottom: 4 }}>{s.icon}</div>
                      <Text style={{ fontSize: 11, color: textColor, textAlign: 'center' }}>{s.label}</Text>
                    </div>
                    {idx < SHIPMENT_STATUSES.length - 1 && (
                      <div style={{ margin: '0 4px', color: isCompleted ? '#52c41a' : '#d9d9d9', fontSize: 16 }}>
                        <ArrowRightOutlined />
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          </Card>

          <Row gutter={16}>
            {/* Timeline */}
            <Col xs={24} md={16}>
              <Card
                title="Tracking Timeline"
                extra={
                  (shipment.current_status || shipment.status) !== 'delivered' && (
                    <Button type="primary" icon={<ScanOutlined />} onClick={() => { updateForm.resetFields(); setScannedBarcode(null); setUpdateModalOpen(true); }}>
                      Update Status
                    </Button>
                  )
                }
              >
                {timelineItems.length > 0 ? (
                  <Timeline mode="left" items={timelineItems} />
                ) : (
                  <Empty description="No tracking events recorded yet" />
                )}
              </Card>
            </Col>

            {/* Duration Summary */}
            <Col xs={24} md={8}>
              <Card title="Duration Summary">
                {trackingEvents.length > 1 ? (
                  <div>
                    {trackingEvents.map((event, idx) => {
                      if (idx === 0) return null;
                      const prevEvent = trackingEvents[idx - 1];
                      const prevConfig = getStatusConfig(prevEvent.status);
                      const currConfig = getStatusConfig(event.status);
                      return (
                        <div key={idx} style={{ marginBottom: 12, padding: '8px 12px', background: '#fafafa', borderRadius: 4 }}>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {prevConfig.label} → {currConfig.label}
                          </Text>
                          <div>
                            <Text strong>{calcDuration(prevEvent.timestamp, event.timestamp)}</Text>
                          </div>
                        </div>
                      );
                    })}
                    {trackingEvents.length >= 2 && (
                      <>
                        <Divider />
                        <div style={{ padding: '8px 12px', background: '#e6f7ff', borderRadius: 4 }}>
                          <Text type="secondary" style={{ fontSize: 12 }}>Total Duration</Text>
                          <div>
                            <Text strong style={{ fontSize: 16 }}>
                              {calcDuration(trackingEvents[0].timestamp, trackingEvents[trackingEvents.length - 1].timestamp)}
                            </Text>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <Empty description="Not enough events for duration calculation" />
                )}
              </Card>
            </Col>
          </Row>
        </>
      ) : (
        <Card>
          <Empty description="Enter a transport order number, docket number, or LR number to track the shipment" />
        </Card>
      )}

      {/* Update Status Modal */}
      <Modal
        title="Update Shipment Status"
        open={updateModalOpen}
        onOk={handleUpdateStatus}
        onCancel={() => { setUpdateModalOpen(false); updateForm.resetFields(); setScannedBarcode(null); }}
        confirmLoading={submitting}
        okText="Update Status"
        width={600}
      >
        <div style={{ marginBottom: 16 }}>
          <BarcodeScanner
            onScan={handleBarcodeScan}
            placeholder="Scan barcode to record shipment update..."
            allowManual
          />
          {scannedBarcode && (
            <Card size="small" style={{ marginTop: 8, background: '#f6ffed' }}>
              <Text type="success">
                Scanned: <Text strong>{scannedBarcode.value}</Text> at {new Date(scannedBarcode.timestamp).toLocaleString()}
              </Text>
            </Card>
          )}
        </div>
        <Form form={updateForm} layout="vertical">
          <Form.Item name="status" label="New Status" rules={[{ required: true, message: 'Select a status' }]}>
            <Select
              placeholder="Select new status"
              options={SHIPMENT_STATUSES.filter((s) => {
                const currentIdx = STATUS_ORDER.indexOf(shipment?.current_status || shipment?.status);
                const sIdx = STATUS_ORDER.indexOf(s.value);
                return sIdx > currentIdx;
              }).map((s) => ({ label: s.label, value: s.value }))}
            />
          </Form.Item>
          <Form.Item name="location_description" label="Location Description" rules={[{ required: true, message: 'Required' }]}>
            <Input placeholder="e.g. Mumbai Warehouse, Highway NH4 checkpoint" prefix={<EnvironmentOutlined />} />
          </Form.Item>
          <Form.Item name="remarks" label="Remarks">
            <TextArea rows={2} placeholder="Additional notes..." />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default ShipmentTracking;
