import React, { useState, useEffect } from 'react';
import {
  Card, Table, Tag, Badge, Button, Modal, Form, Select, DatePicker,
  Input, InputNumber, Switch, Divider, Space, Collapse, Spin, App, Row, Col, Typography, Alert, Upload, Image, Tooltip
} from 'antd';
import {
  FolderAddOutlined, CheckCircleOutlined, PlusOutlined, DeleteOutlined,
  EnvironmentOutlined, GoldOutlined, FilePdfOutlined, CarOutlined,
  UserOutlined, MailOutlined, PhoneOutlined, KeyOutlined, ArrowRightOutlined,
  ClockCircleOutlined, SafetyCertificateOutlined, SendOutlined, UploadOutlined,
  EyeOutlined, SearchOutlined, ArrowLeftOutlined, BarcodeOutlined, GiftOutlined
} from '@ant-design/icons';
import api from '../../config/api';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import { formatNumber, formatDate } from '../../utils/helpers';
import SerialNumbersModal from '../../components/SerialNumbersModal';
import useAuthStore from '../../store/authStore';


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

/**
 * Safely convert a stored image value to a displayable <img src> string.
 *
 * Handles three legitimate cases:
 *   1. Relative upload paths: "/uploads/general/abc.png"  → used as-is (Vite proxy forwards to backend)
 *   2. Absolute HTTP(S) URLs: "https://..."               → used as-is
 *   3. Full data URIs:        "data:image/png;base64,..." → used as-is
 *
 * Legacy records may have a truncated raw base64 blob (the column was VARCHAR(500)).
 * Those are NOT valid URIs and would cause ERR_INVALID_URL, so we return null
 * which lets the caller render a "no image" fallback instead.
 */
export const toImgSrc = (val) => {
  if (!val || typeof val !== 'string') return null;
  const v = val.trim();
  if (v.startsWith('/uploads/') || v.startsWith('http://') || v.startsWith('https://')) return v;
  if (v.startsWith('data:image/') && v.includes(';base64,')) {
    const parts = v.split(',');
    if (parts.length > 1 && !parts[1].includes('.')) {
      return v;
    }
  }
  // Anything else (truncated base64, raw binary, unknown format) — discard.
  return null;
};

export const groupDescription = (desc) => {
  if (!desc) return '';
  const items = desc.split(', ');
  const grouped = {};
  items.forEach(item => {
    const match = item.match(/^(.*?)\s*\((\d+(?:\.\d+)?)\s*(.*?)\)$/);
    if (match) {
      const name = match[1].trim();
      const qty = parseFloat(match[2]);
      const uom = match[3].trim();
      const key = `${name}_${uom}`;
      if (!grouped[key]) {
        grouped[key] = { name, qty: 0, uom };
      }
      grouped[key].qty += qty;
    } else {
      if (!grouped[item]) {
        grouped[item] = { name: item, qty: null, uom: '' };
      }
    }
  });
  return Object.values(grouped).map(g => {
    if (g.qty !== null) {
      const formattedQty = Number(g.qty.toFixed(3));
      return `${g.name} (${formattedQty} ${g.uom})`;
    }
    return g.name;
  }).join(', ');
};

export const groupMaterials = (materials) => {
  if (!materials) return [];
  const grouped = {};
  materials.forEach(m => {
    const key = m.material_id || m.material_code;
    if (!grouped[key]) {
      grouped[key] = {
        ...m,
        quantity: 0,
        number_of_packages: 0,
        batches: new Set(),
        package_types: new Set()
      };
    }
    grouped[key].quantity += Number(m.quantity || 0);
    grouped[key].number_of_packages += Number(m.number_of_packages || 0);
    if (m.batch_number) grouped[key].batches.add(m.batch_number);
    if (m.package_type) grouped[key].package_types.add(m.package_type);
  });
  
  return Object.values(grouped).map((m, idx) => ({
    ...m,
    key: m.material_code || idx,
    batch_number: Array.from(m.batches).join(', ') || m.batch_number,
    package_type: Array.from(m.package_types).join(', ') || m.package_type
  }));
};

export const groupIssueItems = (items) => {
  if (!items) return [];
  const grouped = {};
  items.forEach(item => {
    const key = item.item_id || item.material_id;
    if (!grouped[key]) {
      grouped[key] = {
        ...item,
        qty: 0,
        dispatched_quantity: 0,
        batches: new Set(),
        serial_numbers: []
      };
    }
    grouped[key].qty += Number(item.qty || item.quantity || 0);
    grouped[key].dispatched_quantity += Number(item.dispatched_quantity || item.qty || item.quantity || 0);
    if (item.batch_number) grouped[key].batches.add(item.batch_number);
    if (item.serial_numbers) {
      grouped[key].serial_numbers = [...grouped[key].serial_numbers, ...item.serial_numbers];
    }
  });
  
  return Object.values(grouped).map((item, idx) => ({
    ...item,
    key: item.item_id || idx,
    batch_number: Array.from(item.batches).join(', ') || item.batch_number
  }));
};

export const getMultiLevelStatusText = (mdo) => {
  if (mdo.dispatch_mode !== 'multi-level') {
    return mdo.status === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED' : mdo.status === 'COMPLETED' ? 'DELIVERED' : mdo.status.replace('_', ' ');
  }
  if (mdo.status === 'ACKNOWLEDGED') return 'ACKNOWLEDGED';
  if (mdo.status === 'COMPLETED') return 'DELIVERED';

  const sdos = mdo.sdos || [];
  if (sdos.length === 0) return 'INITIALIZED';

  // Sort SDOs by sequence number
  const sortedSdos = [...sdos].sort((a, b) => (a.sequence_number || 1) - (b.sequence_number || 1));
  
  // Find the current active SDO leg (the one that is pending)
  const pendingSdo = sortedSdos.find(s => s.status === 'PENDING');
  if (pendingSdo) {
    const seq = pendingSdo.sequence_number || 1;
    const destName = pendingSdo.custodian_position_name || 'Custodian';
    if (seq === 1) {
      return `IN TRANSIT (Central to ${destName})`;
    } else {
      const prevSdo = sortedSdos.find(s => s.sequence_number === seq - 1);
      const prevName = prevSdo?.custodian_position_name || 'Previous Leg';
      return `IN TRANSIT (${prevName} to ${destName})`;
    }
  }

  const acknowledgedSdo = [...sortedSdos].reverse().find(s => s.status === 'ACKNOWLEDGED');
  if (acknowledgedSdo) {
    return `AT ${acknowledgedSdo.custodian_position_name || 'Custodian'} (Awaiting Handover)`;
  }

  return mdo.status.replace('_', ' ');
};

export const getMultiLevelStatusColor = (mdo) => {
  if (mdo.dispatch_mode !== 'multi-level') {
    return mdo.status === 'ACKNOWLEDGED' ? 'success' :
      mdo.status === 'COMPLETED' ? 'cyan' :
      mdo.status === 'IN_TRANSIT' ? 'magenta' :
      mdo.status === 'DISPATCHED' ? 'blue' :
      mdo.status === 'CONFIRMED' ? 'purple' :
      mdo.status === 'APPROVED' ? 'indigo' :
      'warning';
  }
  if (mdo.status === 'ACKNOWLEDGED') return 'success';
  if (mdo.status === 'COMPLETED') return 'cyan';
  const text = getMultiLevelStatusText(mdo);
  if (text.startsWith('IN TRANSIT')) return 'magenta';
  if (text.startsWith('AT ')) return 'orange';
  return 'warning';
};

const FormUpload = ({ value, ...props }) => <Upload {...props} />;

export default function LogisticsDispatch() {
  const navigate = useNavigate();
  const { message } = App.useApp();
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
  const dispatchMode = Form.useWatch('dispatch_mode', form) || 'direct';
  const [uploadedUrls, setUploadedUrls] = useState({});
  const [selectedMdo, setSelectedMdo] = useState(null);
  const [chainPreview, setChainPreview] = useState(null);
  const [loadingChain, setLoadingChain] = useState(false);

  const [receiveLegModalOpen, setReceiveLegModalOpen] = useState(false);
  const [handoverLegModalOpen, setHandoverLegModalOpen] = useState(false);
  const [activeSdo, setActiveSdo] = useState(null);
  const [receiptPhotos, setReceiptPhotos] = useState([]);
  const [receiptSignature, setReceiptSignature] = useState('');
  const [handoverPhotos, setHandoverPhotos] = useState([]);
  const [handoverSignature, setHandoverSignature] = useState('');
  const [receiveForm] = Form.useForm();
  const [handoverForm] = Form.useForm();
  const currentUser = useAuthStore((s) => s.user);
  const hasKey = useAuthStore((s) => s.hasKey);

  const uploadImageFile = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('entity_type', 'general');
    const response = await api.post('/attachments/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data.url || response.data.file_path;
  };


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
  const [linkedConsignment, setLinkedConsignment] = useState(null);
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
      const canViewIssues = hasKey('warehouse-material-issues');
      const canViewIndents = hasKey('indent-indents');

      const [mdoRes, masterRes, issuesRes, indentRes] = await Promise.all([
        api.get('/logistics/mdo').catch(err => {
          console.error("Error fetching MDOs:", err);
          return { data: [] };
        }),
        api.get('/logistics/masters').catch(err => {
          console.error("Error fetching masters:", err);
          return { data: null };
        }),
        canViewIssues
          ? api.get('/warehouse/material-issues', { params: { page_size: 100, status: 'issued' } }).catch(err => {
              console.warn("Error fetching material issues (could be permission 403):", err);
              return { data: { items: [] } };
            })
          : Promise.resolve({ data: { items: [] } }),
        canViewIndents
          ? api.get('/indents', { params: { page_size: 100, available_for_issue: true } }).catch(err => {
              console.warn("Error fetching indents:", err);
              return { data: { items: [] } };
            })
          : Promise.resolve({ data: { items: [] } })
      ]);

      setMdos(mdoRes.data || []);
      setMasters(masterRes.data || null);

      const issuesList = (issuesRes && issuesRes.data) ? (issuesRes.data.items || issuesRes.data.data || issuesRes.data || []) : [];
      setMaterialIssues(Array.isArray(issuesList) ? issuesList.filter(i => i && i.status === 'issued') : []);

      const indentsList = (indentRes && indentRes.data) ? (indentRes.data.items || indentRes.data.data || indentRes.data || []) : [];
      setIndents(Array.isArray(indentsList) ? indentsList.map(i => ({ label: i.indent_number, value: i.id })) : []);
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


  const fetchChainPreview = async (materialIssueId, destWarehouseId = null, destUserId = null) => {
    if (!materialIssueId) {
      setChainPreview(null);
      return;
    }
    setLoadingChain(true);
    try {
      const params = { material_issue_id: materialIssueId };
      if (destWarehouseId) params.destination_warehouse_id = destWarehouseId;
      if (destUserId) params.destination_user_id = destUserId;
      const res = await api.get('/logistics/preview-dispatch-chain', { params });
      setChainPreview(res.data);
    } catch (err) {
      console.error('Failed to fetch chain preview:', err);
      setChainPreview(null);
    } finally {
      setLoadingChain(false);
    }
  };

  useEffect(() => {
    if (dispatchMode === 'multi-level' && selectedIssue?.id) {
      fetchChainPreview(selectedIssue.id);
    } else if (dispatchMode === 'direct') {
      setChainPreview(null);
    }
  }, [dispatchMode, selectedIssue?.id]);


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
      if (issueId && (form.getFieldValue('dispatch_mode') || 'direct') === 'multi-level') {
        fetchChainPreview(issueId);
      }
      // Fetch consignment packages for the selected MI
      try {
        const conRes = await api.get('/consignment/by-mi/' + issueId);
        if (conRes.data && conRes.data.length > 0) {
          const conData = conRes.data[0];
          const conDetailRes = await api.get('/consignment/' + conData.id);
          const conDetail = conDetailRes.data;
          setLinkedConsignment(conDetail);

          // Build a detailed description using package details
          const pkgsInfo = (conDetail.packages || []).map((pkg, idx) => {
            const dimStr = (pkg.length_cm && pkg.width_cm && pkg.height_cm) 
              ? `${pkg.length_cm}x${pkg.width_cm}x${pkg.height_cm} cm`
              : 'N/A';
            return `Pkg #${idx+1} [${pkg.package_type}]: Weight: ${pkg.gross_weight_kg || 0} kg, Dim: ${dimStr}, Seal: ${pkg.seal_number || 'N/A'}`;
          }).join(' | ');

          const computedDesc = `Total Packages: ${conDetail.total_packages || 0}. Details: ${pkgsInfo}`;

          form.setFieldsValue({
            items_description: computedDesc,
            logistics_weight: parseFloat(conDetail.total_weight_kg || 0),
            logistics_volume: parseFloat(conDetail.total_volume_cft || 0),
          });
        } else {
          setLinkedConsignment(null);
        }
      } catch (e) {
        console.warn('No consignment found for this MI:', e);
        setLinkedConsignment(null);
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
    setSelectedMdo(mdo);

    let issueData = null;
    try {
      setLoadingDetails(true);
      if (!hasKey('warehouse-material-issues')) {
        throw new Error("Permission 'warehouse-material-issues' missing, falling back to local MDO materials.");
      }
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
        if (!indents.some(i => i.value === indentData.id)) {
          setIndents(prev => [...prev, { label: indentData.indent_number, value: indentData.id }]);
        }
      } else {
        setSelectedIndent(null);
        setSelectedIndentItems([]);
      }
    } catch (err) {
      console.warn("[LogisticsDispatch] Falling back to local MDO materials (permission or network issue):", err?.message || err);
      issueData = {
        id: mdo.material_issue_id,
        issue_number: mdo.material_issue_number || `MI-ID: ${mdo.material_issue_id}`,
        items: (mdo.materials || []).map(m => ({
          id: m.id,
          item_id: m.material_id,
          qty: m.quantity,
          uom_name: m.unit_of_measure,
          item_name: m.material_name,
          item_code: m.material_code,
          batch_number: m.batch_number,
          serial_numbers: m.serial_numbers
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
      
      if (mdo.indent_id) {
        const indentData = {
          id: mdo.indent_id,
          indent_number: mdo.indent_number || `IND-ID: ${mdo.indent_id}`,
          warehouse_name: mdo.destination_warehouse_name || mdo.warehouse_name || 'Destination Warehouse',
          raised_by_name: mdo.destination_user_name || mdo.creator_name || 'Consignee'
        };
        setSelectedIndent(indentData);
        setSelectedIndentItems((mdo.materials || []).map(m => ({
          id: m.id,
          item_name: m.material_name,
          item_code: m.material_code,
          requested_qty: m.quantity,
          required_date: mdo.required_delivery_date,
          key: m.id || Math.random()
        })));
        if (!indents.some(i => i.value === indentData.id)) {
          setIndents(prev => [...prev, { label: indentData.indent_number, value: indentData.id }]);
        }
      } else {
        setSelectedIndent(null);
        setSelectedIndentItems([]);
      }
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
      dispatch_mode: mdo.dispatch_mode || 'direct',

      driver_name: mdo.handover?.driver_name,
      driver_phone: mdo.handover?.driver_phone,
      received_by_name: mdo.handover?.received_by_name,
      received_by_phone: mdo.handover?.received_by_phone,
      received_by_emp_code: mdo.handover?.received_by_emp_code,
      received_by_aadhar_no: mdo.handover?.received_by_aadhar_no,
      received_by_designation: mdo.handover?.received_by_designation,
      vehicle_no: mdo.handover?.vehicle_no,
      courier_name: mdo.handover?.courier_name,
      awb_no: mdo.handover?.awb_no,
      handover_remarks: mdo.handover?.remarks
    });

    if (mdo.dispatch_mode === 'multi-level' && mdo.material_issue_id) {
      fetchChainPreview(mdo.material_issue_id, mdo.destination_warehouse_id, mdo.destination_user_id);
    } else {
      setChainPreview(null);
    }

    // Fetch consignment packages for the selected MI
    if (mdo.material_issue_id) {
      try {
        const conRes = await api.get('/consignment/by-mi/' + mdo.material_issue_id);
        if (conRes.data && conRes.data.length > 0) {
          const conData = conRes.data[0];
          const conDetailRes = await api.get('/consignment/' + conData.id);
          setLinkedConsignment(conDetailRes.data);
        } else {
          setLinkedConsignment(null);
        }
      } catch (e) {
        console.warn('No consignment found for this MI:', e);
        setLinkedConsignment(null);
      }
    }

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

      const payload = {
        warehouseId: selectedIssue.warehouse_id,
        priority: values.priority || 'MEDIUM',
        specialInstructions: serializedInstructions,
        materials: consignmentMaterials,
        dispatch_mode: values.dispatch_mode || 'direct',
        material_issue_id: selectedIssue.id,
        indent_id: selectedIssue.indent_id,
        destination_warehouse_id: selectedIssue.destination_warehouse_id,
        delivery_address: serializedAddress,
        e_challan: dispatchType === 'THIRD_PARTY' ? null : (uploadedUrls.e_challan || 'https://bhspl-scm.s3.amazonaws.com/challans/E-CHL2026.pdf'),
        waybill: dispatchType === 'THIRD_PARTY' ? null : (uploadedUrls.waybill || 'https://bhspl-scm.s3.amazonaws.com/waybills/E-WAY2026.pdf'),
        dispatch_type: dispatchType,

        // Handover details (if not RFQ)
        courier_name: values.courier_name,
        awb_no: values.awb_no,
        vehicle_no: values.vehicle_no,
        driver_name: values.driver_name,
        driver_phone: values.driver_phone ? values.driver_phone.replace(/[\s\-()]/g, '') : undefined,
        received_by_name: values.received_by_name,
        received_by_phone: values.received_by_phone ? values.received_by_phone.replace(/[\s\-()]/g, '') : undefined,
        received_by_emp_code: values.received_by_emp_code,
        received_by_aadhar_no: values.received_by_aadhar_no ? values.received_by_aadhar_no.replace(/\s/g, '') : undefined,
        received_by_designation: values.received_by_designation,
        handover_remarks: uploadedUrls.receiver_signature
          ? `RECEIVER_SIGNATURE: ${uploadedUrls.receiver_signature} | REMARKS: ${values.handover_remarks || 'Standard handover clearance completed.'}`
          : (values.handover_remarks || 'Standard handover clearance completed.')
      };

      const res = await api.post('/logistics/mdo', payload);
      const newMdoNum = res.data.mdo_number;

      message.success(`Dispatch Plan ${newMdoNum} saved successfully!`);

      if (dispatchType === 'THIRD_PARTY') {
        message.info("Routing directly to the Freight Bidding Desk (RFQ)...");
        setShowDesigner(false);
        form.resetFields();
        setSelectedIssue(null);
        setSelectedIndent(null);
        setSelectedIndentItems([]);
        setSelectedIssueItems([]);
        setUploadedUrls({});
        navigate('/logistics/rfq', { state: { openPublisher: true } });
      } else {
        setShowDesigner(false);
        form.resetFields();
        setSelectedIssue(null);
        setSelectedIndent(null);
        setSelectedIndentItems([]);
        setSelectedIssueItems([]);
        setUploadedUrls({});
        await fetchData();
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#020617' }}>
        <Spin size="large" />
        <span style={{ color: '#94a3b8', fontSize: 16 }}>Loading Dispatch Plan ledger...</span>
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
              color={getMultiLevelStatusColor(mdo)}
              style={{ border: 'none', fontWeight: 700, borderRadius: '4px' }}
            >
              {getMultiLevelStatusText(mdo)}
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
                  <Button type="link" icon={<FilePdfOutlined />} href={mdo.e_challan} target="_blank" style={{ color: '#ef4444', fontWeight: 600, padding: 0 }}>Delivery Challan</Button>
                )}
                {mdo.waybill && (
                  <Button type="link" icon={<FilePdfOutlined />} href={mdo.waybill} target="_blank" style={{ color: '#ef4444', fontWeight: 600, padding: 0 }}>Deliverable Document</Button>
                )}
              </Col>
            </Row>
            <Row gutter={[16, 16]} style={{ marginBottom: '16px', borderBottom: '1px solid #cbd5e1', paddingBottom: '14px' }}>
              <Col xs={24} md={12}>
                <span style={{ fontSize: '10px', fontFamily: 'monospace', color: '#64748b', display: 'block', textTransform: 'uppercase', marginBottom: '4px' }}>Items Description</span>
                <span style={{ fontSize: '13px', color: '#475569', fontWeight: 500 }}>{groupDescription(inst.desc) || 'SCM Materials'}</span>
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
              {mdo.status === 'DISPATCHED' && mdo.dispatch_mode !== 'multi-level' && (
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

              {mdo.status === 'ACKNOWLEDGED' && (
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
                  <span style={{ color: '#15803d', fontSize: '12px', fontWeight: 600 }}>✅ Delivery has been acknowledged successfully by the receiver. Click "View details" to inspect Proof of Delivery (POD) signatures and photos.</span>
                </div>
              )}

              {mdo.status === 'COMPLETED' && (
                <div style={{
                  background: '#f0fdf4',
                  border: '1px solid #16a34a',
                  padding: '14px',
                  borderRadius: '8px',
                  marginBottom: '16px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '12px'
                }}>
                  <span style={{ color: '#15803d', fontSize: '12px', fontWeight: 600 }}>✅ Delivery completed! All custody legs have been acknowledged and the consignment has been received at the destination warehouse.</span>
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
                    items: mdo.materials || []
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

          {/* SDO sections list — show materials for every SDO leg */}
          <Row gutter={[12, 12]}>
            {mdo.sdos.map((sdo, sdoIdx) => {
              // Materials are stored at MDO level (sdo_id is null), so fall back
              // to the SDO's own materials first, then MDO-level materials.
              const sdoMaterials = (sdo.materials && sdo.materials.length > 0)
                ? sdo.materials
                : (mdo.materials || []);
              return (
                <Col key={sdo.id} xs={24}>
                  <Card
                    size="small"
                    title={
                      <span style={{ fontSize: '12px', fontWeight: 700, color: '#334155' }}>
                        <span style={{ 
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: '20px', height: '20px', borderRadius: '50%',
                          background: sdo.status === 'HANDED_OVER' ? '#4f46e5' : sdo.status === 'ACKNOWLEDGED' ? '#0ea5e9' : '#94a3b8',
                          color: '#fff', fontSize: '10px', fontWeight: 'bold', marginRight: '8px'
                        }}>
                          {sdoIdx + 1}
                        </span>
                        {sdo.sdo_number || `SDO ${sdoIdx + 1}`} — {sdo.custodian_position_name || 'Custodian'}
                        <Tag 
                          color={sdo.status === 'HANDED_OVER' ? 'purple' : sdo.status === 'ACKNOWLEDGED' ? 'blue' : 'warning'}
                          style={{ marginLeft: '8px', fontSize: '10px' }}
                        >
                          {sdo.status}
                        </Tag>
                      </span>
                    }
                    style={{ background: '#ffffff', borderColor: '#e2e8f0', borderRadius: '8px' }}
                  >
                    {/* BOM list table */}
                    <Table
                      dataSource={groupMaterials(sdoMaterials)}
                      size="small"
                      pagination={false}
                      rowKey="key"
                      className="logistics-dark-subtable"
                      columns={[
                        { title: 'Code', dataIndex: 'material_code', key: 'code', render: t => <span style={{ fontFamily: 'monospace', color: '#334155' }}>{t}</span> },
                        { title: 'Name', dataIndex: 'material_name', key: 'name', render: text => <span style={{ color: '#0f172a', fontWeight: 500 }}>{text}</span> },
                        { title: 'Quantity', dataIndex: 'quantity', key: 'qty', render: (q, r) => <span style={{ fontFamily: 'monospace', color: '#4f46e5', fontWeight: 600 }}>{q} {r.unit_of_measure}</span> },
                        { title: 'Batch', dataIndex: 'batch_number', key: 'batch', render: t => <span style={{ fontFamily: 'monospace' }}>{t}</span> },
                        { title: 'Packages', key: 'pkgs', render: (_, r) => <span>{r.number_of_packages}x {r.package_type}</span> },
                        {
                          title: 'Conditions',
                          key: 'conditions',
                          render: (_, r) => (
                            <Space size={[4, 4]} wrap>
                              {r.special_storage_condition && (
                                <Tooltip title={`Storage Temp: ${r.storage_min_temp ?? '-∞'} to ${r.storage_max_temp ?? '∞'} °C | Moisture: ${r.storage_min_moisture ?? 0}% to ${r.storage_max_moisture ?? 100}%`}>
                                  <Tag color="blue" style={{ fontSize: '10px', borderRadius: '4px', margin: 0 }}>
                                    Storage: {r.storage_min_temp ?? '*'} to {r.storage_max_temp ?? '*'}°C
                                  </Tag>
                                </Tooltip>
                              )}
                              {r.special_storage_condition && r.storage_breakable && (
                                <Tag color="red" style={{ fontSize: '10px', borderRadius: '4px', margin: 0 }}>Fragile Store</Tag>
                              )}
                              {r.special_transport_condition && (
                                <Tooltip title={`Transit Temp: ${r.transport_min_temp ?? '-∞'} to ${r.transport_max_temp ?? '∞'} °C | Moisture: ${r.transport_min_moisture ?? 0}% to ${r.transport_max_moisture ?? 100}%`}>
                                  <Tag color="cyan" style={{ fontSize: '10px', borderRadius: '4px', margin: 0 }}>
                                    Transit: {r.transport_min_temp ?? '*'} to {r.transport_max_temp ?? '*'}°C
                                  </Tag>
                                </Tooltip>
                              )}
                              {r.special_transport_condition && r.transport_breakable && (
                                <Tag color="volcano" style={{ fontSize: '10px', borderRadius: '4px', margin: 0 }}>Fragile Transit</Tag>
                              )}
                              {!r.special_storage_condition && !r.special_transport_condition && (
                                <span style={{ color: '#94a3b8', fontSize: '11px' }}>Standard</span>
                              )}
                            </Space>
                          )
                        }
                      ]}
                    />
                  </Card>
                </Col>
              );
            })}
          </Row>
        </div>
      )
    };
  });

  const renderCustodyTimeline = () => {
    if (!selectedMdo) return null;
    
    const isMultiLevel = selectedMdo.dispatch_mode === 'multi-level';
    const sdos = selectedMdo.sdos || [];
    const sortedSdos = [...sdos].sort((a, b) => (a.sequence_number || 1) - (b.sequence_number || 1));

    // Build a merged timeline: combine actual SDO legs with chain preview positions
    // so view-only and destination positions are visible alongside real custody legs.
    const sdoPositionIds = new Set(sortedSdos.map(s => s.custodian_position_id));
    const previewChain = (isMultiLevel && chainPreview?.chain) ? chainPreview.chain : [];

    // Remaining chain positions not yet materialised as SDOs
    const remainingChainPositions = previewChain.filter(cp => !sdoPositionIds.has(cp.position_id));

    // Total legs = actual SDOs + remaining chain positions
    const totalLegs = sortedSdos.length + remainingChainPositions.length;
    
    return (
      <Card 
        title={<span style={{ color: '#0f172a', fontWeight: 800 }}>Custody Transfer Legs & State Transitions</span>}
        style={{ marginTop: '20px', borderRadius: '12px', border: '1px solid #cbd5e1', background: '#f8fafc' }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Source entry */}
          <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: '#10b981', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
                WH
              </div>
              <div style={{ width: '2px', height: '40px', background: '#cbd5e1' }} />
            </div>
            <div>
              <strong style={{ color: '#0f172a' }}>Source Warehouse: {selectedMdo.warehouse_name || 'Loading Dock'}</strong>
              <div style={{ fontSize: '12px', color: '#64748b' }}>Consignment initialized on {formatDate(selectedMdo.order_date)}</div>
            </div>
          </div>

          {/* Render SDO legs */}
          {sortedSdos.map((sdo, idx) => {
            // Check ALL positions the user holds (not just primary) so a DM with
            // multiple positions can still see the acknowledge / handover buttons.
            const userPositionIds = new Set(
              (currentUser?.positions || []).map(p => p.id)
            );
            if (currentUser?.position_id) userPositionIds.add(currentUser.position_id);
            const isUserCustodian = userPositionIds.has(sdo.custodian_position_id) || ['admin', 'super_admin', 'logistics_manager'].includes(currentUser?.role);
            const isLastSdo = idx === sortedSdos.length - 1;
            const hasRemaining = remainingChainPositions.length > 0;
            // View-only remaining positions don't block final delivery detection.
            // The last SDO is the final delivery leg if there are no remaining
            // approve/destination positions (only view-only observers left).
            const hasRemainingApproveLegs = remainingChainPositions.some(cp => !cp.view_only);
            const isFinalDeliveryLeg = isLastSdo && !hasRemainingApproveLegs;
            
            return (
              <div key={sdo.id} style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ 
                    width: '32px', 
                    height: '32px', 
                    borderRadius: '50%', 
                    background: sdo.status === 'HANDED_OVER' ? '#4f46e5' : sdo.status === 'ACKNOWLEDGED' ? '#0ea5e9' : '#cbd5e1', 
                    color: '#fff', 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center', 
                    fontWeight: 'bold'
                  }}>
                    {idx + 1}
                  </div>
                  {(isLastSdo && hasRemaining) && <div style={{ width: '2px', height: '60px', background: '#cbd5e1', borderStyle: 'dashed' }} />}
                  {(isLastSdo && !hasRemaining && idx < sortedSdos.length - 1) && <div style={{ width: '2px', height: '60px', background: '#cbd5e1' }} />}
                  {!isLastSdo && <div style={{ width: '2px', height: '60px', background: '#cbd5e1' }} />}
                </div>
                <div style={{ flex: 1, background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '16px', boxShadow: '0 2px 8px rgba(0,0,0,0.02)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                    <div>
                      <strong style={{ color: '#0f172a', fontSize: '14px' }}>
                        Leg {sdo.sequence_number || idx + 1}: {sdo.custodian_position_name || 'Custodian Position'}
                      </strong>
                      <div style={{ fontSize: '12px', color: '#475569', fontWeight: 500 }}>
                        {sdo.received_by_name ? `Custodian Employee: ${sdo.received_by_name}` : 'Awaiting Custody'}
                      </div>
                    </div>
                    <Tag color={
                      sdo.status === 'HANDED_OVER' ? 'purple' :
                      sdo.status === 'ACKNOWLEDGED' ? 'blue' :
                      'warning'
                    } style={{ fontWeight: 'bold' }}>
                      {sdo.status}
                    </Tag>
                  </div>
                  
                  {/* Action buttons */}
                  <div style={{ marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {sdo.status === 'PENDING' && isUserCustodian && (
                      <Button 
                        type="primary" 
                        size="small" 
                        icon={isFinalDeliveryLeg ? <EnvironmentOutlined /> : <CheckCircleOutlined />}
                        style={{ 
                          background: isFinalDeliveryLeg ? '#059669' : '#0284c7', 
                          borderColor: isFinalDeliveryLeg ? '#059669' : '#0284c7', 
                          fontWeight: 600 
                        }}
                        onClick={() => {
                          if (isFinalDeliveryLeg) {
                            navigate(`/logistics/dispatch-orders/${selectedMdo.mdo_number}/acknowledge`);
                          } else {
                            setActiveSdo(sdo);
                            setReceiveLegModalOpen(true);
                          }
                        }}
                      >
                        {isFinalDeliveryLeg ? 'Acknowledge Delivery' : 'Acknowledge Dispatch'}
                      </Button>
                    )}
                    {sdo.status === 'ACKNOWLEDGED' && selectedMdo.status !== 'COMPLETED' && isUserCustodian && !isFinalDeliveryLeg && (
                      <Button 
                        type="primary" 
                        size="small"
                        icon={<SendOutlined />}
                        style={{ background: '#4f46e5', borderColor: '#4f46e5', fontWeight: 600 }}
                        onClick={() => {
                          setActiveSdo(sdo);
                          setHandoverLegModalOpen(true);
                        }}
                      >
                        Handover Leg
                      </Button>
                    )}
                  </div>

                  {/* Acknowledge (Receipt) Details Logs */}
                  {sdo.status !== 'PENDING' && (
                    <div style={{ marginTop: '12px', borderTop: '1px solid #f1f5f9', paddingTop: '12px' }}>
                      <Row gutter={[16, 12]}>
                        <Col xs={24} sm={12}>
                          <span style={{ fontSize: '11px', color: '#64748b', display: 'block' }}>RECEIVED BY</span>
                          <strong style={{ fontSize: '12px', color: '#334155' }}>{sdo.received_by_name || 'System / Admin'}</strong>
                        </Col>
                        <Col xs={24} sm={12}>
                          <span style={{ fontSize: '11px', color: '#64748b', display: 'block' }}>RECEIVED AT</span>
                          <strong style={{ fontSize: '12px', color: '#334155' }}>{formatDate(sdo.received_at)}</strong>
                        </Col>
                        <Col xs={12} sm={8}>
                          <span style={{ fontSize: '11px', color: '#64748b', display: 'block' }}>SEAL INTACT</span>
                          <strong style={{ fontSize: '12px', color: sdo.seal_intact ? '#16a34a' : '#ef4444' }}>{sdo.seal_intact ? 'YES' : 'NO'}</strong>
                        </Col>
                        <Col xs={12} sm={8}>
                          <span style={{ fontSize: '11px', color: '#64748b', display: 'block' }}>PACKAGING</span>
                          <strong style={{ fontSize: '12px', color: '#334155' }}>{sdo.packaging_condition}</strong>
                        </Col>
                        <Col xs={24} sm={8}>
                          <span style={{ fontSize: '11px', color: '#64748b', display: 'block' }}>DISCREPANCY REPORTED</span>
                          <strong style={{ fontSize: '12px', color: sdo.discrepancy_reported ? '#ef4444' : '#16a34a' }}>{sdo.discrepancy_reported ? 'YES' : 'NO'}</strong>
                        </Col>
                        {sdo.receiving_remarks && (
                          <Col span={24}>
                            <span style={{ fontSize: '11px', color: '#64748b', display: 'block' }}>RECEIVING REMARKS</span>
                            <span style={{ fontSize: '12px', color: '#475569' }}>{sdo.receiving_remarks}</span>
                          </Col>
                        )}
                        
                        <Col xs={24} md={12}>
                          <span style={{ fontSize: '11px', color: '#64748b', display: 'block', marginBottom: '6px' }}>Receipt Photos</span>
                          {sdo.receipt_photos && sdo.receipt_photos.length > 0 ? (
                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                              {sdo.receipt_photos.map((p, pIdx) => (
                                <React.Fragment key={pIdx}>
                                  {toImgSrc(p) ? (
                                    <Image
                                      src={toImgSrc(p)}
                                      alt="Receipt Photo"
                                      style={{ width: '60px', height: '60px', objectFit: 'cover', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                                    />
                                  ) : (
                                    <span style={{ fontSize: '11px', color: '#94a3b8' }}>Invalid image</span>
                                  )}
                                </React.Fragment>
                              ))}
                            </div>
                          ) : (
                            <span style={{ fontSize: '11px', color: '#94a3b8' }}>No photos uploaded</span>
                          )}
                        </Col>
                        <Col xs={24} md={12}>
                          <span style={{ fontSize: '11px', color: '#64748b', display: 'block', marginBottom: '6px' }}>Receipt Signature</span>
                          {toImgSrc(sdo.receipt_signature) ? (
                            <Image
                              src={toImgSrc(sdo.receipt_signature)}
                              alt="Receipt Signature"
                              style={{ height: '40px', maxWidth: '120px', objectFit: 'contain', border: '1px dashed #cbd5e1', padding: '2px', background: '#fff' }}
                            />
                          ) : (
                            <span style={{ fontSize: '11px', color: '#94a3b8' }}>No signature uploaded</span>
                          )}
                        </Col>
                      </Row>
                    </div>
                  )}

                  {/* Handover Details Logs */}
                  {sdo.status === 'HANDED_OVER' && (
                    <div style={{ marginTop: '12px', borderTop: '1px solid #f1f5f9', paddingTop: '12px', background: '#fafafa', padding: '10px', borderRadius: '6px' }}>
                      <Row gutter={[16, 12]}>
                        <Col xs={24} sm={12}>
                          <span style={{ fontSize: '11px', color: '#64748b', display: 'block' }}>HANDED OVER BY</span>
                          <strong style={{ fontSize: '12px', color: '#334155' }}>{sdo.handed_over_by_name || 'System / Admin'}</strong>
                        </Col>
                        <Col xs={24} sm={12}>
                          <span style={{ fontSize: '11px', color: '#64748b', display: 'block' }}>HANDOVER TIME</span>
                          <strong style={{ fontSize: '12px', color: '#334155' }}>{formatDate(sdo.handover_time)}</strong>
                        </Col>
                        <Col xs={12} sm={8}>
                          <span style={{ fontSize: '11px', color: '#64748b', display: 'block' }}>HANDOVER TYPE</span>
                          <strong style={{ fontSize: '12px', color: '#334155' }}>{sdo.handover_type?.toUpperCase()}</strong>
                        </Col>
                        
                        {sdo.carrier_details && (
                          <>
                            {sdo.handover_type === 'own vehicle' && (
                              <>
                                <Col xs={12} sm={8}>
                                  <span style={{ fontSize: '11px', color: '#64748b', display: 'block' }}>VEHICLE NO</span>
                                  <strong style={{ fontSize: '12px', color: '#334155' }}>{sdo.carrier_details.vehicle_no || '—'}</strong>
                                </Col>
                                <Col xs={24} sm={8}>
                                  <span style={{ fontSize: '11px', color: '#64748b', display: 'block' }}>DRIVER</span>
                                  <strong style={{ fontSize: '12px', color: '#334155' }}>{sdo.carrier_details.driver_name} ({sdo.carrier_details.driver_phone})</strong>
                                </Col>
                              </>
                            )}
                            {sdo.handover_type === 'COURIER' && (
                              <>
                                <Col xs={12} sm={8}>
                                  <span style={{ fontSize: '11px', color: '#64748b', display: 'block' }}>COURIER CO</span>
                                  <strong style={{ fontSize: '12px', color: '#334155' }}>{sdo.carrier_details.courier_name || '—'}</strong>
                                </Col>
                                <Col xs={24} sm={8}>
                                  <span style={{ fontSize: '11px', color: '#64748b', display: 'block' }}>AWB NO</span>
                                  <strong style={{ fontSize: '12px', color: '#334155' }}>{sdo.carrier_details.awb_no || '—'}</strong>
                                </Col>
                              </>
                            )}
                            {sdo.handover_type === 'IN_PERSON' && (
                              <Col xs={24} sm={16}>
                                <span style={{ fontSize: '11px', color: '#64748b', display: 'block' }}>RECEIVER</span>
                                <strong style={{ fontSize: '12px', color: '#334155' }}>{sdo.carrier_details.received_by_name} ({sdo.carrier_details.received_by_phone})</strong>
                              </Col>
                            )}
                            {sdo.carrier_details.remarks && (
                              <Col span={24}>
                                <span style={{ fontSize: '11px', color: '#64748b', display: 'block' }}>HANDOVER REMARKS</span>
                                <span style={{ fontSize: '12px', color: '#475569' }}>{sdo.carrier_details.remarks}</span>
                              </Col>
                            )}
                          </>
                        )}
                        
                        <Col xs={24} md={12}>
                          <span style={{ fontSize: '11px', color: '#64748b', display: 'block', marginBottom: '6px' }}>Materials Photos</span>
                          {sdo.handover_photos && sdo.handover_photos.length > 0 ? (
                            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                              {sdo.handover_photos.map((p, pIdx) => (
                                <React.Fragment key={pIdx}>
                                  {toImgSrc(p) ? (
                                    <Image
                                      src={toImgSrc(p)}
                                      alt="Materials Photo"
                                      style={{ width: '60px', height: '60px', objectFit: 'cover', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                                    />
                                  ) : (
                                    <span style={{ fontSize: '11px', color: '#94a3b8' }}>Invalid image</span>
                                  )}
                                </React.Fragment>
                              ))}
                            </div>
                          ) : (
                            <span style={{ fontSize: '11px', color: '#94a3b8' }}>No photos uploaded</span>
                          )}
                        </Col>
                        <Col xs={24} md={12}>
                          <span style={{ fontSize: '11px', color: '#64748b', display: 'block', marginBottom: '6px' }}>Handover Signature</span>
                          {toImgSrc(sdo.handover_signature) ? (
                            <Image
                              src={toImgSrc(sdo.handover_signature)}
                              alt="Handover Signature"
                              style={{ height: '40px', maxWidth: '120px', objectFit: 'contain', border: '1px dashed #cbd5e1', padding: '2px', background: '#fff' }}
                            />
                          ) : (
                            <span style={{ fontSize: '11px', color: '#94a3b8' }}>No signature uploaded</span>
                          )}
                        </Col>
                      </Row>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Remaining preview chain — view-only positions and destination */}
          {remainingChainPositions.map((chainPos, idx) => {
            const legNum = sortedSdos.length + idx + 1;
            const isDestination = chainPos.is_destination;
            const isViewOnly = chainPos.view_only;
            const isLast = idx === remainingChainPositions.length - 1;

            // View-only positions: displayed for hierarchy visibility, no actions
            if (isViewOnly && !isDestination) {
              return (
                <div key={`viewonly-${legNum}`} style={{ display: 'flex', gap: '16px', alignItems: 'flex-start', opacity: 0.5 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{ 
                      width: '32px', height: '32px', borderRadius: '50%', 
                      background: '#f1f5f9', color: '#94a3b8', 
                      display: 'flex', alignItems: 'center', justifyContent: 'center', 
                      fontWeight: 'bold', border: '2px solid #cbd5e1'
                    }}>
                      <EyeOutlined />
                    </div>
                    {!isLast && <div style={{ width: '2px', height: '40px', background: '#cbd5e1', borderStyle: 'dashed' }} />}
                  </div>
                  <div style={{ flex: 1, background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: '10px', padding: '12px 16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                      <div>
                        <strong style={{ color: '#64748b', fontSize: '14px' }}>
                          {chainPos.position_name} ({chainPos.role_name})
                        </strong>
                        <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                          {chainPos.employee_name ? `${chainPos.employee_name} (${chainPos.employee_code})` : 'Unassigned'}
                        </div>
                      </div>
                      <Tag color="default" style={{ fontWeight: 'bold', borderStyle: 'dashed' }}>
                        <EyeOutlined /> VIEW ONLY
                      </Tag>
                    </div>
                    <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                      This position has view access only — no acknowledgement or handover actions.
                    </div>
                  </div>
                </div>
              );
            }

            // Destination position: Acknowledge Delivery for final delivery
            if (isDestination) {
              return (
                <div key={`dest-${legNum}`} style={{ display: 'flex', gap: '16px', alignItems: 'flex-start', opacity: 0.7 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <div style={{ 
                      width: '32px', height: '32px', borderRadius: '50%', 
                      background: '#f1f5f9', color: '#059669', 
                      display: 'flex', alignItems: 'center', justifyContent: 'center', 
                      fontWeight: 'bold', border: '2px dashed #059669'
                    }}>
                      <EnvironmentOutlined />
                    </div>
                  </div>
                  <div style={{ flex: 1, background: '#ecfdf5', border: '1px dashed #059669', borderRadius: '10px', padding: '12px 16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                      <div>
                        <strong style={{ color: '#065f46', fontSize: '14px' }}>
                          Destination: {chainPos.position_name} ({chainPos.role_name})
                        </strong>
                        <div style={{ fontSize: '11px', color: '#047857' }}>
                          {chainPos.employee_name ? `${chainPos.employee_name} (${chainPos.employee_code})` : 'Destination Warehouse User'}
                        </div>
                      </div>
                      {selectedMdo.status !== 'COMPLETED' && selectedMdo.status !== 'ACKNOWLEDGED' ? (
                        <Button 
                          type="primary" 
                          size="small" 
                          icon={<EnvironmentOutlined />}
                          style={{ background: '#059669', borderColor: '#059669', fontWeight: 'bold' }}
                          onClick={() => navigate(`/logistics/dispatch-orders/${selectedMdo.mdo_number}/acknowledge`)}
                        >
                          Acknowledge Delivery
                        </Button>
                      ) : (
                        <Tag color="green" style={{ fontWeight: 'bold' }}>
                          <EnvironmentOutlined /> ACKNOWLEDGED
                        </Tag>
                      )}
                    </div>
                    <div style={{ fontSize: '11px', color: '#047857', marginTop: '4px' }}>
                      Final delivery acknowledgement at destination warehouse. Completing this step marks the MDO as delivered.
                    </div>
                  </div>
                </div>
              );
            }

            // Upcoming approve leg (not yet created as SDO)
            return (
              <div key={`preview-${legNum}`} style={{ display: 'flex', gap: '16px', alignItems: 'flex-start', opacity: 0.6 }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ 
                    width: '32px', 
                    height: '32px', 
                    borderRadius: '50%', 
                    background: '#f1f5f9', 
                    color: '#94a3b8', 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center', 
                    fontWeight: 'bold',
                    border: '2px dashed #cbd5e1'
                  }}>
                    {legNum}
                  </div>
                  {!isLast && <div style={{ width: '2px', height: '40px', background: '#cbd5e1', borderStyle: 'dashed' }} />}
                </div>
                <div>
                  <strong style={{ color: '#64748b' }}>Leg {legNum}: {chainPos.position_name} ({chainPos.role_name})</strong>
                  <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                    Custodian: {chainPos.employee_name ? `${chainPos.employee_name} (${chainPos.employee_code})` : 'Unassigned'}
                  </div>
                  <Tag style={{ marginTop: '4px' }}>UPCOMING LEG</Tag>
                </div>
              </div>
            );
          })}

          {!isMultiLevel && (
            <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ 
                  width: '32px', height: '32px', borderRadius: '50%', 
                  background: '#f1f5f9', color: '#059669', 
                  display: 'flex', alignItems: 'center', justifyContent: 'center', 
                  fontWeight: 'bold', border: '2px dashed #059669'
                }}>
                  <EnvironmentOutlined />
                </div>
              </div>
              <div style={{ flex: 1, background: '#ecfdf5', border: '1px dashed #059669', borderRadius: '10px', padding: '12px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                  <div>
                    <strong style={{ color: '#065f46', fontSize: '14px' }}>
                      Destination: {selectedMdo.destination_warehouse_name || selectedMdo.destination_user_name || 'Client Drop Site'}
                    </strong>
                    <div style={{ fontSize: '11px', color: '#047857' }}>
                      {selectedMdo.delivery_address || 'Final delivery destination'}
                    </div>
                  </div>
                  {selectedMdo.status !== 'COMPLETED' && selectedMdo.status !== 'ACKNOWLEDGED' ? (
                    <Button 
                      type="primary" 
                      size="small" 
                      icon={<EnvironmentOutlined />}
                      style={{ background: '#059669', borderColor: '#059669', fontWeight: 'bold' }}
                      onClick={() => navigate(`/logistics/dispatch-orders/${selectedMdo.mdo_number}/acknowledge`)}
                    >
                      Acknowledge Delivery
                    </Button>
                  ) : (
                    <Tag color="green" style={{ fontWeight: 'bold' }}>
                      <EnvironmentOutlined /> ACKNOWLEDGED
                    </Tag>
                  )}
                </div>
                <div style={{ fontSize: '11px', color: '#047857', marginTop: '4px' }}>
                  Final delivery acknowledgement at destination warehouse. Completing this step marks the MDO as delivered.
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>
    );
  };

  return (
    <div style={{ padding: '28px', background: 'radial-gradient(ellipse at top, #f8fafc 0%, #f1f5f9 80%)', minHeight: '100vh', color: '#334155', fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" }}>

      {/* Top Banner Header — hidden when form page is active */}
      {!showDesigner && (
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
              setDispatchType('own vehicle');
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
      )}

      {/* Main Designer Form Page — replaces modal with full page layout */}
      {showDesigner && (
      <div style={{ background: '#ffffff', borderRadius: '16px', border: '1px solid #e2e8f0', boxShadow: '0 4px 20px rgba(0,0,0,0.05)', minHeight: 'calc(100vh - 100px)' }}>
        {/* Page Header with Back Button */}
        <div style={{ 
          display: 'flex', alignItems: 'center', gap: '16px', padding: '20px 28px',
          borderBottom: '1px solid #e2e8f0', background: '#f8fafc', borderRadius: '16px 16px 0 0'
        }}>
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => {
              setShowDesigner(false);
              form.resetFields();
              setSelectedIssue(null);
              setUploadedUrls({});
              setIsReadOnly(false);
              setSelectedMdo(null);
            }}
            style={{ fontWeight: 600, borderRadius: '8px' }}
          >
            Back
          </Button>
          <span style={{ color: '#0f172a', fontSize: '17px', fontWeight: 700, letterSpacing: '-0.2px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isReadOnly ? <EyeOutlined style={{ color: '#0284c7' }} /> : <PlusOutlined style={{ color: '#0284c7' }} />}
            {isReadOnly ? 'VIEW DISPATCH PLAN DETAILS' : 'NEW DISPATCH'}
          </span>
        </div>
        <div style={{ padding: '24px 28px' }}>
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
                       <Col span={8}>
                         <Text type="secondary" style={{ fontSize: '11px', display: 'block', color: '#64748b' }}>Dispatch Warehouse</Text>
                         <Text strong style={{ fontSize: '12px', color: '#334155' }}>{selectedIssue.destination_warehouse_name || '—'}</Text>
                       </Col>
                       <Col span={8}>
                         <Text type="secondary" style={{ fontSize: '11px', display: 'block', color: '#64748b' }}>Issued To</Text>
                         <Text strong style={{ fontSize: '12px', color: '#334155' }}>{selectedIssue.issued_to_name || '—'} {selectedIssue.issued_to_employee_code ? `(${selectedIssue.issued_to_employee_code})` : ''}</Text>
                       </Col>
                       <Col span={8}>
                         <Text type="secondary" style={{ fontSize: '11px', display: 'block', color: '#64748b' }}>Position Code</Text>
                         <Tag color="purple">{selectedIssue.position_code || '—'}</Tag>
                       </Col>
                     </Row>
                  </div>
                )}
                <Table
                  dataSource={groupIssueItems(selectedIssueItems)}
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

          {/* New separate space for Consignment Packages and Parent Packages Tree View */}
          {(() => {
            if (!selectedIssue) return null;
            if (linkedConsignment === null) {
              return (
                <Alert
                  message="No Consignment Created Yet"
                  description="This Material Issue does not have a consignment. Create one from the Consignment Pipeline page."
                  type="info"
                  showIcon
                  style={{ marginBottom: '20px', borderRadius: '8px' }}
                />
              );
            }
            const packages = linkedConsignment.packages || [];
            if (packages.length === 0) {
              return (
                <Card
                  title={<span style={{ color: '#0f172a', fontWeight: 700 }}><GiftOutlined style={{ color: '#d97706', marginRight: '8px' }} />Consignment Packaging Hierarchy (Tree View)</span>}
                  style={{ borderRadius: '12px', border: '1px solid #cbd5e1', marginBottom: '20px' }}
                >
                  <Empty description="No packages in this consignment" />
                </Card>
              );
            }

            // Group packages by parent_package_code
            const parentGroups = {};
            const unassigned = [];
            packages.forEach(pkg => {
              if (pkg.parent_package_code) {
                if (!parentGroups[pkg.parent_package_code]) {
                  parentGroups[pkg.parent_package_code] = {
                    code: pkg.parent_package_code,
                    barcode: pkg.parent_package_barcode,
                    packages: [],
                    total_weight: 0,
                    total_volume: 0,
                  };
                }
                parentGroups[pkg.parent_package_code].packages.push(pkg);
                parentGroups[pkg.parent_package_code].total_weight += Number(pkg.gross_weight_kg || 0);
                parentGroups[pkg.parent_package_code].total_volume += Number(pkg.volume_cft || 0);
              } else {
                unassigned.push(pkg);
              }
            });

            const parentsList = Object.values(parentGroups);

            return (
              <Card
                title={
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                    <span style={{ color: '#0f172a', fontWeight: 700 }}>
                      <GiftOutlined style={{ color: '#d97706', marginRight: '8px' }} />
                      Consignment Packaging Hierarchy (Tree View)
                    </span>
                    <Tag color="blue" style={{ fontWeight: 600 }}>
                      Consignment: {linkedConsignment.consignment_number}
                    </Tag>
                  </div>
                }
                style={{
                  borderRadius: '12px',
                  border: '1px solid #cbd5e1',
                  background: '#ffffff',
                  marginBottom: '20px',
                  boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)',
                }}
              >
                {(() => {
                  const conSignature = linkedConsignment.receipt_signature_url;
                  const conPhotos = linkedConsignment.receipt_photos || [];
                  const allReceiptSignatures = Array.from(new Set([
                    conSignature,
                    ...packages.map(p => p.receipt_signature_url)
                  ].filter(Boolean)));
                  const allReceiptPhotos = Array.from(new Set([
                    ...conPhotos,
                    ...packages.flatMap(p => p.receipt_photos || [])
                  ].filter(Boolean)));
                  if (allReceiptSignatures.length === 0 && allReceiptPhotos.length === 0) return null;
                  return (
                    <div style={{ 
                      background: '#f8fafc', 
                      border: '1px solid #cbd5e1', 
                      borderRadius: '8px', 
                      padding: '12px 16px', 
                      margin: '16px', 
                      display: 'flex', 
                      flexDirection: 'column', 
                      gap: '8px' 
                    }}>
                      <div style={{ fontWeight: 700, fontSize: '13px', color: '#1e293b' }}>
                        Consignment Delivery Evidence Summary (All Packages)
                      </div>
                      <Space size="middle" wrap>
                        {allReceiptSignatures.map((sig, idx) => (
                          <div key={`sig-${idx}`} style={{ display: 'inline-block', textAlign: 'center' }}>
                            <span style={{ display: 'block', fontSize: '10px', color: '#64748b', marginBottom: '4px' }}>Signature #{idx + 1}</span>
                            <Image src={sig} width={60} height={40} style={{ objectFit: 'contain', borderRadius: '4px', border: '1px solid #cbd5e1', background: '#fff' }} />
                          </div>
                        ))}
                        {allReceiptPhotos.map((photo, idx) => (
                          <div key={`photo-${idx}`} style={{ display: 'inline-block', textAlign: 'center' }}>
                            <span style={{ display: 'block', fontSize: '10px', color: '#64748b', marginBottom: '4px' }}>Photo #{idx + 1}</span>
                            <Image src={photo} width={60} height={40} style={{ objectFit: 'cover', borderRadius: '4px', border: '1px solid #cbd5e1', background: '#fff' }} />
                          </div>
                        ))}
                      </Space>
                    </div>
                  );
                })()}
                <div style={{ maxHeight: '400px', overflowY: 'auto', paddingRight: '8px' }}>
                  {parentsList.length > 0 && (
                    <div style={{ marginBottom: unassigned.length > 0 ? '24px' : '0' }}>
                      <div style={{ fontWeight: 700, fontSize: '14px', color: '#1e293b', marginBottom: '12px', borderBottom: '2px solid #e2e8f0', paddingBottom: '6px' }}>
                        Parent Packages ({parentsList.length})
                      </div>
                      <Collapse defaultActiveKey={[]} ghost expandIconPosition="start">
                        {parentsList.map(parent => (
                          <Collapse.Panel
                            key={parent.code}
                            header={
                              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', width: '95%', alignItems: 'center', background: '#f8fafc', padding: '10px 14px', borderRadius: '8px', border: '1px solid #e2e8f0', marginLeft: '4px' }}>
                                <Space size="middle">
                                  <span style={{ fontWeight: 700, color: '#4f46e5', fontSize: '13px' }}>PARENT: {parent.code}</span>
                                  <Tag color="cyan">Pallet/Crate</Tag>
                                  <Tag color="blue">{parent.packages.length} Packages Included</Tag>
                                </Space>
                                <Space size="large" style={{ fontSize: '12px', color: '#64748b' }}>
                                  <span><strong>Weight:</strong> {parent.total_weight.toFixed(2)} KG</span>
                                  <span><strong>Volume:</strong> {parent.total_volume.toFixed(2)} CFT</span>
                                </Space>
                              </div>
                            }
                            style={{ marginBottom: '12px', border: 'none' }}
                          >
                            <div style={{ padding: '0 12px 12px 36px', borderLeft: '2px dashed #cbd5e1', marginLeft: '24px' }}>
                              <Collapse defaultActiveKey={[]} ghost>
                                {parent.packages.map((pkg, idx) => (
                                  <Collapse.Panel
                                    key={pkg.id}
                                    header={
                                      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', width: '95%', alignItems: 'center', background: '#ffffff', padding: '8px 12px', borderRadius: '6px', border: '1px solid #cbd5e1', cursor: 'pointer' }}>
                                        <Space>
                                          <Tag color="blue" style={{ fontFamily: 'monospace', fontWeight: 700 }}>PKG #{idx + 1}</Tag>
                                          <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{pkg.package_number}</span>
                                          <Tag color="default">{pkg.package_type}</Tag>
                                          {pkg.seal_number && <Tag color="orange">Seal: {pkg.seal_number}</Tag>}
                                        </Space>
                                        <Space size="middle" style={{ fontSize: '12px', color: '#64748b' }}>
                                          <span><strong>Weight:</strong> {pkg.gross_weight_kg || 0} KG</span>
                                          <span><strong>Volume:</strong> {pkg.volume_cft ? pkg.volume_cft.toFixed(2) + ' CFT' : '—'}</span>
                                          <span><strong>Items:</strong> {pkg.material_count || 0}</span>
                                        </Space>
                                      </div>
                                    }
                                    style={{ marginBottom: '8px', border: 'none' }}
                                  >
                                    <div style={{ padding: '8px 12px 8px 24px', borderLeft: '2px dashed #e2e8f0', marginLeft: '16px' }}>
                                      {(pkg.receipt_signature_url || (pkg.receipt_photos && pkg.receipt_photos.length > 0)) && (
                                        <div style={{ 
                                          background: '#f8fafc', 
                                          border: '1px dashed #cbd5e1', 
                                          borderRadius: '6px', 
                                          padding: '8px 12px', 
                                          marginBottom: '10px',
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'space-between',
                                          flexWrap: 'wrap',
                                          gap: '8px'
                                        }}>
                                          <div style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>
                                            Package-wise Receipt Evidence:
                                          </div>
                                          <Space size="middle" wrap>
                                            {pkg.receipt_signature_url && (
                                              <div style={{ textAlign: 'center' }}>
                                                <span style={{ display: 'block', fontSize: '9px', color: '#64748b' }}>Signature</span>
                                                <Image src={pkg.receipt_signature_url} width={50} height={35} style={{ objectFit: 'contain', borderRadius: '4px', border: '1px solid #cbd5e1', background: '#fff' }} />
                                              </div>
                                            )}
                                            {(pkg.receipt_photos || []).map((photo, pIdx) => (
                                              <div key={pIdx} style={{ textAlign: 'center' }}>
                                                <span style={{ display: 'block', fontSize: '9px', color: '#64748b' }}>Photo {pIdx + 1}</span>
                                                <Image src={photo} width={50} height={35} style={{ objectFit: 'cover', borderRadius: '4px', border: '1px solid #cbd5e1', background: '#fff' }} />
                                              </div>
                                            ))}
                                          </Space>
                                        </div>
                                      )}
                                      {pkg.items && pkg.items.length > 0 && (
                                        <Table
                                          dataSource={pkg.items}
                                          size="small"
                                          pagination={false}
                                          rowKey="id"
                                          style={{ background: '#fff', borderRadius: '6px', overflow: 'hidden', border: '1px solid #e2e8f0' }}
                                          columns={[
                                            { title: 'Code', dataIndex: 'material_code', key: 'code', render: t => <span style={{ fontFamily: 'monospace' }}>{t}</span> },
                                            { title: 'Material', dataIndex: 'material_name', key: 'name' },
                                            { title: 'Batch', dataIndex: 'batch_number', key: 'batch', render: t => t || '—' },
                                            { title: 'Qty', dataIndex: 'quantity_packed', key: 'qty', render: val => <span style={{ fontWeight: 600 }}>{val}</span> },
                                            { title: 'UOM', dataIndex: 'uom_code', key: 'uom' },
                                            {
                                              title: 'Serial/Asset Codes',
                                              key: 'serial_numbers',
                                              width: 200,
                                              render: (_, r) => {
                                                const serials = r.serial_numbers || [];
                                                if (serials.length === 0) return <span style={{ color: '#94a3b8' }}>—</span>;
                                                const isAsset = r.material_type === 'asset' || r.item?.item_type === 'asset';
                                                const isConsumable = r.material_type === 'consumable' || r.item?.item_type === 'consumable';
                                                const labelColor = isAsset ? 'cyan' : isConsumable ? 'orange' : 'blue';
                                                
                                                if (serials.length <= 3) {
                                                  return (
                                                    <Space wrap size={[4, 4]}>
                                                      {serials.map(sn => (
                                                        <Tag key={sn} color={labelColor} style={{ fontFamily: 'monospace', margin: 0, fontSize: '11px', borderRadius: '4px' }}>
                                                          {sn}
                                                        </Tag>
                                                      ))}
                                                    </Space>
                                                  );
                                                }
                                                return (
                                                  <SerialNumbersModal
                                                    value={serials}
                                                    itemName={r.material_name || r.item?.name}
                                                    itemCode={r.material_code}
                                                    quantity={Math.round(Number(r.quantity_packed || 0))}
                                                    hasSerial={true}
                                                    size="small"
                                                    readOnly
                                                    />
                                                );
                                              }
                                            },
                                          ]}
                                        />
                                      )}
                                    </div>
                                  </Collapse.Panel>
                                ))}
                              </Collapse>
                            </div>
                          </Collapse.Panel>
                        ))}
                      </Collapse>
                    </div>
                  )}

                  {unassigned.length > 0 && (
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '14px', color: '#1e293b', marginBottom: '12px', borderBottom: '2px solid #e2e8f0', paddingBottom: '6px' }}>
                        Individual Packages (Loose / Unassigned to Parent) ({unassigned.length})
                      </div>
                      <Collapse defaultActiveKey={[]} ghost>
                        {unassigned.map((pkg, idx) => (
                          <Collapse.Panel
                            key={pkg.id}
                            header={
                              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', width: '95%', alignItems: 'center', background: '#f8fafc', padding: '10px 14px', borderRadius: '8px', border: '1px solid #e2e8f0', marginLeft: '4px' }}>
                                <Space>
                                  <Tag color="blue" style={{ fontFamily: 'monospace', fontWeight: 700 }}>PKG #{idx + 1}</Tag>
                                  <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{pkg.package_number}</span>
                                  <Tag color="default">{pkg.package_type}</Tag>
                                  {pkg.seal_number && <Tag color="orange">Seal: {pkg.seal_number}</Tag>}
                                </Space>
                                <Space size="large" style={{ fontSize: '12px', color: '#64748b' }}>
                                  <span><strong>Weight:</strong> {pkg.gross_weight_kg || 0} KG</span>
                                  <span><strong>Volume:</strong> {pkg.volume_cft ? pkg.volume_cft.toFixed(2) + ' CFT' : '—'}</span>
                                  <span><strong>Items:</strong> {pkg.material_count || 0}</span>
                                </Space>
                              </div>
                            }
                            style={{ marginBottom: '12px', border: 'none' }}
                          >
                            <div style={{ padding: '0 12px 12px 36px', borderLeft: '2px dashed #cbd5e1', marginLeft: '24px' }}>
                              {(pkg.receipt_signature_url || (pkg.receipt_photos && pkg.receipt_photos.length > 0)) && (
                                        <div style={{ 
                                          background: '#f8fafc', 
                                          border: '1px dashed #cbd5e1', 
                                          borderRadius: '6px', 
                                          padding: '8px 12px', 
                                          marginBottom: '10px',
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'space-between',
                                          flexWrap: 'wrap',
                                          gap: '8px'
                                        }}>
                                          <div style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>
                                            Package-wise Receipt Evidence:
                                          </div>
                                          <Space size="middle" wrap>
                                            {pkg.receipt_signature_url && (
                                              <div style={{ textAlign: 'center' }}>
                                                <span style={{ display: 'block', fontSize: '9px', color: '#64748b' }}>Signature</span>
                                                <Image src={pkg.receipt_signature_url} width={50} height={35} style={{ objectFit: 'contain', borderRadius: '4px', border: '1px solid #cbd5e1', background: '#fff' }} />
                                              </div>
                                            )}
                                            {(pkg.receipt_photos || []).map((photo, pIdx) => (
                                              <div key={pIdx} style={{ textAlign: 'center' }}>
                                                <span style={{ display: 'block', fontSize: '9px', color: '#64748b' }}>Photo {pIdx + 1}</span>
                                                <Image src={photo} width={50} height={35} style={{ objectFit: 'cover', borderRadius: '4px', border: '1px solid #cbd5e1', background: '#fff' }} />
                                              </div>
                                            ))}
                                          </Space>
                                        </div>
                                      )}
                              {pkg.items && pkg.items.length > 0 && (
                                <Table
                                  dataSource={pkg.items}
                                  size="small"
                                  pagination={false}
                                  rowKey="id"
                                  style={{ background: '#fff', borderRadius: '6px', overflow: 'hidden', border: '1px solid #e2e8f0' }}
                                  columns={[
                                    { title: 'Code', dataIndex: 'material_code', key: 'code', render: t => <span style={{ fontFamily: 'monospace' }}>{t}</span> },
                                    { title: 'Material', dataIndex: 'material_name', key: 'name' },
                                    { title: 'Batch', dataIndex: 'batch_number', key: 'batch', render: t => t || '—' },
                                    { title: 'Qty', dataIndex: 'quantity_packed', key: 'qty', render: val => <span style={{ fontWeight: 600 }}>{val}</span> },
                                    { title: 'UOM', dataIndex: 'uom_code', key: 'uom' },
                                    {
                                      title: 'Serial/Asset Codes',
                                      key: 'serial_numbers',
                                      width: 200,
                                      render: (_, r) => {
                                        const serials = r.serial_numbers || [];
                                        if (serials.length === 0) return <span style={{ color: '#94a3b8' }}>—</span>;
                                        const isAsset = r.material_type === 'asset' || r.item?.item_type === 'asset';
                                        const isConsumable = r.material_type === 'consumable' || r.item?.item_type === 'consumable';
                                        const labelColor = isAsset ? 'cyan' : isConsumable ? 'orange' : 'blue';
                                        
                                        if (serials.length <= 3) {
                                          return (
                                            <Space wrap size={[4, 4]}>
                                              {serials.map(sn => (
                                                <Tag key={sn} color={labelColor} style={{ fontFamily: 'monospace', margin: 0, fontSize: '11px', borderRadius: '4px' }}>
                                                  {sn}
                                                </Tag>
                                              ))}
                                            </Space>
                                          );
                                        }
                                        return (
                                          <SerialNumbersModal
                                            value={serials}
                                            itemName={r.material_name || r.item?.name}
                                            itemCode={r.material_code}
                                            quantity={Math.round(Number(r.quantity_packed || 0))}
                                            hasSerial={true}
                                            size="small"
                                            readOnly
                                          />
                                        );
                                      }
                                    },
                                  ]}
                                />
                              )}
                            </div>
                          </Collapse.Panel>
                        ))}
                      </Collapse>
                    </div>
                  )}
                </div>
              </Card>
            );
          })() }

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
                  suffix="KG"
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
                  suffix="CFT"
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
                  {/* <Option value="THIRD_PARTY">Third-Party Carrier Bidding (RFQ)</Option> */}
                </Select>
              </Form.Item>
            </Col>

            <Col xs={24} md={12}>
              <Form.Item name="dispatch_mode" label={<span style={{ color: '#4f46e5', fontWeight: 600 }}>Dispatch Mode</span>} rules={[{ required: true, message: 'Please select dispatch mode' }]}>
                <Select style={{ width: '100%' }}>
                  <Option value="direct">Direct Dispatch</Option>
                  {/* <Option value="multi-level">Multi-Level Custody Transfer</Option> */}
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
                  <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" disabledDate={(current) => current && current.isBefore(dayjs().startOf('day'))} />
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
                {isReadOnly ? (
                  <Row gutter={[16, 16]} style={{ fontSize: '13px' }}>
                    <Col xs={12} md={6}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Driver Name</span>
                      <strong style={{ color: '#334155' }}>{form.getFieldValue('driver_name') || '—'}</strong>
                    </Col>
                    <Col xs={12} md={6}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Driver Phone</span>
                      <strong style={{ color: '#334155' }}>{form.getFieldValue('driver_phone') || '—'}</strong>
                    </Col>
                    <Col xs={12} md={6}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Received By</span>
                      <strong style={{ color: '#334155' }}>{form.getFieldValue('received_by_name') || '—'}</strong>
                    </Col>
                    <Col xs={12} md={6}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Received By Phone</span>
                      <strong style={{ color: '#334155' }}>{form.getFieldValue('received_by_phone') || '—'}</strong>
                    </Col>
                    <Col xs={24}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Remarks / Loading Specs</span>
                      <span style={{ color: '#334155' }}>{form.getFieldValue('handover_remarks') || '—'}</span>
                    </Col>
                    <Col xs={12}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '11px', textTransform: 'uppercase', marginBottom: '8px' }}>Vehicle Image</span>
                      {uploadedUrls.vehicle_image ? (
                        <Image src={uploadedUrls.vehicle_image} style={{ maxHeight: '150px', objectFit: 'contain', borderRadius: '6px', border: '1px solid #cbd5e1' }} />
                      ) : (
                        <span style={{ color: '#94a3b8' }}>No vehicle image uploaded</span>
                      )}
                    </Col>
                    <Col xs={12}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '11px', textTransform: 'uppercase', marginBottom: '8px' }}>Receiver Signature</span>
                      {uploadedUrls.receiver_signature ? (
                        <Image src={uploadedUrls.receiver_signature} style={{ maxHeight: '150px', objectFit: 'contain', borderRadius: '6px', border: '1px solid #cbd5e1' }} />
                      ) : (
                        <span style={{ color: '#94a3b8' }}>No receiver signature uploaded</span>
                      )}
                    </Col>
                  </Row>
                ) : (
                  <>
                    <Row gutter={16}>
                      <Col xs={24} md={12}>
                        <Form.Item name="driver_name" label="Driver Full Name" rules={[{ required: true }]}>
                          <Input placeholder="E.g., Satish Kumar" />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={12}>
                        <Form.Item
                          name="driver_phone"
                          label="Driver Phone Number"
                          rules={[
                            { required: true, message: 'Driver Phone is required' },
                            {
                              validator: (_, value) => {
                                if (!value) return Promise.resolve();
                                const cleaned = value.replace(/[\s\-()]/g, '');
                                if (/^(?:\+?91|0)?[6-9]\d{9}$/.test(cleaned) || /^\+?[1-9]\d{9,14}$/.test(cleaned)) {
                                  return Promise.resolve();
                                }
                                return Promise.reject(new Error('Enter a valid 10-digit mobile number, optionally with country code'));
                              }
                            }
                          ]}
                        >
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
                        <Form.Item
                          name="received_by_phone"
                          label="Received By (Phone Number)"
                          rules={[
                            { required: true, message: 'Receiver Phone is required' },
                            {
                              validator: (_, value) => {
                                if (!value) return Promise.resolve();
                                const cleaned = value.replace(/[\s\-()]/g, '');
                                if (/^(?:\+?91|0)?[6-9]\d{9}$/.test(cleaned) || /^\+?[1-9]\d{9,14}$/.test(cleaned)) {
                                  return Promise.resolve();
                                }
                                return Promise.reject(new Error('Enter a valid 10-digit mobile number, optionally with country code'));
                              }
                            }
                          ]}
                        >
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
                  </>
                )}
              </Card>
            )}
    
            {dispatchType === 'IN_PERSON' && (
              <Card
                title={<span style={{ color: '#d97706', fontWeight: 700 }}><UserOutlined /> In-Person Handover Manifest</span>}
                style={{ background: '#fffbeb', borderColor: '#fde68a', borderRadius: '12px' }}
              >
                {isReadOnly ? (
                  <Row gutter={[16, 16]} style={{ fontSize: '13px' }}>
                    <Col xs={12} md={8}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Pickup Person Name</span>
                      <strong style={{ color: '#334155' }}>{form.getFieldValue('received_by_name') || '—'}</strong>
                    </Col>
                    <Col xs={12} md={8}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Pickup Person Phone</span>
                      <strong style={{ color: '#334155' }}>{form.getFieldValue('received_by_phone') || '—'}</strong>
                    </Col>
                    <Col xs={12} md={8}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Employee Code</span>
                      <strong style={{ color: '#334155' }}>{form.getFieldValue('received_by_emp_code') || '—'}</strong>
                    </Col>
                    <Col xs={12} md={8}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Aadhar No</span>
                      <strong style={{ color: '#334155' }}>{form.getFieldValue('received_by_aadhar_no') || '—'}</strong>
                    </Col>
                    <Col xs={12} md={8}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Designation</span>
                      <strong style={{ color: '#334155' }}>{form.getFieldValue('received_by_designation') || '—'}</strong>
                    </Col>
                    <Col xs={24}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Handover Remarks</span>
                      <span style={{ color: '#334155' }}>{form.getFieldValue('handover_remarks') || '—'}</span>
                    </Col>
                    <Col xs={24}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '11px', textTransform: 'uppercase', marginBottom: '8px' }}>Receiver Signature</span>
                      {uploadedUrls.receiver_signature ? (
                        <Image src={uploadedUrls.receiver_signature} style={{ maxHeight: '150px', objectFit: 'contain', borderRadius: '6px', border: '1px solid #cbd5e1' }} />
                      ) : (
                        <span style={{ color: '#94a3b8' }}>No receiver signature uploaded</span>
                      )}
                    </Col>
                  </Row>
                ) : (
                  <>
                    <Row gutter={16}>
                      <Col xs={24} md={12}>
                        <Form.Item name="received_by_name" label="Pickup Person Name" rules={[{ required: true }]}>
                          <Input placeholder="E.g., Rahul Verma" />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={12}>
                        <Form.Item
                          name="received_by_phone"
                          label="Pickup Person Phone Number"
                          rules={[
                            { required: true, message: 'Pickup Person Phone is required' },
                            {
                              validator: (_, value) => {
                                if (!value) return Promise.resolve();
                                const cleaned = value.replace(/[\s\-()]/g, '');
                                if (/^(?:\+?91|0)?[6-9]\d{9}$/.test(cleaned) || /^\+?[1-9]\d{9,14}$/.test(cleaned)) {
                                  return Promise.resolve();
                                }
                                return Promise.reject(new Error('Enter a valid 10-digit mobile number, optionally with country code'));
                              }
                            }
                          ]}
                        >
                          <Input placeholder="E.g., 9765432100" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col xs={24} md={8}>
                        <Form.Item name="received_by_emp_code" label="Employee Code" rules={[{ required: true, message: 'Employee Code is required' }]}>
                          <Input placeholder="E.g., EMP101" />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={8}>
                        <Form.Item
                          name="received_by_aadhar_no"
                          label="Aadhar Number"
                          rules={[
                            { required: true, message: 'Aadhar Number is required' },
                            {
                              validator: (_, value) => {
                                if (!value) return Promise.resolve();
                                const cleaned = value.replace(/\s/g, '');
                                if (/^\d{12}$/.test(cleaned)) {
                                  return Promise.resolve();
                                }
                                return Promise.reject(new Error('Enter a valid 12-digit Aadhar number'));
                              }
                            }
                          ]}
                        >
                          <Input placeholder="E.g., 1234 5678 9012" maxLength={14} />
                        </Form.Item>
                      </Col>
                      <Col xs={24} md={8}>
                        <Form.Item name="received_by_designation" label="Designation" rules={[{ required: true, message: 'Designation is required' }]}>
                          <Input placeholder="E.g., Logistics Officer" />
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
                  </>
                )}
              </Card>
            )}
    
            {dispatchType === 'COURIER' && (
              <Card
                title={<span style={{ color: '#0284c7', fontWeight: 700 }}><MailOutlined /> Courier Dispatch Manifest</span>}
                style={{ background: '#f0f9ff', borderColor: '#bae6fd', borderRadius: '12px' }}
              >
                {isReadOnly ? (
                  <Row gutter={[16, 16]} style={{ fontSize: '13px' }}>
                    <Col xs={12} md={12}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Courier Company Name</span>
                      <strong style={{ color: '#334155' }}>{form.getFieldValue('courier_name') || '—'}</strong>
                    </Col>
                    <Col xs={12} md={12}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>AWB / Tracking Number</span>
                      <strong style={{ color: '#334155' }}>{form.getFieldValue('awb_no') || '—'}</strong>
                    </Col>
                    <Col xs={24}>
                      <span style={{ color: '#64748b', display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Delivery Remarks</span>
                      <span style={{ color: '#334155' }}>{form.getFieldValue('handover_remarks') || '—'}</span>
                    </Col>
                  </Row>
                ) : (
                  <>
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
                  </>
                )}
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

          {isReadOnly && selectedMdo && selectedMdo.delivery_acknowledged && (
            <Card 
              title={<span style={{ color: '#0f172a', fontWeight: 800 }}>Proof of Delivery (POD) / Receipt Acknowledgement Details</span>}
              style={{ marginBottom: '20px', borderRadius: '12px', border: '1px solid #cbd5e1', boxShadow: '0 4px 12px rgba(0,0,0,0.03)', background: '#f8fafc' }}
            >
              <Row gutter={[24, 16]}>
                <Col xs={24} md={8}>
                  <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Receiver Name</Text>
                  <strong style={{ color: '#0f172a', fontSize: '14px' }}>{selectedMdo.delivery_acknowledged_by_name || '—'}</strong>
                </Col>
                <Col xs={24} md={8}>
                  <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Contact / Phone</Text>
                  <strong style={{ color: '#0f172a', fontSize: '14px' }}>{selectedMdo.delivery_acknowledged_by_phone || '—'}</strong>
                </Col>
                <Col xs={24} md={8}>
                  <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Acknowledgement Date</Text>
                  <strong style={{ color: '#0f172a', fontSize: '14px' }}>{formatDate(selectedMdo.delivery_acknowledged_at)}</strong>
                </Col>
                <Col xs={24} md={8}>
                  <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Goods Condition</Text>
                  <div>
                    <Tag color={selectedMdo.goods_condition_on_delivery === 'GOOD' ? 'green' : 'orange'} style={{ fontWeight: 'bold' }}>
                      {selectedMdo.goods_condition_on_delivery || 'GOOD'}
                    </Tag>
                  </div>
                </Col>
                <Col xs={24} md={16}>
                  <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase' }}>Remarks / Discrepancy</Text>
                  <strong style={{ color: '#0f172a', fontSize: '13px' }}>{selectedMdo.delivery_remarks || '—'}</strong>
                </Col>
                
                <Col xs={24} md={12}>
                  <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase', marginBottom: '10px', fontWeight: 700, letterSpacing: '0.5px' }}>📝 Receiver Signature / Stamp</Text>
                  {selectedMdo.receiver_signature_url ? (
                    <div style={{ background: 'linear-gradient(135deg,#f0fdf4,#dcfce7)', padding: '16px', borderRadius: '12px', border: '2px solid #86efac' }}>
                      <span style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#166534', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>✓ Uploaded — Click image to zoom full screen</span>
                      <Image.PreviewGroup>
                        <Image
                          src={selectedMdo.receiver_signature_url}
                          alt="Receiver Signature"
                          style={{ width: '100%', maxHeight: '280px', objectFit: 'contain', borderRadius: '8px', border: '2px solid #86efac', background: '#fff', display: 'block' }}
                          preview={{ mask: <span style={{ fontSize: '13px', fontWeight: 600 }}>🔍 Click to Zoom</span> }}
                        />
                      </Image.PreviewGroup>
                    </div>
                  ) : (
                    <div style={{ background: '#fafafa', padding: '20px', borderRadius: '10px', border: '1.5px dashed #cbd5e1', textAlign: 'center' }}>
                      <Text type="secondary" style={{ fontSize: '13px' }}>No signature image uploaded yet</Text>
                    </div>
                  )}
                </Col>

                <Col xs={24} md={12}>
                  <Text type="secondary" style={{ display: 'block', fontSize: '11px', textTransform: 'uppercase', marginBottom: '10px', fontWeight: 700, letterSpacing: '0.5px' }}>📦 Delivery Photos (Evidence)</Text>
                  {selectedMdo.delivery_photo_urls && selectedMdo.delivery_photo_urls.photo ? (
                    <div style={{ background: 'linear-gradient(135deg,#f0f9ff,#e0f2fe)', padding: '16px', borderRadius: '12px', border: '2px solid #7dd3fc' }}>
                      <span style={{ display: 'block', fontSize: '11px', fontWeight: 700, color: '#075985', marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>✓ Evidence Photo — Click to zoom</span>
                      <Image.PreviewGroup>
                        <Image
                          src={selectedMdo.delivery_photo_urls.photo}
                          alt="Delivery Evidence"
                          style={{ width: '100%', maxHeight: '280px', objectFit: 'contain', borderRadius: '8px', border: '2px solid #7dd3fc', background: '#fff', display: 'block' }}
                          preview={{ mask: <span style={{ fontSize: '13px', fontWeight: 600 }}>🔍 Click to Zoom</span> }}
                        />
                      </Image.PreviewGroup>
                      {selectedMdo.delivery_photo_urls.review && (
                        <div style={{ marginTop: '10px', padding: '10px 14px', background: 'rgba(7,89,133,0.07)', borderRadius: '8px', borderLeft: '3px solid #0891b2' }}>
                          <Text style={{ fontSize: '12px', color: '#075985', fontStyle: 'italic', display: 'block' }}>
                            💬 Condition Assessment: {selectedMdo.delivery_photo_urls.review}
                          </Text>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div style={{ background: '#fafafa', padding: '20px', borderRadius: '10px', border: '1.5px dashed #cbd5e1', textAlign: 'center' }}>
                      <Text type="secondary" style={{ fontSize: '13px' }}>No delivery photos uploaded</Text>
                    </div>
                  )}
                </Col>
              </Row>
            </Card>
          )}

          {dispatchType !== 'THIRD_PARTY' && (
            <Card
              title={<span style={{ color: '#475569', fontWeight: 700 }}>SCM Compliance Attachments</span>}
              style={{ marginBottom: '20px', borderRadius: '12px' }}
            >
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item name="e_challan" label="Delivery Challan">
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
                      <Button icon={<UploadOutlined />} disabled={isReadOnly}>Upload Delivery Challan</Button>
                    </FormUpload>
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item name="waybill" label="Deliverable Document">
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
                      <Button icon={<UploadOutlined />} disabled={isReadOnly}>Upload Deliverable Document</Button>
                    </FormUpload>
                  </Form.Item>
                </Col>
              </Row>
            </Card>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '28px' }}>
            {isReadOnly ? (
              <Button type="primary" onClick={() => { setShowDesigner(false); form.resetFields(); setSelectedIssue(null); setIsReadOnly(false); setSelectedMdo(null); }}>Close</Button>
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
        {!isReadOnly && dispatchMode === 'multi-level' && chainPreview && (
          <Card
            title={<span style={{ color: '#0ea5e9', fontWeight: 800 }}>Resolved Custody Chain Preview</span>}
            style={{ marginTop: '20px', borderRadius: '12px', border: '1px solid #cbd5e1', background: '#f8fafc' }}
          >
            {chainPreview.chain && chainPreview.chain.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {chainPreview.chain.map((pos, idx) => (
                  <div key={idx} style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                    <span style={{ 
                      background: pos.is_destination ? '#059669' : pos.view_only ? '#94a3b8' : '#0ea5e9', 
                      color: '#fff', borderRadius: '50%', width: '24px', height: '24px', 
                      display: 'flex', alignItems: 'center', justifyContent: 'center', 
                      fontWeight: 'bold', fontSize: '12px'
                    }}>
                      {pos.is_destination ? <EnvironmentOutlined /> : pos.view_only ? <EyeOutlined /> : idx + 1}
                    </span>
                    <div>
                      <strong style={{ color: '#334155' }}>{pos.position_name}</strong> ({pos.role_name})
                      {pos.view_only && !pos.is_destination && (
                        <Tag color="default" style={{ marginLeft: '6px', fontSize: '10px', borderStyle: 'dashed' }}><EyeOutlined /> View Only</Tag>
                      )}
                      {pos.is_destination && (
                        <Tag color="green" style={{ marginLeft: '6px', fontSize: '10px' }}><EnvironmentOutlined /> Destination</Tag>
                      )}
                      {pos.can_approve && !pos.is_destination && (
                        <Tag color="blue" style={{ marginLeft: '6px', fontSize: '10px' }}>Custody Leg</Tag>
                      )}
                      <div style={{ fontSize: '11px', color: '#64748b' }}>
                        Employee: {pos.employee_name ? `${pos.employee_name} (${pos.employee_code})` : 'Unassigned'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Text type="secondary">No positions resolved in the workflow chain.</Text>
            )}
          </Card>
        )}
        {isReadOnly && renderCustodyTimeline()}
        </div>
      </div>
      )}

      {/* Acknowledge Receipt Modal */}
      <Modal
        title={<span style={{ color: '#0f172a', fontWeight: 700 }}>
          {(() => {
            const _sdos = selectedMdo?.sdos || [];
            const _sdoPosIds = new Set(_sdos.map(s => s.custodian_position_id));
            const _preview = (chainPreview?.chain) ? chainPreview.chain : [];
            const _remaining = _preview.filter(cp => !_sdoPosIds.has(cp.position_id));
            const _hasApproveRemaining = _remaining.some(cp => !cp.view_only);
            const _isFinal = (activeSdo?.sequence_number || 0) >= _sdos.length && !_hasApproveRemaining;
            return _isFinal
              ? <><EnvironmentOutlined style={{ color: '#059669' }} /> ACKNOWLEDGE DELIVERY</>
              : <><CheckCircleOutlined style={{ color: '#0ea5e9' }} /> ACKNOWLEDGE DISPATCH RECEIPT</>;
          })()}
        </span>}
        open={receiveLegModalOpen}
        onCancel={() => {
          setReceiveLegModalOpen(false);
          receiveForm.resetFields();
          setReceiptPhotos([]);
          setReceiptSignature('');
        }}
        footer={null}
      >
        <Form
          form={receiveForm}
          layout="vertical"
          onFinish={async (values) => {
            if (!receiptSignature) {
              message.warning("Receiver signature upload is required!");
              return;
            }
            try {
              const payload = {
                seal_intact: !!values.seal_intact,
                packaging_condition: values.packaging_condition || 'INTACT',
                discrepancy_reported: !!values.discrepancy_reported,
                receiving_remarks: values.receiving_remarks,
                receipt_photos: receiptPhotos,
                receipt_signature: receiptSignature
              };
              
              const res = await api.post(`/logistics/sdo/${activeSdo.id}/receive`, payload);
              const isLastLeg = res.data?.is_last;
              message.success(isLastLeg ? "Delivery acknowledged successfully! MDO marked as completed." : "Custody transfer leg acknowledged successfully!");
              setReceiveLegModalOpen(false);
              receiveForm.resetFields();
              setReceiptPhotos([]);
              setReceiptSignature('');
              setShowDesigner(false);
              await fetchData();
            } catch (err) {
              console.error(err);
              const detail = err?.response?.data?.detail;
              message.error(typeof detail === 'string' ? detail : "Failed to acknowledge dispatch leg.");
            }
          }}
          initialValues={{ seal_intact: true, packaging_condition: 'INTACT', discrepancy_reported: false }}
        >
          <Form.Item name="seal_intact" label="Is the security seal intact?" valuePropName="checked">
            <Switch checkedChildren="YES" unCheckedChildren="NO" />
          </Form.Item>
          
          <Form.Item name="packaging_condition" label="Packaging Condition" rules={[{ required: true }]}>
            <Select>
              <Option value="INTACT">INTACT</Option>
              <Option value="DAMAGED">DAMAGED</Option>
              <Option value="TAMPERED">TAMPERED</Option>
            </Select>
          </Form.Item>

          <Form.Item name="discrepancy_reported" label="Any discrepancy / damage reported?" valuePropName="checked">
            <Switch checkedChildren="YES" unCheckedChildren="NO" />
          </Form.Item>

          <Form.Item name="receiving_remarks" label="Receiving Remarks / Notes">
            <Input.TextArea rows={2} placeholder="Add any comments on quality or count..." />
          </Form.Item>

          <Form.Item label="Condition Photos (Upload material photos)" required>
            <Upload
              listType="picture-card"
              multiple
              customRequest={async ({ file, onSuccess, onError }) => {
                try {
                  const url = await uploadImageFile(file);
                  setReceiptPhotos((prev) => [...prev, url]);
                  onSuccess(null, file);
                  message.success(`${file.name} uploaded`);
                } catch (err) {
                  onError(err);
                  message.error("Upload failed");
                }
              }}
            >
              <div>
                <PlusOutlined />
                <div style={{ marginTop: 8 }}>Upload</div>
              </div>
            </Upload>
          </Form.Item>

          <Form.Item label="Receiver Signature Upload" required>
            <Upload
              maxCount={1}
              listType="picture"
              customRequest={async ({ file, onSuccess, onError }) => {
                try {
                  const url = await uploadImageFile(file);
                  setReceiptSignature(url);
                  onSuccess(null, file);
                  message.success(`Signature uploaded successfully`);
                } catch (err) {
                  onError(err);
                  message.error("Upload failed");
                }
              }}
            >
              <Button icon={<UploadOutlined />}>Upload Signature Image</Button>
            </Upload>
          </Form.Item>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
            <Button onClick={() => setReceiveLegModalOpen(false)}>Cancel</Button>
            <Button type="primary" htmlType="submit">Submit Acknowledgment</Button>
          </div>
        </Form>
      </Modal>

      {/* Handover Leg Modal */}
      <Modal
        title={<span style={{ color: '#0f172a', fontWeight: 700 }}><SendOutlined style={{ color: '#4f46e5' }} /> HANDOVER CUSTODY TO NEXT LEG</span>}
        open={handoverLegModalOpen}
        onCancel={() => {
          setHandoverLegModalOpen(false);
          handoverForm.resetFields();
          setHandoverPhotos([]);
          setHandoverSignature('');
        }}
        footer={null}
      >
        <Form
          form={handoverForm}
          layout="vertical"
          onFinish={async (values) => {
            if (!handoverSignature) {
              message.warning("Handover signature upload is required!");
              return;
            }
            try {
              const cleanedDriverPhone = values.driver_phone ? values.driver_phone.replace(/[\s\-()]/g, '') : undefined;
              const cleanedReceivedPhone = values.received_by_phone ? values.received_by_phone.replace(/[\s\-()]/g, '') : undefined;

              const payload = {
                handover_type: values.handover_type,
                vehicle_no: values.vehicle_no,
                driver_name: values.driver_name || values.received_by_name,
                driver_phone: cleanedDriverPhone || cleanedReceivedPhone,
                courier_name: values.courier_name,
                awb_no: values.awb_no,
                remarks: values.remarks,
                handover_photos: handoverPhotos,
                handover_signature: handoverSignature
              };
              
              await api.post(`/logistics/sdo/${activeSdo.id}/handover`, payload);
              message.success("Custody leg handed over successfully!");
              setHandoverLegModalOpen(false);
              handoverForm.resetFields();
              setHandoverPhotos([]);
              setHandoverSignature('');
              setShowDesigner(false);
              await fetchData();
            } catch (err) {
              console.error(err);
              const detail = err?.response?.data?.detail;
              message.error(typeof detail === 'string' ? detail : "Failed to execute handover.");
            }
          }}
          initialValues={{ handover_type: 'own vehicle' }}
        >
          <Form.Item name="handover_type" label="Handover Methodology" rules={[{ required: true }]}>
            <Select>
              <Option value="own vehicle">Self-Owned Fleet Dispatch</Option>
              <Option value="COURIER">Courier Dispatch</Option>
              <Option value="IN_PERSON">In-Person Handover</Option>
            </Select>
          </Form.Item>

          <Form.Item noStyle shouldUpdate={(prevValues, currentValues) => prevValues.handover_type !== currentValues.handover_type}>
            {({ getFieldValue }) => {
              const type = getFieldValue('handover_type');
              if (type === 'own vehicle') {
                return (
                  <>
                    <Form.Item name="vehicle_no" label="Vehicle Number" rules={[{ required: true }]}>
                      <Input placeholder="E.g., MH-12-PQ-1234" />
                    </Form.Item>
                    <Form.Item name="driver_name" label="Driver Full Name" rules={[{ required: true }]}>
                      <Input placeholder="Driver Name" />
                    </Form.Item>
                    <Form.Item
                      name="driver_phone"
                      label="Driver Phone Number"
                      rules={[
                        { required: true, message: 'Driver Phone is required' },
                        {
                          validator: (_, value) => {
                            if (!value) return Promise.resolve();
                            const cleaned = value.replace(/[\s\-()]/g, '');
                            if (/^(?:\+?91|0)?[6-9]\d{9}$/.test(cleaned) || /^\+?[1-9]\d{9,14}$/.test(cleaned)) {
                              return Promise.resolve();
                            }
                            return Promise.reject(new Error('Enter a valid 10-digit mobile number, optionally with country code'));
                          }
                        }
                      ]}
                    >
                      <Input placeholder="Driver Phone" />
                    </Form.Item>
                  </>
                );
              }
              if (type === 'COURIER') {
                return (
                  <>
                    <Form.Item name="courier_name" label="Courier Company Name" rules={[{ required: true }]}>
                      <Input placeholder="E.g., DHL, BlueDart" />
                    </Form.Item>
                    <Form.Item name="awb_no" label="AWB / Tracking Number" rules={[{ required: true }]}>
                      <Input placeholder="AWB Number" />
                    </Form.Item>
                  </>
                );
              }
              if (type === 'IN_PERSON') {
                return (
                  <>
                    <Form.Item name="received_by_name" label="Receiver Employee Name" rules={[{ required: true }]}>
                      <Input placeholder="Name of person receiving custody" />
                    </Form.Item>
                    <Form.Item
                      name="received_by_phone"
                      label="Receiver Phone Number"
                      rules={[
                        { required: true, message: 'Receiver Phone is required' },
                        {
                          validator: (_, value) => {
                            if (!value) return Promise.resolve();
                            const cleaned = value.replace(/[\s\-()]/g, '');
                            if (/^(?:\+?91|0)?[6-9]\d{9}$/.test(cleaned) || /^\+?[1-9]\d{9,14}$/.test(cleaned)) {
                              return Promise.resolve();
                            }
                            return Promise.reject(new Error('Enter a valid 10-digit mobile number, optionally with country code'));
                          }
                        }
                      ]}
                    >
                      <Input placeholder="Phone number" />
                    </Form.Item>
                  </>
                );
              }
              return null;
            }}
          </Form.Item>

          <Form.Item name="remarks" label="Handover Remarks">
            <Input.TextArea rows={2} placeholder="Loading conditions, seal number, etc..." />
          </Form.Item>

          <Form.Item label="Materials Photos (Upload condition photos)" required>
            <Upload
              listType="picture-card"
              multiple
              customRequest={async ({ file, onSuccess, onError }) => {
                try {
                  const url = await uploadImageFile(file);
                  setHandoverPhotos((prev) => [...prev, url]);
                  onSuccess(null, file);
                  message.success(`${file.name} uploaded`);
                } catch (err) {
                  onError(err);
                  message.error("Upload failed");
                }
              }}
            >
              <div>
                <PlusOutlined />
                <div style={{ marginTop: 8 }}>Upload</div>
              </div>
            </Upload>
          </Form.Item>

          <Form.Item label="Handover Custodian Signature Upload" required>
            <Upload
              maxCount={1}
              listType="picture"
              customRequest={async ({ file, onSuccess, onError }) => {
                try {
                  const url = await uploadImageFile(file);
                  setHandoverSignature(url);
                  onSuccess(null, file);
                  message.success(`Signature uploaded successfully`);
                } catch (err) {
                  onError(err);
                  message.error("Upload failed");
                }
              }}
            >
              <Button icon={<UploadOutlined />}>Upload Signature Image</Button>
            </Upload>
          </Form.Item>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
            <Button onClick={() => setHandoverLegModalOpen(false)}>Cancel</Button>
            <Button type="primary" htmlType="submit">Submit Handover</Button>
          </div>
        </Form>
      </Modal>

      {/* SCM Dispatch Plan Ledger collapse */}
      {!showDesigner && (
      <div style={{ marginTop: '16px' }}>
        <Collapse
          style={{ background: 'transparent', border: 'none' }}
          className="logistics-dark-collapse"
          expandIconPosition="end"
          items={collapseItems}
        />
      </div>
      )}

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
