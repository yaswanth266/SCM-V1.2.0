import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Form, Input, InputNumber, Select, Switch, Space, Button, message, Row, Col, Tabs, Table, Checkbox, Divider, Tooltip, Spin,
} from 'antd';
import { ArrowLeftOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;

const UNIQUE_BARCODE_OPTIONS = [
  { label: 'Auto Generate', value: 'auto' },
  { label: 'QR Code', value: 'qrcode' },
  { label: 'Barcode 128', value: 'barcode_128' },
  { label: 'Barcode EAN-13', value: 'barcode_ean13' },
];

const ITEM_DOSAGE_FORMS = [
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
];

const VALUATION_METHODS = [
  { label: 'FIFO (First In First Out)', value: 'fifo' },
  { label: 'FEFO (First Expiry First Out)', value: 'fefo' },
  { label: 'LIFO (Last In First Out)', value: 'lifo' },
  { label: 'Weighted Average', value: 'weighted_average' },
];

const ItemForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';

  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Lookup data
  const [allCategoriesRaw, setAllCategoriesRaw] = useState([]);
  const [uoms, setUoms] = useState([]);
  const [uomCategories, setUomCategories] = useState([]);
  const [brandOptions, setBrandOptions] = useState([]);
  const [itemTypeOptions, setItemTypeOptions] = useState([]);
  const [featureOptions, setFeatureOptions] = useState([]);

  // Category selection states
  const [level1Id, setLevel1Id] = useState(undefined);
  const [level2Id, setLevel2Id] = useState(undefined);
  const [level3Id, setLevel3Id] = useState(undefined);

  // Dynamic attributes & specs
  const [categoryAttributes, setCategoryAttributes] = useState([]);
  const [attrValues, setAttrValues] = useState({}); // { attribute_id: { value, uom_id } }
  const [categorySpecs, setCategorySpecs] = useState([]);
  const [specValues, setSpecValues] = useState({}); // { spec_id: { value, min_value, max_value, uom_id } }
  const [autoCodePreview, setAutoCodePreview] = useState('');
  const [autoCodeError, setAutoCodeError] = useState('');
  const [kitComponents, setKitComponents] = useState([]);

  // Form conditional fields
  const [selectedIsKit, setSelectedIsKit] = useState(false);
  const [selectedAddInitialQty, setSelectedAddInitialQty] = useState(false);
  const [selectedUomCategoryId, setSelectedUomCategoryId] = useState(undefined);

  const fetchLookups = useCallback(async () => {
    setLoading(true);
    try {
      const [catRes, uomCatRes, uomRes, brandRes, typeRes] = await Promise.all([
        api.get('/masters/categories', { params: { page_size: 500 } }),
        api.get('/masters/uom-categories', { params: { page_size: 100 } }),
        api.get('/masters/uom', { params: { page_size: 500 } }),
        api.get('/masters/brands', { params: { page_size: 500 } }),
        api.get('/masters/item-types', { params: { page_size: 100 } }),
      ]);

      const catData = catRes.data?.items || catRes.data?.data || catRes.data || [];
      setAllCategoriesRaw(catData);

      const uomCats = uomCatRes.data?.items || uomCatRes.data?.data || uomCatRes.data || [];
      setUomCategories(uomCats.map((c) => ({ label: c.name, value: c.id })));

      const uomItems = uomRes.data?.items || uomRes.data?.data || uomRes.data || [];
      setUoms(uomItems.map((u) => ({
        label: u.abbreviation ? `${u.name} (${u.abbreviation})` : u.name,
        value: u.id,
        id: u.id,
        name: u.name,
        abbreviation: u.abbreviation,
        category_id: u.category_id,
      })));

      const brands = brandRes.data?.items || brandRes.data?.data || brandRes.data || [];
      setBrandOptions(brands.map((b) => ({ label: b.name, value: b.name })));

      const types = typeRes.data?.items || typeRes.data?.data || typeRes.data || [];
      setItemTypeOptions(types.map((t) => {
        if (typeof t === 'object' && t !== null) {
          return {
            label: t.name ? t.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '',
            value: t.name || '',
          };
        }
        return {
          label: String(t).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          value: String(t),
        };
      }));

      if (!isNew) {
        await fetchItemData(catData);
      } else {
        form.setFieldsValue({
          item_code: '',
          status: 'active',
          has_batch: false,
          has_serial: false,
          has_expiry: false,
          barcode_type: 'auto',
          valuation_method: 'fifo',
          category_id: undefined,
          is_kit: false,
          add_initial_qty: false,
          initial_quantity: undefined,
        });
      }
    } catch (err) {
      message.error('Failed to load form lookup data: ' + getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id, isNew]);

  useEffect(() => {
    fetchLookups();
  }, [fetchLookups]);

  const fetchItemData = async (catData) => {
    try {
      const res = await api.get(`/masters/items/${id}`);
      const item = res.data;
      setSelectedIsKit(Boolean(item.is_kit));
      setSelectedUomCategoryId(item.uom_category_id);

      // Resolve category path (Level 1 > Level 2 > Level 3)
      const resolveLevels = () => {
        const leafId = item.category_id;
        if (!leafId) return;
        const leaf = catData.find((c) => c.id === leafId);
        if (!leaf) return;

        if (Number(leaf.level) === 3) {
          setLevel3Id(leaf.id);
          setLevel2Id(leaf.parent_id);
          const p = catData.find((c) => c.id === leaf.parent_id);
          if (p) setLevel1Id(p.parent_id);
        } else if (Number(leaf.level) === 2) {
          setLevel2Id(leaf.id);
          setLevel1Id(leaf.parent_id);
        } else {
          setLevel1Id(leaf.id);
        }
      };
      resolveLevels();

      form.setFieldsValue({
        ...item,
        status: item.is_active === false ? 'inactive' : 'active',
      });

      const catId = item.category_id;
      if (catId) {
        await Promise.all([
          loadAttributesForCategory(catId, item.id),
          loadSpecsForCategory(catId, item.id),
          fetchFeatures(catId),
        ]);
      }

      if (item.is_kit && Array.isArray(item.kit_components)) {
        setKitComponents(
          item.kit_components.map((c, idx) => ({
            key: c.id || idx,
            component_name: c.component_name,
            quantity: c.quantity,
            uom_id: c.uom_id,
            remarks: c.remarks || '',
          }))
        );
      }
    } catch (err) {
      message.error('Failed to load item: ' + getErrorMessage(err));
      navigate('/masters/items');
    }
  };

  const loadAttributesForCategory = async (categoryId, itemId = null) => {
    try {
      const res = await api.get('/masters/item-attributes', { params: { category_id: categoryId } });
      setCategoryAttributes(res.data || []);
      if (itemId) {
        const valRes = await api.get(`/masters/items/${itemId}/attribute-values`);
        const aMap = {};
        (valRes.data || []).forEach((v) => {
          aMap[v.attribute_id] = v;
        });
        setAttrValues(aMap);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const loadSpecsForCategory = async (categoryId, itemId = null) => {
    try {
      const res = await api.get('/masters/item-specs', { params: { item_category_id: categoryId } });
      setCategorySpecs(res.data || []);
      if (itemId) {
        const valRes = await api.get(`/masters/items/${itemId}/spec-values`);
        const sMap = {};
        (valRes.data || []).forEach((v) => {
          sMap[v.spec_id] = v;
        });
        setSpecValues(sMap);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchFeatures = async (categoryId) => {
    try {
      const res = await api.get('/masters/features', { params: { category_id: categoryId } });
      const data = res.data?.items || res.data?.data || res.data || [];
      setFeatureOptions(data.map((f) => ({ label: f.name, value: f.id })));
    } catch {
      setFeatureOptions([]);
    }
  };

  const previewItemCode = async (categoryId) => {
    if (!categoryId || !isNew) {
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
    if (!isNew) return;
    setAutoCodePreview('');
    setAutoCodeError('');
    form.setFieldsValue({ item_code: '' });
  };

  const getUomOptionsForCategory = (categoryId) => (
    categoryId ? uoms.filter((u) => u.category_id === categoryId) : uoms
  );

  const handleValuesChange = (changed, all) => {
    if ('is_kit' in changed) {
      setSelectedIsKit(changed.is_kit);
    }
    if ('add_initial_qty' in changed) {
      setSelectedAddInitialQty(changed.add_initial_qty);
    }
    if ('uom_category_id' in changed) {
      setSelectedUomCategoryId(changed.uom_category_id);
    }
  };

  // Attributes / Specs inputs updates
  const updateAttrValue = (attrId, field, val) => {
    setAttrValues((prev) => ({
      ...prev,
      [attrId]: { ...prev[attrId], [field]: val },
    }));
  };

  const updateAttrFields = (attrId, fields) => {
    setAttrValues((prev) => ({
      ...prev,
      [attrId]: { ...prev[attrId], ...fields },
    }));
  };

  const updateSpecValue = (specId, field, val) => {
    setSpecValues((prev) => ({
      ...prev,
      [specId]: { ...prev[specId], [field]: val },
    }));
  };

  // Kit components manipulation
  const addKitComponent = () => {
    setKitComponents((prev) => [
      ...prev,
      { key: Date.now(), component_name: '', quantity: 1, uom_id: undefined, remarks: '' },
    ]);
  };

  const removeKitComponent = (key) => {
    setKitComponents((prev) => prev.filter((c) => c.key !== key));
  };

  const updateKitComponent = (key, field, val) => {
    setKitComponents((prev) =>
      prev.map((c) => (c.key === key ? { ...c, [field]: val } : c))
    );
  };

  const kitComponentCode = (index, parentCode) => {
    const base = parentCode ? parentCode.trim() : 'AUTO';
    return `${base}-${kitComponentSuffix(index)}`;
  };

  const kitComponentSuffix = (index) => {
    let value = index + 1;
    const chars = [];
    while (value >= 0) {
      chars.unshift(String.fromCharCode(97 + (value % 26)));
      value = Math.floor(value / 26) - 1;
    }
    return chars.join('');
  };

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

  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const values = await form.validateFields();

      // Validate required dynamic attributes
      const missingAttrs = categoryAttributes.filter((a) => {
        if (!a.is_required) return false;
        const v = attrValues[a.id];
        return !v || v.value === undefined || v.value === null || String(v.value).trim() === '';
      });
      if (missingAttrs.length > 0) {
        message.error(`Please fill required attribute: ${missingAttrs[0].name}`);
        setSubmitting(false);
        return;
      }

      // Validate required dynamic specs
      const missingSpecs = categorySpecs.filter((s) => {
        if (!s.is_required) return false;
        const v = specValues[s.spec_id];
        if (!v) return true;
        const hasVal = v.value != null && String(v.value).trim() !== '';
        const hasMin = v.min_value != null && String(v.min_value).trim() !== '';
        const hasMax = v.max_value != null && String(v.max_value).trim() !== '';
        return !(hasVal || hasMin || hasMax);
      });
      if (missingSpecs.length > 0) {
        message.error(`Please fill required spec: ${missingSpecs[0].spec_name || missingSpecs[0].name}`);
        setSubmitting(false);
        return;
      }

      const savingKit = Boolean(values.is_kit);
      const normalizedKitComponents = kitComponents
        .map((row, idx) => ({
          component_code: kitComponentCode(idx, values.item_code) || null,
          component_name: row.component_name ? String(row.component_name).trim() : '',
          quantity: Number(row.quantity || 0),
          uom_id: row.uom_id || null,
          sort_order: idx + 1,
          remarks: row.remarks ? String(row.remarks).trim() : null,
        }))
        .filter((row) => row.component_name || row.component_code || row.quantity || row.uom_id);

      if (savingKit) {
        if (normalizedKitComponents.length === 0) {
          message.error('Add at least one component for this item.');
          setSubmitting(false);
          return;
        }
        const invalidComponent = normalizedKitComponents.find((row) => !row.component_name || !row.quantity || row.quantity <= 0 || !row.uom_id);
        if (invalidComponent) {
          message.error('Each component needs a name, quantity greater than zero, and UOM.');
          setSubmitting(false);
          return;
        }
      }

      const { status, add_initial_qty, initial_quantity, ...rest } = values;
      delete rest.secondary_uom_id;
      delete rest.sku;
      delete rest.weight;
      delete rest.weight_uom;
      delete rest.volume;
      delete rest.volume_uom;

      if (isNew && autoCodePreview && rest.item_code === autoCodePreview) {
        rest.item_code = 'AUTO';
      }

      const payload = {
        ...rest,
        is_active: status === 'inactive' ? false : true,
        kit_components: savingKit ? normalizedKitComponents : [],
      };

      if (isNew && add_initial_qty && initial_quantity != null) {
        payload.initial_quantity = initial_quantity;
      }

      let savedItemId;
      if (!isNew) {
        await api.put(`/masters/items/${id}`, payload);
        savedItemId = id;
        message.success('Item updated successfully');
      } else {
        const res = await api.post('/masters/items', payload);
        savedItemId = res.data?.id || res.data?.data?.id;
        message.success('Item created successfully');
      }

      // Save per-item attribute values
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

      // Save per-item specs values
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

      navigate('/masters/items');
    } catch (err) {
      if (err.errorFields) {
        message.error('Please fix the highlighted validation errors before saving.');
        return;
      }
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const kitComponentColumns = [
    { title: '#', key: 'index', width: 64, render: (_, __, index) => index + 1 },
    {
      title: 'Component Name',
      dataIndex: 'component_name',
      render: (val, record) => (
        <Input
          value={val}
          onChange={(e) => updateKitComponent(record.key, 'component_name', e.target.value)}
          placeholder="Component Name"
        />
      ),
    },
    {
      title: 'Quantity',
      dataIndex: 'quantity',
      width: 140,
      render: (val, record) => (
        <InputNumber
          value={val}
          min={0.001}
          onChange={(value) => updateKitComponent(record.key, 'quantity', value)}
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'UOM',
      dataIndex: 'uom_id',
      width: 180,
      render: (val, record) => (
        <Select
          value={val}
          onChange={(value) => updateKitComponent(record.key, 'uom_id', value)}
          options={uoms.map((u) => ({ label: `${u.name} (${u.abbreviation || ''})`, value: u.id }))}
          placeholder="Select UOM"
          showSearch
          optionFilterProp="label"
          allowClear
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: 'Remarks',
      dataIndex: 'remarks',
      render: (val, record) => (
        <Input
          value={val}
          onChange={(e) => updateKitComponent(record.key, 'remarks', e.target.value)}
          placeholder="Optional remarks"
        />
      ),
    },
    {
      title: '',
      width: 80,
      render: (_, record) => (
        <Button danger type="link" icon={<DeleteOutlined />} onClick={() => removeKitComponent(record.key)} />
      ),
    },
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={isNew ? 'Create Item' : 'Edit Item'} subtitle="Manage item details and metadata">
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/masters/items')}>
            Back to Items
          </Button>
          <Button type="primary" onClick={handleSubmit} loading={submitting}>
            {isNew ? 'Create Item' : 'Save Changes'}
          </Button>
        </Space>
      </PageHeader>

      <Card>
        <Form form={form} layout="vertical" requiredMark="optional" preserve onValuesChange={handleValuesChange}>
          <Tabs
            defaultActiveKey="basic"
            destroyOnHidden={false}
            items={[
              {
                key: 'basic',
                label: 'Basic',
                children: (
                  <>
                    <Row gutter={16}>
                      <Col span={8}>
                        <Form.Item label="Category Level 1">
                          <Select
                            placeholder="Select Level 1"
                            value={level1Id}
                            disabled={!isNew}
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
                            disabled={!isNew || !level1Id}
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
                            disabled={!isNew || !level2Id}
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

                    <Row gutter={16}>
                      <Col span={8}>
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
                      <Col span={8}>
                        <Form.Item
                          name="item_type"
                          label="Item Type"
                          rules={[{ required: true, message: 'Select item type' }]}
                        >
                          <Select placeholder="Select type" options={itemTypeOptions} />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="is_kit" valuePropName="checked" label=" ">
                          <Checkbox>Has Components / Kit</Checkbox>
                        </Form.Item>
                      </Col>
                    </Row>

                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item
                          name="item_code"
                          label="Item Code"
                          help={autoCodeError || (autoCodePreview ? 'System code auto-generated from Level 1 + Level 2 + Level 3 numeric sequence. Readable code is created after save.' : undefined)}
                          validateStatus={autoCodeError ? 'warning' : undefined}
                          rules={[{ required: true, message: 'Item code is required' }]}
                        >
                          <Input
                            disabled={!isNew}
                            readOnly={isNew}
                            placeholder="Select Category Level 1, 2, and 3"
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
                      <TextArea rows={3} placeholder="Item description" />
                    </Form.Item>

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

                    {isNew && (
                      <Row gutter={16}>
                        <Col span={12}>
                          <Form.Item name="add_initial_qty" valuePropName="checked" initialValue={false} label=" ">
                            <Checkbox>Add Initial Quantity</Checkbox>
                          </Form.Item>
                        </Col>
                        {selectedAddInitialQty && (
                          <Col span={12}>
                            <Form.Item
                              name="initial_quantity"
                              label="Initial Quantity"
                              rules={[
                                { required: true, message: 'Initial quantity is required' },
                                { type: 'number', min: 0.001, message: 'Quantity must be greater than zero' }
                              ]}
                            >
                              <InputNumber min={0.001} precision={3} style={{ width: '100%' }} placeholder="Enter initial quantity" />
                            </Form.Item>
                          </Col>
                        )}
                      </Row>
                    )}
                  </>
                ),
              },
              {
                key: 'kit',
                label: `Kit Components${kitComponents.length ? ` (${kitComponents.length})` : ''}`,
                children: (
                  <div>
                    {selectedIsKit ? (
                      <>
                        <div style={{ marginBottom: 12, color: 'rgba(0,0,0,0.65)' }}>
                          Define what is inside one parent pack. Stock, indent, procurement, and issue continue to use the parent item.
                        </div>
                        <Table
                          dataSource={kitComponents}
                          columns={kitComponentColumns}
                          rowKey="key"
                          pagination={false}
                          size="small"
                          scroll={{ x: 1000 }}
                          footer={() => (
                            <Button type="dashed" icon={<PlusOutlined />} onClick={addKitComponent} block>
                              Add Component
                            </Button>
                          )}
                          locale={{ emptyText: 'No kit components added' }}
                        />
                      </>
                    ) : (
                      <div style={{ padding: 16, color: 'rgba(0,0,0,0.45)' }}>
                        Enable Has Components / Kit in Basic to define pack components.
                      </div>
                    )}
                  </div>
                ),
              },
              {
                key: 'attributes',
                label: `Attributes${categoryAttributes.length ? ` (${categoryAttributes.length})` : ''}`,
                children: (
                  <div>
                    {categoryAttributes.length === 0 ? (
                      <div style={{ padding: 16, color: 'rgba(0,0,0,0.45)' }}>
                        No attributes defined for this category.
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
                            const currentUomCategoryId = v.uom_category_id || a.uom_category_id || null;
                            return (
                              <tr key={a.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                                <td style={{ padding: 8 }}>
                                  {a.name} {a.is_required ? <span style={{ color: '#f5222d' }}>*</span> : null}
                                </td>
                                <td style={{ padding: 8, color: 'rgba(0,0,0,0.45)' }}>{a.data_type}</td>
                                <td style={{ padding: 8, width: 320 }}>{renderAttributeInput(a, v)}</td>
                                <td style={{ padding: 8, width: 180 }}>
                                  <Select
                                    value={currentUomCategoryId}
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
                                        uom_category_id: currentUomCategoryId || selectedUom?.category_id || null,
                                      });
                                    }}
                                    options={getUomOptionsForCategory(currentUomCategoryId)}
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
                        No specs mapped for this category.
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
                            const currentUomCategoryId = s.spec_uom_category_id || uoms.find((u) => u.value === selectedUomId)?.category_id || null;
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
                                    options={getUomOptionsForCategory(currentUomCategoryId)}
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
                      <Col span={12}>
                        <Form.Item name="barcode_type" label="Barcode Type">
                          <Select placeholder="Select barcode type" options={UNIQUE_BARCODE_OPTIONS} />
                        </Form.Item>
                      </Col>
                    </Row>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="barcode_value" label="Barcode Value">
                          <Input placeholder="Barcode text" />
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
                label: 'Stock Limits',
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
                        <Form.Item
                          name="min_order_qty"
                          label="Min Order Qty"
                          dependencies={['max_order_qty']}
                          rules={[
                            ({ getFieldValue }) => ({
                              validator(_, value) {
                                const minVal = value !== undefined && value !== null ? Number(value) : 0;
                                const maxVal = getFieldValue('max_order_qty');
                                const maxValNum = maxVal !== undefined && maxVal !== null ? Number(maxVal) : 0;
                                if (maxValNum > 0 && minVal >= maxValNum) {
                                  return Promise.reject(new Error('Min Order Qty must be less than Max Order Qty'));
                                }
                                return Promise.resolve();
                              },
                            }),
                          ]}
                        >
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
                label: 'Tax Rates',
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
                    <Divider orientation="left">Healthcare & Valuation</Divider>
                    <Row gutter={16}>
                      <Col span={12}>
                        <Form.Item name="dosage_form" label="Dosage Form">
                          <Select allowClear placeholder="Select dosage form" options={ITEM_DOSAGE_FORMS} />
                        </Form.Item>
                      </Col>
                      <Col span={12}>
                        <Form.Item name="valuation_method" label="Valuation Method" initialValue="fifo">
                          <Select options={VALUATION_METHODS} />
                        </Form.Item>
                      </Col>
                    </Row>
                  </>
                ),
              },
            ]}
          />
        </Form>
      </Card>
    </div>
  );
};

export default ItemForm;
