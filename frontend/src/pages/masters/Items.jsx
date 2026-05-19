import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Drawer, Form, Input, Select, InputNumber, Switch, Space,
  Popconfirm, message, Row, Col, Divider, Tabs, Spin, TreeSelect,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  DownloadOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { formatCurrency, getErrorMessage, downloadExcel } from '../../utils/helpers';
import { ITEM_OWNERSHIP } from '../../utils/constants';

const Items = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialSearch = searchParams.get('search') || '';
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [categories, setCategories] = useState([]);
  const [allCategoryOptions, setAllCategoryOptions] = useState([]);
  const [uomCategories, setUomCategories] = useState([]);
  const [uoms, setUoms] = useState([]);
  const [brandOptions, setBrandOptions] = useState([]);
  const [itemTypeOptions, setItemTypeOptions] = useState([]);
  const [featureOptions, setFeatureOptions] = useState([]);
  const [filterCategory, setFilterCategory] = useState(undefined);
  const [filterType, setFilterType] = useState(undefined);
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [refreshKey, setRefreshKey] = useState(0);

  // Multi-level category state
  const [allCategoriesRaw, setAllCategoriesRaw] = useState([]);
  const [level1Id, setLevel1Id] = useState(undefined);
  const [level2Id, setLevel2Id] = useState(undefined);
  const [level3Id, setLevel3Id] = useState(undefined);

  // Attributes for the currently-selected category + per-item values
  const [categoryAttributes, setCategoryAttributes] = useState([]);
  const [attrValues, setAttrValues] = useState({}); // { attribute_id: { value, uom_id } }
  const [categorySpecs, setCategorySpecs] = useState([]);
  const [specValues, setSpecValues] = useState({}); // { spec_id: { value, min_value, max_value, uom_id } }
  const [autoCodePreview, setAutoCodePreview] = useState('');
  const [autoCodeError, setAutoCodeError] = useState('');
  const selectedUomCategoryId = Form.useWatch('uom_category_id', form);

  const fetchBrands = async () => {
    try {
      const res = await api.get('/masters/brands', { params: { page_size: 500 } });
      const data = res.data;
      const items = data.items || data.data || (Array.isArray(data) ? data : []);
      const options = items.map((b) => ({
        label: `${b.name} (${b.code})`,
        value: b.code,
      }));
      setBrandOptions(options);
    } catch (err) {
      console.error('fetchBrands error:', err);
    }
  };

  const fetchItemTypes = async () => {
    try {
      const res = await api.get('/masters/item-types', { params: { page_size: 500 } });
      const data = res.data;
      const items = data.items || data.data || (Array.isArray(data) ? data : []);
      const options = items.map((t) => ({
        label: (t.name || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        value: t.name,
      }));
      setItemTypeOptions(options);
    } catch (err) {
      console.error('fetchItemTypes error:', err);
    }
  };

  const fetchFeatures = async (categoryId, includeInactive = false) => {
    if (!categoryId) {
      setFeatureOptions([]);
      return;
    }
    try {
      const res = await api.get('/masters/features', {
        params: { category_id: categoryId, page_size: 500, include_inactive: includeInactive },
      });
      const data = res.data;
      const items = data.items || data.data || (Array.isArray(data) ? data : []);
      setFeatureOptions(items.map((f) => ({
        label: f.is_active === false ? `${f.name} (Inactive)` : f.name,
        value: f.id,
      })));
    } catch (err) {
      console.error('fetchFeatures error:', err);
      setFeatureOptions([]);
    }
  };

  useEffect(() => {
    fetchCategories();
    fetchUOMCategories();
    fetchUOMs();
    fetchBrands();
    fetchItemTypes();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the form's category changes (or we open edit), reload attribute definitions
  const loadAttributesForCategory = async (categoryId) => {
    if (!categoryId) {
      setCategoryAttributes([]);
      return;
    }
    try {
      const res = await api.get('/masters/item-attributes', { params: { category_id: categoryId } });
      setCategoryAttributes(res.data || []);
    } catch {
      setCategoryAttributes([]);
    }
  };

  const loadSpecsForCategory = async (categoryId) => {
    if (!categoryId) {
      setCategorySpecs([]);
      return;
    }
    try {
      const res = await api.get('/masters/item-specs', { params: { item_category_id: categoryId } });
      setCategorySpecs(res.data || []);
    } catch {
      setCategorySpecs([]);
    }
  };

  const loadItemAttributeValues = async (itemId) => {
    try {
      const res = await api.get(`/masters/items/${itemId}/attribute-values`);
      const map = {};
      (res.data || []).forEach((v) => {
        map[v.attribute_id] = {
          value: v.value || '',
          uom_category_id: v.uom_category_id || null,
          uom_id: v.uom_id || null,
        };
      });
      setAttrValues(map);
    } catch {
      setAttrValues({});
    }
  };

  const loadItemSpecValues = async (itemId) => {
    try {
      const res = await api.get(`/masters/items/${itemId}/spec-values`);
      const map = {};
      (res.data || []).forEach((v) => {
        map[v.spec_id] = {
          value: v.value || '',
          min_value: v.min_value || '',
          max_value: v.max_value || '',
          uom_id: v.uom_id || null,
        };
      });
      setSpecValues(map);
    } catch {
      setSpecValues({});
    }
  };

  const updateAttrValue = (attrId, field, val) => {
    setAttrValues((prev) => ({
      ...prev,
      [attrId]: { ...(prev[attrId] || {}), [field]: val },
    }));
  };

  const updateAttrFields = (attrId, patch) => {
    setAttrValues((prev) => ({
      ...prev,
      [attrId]: { ...(prev[attrId] || {}), ...patch },
    }));
  };

  const updateSpecValue = (specId, field, val) => {
    setSpecValues((prev) => ({
      ...prev,
      [specId]: { ...(prev[specId] || {}), [field]: val },
    }));
  };

  const fetchCategories = async () => {
    try {
      const res = await api.get('/masters/categories', { params: { page_size: 1000 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setAllCategoriesRaw(items);
      setCategoryTree(items);
    } catch (err) {
      console.error('fetchCategories error:', err);
    }
  };

  const setCategoryTree = (items) => {
    const buildTree = (list, parentId = null) => {
      return list
        .filter((c) => (c.parent_id || null) === parentId)
        .map((c) => ({
          title: c.name,
          value: c.id,
          key: c.id,
          children: buildTree(list, c.id),
        }));
    };
    setCategories(buildTree(items));
    setAllCategoryOptions(items.map((c) => ({ label: c.name, value: c.id })));
  };

  const fetchUOMCategories = async () => {
    try {
      const res = await api.get('/masters/uom-categories');
      const data = res.data;
      const items = data.items || data.data || data || [];
      setUomCategories(items.map((c) => ({ label: c.name, value: c.id })));
    } catch {
      // silent
    }
  };

  const fetchUOMs = async () => {
    try {
      const res = await api.get('/masters/uom', { params: { page_size: 200 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setUoms(items.map((u) => ({
        label: `${u.name} (${u.abbreviation || ''})`,
        value: u.id,
        category_id: u.category_id || null,
      })));
    } catch {
      // silent
    }
  };

  const getUomOptionsForCategory = (categoryId) => (
    categoryId ? uoms.filter((u) => u.category_id === categoryId) : uoms
  );

  const previewItemCode = async (categoryId) => {
    if (!categoryId || editingItem) {
      setAutoCodePreview('');
      setAutoCodeError('');
      return;
    }
    const category = allCategoriesRaw.find((c) => c.id === categoryId);
    if (!category || Number(category.level) !== 3 || !/^\d{6}$/.test(String(category.full_code || ''))) {
      setAutoCodePreview('');
      setAutoCodeError('Select a Level 3 category with a valid full code before generating item code.');
      form.setFieldsValue({ item_code: '' });
      return;
    }
    try {
      const res = await api.post('/masters/items/preview-code', { category_id: categoryId });
      const preview = res.data?.preview || '';
      setAutoCodePreview(preview);
      setAutoCodeError('');
      if (preview) form.setFieldsValue({ item_code: preview });
    } catch (err) {
      setAutoCodePreview('');
      setAutoCodeError(getErrorMessage(err));
      form.setFieldsValue({ item_code: '' });
    }
  };

  const clearItemCodePreview = () => {
    if (editingItem) return;
    setAutoCodePreview('');
    setAutoCodeError('');
    form.setFieldsValue({ item_code: '' });
  };



  const fetchItems = useCallback(
    async (params) => {
      const queryParams = { ...params };
      if (filterCategory) queryParams.category_id = filterCategory;
      if (filterType) queryParams.item_type = filterType;
      // BUG-FE-019: send explicit lowercase string so axios doesn't serialize
      // the JS boolean as 'True'/'False' depending on platform formatter.
      if (filterStatus) queryParams.is_active = filterStatus === 'active' ? 'true' : 'false';
      const res = await api.get('/masters/items', { params: queryParams });
      return res;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterCategory, filterType, filterStatus, refreshKey]
  );

  const handleAdd = () => {
    setEditingItem(null);
    form.resetFields();
    setCategoryAttributes([]);
    setCategorySpecs([]);
    setFeatureOptions([]);
    setAttrValues({});
    setSpecValues({});
    setAutoCodePreview('');
    setAutoCodeError('');
    // BUG-FE-009: do NOT auto-generate item_code client-side.
    // Leave blank so the backend's `AUTO`/blank handling produces the
    // canonical BHSPL-PH-MED-T-0001 code at create time.
    form.setFieldsValue({
      item_code: '',
      status: 'active',
      has_batch: false,
      has_serial: false,
      has_expiry: false,
      barcode_type: 'auto',
      valuation_method: 'fifo',
      category_id: undefined,
    });
    setLevel1Id(undefined);
    setLevel2Id(undefined);
    setLevel3Id(undefined);
    setDrawerOpen(true);
  };

  const handleEdit = (record) => {
    const recordFeatureIds = Array.isArray(record.feature_ids) && record.feature_ids.length > 0
      ? record.feature_ids
      : (record.feature_id ? [record.feature_id] : []);
    setEditingItem(record);
    setAutoCodePreview('');
    setAutoCodeError('');
    form.setFieldsValue({
      ...record,
      category_id: record.category_id || record.category?.id,
      feature_ids: recordFeatureIds,
      uom_category_id: record.uom_category_id || record.primary_uom?.category_id || uoms.find((u) => u.value === record.primary_uom_id)?.category_id,
      primary_uom_id: record.primary_uom_id || record.primary_uom?.id,
      status: record.is_active === false ? 'inactive' : 'active',
    });
    // Reload attributes/specs for this item's category + existing values
    const catId = record.category_id || record.category?.id;
    if (catId) {
      loadAttributesForCategory(catId);
      loadSpecsForCategory(catId);
      fetchFeatures(catId, true);
      loadItemAttributeValues(record.id);
      loadItemSpecValues(record.id);

      // Resolve category hierarchy for levels
      const resolveLevels = () => {
        const cat3 = allCategoriesRaw.find((c) => c.id === catId);
        if (!cat3) return;

        if (!cat3.parent_id) {
          setLevel1Id(cat3.id);
          setLevel2Id(undefined);
          setLevel3Id(undefined);
        } else {
          const cat2 = allCategoriesRaw.find((c) => c.id === cat3.parent_id);
          if (cat2 && !cat2.parent_id) {
            // cat3 is actually level 2
            setLevel1Id(cat2.id);
            setLevel2Id(cat3.id);
            setLevel3Id(undefined);
          } else if (cat2 && cat2.parent_id) {
            // cat3 is level 3, cat2 is level 2
            const cat1 = allCategoriesRaw.find((c) => c.id === cat2.parent_id);
            if (cat1) {
              setLevel1Id(cat1.id);
              setLevel2Id(cat2.id);
              setLevel3Id(cat3.id);
            }
          }
        }
      };
      resolveLevels();
    }
    setDrawerOpen(true);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/masters/items/${id}`);
      message.success('Item deleted successfully');
      // Force DataTable remount by changing key, triggering a fresh fetch
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSubmit = async () => {
    // BUG-FE-131: guard against rapid double-clicks creating duplicate items.
    if (submitting) return;
    setSubmitting(true);
    try {
      const values = await form.validateFields();
      const { status, ...rest } = values;
      delete rest.secondary_uom_id;
      delete rest.sku;
      delete rest.weight;
      delete rest.weight_uom;
      delete rest.volume;
      delete rest.volume_uom;
      if (!editingItem && autoCodePreview && rest.item_code === autoCodePreview) {
        rest.item_code = 'AUTO';
      }
      const payload = {
        ...rest,
        is_active: status === 'inactive' ? false : true,
      };
      let savedItemId;
      if (editingItem) {
        await api.put(`/masters/items/${editingItem.id}`, payload);
        savedItemId = editingItem.id;
        message.success('Item updated successfully');
      } else {
        const res = await api.post('/masters/items', payload);
        savedItemId = res.data?.id || res.data?.data?.id;
        message.success('Item created successfully');
      }
      // Save per-item attribute values (if we have any to save).
      if (savedItemId && Object.keys(attrValues).length > 0) {
        const attrsById = Object.fromEntries(categoryAttributes.map((a) => [String(a.id), a]));
        const rows = Object.entries(attrValues)
          .filter(([, v]) => v.value != null && String(v.value).trim() !== '')
          .map(([attrId, v]) => {
            const attr = attrsById[attrId] || {};
            return {
              attribute_id: Number(attrId),
              value: String(v.value),
              uom_category_id: v.uom_category_id || attr.uom_category_id || null,
              uom_id: v.uom_id || attr.uom_id || null,
            };
          });
        try {
          await api.put(`/masters/items/${savedItemId}/attribute-values`, rows);
        } catch (err) {
          message.warning(`Item saved, but attributes failed: ${getErrorMessage(err)}`);
        }
      }
      if (savedItemId && Object.keys(specValues).length > 0) {
        const specsById = Object.fromEntries(categorySpecs.map((s) => [String(s.spec_id), s]));
        const rows = Object.entries(specValues)
          .filter(([, v]) => (
            (v.value != null && String(v.value).trim() !== '') ||
            (v.min_value != null && String(v.min_value).trim() !== '') ||
            (v.max_value != null && String(v.max_value).trim() !== '')
          ))
          .map(([specId, v]) => {
            const spec = specsById[specId] || {};
            return {
              spec_id: Number(specId),
              value: v.value != null ? String(v.value) : null,
              min_value: v.min_value != null && String(v.min_value).trim() !== '' ? String(v.min_value) : null,
              max_value: v.max_value != null && String(v.max_value).trim() !== '' ? String(v.max_value) : null,
              uom_id: v.uom_id || spec.uom_id || spec.spec_uom_id || null,
            };
          });
        try {
          await api.put(`/masters/items/${savedItemId}/spec-values`, rows);
        } catch (err) {
          message.warning(`Item saved, but specs failed: ${getErrorMessage(err)}`);
        }
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingItem(null);
      setCategoryAttributes([]);
      setAttrValues({});
      setCategorySpecs([]);
      setSpecValues({});
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) {
        // BUG-FE-013: include every tab that has form-fields so error tab
        // detection isn't silently lost when a Stock/Pricing/Compliance/Barcode
        // field fails validation.
        const tabFields = {
          basic: ['item_code', 'name', 'item_type', 'category_id', 'feature_ids', 'status', 'description', 'brand', 'manufacturer', 'dosage_form'],
          units: ['uom_category_id', 'primary_uom_id', 'conversion_factor', 'pack_size'],
          stock: ['safety_stock', 'reorder_level', 'minimum_stock', 'maximum_stock', 'has_batch', 'has_serial', 'has_expiry', 'shelf_life_days'],
          pricing: ['purchase_price', 'selling_price', 'mrp', 'tax_rate', 'discount_percent', 'valuation_method'],
          compliance: ['hsn_code', 'gst_rate', 'is_controlled_substance', 'schedule_type'],
          barcode: ['barcode_type', 'barcode_value'],
        };
        const errorFieldNames = err.errorFields.map((f) => f.name[0]);
        let matched = false;
        for (const [tab, fields] of Object.entries(tabFields)) {
          if (errorFieldNames.some((f) => fields.includes(f))) {
            message.error(`Please fill required fields in the "${tab.charAt(0).toUpperCase() + tab.slice(1)}" tab`);
            matched = true;
            break;
          }
        }
        if (!matched) {
          message.error('Please fix the highlighted validation errors before saving.');
        }
        return;
      }
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleExport = async () => {
    try {
      // BUG-FE-173: cap page_size to a reasonable bound and warn the user when
      // the dataset is large so they know the export is the current page only.
      const EXPORT_CAP = 5000;
      const hide = message.loading('Preparing export...', 0);
      const res = await api.get('/masters/items', { params: { page_size: EXPORT_CAP } });
      hide();
      const data = res.data;
      const items = data.items || data.data || data || [];
      if (data.total && data.total > EXPORT_CAP) {
        message.warning(`Showing first ${EXPORT_CAP} of ${data.total} items. Apply filters to narrow the export.`);
      }
      const exportData = items.map((item) => ({
        'Item Code': item.item_code,
        'Name': item.name,

        'Features': (item.feature_names && item.feature_names.length > 0)
          ? item.feature_names.join(', ')
          : (item.feature_name || ''),
        'Category': item.category?.name || item.category_name || '',
        'Type': item.item_type,
        'Primary UOM': item.primary_uom?.name || item.primary_uom_name || '',
        'HSN Code': item.hsn_code || '',
        'Safety Stock': item.safety_stock || 0,
        'Reorder Level': item.reorder_level || 0,
        'Purchase Price': item.purchase_price || 0,
        'Selling Price': item.selling_price || 0,
        'MRP': item.mrp || 0,
        'Status': item.is_active === false ? 'Inactive' : 'Active',
        'Brand': item.brand || '',
        'Manufacturer': item.manufacturer || '',
        'Dosage Form': item.dosage_form || '',
        'Valuation Method': item.valuation_method || '',
      }));
      downloadExcel(exportData, 'items', 'Items');
      message.success('Export completed');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'Item Code',
      dataIndex: 'item_code',
      key: 'item_code',
      width: 130,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a onClick={() => navigate(`/masters/items/${record.id}`)}>{text}</a>
      ),
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      width: 220,
      sorter: true,
      ellipsis: true,
    },

    {
      title: 'Category',
      dataIndex: ['category', 'name'],
      key: 'category',
      width: 150,
      render: (text, record) => text || record.category_name || '-',
    },
    {
      title: 'Type',
      dataIndex: 'item_type',
      key: 'item_type',
      width: 130,
      render: (val) => {
        const found = itemTypeOptions.find((t) => t.value === val);
        return found ? found.label : (val || '-');
      },
    },
    {
      title: 'Feature',
      dataIndex: 'feature_names',
      key: 'feature_names',
      width: 220,
      render: (val, record) => {
        if (Array.isArray(val) && val.length > 0) return val.join(', ');
        if (record.feature_name) return record.feature_name;
        if (record.feature?.name) return record.feature.name;
        return '-';
      },
    },
    {
      title: 'Primary UOM',
      dataIndex: ['primary_uom', 'name'],
      key: 'primary_uom',
      width: 110,
      render: (text, record) => text || record.primary_uom_name || '-',
    },
    {
      title: 'Barcode Type',
      dataIndex: 'barcode_type',
      key: 'barcode_type',
      width: 110,
    },
    {
      title: 'Safety Stock',
      dataIndex: 'safety_stock',
      key: 'safety_stock',
      width: 110,
      align: 'right',
      render: (val) => val ?? '-',
    },
    {
      title: 'Reorder Level',
      dataIndex: 'reorder_level',
      key: 'reorder_level',
      width: 120,
      align: 'right',
      render: (val) => val ?? '-',
    },
    {
      title: 'Purchase Price',
      dataIndex: 'purchase_price',
      key: 'purchase_price',
      width: 130,
      align: 'right',
      render: (val) => formatCurrency(val),
    },
    {
      title: 'Selling Price',
      dataIndex: 'selling_price',
      key: 'selling_price',
      width: 130,
      align: 'right',
      render: (val) => formatCurrency(val),
    },
    {
      title: 'Status',
      dataIndex: 'is_active',
      key: 'status',
      width: 100,
      render: (isActive, record) => {
        const status = record.status || (isActive === false ? 'inactive' : 'active');
        return <StatusTag status={status} />;
      },
    },
    { title: 'Brand', dataIndex: 'brand', key: 'brand', width: 120 },
    { title: 'Manufacturer', dataIndex: 'manufacturer', key: 'manufacturer', width: 150 },
    { title: 'Valuation', dataIndex: 'valuation_method', key: 'valuation_method', width: 100, render: (v) => (v || 'fifo').toUpperCase() },
    {
      title: 'Actions',
      key: 'actions',
      width: 140,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button
            type="link"
            size="small"
            icon={<EyeOutlined />}
            onClick={() => navigate(`/masters/items/${record.id}`)}
          />
          <Button
            type="link"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEdit(record)}
          />
          <Popconfirm
            title="Delete this item?"
            description="This action cannot be undone."
            onConfirm={() => handleDelete(record.id)}
            okText="Delete"
            okButtonProps={{ danger: true }}
          >
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const uniqueItemTypes = itemTypeOptions;

  const uniqueBarcodeOptions = [
    { label: 'Auto Generate', value: 'auto' },
    { label: 'QR Code', value: 'qrcode' },
    { label: 'Barcode 128', value: 'barcode_128' },
    { label: 'Barcode EAN-13', value: 'barcode_ean13' },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <Select
        placeholder="Category"
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ width: 160 }}
        value={filterCategory}
        onChange={(v) => { setFilterCategory(v); setRefreshKey((k) => k + 1); }}
        options={allCategoryOptions}
      />
      <Select
        placeholder="Item Type"
        allowClear
        style={{ width: 150 }}
        value={filterType}
        onChange={(v) => { setFilterType(v); setRefreshKey((k) => k + 1); }}
        options={uniqueItemTypes}
      />
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 120 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Active', value: 'active' },
          { label: 'Inactive', value: 'inactive' },
        ]}
      />
    </Space>
  );

  const parseCommaOptions = (raw = '') => {
    const opts = [];
    let buf = '';
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '\\' && raw[i + 1] === ',') {
        buf += ',';
        i += 1;
      } else if (ch === ',') {
        const t = buf.trim();
        if (t) opts.push({ label: t, value: t });
        buf = '';
      } else {
        buf += ch;
      }
    }
    const tail = buf.trim();
    if (tail) opts.push({ label: tail, value: tail });
    return opts;
  };

  const renderAttributeInput = (a, v) => {
    if (a.data_type === 'boolean') {
      const norm = (() => {
        if (v.value === true || v.value === 'true' || v.value === 1 || v.value === '1') return 'true';
        if (v.value === false || v.value === 'false' || v.value === 0 || v.value === '0') return 'false';
        return undefined;
      })();
      return (
        <Select
          value={norm}
          onChange={(val) => updateAttrValue(a.id, 'value', val)}
          options={[{ label: 'Yes', value: 'true' }, { label: 'No', value: 'false' }]}
          allowClear
          style={{ width: 120 }}
        />
      );
    }
    if (a.data_type === 'enum') {
      return (
        <Select
          value={v.value}
          onChange={(val) => updateAttrValue(a.id, 'value', val)}
          options={parseCommaOptions(a.allowed_values || '')}
          allowClear
          style={{ width: '100%' }}
        />
      );
    }
    if (a.data_type === 'number') {
      return (
        <InputNumber
          value={v.value !== '' && v.value != null ? Number(v.value) : null}
          onChange={(val) => updateAttrValue(a.id, 'value', val == null ? '' : String(val))}
          min={a.min_value != null ? Number(a.min_value) : undefined}
          max={a.max_value != null ? Number(a.max_value) : undefined}
          precision={a.precision != null ? Number(a.precision) : 2}
          style={{ width: '100%' }}
        />
      );
    }
    return (
      <Input
        value={v.value || ''}
        onChange={(e) => updateAttrValue(a.id, 'value', e.target.value)}
      />
    );
  };

  const renderSpecInput = (s, v) => {
    const dataType = s.spec_data_type || s.data_type;
    if (dataType === 'boolean') {
      const norm = (() => {
        if (v.value === true || v.value === 'true' || v.value === 1 || v.value === '1') return 'true';
        if (v.value === false || v.value === 'false' || v.value === 0 || v.value === '0') return 'false';
        return undefined;
      })();
      return (
        <Select
          value={norm}
          onChange={(val) => updateSpecValue(s.spec_id, 'value', val)}
          options={[{ label: 'Yes', value: 'true' }, { label: 'No', value: 'false' }]}
          allowClear
          style={{ width: 120 }}
        />
      );
    }
    if (dataType === 'enum') {
      return (
        <Select
          value={v.value}
          onChange={(val) => updateSpecValue(s.spec_id, 'value', val)}
          options={parseCommaOptions(s.spec_allowed_values || '')}
          allowClear
          style={{ width: '100%' }}
        />
      );
    }
    if (dataType === 'number') {
      return (
        <InputNumber
          value={v.value !== '' && v.value != null ? Number(v.value) : null}
          onChange={(val) => updateSpecValue(s.spec_id, 'value', val == null ? '' : String(val))}
          precision={2}
          style={{ width: '100%' }}
        />
      );
    }
    if (dataType === 'range') {
      return (
        <Space.Compact style={{ width: '100%' }}>
          <InputNumber
            value={v.min_value !== '' && v.min_value != null ? Number(v.min_value) : null}
            onChange={(val) => updateSpecValue(s.spec_id, 'min_value', val == null ? '' : String(val))}
            placeholder="Min"
            style={{ width: '50%' }}
          />
          <InputNumber
            value={v.max_value !== '' && v.max_value != null ? Number(v.max_value) : null}
            onChange={(val) => updateSpecValue(s.spec_id, 'max_value', val == null ? '' : String(val))}
            placeholder="Max"
            style={{ width: '50%' }}
          />
        </Space.Compact>
      );
    }
    return (
      <Input
        value={v.value || ''}
        onChange={(e) => updateSpecValue(s.spec_id, 'value', e.target.value)}
      />
    );
  };

  return (
    <div>
      <PageHeader title="Items" subtitle="Manage inventory items">
        <Space>
          <Button icon={<DownloadOutlined />} onClick={handleExport}>
            Export
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            Add Item
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchItems}
        rowKey="id"
        searchPlaceholder="Search by name or code..."
        exportFileName="items"
        toolbar={toolbar}
        scroll={{ x: 1600 }}
        initialSearch={initialSearch}
      />

      <Drawer
        title={editingItem ? 'Edit Item' : 'Add Item'}
        width={720}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setEditingItem(null); form.resetFields(); setCategorySpecs([]); setSpecValues({}); }}
        // BUG-FE-012: Form lives OUTSIDE the Drawer (via useForm). With
        // destroyOnHidden Antd unmounts the Form Provider while the form
        // instance still references stale field values. Rely on manual
        // resetFields() in onClose instead.
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); setEditingItem(null); form.resetFields(); setCategorySpecs([]); setSpecValues({}); }}>
              Cancel
            </Button>
            <Button type="primary" onClick={handleSubmit} loading={submitting}>
              {editingItem ? 'Update' : 'Create'}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical" requiredMark="optional" preserve>
          <Tabs
            defaultActiveKey="basic"
            destroyOnHidden={false}
            items={[
              // BUG-FE-130/142: every tab pane is mounted (not lazily) so
              // hidden Form.Items participate in validateFields(). forceRender
              // covers AntD legacy v4 prop; destroyOnHidden=false is the
              // v5 toggle.
              {
                key: 'basic',
                label: 'Basic',
                children: (
                  <>
                      <Col span={24}>
                        <Row gutter={16}>
                          <Col span={8}>
                            <Form.Item label="Category Level 1">
                              <Select
                                placeholder="Select Level 1"
                                value={level1Id}
                                allowClear
                                showSearch
                                optionFilterProp="label"
                                options={allCategoriesRaw
                                  .filter((c) => !c.parent_id)
                                  .map((c) => ({ label: c.name, value: c.id }))}
                                onChange={(v) => {
                                  setLevel1Id(v);
                                  setLevel2Id(undefined);
                                  setLevel3Id(undefined);
                                  form.setFieldsValue({ category_id: v });
                                  if (v) {
                                    loadAttributesForCategory(v);
                                    loadSpecsForCategory(v);
                                    fetchFeatures(v);
                                    clearItemCodePreview();
                                  } else {
                                    setCategoryAttributes([]);
                                    setCategorySpecs([]);
                                    setFeatureOptions([]);
                                    clearItemCodePreview();
                                  }
                                  setAttrValues({});
                                  setSpecValues({});
                                  form.setFieldsValue({ feature_ids: [] });
                                }}
                              />
                            </Form.Item>
                          </Col>
                          <Col span={8}>
                            <Form.Item label="Category Level 2">
                              <Select
                                placeholder="Select Level 2"
                                value={level2Id}
                                disabled={!level1Id}
                                allowClear
                                showSearch
                                optionFilterProp="label"
                                options={allCategoriesRaw
                                  .filter((c) => c.parent_id === level1Id)
                                  .map((c) => ({ label: c.name, value: c.id }))}
                                onChange={(v) => {
                                  setLevel2Id(v);
                                  setLevel3Id(undefined);
                                  form.setFieldsValue({ category_id: v || level1Id });
                                  const effectiveId = v || level1Id;
                                  if (effectiveId) {
                                    loadAttributesForCategory(effectiveId);
                                    loadSpecsForCategory(effectiveId);
                                    fetchFeatures(effectiveId);
                                    clearItemCodePreview();
                                  }
                                  setAttrValues({});
                                  setSpecValues({});
                                  form.setFieldsValue({ feature_ids: [] });
                                }}
                              />
                            </Form.Item>
                          </Col>
                          <Col span={8}>
                            <Form.Item label="Category Level 3">
                              <Select
                                placeholder="Select Level 3"
                                value={level3Id}
                                disabled={!level2Id}
                                allowClear
                                showSearch
                                optionFilterProp="label"
                                options={allCategoriesRaw
                                  .filter((c) => c.parent_id === level2Id)
                                  .map((c) => ({ label: c.name, value: c.id }))}
                                onChange={(v) => {
                                  setLevel3Id(v);
                                  form.setFieldsValue({ category_id: v || level2Id || level1Id });
                                  const effectiveId = v || level2Id || level1Id;
                                  if (effectiveId) {
                                    loadAttributesForCategory(effectiveId);
                                    loadSpecsForCategory(effectiveId);
                                    fetchFeatures(effectiveId);
                                  }
                                  if (v) previewItemCode(v);
                                  else clearItemCodePreview();
                                  setAttrValues({});
                                  setSpecValues({});
                                  form.setFieldsValue({ feature_ids: [] });
                                }}
                              />
                            </Form.Item>
                          </Col>
                        </Row>
                        <Form.Item name="category_id" noStyle>
                          <Input type="hidden" />
                        </Form.Item>
                      </Col>
                      <Row gutter={16}>
  <Col span={6}>
                        <Form.Item name="brand" label="Brand">
                          <Select
                            showSearch
                            allowClear
                            placeholder="Select brand"
                            optionFilterProp="label"
                            options={brandOptions}
                          />
                        </Form.Item>
                      </Col>
                      </Row>

                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item
                          name="item_code"
                          label="Item Code"
                          help={autoCodeError || (autoCodePreview ? 'Auto-generated from Level 1 + Level 2 + Level 3 category sequence.' : undefined)}
                          validateStatus={autoCodeError ? 'warning' : undefined}
                          rules={[{ required: true, message: 'Item code is required' }]}
                        >
                          <Input
                            readOnly={!editingItem}
                            placeholder="Select Level 1, Level 2, and Level 3 categories"
                          />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item
                          name="name"
                          label="Item Name"
                          rules={[{ required: true, message: 'Name is required' }]}
                        >
                          <Input placeholder="Enter item name" />
                        </Form.Item>
                      </Col>
                    </Row>

                    <Form.Item name="description" label="Description">
                      <Input.TextArea rows={3} placeholder="Item description" />
                    </Form.Item>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item
                          name="item_type"
                          label="Item Type"
                          rules={[{ required: true, message: 'Select item type' }]}
                        >
                          <Select placeholder="Select type" options={uniqueItemTypes} />
                        </Form.Item>
                      </Col>

                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="feature_ids" label="Features">
                          <Select
                            mode="multiple"
                            placeholder="Select features"
                            allowClear
                            showSearch
                            maxTagCount="responsive"
                            optionFilterProp="label"
                            options={featureOptions}
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="status" label="Status" initialValue="active">
                          <Select
                            options={[
                              { label: 'Active', value: 'active' },
                              { label: 'Inactive', value: 'inactive' },
                            ]}
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                  </>
                ),
              },
              {
                key: 'attributes',
                label: `Attributes${categoryAttributes.length ? ` (${categoryAttributes.length})` : ''}`,
                children: (
                  <div>
                    {categoryAttributes.length === 0 ? (
                      <div style={{ padding: 16, color: 'rgba(0,0,0,0.45)' }}>
                        No attributes defined for this category. Define them under{' '}
                        <a onClick={() => navigate('/masters/item-attributes')}>Masters → Attributes</a>.
                      </div>
                    ) : (
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr>
                            {['Attribute', 'Type', 'Value', 'UOM Category', 'UOM', ''].map((h) => (
                              <th key={h} style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #eee' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {categoryAttributes.map((a) => {
                            const v = attrValues[a.id] || {};
                            const selectedUomCategoryId = v.uom_category_id || a.uom_category_id || null;
                            return (
                              <tr key={a.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                                <td style={{ padding: 8 }}>
                                  {a.name} {a.is_required ? <span style={{ color: '#f5222d' }}>*</span> : null}
                                </td>
                                <td style={{ padding: 8, color: 'rgba(0,0,0,0.45)' }}>{a.data_type}</td>
                                <td style={{ padding: 8, width: 320 }}>{renderAttributeInput(a, v)}</td>
                                <td style={{ padding: 8, width: 180 }}>
                                  <Select
                                    value={selectedUomCategoryId}
                                    onChange={(val) => {
                                      const currentUom = uoms.find((u) => u.value === (v.uom_id || a.uom_id));
                                      updateAttrFields(a.id, {
                                        uom_category_id: val || null,
                                        uom_id: currentUom && val && currentUom.category_id !== val ? null : v.uom_id,
                                      });
                                    }}
                                    options={uomCategories}
                                    allowClear
                                    showSearch
                                    optionFilterProp="label"
                                    style={{ width: '100%' }}
                                  />
                                </td>
                                <td style={{ padding: 8, width: 160 }}>
                                  <Select
                                    value={v.uom_id || a.uom_id || null}
                                    onChange={(val) => {
                                      const selectedUom = uoms.find((u) => u.value === val);
                                      updateAttrFields(a.id, {
                                        uom_id: val || null,
                                        uom_category_id: selectedUomCategoryId || selectedUom?.category_id || null,
                                      });
                                    }}
                                    options={getUomOptionsForCategory(selectedUomCategoryId)}
                                    allowClear
                                    showSearch
                                    optionFilterProp="label"
                                    style={{ width: '100%' }}
                                  />
                                </td>
                                <td style={{ padding: 8, color: 'rgba(0,0,0,0.3)', fontSize: 11 }}>{a.code}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                ),
              },
              {
                key: 'specs',
                label: `Specs${categorySpecs.length ? ` (${categorySpecs.length})` : ''}`,
                children: (
                  <div>
                    {categorySpecs.length === 0 ? (
                      <div style={{ padding: 16, color: 'rgba(0,0,0,0.45)' }}>
                        No specs mapped for this category. Define them under{' '}
                        <a onClick={() => navigate('/masters/specs')}>Masters → Specs</a>.
                      </div>
                    ) : (
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr>
                            {['Spec', 'Type', 'Value', 'UOM', ''].map((h) => (
                              <th key={h} style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #eee' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {categorySpecs.map((s) => {
                            const v = specValues[s.spec_id] || {
                              value: s.default_value || '',
                              min_value: '',
                              max_value: '',
                              uom_id: s.uom_id || s.spec_uom_id || null,
                            };
                            const selectedUomId = v.uom_id || s.uom_id || s.spec_uom_id || null;
                            const selectedUomCategoryId = s.spec_uom_category_id || uoms.find((u) => u.value === selectedUomId)?.category_id || null;
                            return (
                              <tr key={s.id || s.spec_id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                                <td style={{ padding: 8 }}>
                                  {s.spec_name} {s.is_required ? <span style={{ color: '#f5222d' }}>*</span> : null}
                                </td>
                                <td style={{ padding: 8, color: 'rgba(0,0,0,0.45)' }}>{s.spec_data_type}</td>
                                <td style={{ padding: 8, width: 320 }}>{renderSpecInput(s, v)}</td>
                                <td style={{ padding: 8, width: 180 }}>
                                  <Select
                                    value={selectedUomId}
                                    onChange={(val) => updateSpecValue(s.spec_id, 'uom_id', val || null)}
                                    options={getUomOptionsForCategory(selectedUomCategoryId)}
                                    allowClear
                                    showSearch
                                    optionFilterProp="label"
                                    style={{ width: '100%' }}
                                  />
                                </td>
                                <td style={{ padding: 8, color: 'rgba(0,0,0,0.3)', fontSize: 11 }}>{s.spec_code}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                ),
              },
              {
                key: 'units',
                label: 'Units',
                children: (
                  <Row gutter={16}>
                    <Col span={12}>
                      <Form.Item
                        name="uom_category_id"
                        label="UOM Category"
                        rules={[{ required: true, message: 'UOM Category is required' }]}
                      >
                        <Select
                          placeholder="Select UOM category"
                          options={uomCategories}
                          showSearch
                          optionFilterProp="label"
                          onChange={(categoryId) => {
                            const primaryUomId = form.getFieldValue('primary_uom_id');
                            const selectedUom = uoms.find((u) => u.value === primaryUomId);
                            if (primaryUomId && selectedUom?.category_id !== categoryId) {
                              form.setFieldsValue({ primary_uom_id: undefined });
                            }
                          }}
                          allowClear
                        />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item
                        name="primary_uom_id"
                        label="Primary UOM"
                        rules={[{ required: true, message: 'Primary UOM is required' }]}
                      >
                        <Select
                          placeholder={selectedUomCategoryId ? 'Select UOM' : 'Select UOM category first'}
                          options={getUomOptionsForCategory(selectedUomCategoryId)}
                          showSearch
                          optionFilterProp="label"
                          disabled={!selectedUomCategoryId}
                        />
                      </Form.Item>
                    </Col>
                  </Row>
                ),
              },
              {
                key: 'identification',
                label: 'Identification',
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="hsn_code" label="HSN Code">
                          <Input placeholder="HSN/SAC code" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="barcode_type" label="Barcode Type">
                          <Select placeholder="Select barcode type" options={uniqueBarcodeOptions} />
                        </Form.Item>
                      </Col>
                    </Row>
                  </>
                ),
              },
              {
                key: 'tracking',
                label: 'Tracking',
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item name="has_batch" label="Has Batch" valuePropName="checked">
                          <Switch />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="has_serial" label="Has Serial" valuePropName="checked">
                          <Switch />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="has_expiry" label="Has Expiry" valuePropName="checked">
                          <Switch />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="shelf_life_days" label="Shelf Life (Days)">
                          <InputNumber min={0} style={{ width: '100%' }} placeholder="0" />
                        </Form.Item>
                      </Col>
                    </Row>
                  </>
                ),
              },
              {
                key: 'stock',
                label: 'Stock',
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item name="safety_stock" label="Safety Stock">
                          <InputNumber min={0} style={{ width: '100%' }} placeholder="0" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="reorder_level" label="Reorder Level">
                          <InputNumber min={0} style={{ width: '100%' }} placeholder="0" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="reorder_qty" label="Reorder Qty">
                          <InputNumber min={0} style={{ width: '100%' }} placeholder="0" />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item name="lead_time_days" label="Lead Time (Days)">
                          <InputNumber min={0} style={{ width: '100%' }} placeholder="0" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="min_order_qty" label="Min Order Qty">
                          <InputNumber min={0} style={{ width: '100%' }} placeholder="0" />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="max_order_qty" label="Max Order Qty">
                          <InputNumber min={0} style={{ width: '100%' }} placeholder="0" />
                        </Form.Item>
                      </Col>
                    </Row>
                  </>
                ),
              },
              {
                key: 'pricing',
                label: 'Pricing',
                children: (
                  <Row gutter={16}>
                    <Col span={8}>
                      <Form.Item name="purchase_price" label="Purchase Price">
                        <InputNumber
                          min={0}
                          step={0.01}
                          precision={2}
                          style={{ width: '100%' }}
                          placeholder="0.00"
                          addonBefore="INR"
                        />
                      </Form.Item>
                    </Col>
                    <Col span={8}>
                      <Form.Item name="selling_price" label="Selling Price">
                        <InputNumber
                          min={0}
                          step={0.01}
                          precision={2}
                          style={{ width: '100%' }}
                          placeholder="0.00"
                          addonBefore="INR"
                        />
                      </Form.Item>
                    </Col>
                    <Col span={8}>
                      <Form.Item name="mrp" label="MRP">
                        <InputNumber
                          min={0}
                          step={0.01}
                          precision={2}
                          style={{ width: '100%' }}
                          placeholder="0.00"
                          addonBefore="INR"
                        />
                      </Form.Item>
                    </Col>
                  </Row>
                ),
              },
              {
                key: 'tax',
                label: 'Tax',
                children: (
                  <Row gutter={16}>
                    <Col span={6}>
                      <Form.Item name="tax_rate" label="Tax Rate (%)">
                        <InputNumber min={0} max={100} step={0.01} precision={2} style={{ width: '100%' }} placeholder="0" />
                      </Form.Item>
                    </Col>
                    <Col span={6}>
                      <Form.Item name="cgst_rate" label="CGST Rate (%)">
                        <InputNumber min={0} max={100} step={0.01} precision={2} style={{ width: '100%' }} placeholder="0" />
                      </Form.Item>
                    </Col>
                    <Col span={6}>
                      <Form.Item name="sgst_rate" label="SGST Rate (%)">
                        <InputNumber min={0} max={100} step={0.01} precision={2} style={{ width: '100%' }} placeholder="0" />
                      </Form.Item>
                    </Col>
                    <Col span={6}>
                      <Form.Item name="igst_rate" label="IGST Rate (%)">
                        <InputNumber min={0} max={100} step={0.01} precision={2} style={{ width: '100%' }} placeholder="0" />
                      </Form.Item>
                    </Col>
                  </Row>
                ),
              },
              {
                key: 'additional',
                label: 'Additional',
                children: (
                  <>
                    <Divider orientation="left">Identity</Divider>
                    <Row gutter={16}>
                      <Col span={24}>
                        <Form.Item name="ownership" label="Ownership">
                          <Select allowClear placeholder="Who owns this item?" options={ITEM_OWNERSHIP} />
                        </Form.Item>
                      </Col>
                    </Row>

                    <Divider orientation="left">Brand / Source</Divider>
                    <Row gutter={16}>

                      <Col span={6}>
                        <Form.Item name="manufacturer" label="Manufacturer">
                          <Input placeholder="Producer" />
                        </Form.Item>
                      </Col>
                      <Col span={6}>
                        <Form.Item name="marketer" label="Marketer">
                          <Input placeholder="Marketing company" />
                        </Form.Item>
                      </Col>
                      <Col span={6}>
                        <Form.Item name="distributor" label="Distributor">
                          <Input placeholder="Distributor" />
                        </Form.Item>
                      </Col>
                    </Row>

                    <Divider orientation="left">Healthcare / Valuation</Divider>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item name="dosage_form" label="Dosage Form">
                          <Select allowClear placeholder="Select dosage form" options={[
                            { label: 'Tablet', value: 'Tablet' },
                            { label: 'Capsule', value: 'Capsule' },
                            { label: 'Syrup', value: 'Syrup' },
                            { label: 'Injection', value: 'Injection' },
                            { label: 'Cream', value: 'Cream' },
                            { label: 'Ointment', value: 'Ointment' },
                            { label: 'Drops', value: 'Drops' },
                            { label: 'Powder', value: 'Powder' },
                            { label: 'Inhaler', value: 'Inhaler' },
                            { label: 'Gel', value: 'Gel' },
                            { label: 'Spray', value: 'Spray' },
                            { label: 'Patch', value: 'Patch' },
                            { label: 'Suspension', value: 'Suspension' },
                            { label: 'Other', value: 'Other' },
                          ]} />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item name="valuation_method" label="Valuation Method" initialValue="fifo">
                          <Select options={[
                            { label: 'FIFO (First In First Out)', value: 'fifo' },
                            { label: 'FEFO (First Expiry First Out)', value: 'fefo' },
                            { label: 'LIFO (Last In First Out)', value: 'lifo' },
                            { label: 'Weighted Average', value: 'weighted_average' },
                          ]} />
                        </Form.Item>
                      </Col>
                    </Row>
                  </>
                ),
              },
            ]}
          />
        </Form>
      </Drawer>
    </div>
  );
};

export default Items;

