import React, { useState, useEffect } from 'react';
import {
  Button, Select, Space, Card, Row, Col, message, Descriptions, Divider,
  Form, Input, InputNumber, Table, Typography, Tag, Spin, Empty, Tooltip,
  Upload, Modal, Image, List, Checkbox, Progress
} from 'antd';
import {
  ArrowLeftOutlined, CheckCircleOutlined, IdcardOutlined, CameraOutlined,
  DeleteOutlined, PlusOutlined, SearchOutlined, EyeOutlined, PictureOutlined,
  InboxOutlined
} from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { formatDate, formatDateTime, formatNumber, getErrorMessage, exportDetailsToExcel, printDetailsToPDF } from '../../utils/helpers';
import useAuthStore from '../../store/authStore';

const { Text, Title } = Typography;
const { TextArea } = Input;
const { Dragger } = Upload;

const MaterialAcknowledgementForm = ({ isViewOnly = false }) => {
  const navigate = useNavigate();
  const { id } = useParams();
  const { user } = useAuthStore();
  const [form] = Form.useForm();

  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingIssues, setPendingIssues] = useState([]);
  const [selectedIssueId, setSelectedIssueId] = useState(null);
  const [issueDetail, setIssueDetail] = useState(null);
  const [ackItems, setAckItems] = useState([]);
  const [detailRecord, setDetailRecord] = useState(null);

  // Photos & Upload state
  const [overallPhotos, setOverallPhotos] = useState([]);
  
  // Serial Selection Modal state
  const [serialModalVisible, setSerialModalVisible] = useState(false);
  const [activeItemIndex, setActiveItemIndex] = useState(null);
  const [serialSearchText, setSerialSearchText] = useState('');
  const [tempSelectedSerials, setTempSelectedSerials] = useState([]);

  useEffect(() => {
    if (isViewOnly && id) {
      loadDetailRecord();
    } else {
      fetchPendingIssues();
      if (user?.employee_code) {
        form.setFieldsValue({ employee_code: user.employee_code });
      }
    }
  }, [id, isViewOnly]);

  const loadDetailRecord = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/indent/material-acknowledgements/${id}`);
      setDetailRecord(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/indent/material-acknowledgement');
    } finally {
      setLoading(false);
    }
  };

  const fetchPendingIssues = async () => {
    try {
      const res = await api.get('/warehouse/vehicle-issues', { params: { page_size: 100, status: 'issued' } });
      const data = res.data?.items || res.data || [];
      setPendingIssues(data.map((i) => ({
        label: `${i.issue_number} - Vehicle ${i.vehicle_code} (${i.vehicle_number})`,
        value: i.id,
        record: i,
      })));
    } catch {
      // silent
    }
  };

  const handleIssueSelect = async (issueId) => {
    setSelectedIssueId(issueId);
    if (!issueId) {
      setIssueDetail(null);
      setAckItems([]);
      return;
    }
    setLoading(true);
    try {
      const res = await api.get(`/warehouse/vehicle-issues/${issueId}`);
      const data = res.data;
      setIssueDetail(data);

      const items = (data.items || []).map((item) => {
        const approved = Number(item.qty || 0);
        return {
          ...item,
          remaining_qty: approved,
          received_qty: approved,
          selected_serial_numbers: item.serial_numbers || [],
          remarks: '',
          photos: [], // item-wise uploaded photos
        };
      });
      setAckItems(items);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // Generic Photo upload handler
  const handleUploadPhoto = async ({ file, onSuccess, onError, isItemWise, itemIndex }) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await api.post('/indent/upload-photo', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
      const url = res.data.url;
      onSuccess({ url });

      if (isItemWise) {
        setAckItems((prev) =>
          prev.map((item, idx) => {
            if (idx === itemIndex) {
              const currentPhotos = item.photos || [];
              return { ...item, photos: [...currentPhotos, url] };
            }
            return item;
          })
        );
      } else {
        setOverallPhotos((prev) => [
          ...prev,
          { uid: file.uid, name: file.name, status: 'done', url }
        ]);
      }
      message.success(`${file.name} uploaded successfully`);
    } catch (err) {
      onError(err);
      message.error(getErrorMessage(err));
    }
  };

  const handleRemoveOverallPhoto = (file) => {
    setOverallPhotos((prev) => prev.filter((p) => p.uid !== file.uid));
  };

  const handleRemoveItemPhoto = (itemIndex, photoUrl) => {
    setAckItems((prev) =>
      prev.map((item, idx) => {
        if (idx === itemIndex) {
          const currentPhotos = item.photos || [];
          return { ...item, photos: currentPhotos.filter((p) => p !== photoUrl) };
        }
        return item;
      })
    );
  };

  // Serial Selection Modal handlers
  const openSerialModal = (index) => {
    const item = ackItems[index];
    setActiveItemIndex(index);
    setTempSelectedSerials(item.selected_serial_numbers || []);
    setSerialSearchText('');
    setSerialModalVisible(true);
  };

  const applySerialSelection = () => {
    if (activeItemIndex === null) return;
    const item = ackItems[activeItemIndex];
    if (tempSelectedSerials.length > item.qty) {
      message.error(`You cannot select more than the issued quantity of ${item.qty}`);
      return;
    }
    setAckItems((prev) =>
      prev.map((it, i) => {
        if (i === activeItemIndex) {
          return {
            ...it,
            selected_serial_numbers: tempSelectedSerials,
            received_qty: tempSelectedSerials.length,
          };
        }
        return it;
      })
    );
    setSerialModalVisible(false);
    setActiveItemIndex(null);
  };

  const handleToggleSerial = (serial, checked) => {
    const item = ackItems[activeItemIndex];
    if (checked) {
      if (tempSelectedSerials.length >= item.qty) {
        message.warning(`Limit reached. Maximum selectable serials: ${item.qty}`);
        return;
      }
      setTempSelectedSerials((prev) => [...prev, serial]);
    } else {
      setTempSelectedSerials((prev) => prev.filter((s) => s !== serial));
    }
  };

  const handleSelectAllSerials = () => {
    const item = ackItems[activeItemIndex];
    const available = item.serial_numbers || [];
    const toSelect = available.slice(0, Number(item.qty));
    setTempSelectedSerials(toSelect);
  };

  const handleSubmitAck = async () => {
    try {
      const values = await form.validateFields();
      const validItems = ackItems.filter((item) => item.received_qty > 0);
      if (validItems.length === 0) {
        message.error('Please enter received quantity for at least one item');
        return;
      }

      // Check serial selections match received quantities
      for (const item of validItems) {
        const isSerialOrAsset = item.has_serial || item.item_type === 'asset' || item.item_type === 'consumable';
        if (isSerialOrAsset && item.serial_numbers && item.serial_numbers.length > 0) {
          const selectedCount = (item.selected_serial_numbers || []).length;
          if (selectedCount === 0) {
            message.error(`Please select serial numbers for item ${item.item_code}`);
            return;
          }
        }
      }

      setSubmitting(true);
      const payload = {
        vehicle_issue_id: selectedIssueId,
        employee_code: values.employee_code || null,
        remarks: values.remarks || '',
        photos: overallPhotos.map((p) => p.url),
        items: validItems.map((item) => ({
          item_id: item.item_id,
          received_qty: item.received_qty,
          remarks: item.remarks || '',
          serial_numbers: (item.has_serial || item.item_type === 'asset' || item.item_type === 'consumable')
            ? (item.selected_serial_numbers || [])
            : null,
          photos: item.photos || [],
        })),
      };
      await api.post('/indent/material-acknowledgements', payload);
      message.success('Vehicle material acknowledged successfully');
      navigate('/indent/material-acknowledgement');
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Card style={{ textAlign: 'center', padding: '100px 0', border: 'none', background: 'transparent' }}>
        <Spin size="large" tip="Loading vehicle receipt..." />
      </Card>
    );
  }

  // --- View Only Detail Mode ---
  if (isViewOnly && detailRecord) {
    const items = detailRecord.items || [];
    return (
      <div style={{ padding: '24px', maxWidth: 1200, margin: '0 auto' }}>
        <PageHeader
          title={`Acknowledgement: ${detailRecord.acknowledgement_number}`}
          subtitle="Receipt details of vehicle material issue"
          style={{ paddingBottom: 16 }}
        >
          <Space>
            <Button
              type="default"
              style={{ borderColor: '#52c41a', color: '#52c41a', fontWeight: 600 }}
              onClick={() => exportDetailsToExcel(detailRecord, 'material_acknowledgement')}
            >
              Export Excel
            </Button>
            <Button
              type="primary"
              style={{ background: '#1890ff', borderColor: '#1890ff', fontWeight: 600 }}
              onClick={() => printDetailsToPDF(detailRecord, 'material_acknowledgement')}
            >
              Print PDF
            </Button>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/indent/material-acknowledgement')}>
              Back
            </Button>
          </Space>
        </PageHeader>
        
        <Card bordered={false} style={{ borderRadius: 12, boxShadow: '0 4px 20px rgba(0, 0, 0, 0.05)' }}>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }} labelStyle={{ fontWeight: 600, background: '#fafafa' }}>
            <Descriptions.Item label="Ack Number">{detailRecord.acknowledgement_number}</Descriptions.Item>
            <Descriptions.Item label="Vehicle Issue #">{detailRecord.vehicle_issue_number || '-'}</Descriptions.Item>
            <Descriptions.Item label="Vehicle Code">{detailRecord.vehicle_code || '-'}</Descriptions.Item>
            <Descriptions.Item label="Vehicle Number">{detailRecord.vehicle_number || '-'}</Descriptions.Item>
            <Descriptions.Item label="Employee Code">
              {detailRecord.employee_code ? (
                <Tag color="purple" style={{ fontFamily: 'monospace', fontWeight: 600 }}>{detailRecord.employee_code}</Tag>
              ) : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Acknowledged By">{detailRecord.acknowledged_by_name || '-'}</Descriptions.Item>
            <Descriptions.Item label="Acknowledged At">{formatDateTime(detailRecord.acknowledged_at)}</Descriptions.Item>
            <Descriptions.Item label="Overall Remarks" span={2}>{detailRecord.remarks || '-'}</Descriptions.Item>
            
            {/* Overall photos rendering */}
            {detailRecord.photos && detailRecord.photos.length > 0 && (
              <Descriptions.Item label="Acknowledgement Photos" span={3}>
                <Space wrap size={12}>
                  <Image.PreviewGroup>
                    {detailRecord.photos.map((url, i) => (
                      <div key={i} style={{ border: '2px solid #f0f0f0', borderRadius: 8, padding: 2, background: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
                        <Image
                          src={url}
                          width={90}
                          height={90}
                          style={{ objectFit: 'cover', borderRadius: 6, cursor: 'zoom-in' }}
                        />
                      </div>
                    ))}
                  </Image.PreviewGroup>
                </Space>
              </Descriptions.Item>
            )}
          </Descriptions>

          <Divider orientation="left" style={{ margin: '24px 0 16px 0' }}><Text strong style={{ fontSize: 16 }}>Received Items</Text></Divider>
          
          <Table
            dataSource={items}
            rowKey="id"
            size="middle"
            pagination={false}
            columns={[
              { title: '#', width: 50, render: (_, __, idx) => idx + 1 },
              { title: 'Item Code', dataIndex: 'item_code', key: 'code', render: (text) => <Text style={{ fontFamily: 'monospace', fontWeight: 500 }}>{text}</Text> },
              { title: 'Item Name', dataIndex: 'item_name', key: 'name', render: (text) => <Text style={{ fontWeight: 500 }}>{text}</Text> },
              { title: 'UOM', dataIndex: 'uom', key: 'uom', render: (v) => v || '-' },
              {
                title: 'Received Qty',
                dataIndex: 'received_qty',
                key: 'rq',
                align: 'right',
                render: (v) => <Text strong style={{ color: '#52c41a', fontSize: 15 }}>{formatNumber(v)}</Text>
              },
              {
                title: 'Serial / Asset Codes',
                dataIndex: 'serial_numbers',
                key: 'serial_numbers',
                render: (serials, record) => {
                  if (!serials || serials.length === 0) return '-';
                  const matCode = record.item_code || '';
                  const prefix = matCode ? `${matCode}-1-` : '';
                  const parsed = serials.map(s => s.startsWith(prefix) ? s : `${prefix}${s}`);
                  return (
                    <Tooltip title={parsed.join(', ')}>
                      <div style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {parsed.map(s => <Tag key={s} color="blue" style={{ fontFamily: 'monospace' }}>{s}</Tag>)}
                      </div>
                    </Tooltip>
                  );
                }
              },
              {
                title: 'Photos',
                dataIndex: 'photos',
                key: 'photos',
                render: (photos) => {
                  if (!photos || photos.length === 0) return <Text type="secondary">No photos</Text>;
                  return (
                    <Image.PreviewGroup>
                      <Space wrap size={4}>
                        {photos.map((url, i) => (
                          <div key={i} style={{ border: '1px solid #e2e8f0', borderRadius: 4, padding: 1, background: '#fff' }}>
                            <Image
                              src={url}
                              width={40}
                              height={40}
                              style={{ objectFit: 'cover', borderRadius: 3, cursor: 'zoom-in' }}
                            />
                          </div>
                        ))}
                      </Space>
                    </Image.PreviewGroup>
                  );
                }
              },
              { title: 'Remarks', dataIndex: 'remarks', key: 'rem', render: (v) => v || '-' },
            ]}
          />
        </Card>
      </div>
    );
  }

  // --- Create Mode ---
  const activeItem = activeItemIndex !== null ? ackItems[activeItemIndex] : null;
  const itemCode = activeItem?.item_code || '';
  const prefix = itemCode ? `${itemCode}-1-` : '';
  const filteredSerials = activeItem
    ? (activeItem.serial_numbers || []).filter(s => {
        const fullCode = s.startsWith(prefix) ? s : `${prefix}${s}`;
        return fullCode.toLowerCase().includes(serialSearchText.toLowerCase());
      })
    : [];

  return (
    <div style={{ padding: '24px', maxWidth: 1200, margin: '0 auto' }}>
      <PageHeader
        title="Acknowledge Vehicle Material Issue"
        subtitle="Acknowledge receipt of materials issued to a vehicle"
        onBack={() => navigate('/indent/material-acknowledgement')}
      >
        <Space>
          <Button
            type="primary"
            icon={<CheckCircleOutlined />}
            onClick={handleSubmitAck}
            loading={submitting}
            disabled={!selectedIssueId}
            style={{ borderRadius: 8, height: 40, fontWeight: 600, background: '#d91b5c', borderColor: '#d91b5c' }}
          >
            Confirm Acknowledgement
          </Button>
        </Space>
      </PageHeader>

      <Card bordered={false} style={{ borderRadius: 12, boxShadow: '0 4px 20px rgba(0, 0, 0, 0.05)', marginBottom: 24 }}>
        <Form form={form} layout="vertical">
          <Row gutter={24}>
            <Col xs={24} md={16}>
              <Form.Item label={<Text strong>Select Vehicle Issue</Text>} required>
                <Select
                  placeholder="Select pending vehicle issue..."
                  value={selectedIssueId}
                  onChange={handleIssueSelect}
                  options={pendingIssues}
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  style={{ width: '100%', height: 40 }}
                  size="large"
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item
                name="employee_code"
                label={<Text strong>Employee Code</Text>}
                rules={[{ required: true, message: 'Employee code is required' }]}
              >
                <Input
                  placeholder="e.g. EMP-0042"
                  prefix={<IdcardOutlined style={{ color: '#94a3b8' }} />}
                  style={{ fontWeight: 600, height: 40 }}
                  size="large"
                />
              </Form.Item>
            </Col>
          </Row>
        </Form>

        {issueDetail ? (
          <>
            <Card size="small" style={{ marginBottom: 24, borderRadius: 8, background: '#f8fafc', border: '1px solid #f1f5f9' }}>
              <Descriptions size="small" column={{ xs: 1, sm: 2, md: 3 }}>
                <Descriptions.Item label={<Text type="secondary">Issue #</Text>}><Text strong>{issueDetail.issue_number}</Text></Descriptions.Item>
                <Descriptions.Item label={<Text type="secondary">Source Warehouse</Text>}><Text strong>{issueDetail.warehouse_name || '-'}</Text></Descriptions.Item>
                <Descriptions.Item label={<Text type="secondary">Vehicle Code</Text>}><Text strong>{issueDetail.vehicle_code}</Text></Descriptions.Item>
                <Descriptions.Item label={<Text type="secondary">Vehicle Number</Text>}><Text strong>{issueDetail.vehicle_number}</Text></Descriptions.Item>
                <Descriptions.Item label={<Text type="secondary">Issue Date</Text>}><Text strong>{formatDate(issueDetail.issue_date)}</Text></Descriptions.Item>
              </Descriptions>
            </Card>

            <Divider orientation="left" style={{ margin: '24px 0 16px 0' }}><Text strong style={{ fontSize: 16 }}>Received Items</Text></Divider>
            <Table
              dataSource={ackItems}
              rowKey="id"
              size="middle"
              pagination={false}
              columns={[
                { title: '#', width: 50, render: (_, __, idx) => idx + 1 },
                { title: 'Item Code', dataIndex: 'item_code', key: 'code', render: (text) => <Text style={{ fontFamily: 'monospace', fontWeight: 500 }}>{text}</Text> },
                { title: 'Item Name', dataIndex: 'item_name', key: 'name', render: (text) => <Text style={{ fontWeight: 500 }}>{text}</Text> },
                { title: 'UOM', dataIndex: 'uom_name', key: 'uom', render: (v) => v || '-' },
                { title: 'Issued Qty', dataIndex: 'qty', key: 'issued', align: 'right', render: (v) => formatNumber(v) },
                {
                  title: 'Receive Now & Serials',
                  dataIndex: 'received_qty',
                  width: 320,
                  render: (val, record, idx) => {
                    const isSerialOrAsset = record.has_serial || record.item_type === 'asset' || record.item_type === 'consumable';
                    if (isSerialOrAsset && record.serial_numbers && record.serial_numbers.length > 0) {
                      const selectedCount = (record.selected_serial_numbers || []).length;
                      return (
                        <Space direction="vertical" style={{ width: '100%' }} size={4}>
                          <Button
                            type="dashed"
                            icon={<IdcardOutlined />}
                            onClick={() => openSerialModal(idx)}
                            block
                            style={{ 
                              display: 'flex', 
                              alignItems: 'center', 
                              justifyContent: 'center', 
                              borderColor: selectedCount > 0 ? '#52c41a' : '#d9d9d9',
                              color: selectedCount > 0 ? '#52c41a' : 'inherit',
                              fontWeight: selectedCount > 0 ? 600 : 'normal'
                            }}
                          >
                            {selectedCount > 0 
                              ? `Selected Serials (${selectedCount} / ${record.qty})` 
                              : `Select Serials / Codes (Max: ${record.qty})`}
                          </Button>
                          {selectedCount > 0 && (
                            <div style={{ maxWidth: 280, display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                              {record.selected_serial_numbers.slice(0, 3).map(s => {
                                const matCode = record.item_code || '';
                                const prefix = matCode ? `${matCode}-1-` : '';
                                const display = s.startsWith(prefix) ? s : `${prefix}${s}`;
                                return (
                                  <Tag key={s} color="success" style={{ fontSize: 10, margin: 0, fontFamily: 'monospace' }}>{display}</Tag>
                                );
                              })}
                              {selectedCount > 3 && (
                                <Tag color="default" style={{ fontSize: 10, margin: 0 }}>+{selectedCount - 3} more</Tag>
                              )}
                            </div>
                          )}
                        </Space>
                      );
                    }
                    return (
                      <InputNumber
                        min={0}
                        max={record.qty}
                        value={val}
                        onChange={(v) => {
                          setAckItems((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, received_qty: v } : item))
                          );
                        }}
                        style={{ width: '100%', height: 36 }}
                      />
                    );
                  },
                },
                {
                  title: 'Upload Photos',
                  dataIndex: 'photos',
                  width: 200,
                  render: (val, record, idx) => {
                    const fileList = (record.photos || []).map((url, i) => ({
                      uid: `item-${idx}-${i}`,
                      name: `photo-${i}.jpg`,
                      status: 'done',
                      url,
                    }));
                    
                    return (
                      <Space wrap size={4}>
                        <Upload
                          customRequest={(options) => handleUploadPhoto({ ...options, isItemWise: true, itemIndex: idx })}
                          showUploadList={false}
                          accept="image/*"
                        >
                          <Button size="small" icon={<CameraOutlined />} type="dashed">
                            Add Photo
                          </Button>
                        </Upload>
                        <Image.PreviewGroup>
                          <Space wrap size={2}>
                            {(record.photos || []).map((url, i) => (
                              <div key={url} style={{ position: 'relative', display: 'inline-block' }}>
                                <Image
                                  src={url}
                                  width={32}
                                  height={32}
                                  style={{ objectFit: 'cover', borderRadius: 4, border: '1px solid #e2e8f0' }}
                                />
                                <Button
                                  type="primary"
                                  danger
                                  shape="circle"
                                  icon={<DeleteOutlined style={{ fontSize: 8 }} />}
                                  size="small"
                                  onClick={() => handleRemoveItemPhoto(idx, url)}
                                  style={{
                                    position: 'absolute',
                                    top: -4,
                                    right: -4,
                                    width: 14,
                                    height: 14,
                                    minWidth: 14,
                                    padding: 0,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center'
                                  }}
                                />
                              </div>
                            ))}
                          </Space>
                        </Image.PreviewGroup>
                      </Space>
                    );
                  }
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
                      placeholder="Item remarks"
                      style={{ height: 36 }}
                    />
                  ),
                },
              ]}
            />

            {/* Overall upload and remarks */}
            <Row gutter={24} style={{ marginTop: 24 }}>
              <Col xs={24} md={12}>
                <Form form={form} layout="vertical">
                  <Form.Item name="remarks" label={<Text strong>Overall Remarks</Text>}>
                    <TextArea rows={4} placeholder="Any general remarks about the receipt..." style={{ borderRadius: 8 }} />
                  </Form.Item>
                </Form>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item label={<Text strong>Upload Overall Proof / Photos</Text>}>
                  <Dragger
                    customRequest={(options) => handleUploadPhoto({ ...options, isItemWise: false })}
                    fileList={overallPhotos}
                    onRemove={handleRemoveOverallPhoto}
                    listType="picture"
                    accept="image/*"
                    style={{ borderRadius: 8, background: '#fafafa' }}
                  >
                    <p className="ant-upload-drag-icon" style={{ color: '#d91b5c', margin: '12px 0 4px 0' }}>
                      <InboxOutlined style={{ fontSize: 32 }} />
                    </p>
                    <p className="ant-upload-text" style={{ fontSize: 13, fontWeight: 500 }}>Click or drag images to this area to upload</p>
                    <p className="ant-upload-hint" style={{ fontSize: 11, color: '#94a3b8' }}>Support for receipt copy, vehicle photo, or handovers</p>
                  </Dragger>
                </Form.Item>
              </Col>
            </Row>
          </>
        ) : (
          <Empty 
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Text type="secondary" style={{ fontSize: 14 }}>
                Select a pending vehicle issue to acknowledge receipt of materials
              </Text>
            } 
            style={{ padding: '40px 0' }}
          />
        )}
      </Card>

      {/* --- Serial Selection Modal --- */}
      <Modal
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8 }}>
            <IdcardOutlined style={{ color: '#d91b5c', fontSize: 20 }} />
            <div>
              <Title level={5} style={{ margin: 0 }}>Select Serial Numbers / Asset Codes</Title>
              <Text type="secondary" style={{ fontSize: 12 }}>{activeItem?.item_name} ({activeItem?.item_code})</Text>
            </div>
          </div>
        }
        visible={serialModalVisible}
        onOk={applySerialSelection}
        onCancel={() => setSerialModalVisible(false)}
        width={550}
        okText="Apply Selection"
        okButtonProps={{ 
          style: { background: '#d91b5c', borderColor: '#d91b5c' },
          disabled: tempSelectedSerials.length === 0
        }}
        destroyOnClose
        style={{ top: 80 }}
        bodyStyle={{ padding: '16px 24px' }}
      >
        {activeItem && (
          <div>
            <Row gutter={16} align="middle" style={{ marginBottom: 16 }}>
              <Col span={14}>
                <Text type="secondary">Maximum Allowed (Issued): </Text>
                <Text strong>{activeItem.qty}</Text>
                <div style={{ marginTop: 4 }}>
                  <Text type="secondary">Currently Selected: </Text>
                  <Text strong style={{ color: tempSelectedSerials.length === Number(activeItem.qty) ? '#52c41a' : '#1890ff' }}>
                    {tempSelectedSerials.length}
                  </Text>
                </div>
              </Col>
              <Col span={10}>
                <Progress 
                  percent={Math.round((tempSelectedSerials.length / Number(activeItem.qty)) * 100)} 
                  size="small" 
                  status={tempSelectedSerials.length === Number(activeItem.qty) ? "success" : "active"}
                  strokeColor={tempSelectedSerials.length === Number(activeItem.qty) ? '#52c41a' : '#1890ff'}
                />
              </Col>
            </Row>

            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <Input
                placeholder="Search serial / asset code..."
                prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
                value={serialSearchText}
                onChange={(e) => setSerialSearchText(e.target.value)}
                allowClear
                style={{ flex: 1 }}
              />
              <Button type="dashed" onClick={handleSelectAllSerials} disabled={tempSelectedSerials.length === Number(activeItem.qty)}>
                Select All
              </Button>
              <Button type="text" onClick={() => setTempSelectedSerials([])} danger>
                Clear
              </Button>
            </div>

            <Card size="small" style={{ maxHeight: 280, overflowY: 'auto', borderRadius: 8, border: '1px solid #f0f0f0' }} bodyStyle={{ padding: 8 }}>
              {filteredSerials.length > 0 ? (
                <List
                  dataSource={filteredSerials}
                  renderItem={(serial) => {
                    const isChecked = tempSelectedSerials.includes(serial);
                    const displayLabel = serial.startsWith(prefix) ? serial : `${prefix}${serial}`;
                    return (
                      <List.Item style={{ padding: '6px 12px', borderBottom: '1px solid #f5f5f5' }}>
                        <Checkbox
                          checked={isChecked}
                          onChange={(e) => handleToggleSerial(serial, e.target.checked)}
                          style={{ width: '100%', fontFamily: 'monospace', fontWeight: isChecked ? 600 : 'normal' }}
                        >
                          {displayLabel}
                        </Checkbox>
                      </List.Item>
                    );
                  }}
                />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No serial numbers match your search" />
              )}
            </Card>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default MaterialAcknowledgementForm;
