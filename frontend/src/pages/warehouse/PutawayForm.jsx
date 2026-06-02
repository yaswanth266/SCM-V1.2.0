import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Form, Input, Select, Button, Space, Spin, message, Table,
  Descriptions, Row, Col, InputNumber, Typography, Divider, Tag,
} from 'antd';
import {
  ArrowLeftOutlined, SaveOutlined, PlusOutlined,
  DeleteOutlined, InboxOutlined,
} from '@ant-design/icons';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import { formatDateTime, formatNumber, getErrorMessage } from '../../utils/helpers';

const { Text } = Typography;

const PutawayForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [form] = Form.useForm();
  const isNew = !id || id === 'new';

  // State
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [putaway, setPutaway] = useState(null);

  // Lookup data
  const [warehouses, setWarehouses] = useState([]);
  const [grnList, setGrnList] = useState([]);
  const [grnItems, setGrnItems] = useState([]);

  // Items table state
  const [items, setItems] = useState([]);
  const [putawayType, setPutawayType] = useState('grn_based');

  // Cascading location state per item (keyed by item row key)
  const [locationOptions, setLocationOptions] = useState({});
  const [lineOptions, setLineOptions] = useState({});
  const [rackOptions, setRackOptions] = useState({});
  const [binOptions, setBinOptions] = useState({});

  // Read query params for pre-population
  const getQueryParam = (key) => {
    const params = new URLSearchParams(location.search);
    return params.get(key);
  };

  // --- Load Warehouses ---
  const loadWarehouses = useCallback(async () => {
    try {
      const res = await api.get('/masters/warehouses', { params: { page_size: 200, exclude_virtual: true } });
      const data = res.data;
      const list = data.items || data.data || data || [];
      setWarehouses(list.map((w) => ({ label: w.name || w.warehouse_name, value: w.id })));
    } catch {
      // silent
    }
  }, []);

  // --- Load GRN list (ones ready for putaway) ---
  const loadGRNs = useCallback(async () => {
    try {
      // Bug fix BUG_0063: GRN never has status 'approved'. The valid post-QI
      // states for putaway are qi_done / putaway_pending / partially_putaway.
      const res = await api.get('/warehouse/grn', {
        params: { page_size: 200, status: 'qi_done,putaway_pending,partially_putaway' },
      });
      const data = res.data;
      const list = data.items || data.data || data || [];
      setGrnList(list.map((g) => ({
        label: `${g.grn_number || g.id} - ${g.vendor_name || ''}`,
        value: g.id,
        grn: g,
      })));
      if (list.length === 0) {
        message.info('No GRNs ready for putaway. Complete Quality Inspection first.');
      }
    } catch (e) {
      message.error('Failed to load GRNs. ' + (e?.response?.data?.detail || e?.message || ''));
      // fall through to legacy fallback below
      try {
        const res = await api.get('/warehouse/grn', { params: { page_size: 200 } });
        const data = res.data;
        const list = data.items || data.data || data || [];
        setGrnList(list.map((g) => ({
          label: `${g.grn_number || g.id} - ${g.vendor_name || ''}`,
          value: g.id,
          grn: g,
        })));
      } catch {
        // silent
      }
    }
  }, []);

  // --- Load GRN items when a GRN is selected ---
  const loadGRNItems = useCallback(async (grnId) => {
    if (!grnId) {
      setGrnItems([]);
      return;
    }
    try {
      const res = await api.get(`/warehouse/grn/${grnId}`);
      const data = res.data;
      const grnItemsList = data.items || [];
      setGrnItems(grnItemsList);

      // Auto-populate items table from GRN items
      const newItems = grnItemsList.map((gi, idx) => ({
        key: `grn-${gi.id || idx}-${Date.now()}`,
        grn_item_id: gi.id,
        item_id: gi.item_id,
        item_name: gi.item_name || (gi.item && (gi.item.item_name || gi.item.name)) || '',
        item_code: gi.item_code || (gi.item && gi.item.item_code) || '',
        qty: gi.received_qty || gi.qty || gi.quantity || 0,
        uom_id: gi.uom_id,
        uom_name: gi.uom || gi.uom_name || (gi.item && gi.item.uom) || '',
        batch_id: gi.batch_id || null,
        batch_number: gi.batch_number || '',
        suggested_bin_id: null,
        location_id: null,
        line_id: null,
        rack_id: null,
      }));
      setItems(newItems);

      // Pre-fill warehouse from GRN if available
      if (data.warehouse_id) {
        form.setFieldsValue({ warehouse_id: data.warehouse_id });
        // Load locations for the warehouse
        newItems.forEach((item) => {
          loadLocations(data.warehouse_id, item.key);
        });
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  }, [form]);

  // --- Cascading selectors: Load locations for a warehouse ---
  const loadLocations = useCallback(async (warehouseId, itemKey) => {
    if (!warehouseId) return;
    try {
      const res = await api.get(`/masters/warehouses/${warehouseId}/locations`, { params: { page_size: 200 } });
      const data = res.data;
      const list = data.items || data.data || data || [];
      setLocationOptions((prev) => ({
        ...prev,
        [itemKey]: list.map((l) => ({ label: l.name || l.code || l.label, value: l.id })),
      }));
    } catch {
      // silent
    }
  }, []);

  // --- Load lines for a location ---
  const loadLines = useCallback(async (warehouseId, locationId, itemKey) => {
    if (!warehouseId || !locationId) return;
    try {
      const res = await api.get(`/masters/warehouses/${warehouseId}/locations/${locationId}/lines`, { params: { page_size: 200 } });
      const data = res.data;
      const list = data.items || data.data || data || [];
      setLineOptions((prev) => ({
        ...prev,
        [itemKey]: list.map((l) => ({ label: l.name || l.code || l.label, value: l.id })),
      }));
    } catch {
      // silent
    }
  }, []);

  // --- Load racks for a line ---
  const loadRacks = useCallback(async (warehouseId, lineId, itemKey) => {
    if (!warehouseId || !lineId) return;
    try {
      const res = await api.get(`/masters/warehouses/${warehouseId}/lines/${lineId}/racks`, { params: { page_size: 200 } });
      const data = res.data;
      const list = data.items || data.data || data || [];
      setRackOptions((prev) => ({
        ...prev,
        [itemKey]: list.map((r) => ({ label: r.name || r.code || r.label, value: r.id })),
      }));
    } catch {
      // silent
    }
  }, []);

  // --- Load bins for a rack ---
  const loadBins = useCallback(async (warehouseId, rackId, itemKey) => {
    if (!warehouseId || !rackId) return;
    try {
      const res = await api.get(`/masters/warehouses/${warehouseId}/racks/${rackId}/bins`, { params: { page_size: 200 } });
      const data = res.data;
      const list = data.items || data.data || data || [];
      setBinOptions((prev) => ({
        ...prev,
        [itemKey]: list.map((b) => ({ label: b.name || b.code || b.label, value: b.id })),
      }));
    } catch {
      // silent
    }
  }, []);

  // --- Fetch existing putaway ---
  const fetchPutaway = useCallback(async () => {
    if (isNew) return;
    setLoading(true);
    try {
      const res = await api.get(`/warehouse/putaways/${id}`);
      setPutaway(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/warehouse/putaway');
    } finally {
      setLoading(false);
    }
  }, [id, isNew, navigate]);

  useEffect(() => {
    if (isNew) {
      loadWarehouses();
      loadGRNs();
      // Check for pre-populated GRN from query params
      const grnId = getQueryParam('grn_id');
      if (grnId) {
        form.setFieldsValue({ grn_id: parseInt(grnId, 10) });
        loadGRNItems(parseInt(grnId, 10));
      }
    } else {
      fetchPutaway();
    }
  }, [isNew, fetchPutaway, loadWarehouses, loadGRNs]);

  // --- Update item field ---
  const updateItem = (key, field, value) => {
    setItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        const updated = { ...item, [field]: value };

        // Reset cascading fields
        if (field === 'location_id') {
          updated.line_id = null;
          updated.rack_id = null;
          updated.suggested_bin_id = null;
          // Clear child options
          setLineOptions((p) => ({ ...p, [key]: [] }));
          setRackOptions((p) => ({ ...p, [key]: [] }));
          setBinOptions((p) => ({ ...p, [key]: [] }));
          // Load lines
          const warehouseId = form.getFieldValue('warehouse_id');
          if (warehouseId && value) {
            loadLines(warehouseId, value, key);
          }
        }
        if (field === 'line_id') {
          updated.rack_id = null;
          updated.suggested_bin_id = null;
          setRackOptions((p) => ({ ...p, [key]: [] }));
          setBinOptions((p) => ({ ...p, [key]: [] }));
          const warehouseId = form.getFieldValue('warehouse_id');
          if (warehouseId && value) {
            loadRacks(warehouseId, value, key);
          }
        }
        if (field === 'rack_id') {
          updated.suggested_bin_id = null;
          setBinOptions((p) => ({ ...p, [key]: [] }));
          const warehouseId = form.getFieldValue('warehouse_id');
          if (warehouseId && value) {
            loadBins(warehouseId, value, key);
          }
        }

        return updated;
      })
    );
  };

  // --- Add a blank item row (manual mode) ---
  const addItemRow = () => {
    const newKey = `manual-${Date.now()}`;
    setItems((prev) => [
      ...prev,
      {
        key: newKey,
        grn_item_id: null,
        item_id: null,
        item_name: '',
        item_code: '',
        qty: 0,
        uom_id: null,
        uom_name: '',
        batch_id: null,
        suggested_bin_id: null,
        location_id: null,
        line_id: null,
        rack_id: null,
      },
    ]);
    // Load locations for new row if warehouse is selected
    const warehouseId = form.getFieldValue('warehouse_id');
    if (warehouseId) {
      loadLocations(warehouseId, newKey);
    }
  };

  // --- Remove an item row ---
  const removeItem = (key) => {
    setItems((prev) => prev.filter((item) => item.key !== key));
  };

  // --- Handle warehouse change: reload locations for all items ---
  const handleWarehouseChange = (warehouseId) => {
    // Clear and reload locations for all items
    setLocationOptions({});
    setLineOptions({});
    setRackOptions({});
    setBinOptions({});

    // Reset location-related fields for all items
    setItems((prev) =>
      prev.map((item) => ({
        ...item,
        location_id: null,
        line_id: null,
        rack_id: null,
        suggested_bin_id: null,
      }))
    );

    if (warehouseId) {
      items.forEach((item) => {
        loadLocations(warehouseId, item.key);
      });
    }
  };

  // --- Handle GRN selection ---
  const handleGRNChange = (grnId) => {
    if (grnId) {
      loadGRNItems(grnId);
    } else {
      setGrnItems([]);
      setItems([]);
    }
  };

  // --- Handle putaway type change ---
  const handlePutawayTypeChange = (type) => {
    setPutawayType(type);
    if (type === 'manual') {
      // Clear GRN selection, start with empty items
      form.setFieldsValue({ grn_id: undefined });
      setGrnItems([]);
      setItems([]);
    }
  };

  // --- Submit ---
  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();

      if (items.length === 0) {
        message.error('Please add at least one item');
        return;
      }

      // Validate items
      const invalidItems = items.filter((item) => !item.item_id || !item.qty || item.qty <= 0);
      if (invalidItems.length > 0) {
        message.error('All items must have a valid item selected and quantity greater than 0');
        return;
      }

      setSubmitting(true);

      const payload = {
        grn_id: values.grn_id || null,
        warehouse_id: values.warehouse_id,
        putaway_type: putawayType,
        remarks: values.remarks || null,
        items: items.map((item) => ({
          grn_item_id: item.grn_item_id || null,
          item_id: item.item_id,
          qty: item.qty,
          uom_id: item.uom_id || null,
          suggested_bin_id: item.suggested_bin_id || null,
          batch_id: item.batch_id || null,
        })),
      };

      const res = await api.post('/warehouse/putaways', payload);
      message.success('Putaway created successfully');
      const newId = res.data?.id;
      if (newId) {
        navigate(`/warehouse/putaway/${newId}`);
      } else {
        navigate('/warehouse/putaway');
      }
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  // --- Loading spinner ---
  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <Spin size="large" tip="Loading Putaway..." fullscreen />
      </div>
    );
  }

  // --- VIEW MODE (existing putaway) ---
  if (!isNew && putaway) {
    const putawayItems = putaway.items || [];
    return (
      <div>
        <PageHeader
          title={putaway.putaway_number || `Putaway #${id}`}
          subtitle="Putaway Detail"
        >
          <Space>
            <Button
              icon={<ArrowLeftOutlined />}
              onClick={() => navigate('/warehouse/putaway')}
            >
              Back
            </Button>
          </Space>
        </PageHeader>

        <Card style={{ marginBottom: 16 }}>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="Putaway Number">
              <Text strong>{putaway.putaway_number || '-'}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="Status">
              <StatusTag status={putaway.status} />
            </Descriptions.Item>
            <Descriptions.Item label="Putaway Type">
              <Tag color={putaway.putaway_type === 'grn_based' ? 'blue' : 'orange'}>
                {putaway.putaway_type === 'grn_based' ? 'GRN Based' : putaway.putaway_type === 'system_directed' ? 'System Directed' : 'Manual'}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="GRN Reference">
              {putaway.grn_number || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Warehouse">
              {putaway.warehouse_name || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Assigned To">
              {putaway.assigned_to_name || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Remarks" span={3}>
              {putaway.remarks || '-'}
            </Descriptions.Item>
            <Descriptions.Item label="Created At">
              {formatDateTime(putaway.created_at)}
            </Descriptions.Item>
            <Descriptions.Item label="Created By">
              {putaway.created_by_name || putaway.created_by || '-'}
            </Descriptions.Item>
            {putaway.completed_at && (
              <Descriptions.Item label="Completed At">
                {formatDateTime(putaway.completed_at)}
              </Descriptions.Item>
            )}
          </Descriptions>
        </Card>

        {/* Items Table */}
        <Card>
          <Divider orientation="left">
            <Space>
              <InboxOutlined />
              Putaway Items ({putawayItems.length})
            </Space>
          </Divider>
          <Table
            dataSource={putawayItems}
            rowKey={(r) => r.id || r.item_id}
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
              {
                title: 'Item Code',
                dataIndex: 'item_code',
                width: 120,
                render: (v, r) => v || (r.item && r.item.item_code) || '-',
              },
              {
                title: 'Item Name',
                dataIndex: 'item_name',
                width: 200,
                render: (v, r) => v || (r.item && (r.item.item_name || r.item.name)) || '-',
              },
              {
                title: 'Qty',
                dataIndex: 'qty',
                width: 80,
                align: 'right',
                render: (v, r) => formatNumber(v || r.quantity || 0),
              },
              {
                title: 'UOM',
                dataIndex: 'uom',
                width: 70,
                render: (v, r) => v || r.uom_name || '-',
              },
              {
                title: 'Batch',
                dataIndex: 'batch_number',
                width: 120,
                render: (v) => v || '-',
              },
              {
                title: 'Suggested Bin',
                dataIndex: 'suggested_bin',
                width: 150,
                render: (v, r) => v || r.suggested_bin_name || '-',
              },
              {
                title: 'Actual Bin',
                dataIndex: 'actual_bin',
                width: 150,
                render: (v, r) => v || r.actual_bin_name || '-',
              },
              {
                title: 'Status',
                dataIndex: 'status',
                width: 110,
                render: (s) => s ? <StatusTag status={s} /> : '-',
              },
            ]}
          />
        </Card>
      </div>
    );
  }

  // --- CREATE MODE ---
  const itemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item',
      dataIndex: 'item_id',
      width: 220,
      render: (_, record) => {
        if (record.grn_item_id) {
          // From GRN - show read-only
          return (
            <Text>
              {record.item_code ? `[${record.item_code}] ` : ''}{record.item_name}
            </Text>
          );
        }
        return (
          <ItemSelector
            value={record.item_id}
            onChange={(val, itemData) => {
              updateItem(record.key, 'item_id', val);
              if (itemData) {
                updateItem(record.key, 'item_name', itemData.item_name || itemData.name || '');
                updateItem(record.key, 'item_code', itemData.item_code || itemData.code || '');
                updateItem(record.key, 'uom_id', itemData.uom_id || null);
                updateItem(record.key, 'uom_name', itemData.uom || itemData.uom_name || '');
              }
            }}
            placeholder="Search item..."
          />
        );
      },
    },
    {
      title: 'Qty',
      dataIndex: 'qty',
      width: 100,
      render: (val, record) => (
        <InputNumber
          value={val}
          min={0.01}
          precision={2}
          style={{ width: '100%' }}
          onChange={(v) => updateItem(record.key, 'qty', v)}
        />
      ),
    },
    {
      title: 'UOM',
      dataIndex: 'uom_name',
      width: 80,
      render: (v) => v || '-',
    },
    {
      title: 'Location',
      width: 150,
      render: (_, record) => (
        <Select
          value={record.location_id}
          options={locationOptions[record.key] || []}
          placeholder="Location"
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: '100%' }}
          onChange={(v) => updateItem(record.key, 'location_id', v)}
          onDropdownVisibleChange={(open) => {
            if (open && !(locationOptions[record.key] || []).length) {
              const warehouseId = form.getFieldValue('warehouse_id');
              if (warehouseId) loadLocations(warehouseId, record.key);
            }
          }}
        />
      ),
    },
    {
      title: 'Line',
      width: 140,
      render: (_, record) => (
        <Select
          value={record.line_id}
          options={lineOptions[record.key] || []}
          placeholder="Line"
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: '100%' }}
          onChange={(v) => updateItem(record.key, 'line_id', v)}
          disabled={!record.location_id}
        />
      ),
    },
    {
      title: 'Rack',
      width: 140,
      render: (_, record) => (
        <Select
          value={record.rack_id}
          options={rackOptions[record.key] || []}
          placeholder="Rack"
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ width: '100%' }}
          onChange={(v) => updateItem(record.key, 'rack_id', v)}
          disabled={!record.line_id}
        />
      ),
    },
    {
      title: 'Bin',
      width: 150,
      render: (_, record) => (
        <Input
          value={record.suggested_bin_id || ''}
          placeholder="Enter bin..."
          style={{ width: '100%' }}
          onChange={(e) => updateItem(record.key, 'suggested_bin_id', e.target.value)}
        />
      ),
    },
    {
      title: '',
      width: 50,
      render: (_, record) => (
        <Button
          type="text"
          danger
          icon={<DeleteOutlined />}
          onClick={() => removeItem(record.key)}
          size="small"
        />
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Create Putaway" subtitle="Create a new putaway order to assign items to bin locations">
        <Space>
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/warehouse/putaway')}
          >
            Back
          </Button>
        </Space>
      </PageHeader>

      <Card style={{ marginBottom: 16 }}>
        <Form
          form={form}
          layout="vertical"
         
        >
          <Row gutter={24}>
            <Col xs={24} sm={12} md={8}>
              <Form.Item
                label="Putaway Type"
                required
              >
                <Select
                  value={putawayType}
                  onChange={handlePutawayTypeChange}
                  options={[
                    { label: 'GRN Based', value: 'grn_based' },
                    { label: 'Manual', value: 'manual' },
                  ]}
                />
              </Form.Item>
            </Col>
            {putawayType === 'grn_based' && (
              <Col xs={24} sm={12} md={8}>
                <Form.Item
                  name="grn_id"
                  label="GRN"
                  rules={[{ required: putawayType === 'grn_based', message: 'Please select a GRN' }]}
                >
                  <Select
                    options={grnList}
                    placeholder="Select GRN"
                    showSearch
                    optionFilterProp="label"
                    allowClear
                    onChange={handleGRNChange}
                  />
                </Form.Item>
              </Col>
            )}
            <Col xs={24} sm={12} md={8}>
              <Form.Item
                name="warehouse_id"
                label="Warehouse"
                rules={[{ required: true, message: 'Please select a warehouse' }]}
              >
                <Select
                  options={warehouses}
                  placeholder="Select warehouse"
                  showSearch
                  optionFilterProp="label"
                  onChange={handleWarehouseChange}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={24}>
            <Col xs={24} md={16}>
              <Form.Item name="remarks" label="Remarks">
                <Input.TextArea rows={2} placeholder="Any remarks..." />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      {/* Items Table */}
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Divider orientation="left" style={{ margin: 0 }}>
            <Space>
              <InboxOutlined />
              Items ({items.length})
            </Space>
          </Divider>
          {putawayType === 'manual' && (
            <Button
              type="dashed"
              icon={<PlusOutlined />}
              onClick={addItemRow}
            >
              Add Item
            </Button>
          )}
        </div>

        <Table
          dataSource={items}
          columns={itemColumns}
          rowKey="key"
          size="small"
          pagination={false}
          scroll={{ x: 1200 }}
          locale={{ emptyText: putawayType === 'grn_based' ? 'Select a GRN to load items' : 'Click "Add Item" to add items' }}
        />

        <div style={{ marginTop: 24 }}>
          <Space>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              onClick={handleSubmit}
              loading={submitting}
              size="large"
              disabled={items.length === 0}
            >
              Create Putaway
            </Button>
            <Button onClick={() => navigate('/warehouse/putaway')}>
              Cancel
            </Button>
          </Space>
        </div>
      </Card>
    </div>
  );
};

export default PutawayForm;
