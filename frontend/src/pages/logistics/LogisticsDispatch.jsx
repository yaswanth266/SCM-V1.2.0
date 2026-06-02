import React, { useState, useEffect } from 'react';
import {
  Card, Table, Tag, Badge, Button, Modal, Form, Select, DatePicker,
  Input, InputNumber, Switch, Divider, Space, Collapse, Spin, message, Row, Col, Typography, Alert, Upload
} from 'antd';
import {
  FolderAddOutlined, CheckCircleOutlined, PlusOutlined, DeleteOutlined,
  EnvironmentOutlined, GoldOutlined, FilePdfOutlined, CarOutlined,
  UserOutlined, MailOutlined, PhoneOutlined, KeyOutlined, ArrowRightOutlined,
  ClockCircleOutlined, SafetyCertificateOutlined, SendOutlined, UploadOutlined,
  EyeOutlined, SearchOutlined
} from '@ant-design/icons';
import api from '../../config/api';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import { formatNumber, formatDate } from '../../utils/helpers';
import SerialNumbersModal from '../../components/SerialNumbersModal';

const { Title, Text, Paragraph } = Typography;
const { Option } = Select;

// Specialized logistics metadata parsers
export const parseAddress = (addr) => {
  if (addr && addr.startsWith('PICKUP: ')) {
    const parts = addr.split(' | DROPOFF: ');
    return { pickup: parts[0].replace('PICKUP: ', ''), dropoff: parts[1] || '' };
  }
  return { pickup: '', dropoff: addr || '' };
};

export const parseInstructions = (inst) => {
  if (inst && inst.startsWith('ITEMS_DESC: ')) {
    const parts = inst.split(' | WEIGHT: ');
    const weightVol = parts[1] ? parts[1].split(' | VOLUME: ') : ['', ''];
    return {
      desc: parts[0].replace('ITEMS_DESC: ', ''),
      weight: weightVol[0] || '',
      volume: weightVol[1] || ''
    };
  }
  return { desc: inst || '', weight: '', volume: '' };
};

const FormUpload = ({ value, ...props }) => <Upload {...props} />;

export default function LogisticsDispatch() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [mdos, setMdos] = useState([]);
  const [masters, setMasters] = useState(null);

  // Custom SCM lookups
  const [materialIssues, setMaterialIssues] = useState([]);
  const [indents, setIndents] = useState([]);

  // SCM Planner Form Modal State
  const [showDesigner, setShowDesigner] = useState(false);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [form] = Form.useForm();
  const [uploadedUrls, setUploadedUrls] = useState({});

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

  // Selected Material Issue / Indent details
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [selectedIndent, setSelectedIndent] = useState(null);
  const [selectedIndentItems, setSelectedIndentItems] = useState([]);
  const [selectedIssueItems, setSelectedIssueItems] = useState([]);
  const [loadingIndent, setLoadingIndent] = useState(false);
  const [loadingIssue, setLoadingIssue] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // Dynamic SCM form state
  const [dispatchType, setDispatchType] = useState('THIRD_PARTY');
  const [submitting, setSubmitting] = useState(false);

  // Dispatch Ledger search
  const [searchText, setSearchText] = useState('');

  // OTP Verification Modal State
  const [otpModalOpen, setOtpModalOpen] = useState(false);
  const [activeHandover, setActiveHandover] = useState(null);
  const [verificationOtp, setVerificationOtp] = useState('');
  const [verifying, setVerifying] = useState(false);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [mdoRes, masterRes, issuesRes, indentRes] = await Promise.all([
        api.get('/logistics/mdo'),
        api.get('/logistics/masters'),
        api.get('/warehouse/material-issues', { params: { page_size: 100, status: 'issued' } }),
        api.get('/indents', { params: { page_size: 100, available_for_issue: true } })
      ]);
      setMdos(mdoRes.data);
      setMasters(masterRes.data);

      const issuesList = issuesRes.data.items || issuesRes.data.data || issuesRes.data || [];
      setMaterialIssues(issuesList.filter(i => i.status === 'issued'));

      const indentsList = indentRes.data.items || indentRes.data.data || indentRes.data || [];
      setIndents(indentsList.map(i => ({ label: i.indent_number, value: i.id })));
    } catch (err) {
      console.error(err);
      message.error("Failed to load SCM dispatch plan desk data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (selectedIndent && !indents.some(i => i.value === selectedIndent.id)) {
      setIndents(prev => [...prev, { label: selectedIndent.indent_number, value: selectedIndent.id }]);
    }
  }, [selectedIndent, indents]);

  useEffect(() => {
    if (selectedIssue && !materialIssues.some(i => i.id === selectedIssue.id)) {
      setMaterialIssues(prev => [...prev, selectedIssue]);
    }
  }, [selectedIssue, materialIssues]);


  const handleIndentSelect = async (indentId) => {
    if (!indentId) {
      setSelectedIndentItems([]);
      setSelectedIndent(null);
      return;
    }
    setLoadingIndent(true);
    try {
      const res = await api.get(`/indents/${indentId}`);
      setSelectedIndent(res.data);
      setSelectedIndentItems((res.data.items || []).map(item => ({
        ...item,
        dispatched_quantity: 0,
        key: item.id || Math.random()
      })));
    } catch (err) {
      message.error('Failed to load indent items');
    } finally {
      setLoadingIndent(false);
    }
  };

  const handleIssueSelect = async (issueId) => {
    if (!issueId) {
      setSelectedIssueItems([]);
      setSelectedIssue(null);
      setSelectedIndent(null);
      setSelectedIndentItems([]);
      form.setFieldsValue({
        indent_id_ref: undefined,
        pickup_location: undefined,
        dropoff_location: undefined,
        items_description: undefined,
        logistics_weight: undefined,
        logistics_volume: undefined,
      });
      return;
    }
    setLoadingIssue(true);
    try {
      const res = await api.get(`/warehouse/material-issues/${issueId}`);
      const issueData = res.data;
      setSelectedIssue(issueData);
      setSelectedIssueItems((issueData.items || []).map(item => ({
        ...item,
        dispatched_quantity: item.qty || 0,
        key: item.id || Math.random()
      })));

      // Prefill fields
      const originWhName = issueData.warehouse_name || 'Main Warehouse Store';
      const destAddress = issueData.destination_warehouse?.address || issueData.destination_warehouse_name || 'Client Drop Site';
      const computedDesc = (issueData.items || []).map(item => `${item.item_name || item.item?.name || 'Material'} (${item.qty} ${item.uom_name || item.uom?.name || 'PCS'})`).join(', ');

      // Auto-compute weight and volume from issue items as a sensible default
      const autoWeight = (issueData.items || []).reduce((acc, item) => acc + (parseFloat(item.qty || 0) * 10), 0);
      const autoVolume = (issueData.items || []).reduce((acc, item) => acc + (parseFloat(item.qty || 0) * 0.5), 0);

      form.setFieldsValue({
        pickup_location: originWhName,
        dropoff_location: destAddress,
        items_description: computedDesc,
        logistics_weight: autoWeight,
        logistics_volume: autoVolume,
      });

      if (issueData.indent_id) {
        form.setFieldsValue({ indent_id_ref: issueData.indent_id });
        setLoadingIndent(true);
        try {
          const indentRes = await api.get(`/indents/${issueData.indent_id}`);
          setSelectedIndent(indentRes.data);
          setSelectedIndentItems((indentRes.data.items || []).map(item => ({
            ...item,
            dispatched_quantity: 0,
            key: item.id || Math.random()
          })));
        } catch (e) {
          console.error("Failed to load linked indent details", e);
        } finally {
          setLoadingIndent(false);
        }
      } else {
        form.setFieldsValue({ indent_id_ref: undefined });
        setSelectedIndent(null);
        setSelectedIndentItems([]);
      }
    } catch (err) {
      message.error('Failed to load material issue items');
    } finally {
      setLoadingIssue(false);
    }
  };

  const handleViewDetails = async (mdo) => {
    setIsReadOnly(true);
    setShowDesigner(true);
    setDispatchType(mdo.dispatch_type);

    let issueData = null;
    try {
      setLoadingDetails(true);
      const issueRes = await api.get(`/warehouse/material-issues/${mdo.material_issue_id}`);
      issueData = issueRes.data;
      setSelectedIssue(issueData);
      setSelectedIssueItems((issueData.items || []).map(item => ({
        ...item,
        dispatched_quantity: item.qty || 0,
        key: item.id || Math.random()
      })));

      if (!materialIssues.some(i => i.id === issueData.id)) {
        setMaterialIssues(prev => [...prev, issueData]);
      }

      if (issueData.indent_id) {
        const indentRes = await api.get(`/indents/${issueData.indent_id}`);
        const indentData = indentRes.data;
        setSelectedIndent(indentData);
        setSelectedIndentItems((indentData.items || []).map(item => ({
          ...item,
          dispatched_quantity: 0,
          key: item.id || Math.random()
        })));
      } else {
        setSelectedIndent(null);
        setSelectedIndentItems([]);
      }
    } catch (err) {
      console.error("Failed to load material issue details for viewing", err);
      issueData = {
        id: mdo.material_issue_id,
        issue_number: `MI-ID: ${mdo.material_issue_id}`,
        items: (mdo.sdos[0]?.materials || []).map(m => ({
          id: m.id,
          item_id: m.material_id,
          qty: m.quantity,
          uom_name: m.unit_of_measure
        }))
      };
      setSelectedIssue(issueData);
      setSelectedIssueItems((issueData.items || []).map(item => ({
        ...item,
        dispatched_quantity: item.qty || 0,
        key: item.id || Math.random()
      })));
      if (!materialIssues.some(i => i.id === issueData.id)) {
        setMaterialIssues(prev => [...prev, issueData]);
      }
      setSelectedIndent(null);
      setSelectedIndentItems([]);
    } finally {
      setLoadingDetails(false);
    }

    const addr = parseAddress(mdo.delivery_address);
    const inst = parseInstructions(mdo.special_instructions);

    form.setFieldsValue({
      issue_id_ref: mdo.material_issue_id,
      indent_id_ref: mdo.indent_id || undefined,
      priority: mdo.priority,
      pickup_location: addr.pickup,
      dropoff_location: addr.dropoff,
      items_description: inst.desc,
      expected_delivery_date: mdo.required_delivery_date ? dayjs(mdo.required_delivery_date) : null,

      driver_name: mdo.handover?.driver_name,
      driver_phone: mdo.handover?.driver_phone,
      received_by_name: mdo.handover?.received_by_name,
      received_by_phone: mdo.handover?.received_by_phone,
      vehicle_no: mdo.handover?.vehicle_no,
      courier_name: mdo.handover?.courier_name,
      awb_no: mdo.handover?.awb_no,
      handover_remarks: mdo.handover?.remarks
    });

    const updatedUploadedUrls = {};
    if (mdo.e_challan) updatedUploadedUrls.e_challan = mdo.e_challan;
    if (mdo.waybill) updatedUploadedUrls.waybill = mdo.waybill;
    if (mdo.handover?.handover_document) {
      if (mdo.dispatch_type === 'own vehicle') {
        updatedUploadedUrls.vehicle_image = mdo.handover.handover_document;
      }
    }
    if (mdo.handover?.remarks && mdo.handover.remarks.includes('RECEIVER_SIGNATURE: ')) {
      const sigPart = mdo.handover.remarks.split(' | REMARKS: ')[0].replace('RECEIVER_SIGNATURE: ', '');
      updatedUploadedUrls.receiver_signature = sigPart;

      const remarksPart = mdo.handover.remarks.split(' | REMARKS: ')[1] || '';
      form.setFieldValue('handover_remarks', remarksPart);
    }
    setUploadedUrls(updatedUploadedUrls);
  };

  const handleCreateDispatchSubmit = async (values) => {
    if (!selectedIssue) {
      message.warning("Please select a Material Issue reference!");
      return;
    }

    try {
      setSubmitting(true);

      const consignmentMaterials = (selectedIssue.items || []).map(item => ({
        materialId: item.item_id,
        qty: item.qty,
        batchNo: item.batch?.batch_number || 'B2026-AUTO',
        pkgType: 'Pallet',
        pkgCount: Math.ceil(item.qty / 10),
        instructions: 'Fragile. Maintain standard handling protocol.'
      }));

      const pickupLoc = values.pickup_location || selectedIssue.warehouse_name || 'Main Warehouse Store';
      const dropoffLoc = values.dropoff_location || selectedIssue.destination_warehouse?.address || selectedIssue.destination_warehouse_name || 'Client Drop Site';
      const itemsDesc = values.items_description || (selectedIssue.items || []).map(item => `${item.item_name || item.item?.name || 'Material'} (${item.qty} ${item.uom_name || item.uom?.name || 'PCS'})`).join(', ');

      const computedWeight = (selectedIssue.items || []).reduce((acc, item) => acc + (parseFloat(item.qty || 0) * 10), 0);
      const computedVolume = (selectedIssue.items || []).reduce((acc, item) => acc + (parseFloat(item.qty || 0) * 0.5), 0);

      // Use user-entered weight/volume if provided, otherwise fall back to auto-computed values
      const finalWeight = values.logistics_weight != null ? parseFloat(values.logistics_weight) : computedWeight;
      const finalVolume = values.logistics_volume != null ? parseFloat(values.logistics_volume) : computedVolume;

      const serializedAddress = `PICKUP: ${pickupLoc} | DROPOFF: ${dropoffLoc}`;
      const serializedInstructions = `ITEMS_DESC: ${itemsDesc} | WEIGHT: ${finalWeight} | VOLUME: ${finalVolume}`;

      const routePayload = {
        pickupDate: dayjs().toISOString(),
        deliveryDate: values.expected_delivery_date 
          ? dayjs(values.expected_delivery_date).toISOString() 
          : (selectedIndent && selectedIndent.required_date ? dayjs(selectedIndent.required_date).toISOString() : dayjs().toISOString()),
        loadingTime: 60,
        unloadingTime: 60,
        helperRequired: false,
        specialReqs: serializedInstructions,
        destinations: [
          {
            locationId: masters?.locations[0]?.id || 1,
            seq: 1,
            contactPerson: values.received_by_name || 'Supervisor Incharge',
            contactMobile: values.received_by_phone || '9876543210'
          }
        ],
        materials: consignmentMaterials
      };

      const payload = {
        warehouseId: selectedIssue.warehouse_id,
        priority: values.priority || 'MEDIUM',
        specialInstructions: serializedInstructions,
        sdos: [routePayload],

        material_issue_id: selectedIssue.id,
        indent_id: selectedIssue.indent_id,
        destination_warehouse_id: selectedIssue.destination_warehouse_id,
        delivery_address: serializedAddress,
        e_challan: uploadedUrls.e_challan || 'https://bhspl-scm.s3.amazonaws.com/challans/E-CHL2026.pdf',
        waybill: uploadedUrls.waybill || 'https://bhspl-scm.s3.amazonaws.com/waybills/E-WAY2026.pdf',
        dispatch_type: dispatchType
      };

      const res = await api.post('/logistics/mdo', payload);
      const newMdoId = res.data.mdo_id;
      const newMdoNum = res.data.mdo_number;

      message.success(`Dispatch Plan ${newMdoNum} saved successfully!`);

      if (dispatchType !== 'THIRD_PARTY') {
        const handoverPayload = {
          dispatch_id: newMdoId,
          handover_type: dispatchType,
          received_by_name: values.received_by_name || 'Warehouse Rep',
          received_by_phone: values.received_by_phone,
          transporter_id: values.transporter_id,
          vehicle_no: values.vehicle_no,
          driver_name: values.driver_name,
          driver_phone: values.driver_phone,
          courier_name: values.courier_name,
          awb_no: values.awb_no,
          remarks: uploadedUrls.receiver_signature
            ? `RECEIVER_SIGNATURE: ${uploadedUrls.receiver_signature} | REMARKS: ${values.handover_remarks || 'Standard handover clearance completed.'}`
            : (values.handover_remarks || 'Standard handover clearance completed.'),
          handover_document: uploadedUrls.vehicle_image || uploadedUrls.waybill || ''
        };

        const handoverRes = await api.post('/logistics/handover', handoverPayload);
        setActiveHandover(handoverRes.data);

        message.success(`Dispatch Handover completed successfully for ${dispatchType}!`);
        setShowDesigner(false);
        form.resetFields();
        setSelectedIssue(null);
        setSelectedIndent(null);
        setSelectedIndentItems([]);
        setSelectedIssueItems([]);
        setUploadedUrls({});
        await fetchData();
      } else {
        message.info("Routing directly to the Freight Bidding Desk (RFQ)...");
        setShowDesigner(false);
        form.resetFields();
        setSelectedIssue(null);
        setSelectedIndent(null);
        setSelectedIndentItems([]);
        setSelectedIssueItems([]);
        setUploadedUrls({});
        navigate('/logistics/rfq', { state: { openPublisher: true } });
      }

    } catch (err) {
      console.error(err);
      message.error("Failed to construct the Dispatch Plan.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyOtpSubmit = async () => {
    // Left as stub for backward compatibility
  };

  // Filter MDOs by search text
  const filteredMdos = mdos.filter(mdo => {
    if (!searchText) return true;
    const q = searchText.toLowerCase();
    return (
      (mdo.mdo_number || '').toLowerCase().includes(q) ||
      (mdo.warehouse_name || '').toLowerCase().includes(q) ||
      (mdo.dispatch_type || '').toLowerCase().includes(q) ||
      (mdo.priority || '').toLowerCase().includes(q) ||
      (mdo.status || '').toLowerCase().includes(q) ||
      (mdo.delivery_address || '').toLowerCase().includes(q) ||
      (mdo.special_instructions || '').toLowerCase().includes(q)
    );
  });

  if (loading && mdos.length === 0) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#020617' }}>
        <Spin size="large" tip="Loading Dispatch Plan ledger..." />
      </div>
    );
  }

  const collapseItems = filteredMdos.map((mdo) => {
    const wh = masters?.warehouses.find(w => w.warehouse_id === mdo.warehouse_id);
    const addr = parseAddress(mdo.delivery_address);
    const inst = parseInstructions(mdo.special_instructions);

    return {
      key: mdo.id,
      label: (
        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <span style={{
              background: 'linear-gradient(135deg, #ffffff 0%, #f1f5f9 100%)',
              padding: '6px 14px',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              color: '#0284c7',
              fontWeight: 800,
              fontFamily: 'monospace',
              fontSize: '12px',
              boxShadow: '0 2px 8px rgba(0,0,0,0.03)'
            }}>
              DSP #{mdo.mdo_number.substring(9)}
            </span>
            <div>
              <h4 style={{ margin: 0, color: '#0f172a', fontSize: '14px', fontWeight: 700 }}>{mdo.mdo_number}</h4>
              <p style={{ margin: 0, color: '#64748b', fontSize: '11px', fontWeight: 500 }}>
                Store Origin: <strong style={{ color: '#475569' }}>{mdo.warehouse_name || (wh ? wh.warehouse_name : 'Loading Dock')}</strong>
              </p>
            </div>
          </div>

          <Space size="middle" style={{ shrink: 0 }}>
            <Tag
              color={mdo.dispatch_type === 'own vehicle' ? 'green' : mdo.dispatch_type === 'COURIER' ? 'cyan' : mdo.dispatch_type === 'IN_PERSON' ? 'orange' : 'purple'}
              style={{ border: 'none', fontWeight: 700, borderRadius: '4px', px: '8px' }}
            >
              {String(mdo.dispatch_type || 'THIRD PARTY').toUpperCase()}
            </Tag>
            <Tag
              color={mdo.priority === 'URGENT' ? 'red' : mdo.priority === 'HIGH' ? 'orange' : 'blue'}
              style={{ border: 'none', fontWeight: 700, borderRadius: '4px' }}
            >
              {mdo.priority} PRIORITY
            </Tag>
            <Tag
              color={
                mdo.status === 'ACKNOWLEDGED' ? 'success' :
                  mdo.status === 'COMPLETED' ? 'cyan' :
                    mdo.status === 'IN_TRANSIT' ? 'magenta' :
                      mdo.status === 'DISPATCHED' ? 'blue' :
                        mdo.status === 'CONFIRMED' ? 'purple' :
                          mdo.status === 'APPROVED' ? 'indigo' :
                            'warning'
              }
              style={{ border: 'none', fontWeight: 700, borderRadius: '4px' }}
            >
              {mdo.status === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED' : mdo.status === 'COMPLETED' ? 'DELIVERED' : mdo.status.replace('_', ' ')}
            </Tag>
          </Space>
        </div>
      ),
      className: "logistics-dark-panel",
      style: {
        background: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: '12px',
        marginBottom: '12px',
        overflow: 'hidden',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.03)'
      },
      children: (
        <div style={{ background: '#f8fafc', padding: '20px', borderRadius: '8px', border: '1px solid #cbd5e1' }}>
          {/* Summary manifest */}
          <>
            <Row gutter={[16, 16]} style={{ marginBottom: '12px' }}>
              <Col xs={24} md={10}>
                <span style={{ fontSize: '10px', fontFamily: 'monospace', color: '#64748b', display: 'block', textTransform: 'uppercase', marginBottom: '4px' }}>Pick Up Location</span>
                <strong style={{ fontSize: '13px', color: '#334155' }}><EnvironmentOutlined style={{ color: '#059669' }} /> {addr.pickup || 'Origin Warehouse'}</strong>
              </Col>
              <Col xs={24} md={10}>
                <span style={{ fontSize: '10px', fontFamily: 'monospace', color: '#64748b', display: 'block', textTransform: 'uppercase', marginBottom: '4px' }}>Drop Off Location</span>
                <strong style={{ fontSize: '13px', color: '#334155' }}><EnvironmentOutlined style={{ color: '#ef4444' }} /> {addr.dropoff || 'Client Store Destination'}</strong>
              </Col>
              <Col xs={24} md={4} style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', alignItems: 'center' }}>
                <Button
                  type="primary"
                  size="small"
                  icon={<EyeOutlined />}
                  onClick={() => handleViewDetails(mdo)}
                  style={{
                    background: 'linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)',
                    borderColor: 'transparent',
                    color: '#ffffff',
                    fontWeight: 700,
                    borderRadius: '6px',
                    boxShadow: '0 2px 6px rgba(14, 165, 233, 0.15)'
                  }}
                >
                  View details
                </Button>
                {mdo.e_challan && (
                  <Button type="link" icon={<FilePdfOutlined />} href={mdo.e_challan} target="_blank" style={{ color: '#ef4444', fontWeight: 600, padding: 0 }}>Challan</Button>
                )}
                {mdo.waybill && (
                  <Button type="link" icon={<FilePdfOutlined />} href={mdo.waybill} target="_blank" style={{ color: '#ef4444', fontWeight: 600, padding: 0 }}>Way Bill</Button>
                )}
              </Col>
            </Row>
            <Row gutter={[16, 16]} style={{ marginBottom: '16px', borderBottom: '1px solid #cbd5e1', paddingBottom: '14px' }}>
              <Col xs={24} md={12}>
                <span style={{ fontSize: '10px', fontFamily: 'monospace', color: '#64748b', display: 'block', textTransform: 'uppercase', marginBottom: '4px' }}>Items Description</span>
                <span style={{ fontSize: '13px', color: '#475569', fontWeight: 500 }}>{inst.desc || 'SCM Materials'}</span>
              </Col>
              <Col xs={12} md={6}>
                <span style={{ fontSize: '10px', fontFamily: 'monospace', color: '#64748b', display: 'block', textTransform: 'uppercase', marginBottom: '4px' }}>Logistics Weight</span>
                <strong style={{ fontSize: '13px', color: '#4f46e5' }}>{inst.weight || parseFloat(mdo.total_weight_kg || 0)} KG</strong>
              </Col>
              <Col xs={12} md={6}>
                <span style={{ fontSize: '10px', fontFamily: 'monospace', color: '#64748b', display: 'block', textTransform: 'uppercase', marginBottom: '4px' }}>Logistics Volume</span>
                <strong style={{ fontSize: '13px', color: '#0284c7' }}>{inst.volume || parseFloat(mdo.total_volume_cft || 0)} CFT</strong>
              </Col>
            </Row>
          </>

          {/* Handover Details */}
          {mdo.handover ? (
            <>
              <Card
                size="small"
                title={<span style={{ color: '#d97706', fontSize: '11px', fontFamily: 'monospace', fontWeight: 700, letterSpacing: '0.5px' }}><SafetyCertificateOutlined /> COMPLETED HANDOVER MANIFEST</span>}
                style={{ background: '#fffbeb', borderColor: '#fde68a', marginBottom: '16px', borderRadius: '8px' }}
              >
                <Row gutter={16} style={{ fontSize: '12px', color: '#475569' }}>
                  <Col xs={12} md={6}>
                    <span style={{ display: 'block', fontSize: '10px', textTransform: 'uppercase', color: '#64748b' }}>Handover ID</span>
                    <div style={{ color: '#0f172a', fontWeight: 'bold' }}>{mdo.handover.handover_no}</div>
                  </Col>
                  <Col xs={12} md={6}>
                    <span style={{ display: 'block', fontSize: '10px', textTransform: 'uppercase', color: '#64748b' }}>Received By</span>
                    <div style={{ color: '#0f172a', fontWeight: 'bold' }}>{mdo.handover.received_by_name} ({mdo.handover.received_by_phone})</div>
                  </Col>
                  {mdo.handover.vehicle_no && (
                    <Col xs={12} md={6}>
                      <span style={{ display: 'block', fontSize: '10px', textTransform: 'uppercase', color: '#64748b' }}>Vehicle / Driver</span>
                      <div style={{ color: '#0f172a' }}>
                        <strong>{mdo.handover.vehicle_no}</strong> ({mdo.handover.driver_name})
                      </div>
                    </Col>
                  )}
                  {mdo.handover.courier_name && (
                    <Col xs={12} md={6}>
                      <span style={{ display: 'block', fontSize: '10px', textTransform: 'uppercase', color: '#64748b' }}>Courier Carrier</span>
                      <div style={{ color: '#0f172a' }}>
                        <strong>{mdo.handover.courier_name}</strong> - {mdo.handover.awb_no}
                      </div>
                    </Col>
                  )}
                </Row>
              </Card>

              {mdo.status === 'DISPATCHED' && (
                <div style={{
                  background: '#eff6ff',
                  border: '1px dashed #3b82f6',
                  padding: '14px',
                  borderRadius: '8px',
                  marginBottom: '16px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '12px'
                }}>
                  <span style={{ color: '#1d4ed8', fontSize: '12px', fontWeight: 600 }}>🚚 Handover manifest recorded successfully. Consortium is ready to be shipped.</span>
                  <Button
                    type="primary"
                    size="small"
                    style={{ background: '#3b82f6', borderColor: '#3b82f6', color: '#ffffff', fontWeight: 'bold' }}
                    onClick={async () => {
                      try {
                        setLoading(true);
                        await api.post(`/logistics/mdo/${mdo.id}/transit`);
                        message.success("Consignment shipped successfully! Status updated to IN TRANSIT.");
                        await fetchData();
                      } catch (err) {
                        message.error("Failed to ship consignment.");
                      } finally {
                        setLoading(false);
                      }
                    }}
                  >
                    Ship / Start Transit
                  </Button>
                </div>
              )}

              {mdo.status === 'IN_TRANSIT' && (
                <div style={{
                  background: '#f0fdf4',
                  border: '1px dashed #22c55e',
                  padding: '14px',
                  borderRadius: '8px',
                  marginBottom: '16px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '12px'
                }}>
                  <span style={{ color: '#15803d', fontSize: '12px', fontWeight: 600 }}>🟢 Package is currently in transit. Awaiting receipt acknowledgement from the indent raiser.</span>
                </div>
              )}
            </>
          ) : mdo.status === 'APPROVED' && mdo.dispatch_type !== 'THIRD_PARTY' && (
            <div style={{
              background: '#fffbeb',
              border: '1px dashed #fcd34d',
              padding: '14px',
              borderRadius: '8px',
              marginBottom: '16px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '12px'
            }}>
              <span style={{ color: '#d97706', fontSize: '12px', fontWeight: 600 }}>⚠️ Dispatch lacks recorded Handover manifest details. Record handover process now.</span>
              <Button
                type="primary"
                size="small"
                style={{ background: '#f59e0b', borderColor: '#f59e0b', color: '#ffffff', fontWeight: 'bold' }}
                onClick={() => {
                  setSelectedIssue({
                    id: mdo.material_issue_id,
                    warehouse_id: mdo.warehouse_id,
                    items: mdo.sdos[0]?.materials || []
                  });
                  setDispatchType(mdo.dispatch_type);

                  const addr = parseAddress(mdo.delivery_address);
                  const inst = parseInstructions(mdo.special_instructions);

                  form.setFieldsValue({
                    pickup_location: addr.pickup,
                    dropoff_location: addr.dropoff,
                    logistics_weight: inst.weight ? parseFloat(inst.weight) : mdo.total_weight_kg,
                    logistics_volume: inst.volume ? parseFloat(inst.volume) : mdo.total_volume_cft,
                    items_description: inst.desc,
                    expected_delivery_date: mdo.required_delivery_date ? dayjs(mdo.required_delivery_date) : dayjs().add(2, 'day')
                  });
                  setShowDesigner(true);
                }}
              >
                Record Handover
              </Button>
            </div>
          )}

          {/* SDO sections list */}
          <Row gutter={[12, 12]}>
            {mdo.sdos.map((sdo) => (
              <Col key={sdo.id} xs={24}>
                <Card
                  size="small"
                  style={{ background: '#ffffff', borderColor: '#e2e8f0', borderRadius: '8px' }}
                >
                  {/* BOM list table */}
                  <Table
                    dataSource={sdo.materials}
                    size="small"
                    pagination={false}
                    rowKey="id"
                    className="logistics-dark-subtable"
                    columns={[
                      { title: 'Code', dataIndex: 'material_code', key: 'code', render: t => <span style={{ fontFamily: 'monospace', color: '#334155' }}>{t}</span> },
                      { title: 'Name', dataIndex: 'material_name', key: 'name', render: text => <span style={{ color: '#0f172a', fontWeight: 500 }}>{text}</span> },
                      { title: 'Quantity', dataIndex: 'quantity', key: 'qty', render: (q, r) => <span style={{ fontFamily: 'monospace', color: '#4f46e5', fontWeight: 600 }}>{q} {r.unit_of_measure}</span> },
                      { title: 'Batch', dataIndex: 'batch_number', key: 'batch', render: t => <span style={{ fontFamily: 'monospace' }}>{t}</span> },
                      { title: 'Packages', key: 'pkgs', render: (_, r) => <span>{r.number_of_packages}x {r.package_type}</span> }
                    ]}
                  />
                </Card>
              </Col>
            ))}
          </Row>
        </div>
      )
    };
  });

  return (
    <div style={{ padding: '28px', background: 'radial-gradient(ellipse at top, #f8fafc 0%, #f1f5f9 80%)', minHeight: '100vh', color: '#334155', fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>

      {/* Top Banner Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '28px',
        flexWrap: 'wrap',
        gap: '16px',
        background: '#ffffff',
        padding: '20px 24px',
        borderRadius: '16px',
        border: '1px solid #e2e8f0',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.05)'
      }}>
        <div>
          <h2 style={{
            color: '#0f172a',
            margin: 0,
            fontWeight: 800,
            fontSize: '24px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            background: 'linear-gradient(90deg, #0284c7 0%, #4f46e5 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            letterSpacing: '-0.5px'
          }}>
            <GoldOutlined style={{ color: '#4f46e5' }} />  Dispatch Ledger
          </h2>
          <p style={{ color: '#64748b', fontSize: '13px', margin: '4px 0 0 0', fontWeight: 500 }}>
            {filteredMdos.length} of {mdos.length} dispatch plans
          </p>
        </div>
        <Space size="middle" wrap>
          <Input
            placeholder="Search dispatch plans..."
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            allowClear
            style={{
              width: 320,
              borderRadius: '8px',
              border: '1px solid #cbd5e1',
              background: '#ffffff'
            }}
          />
          <Button
            type="primary"
            icon={<FolderAddOutlined />}
            onClick={() => {
              setIsReadOnly(false);
              setShowDesigner(true);
              setDispatchType('THIRD_PARTY');
            }}
            className="premium-btn"
            style={{
              borderRadius: '8px',
              fontWeight: 700,
              height: '42px',
              background: 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)',
              borderColor: 'transparent',
              boxShadow: '0 4px 14px 0 rgba(2, 132, 199, 0.25)',
              transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
            }}
          >
            New Dispatch
          </Button>
        </Space>
      </div>

      {/* Main Designer Modal Form */}
      <Modal
        title={
          <span style={{ color: '#0f172a', fontSize: '17px', fontWeight: 700, letterSpacing: '-0.2px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isReadOnly ? <EyeOutlined style={{ color: '#0284c7' }} /> : <PlusOutlined style={{ color: '#0284c7' }} />}
            {isReadOnly ? 'VIEW DISPATCH PLAN DETAILS' : 'NEW DISPATCH'}
          </span>
        }
        open={showDesigner}
        onCancel={() => {
          setShowDesigner(false);
          form.resetFields();
          setSelectedIssue(null);
          setUploadedUrls({});
          setIsReadOnly(false);
        }}
        width="100%"
        footer={null}
        style={{ top: 0, margin: 0, padding: 0, maxWidth: '100vw' }}
        styles={{
          body: { background: '#ffffff', padding: '24px', minHeight: 'calc(100vh - 55px)', overflowY: 'auto' },
          header: { background: '#ffffff', borderBottom: '1px solid #e2e8f0' }
        }}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleCreateDispatchSubmit}
          initialValues={{ priority: 'MEDIUM' }}
          className="premium-dark-form"
          disabled={isReadOnly}
        >
          {/* Side-by-Side Reference Panel */}
          <Row gutter={[20, 20]} style={{ marginBottom: '20px' }}>
            {/* Left Column: Indent Reference */}
            <Col xs={24} md={12}>
              <Card title={<span style={{ color: '#0f172a', fontWeight: 700 }}>Indent Reference</span>} size="small" style={{ borderRadius: '12px', border: '1px solid #cbd5e1', background: '#ffffff', height: '100%' }}>
                <Form.Item name="indent_id_ref" label={<span style={{ color: '#475569', fontWeight: 600 }}>Select Indent ID</span>} style={{ marginBottom: '14px' }}>
                  <Select
                    showSearch
                    placeholder="Select an Indent"
                    options={indents}
                    onChange={handleIndentSelect}
                    allowClear
                    disabled={isReadOnly}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
                {selectedIndent && (
                  <div style={{
                    background: '#f8fafc',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    marginBottom: '14px',
                    border: '1px solid #cbd5e1'
                  }}>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Text type="secondary" style={{ fontSize: '11px', display: 'block', color: '#64748b' }}>Req. Warehouse</Text>
                        <Text strong style={{ fontSize: '12px', color: '#334155' }}>{selectedIndent.warehouse_name || '—'}</Text>
                      </Col>
                      <Col span={12}>
                        <Text type="secondary" style={{ fontSize: '11px', display: 'block', color: '#64748b' }}>Req. User</Text>
                        <Text strong style={{ fontSize: '12px', color: '#334155' }}>{selectedIndent.raised_by_name || '—'}</Text>
                      </Col>
                    </Row>
                  </div>
                )}
                <Table
                  dataSource={selectedIndentItems}
                  size="small"
                  pagination={false}
                  loading={loadingIndent}
                  scroll={{ y: 220 }}
                  className="logistics-dark-subtable"
                  columns={[
                    { title: 'Material', render: (_, r) => r.item_name || r.item?.name },
                    { title: 'Req. Qty', dataIndex: 'requested_qty', width: 90 },
                    { title: 'Req. Date', dataIndex: 'required_date', render: d => formatDate(d), width: 100 },
                  ]}
                />
              </Card>
            </Col>

            {/* Right Column: Material Issue Reference */}
            <Col xs={24} md={12}>
              <Card title={<span style={{ color: '#0f172a', fontWeight: 700 }}>Material Issue Reference</span>} size="small" style={{ borderRadius: '12px', border: '1px solid #cbd5e1', background: '#ffffff', height: '100%' }}>
                <Form.Item name="issue_id_ref" label={<span style={{ color: '#4f46e5', fontWeight: 600 }}>Select Material Issue ID</span>} rules={[{ required: true, message: 'Please select a Material Issue reference' }]} style={{ marginBottom: '14px' }}>
                  <Select
                    showSearch
                    placeholder="Choose an active Material Issue..."
                    options={materialIssues.map(issue => ({ label: issue.issue_number, value: issue.id }))}
                    onChange={handleIssueSelect}
                    allowClear
                    disabled={isReadOnly}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
                {selectedIssue && (
                  <div style={{
                    background: '#f8fafc',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    marginBottom: '14px',
                    border: '1px solid #cbd5e1'
                  }}>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Text type="secondary" style={{ fontSize: '11px', display: 'block', color: '#64748b' }}>Dispatch Warehouse</Text>
                        <Text strong style={{ fontSize: '12px', color: '#334155' }}>{selectedIssue.destination_warehouse_name || '—'}</Text>
                      </Col>
                      <Col span={12}>
                        <Text type="secondary" style={{ fontSize: '11px', display: 'block', color: '#64748b' }}>Issued To</Text>
                        <Text strong style={{ fontSize: '12px', color: '#334155' }}>{selectedIssue.issued_to_name || selectedIssue.issued_to || '—'}</Text>
                      </Col>
                    </Row>
                  </div>
                )}
                <Table
                  dataSource={selectedIssueItems}
                  size="small"
                  pagination={false}
                  loading={loadingIssue}
                  scroll={{ y: 220 }}
                  className="logistics-dark-subtable"
                  columns={[
                    { title: 'Material', render: (_, r) => r.item_name || r.item?.name },
                    { title: 'Appr. Qty', dataIndex: 'qty', width: 90, render: (val) => formatNumber(val) },
                    { title: 'Disp. Qty', dataIndex: 'qty', width: 90, render: (val) => formatNumber(val) },
                    { title: 'Batch', dataIndex: 'batch_number', width: 100, render: (t) => t || 'B2026-AUTO' },
                    {
                      title: 'Serial Nos',
                      key: 'serial_numbers',
                      width: 130,
                      render: (_, r) => (
                        <SerialNumbersModal
                          value={r.serial_numbers || []}
                          itemName={r.item_name || r.item?.name}
                          itemCode={r.item_code}
                          quantity={Math.round(Number(r.qty || 0))}
                          hasSerial={!!(r.serial_numbers && r.serial_numbers.length > 0)}
                          size="small"
                          readOnly
                        />
                      ),
                    },
                  ]}
                />
              </Card>
            </Col>
          </Row>

          <Divider orientation="left"><span style={{ color: '#4f46e5', fontWeight: 700 }}>Logistics & Routing Details</span></Divider>

          <Row gutter={20} style={{ marginBottom: '20px' }}>
            <Col xs={24} md={12}>
              <Form.Item
                name="pickup_location"
                label={<span style={{ color: '#475569', fontWeight: 600 }}>Pickup Location</span>}
                rules={[{ required: true, message: 'Pickup Location is required' }]}
              >
                <Input placeholder="E.g., Central Warehouse Hub A" />
              </Form.Item>
            </Col>

            <Col xs={24} md={12}>
              <Form.Item
                name="dropoff_location"
                label={<span style={{ color: '#475569', fontWeight: 600 }}>Destination Location (Drop Off)</span>}
                rules={[{ required: true, message: 'Destination Location is required' }]}
              >
                <Input placeholder="E.g., Site Office, Section 5" />
              </Form.Item>
            </Col>

            <Col span={24}>
              <Form.Item
                name="items_description"
                label={<span style={{ color: '#475569', fontWeight: 600 }}>Items Description</span>}
                rules={[{ required: true, message: 'Items description is required' }]}
              >
                <Input.TextArea rows={2} placeholder="Brief summary of dispatched consignment items..." />
              </Form.Item>
            </Col>

            <Col xs={24} md={12}>
              <Form.Item
                name="logistics_weight"
                label={<span style={{ color: '#4f46e5', fontWeight: 600 }}>Logistics Weight (KG)</span>}
                rules={[{ required: true, message: 'Logistics weight is required' }]}
              >
                <InputNumber
                  min={0}
                  step={0.1}
                  precision={2}
                  style={{ width: '100%' }}
                  placeholder="e.g. 250.00"
                  addonAfter="KG"
                />
              </Form.Item>
            </Col>

            <Col xs={24} md={12}>
              <Form.Item
                name="logistics_volume"
                label={<span style={{ color: '#0284c7', fontWeight: 600 }}>Logistics Volume (CFT)</span>}
                rules={[{ required: true, message: 'Logistics volume is required' }]}
              >
                <InputNumber
                  min={0}
                  step={0.1}
                  precision={2}
                  style={{ width: '100%' }}
                  placeholder="e.g. 45.00"
                  addonAfter="CFT"
                />
              </Form.Item>
            </Col>
          </Row>

          <Divider />

          <Row gutter={20} style={{ marginBottom: '20px' }}>
            <Col xs={24} md={12}>
              <Form.Item label={<span className="form-label-glowing">Dispatch Methodology</span>} required>
                <Select
                  value={dispatchType}
                  onChange={(val) => {
                    setDispatchType(val);
                  }}
                  style={{ width: '100%' }}
                >
                  <Option value="own vehicle">Self-Owned Fleet Dispatch</Option>
                  <Option value="COURIER">Courier Dispatch</Option>
                  <Option value="IN_PERSON">In-Person Handover</Option>
                  <Option value="THIRD_PARTY">Third-Party Carrier Bidding (RFQ)</Option>
                </Select>
              </Form.Item>
            </Col>

            <Col xs={24} md={12}>
              <Form.Item name="priority" label={<span style={{ color: '#475569', fontWeight: 600 }}>Priority</span>} rules={[{ required: true }]}>
                <Select style={{ width: '100%' }}>
                  <Option value="LOW">LOW</Option>
                  <Option value="MEDIUM">MEDIUM</Option>
                  <Option value="HIGH">HIGH</Option>
                  <Option value="URGENT">URGENT</Option>
                </Select>
              </Form.Item>
            </Col>
            {dispatchType !== 'THIRD_PARTY' && (
              <Col xs={24} md={12}>
                <Form.Item
                  name="expected_delivery_date"
                  label={<span style={{ color: '#475569', fontWeight: 600 }}>Expected Delivery Date</span>}
                  rules={[{ required: true, message: 'Expected delivery date is required' }]}
                >
                  <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" />
                </Form.Item>
              </Col>
            )}
          </Row>

          <div style={{ marginBottom: '20px' }}>
            {dispatchType === 'own vehicle' && (
              <Card
                title={<span style={{ color: '#16a34a', fontWeight: 700 }}><CarOutlined /> Self-Owned Fleet Dispatch</span>}
                style={{ background: '#f0fdf4', borderColor: '#bbf7d0', borderRadius: '12px' }}
              >
                <Row gutter={16}>
                  <Col xs={24} md={12}>
                    <Form.Item name="driver_name" label="Driver Full Name" rules={[{ required: true }]}>
                      <Input placeholder="E.g., Satish Kumar" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    <Form.Item name="driver_phone" label="Driver Phone Number" rules={[{ required: true }]}>
                      <Input placeholder="E.g., 9988776655" />
                    </Form.Item>
                  </Col>
                </Row>
                <Row gutter={16}>
                  <Col xs={24} md={12}>
                    <Form.Item name="received_by_name" label="Received By (Name at Site)" rules={[{ required: true }]}>
                      <Input placeholder="E.g., Nilesh Patil" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    <Form.Item name="received_by_phone" label="Received By (Phone Number)" rules={[{ required: true }]}>
                      <Input placeholder="E.g., 9898001122" />
                    </Form.Item>
                  </Col>
                </Row>
                <Row gutter={16}>
                  <Col xs={24} md={12}>
                    <Form.Item name="vehicle_image" label="Vehicle Image (File Attachment)" rules={[{ required: true }]}>
                      <FormUpload
                        maxCount={1}
                        disabled={isReadOnly}
                        customRequest={async ({ file, onSuccess, onError }) => {
                          try {
                            await handleUploadFile(file, 'vehicle_image');
                            onSuccess(null, file);
                          } catch (err) {
                            onError(err);
                          }
                        }}
                        showUploadList={true}
                      >
                        <Button icon={<UploadOutlined />} disabled={isReadOnly}>Upload Vehicle Image</Button>
                      </FormUpload>
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    <Form.Item name="receiver_signature" label="Receiver Signature (File Attachment)" rules={[{ required: true }]}>
                      <FormUpload
                        maxCount={1}
                        disabled={isReadOnly}
                        customRequest={async ({ file, onSuccess, onError }) => {
                          try {
                            await handleUploadFile(file, 'receiver_signature');
                            onSuccess(null, file);
                          } catch (err) {
                            onError(err);
                          }
                        }}
                        showUploadList={true}
                      >
                        <Button icon={<UploadOutlined />} disabled={isReadOnly}>Upload Receiver Signature</Button>
                      </FormUpload>
                    </Form.Item>
                  </Col>
                </Row>
                <Form.Item name="handover_remarks" label="Remarks / Loading Specs">
                  <Input placeholder="Secure items. Cold chain box used..." />
                </Form.Item>
              </Card>
            )}

            {dispatchType === 'IN_PERSON' && (
              <Card
                title={<span style={{ color: '#d97706', fontWeight: 700 }}><UserOutlined /> In-Person Handover Manifest</span>}
                style={{ background: '#fffbeb', borderColor: '#fde68a', borderRadius: '12px' }}
              >
                <Row gutter={16}>
                  <Col xs={24} md={12}>
                    <Form.Item name="received_by_name" label="Pickup Person Name" rules={[{ required: true }]}>
                      <Input placeholder="E.g., Rahul Verma" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    <Form.Item name="received_by_phone" label="Pickup Person Phone Number" rules={[{ required: true }]}>
                      <Input placeholder="E.g., 9765432100" />
                    </Form.Item>
                  </Col>
                </Row>
                <Row gutter={16}>
                  <Col xs={24} md={12}>
                    <Form.Item name="receiver_signature" label="Receiver Signature (File Attachment)" rules={[{ required: true }]}>
                      <FormUpload
                        maxCount={1}
                        disabled={isReadOnly}
                        customRequest={async ({ file, onSuccess, onError }) => {
                          try {
                            await handleUploadFile(file, 'receiver_signature');
                            onSuccess(null, file);
                          } catch (err) {
                            onError(err);
                          }
                        }}
                        showUploadList={true}
                      >
                        <Button icon={<UploadOutlined />} disabled={isReadOnly}>Upload Receiver Signature</Button>
                      </FormUpload>
                    </Form.Item>
                  </Col>
                </Row>
                <Form.Item name="handover_remarks" label="Handover Remarks">
                  <Input placeholder="Employee ID verified. Clean handover executed..." />
                </Form.Item>
              </Card>
            )}

            {dispatchType === 'COURIER' && (
              <Card
                title={<span style={{ color: '#0284c7', fontWeight: 700 }}><MailOutlined /> Courier Dispatch Manifest</span>}
                style={{ background: '#f0f9ff', borderColor: '#bae6fd', borderRadius: '12px' }}
              >
                <Row gutter={16}>
                  <Col xs={24} md={12}>
                    <Form.Item name="courier_name" label="Courier / Transporter Company Name" rules={[{ required: true }]}>
                      <Input placeholder="E.g., DHL Express, BlueDart" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    <Form.Item name="awb_no" label="Docket / AWB tracking Number" rules={[{ required: true }]}>
                      <Input placeholder="E.g., AWB-99808112" />
                    </Form.Item>
                  </Col>
                </Row>
                <Form.Item name="handover_remarks" label="Delivery Remarks">
                  <Input placeholder="Fragile sticker applied. Consignment receipt attached..." />
                </Form.Item>
              </Card>
            )}

            {dispatchType === 'THIRD_PARTY' && (
              <Alert
                message={<strong style={{ color: '#581c87' }}><SendOutlined /> B2B Freight Bidding Auto-routing Active</strong>}
                description={
                  <div style={{ color: '#6b21a8', fontSize: '12px', marginTop: '4px' }}>
                    This plan will be registered as a draft. Submitting will auto-route you to the B2B Freight Carrier Bidding workspace to raise a transporter RFQ campaign.
                  </div>
                }
                type="info"
                showIcon
                style={{ background: '#faf5ff', borderColor: '#e9d5ff', borderRadius: '8px' }}
              />
            )}
          </div>

          <Card
            title={<span style={{ color: '#475569', fontWeight: 700 }}>SCM Compliance Attachments</span>}
            style={{ marginBottom: '20px', borderRadius: '12px' }}
          >
            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Form.Item name="e_challan" label="e-Challan document">
                  <FormUpload
                    maxCount={1}
                    disabled={isReadOnly}
                    customRequest={async ({ file, onSuccess, onError }) => {
                      try {
                        await handleUploadFile(file, 'e_challan');
                        onSuccess(null, file);
                      } catch (err) {
                        onError(err);
                      }
                    }}
                    showUploadList={true}
                  >
                    <Button icon={<UploadOutlined />} disabled={isReadOnly}>Upload e-Challan</Button>
                  </FormUpload>
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item name="waybill" label="Way Bill document">
                  <FormUpload
                    maxCount={1}
                    disabled={isReadOnly}
                    customRequest={async ({ file, onSuccess, onError }) => {
                      try {
                        await handleUploadFile(file, 'waybill');
                        onSuccess(null, file);
                      } catch (err) {
                        onError(err);
                      }
                    }}
                    showUploadList={true}
                  >
                    <Button icon={<UploadOutlined />} disabled={isReadOnly}>Upload Way Bill</Button>
                  </FormUpload>
                </Form.Item>
              </Col>
            </Row>
          </Card>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '28px' }}>
            {isReadOnly ? (
              <Button type="primary" onClick={() => { setShowDesigner(false); form.resetFields(); setSelectedIssue(null); setIsReadOnly(false); }}>Close</Button>
            ) : (
              <>
                <Button onClick={() => { setShowDesigner(false); form.resetFields(); setSelectedIssue(null); }}>Cancel Plan</Button>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={submitting}
                  style={{
                    background: 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)',
                    borderColor: 'transparent',
                    fontWeight: 'bold',
                    boxShadow: '0 4px 14px 0 rgba(2, 132, 199, 0.15)'
                  }}
                >
                  {dispatchType === 'THIRD_PARTY' ? 'Publish & Route to RFQ' : 'Dispatch'}
                </Button>
              </>
            )}
          </div>
        </Form>
      </Modal>

      {/* SCM Dispatch Plan Ledger collapse */}
      <div style={{ marginTop: '16px' }}>
        <Collapse
          style={{ background: 'transparent', border: 'none' }}
          className="logistics-dark-collapse"
          expandIconPosition="end"
          items={collapseItems}
        />
      </div>

      <style>{`
        /* Top notch UI Animations & Styling - Senior UI Developer approved Light Theme */
        
        .premium-btn:hover {
          transform: translateY(-1px);
          box-shadow: 0 6px 20px 0 rgba(79, 70, 229, 0.25) !important;
          filter: brightness(1.05);
        }

        .logistics-dark-panel {
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
        }
        
        .logistics-dark-panel:hover {
          transform: translateY(-2px);
          border-color: #cbd5e1 !important;
          box-shadow: 0 10px 20px -10px rgba(0, 0, 0, 0.05) !important;
        }

        .ant-collapse-header {
          transition: all 0.3s ease !important;
        }
        .ant-collapse-header:hover {
          background: #f8fafc !important;
        }

        /* Glassmorphic input overrides for premium light feel */
        .premium-dark-form .ant-select-selector {
          background: #ffffff !important;
          border: 1px solid #cbd5e1 !important;
          color: #0f172a !important;
          border-radius: 8px !important;
          height: 42px !important;
          display: flex;
          align-items: center;
          transition: all 0.3s ease;
        }
        .premium-dark-form .ant-select-selector:hover {
          border-color: #4f46e5 !important;
        }
        .premium-dark-form .ant-select-selection-placeholder {
          color: #94a3b8 !important;
        }
        .premium-dark-form .ant-select-arrow {
          color: #4f46e5 !important;
        }
        
        .premium-dark-form .ant-input {
          background: #ffffff !important;
          border: 1px solid #cbd5e1 !important;
          color: #0f172a !important;
          border-radius: 8px !important;
          padding: 9px 14px !important;
          transition: all 0.3s ease;
        }
        .premium-dark-form .ant-input:hover {
          border-color: #4f46e5 !important;
        }
        .premium-dark-form .ant-input:focus, 
        .premium-dark-form .ant-select-focused .ant-select-selector {
          border-color: #4f46e5 !important;
          box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.15) !important;
        }

        .premium-dark-form .ant-picker {
          background: #ffffff !important;
          border: 1px solid #cbd5e1 !important;
          color: #0f172a !important;
          border-radius: 8px !important;
          height: 42px !important;
          transition: all 0.3s ease;
        }
        .premium-dark-form .ant-picker:hover {
          border-color: #4f46e5 !important;
        }
        .premium-dark-form .ant-picker-focused {
          border-color: #4f46e5 !important;
          box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.15) !important;
        }
        .premium-dark-form .ant-picker-input > input {
          color: #0f172a !important;
        }
        .premium-dark-form .ant-picker-suffix {
          color: #4f46e5 !important;
        }

        .form-label-glowing {
          color: #4f46e5;
          font-weight: 600;
        }

        /* Modal custom premium light design overrides */
        .ant-modal-content {
          background: #ffffff !important;
          border: 1px solid #e2e8f0 !important;
          box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1) !important;
          border-radius: 16px !important;
        }
        .ant-modal-header {
          background: transparent !important;
          border-bottom: 1px solid #e2e8f0 !important;
        }
        .ant-modal-title {
          color: #0f172a !important;
        }
        
        /* Neon glowing pulse for security verification modal (Light-adapted) */
        @keyframes modalPulseGlow {
          0% { box-shadow: 0 0 6px rgba(217, 119, 6, 0.15), 0 20px 25px -5px rgba(0,0,0,0.05); }
          50% { box-shadow: 0 0 25px rgba(217, 119, 6, 0.35), 0 20px 25px -5px rgba(0,0,0,0.05); }
          100% { box-shadow: 0 0 6px rgba(217, 119, 6, 0.15), 0 20px 25px -5px rgba(0,0,0,0.05); }
        }
        .premium-glow-modal .ant-modal-content {
          border: 1px solid #fcd34d !important;
          animation: modalPulseGlow 3s infinite ease-in-out;
        }

        .logistics-dark-collapse .ant-collapse-header {
          color: #0f172a !important;
          background: #f8fafc !important;
          border-bottom: 1px solid #cbd5e1 !important;
          padding: 14px 18px !important;
        }
        .logistics-dark-collapse .ant-collapse-content {
          background: #f8fafc !important;
          border-top: none !important;
        }
        .logistics-dark-subtable .ant-table {
          background: #ffffff !important;
          color: #334155 !important;
        }
        .logistics-dark-subtable .ant-table-thead > tr > th {
          background: #f1f5f9 !important;
          color: #475569 !important;
          border-bottom: 1px solid #cbd5e1 !important;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          padding: 6px 10px !important;
        }
        .logistics-dark-subtable .ant-table-tbody > tr > td {
          border-bottom: 1px solid #f1f5f9 !important;
          background: #ffffff !important;
          color: #334155 !important;
          padding: 8px 10px !important;
        }
      `}</style>
    </div>
  );
}
