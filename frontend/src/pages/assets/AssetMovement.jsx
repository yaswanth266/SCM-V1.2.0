import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Modal, Form, Input, Select, Space, Row, Col, DatePicker,
  message, Card, Timeline, Spin, Descriptions, Tag, Divider,
} from 'antd';
import {
  PlusOutlined, SwapOutlined, HistoryOutlined, SearchOutlined,
  ScanOutlined, DownloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import BarcodeScanner from '../../components/BarcodeScanner';
import api from '../../config/api';
import { formatDate, formatDateForAPI, getErrorMessage, downloadExcel } from '../../utils/helpers';
import { MOVEMENT_TYPES, DATE_FORMAT } from '../../utils/constants';

const MOVEMENT_COLORS = {
  transfer: 'blue',
  assign: 'green',
  return: 'orange',
  maintenance: 'purple',
  dispose: 'red',
};

const AssetMovement = () => {
  const [modalOpen, setModalOpen] = useState(false);
  const [timelineModal, setTimelineModal] = useState(false);
  const [scannerModal, setScannerModal] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [filterType, setFilterType] = useState(undefined);
  const [assets, setAssets] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [users, setUsers] = useState([]);
  const [selectedAssetInfo, setSelectedAssetInfo] = useState(null);
  const [timelineAsset, setTimelineAsset] = useState(null);
  const [timelineData, setTimelineData] = useState([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [assetSearchText, setAssetSearchText] = useState('');

  useEffect(() => {
    fetchLookups();
  }, []);

  const fetchLookups = async () => {
    try {
      const [assetRes, warehouseRes, userRes] = await Promise.allSettled([
        // BUG-HC-130 fix: cap aligned with backend's tightened page_size
        // limit (was 500 client-side, but backend now caps at 200). For
        // larger inventories the user should rely on barcode scan or the
        // free-text /assets/search endpoint rather than scrolling a 500-row
        // dropdown — surface a hint via the placeholder when truncation
        // is suspected.
        api.get('/assets', { params: { page_size: 200 } }),
        api.get('/masters/warehouses', { params: { page_size: 500, status: 'active' } }),
        api.get('/users/lookup', { params: { page_size: 500 } }),
      ]);
      if (assetRes.status === 'fulfilled') {
        const d = assetRes.value.data;
        setAssets((d.items || d.data || d || []).map((a) => ({
          label: `${a.asset_code} - ${a.name}`,
          value: a.id,
          asset: a,
        })));
      }
      if (warehouseRes.status === 'fulfilled') {
        const d = warehouseRes.value.data;
        setWarehouses((d.items || d.data || d || []).map((w) => ({ label: w.name, value: w.id })));
      }
      if (userRes.status === 'fulfilled') {
        const d = userRes.value.data;
        setUsers((d.items || d.data || d || []).map((u) => ({ label: u.full_name || u.username, value: u.id })));
      }
    } catch {
      // silent
    }
  };

  const fetchMovements = useCallback(
    async (params) => {
      const queryParams = { ...params };
      if (filterType) queryParams.movement_type = filterType;
      const res = await api.get('/assets/movements', { params: queryParams });
      return res;
    },
    [filterType]
  );

  const handleAssetSelect = (assetId) => {
    const found = assets.find((a) => a.value === assetId);
    if (found) {
      setSelectedAssetInfo(found.asset);
      form.setFieldsValue({
        from_location: found.asset.current_location,
        from_user: found.asset.assigned_to,
      });
    } else {
      setSelectedAssetInfo(null);
    }
  };

  const handleScan = async (scanResult) => {
    const code = scanResult.value;
    try {
      const res = await api.get('/assets/search', { params: { barcode: code } });
      const data = res.data;
      const asset = data.items ? data.items[0] : (Array.isArray(data) ? data[0] : data);
      if (asset) {
        setScannerModal(false);
        setModalOpen(true);
        setSelectedAssetInfo(asset);
        form.setFieldsValue({
          asset_id: asset.id,
          from_location: asset.current_location,
          from_user: asset.assigned_to,
        });
        message.success(`Found asset: ${asset.asset_code} - ${asset.name}`);
      } else {
        message.warning('No asset found with this barcode');
      }
    } catch {
      message.error('Failed to search asset by barcode');
    }
  };

  const handleRecordMovement = () => {
    setSelectedAssetInfo(null);
    form.resetFields();
    form.setFieldsValue({ movement_date: dayjs() });
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const payload = {
        ...values,
        movement_date: formatDateForAPI(values.movement_date),
      };
      await api.post('/assets/movements', payload);
      message.success('Movement recorded successfully');
      setModalOpen(false);
      form.resetFields();
      setSelectedAssetInfo(null);
      setRefreshKey((k) => k + 1);
      fetchLookups();
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleViewTimeline = async (assetId, assetInfo) => {
    setTimelineAsset(assetInfo || null);
    setTimelineModal(true);
    setTimelineLoading(true);
    try {
      const res = await api.get(`/assets/${assetId}/movements`, { params: { page_size: 200 } });
      const data = res.data;
      setTimelineData(data.items || data.data || data || []);
    } catch {
      setTimelineData([]);
    } finally {
      setTimelineLoading(false);
    }
  };

  const handleExport = async () => {
    try {
      const res = await api.get('/assets/movements', { params: { page_size: 10000 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      const exportData = items.map((m) => ({
        'Asset': m.asset_code || m.asset_name || '',
        'Movement Type': m.movement_type,
        'From Location': m.from_location || '',
        'To Location': m.to_location || '',
        'From User': m.from_user_name || '',
        'To User': m.to_user_name || '',
        'Date': formatDate(m.movement_date),
        'Reason': m.reason || '',
      }));
      downloadExcel(exportData, 'asset_movements', 'Movements');
      message.success('Export completed');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'Asset',
      key: 'asset',
      width: 200,
      render: (_, record) => (
        <a onClick={() => handleViewTimeline(record.asset_id, record)}>
          {record.asset_code || record.asset_name || `Asset #${record.asset_id}`}
        </a>
      ),
    },
    {
      title: 'Movement Type',
      dataIndex: 'movement_type',
      key: 'movement_type',
      width: 130,
      render: (val) => {
        const found = MOVEMENT_TYPES.find((t) => t.value === val);
        const color = MOVEMENT_COLORS[val] || 'default';
        return <Tag color={color}>{found ? found.label : (val || '-')}</Tag>;
      },
    },
    {
      title: 'From Location',
      dataIndex: 'from_location',
      key: 'from_location',
      width: 150,
      render: (val) => val || '-',
    },
    {
      title: 'To Location',
      dataIndex: 'to_location',
      key: 'to_location',
      width: 150,
      render: (val) => val || '-',
    },
    {
      title: 'From User',
      dataIndex: 'from_user_name',
      key: 'from_user',
      width: 140,
      render: (val) => val || '-',
    },
    {
      title: 'To User',
      dataIndex: 'to_user_name',
      key: 'to_user',
      width: 140,
      render: (val) => val || '-',
    },
    {
      title: 'Date',
      dataIndex: 'movement_date',
      key: 'movement_date',
      width: 120,
      render: (val) => formatDate(val),
      sorter: true,
    },
    {
      title: 'Reason',
      dataIndex: 'reason',
      key: 'reason',
      width: 200,
      ellipsis: true,
      render: (val) => val || '-',
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 80,
      render: (_, record) => (
        <Button
          type="link"
          size="small"
          icon={<HistoryOutlined />}
          onClick={() => handleViewTimeline(record.asset_id, record)}
        />
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <Select
        placeholder="Movement Type"
        allowClear
        style={{ width: 160 }}
        value={filterType}
        onChange={(v) => { setFilterType(v); setRefreshKey((k) => k + 1); }}
        options={MOVEMENT_TYPES}
      />
    </Space>
  );

  const movementType = Form.useWatch('movement_type', form);

  return (
    <div>
      <PageHeader title="Asset Movement" subtitle="Track asset transfers, assignments, and dispositions">
        <Space>
          <Button icon={<DownloadOutlined />} onClick={handleExport}>Export</Button>
          <Button icon={<ScanOutlined />} onClick={() => setScannerModal(true)}>Scan Asset</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleRecordMovement}>Record Movement</Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchMovements}
        rowKey="id"
        searchPlaceholder="Search movements..."
        exportFileName="asset_movements"
        toolbar={toolbar}
        scroll={{ x: 1400 }}
      />

      {/* Record Movement Modal */}
      <Modal
        title="Record Asset Movement"
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setSelectedAssetInfo(null); form.resetFields(); }}
        onOk={handleSubmit}
        confirmLoading={submitting}
        okText="Record Movement"
        width={700}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={16}>
              <Form.Item name="asset_id" label="Asset" rules={[{ required: true, message: 'Select an asset' }]}>
                <Select
                  placeholder="Search and select asset"
                  options={assets}
                  showSearch
                  optionFilterProp="label"
                  onChange={handleAssetSelect}
                  filterOption={(input, option) =>
                    (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="movement_date" label="Movement Date" rules={[{ required: true, message: 'Date required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
          </Row>

          {selectedAssetInfo && (
            <Card size="small" style={{ marginBottom: 16, background: '#fafafa' }}>
              <Descriptions size="small" column={3}>
                <Descriptions.Item label="Code">{selectedAssetInfo.asset_code}</Descriptions.Item>
                <Descriptions.Item label="Name">{selectedAssetInfo.name}</Descriptions.Item>
                <Descriptions.Item label="Status"><StatusTag status={selectedAssetInfo.status} /></Descriptions.Item>
                <Descriptions.Item label="Location">{selectedAssetInfo.current_location || '-'}</Descriptions.Item>
                <Descriptions.Item label="Assigned To">{selectedAssetInfo.assigned_to_name || '-'}</Descriptions.Item>
                <Descriptions.Item label="Condition">{selectedAssetInfo.condition || '-'}</Descriptions.Item>
              </Descriptions>
            </Card>
          )}

          <Form.Item name="movement_type" label="Movement Type" rules={[{ required: true, message: 'Select movement type' }]}>
            <Select placeholder="Select movement type" options={MOVEMENT_TYPES} />
          </Form.Item>

          {(movementType === 'transfer') && (
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="from_location" label="From Location">
                  <Select placeholder="From location" options={warehouses} showSearch optionFilterProp="label" allowClear />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="to_location" label="To Location" rules={[{ required: true, message: 'To location required' }]}>
                  <Select placeholder="To location" options={warehouses} showSearch optionFilterProp="label" />
                </Form.Item>
              </Col>
            </Row>
          )}

          {(movementType === 'assign') && (
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="to_user" label="Assign To" rules={[{ required: true, message: 'Select user' }]}>
                  <Select placeholder="Select user" options={users} showSearch optionFilterProp="label" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="to_location" label="Location">
                  <Select placeholder="Select location" options={warehouses} showSearch optionFilterProp="label" allowClear />
                </Form.Item>
              </Col>
            </Row>
          )}

          {(movementType === 'return') && (
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="from_user" label="Return From">
                  <Select placeholder="Select user" options={users} showSearch optionFilterProp="label" allowClear />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="to_location" label="Return To Location" rules={[{ required: true, message: 'Location required' }]}>
                  <Select placeholder="Select location" options={warehouses} showSearch optionFilterProp="label" />
                </Form.Item>
              </Col>
            </Row>
          )}

          {(movementType === 'maintenance') && (
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="to_location" label="Maintenance Location">
                  <Select placeholder="Select location" options={warehouses} showSearch optionFilterProp="label" allowClear />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="expected_return_date" label="Expected Return Date">
                  <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
                </Form.Item>
              </Col>
            </Row>
          )}

          {(movementType === 'dispose') && (
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item name="disposal_method" label="Disposal Method">
                  <Select
                    placeholder="Select method"
                    options={[
                      { label: 'Sold', value: 'sold' },
                      { label: 'Scrapped', value: 'scrapped' },
                      { label: 'Donated', value: 'donated' },
                      { label: 'Written Off', value: 'written_off' },
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="disposal_value" label="Disposal Value">
                  <Input type="number" placeholder="0.00" prefix="INR" />
                </Form.Item>
              </Col>
            </Row>
          )}

          <Form.Item name="reason" label="Reason / Notes" rules={[{ required: true, message: 'Provide a reason' }]}>
            <Input.TextArea rows={3} placeholder="Reason for this movement" />
          </Form.Item>
        </Form>
      </Modal>

      {/* Barcode Scanner Modal */}
      <Modal
        title="Scan Asset Barcode"
        open={scannerModal}
        onCancel={() => setScannerModal(false)}
        footer={null}
        width={500}
        destroyOnHidden
      >
        <BarcodeScanner onScan={handleScan} placeholder="Scan or enter asset barcode..." />
      </Modal>

      {/* Timeline Modal */}
      <Modal
        title={`Movement History${timelineAsset ? ` - ${timelineAsset.asset_code || timelineAsset.asset_name || ''}` : ''}`}
        open={timelineModal}
        onCancel={() => { setTimelineModal(false); setTimelineAsset(null); setTimelineData([]); }}
        footer={[
          <Button key="close" onClick={() => { setTimelineModal(false); setTimelineAsset(null); }}>Close</Button>,
        ]}
        width={600}
        destroyOnHidden
      >
        <Spin spinning={timelineLoading}>
          {timelineData.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#999', padding: 40 }}>No movement history for this asset</div>
          ) : (
            <Timeline
              style={{ marginTop: 24 }}
              items={timelineData.map((m) => ({
                color: MOVEMENT_COLORS[m.movement_type] || 'gray',
                children: (
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                      <Tag color={MOVEMENT_COLORS[m.movement_type] || 'default'}>
                        {m.movement_type ? m.movement_type.charAt(0).toUpperCase() + m.movement_type.slice(1) : 'Unknown'}
                      </Tag>
                      <span style={{ fontSize: 12, color: '#999', marginLeft: 8 }}>{formatDate(m.movement_date || m.created_at)}</span>
                    </div>
                    {m.from_location && <div style={{ fontSize: 13 }}>From: <strong>{m.from_location}</strong></div>}
                    {m.to_location && <div style={{ fontSize: 13 }}>To: <strong>{m.to_location}</strong></div>}
                    {m.from_user_name && <div style={{ fontSize: 13 }}>From User: {m.from_user_name}</div>}
                    {m.to_user_name && <div style={{ fontSize: 13 }}>To User: {m.to_user_name}</div>}
                    {m.reason && <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>Reason: {m.reason}</div>}
                  </div>
                ),
              }))}
            />
          )}
        </Spin>
      </Modal>
    </div>
  );
};

export default AssetMovement;

