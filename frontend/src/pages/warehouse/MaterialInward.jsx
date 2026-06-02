import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, Table,
  Popconfirm, message, Row, Col, DatePicker, Tag, Divider,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  CheckCircleOutlined, SearchOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const MaterialInward = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [viewMode, setViewMode] = useState(false);
  const [editingRecord, setEditingRecord] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Lookups
  const [warehouses, setWarehouses] = useState([]);
  const [vendors, setVendors] = useState([]);

  // Line items state
  const [items, setItems] = useState([]);
  const [itemMaster, setItemMaster] = useState([]);
  const [uoms, setUoms] = useState([]);

  // PO fetch
  const [poLoading, setPoLoading] = useState(false);
  const [poList, setPoList] = useState([]);
  const [fetchingPoList, setFetchingPoList] = useState(false);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterWarehouse, setFilterWarehouse] = useState(undefined);

  useEffect(() => {
    fetchWarehouses();
    fetchVendors();
    fetchItemMaster();
    fetchUOMs();
    fetchActivePOs();
  }, []);

  const fetchActivePOs = async () => {
    setFetchingPoList(true);
    try {
      const res = await api.get('/procurement/purchase-orders', {
        params: { page_size: 500, status: 'approved,partially_received' }
      });
      const data = res.data;
      const list = data.items || data.data || (Array.isArray(data) ? data : []);
      setPoList(list.map((po) => ({ label: po.po_number, value: po.po_number })));
    } catch { /* silent */ }
    finally { setFetchingPoList(false); }
  };

  const fetchWarehouses = async () => {
    try {
      const res = await api.get('/masters/warehouses', { params: { page_size: 500 } });
      const data = res.data;
      const list = data.items || data.data || (Array.isArray(data) ? data : []);
      setWarehouses(list.map((w) => ({ label: w.name, value: w.id })));
    } catch { /* silent */ }
  };

  const fetchVendors = async () => {
    try {
      const res = await api.get('/masters/vendors', { params: { page_size: 500 } });
      const data = res.data;
      const list = data.items || data.data || (Array.isArray(data) ? data : []);
      setVendors(list.map((v) => ({ label: `${v.vendor_code} - ${v.name}`, value: v.id })));
    } catch { /* silent */ }
  };

  const fetchItemMaster = async () => {
    try {
      const res = await api.get('/masters/items', { params: { page_size: 1000 } });
      const data = res.data;
      const list = data.items || data.data || (Array.isArray(data) ? data : []);
      setItemMaster(list.map((i) => ({
        label: `${i.item_code} - ${i.name}`,
        value: i.id,
        uom_id: i.primary_uom_id,
      })));
    } catch { /* silent */ }
  };

  const fetchUOMs = async () => {
    try {
      const res = await api.get('/masters/uom', { params: { page_size: 200 } });
      const data = res.data;
      const list = data.items || data.data || (Array.isArray(data) ? data : []);
      setUoms(list.map((u) => ({ label: `${u.name} (${u.abbreviation || ''})`, value: u.id })));
    } catch { /* silent */ }
  };

  const fetchInwards = useCallback(
    async (params) => {
      const queryParams = { ...params };
      if (filterStatus) queryParams.status = filterStatus;
      if (filterWarehouse) queryParams.warehouse_id = filterWarehouse;
      return await api.get('/warehouse/inwards', { params: queryParams });
    },
    [filterStatus, filterWarehouse, refreshKey]
  );

  const handleAdd = () => {
    setEditingRecord(null);
    setViewMode(false);
    form.resetFields();
    form.setFieldsValue({ received_date: dayjs() });
    setItems([{ key: Date.now(), item_id: null, item_name_manual: '', ordered_qty: 0, received_qty: 0, uom_id: null, uom_manual: '', remarks: '' }]);
    setDrawerOpen(true);
  };

  const handleView = async (record) => {
    setViewMode(true);
    setEditingRecord(record);
    form.setFieldsValue({
      ...record,
      received_date: record.received_date ? dayjs(record.received_date) : dayjs(),
    });
    setItems((record.items || []).map((it, idx) => ({ ...it, key: it.id || idx })));
    setDrawerOpen(true);
  };

  const handleFetchPO = async (poNumberArg) => {
    const poNumber = poNumberArg || form.getFieldValue('po_number');
    if (!poNumber) {
      message.warning('Enter or select a PO number first');
      return;
    }
    setPoLoading(true);
    try {
      const res = await api.get(`/warehouse/inwards/fetch-po/${poNumber}`);
      const po = res.data;
      form.setFieldsValue({
        po_id: po.po_id,
        vendor_id: po.vendor_id,
      });
      const poItems = (po.items || []).map((pi, idx) => ({
        key: Date.now() + idx,
        item_id: pi.item_id,
        item_code: pi.item_code,
        item_name: pi.item_name,
        item_name_manual: '',
        ordered_qty: pi.ordered_qty,
        received_qty: pi.pending_qty,
        uom_id: pi.uom_id,
        uom_name: pi.uom_name,
        uom_manual: '',
        remarks: '',
      }));
      setItems(poItems);
      message.success(`PO ${poNumber} loaded with ${poItems.length} item(s)`);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setPoLoading(false);
    }
  };

  const handleAddItem = () => {
    setItems((prev) => [...prev, {
      key: Date.now(),
      item_id: null,
      item_name_manual: '',
      ordered_qty: 0,
      received_qty: 0,
      uom_id: null,
      uom_manual: '',
      remarks: '',
    }]);
  };

  const handleRemoveItem = (key) => {
    setItems((prev) => prev.filter((i) => i.key !== key));
  };

  const handleItemFieldChange = (key, field, value) => {
    setItems((prev) => prev.map((i) => {
      if (i.key !== key) return i;
      const updated = { ...i, [field]: value };
      // Auto-fill UOM and name/code when item is selected
      if (field === 'item_id') {
        if (value) {
          const master = itemMaster.find((m) => String(m.value) === String(value));
          if (master) {
            if (master.uom_id) updated.uom_id = master.uom_id;
            const parts = master.label.split(' - ');
            updated.item_code = parts[0];
            updated.item_name = parts.slice(1).join(' - ');
          }
        } else {
          updated.item_code = '';
          updated.item_name = '';
        }
      }
      if (field === 'uom_id') {
        if (value) {
          const uomObj = uoms.find((u) => String(u.value) === String(value));
          if (uomObj) {
            updated.uom_name = uomObj.label;
          }
        } else {
          updated.uom_name = '';
        }
      }
      return updated;
    }));
  };

  const handleSubmit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const values = await form.validateFields();
      if (items.length === 0) {
        message.error('Add at least one item');
        return;
      }
      const validItems = items.filter((i) => i.item_id || i.item_name_manual);
      if (validItems.length === 0) {
        message.error('Each item must have either a linked item or a manual name');
        return;
      }
      const payload = {
        po_id: values.po_id || null,
        po_number: values.po_number || null,
        vendor_id: values.vendor_id || null,
        vendor_name_manual: values.vendor_name_manual || null,
        warehouse_id: values.warehouse_id,
        received_date: values.received_date ? values.received_date.toISOString() : new Date().toISOString(),
        vehicle_number: values.vehicle_number || null,
        driver_name: values.driver_name || null,
        remarks: values.remarks || null,
        items: validItems.map((i) => ({
          item_id: i.item_id || null,
          item_name_manual: i.item_name_manual || null,
          ordered_qty: i.ordered_qty || 0,
          received_qty: i.received_qty || 0,
          uom_id: i.uom_id || null,
          uom_manual: i.uom_manual || null,
          remarks: i.remarks || null,
        })),
      };
      await api.post('/warehouse/inwards', payload);
      message.success('Material Inward created successfully');
      setDrawerOpen(false);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) {
        message.error('Please fill all required fields');
        return;
      }
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleComplete = async (id) => {
    try {
      await api.post(`/warehouse/inwards/${id}/complete`);
      message.success('Material Inward marked as received');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const statusColor = (s) => {
    switch (s) {
      case 'draft': return 'default';
      case 'received': return 'green';
      case 'grn_created': return 'blue';
      case 'cancelled': return 'red';
      default: return 'default';
    }
  };

  const columns = [
    {
      title: 'Inward #',
      dataIndex: 'inward_number',
      key: 'inward_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a onClick={() => handleView(record)}>{text}</a>
      ),
    },
    {
      title: 'PO Number',
      dataIndex: 'po_number',
      key: 'po_number',
      width: 140,
      render: (v) => v || '-',
    },
    {
      title: 'Vendor',
      key: 'vendor',
      width: 200,
      ellipsis: true,
      render: (_, record) => record.vendor_name || record.vendor_name_manual || '-',
    },
    {
      title: 'Warehouse',
      dataIndex: 'warehouse_name',
      key: 'warehouse_name',
      width: 160,
      render: (v) => v || '-',
    },
    {
      title: 'Received Date',
      dataIndex: 'received_date',
      key: 'received_date',
      width: 140,
      render: (v) => v ? dayjs(v).format('DD-MMM-YYYY') : '-',
    },
    {
      title: 'Vehicle #',
      dataIndex: 'vehicle_number',
      key: 'vehicle_number',
      width: 130,
      render: (v) => v || '-',
    },
    {
      title: 'Items',
      key: 'item_count',
      width: 80,
      align: 'center',
      render: (_, record) => (record.items || []).length,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (v) => <Tag color={statusColor(v)}>{(v || 'draft').toUpperCase()}</Tag>,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleView(record)} />
          {record.status === 'draft' && (
            <Popconfirm
              title="Mark as received?"
              description="This will update the status to 'Received'."
              onConfirm={() => handleComplete(record.id)}
              okText="Confirm"
            >
              <Button type="link" size="small" icon={<CheckCircleOutlined />} style={{ color: '#52c41a' }} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 140 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Draft', value: 'draft' },
          { label: 'Received', value: 'received' },
          { label: 'GRN Created', value: 'grn_created' },
          { label: 'Cancelled', value: 'cancelled' },
        ]}
      />
      <Select
        placeholder="Warehouse"
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ width: 180 }}
        value={filterWarehouse}
        onChange={(v) => { setFilterWarehouse(v); setRefreshKey((k) => k + 1); }}
        options={warehouses}
      />
    </Space>
  );

  const itemColumns = [
    {
      title: 'Item',
      dataIndex: 'item_id',
      width: 240,
      render: (val, record) => {
        if (viewMode) {
          return (
            <span>
              {record.item_code && record.item_name
                ? `${record.item_code} - ${record.item_name}`
                : itemMaster.find((m) => String(m.value) === String(val))?.label || record.item_name_manual || '-'}
            </span>
          );
        }

        const options = [...itemMaster];
        if (record.item_id && !options.some((o) => String(o.value) === String(record.item_id))) {
          const label = record.item_code && record.item_name
            ? `${record.item_code} - ${record.item_name}`
            : record.item_name || `Item ID: ${record.item_id}`;
          options.push({
            label: label,
            value: record.item_id,
            uom_id: record.uom_id,
          });
        }

        return (
          <Select
            value={val}
            placeholder="Select item"
            allowClear
            showSearch
            optionFilterProp="label"
            options={options}
            style={{ width: '100%' }}
            onChange={(v) => handleItemFieldChange(record.key, 'item_id', v)}
          />
        );
      },
    },
    {
      title: 'Manual Name',
      dataIndex: 'item_name_manual',
      width: 160,
      render: (val, record) => viewMode ? (val || '-') : (
        <Input
          value={val}
          placeholder="If not in system"
          onChange={(e) => handleItemFieldChange(record.key, 'item_name_manual', e.target.value)}
        />
      ),
    },
    {
      title: 'Ordered Qty',
      dataIndex: 'ordered_qty',
      width: 110,
      render: (val, record) => viewMode ? (val ?? 0) : (
        <InputNumber
          value={val}
          min={0}
          style={{ width: '100%' }}
          onChange={(v) => handleItemFieldChange(record.key, 'ordered_qty', v)}
        />
      ),
    },
    {
      title: 'Received Qty',
      dataIndex: 'received_qty',
      width: 110,
      render: (val, record) => viewMode ? (val ?? 0) : (
        <InputNumber
          value={val}
          min={0}
          style={{ width: '100%' }}
          onChange={(v) => handleItemFieldChange(record.key, 'received_qty', v)}
        />
      ),
    },
    {
      title: 'UOM',
      dataIndex: 'uom_id',
      width: 140,
      render: (val, record) => {
        if (viewMode) {
          return (
            <span>
              {record.uom_name || uoms.find((u) => String(u.value) === String(val))?.label || record.uom_manual || '-'}
            </span>
          );
        }

        const options = [...uoms];
        if (record.uom_id && !options.some((o) => String(o.value) === String(record.uom_id))) {
          options.push({
            label: record.uom_name || `UOM ID: ${record.uom_id}`,
            value: record.uom_id,
          });
        }

        return (
          <Select
            value={val}
            placeholder="UOM"
            allowClear
            showSearch
            optionFilterProp="label"
            options={options}
            style={{ width: '100%' }}
            onChange={(v) => handleItemFieldChange(record.key, 'uom_id', v)}
          />
        );
      },
    },
    {
      title: 'Remarks',
      dataIndex: 'remarks',
      width: 150,
      render: (val, record) => viewMode ? (val || '-') : (
        <Input
          value={val}
          placeholder="Remarks"
          onChange={(e) => handleItemFieldChange(record.key, 'remarks', e.target.value)}
        />
      ),
    },
  ];

  if (!viewMode) {
    itemColumns.push({
      title: '',
      width: 50,
      render: (_, record) => (
        <Button type="link" size="small" danger icon={<DeleteOutlined />} onClick={() => handleRemoveItem(record.key)} />
      ),
    });
  }

  return (
    <div>
      <PageHeader title="Material Inward" subtitle="Record incoming materials at the warehouse">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          New Inward
        </Button>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchInwards}
        rowKey="id"
        searchPlaceholder="Search by inward number, PO number..."
        toolbar={toolbar}
        scroll={{ x: 1200 }}
      />

      <Drawer
        title={viewMode ? `Inward: ${editingRecord?.inward_number || ''}` : 'New Material Inward'}
        width={900}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setEditingRecord(null); setViewMode(false); form.resetFields(); setItems([]); }}
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); setEditingRecord(null); setViewMode(false); form.resetFields(); setItems([]); }}>
              {viewMode ? 'Close' : 'Cancel'}
            </Button>
            {!viewMode && (
              <Button type="primary" onClick={handleSubmit} loading={submitting}>
                Create
              </Button>
            )}
          </Space>
        }
      >
        <Form form={form} layout="vertical" disabled={viewMode}>
          <Divider orientation="left">PO Reference (Optional)</Divider>
          <Row gutter={16}>
            <Col span={10}>
              <Form.Item name="po_number" label="PO Number">
                {viewMode ? (
                  <Input placeholder="PO number" />
                ) : (
                  <Select
                    showSearch
                    placeholder="Select PO to auto-fill"
                    options={poList}
                    loading={fetchingPoList}
                    onFocus={fetchActivePOs}
                    onChange={(v) => {
                      form.setFieldsValue({ po_number: v });
                      handleFetchPO(v);
                    }}
                    filterOption={(input, option) =>
                      (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                    }
                    allowClear
                  />
                )}
              </Form.Item>
            </Col>
            <Col span={4} style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 24 }}>
              {!viewMode && (
                <Button icon={<SearchOutlined />} onClick={() => handleFetchPO()} loading={poLoading}>
                  Fetch
                </Button>
              )}
            </Col>
            <Col span={10}>
              <Form.Item name="po_id" hidden><Input /></Form.Item>
            </Col>
          </Row>

          <Divider orientation="left">Inward Details</Divider>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="warehouse_id" label="Warehouse" rules={[{ required: true, message: 'Select warehouse' }]}>
                <Select placeholder="Select warehouse" options={warehouses} showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="vendor_id" label="Vendor">
                <Select placeholder="Select vendor" options={vendors} allowClear showSearch optionFilterProp="label" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="received_date" label="Received Date" rules={[{ required: true, message: 'Select date' }]}>
                <DatePicker style={{ width: '100%' }} format="DD-MMM-YYYY" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="vehicle_number" label="Vehicle Number">
                <Input placeholder="e.g. MH-12-AB-1234" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="driver_name" label="Driver Name">
                <Input placeholder="Driver name" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="vendor_name_manual" label="Vendor Name (Manual)">
                <Input placeholder="If vendor not in system" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="remarks" label="Remarks">
                <Input.TextArea rows={2} placeholder="Any remarks" />
              </Form.Item>
            </Col>
          </Row>
        </Form>

        <Divider orientation="left">Items</Divider>
        {!viewMode && (
          <div style={{ marginBottom: 12 }}>
            <Button type="dashed" icon={<PlusOutlined />} onClick={handleAddItem}>
              Add Item
            </Button>
          </div>
        )}
        <Table
          dataSource={items}
          columns={itemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 900 }}
          locale={{ emptyText: 'No items added yet' }}
        />
      </Drawer>
    </div>
  );
};

export default MaterialInward;
