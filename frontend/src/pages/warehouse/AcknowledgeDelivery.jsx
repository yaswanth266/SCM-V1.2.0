import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button, Form, Input, InputNumber, Select, Space, Card, Row, Col,
  Table, Divider, Typography, Tag, Spin, message, Upload
} from 'antd';
import {
  ArrowLeftOutlined, CheckCircleOutlined,
  UploadOutlined, WarningOutlined, SearchOutlined
} from '@ant-design/icons';
import api from '../../config/api';
import PageHeader from '../../components/PageHeader';
import SerialNumbersModal from '../../components/SerialNumbersModal';
import { getErrorMessage, formatNumber } from '../../utils/helpers';

const { TextArea } = Input;
const { Title, Text } = Typography;



const AcknowledgeDelivery = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryDispatchNo = searchParams.get('dispatchNo');
  
  const [form] = Form.useForm();
  
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  
  // SCM lookup states
  const [warehouses, setWarehouses] = useState([]);
  const [dispatches, setDispatches] = useState([]);
  
  // User operating choices
  const [selectedWarehouseId, setSelectedWarehouseId] = useState(null);
  const [selectedDispatchId, setSelectedDispatchId] = useState(null);
  
  // Active dispatch details
  const [dispatch, setDispatch] = useState(null);
  const [items, setItems] = useState([]);
  const [uploadedUrls, setUploadedUrls] = useState({});



  // Fetch initial masters list
  useEffect(() => {
    const fetchMasters = async () => {
      try {
        setLoading(true);
        const [warehouseRes, dispatchRes] = await Promise.all([
          api.get('/masters/warehouses', { params: { page_size: 200 } }),
          api.get('/warehouse/dispatch', { params: { page_size: 200 } })
        ]);
        
        const whsList = warehouseRes.data?.items || warehouseRes.data?.data || warehouseRes.data || [];
        setWarehouses(whsList);
        
        const dispList = dispatchRes.data?.items || dispatchRes.data?.data || dispatchRes.data || [];
        setDispatches(dispList);

        // Pre-select first operating warehouse if none selected
        if (whsList.length > 0) {
          setSelectedWarehouseId(whsList[0].id);
        }
      } catch (err) {
        message.error("Failed to load warehouses and dispatches master registries.");
      } finally {
        setLoading(false);
      }
    };
    fetchMasters();
  }, []);

  // Recurse function to resolve sub-warehouses
  const getDescendantWarehouseIds = (parentWhId, allWhs) => {
    const descendants = [];
    const recurse = (id) => {
      const children = allWhs.filter(w => w.parent_id === id);
      children.forEach(c => {
        descendants.push(c.id);
        recurse(c.id);
      });
    };
    recurse(parentWhId);
    return descendants;
  };

  // Filter available dispatches for operating warehouse based on parent relationship
  const filteredDispatches = dispatches.filter(d => {
    if (!selectedWarehouseId) return false;
    
    const opWh = warehouses.find(w => w.id === selectedWarehouseId);
    if (!opWh) return false;

    // Check if it is parent-less
    if (opWh.parent_id === null || !opWh.parent_id) {
      // Parent-less: see all dispatches, except those issued by itself
      return d.warehouse_id !== selectedWarehouseId;
    } else {
      // Child sub-warehouse: see only dispatches destined to itself or its descendants
      const descendants = getDescendantWarehouseIds(selectedWarehouseId, warehouses);
      const allowedIds = [selectedWarehouseId, ...descendants];
      return allowedIds.includes(d.destination_warehouse_id);
    }
  });

  // Handle URL Deep link matching on load
  useEffect(() => {
    if (dispatches.length > 0) {
      let targetId = null;
      if (id) {
        const found = dispatches.find(d => String(d.id) === String(id) || d.dispatch_id === id);
        if (found) targetId = found.id;
      } else if (queryDispatchNo) {
        const found = dispatches.find(d => d.dispatch_id === queryDispatchNo);
        if (found) targetId = found.id;
      }
      
      if (targetId) {
        setSelectedDispatchId(targetId);
        // Ensure the operating warehouse matches the destination warehouse
        const activeDisp = dispatches.find(d => d.id === targetId);
        if (activeDisp && activeDisp.destination_warehouse_id) {
          setSelectedWarehouseId(activeDisp.destination_warehouse_id);
        }
      }
    }
  }, [id, queryDispatchNo, dispatches]);

  // Load specific dispatch details on selection
  useEffect(() => {
    const fetchDispatchData = async () => {
      if (!selectedDispatchId) {
        setDispatch(null);
        setItems([]);
        return;
      }
      setLoading(true);
      try {
        const res = await api.get(`/warehouse/dispatch/${selectedDispatchId}`);
        const data = res.data;
        setDispatch(data);
        
        // Map the dispatch items — carry serial numbers from dispatch
        const initialItems = (data.items || []).map((it, idx) => ({
          key: it.id || idx,
          id: it.id,
          material_id: it.material_id,
          material_name: it.material_name || `Item ${it.material_id}`,
          material_code: it.material_code || `CODE-${it.material_id}`,
          quantity_dispatched: Number(it.dispatched_quantity || 0),
          quantity_received: Number(it.dispatched_quantity || 0),
          uom: it.uom || 'Nos',
          serial_numbers: it.serial_numbers || [],
          has_serial: !!(it.has_serial || (it.serial_numbers && it.serial_numbers.length > 0)),
          remarks: ''
        }));
        
        setItems(initialItems);
        
        // Pre-fill some defaults
        form.setFieldsValue({
          acknowledged_by_name: '',
          acknowledged_by_phone: '',
          receiver_id_proof_type: 'NONE',
          receiver_signature_url: undefined
        });
        setUploadedUrls({});
      } catch (err) {
        message.error('Failed to load dispatch details: ' + getErrorMessage(err));
      } finally {
        setLoading(false);
      }
    };
    fetchDispatchData();
  }, [selectedDispatchId, form]);

  const handleUploadFile = async (file, fieldKey) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('entity_type', 'general');
    try {
      const response = await api.post('/attachments/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      const data = response.data;
      const uploadedUrl = data.url || data.file_path || '';
      setUploadedUrls((prev) => ({ ...prev, [fieldKey]: uploadedUrl }));
      form.setFieldsValue({ [fieldKey]: uploadedUrl });
      message.success(`${file.name} uploaded successfully.`);
      return uploadedUrl;
    } catch (error) {
      console.error(error);
      message.error(`${file.name} upload failed.`);
      throw error;
    }
  };



  const handleReceivedQtyChange = (key, val) => {
    setItems(prev => prev.map(it => it.key === key ? { ...it, quantity_received: val } : it));
  };

  const handleRemarksChange = (key, val) => {
    setItems(prev => prev.map(it => it.key === key ? { ...it, remarks: val } : it));
  };

  const handleSerialNumbersChange = (key, serials) => {
    setItems(prev => prev.map(it => it.key === key ? { ...it, serial_numbers: serials } : it));
  };

  const handleSubmit = async () => {
    if (!dispatch) {
      message.warning("Please select a valid dispatch order to acknowledge.");
      return;
    }
    
    try {
      const values = await form.validateFields();
      
      const signatureUrl = uploadedUrls.signature_image;
      if (!signatureUrl) {
        message.error('Signature image proof is mandatory!');
        return;
      }

      // Validate that selected serials match quantity_received if has_serial is true
      for (const item of items) {
        if (item.has_serial) {
          const serialCount = (item.serial_numbers || []).length;
          if (serialCount !== Math.round(item.quantity_received)) {
            message.error(`Please select exactly ${Math.round(item.quantity_received)} serial number(s) for ${item.material_name} (currently selected: ${serialCount})`);
            return;
          }
        }
      }

      setSubmitting(true);
      
      const payload = {
        acknowledgement_type: items.some(it => it.quantity_received < it.quantity_dispatched) ? 'PARTIAL_DELIVERY' : 'FULL_DELIVERY',
        acknowledged_by_name: values.acknowledged_by_name || 'Receiver Rep',
        acknowledged_by_designation: values.acknowledged_by_designation || 'Warehouse operator',
        acknowledged_by_department: values.acknowledged_by_department || 'SCM',
        acknowledged_by_phone: values.acknowledged_by_phone || '9998880000',
        acknowledged_by_email: values.acknowledged_by_email || 'rep@bhspl.com',
        acknowledged_by_employee_code: values.acknowledged_by_employee_code || 'EMP-ACK',
        destination_warehouse_id: dispatch.destination_warehouse_id,
        destination_user_id: dispatch.destination_user_id,
        actual_delivery_location: values.actual_delivery_location || '',
        verification_method: 'DIGITAL_SIGNATURE',
        receiver_signature_url: signatureUrl,
        receiver_signature_captured_via: 'FILE_UPLOAD',
        receiver_id_proof_type: values.receiver_id_proof_type || 'NONE',
        receiver_id_proof_number: values.receiver_id_proof_number || '',
        receiver_id_proof_document_url: '',
        delivery_photos: uploadedUrls.materials_photos ? { photo: uploadedUrls.materials_photos, review: values.photo_review || '' } : {},
        delivery_latitude: null,
        delivery_longitude: null,
        geo_fence_verified: false,
        device_id: 'BROWSER_CLIENT',
        ip_address: '127.0.0.1',
        total_items_expected: items.reduce((acc, it) => acc + it.quantity_dispatched, 0),
        total_items_received: items.reduce((acc, it) => acc + it.quantity_received, 0),
        total_items_damaged: 0,
        total_items_rejected: 0,
        goods_condition: 'GOOD',
        quality_check_performed: true,
        quality_checked_by: values.acknowledged_by_name || 'Receiver Rep',
        quality_check_remarks: values.quality_check_remarks || 'Standard visual checkout completed.',
        packaging_condition: 'INTACT',
        seal_intact: true,
        seal_number_verified: '',
        temperature_recorded: null,
        humidity_recorded: null,
        discrepancy_reported: items.some(it => it.quantity_received < it.quantity_dispatched),
        discrepancy_type: items.some(it => it.quantity_received < it.quantity_dispatched) ? 'QUANTITY_MISMATCH' : null,
        discrepancy_description: values.discrepancy_description || '',
        items: items.map(item => ({
          dispatch_item_id: item.id,
          material_id: item.material_id,
          batch_number: item.batch_number || null,
          serial_numbers: (item.serial_numbers || []).filter(s => s && s.trim()),
          quantity_dispatched: item.quantity_dispatched,
          quantity_received: item.quantity_received,
          quantity_accepted: item.quantity_received,
          quantity_rejected: Math.max(0, item.quantity_dispatched - item.quantity_received),
          quantity_damaged: 0,
          // DB ENUM: GOOD | DAMAGED | EXPIRED | DEFECTIVE | WRONG_ITEM  ('PARTIAL' is NOT valid)
          unit_of_measure: item.uom || item.uom_name || 'Pcs',
          item_condition: item.quantity_received >= item.quantity_dispatched ? 'GOOD' : 'DAMAGED',
          rejection_reason: item.quantity_received < item.quantity_dispatched ? 'Short quantity received' : null,
          damage_description: null,
          item_photo_urls: [],
          remarks: item.remarks || null,
        }))
      };

      const response = await api.post(`/outbound/dispatch/${dispatch.id}/acknowledge`, payload);
      message.success(response.data.message || 'Delivery Acknowledged Successfully!');
      navigate('/logistics/dispatch');
    } catch (err) {
      if (err.errorFields) return;
      message.error('Failed to acknowledge delivery: ' + getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const columns = [
    {
      title: 'Material Name',
      key: 'material',
      render: (_, r) => (
        <div>
          <Text strong style={{ color: '#0f172a' }}>{r.material_name}</Text>
          {r.material_code && (
            <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '8px', fontFamily: 'monospace' }}>
              ({r.material_code})
            </span>
          )}
        </div>
      )
    },
    {
      title: 'Dispatched Qty',
      dataIndex: 'quantity_dispatched',
      key: 'quantity_dispatched',
      width: 140,
      render: (val, r) => <span style={{ fontWeight: 600, color: '#475569' }}>{val} {r.uom}</span>
    },
    {
      title: 'Received Qty',
      key: 'quantity_received',
      width: 160,
      render: (_, r) => (
        <InputNumber
          min={0}
          max={r.quantity_dispatched}
          value={r.quantity_received}
          onChange={(val) => handleReceivedQtyChange(r.key, val)}
          style={{ width: '100%' }}
        />
      )
    },
    {
      title: 'Serial Numbers',
      key: 'serial_numbers',
      width: 150,
      render: (_, r) => {
        // Find the original dispatch item to get the complete list of dispatched serials
        const origItem = dispatch?.items?.find(item => item.id === r.id);
        const dispatchedSerials = origItem?.serial_numbers || [];

        return (
          <SerialNumbersModal
            value={r.serial_numbers || []}
            onChange={(updated) => handleSerialNumbersChange(r.key, updated)}
            itemName={r.material_name}
            itemCode={r.material_code}
            quantity={Math.round(Number(r.quantity_received || 0))}
            hasSerial={r.has_serial || (dispatchedSerials && dispatchedSerials.length > 0)}
            size="small"
            mode="select"
            availableSerials={dispatchedSerials}
          />
        );
      }
    },
    {
      title: 'Remarks',
      key: 'remarks',
      render: (_, r) => (
        <Input
          placeholder="Enter item condition or short notes..."
          value={r.remarks}
          onChange={(e) => handleRemarksChange(r.key, e.target.value)}
          style={{ width: '100%' }}
        />
      )
    }
  ];

  return (
    <div style={{ padding: '28px', background: 'radial-gradient(ellipse at top, #f8fafc 0%, #f1f5f9 80%)', minHeight: '100vh', color: '#334155' }}>
      <PageHeader 
        title="Delivery Acknowledgement & Touch-Signature POD Portal" 
        subtitle="Verify outbound dispatch shipments, check quantities, draw signatures and submit digital POD proofs."
      >
        <Space>
          <Button onClick={() => navigate('/logistics/dispatch')} icon={<ArrowLeftOutlined />}>
            Back to Plans
          </Button>
          <Button 
            type="primary" 
            icon={<CheckCircleOutlined />} 
            loading={submitting} 
            onClick={handleSubmit}
            style={{ background: 'linear-gradient(135deg, #4f46e5 0%, #3730a3 100%)', borderColor: 'transparent', fontWeight: 'bold' }}
          >
            Acknowledge Dispatch
          </Button>
        </Space>
      </PageHeader>

      <Row gutter={[20, 20]}>
        {/* Step 1: Operating Location & Dispatch Search */}
        <Col span={24}>
          <Card 
            title={<span style={{ color: '#0f172a', fontWeight: 800 }}>1. Search SCM Outbound Dispatch</span>}
            size="small"
            style={{ borderRadius: '12px', border: '1px solid #cbd5e1', boxShadow: '0 4px 12px rgba(0,0,0,0.03)' }}
          >
            <Row gutter={24}>
              <Col xs={24} md={12}>
                <Form.Item label={<span style={{ color: '#475569', fontWeight: 600 }}>Operating Warehouse</span>} style={{ marginBottom: 0 }}>
                  <Select
                    showSearch
                    placeholder="Select operating warehouse location..."
                    value={selectedWarehouseId}
                    onChange={(val) => {
                      setSelectedWarehouseId(val);
                      setSelectedDispatchId(null);
                    }}
                    options={warehouses.map(w => ({ label: `${w.name} (${w.code})`, value: w.id }))}
                    style={{ width: '100%' }}
                    filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
                  />
                </Form.Item>
              </Col>
              
              <Col xs={24} md={12}>
                <Form.Item label={<span style={{ color: '#4f46e5', fontWeight: 600 }}>Select Dispatch Number</span>} style={{ marginBottom: 0 }}>
                  <Select
                    showSearch
                    placeholder="Search by Dispatch No..."
                    value={selectedDispatchId}
                    onChange={(val) => setSelectedDispatchId(val)}
                    options={filteredDispatches.map(d => ({ 
                      label: `${d.dispatch_id} (To: ${d.destination_warehouse_name || d.destination_user_name || 'Client Drop'})`, 
                      value: d.id 
                    }))}
                    style={{ width: '100%' }}
                    filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
                  />
                </Form.Item>
              </Col>
            </Row>
          </Card>
        </Col>

        {dispatch ? (
          <>
            {/* Step 2: Dispatch Shipment details */}
            <Col span={24}>
              <Card 
                title={<span style={{ color: '#0f172a', fontWeight: 800 }}>2. Shipment Manifest Summary</span>}
                size="small"
                style={{ borderRadius: '12px', border: '1px solid #cbd5e1', boxShadow: '0 4px 12px rgba(0,0,0,0.03)' }}
              >
                <Row gutter={[24, 12]} style={{ fontSize: '13px' }}>
                  <Col xs={12} md={6}>
                    <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Dispatch Number</Text>
                    <strong style={{ color: '#0f172a', fontSize: '14px', fontFamily: 'monospace' }}>{dispatch.dispatch_id}</strong>
                  </Col>
                  <Col xs={12} md={6}>
                    <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Recipient / Destination</Text>
                    <strong style={{ color: '#0f172a', fontSize: '14px' }}>
                      {dispatch.destination_warehouse_name || dispatch.destination_user_name || 'SCM drop site'}
                    </strong>
                  </Col>
                  <Col xs={12} md={6}>
                    <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Status</Text>
                    <div>
                      <Tag color="orange" style={{ fontWeight: 'bold' }}>{dispatch.status}</Tag>
                    </div>
                  </Col>
                  <Col xs={12} md={6}>
                    <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Dispatch Method</Text>
                    <div>
                      <Tag color="blue" style={{ fontWeight: 'bold' }}>{dispatch.dispatch_type || 'THIRD_PARTY'}</Tag>
                    </div>
                  </Col>
                </Row>
              </Card>
            </Col>

            {/* Step 3: Material Line Items Verification */}
            <Col span={24}>
              <Card 
                title={<span style={{ color: '#0f172a', fontWeight: 800 }}>3. Materials Receipt Check</span>}
                size="small"
                style={{ borderRadius: '12px', border: '1px solid #cbd5e1', boxShadow: '0 4px 12px rgba(0,0,0,0.03)' }}
              >
                <Table
                  dataSource={items}
                  columns={columns}
                  pagination={false}
                  bordered
                  className="logistics-dark-subtable"
                />
              </Card>
            </Col>

            {/* Step 4: Secure Digital POD Evidence */}
            <Col xs={24} md={12}>
              <Card 
                title={<span style={{ color: '#0f172a', fontWeight: 800 }}>4. Signatory Credentials</span>}
                size="small"
                style={{ borderRadius: '12px', border: '1px solid #cbd5e1', boxShadow: '0 4px 12px rgba(0,0,0,0.03)', height: '100%' }}
              >
                <Form form={form} layout="vertical">
                  <Row gutter={16}>
                    <Col span={12}>
                      <Form.Item 
                        name="acknowledged_by_name" 
                        label={<span style={{ fontWeight: 600 }}>Receiver Name</span>} 
                        rules={[{ required: true, message: 'Receiver name is required' }]}
                      >
                        <Input placeholder="E.g., Nilesh Patil" />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item 
                        name="acknowledged_by_phone" 
                        label={<span style={{ fontWeight: 600 }}>Contact Number</span>} 
                        rules={[{ required: true, message: 'Phone number is required' }]}
                      >
                        <Input placeholder="E.g., 9988001122" />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="acknowledged_by_designation" label="Designation">
                        <Input placeholder="E.g., Store In-Charge" />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="acknowledged_by_department" label="Department">
                        <Input placeholder="E.g., Warehouse Ops" />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="receiver_id_proof_type" label="ID Proof Type">
                        <Select>
                          <Select.Option value="NONE">None</Select.Option>
                          <Select.Option value="AADHAR">Aadhar Card</Select.Option>
                          <Select.Option value="PAN">PAN Card</Select.Option>
                          <Select.Option value="EMPLOYEE_ID">Employee ID Card</Select.Option>
                        </Select>
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="receiver_id_proof_number" label="ID Proof Number">
                        <Input placeholder="Enter ID characters" />
                      </Form.Item>
                    </Col>
                    <Col span={24}>
                      <Form.Item name="actual_delivery_location" label="Delivery Bin / drop-off Address">
                        <Input placeholder="E.g., Main Yard, Sector 4 Bin" />
                      </Form.Item>
                    </Col>
                  </Row>
                </Form>
              </Card>
            </Col>

            <Col xs={24} md={12}>
              <Card 
                title={<span style={{ color: '#0f172a', fontWeight: 800 }}>5. Secure Signature & Photos Evidence</span>}
                size="small"
                style={{ borderRadius: '12px', border: '1px solid #cbd5e1', boxShadow: '0 4px 12px rgba(0,0,0,0.03)', height: '100%' }}
              >
                <Form form={form} layout="vertical">
                  {/* Upload Signature Proof / Stamp Photo */}
                  <Form.Item name="signature_image" label={<span style={{ fontWeight: 600 }}>Upload Signature / Stamp Photo</span>}>
                    <Upload
                      maxCount={1}
                      customRequest={async ({ file, onSuccess, onError }) => {
                        try {
                          await handleUploadFile(file, 'signature_image');
                          onSuccess(null, file);
                        } catch (err) {
                          onError(err);
                        }
                      }}
                      showUploadList={true}
                    >
                      <Button icon={<UploadOutlined />}>Upload Signature Proof File</Button>
                    </Upload>
                  </Form.Item>

                  {/* Upload Material Photos */}
                  <Form.Item name="materials_photos" label={<span style={{ fontWeight: 600 }}>Upload Materials Condition Photos</span>}>
                    <Upload
                      maxCount={1}
                      customRequest={async ({ file, onSuccess, onError }) => {
                        try {
                          await handleUploadFile(file, 'materials_photos');
                          onSuccess(null, file);
                        } catch (err) {
                          onError(err);
                        }
                      }}
                      showUploadList={true}
                    >
                      <Button icon={<UploadOutlined />}>Upload Received Materials Photo</Button>
                    </Upload>
                  </Form.Item>

                  {uploadedUrls.materials_photos && (
                    <div style={{ marginTop: '12px', marginBottom: '16px', background: '#fafafa', padding: '12px', borderRadius: '8px', border: '1px solid #cbd5e1' }}>
                      <span style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: '#475569', marginBottom: '6px' }}>Uploaded Photo Review Preview</span>
                      <img src={uploadedUrls.materials_photos} alt="Materials Condition Proof" style={{ maxWidth: '100%', maxHeight: '180px', borderRadius: '6px', border: '1px solid #cbd5e1', display: 'block', margin: '0 auto' }} />
                    </div>
                  )}

                  {uploadedUrls.materials_photos && (
                    <Form.Item name="photo_review" label={<span style={{ fontWeight: 600 }}>Photo Review Remarks / Condition Assessment</span>} rules={[{ required: true, message: 'Please provide a review for the uploaded photos' }]}>
                      <TextArea rows={2} placeholder="E.g., Checked items inside box; packaging intact, no leakage found." />
                    </Form.Item>
                  )}
                </Form>
              </Card>
            </Col>
          </>
        ) : (
          <Col span={24}>
            <Card style={{ borderRadius: '12px', border: '1px dashed #cbd5e1', textAlign: 'center', padding: '40px' }}>
              <SearchOutlined style={{ fontSize: '32px', color: '#94a3b8', marginBottom: '12px' }} />
              <Title level={5} style={{ margin: 0, color: '#64748b' }}>Awaiting SCM Dispatch Selection</Title>
              <Text type="secondary">Select your operating location and search a dispatch order to begin confirmation process.</Text>
            </Card>
          </Col>
        )}
      </Row>
    </div>
  );
};

export default AcknowledgeDelivery;
