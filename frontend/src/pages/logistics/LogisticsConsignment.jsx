import React, { useState, useEffect, useCallback } from 'react';
import Barcode from 'react-barcode';
import {
  Card, Table, Tag, Button, Modal, Form, Select, Input, InputNumber,
  Space, Spin, App, Row, Col, Divider, Alert, Tooltip, Empty,
  Descriptions, Typography, Progress, Collapse, Statistic
} from 'antd';
import {
  PlusOutlined, EyeOutlined, SearchOutlined, ArrowLeftOutlined,
  CheckCircleOutlined, SendOutlined, InboxOutlined,
  BarcodeOutlined, EnvironmentOutlined,
  LoadingOutlined, ScanOutlined,
  GoldOutlined, BoxPlotOutlined, DeleteOutlined, GiftOutlined,
  PrinterOutlined, DownloadOutlined, LockOutlined, UnlockOutlined,
  EditOutlined
} from '@ant-design/icons';
import api from '../../config/api';
import dayjs from 'dayjs';

import { formatNumber, formatDate } from '../../utils/helpers';
import ParentPackagingModal from './ParentPackagingModal';
import AssetCodesTreeModal from '../../components/AssetCodesTreeModal';

const { Title, Text } = Typography;
const { Option } = Select;
const { Panel } = Collapse;

const STATUS_COLORS = {
  DRAFT: 'default',
  PACKED: 'blue',
  IN_TRANSIT: 'processing',
  PARTIALLY_RECEIVED: 'warning',
  RECEIVED: 'success',
  CANCELLED: 'error',
};

export default function LogisticsConsignment() {
  const { message } = App.useApp();

  // List state
  const [loading, setLoading] = useState(true);
  const [consignments, setConsignments] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState(null);

  // Create form state
  const [showCreate, setShowCreate] = useState(false);
  const [form] = Form.useForm();
  const [materialIssues, setMaterialIssues] = useState([]);
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [selectedIssueItems, setSelectedIssueItems] = useState([]);
  const [loadingIssue, setLoadingIssue] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [packages, setPackages] = useState([]);
  const [editId, setEditId] = useState(null);

  // Modal states for selectable serial numbers in packages creation
  const [modalOpen, setModalOpen] = useState(false);
  const [activePkgKey, setActivePkgKey] = useState(null);
  const [activeMiItemId, setActiveMiItemId] = useState(null);

  // Detail view state
  const [detailConsignment, setDetailConsignment] = useState(null);
  const [showDetail, setShowDetail] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [parentPackagingVisible, setParentPackagingVisible] = useState(false);

  const [printLabelData, setPrintLabelData] = useState(null);
  const [printLabelType, setPrintLabelType] = useState(''); // 'consignment', 'parent', 'package'

  const getRemainingQty = (miItem, currentPkgKey) => {
    const miQty = parseFloat(miItem.qty || miItem.quantity || 0);
    const packedInOthers = packages
      .filter(p => p.key !== currentPkgKey)
      .reduce((sum, p) => {
        const item = p.items.find(i => i.material_issue_item_id === miItem.id);
        return sum + parseFloat(item ? item.quantity_packed || 0 : 0);
      }, 0);
    return Math.max(0, miQty - packedInOthers);
  };

  const getAvailableSerials = (miItem, currentPkgKey, currentPackages = packages) => {
    const allSerials = miItem.serial_numbers || [];
    const usedInOthers = currentPackages
      .filter(p => p.key !== currentPkgKey)
      .reduce((acc, p) => {
        const item = p.items.find(i => i.material_issue_item_id === miItem.id);
        if (item && item.serial_numbers) {
          item.serial_numbers.forEach(sn => acc.add(sn));
        }
        return acc;
      }, new Set());
    return allSerials.filter(sn => !usedInOthers.has(sn));
  };

  const handlePackageItemQtyChange = (pkgKey, miItemId, qty) => {
    setPackages(prev => prev.map(p => {
      if (p.key !== pkgKey) return p;
      return {
        ...p,
        items: p.items.map(i => {
          if (i.material_issue_item_id === miItemId) {
            const miItem = selectedIssueItems.find(item => item.id === miItemId);
            let updatedSerials = i.serial_numbers || [];
            if (miItem && miItem.serial_numbers && miItem.serial_numbers.length > 0) {
              const available = getAvailableSerials(miItem, pkgKey, prev);
              updatedSerials = available.slice(0, Math.min(qty, available.length));
            }
            return {
              ...i,
              quantity_packed: qty,
              serial_numbers: updatedSerials,
            };
          }
          return i;
        }),
      };
    }));
  };

  const handlePackageItemSerialsChange = (pkgKey, miItemId, selectedSns) => {
    setPackages(prev => prev.map(p => {
      if (p.key !== pkgKey) return p;
      return {
        ...p,
        items: p.items.map(i => {
          if (i.material_issue_item_id === miItemId) {
            return {
              ...i,
              serial_numbers: selectedSns,
              quantity_packed: selectedSns.length
            };
          }
          return i;
        })
      };
    }));
  };

  const handleDownloadBarcode = (val) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = `https://bwipjs-api.metafloor.com/?bcid=code128&text=${encodeURIComponent(val)}&scale=3&rotate=N&includetext`;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      // 50 x 25 mm size at 300 DPI
      canvas.width = 590;
      canvas.height = 295;
      const ctx = canvas.getContext('2d');
      
      // Fill white background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Center and scale the barcode image
      // Give it some padding
      const padX = 25;
      const padY = 20;
      const destW = canvas.width - (padX * 2);
      const destH = canvas.height - (padY * 2);
      
      ctx.drawImage(img, padX, padY, destW, destH);
      
      // Download
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `barcode_${val}.png`;
      a.click();
    };
    img.onerror = () => {
      message.error('Failed to download barcode image');
    };
  };

  const handlePreviewConsignmentLabel = () => {
    if (!detailConsignment) return;
    setPrintLabelType('consignment');
    setPrintLabelData({
      title: 'CONSIGNMENT',
      subtitle: 'MANIFEST',
      number: detailConsignment.consignment_number,
      barcode: detailConsignment.consignment_barcode || detailConsignment.consignment_number,
      details: [
        { label: 'MI Number', value: detailConsignment.material_issue_number },
        { label: 'Indent #', value: detailConsignment.indent_number || '—' },
        { label: 'Source WH', value: detailConsignment.warehouse_name },
        { label: 'Destination WH', value: detailConsignment.destination_warehouse_name || '—' },
        { label: 'Receiver', value: detailConsignment.receiver_employee_code 
          ? `${detailConsignment.receiver_name || ''} (${detailConsignment.receiver_employee_code})` 
          : (detailConsignment.receiver_name || '—') },
        { label: 'Total Packages', value: detailConsignment.total_packages },
        { label: 'Total Weight', value: `${detailConsignment.total_weight_kg || 0} KG` },
        { label: 'Total Volume', value: `${detailConsignment.total_volume_cft || 0} CFT` },
      ]
    });
  };

  const handlePreviewParentLabel = async (parentCode) => {
    if (!detailConsignment) return;
    try {
      const parentsRes = await api.get(`/consignment/${detailConsignment.id}/parent-packages`);
      const parent = (parentsRes.data || []).find(p => p.parent_package_number === parentCode);
      if (!parent) {
        message.error('Parent package details not found');
        return;
      }
      const labelRes = await api.get(`/consignment/${detailConsignment.id}/parent-packages/${parent.id}/label`);
      const label = labelRes.data;
      setPrintLabelType('parent');
      setPrintLabelData({
        title: 'PARENT PACKAGE',
        subtitle: label.parent_package_type,
        number: label.parent_package_number,
        barcode: label.parent_package_barcode || label.parent_package_number,
        details: [
          { label: 'Consignment', value: label.consignment_number },
          { label: 'Destination', value: label.destination_warehouse_name || '—' },
          { label: 'Receiver', value: label.receiver_employee_code 
            ? `${label.receiver_name || ''} (${label.receiver_employee_code})` 
            : (label.receiver_name || '—') },
          { label: 'Child Packages', value: label.child_package_count },
          { label: 'Gross Weight', value: `${label.gross_weight_kg || 0} KG` },
          { label: 'Volume', value: `${label.total_volume_cft || 0} CFT` },
        ]
      });
    } catch (err) {
      message.error('Failed to load parent package label details');
    }
  };

  const handlePreviewPackageLabel = async (pkgId) => {
    try {
      const res = await api.get(`/consignment/package/${pkgId}/label`);
      const label = res.data;
      setPrintLabelType('package');
      setPrintLabelData({
        title: 'PACKAGE',
        subtitle: label.package_type,
        number: label.package_number,
        barcode: label.package_barcode_value || label.package_number,
        details: [
          { label: 'Consignment', value: label.consignment_number },
          { label: 'Location', value: label.location || '—' },
          { label: 'Receiver', value: label.receiver_employee_code 
            ? `${label.receiver_name || ''} (${label.receiver_employee_code})` 
            : (label.receiver_name || '—') },
          { label: 'Material Count', value: label.material_count },
          { label: 'Weight', value: `${label.gross_weight_kg || 0} KG` },
        ]
      });
    } catch (err) {
      message.error('Failed to load package label details');
    }
  };

  const handlePrintLabelAction = (label) => {
    const w = window.open('', '_blank', 'width=500,height=700');
    if (!w) {
      message.error('Pop-up blocked. Please allow pop-ups for this site.');
      return;
    }
    const detailsHtml = label.details.map(d => 
      `<div><span class="label-text">${d.label}:</span> <span class="value">${d.value}</span></div>`
    ).join('');

    w.document.write(`<!DOCTYPE html><html><head><title>Label: ${label.number}</title>
      <style>
        @page { size: 4in 6in; margin: 6mm; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Courier New', Courier, monospace; font-size: 11px; color: #000; }
        .label { border: 2px solid #000; padding: 15px; width: 100%; max-width: 3.8in; min-height: 5.5in; display: flex; flex-direction: column; }
        .header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 8px; }
        .header h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 1px; }
        .header .type { font-size: 12px; font-weight: bold; text-transform: uppercase; }
        .barcode-section { text-align: center; margin: 8px 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
        .barcode-section svg { max-width: 100%; }
        .info-grid { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; font-size: 11px; }
        .info-grid div { display: flex; justify-content: space-between; border-bottom: 1px dotted #ccc; padding-bottom: 2px; }
        .info-grid .label-text { font-weight: bold; color: #333; }
        .info-grid .value { font-weight: bold; }
        .footer { margin-top: auto; border-top: 1px solid #000; padding-top: 4px; font-size: 9px; text-align: center; }
      </style>
    </head><body>
      <div class="label">
        <div class="header">
          <h2>${label.title}</h2>
          ${label.subtitle ? `<div class="type">${label.subtitle}</div>` : ''}
        </div>
        <div style="text-align:center;margin:6px 0;">
          <strong style="font-size:16px;letter-spacing:0.5px;">${label.number}</strong>
        </div>
        <div class="barcode-section">
          <svg id="barcode-svg"></svg>
        </div>
        <div class="info-grid">
          ${detailsHtml}
        </div>
        <div class="footer">
          Printed: ${new Date().toLocaleString()} | ${label.number}
        </div>
      </div>
      <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
      <script>
        try { JsBarcode('#barcode-svg', '${label.number}', { width: 1.5, height: 40, fontSize: 10, margin: 2 }); } catch(e) {}
        window.onload = function() { setTimeout(function() { window.print(); }, 500); };
      </script>
    </body></html>`);
    w.document.close();
  };

  const activeMiItem = selectedIssueItems.find(item => item.id === activeMiItemId);
  const activePkg = packages.find(p => p.key === activePkgKey);
  const activePkgItem = activePkg ? activePkg.items.find(i => i.material_issue_item_id === activeMiItemId) : null;

  const lockedCodes = React.useMemo(() => {
    if (!activeMiItem) return {};
    const map = {};
    packages.forEach((pkg, index) => {
      if (pkg.key === activePkgKey) return; // skip current package
      const item = pkg.items.find(i => i.material_issue_item_id === activeMiItem.id);
      if (item && item.serial_numbers) {
        item.serial_numbers.forEach(sn => {
          map[sn] = pkg.package_description || `Package ${index + 1}`;
        });
      }
    });
    return map;
  }, [activeMiItem, packages, activePkgKey]);

  const mockRawRows = React.useMemo(() => {
    if (!activeMiItem) return [];
    // Show only current package's selected codes + available codes (not used in other packages)
    const available = getAvailableSerials(activeMiItem, activePkgKey);
    const selected = activePkgItem ? (activePkgItem.serial_numbers || []) : [];
    const pool = Array.from(new Set([...selected, ...available]));
    return [{
      location: 'Issued Stock',
      bin_name: 'Issued Area',
      batch_number: activeMiItem.batch_number || activeMiItem.batch?.batch_number || 'Issued Batch',
      serial_numbers: pool,
      asset_codes: pool,
      consumable_codes: pool,
      batch_id: activeMiItem.batch_id,
      bin_id: activeMiItem.bin_id,
    }];
  }, [activeMiItem, activePkgItem, activePkgKey]);

  const handleSaveModalCodes = (selected) => {
    handlePackageItemSerialsChange(activePkgKey, activeMiItemId, selected);
    setModalOpen(false);
    setActivePkgKey(null);
    setActiveMiItemId(null);
  };

  // Fetch consignments list
  const fetchConsignments = useCallback(async (p = page) => {
    try {
      setLoading(true);
      const params = { page: p, page_size: pageSize };
      if (statusFilter) params.status = statusFilter;
      if (searchText) params.search = searchText;
      const res = await api.get('/consignment', { params });
      setConsignments(res.data.data || []);
      setTotal(res.data.total || 0);
    } catch (err) {
      console.error('Failed to fetch consignments:', err);
      message.error('Failed to load consignments');
    } finally {
      setLoading(false);
    }
  }, [pageSize, statusFilter, searchText, message]);

  useEffect(() => {
    fetchConsignments();
  }, [page, pageSize, statusFilter]);

  // Fetch Material Issues for create form
  const fetchMaterialIssues = async (editingMaterialIssueId = null, currentConsignmentId = null) => {
    try {
      const issuesRes = await api.get('/warehouse/material-issues', { params: { page_size: 100, status: 'issued' } }).catch(() => ({ data: { items: [] } }));
      const consignmentsRes = await api.get('/consignment', { params: { page_size: 200 } }).catch(() => ({ data: { data: [] } }));
      
      const issues = issuesRes.data?.items || issuesRes.data?.data || issuesRes.data || [];
      const consignments = consignmentsRes.data?.data || [];
      
      const existingMiIds = new Set(
        consignments
          .filter(c => c && c.status !== 'CANCELLED' && c.id !== currentConsignmentId && c.id !== editId)
          .map(c => c.material_issue_id)
      );

      const filteredIssues = (Array.isArray(issues) ? issues.filter(i => i && i.status === 'issued') : [])
        .filter(i => {
          if (existingMiIds.has(i.id) && i.id !== editingMaterialIssueId) {
            return false;
          }
          return true;
        });

      setMaterialIssues(filteredIssues);
    } catch (err) {
      console.warn('Could not fetch material issues:', err);
    }
  };

  const handleOpenCreate = () => {
    setShowCreate(true);
    setShowDetail(false);
    setDetailConsignment(null);
    form.resetFields();
    setSelectedIssue(null);
    setSelectedIssueItems([]);
    setPackages([]);
    setEditId(null);
    fetchMaterialIssues();
  };

  const handleEditConsignment = async (conRecord) => {
    setLoadingIssue(true);
    try {
      setEditId(conRecord.id);
      setShowCreate(true);
      setShowDetail(false);
      setDetailConsignment(null);
      form.resetFields();

      // Fetch material issues list for selection dropdown
      await fetchMaterialIssues(conRecord.material_issue_id, conRecord.id);

      // Fetch consignment details (with packages and items)
      const resCon = await api.get(`/consignment/${conRecord.id}`);
      const conData = resCon.data;

      // Fetch Material Issue details
      const resMi = await api.get(`/warehouse/material-issues/${conData.material_issue_id}`);
      const issueData = resMi.data;

      setSelectedIssue(issueData);

      // We map the issue items and inject packed_qty for previous consignments (excluding this one).
      const items = (issueData.items || []).map(item => {
        let packedInThisCon = 0;
        (conData.packages || []).forEach(pkg => {
          const pItem = (pkg.items || []).find(i => i.material_issue_item_id === item.id);
          if (pItem) {
            packedInThisCon += parseFloat(pItem.quantity_packed || 0);
          }
        });

        const otherPacked = Math.max(0, parseFloat(item.packed_qty || 0) - packedInThisCon);
        const remaining = Math.max(0, parseFloat(item.qty || 0) - otherPacked);

        return {
          ...item,
          key: item.id || Math.random(),
          quantity_packed: remaining,
          packed_qty: otherPacked,
        };
      });
      setSelectedIssueItems(items);

      // Pre-fill form fields
      form.setFieldsValue({
        material_issue_id: conData.material_issue_id,
        receiver_employee_code: conData.receiver_employee_code || '',
        receiver_name: conData.receiver_name || '',
        state_code: conData.state_code || 'AP',
        mdo_id: conData.mdo_id || undefined,
        indent_id: conData.indent_id || undefined,
      });

      // Map packages
      const mappedPackages = (conData.packages || []).map((pkg, pkgIdx) => {
        return {
          key: pkg.id || Date.now() + pkgIdx,
          package_type: pkg.package_type || 'BOX',
          package_description: pkg.package_description || `Package ${pkgIdx + 1}`,
          gross_weight_kg: parseFloat(pkg.gross_weight_kg || 0),
          length_cm: pkg.length_cm ? parseFloat(pkg.length_cm) : undefined,
          width_cm: pkg.width_cm ? parseFloat(pkg.width_cm) : undefined,
          height_cm: pkg.height_cm ? parseFloat(pkg.height_cm) : undefined,
          seal_number: pkg.seal_number || '',
          parent_package_group: pkg.parent_package_code || null,
          items: (pkg.items || []).map(i => {
            return {
              material_issue_item_id: i.material_issue_item_id,
              material_id: i.material_id,
              quantity_packed: parseFloat(i.quantity_packed || 0),
              uom_code: i.uom_code || 'NOS',
              batch_id: i.batch_id || undefined,
              source_bin_id: i.source_bin_id || undefined,
              serial_numbers: i.serial_numbers || [],
              unit_price: parseFloat(i.unit_price || 0),
              _material_name: i.item_name || i.item?.name || 'Material',
              _material_code: i.item_code || i.item?.item_code || '',
            };
          }),
          locked: true,
        };
      });
      setPackages(mappedPackages);

    } catch (err) {
      console.error('Failed to load consignment for editing:', err);
      message.error('Failed to load consignment details for editing');
    } finally {
      setLoadingIssue(false);
    }
  };

  const handleIssueSelect = async (issueId) => {
    if (!issueId) {
      setSelectedIssue(null);
      setSelectedIssueItems([]);
      setPackages([]);
      return;
    }
    setLoadingIssue(true);
    try {
      const res = await api.get(`/warehouse/material-issues/${issueId}`);
      const issueData = res.data;
      setSelectedIssue(issueData);
      const items = (issueData.items || []).map(item => ({
        ...item,
        key: item.id || Math.random(),
        quantity_packed: item.qty || item.quantity || 0,
      }));
      setSelectedIssueItems(items);

      // Auto-populate receiver fields from MI's issued_to data
      if (issueData.issued_to_employee_code || issueData.issued_to_name) {
        form.setFieldsValue({
          receiver_employee_code: issueData.issued_to_employee_code || '',
          receiver_name: issueData.issued_to_name || '',
        });
      }

      // Auto-create a default package with all items
      const defaultPkgItems = items.map(i => ({
        material_issue_item_id: i.id,
        material_id: i.item_id || i.material_id,
        quantity_packed: i.quantity_packed,
        uom_code: i.uom_code || i.uom_name || 'NOS',
        batch_id: i.batch_id || undefined,
        source_bin_id: i.bin_id || undefined,
        serial_numbers: i.serial_numbers || [],
        unit_price: i.rate || 0,
        _material_name: i.item_name || i.item?.name || 'Material',
        _material_code: i.item_code || i.item?.item_code || '',
      }));

      setPackages([{
        key: Date.now(),
        package_type: 'BOX',
        package_description: `Package 1 - ${issueData.issue_number || ''}`,
        gross_weight_kg: defaultPkgItems.reduce((sum, i) => sum + (parseFloat(i.quantity_packed || 0) * 0.5), 0),
        length_cm: 30,
        width_cm: 20,
        height_cm: 15,
        seal_number: '',
        parent_package_group: null,
        items: defaultPkgItems,
        locked: false,
      }]);
    } catch (err) {
      console.error('Failed to load MI items:', err);
      message.error('Failed to load material issue items');
    } finally {
      setLoadingIssue(false);
    }
  };

  const handleAddPackage = () => {
    setPackages(prev => [...prev, {
      key: Date.now(),
      package_type: 'BOX',
      package_description: `Package ${prev.length + 1}`,
      gross_weight_kg: 0,
      length_cm: 30,
      width_cm: 20,
      height_cm: 15,
      seal_number: '',
      parent_package_group: null,
      items: [],
      locked: false,
    }]);
  };

  const handleRemovePackage = (pkgKey) => {
    setPackages(prev => prev.filter(p => p.key !== pkgKey));
  };

  const handlePackageFieldChange = (pkgKey, field, value) => {
    setPackages(prev => prev.map(p => p.key === pkgKey ? { ...p, [field]: value } : p));
  };

  const handlePackageItemToggle = (pkgKey, miItem) => {
    setPackages(prev => {
      const currentPkg = prev.find(p => p.key === pkgKey);
      if (!currentPkg) return prev;
      const exists = currentPkg.items.find(i => i.material_issue_item_id === miItem.id);
      if (exists) {
        return prev.map(p => p.key === pkgKey ? { ...p, items: p.items.filter(i => i.material_issue_item_id !== miItem.id) } : p);
      }
      
      const miQty = parseFloat(miItem.qty || miItem.quantity || 0);
      const packedInOthers = prev
        .filter(p => p.key !== pkgKey)
        .reduce((sum, p) => {
          const item = p.items.find(i => i.material_issue_item_id === miItem.id);
          return sum + parseFloat(item ? item.quantity_packed || 0 : 0);
        }, 0);
      const remaining = Math.max(0, miQty - packedInOthers);

      const allSerials = miItem.serial_numbers || [];
      const usedInOthers = prev
        .filter(p => p.key !== pkgKey)
        .reduce((acc, p) => {
          const item = p.items.find(i => i.material_issue_item_id === miItem.id);
          if (item && item.serial_numbers) {
            item.serial_numbers.forEach(sn => acc.add(sn));
          }
          return acc;
        }, new Set());
      const availableSerials = allSerials.filter(sn => !usedInOthers.has(sn));

      const hasSerials = allSerials.length > 0;
      const initialSns = hasSerials ? availableSerials : [];
      const initialQty = hasSerials ? availableSerials.length : remaining;

      return prev.map(p => p.key === pkgKey ? {
        ...p,
        items: [...p.items, {
          material_issue_item_id: miItem.id,
          material_id: miItem.item_id || miItem.material_id,
          quantity_packed: initialQty,
          uom_code: miItem.uom_code || miItem.uom_name || 'NOS',
          batch_id: miItem.batch_id || undefined,
          source_bin_id: miItem.bin_id || undefined,
          serial_numbers: initialSns,
          unit_price: miItem.rate || 0,
          _material_name: miItem.item_name || miItem.item?.name || 'Material',
          _material_code: miItem.item_code || miItem.item?.item_code || '',
        }],
      } : p);
    });
  };

  const handleCreateSubmit = async (values) => {
    if (!selectedIssue) {
      message.warning('Please select a Material Issue');
      return;
    }
    if (packages.length === 0) {
      message.warning('Add at least one package');
      return;
    }
    // Validate each package has items and is locked
    for (const pkg of packages) {
      if (pkg.items.length === 0) {
        message.warning(`Package "${pkg.package_description}" has no items`);
        return;
      }
      if (!pkg.locked) {
        message.warning(`Please click "Create Package" to lock Package "${pkg.package_description}" before creating the consignment.`);
        return;
      }
    }

    // Validate that total quantity packed for each MI item across all packages matches the issued quantity
    for (const miItem of selectedIssueItems) {
      const totalPackedInPkgs = packages.reduce((sum, pkg) => {
        const pItem = pkg.items.find(i => i.material_issue_item_id === miItem.id);
        return sum + parseFloat(pItem ? pItem.quantity_packed || 0 : 0);
      }, 0);
      const targetQty = parseFloat(miItem.qty || miItem.quantity || 0);
      if (Math.abs(totalPackedInPkgs - targetQty) > 0.0001) {
        message.warning(`Total packed quantity (${totalPackedInPkgs}) for item "${miItem.item_name || miItem.item?.name || 'Material'}" must equal the issued quantity (${targetQty}).`);
        return;
      }
    }

    try {
      setSubmitting(true);
      const payload = {
        material_issue_id: selectedIssue.id,
        indent_id: selectedIssue.indent_id || values.indent_id || null,
        mdo_id: values.mdo_id || null,
        destination_warehouse_id: selectedIssue.destination_warehouse_id || null,
        receiver_employee_code: selectedIssue.issued_to_employee_code || null,
        receiver_name: selectedIssue.issued_to_name || null,
        receiver_position_code: selectedIssue.position_code || null,
        state_code: values.state_code || 'AP',
        packages: packages.map(pkg => ({
          package_type: pkg.package_type,
          package_description: pkg.package_description,
          length_cm: pkg.length_cm || null,
          width_cm: pkg.width_cm || null,
          height_cm: pkg.height_cm || null,
          gross_weight_kg: pkg.gross_weight_kg || 0,
          seal_number: pkg.seal_number || null,
          parent_package_group: pkg.parent_package_group || null,
          items: pkg.items.map(item => ({
            material_issue_item_id: item.material_issue_item_id,
            material_id: item.material_id,
            batch_id: item.batch_id || null,
            source_bin_id: item.source_bin_id || null,
            quantity_packed: item.quantity_packed,
            serial_numbers: item.serial_numbers || null,
            uom_code: item.uom_code || 'NOS',
            unit_price: item.unit_price || 0,
          })),
        })),
      };

      if (editId) {
        await api.put(`/consignment/${editId}`, payload);
        message.success('Consignment updated successfully!');
      } else {
        await api.post('/consignment', payload);
        message.success('Consignment created successfully!');
      }
      setShowCreate(false);
      setEditId(null);
      form.resetFields();
      setSelectedIssue(null);
      setSelectedIssueItems([]);
      setPackages([]);
      setPage(1);
      await fetchConsignments(1);
    } catch (err) {
      console.error('Failed to create consignment:', err);
      let errMsg = 'Failed to create consignment';
      if (err.response?.data?.detail) {
        if (typeof err.response.data.detail === 'string') {
          errMsg = err.response.data.detail;
        } else if (Array.isArray(err.response.data.detail)) {
          errMsg = err.response.data.detail.map(d => d.msg).join(', ');
        }
      }
      message.error(errMsg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleViewDetail = async (conId) => {
    try {
      setLoadingDetail(true);
      const res = await api.get(`/consignment/${conId}`);
      setDetailConsignment(res.data);
      setShowDetail(true);
      setShowCreate(false);
    } catch (err) {
      console.error('Failed to load consignment detail:', err);
      message.error('Failed to load consignment details');
    } finally {
      setLoadingDetail(false);
    }
  };

  const handlePack = async (conId) => {
    try {
      await api.post(`/consignment/${conId}/pack`);
      message.success('Consignment marked as PACKED');
      await fetchConsignments(page);
      if (detailConsignment?.id === conId) handleViewDetail(conId);
    } catch (err) {
      message.error(err.response?.data?.detail || 'Failed to pack consignment');
    }
  };

  const handleDispatch = async (conId) => {
    try {
      await api.post(`/consignment/${conId}/dispatch`);
      message.success('Consignment marked as IN_TRANSIT');
      await fetchConsignments(page);
      if (detailConsignment?.id === conId) handleViewDetail(conId);
    } catch (err) {
      message.error(err.response?.data?.detail || 'Failed to dispatch consignment');
    }
  };

  // ── Table columns ──
  const columns = [
    {
      title: 'Consignment #',
      dataIndex: 'consignment_number',
      key: 'con_number',
      render: (val, record) => (
        <Button type="link" style={{ fontFamily: 'monospace', fontWeight: 700, padding: 0 }}
          onClick={() => handleViewDetail(record.id)}>
          {val}
        </Button>
      ),
    },
    {
      title: 'MI Reference',
      dataIndex: 'material_issue_number',
      key: 'mi',
      render: (val) => <span style={{ fontFamily: 'monospace', color: '#475569' }}>{val || '—'}</span>,
    },
    {
      title: 'Source WH',
      dataIndex: 'warehouse_name',
      key: 'wh',
      ellipsis: true,
    },
    {
      title: 'Destination WH',
      dataIndex: 'destination_warehouse_name',
      key: 'dest_wh',
      ellipsis: true,
      render: (val) => <span>{val || '—'}</span>,
    },
    {
      title: 'Receiver',
      key: 'receiver',
      render: (_, r) => <span>{r.receiver_name || r.receiver_employee_code || '—'}</span>,
    },
    {
      title: 'Packages',
      key: 'pkgs',
      render: (_, r) => (
        <span style={{ fontFamily: 'monospace' }}>
          {r.packages_received || 0}/{r.total_packages || 0}
        </span>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (s) => <Tag color={STATUS_COLORS[s] || 'default'}>{s?.replace('_', ' ')}</Tag>,
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      key: 'created',
      render: (d) => <span style={{ fontSize: '12px', color: '#64748b' }}>{formatDate(d)}</span>,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 240,
      render: (_, r) => (
        <Space size="small" wrap>
          <Tooltip title="View details & packages">
            <Button size="small" icon={<EyeOutlined />} onClick={() => handleViewDetail(r.id)} />
          </Tooltip>
          {r.status === 'DRAFT' && (
            <>
              <Tooltip title="Edit consignment">
                <Button size="small" icon={<EditOutlined />} onClick={() => handleEditConsignment(r)} />
              </Tooltip>
              <Tooltip title="Mark as PACKED">
                <Button size="small" type="primary" icon={<CheckCircleOutlined />}
                  style={{ background: '#0284c7' }}
                  onClick={() => handlePack(r.id)}>Pack</Button>
              </Tooltip>
            </>
          )}
        </Space>
      ),
    },
  ];

  // ── Loading state ──
  if (loading && consignments.length === 0 && !showCreate && !showDetail) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <Spin indicator={<LoadingOutlined style={{ fontSize: 40 }} spin />} />
        <span style={{ color: '#64748b', fontSize: 16 }}>Loading consignments...</span>
      </div>
    );
  }

  // ── Detail View ──
  if (showDetail && detailConsignment) {
    return (
      <div style={{ padding: '24px', background: 'radial-gradient(ellipse at top, #f8fafc 0%, #f1f5f9 80%)', minHeight: '100vh' }}>
        <div style={{
          background: '#ffffff', padding: '20px 24px', borderRadius: '12px',
          border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)',
          marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px'
        }}>
          <Space>
            <Button icon={<ArrowLeftOutlined />} onClick={() => { setShowDetail(false); setDetailConsignment(null); }}
              style={{ borderRadius: '8px', fontWeight: 600 }}>Back</Button>
            <Tag color={STATUS_COLORS[detailConsignment.status] || 'default'} style={{ fontWeight: 700, fontSize: '13px' }}>
              {detailConsignment.status?.replace('_', ' ')}
            </Tag>
            <span style={{ fontFamily: 'monospace', fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>
              {detailConsignment.consignment_number}
            </span>
          </Space>
          <Space>
            <Button
              icon={<PrinterOutlined style={{ color: '#4f46e5' }} />}
              onClick={handlePreviewConsignmentLabel}
              style={{ borderRadius: '8px', fontWeight: 600 }}
            >
              Print Consignment
            </Button>
            <Button
              icon={<DownloadOutlined style={{ color: '#16a34a' }} />}
              onClick={() => handleDownloadBarcode(detailConsignment.consignment_number)}
              style={{ borderRadius: '8px', fontWeight: 600 }}
            >
              Download Barcode
            </Button>
            {detailConsignment.status === 'DRAFT' && (
              <Button type="primary" icon={<CheckCircleOutlined />}
                onClick={() => handlePack(detailConsignment.id)}
                style={{ background: '#0284c7', borderColor: '#0284c7', borderRadius: '8px', fontWeight: 600 }}>
                Mark as Packed
              </Button>
            )}
          </Space>
        </div>

        {/* Consignment Info */}
        <Row gutter={[16, 16]} style={{ marginBottom: '16px' }}>
          <Col xs={24} md={16}>
            <Card style={{ borderRadius: '12px', border: '1px solid #e2e8f0', height: '100%' }}>
              <Descriptions title={<span style={{ fontWeight: 700 }}>Consignment Details</span>} column={{ xs: 1, sm: 2 }} size="small">
                <Descriptions.Item label="Consignment #">{detailConsignment.consignment_number}</Descriptions.Item>
                <Descriptions.Item label="MI Number">{detailConsignment.material_issue_number || '—'}</Descriptions.Item>
                <Descriptions.Item label="Indent #">{detailConsignment.indent_number || '—'}</Descriptions.Item>
                <Descriptions.Item label="Source Warehouse">{detailConsignment.warehouse_name || '—'}</Descriptions.Item>
                <Descriptions.Item label="Destination WH">{detailConsignment.destination_warehouse_name || '—'}</Descriptions.Item>
                <Descriptions.Item label="Receiver">{detailConsignment.receiver_name ? (detailConsignment.receiver_employee_code ? `${detailConsignment.receiver_name} (${detailConsignment.receiver_employee_code})` : detailConsignment.receiver_name) : (detailConsignment.receiver_employee_code || '—')}</Descriptions.Item>
                <Descriptions.Item label="Receiver Position"><Tag color="purple">{detailConsignment.receiver_position_code || '—'}</Tag></Descriptions.Item>
                <Descriptions.Item label="Total Packages">{detailConsignment.total_packages || 0}</Descriptions.Item>
                <Descriptions.Item label="Total Weight">{detailConsignment.total_weight_kg ? `${detailConsignment.total_weight_kg} KG` : '—'}</Descriptions.Item>
                <Descriptions.Item label="Total Volume">{detailConsignment.total_volume_cft ? `${detailConsignment.total_volume_cft} CFT` : '—'}</Descriptions.Item>
                <Descriptions.Item label="Created">{formatDate(detailConsignment.created_at)}</Descriptions.Item>
                <Descriptions.Item label="Packed At">{detailConsignment.packed_at ? formatDate(detailConsignment.packed_at) : '—'}</Descriptions.Item>
              </Descriptions>
            </Card>
          </Col>
          <Col xs={24} md={8}>
            <Card
              title={<span style={{ fontWeight: 700 }}><BarcodeOutlined style={{ marginRight: '8px', color: '#4f46e5' }} />Parent Package Barcodes</span>}
              extra={
                (detailConsignment.status === 'DRAFT' || detailConsignment.status === 'PACKED') && (
                  <Button
                    type="link"
                    size="small"
                    icon={<BoxPlotOutlined style={{ color: '#4f46e5' }} />}
                    onClick={() => setParentPackagingVisible(true)}
                    style={{ fontWeight: 600 }}
                  >
                    Manage Parents
                  </Button>
                )
              }
              style={{ borderRadius: '12px', border: '1px solid #e2e8f0', height: '100%', overflowY: 'auto' }}
            >
              {(() => {
                const parents = {};
                (detailConsignment.packages || []).forEach(p => {
                  if (p.parent_package_code && !parents[p.parent_package_code]) {
                    parents[p.parent_package_code] = p.parent_package_barcode || p.parent_package_code;
                  }
                });
                const parentCodes = Object.keys(parents);
                if (parentCodes.length > 0) {
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                      {parentCodes.map(code => (
                        <div key={code} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', borderBottom: '1px solid #f1f5f9', paddingBottom: '12px' }}>
                          <Barcode value={code} width={1.2} height={40} fontSize={11} />
                          <Space style={{ marginTop: '4px' }}>
                            <Button size="small" type="link" icon={<PrinterOutlined />} onClick={() => handlePreviewParentLabel(code)}>Print</Button>
                            <Button size="small" type="link" icon={<DownloadOutlined />} onClick={() => handleDownloadBarcode(code)}>Download</Button>
                          </Space>
                          <div style={{ fontSize: '11px', color: '#64748b', textAlign: 'center', marginTop: '4px' }}>Scan barcode to acknowledge this parent package group.</div>
                        </div>
                      ))}
                    </div>
                  );
                }
                return <Empty description="No parent packages defined" />;
              })()}
            </Card>
          </Col>
        </Row>

        {/* Packages */}
        <Row gutter={[16, 16]}>
          {(detailConsignment.packages || []).map((pkg, idx) => (
            <Col xs={24} key={pkg.id}>
              <Card
                size="small"
                title={
                  <Space>
                    <GiftOutlined style={{ color: '#0284c7' }} />
                    <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{pkg.package_number}</span>
                    <Tag color={STATUS_COLORS[pkg.status] || 'default'}>{pkg.status?.replace('_', ' ')}</Tag>
                  </Space>
                }
                style={{ borderRadius: '10px', border: '1px solid #e2e8f0' }}
                extra={
                  <Space size="small">
                    <Tooltip title="Print Package Label">
                      <Button size="small" icon={<PrinterOutlined />}
                        onClick={() => handlePreviewPackageLabel(pkg.id)} />
                    </Tooltip>
                    <Tooltip title="Download Barcode">
                      <Button size="small" icon={<DownloadOutlined />}
                        onClick={() => handleDownloadBarcode(pkg.package_number)} />
                    </Tooltip>
                  </Space>
                }
              >
                <Row gutter={[12, 12]}>
                  <Col xs={24} md={18}>
                    <Row gutter={[12, 12]}>
                      <Col xs={24} md={10}>
                        <div style={{ fontSize: '11px', color: '#64748b' }}>Type</div>
                        <div style={{ fontWeight: 600 }}>{pkg.package_type}</div>
                      </Col>
                      <Col xs={12} md={4}>
                        <div style={{ fontSize: '11px', color: '#64748b' }}>Weight</div>
                        <div style={{ fontWeight: 600 }}>{pkg.gross_weight_kg ? `${pkg.gross_weight_kg} KG` : '—'}</div>
                      </Col>
                      <Col xs={12} md={5}>
                        <div style={{ fontSize: '11px', color: '#64748b' }}>Volume</div>
                        <div style={{ fontWeight: 600 }}>{pkg.volume_cft ? `${pkg.volume_cft.toFixed(2)} CFT` : '—'}</div>
                      </Col>
                      <Col xs={12} md={5}>
                        <div style={{ fontSize: '11px', color: '#64748b' }}>Items</div>
                        <div style={{ fontWeight: 600 }}>{pkg.material_count || 0}</div>
                      </Col>
                    </Row>
                  </Col>
                  <Col xs={24} md={6} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', borderLeft: '1px solid #f1f5f9', paddingLeft: '16px', gap: '4px' }}>
                    <Barcode value={pkg.package_number} width={1.2} height={42} fontSize={11} />
                    <Space size="middle">
                      <Button type="link" size="small" icon={<PrinterOutlined />} onClick={() => handlePreviewPackageLabel(pkg.id)}>Print</Button>
                      <Button type="link" size="small" icon={<DownloadOutlined />} onClick={() => handleDownloadBarcode(pkg.package_number)}>Download</Button>
                    </Space>
                  </Col>
                </Row>

                {/* Package Items Table */}
                {pkg.items && pkg.items.length > 0 && (
                  <Table
                    dataSource={pkg.items}
                    size="small"
                    pagination={false}
                    rowKey="id"
                    style={{ marginTop: '12px' }}
                    columns={[
                      { title: 'Code', dataIndex: 'material_code', key: 'code', render: t => <span style={{ fontFamily: 'monospace' }}>{t}</span> },
                      { title: 'Material', dataIndex: 'material_name', key: 'name' },
                      { title: 'Batch', dataIndex: 'batch_number', key: 'batch', render: t => t || '—' },
                      { title: 'Expiry', dataIndex: 'expiry_date', key: 'expiry', render: t => t || '—' },
                      { title: 'Packed', dataIndex: 'quantity_packed', key: 'qty', render: val => <span style={{ fontWeight: 600 }}>{val}</span> },
                      { title: 'UOM', dataIndex: 'uom_code', key: 'uom' },
                      {
                        title: 'Received', key: 'received',
                        render: (_, r) => r.quantity_received ? (
                          <span style={{ color: r.quantity_received >= r.quantity_packed ? '#16a34a' : '#d97706', fontWeight: 600 }}>
                            {r.quantity_received}
                          </span>
                        ) : <span style={{ color: '#94a3b8' }}>—</span>,
                      },
                      {
                        title: 'Condition', dataIndex: 'item_condition', key: 'condition',
                        render: t => t ? <Tag color={t === 'GOOD' ? 'success' : 'error'}>{t}</Tag> : '—',
                      },
                      {
                        title: 'Serial Numbers',
                        key: 'serials',
                        width: 150,
                        render: (_, r) => {
                          if (!r.serial_numbers || r.serial_numbers.length === 0) return <span style={{ color: '#94a3b8' }}>—</span>;
                          const matCode = r.material_code || '';
                          const prefix = matCode ? `${matCode}-1-` : '';
                          const parsed = r.serial_numbers.map(s => {
                            if (prefix && s.startsWith(prefix)) {
                              return s.slice(prefix.length);
                            }
                            if (s.startsWith('1-') && s.endsWith(`-${matCode}`)) {
                              return s.slice(2, -matCode.length - 1);
                            }
                            return s;
                          });
                          return (
                            <Tooltip title={parsed.join(', ')}>
                              <div style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {parsed.map((s) => <Tag key={s} color="blue">{s}</Tag>)}
                              </div>
                            </Tooltip>
                          );
                        }
                      },
                      {
                        title: 'Asset/Consumable Codes',
                        key: 'asset_codes',
                        width: 170,
                        render: (_, r) => {
                          const isAsset = r.material_type === 'asset';
                          const isConsumable = r.material_type === 'consumable';
                          if (!isAsset && !isConsumable) return <span style={{ color: '#94a3b8' }}>—</span>;
                          if (!r.serial_numbers || r.serial_numbers.length === 0) return <span style={{ color: '#94a3b8' }}>—</span>;
                          const matCode = r.material_code || '';
                          const prefix = matCode ? `${matCode}-1-` : '';
                          const parsed = r.serial_numbers.map(s => {
                            if (prefix && s.startsWith(prefix)) {
                              return s;
                            }
                            return `${prefix}${s}`;
                          });
                          return (
                            <Tooltip title={parsed.join(', ')}>
                              <div style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {parsed.map((s) => <Tag key={s} color={isAsset ? "cyan" : "orange"}>{s}</Tag>)}
                              </div>
                            </Tooltip>
                          );
                        }
                      }
                    ]}
                  />
                )}
              </Card>
            </Col>
          ))}
          {(!detailConsignment.packages || detailConsignment.packages.length === 0) && (
            <Col span={24}>
              <Empty description="No packages in this consignment" />
            </Col>
          )}
        </Row>
        <ParentPackagingModal
          visible={parentPackagingVisible}
          onClose={() => setParentPackagingVisible(false)}
          consignment={detailConsignment}
          onUpdated={() => handleViewDetail(detailConsignment.id)}
        />

        {/* Label Print Preview Modal */}
        <Modal
          title="Print Label Preview"
          open={!!printLabelData}
          onCancel={() => setPrintLabelData(null)}
          footer={[
            <Button key="close" onClick={() => setPrintLabelData(null)}>Close</Button>,
            <Button key="print" type="primary" icon={<PrinterOutlined />} onClick={() => handlePrintLabelAction(printLabelData)}>
              Print Label
            </Button>
          ]}
          width={400}
        >
          {printLabelData && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px 0' }}>
              <div style={{ border: '2px solid #000', padding: 15, width: '100%', fontFamily: 'monospace', fontSize: 11 }}>
                <div style={{ textAlign: 'center', borderBottom: '2px solid #000', paddingBottom: 6, marginBottom: 8 }}>
                  <h3 style={{ margin: 0 }}>{printLabelData.title}</h3>
                  {printLabelData.subtitle && <strong>{printLabelData.subtitle}</strong>}
                </div>
                <div style={{ textAlign: 'center', margin: '8px 0' }}>
                  <strong style={{ fontSize: 14 }}>{printLabelData.number}</strong>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', margin: '8px 0', gap: 8 }}>
                  <Barcode value={printLabelData.number} width={1.2} height={40} fontSize={10} />
                </div>
                <Divider style={{ margin: '8px 0', borderBlockStart: '1px solid #000' }} />
                {printLabelData.details.map((d, i) => (
                  <div key={i}><strong>{d.label}:</strong> {d.value}</div>
                ))}
              </div>
            </div>
          )}
        </Modal>
      </div>
    );
  }

  // ── Create Consignment View ──
  if (showCreate) {
    return (
      <div style={{ padding: '24px', background: 'radial-gradient(ellipse at top, #f8fafc 0%, #f1f5f9 80%)', minHeight: '100vh' }}>
        <div style={{
          background: '#ffffff', padding: '20px 24px', borderRadius: '12px',
          border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)',
          marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px'
        }}>
          <Space>
            <Button icon={<ArrowLeftOutlined />} onClick={() => { setShowCreate(false); setEditId(null); form.resetFields(); setSelectedIssue(null); setSelectedIssueItems([]); setPackages([]); }}
              style={{ borderRadius: '8px', fontWeight: 600 }}>Back</Button>
            <span style={{ fontSize: '17px', fontWeight: 700, color: '#0f172a' }}>
              <PlusOutlined style={{ color: '#0284c7', marginRight: '8px' }} />
              {editId ? 'Edit Consignment' : 'New Consignment'}
            </span>
          </Space>
        </div>

        <Form
          form={form}
          layout="vertical"
          onFinish={handleCreateSubmit}
          initialValues={{ state_code: 'AP' }}
        >
          {/* Step 1: Select Material Issue */}
          <Card
            title={<span style={{ fontWeight: 700 }}><InboxOutlined style={{ color: '#4f46e5', marginRight: '8px' }} />1. Select Material Issue</span>}
            style={{ borderRadius: '12px', border: '1px solid #e2e8f0', marginBottom: '16px' }}
          >
            <Row gutter={16}>
              <Col xs={24} md={16}>
                <Form.Item label="Material Issue" name="issue_id" rules={[{ required: true, message: 'Select a Material Issue' }]}>
                  <Select
                    showSearch
                    placeholder="Choose an issued Material Issue..."
                    onChange={handleIssueSelect}
                    allowClear
                    style={{ width: '100%' }}
                    optionFilterProp="children"
                  >
                    {materialIssues.map(issue => (
                      <Option key={issue.id} value={issue.id}>
                        {issue.issue_number} — {issue.warehouse_name || ''}
                      </Option>
                    ))}
                  </Select>
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item label="State Code" name="state_code">
                  <Select>
                    <Option value="AP">Andhra Pradesh (AP)</Option>
                    <Option value="TS">Telangana (TS)</Option>
                    <Option value="TN">Tamil Nadu (TN)</Option>
                    <Option value="KA">Karnataka (KA)</Option>
                    <Option value="KL">Kerala (KL)</Option>
                    <Option value="MH">Maharashtra (MH)</Option>
                    <Option value="GJ">Gujarat (GJ)</Option>
                    <Option value="DL">Delhi (DL)</Option>
                    <Option value="GEN">General (GEN)</Option>
                  </Select>
                </Form.Item>
              </Col>
            </Row>

            {selectedIssue && (
              <Alert
                message={
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <Space wrap>
                      <span><strong>Issue:</strong> {selectedIssue.issue_number}</span>
                      <Divider type="vertical" />
                      <span><strong>WH:</strong> {selectedIssue.warehouse_name || '—'}</span>
                      <Divider type="vertical" />
                      <span><strong>Items:</strong> {selectedIssueItems.length}</span>
                    </Space>
                    <Space wrap style={{ background: '#f8fafc', padding: '6px 12px', borderRadius: '6px', border: '1px solid #e2e8f0', width: 'fit-content', marginTop: '4px' }}>
                      <span>👤 <strong>Issued To:</strong> {selectedIssue.issued_to_name || '—'}{selectedIssue.issued_to_employee_code ? ` (${selectedIssue.issued_to_employee_code})` : ''}</span>
                      <Divider type="vertical" />
                      <span>💼 <strong>Position Code:</strong> <Tag color="purple">{selectedIssue.position_code || '—'}</Tag></span>
                    </Space>
                  </div>
                }
                type="info"
                showIcon
                style={{ marginTop: '12px', borderRadius: '8px' }}
              />
            )}
          </Card>

          {/* Step 2: Packages */}
          <Card
            title={
              <Space>
                <span style={{ fontWeight: 700 }}><GiftOutlined style={{ color: '#d97706', marginRight: '8px' }} />2. Packages & Items</span>
                <Button size="small" icon={<PlusOutlined />} onClick={handleAddPackage}
                  disabled={!selectedIssue || !packages.every(p => p.locked)}
                  style={{ borderRadius: '6px', fontWeight: 600 }}>Add Package</Button>
              </Space>
            }
            style={{ borderRadius: '12px', border: '1px solid #e2e8f0', marginBottom: '16px' }}
          >
            {packages.length === 0 ? (
              <Empty description="No packages added. Select a Material Issue and add packages." />
            ) : (
              packages.map((pkg, pkgIdx) => (
                <Card
                  key={pkg.key}
                  size="small"
                  type="inner"
                  title={
                    <Space>
                      <Tag color="blue" style={{ fontFamily: 'monospace', fontWeight: 700 }}>PKG #{pkgIdx + 1}</Tag>
                      <span style={{ fontWeight: 600 }}>{pkg.package_description}</span>
                      {pkg.locked && <Tag color="success" icon={<LockOutlined />}>Package Locked & Created</Tag>}
                    </Space>
                  }
                  extra={
                    <Space>
                      {!pkg.locked ? (
                        <Button
                          size="small"
                          type="primary"
                          icon={<CheckCircleOutlined />}
                          style={{ background: '#16a34a', borderColor: '#16a34a' }}
                          onClick={() => handlePackageFieldChange(pkg.key, 'locked', true)}
                          disabled={pkg.items.length === 0}
                        >
                          Create Package
                        </Button>
                      ) : (
                        <Button
                          size="small"
                          icon={<UnlockOutlined />}
                          onClick={() => handlePackageFieldChange(pkg.key, 'locked', false)}
                        >
                          Unlock
                        </Button>
                      )}
                      <Button size="small" danger icon={<DeleteOutlined />}
                        disabled={pkg.locked}
                        onClick={() => handleRemovePackage(pkg.key)}
                        style={{ borderRadius: '6px' }} />
                    </Space>
                  }
                  style={{ marginBottom: '12px', borderRadius: '10px', border: pkg.locked ? '1px solid #bbf7d0' : '1px solid #e2e8f0', background: pkg.locked ? '#f0fdf4' : '#ffffff' }}
                >
                  <Row gutter={12}>
                    <Col xs={12} md={5}>
                      <Form.Item label="Type">
                        <Select disabled={pkg.locked} value={pkg.package_type} onChange={v => handlePackageFieldChange(pkg.key, 'package_type', v)}>
                          <Option value="BOX">BOX</Option>
                          <Option value="CRATE">CRATE</Option>
                          <Option value="PALLET">PALLET</Option>
                          <Option value="BAG">BAG</Option>
                          <Option value="LOOSE">LOOSE</Option>
                        </Select>
                      </Form.Item>
                    </Col>
                    <Col xs={12} md={5}>
                      <Form.Item label="Weight (KG)">
                        <InputNumber disabled={pkg.locked} value={pkg.gross_weight_kg} min={0} step={0.1}
                          onChange={v => handlePackageFieldChange(pkg.key, 'gross_weight_kg', v)}
                          style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                    <Col xs={8} md={4}>
                      <Form.Item label="L (cm)">
                        <InputNumber disabled={pkg.locked} value={pkg.length_cm} min={0} onChange={v => handlePackageFieldChange(pkg.key, 'length_cm', v)}
                          style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                    <Col xs={8} md={4}>
                      <Form.Item label="W (cm)">
                        <InputNumber disabled={pkg.locked} value={pkg.width_cm} min={0} onChange={v => handlePackageFieldChange(pkg.key, 'width_cm', v)}
                          style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                    <Col xs={8} md={4}>
                      <Form.Item label="H (cm)">
                        <InputNumber disabled={pkg.locked} value={pkg.height_cm} min={0} onChange={v => handlePackageFieldChange(pkg.key, 'height_cm', v)}
                          style={{ width: '100%' }} />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={24}>
                      <Form.Item label="Description">
                        <Input disabled={pkg.locked} value={pkg.package_description}
                          onChange={e => handlePackageFieldChange(pkg.key, 'package_description', e.target.value)} />
                      </Form.Item>
                    </Col>
                  </Row>

                  {/* Items in this package */}
                  <Divider style={{ margin: '8px 0', fontSize: '12px' }}>Items</Divider>
                  {selectedIssueItems.length > 0 && (
                    <Table
                      dataSource={selectedIssueItems}
                      size="small"
                      pagination={false}
                      rowKey="key"
                      columns={[
                        {
                          title: 'Include',
                          key: 'include',
                          width: 60,
                          render: (_, miItem) => {
                            const isIncluded = pkg.items.some(i => i.material_issue_item_id === miItem.id);
                            const remaining = getRemainingQty(miItem, pkg.key);
                            const disabled = (!isIncluded && remaining <= 0) || pkg.locked;
                            return (
                              <Tooltip title={pkg.locked ? "Package is locked" : (disabled ? "Fully packed in other packages (Locked)" : "")}>
                                <CheckCircleOutlined
                                  style={{
                                    fontSize: '18px',
                                    color: isIncluded ? '#16a34a' : (disabled ? '#f1f5f9' : '#d9d9d9'),
                                    cursor: disabled ? 'not-allowed' : 'pointer',
                                  }}
                                  onClick={() => {
                                    if (!disabled && !pkg.locked) {
                                      handlePackageItemToggle(pkg.key, miItem);
                                    }
                                  }}
                                />
                              </Tooltip>
                            );
                          },
                        },
                        { title: 'Code', render: (_, r) => <span style={{ fontFamily: 'monospace' }}>{r.item_code || r.item?.item_code}</span> },
                        { title: 'Material', render: (_, r) => r.item_name || r.item?.name },
                        {
                          title: 'MI Qty', key: 'mi_qty', width: 80,
                          render: (_, r) => (
                            <span style={{ fontWeight: 600, color: '#4f46e5' }}>{r.qty || r.quantity || 0}</span>
                          ),
                        },
                        {
                          title: 'Available Qty', key: 'available_qty', width: 100,
                          render: (_, miItem) => {
                            const remaining = getRemainingQty(miItem, pkg.key);
                            return <span style={{ fontWeight: 600, color: remaining > 0 ? '#16a34a' : '#ef4444' }}>{remaining}</span>;
                          }
                        },
                        {
                          title: 'Pkg Qty', key: 'pkg_qty', width: 110,
                          render: (_, miItem) => {
                            const pkgItem = pkg.items.find(i => i.material_issue_item_id === miItem.id);
                            const remaining = getRemainingQty(miItem, pkg.key);
                            return pkgItem ? (
                              <InputNumber
                                size="small"
                                value={pkgItem.quantity_packed}
                                min={0}
                                max={remaining}
                                disabled={pkg.locked}
                                onChange={v => {
                                  const clamped = Math.min(v || 0, remaining);
                                  handlePackageItemQtyChange(pkg.key, miItem.id, clamped);
                                }}
                                style={{ width: '80px' }}
                              />
                            ) : <span style={{ color: '#94a3b8' }}>{remaining <= 0 ? "Locked" : "0"}</span>;
                          },
                        },
                        {
                          title: 'Serial / Asset Codes',
                          key: 'serials',
                          width: 220,
                          render: (_, miItem) => {
                            const pkgItem = pkg.items.find(i => i.material_issue_item_id === miItem.id);
                            if (!pkgItem) return <span style={{ color: '#94a3b8' }}>0</span>;
                            
                            const isTracked = miItem.item_type === 'asset' || miItem.item_type === 'consumable' || miItem.has_serial || miItem.material_type === 'asset' || miItem.material_type === 'consumable';
                            const hasSerials = miItem.serial_numbers && miItem.serial_numbers.length > 0;
                            
                            if (isTracked && !hasSerials) {
                              return <Tag color="warning" style={{ fontWeight: 600 }}>0 codes issued</Tag>;
                            }
                            if (!isTracked) {
                              return <span style={{ color: '#94a3b8' }}>—</span>;
                            }
                            
                            const selectedCount = pkgItem.serial_numbers?.length || 0;
                            const isAsset = miItem.item_type === 'asset' || miItem.material_type === 'asset';
                            const isConsumable = miItem.item_type === 'consumable' || miItem.material_type === 'consumable';
                            const label = (isAsset || isConsumable) ? 'Codes' : 'Serials';
                            return (
                              <Button
                                size="small"
                                type={selectedCount > 0 ? "primary" : "dashed"}
                                disabled={pkg.locked}
                                icon={<BarcodeOutlined />}
                                onClick={() => {
                                  setActivePkgKey(pkg.key);
                                  setActiveMiItemId(miItem.id);
                                  setModalOpen(true);
                                }}
                                style={{
                                  borderRadius: '20px',
                                  fontWeight: 600,
                                  fontSize: '11px',
                                  background: selectedCount > 0 ? '#16a34a' : undefined,
                                  borderColor: selectedCount > 0 ? '#16a34a' : undefined,
                                }}
                              >
                                {selectedCount > 0 ? `${selectedCount} ${label} Selected` : `Select ${label}`}
                              </Button>
                            );
                          }
                        },
                        { title: 'UOM', render: (_, r) => r.uom_code || r.uom_name || 'NOS' },
                        { title: 'Batch', render: (_, r) => r.batch_number || r.batch?.batch_number || '—' },
                      ]}
                    />
                  )}
                  <div style={{ marginTop: '8px', fontSize: '12px', color: '#64748b' }}>
                    <strong>{pkg.items.length}</strong> item(s) in this package
                  </div>
                </Card>
              ))
            )}

            {packages.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: '16px', marginBottom: '16px' }}>
                <Button 
                  type="dashed" 
                  icon={<PlusOutlined />} 
                  onClick={handleAddPackage}
                  style={{ width: '60%', height: '40px', borderRadius: '8px', fontWeight: 600 }}
                  disabled={!selectedIssue || !packages.every(p => p.locked)}
                >
                  Create Package / Add Package
                </Button>
              </div>
            )}
          </Card>

          {/* Submit */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '16px' }}>
            <Button onClick={() => { setShowCreate(false); setEditId(null); form.resetFields(); setSelectedIssue(null); setSelectedIssueItems([]); setPackages([]); }}
              style={{ borderRadius: '8px' }}>Cancel</Button>
            <Button type="primary" htmlType="submit" loading={submitting}
              icon={<GoldOutlined />}
              style={{ borderRadius: '8px', fontWeight: 700, background: 'linear-gradient(135deg, #0284c7, #0369a1)', borderColor: 'transparent' }}
            >
              {editId ? 'Update Consignment' : 'Create Consignment'}
            </Button>
          </div>
        </Form>
        {activeMiItem && (
          <AssetCodesTreeModal
            open={modalOpen}
            onCancel={() => {
              setModalOpen(false);
              setActivePkgKey(null);
              setActiveMiItemId(null);
            }}
            onSave={handleSaveModalCodes}
            selectedCodes={activePkgItem ? (activePkgItem.serial_numbers || []) : []}
            rawRows={mockRawRows}
            lockedCodes={lockedCodes}
            itemCode={activeMiItem.item_code || activeMiItem.item?.item_code || ''}
            itemName={activeMiItem.item_name || activeMiItem.item?.name || ''}
            itemType={activeMiItem.material_type || activeMiItem.item?.item_type || 'asset'}
            targetQty={activePkgItem ? activePkgItem.quantity_packed : 0}
          />
        )}
      </div>
    );
  }

  // ── List View ──
  return (
    <div style={{ padding: '24px', background: 'radial-gradient(ellipse at top, #f8fafc 0%, #f1f5f9 80%)', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '24px', flexWrap: 'wrap', gap: '12px',
        background: '#ffffff', padding: '20px 24px', borderRadius: '12px',
        border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)'
      }}>
        <div>
          <h2 style={{ margin: 0, fontWeight: 700, fontSize: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <GoldOutlined style={{ color: '#4f46e5' }} /> Consignment Packaging
          </h2>
          <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: '13px' }}>
            Create and manage consignments with package-level tracking
          </p>
        </div>
        <Space>
          <Input
            placeholder="Search consignments..."
            prefix={<SearchOutlined style={{ color: '#94a3b8' }} />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onPressEnter={(e) => { setSearchText(e.target.value); setTimeout(() => { setPage(1); fetchConsignments(1); }, 0); }}
            allowClear
            style={{ width: 280, borderRadius: '8px' }}
          />
          <Select
            placeholder="All Status"
            value={statusFilter}
            onChange={(val) => { setStatusFilter(val); setPage(1); }}
            allowClear
            style={{ width: 160, borderRadius: '8px' }}
          >
            <Option value="DRAFT">Draft</Option>
            <Option value="PACKED">Packed</Option>
            <Option value="IN_TRANSIT">In Transit</Option>
            <Option value="PARTIALLY_RECEIVED">Partially Received</Option>
            <Option value="RECEIVED">Received</Option>
          </Select>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleOpenCreate}
            style={{
              borderRadius: '8px', fontWeight: 700, height: '40px',
              background: 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)',
              borderColor: 'transparent'
            }}
          >
            New Consignment
          </Button>
        </Space>
      </div>

      {/* Stats Row */}
      <Row gutter={[16, 16]} style={{ marginBottom: '16px' }}>
        <Col xs={12} sm={6} md={3}>
          <Card size="small" style={{ borderRadius: '10px', border: '1px solid #e2e8f0' }}>
            <Statistic title="Total" value={total} suffix="Consignments" valueStyle={{ fontSize: '20px', fontWeight: 700 }} />
          </Card>
        </Col>
        <Col xs={12} sm={6} md={3}>
          <Card size="small" style={{ borderRadius: '10px', border: '1px solid #e2e8f0' }}>
            <Statistic title="Draft" value={consignments.filter(c => c.status === 'DRAFT').length} valueStyle={{ fontSize: '20px', color: '#64748b' }} />
          </Card>
        </Col>
        <Col xs={12} sm={6} md={3}>
          <Card size="small" style={{ borderRadius: '10px', border: '1px solid #e2e8f0' }}>
            <Statistic title="In Transit" value={consignments.filter(c => c.status === 'IN_TRANSIT').length} valueStyle={{ fontSize: '20px', color: '#0284c7' }} />
          </Card>
        </Col>
        <Col xs={12} sm={6} md={3}>
          <Card size="small" style={{ borderRadius: '10px', border: '1px solid #e2e8f0' }}>
            <Statistic title="Received" value={consignments.filter(c => c.status === 'RECEIVED').length} valueStyle={{ fontSize: '20px', color: '#16a34a' }} />
          </Card>
        </Col>
      </Row>

      {/* Consignment Table */}
      <Card style={{ borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
        <Table
          dataSource={consignments}
          columns={columns}
          rowKey="id"
          loading={loading}
          pagination={{
            current: page,
            pageSize,
            total,
            onChange: (p, ps) => { setPage(p); setPageSize(ps); },
            showSizeChanger: true,
            showTotal: (t) => `Total ${t} consignments`,
          }}
          size="middle"
        />
      </Card>
      {!showCreate && <Form form={form} style={{ display: 'none' }} />}
    </div>
  );
}
