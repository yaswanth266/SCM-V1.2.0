import React, { useState, useEffect } from 'react';
import {
  Card, Descriptions, Tabs, Table, Spin, Tag, Space, Button, message, Row, Col, Empty,
} from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import BarcodeDisplay from '../../components/BarcodeDisplay';
import api from '../../config/api';
import {
  formatCurrency, formatDate, formatDateTime, formatNumber, getErrorMessage,
} from '../../utils/helpers';
import { BARCODE_TYPES } from '../../utils/constants';

const ItemDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stockData, setStockData] = useState([]);
  const [stockLoading, setStockLoading] = useState(false);
  const [vendors, setVendors] = useState([]);
  const [vendorsLoading, setVendorsLoading] = useState(false);
  const [priceHistory, setPriceHistory] = useState([]);
  const [priceLoading, setPriceLoading] = useState(false);
  const [packing, setPacking] = useState([]);
  const [packingLoading, setPackingLoading] = useState(false);
  const [transactions, setTransactions] = useState([]);
  const [transLoading, setTransLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('stock');

  const fetchItem = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/masters/items/${id}`);
      setItem(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/masters/items');
    } finally {
      setLoading(false);
    }
  };

  const [categoryAttributes, setCategoryAttributes] = useState([]);
  const [attrValues, setAttrValues] = useState({});
  const [categorySpecs, setCategorySpecs] = useState([]);
  const [specValues, setSpecValues] = useState({});
  const [uoms, setUoms] = useState([]);

  const loadItemAttributesAndSpecs = async (itemId, categoryId) => {
    if (!categoryId) return;
    try {
      const [attrDefRes, specDefRes, attrValRes, specValRes] = await Promise.all([
        api.get('/masters/item-attributes', { params: { category_id: categoryId } }),
        api.get('/masters/item-specs', { params: { item_category_id: categoryId } }),
        api.get(`/masters/items/${itemId}/attribute-values`),
        api.get(`/masters/items/${itemId}/spec-values`),
      ]);
      setCategoryAttributes(attrDefRes.data || []);
      setCategorySpecs(specDefRes.data || []);
      const aMap = {};
      (attrValRes.data || []).forEach(v => { aMap[v.attribute_id] = v; });
      setAttrValues(aMap);
      const sMap = {};
      (specValRes.data || []).forEach(v => { sMap[v.spec_id] = v; });
      setSpecValues(sMap);
    } catch (err) {
      console.error('Failed to load attributes/specs:', err);
    }
  };

  const fetchUOMs = async () => {
    try {
      const res = await api.get('/masters/uom', { params: { page_size: 200 } });
      const data = res.data;
      setUoms(data.items || data.data || data || []);
    } catch {}
  };

  useEffect(() => {
    if (id) {
      fetchItem();
      fetchUOMs();
    }
  }, [id]);

  useEffect(() => {
    if (item) {
      const catId = item.category_id || item.category?.id;
      if (catId) loadItemAttributesAndSpecs(item.id, catId);

      if (activeTab === 'stock') fetchStock();
      else if (activeTab === 'vendors') fetchVendors();
      else if (activeTab === 'price_history') fetchPriceHistory();
      else if (activeTab === 'packing') fetchPacking();
      else if (activeTab === 'transactions') fetchTransactions();
    }
  }, [activeTab, item]);

  const fetchStock = async () => {
    setStockLoading(true);
    try {
      const res = await api.get(`/masters/items/${id}/stock`, { params: { page_size: 200 } });
      const data = res.data;
      setStockData(data.items || data.data || data || []);
    } catch {
      setStockData([]);
    } finally {
      setStockLoading(false);
    }
  };

  const fetchVendors = async () => {
    setVendorsLoading(true);
    try {
      const res = await api.get(`/masters/items/${id}/vendors`, { params: { page_size: 200 } });
      const data = res.data;
      setVendors(data.items || data.data || data || []);
    } catch {
      setVendors([]);
    } finally {
      setVendorsLoading(false);
    }
  };

  const fetchPriceHistory = async () => {
    setPriceLoading(true);
    try {
      const res = await api.get(`/masters/items/${id}/prices`, { params: { page_size: 200 } });
      const data = res.data;
      setPriceHistory(data.items || data.data || data || []);
    } catch {
      setPriceHistory([]);
    } finally {
      setPriceLoading(false);
    }
  };

  const fetchPacking = async () => {
    setPackingLoading(true);
    try {
      const res = await api.get(`/masters/items/${id}/packing`, { params: { page_size: 200 } });
      const data = res.data;
      setPacking(data.items || data.data || data || []);
    } catch {
      setPacking([]);
    } finally {
      setPackingLoading(false);
    }
  };

  const fetchTransactions = async () => {
    setTransLoading(true);
    try {
      const res = await api.get(`/masters/items/${id}/transactions`, { params: { page_size: 100 } });
      const data = res.data;
      setTransactions(data.items || data.data || data || []);
    } catch {
      setTransactions([]);
    } finally {
      setTransLoading(false);
    }
  };

  const stockColumns = [
    { title: 'Warehouse', dataIndex: ['warehouse', 'name'], key: 'warehouse', render: (t, r) => t || r.warehouse_name || '-' },
    { title: 'Location', dataIndex: ['location', 'name'], key: 'location', render: (t, r) => t || r.location_name || r.bin_code || '-' },
    { title: 'Batch', dataIndex: 'batch_number', key: 'batch', render: (v) => v || '-' },
    { title: 'Quantity', dataIndex: 'quantity', key: 'qty', align: 'right', render: (v) => formatNumber(v) },
    { title: 'Reserved', dataIndex: 'reserved_qty', key: 'reserved', align: 'right', render: (v) => formatNumber(v) },
    { title: 'Available', dataIndex: 'available_qty', key: 'available', align: 'right', render: (v) => formatNumber(v) },
    { title: 'Valuation', dataIndex: 'valuation_amount', key: 'val', align: 'right', render: (v) => formatCurrency(v) },
  ];

  const vendorColumns = [
    { title: 'Vendor Code', dataIndex: ['vendor', 'vendor_code'], key: 'code', render: (t, r) => t || r.vendor_code || '-' },
    { title: 'Vendor Name', dataIndex: ['vendor', 'name'], key: 'name', render: (t, r) => t || r.vendor_name || '-' },
    { title: 'Lead Time (Days)', dataIndex: 'lead_time_days', key: 'lead', align: 'right' },
    { title: 'Last Price', dataIndex: 'last_price', key: 'price', align: 'right', render: (v) => formatCurrency(v) },
    { title: 'Last Supplied', dataIndex: 'last_supplied_date', key: 'date', render: (v) => formatDate(v) },
    { title: 'Preferred', dataIndex: 'is_preferred', key: 'pref', render: (v) => v ? <Tag color="green">Yes</Tag> : <Tag>No</Tag> },
  ];

  const priceColumns = [
    { title: 'Price List', dataIndex: ['price_list', 'name'], key: 'pl', render: (t, r) => t || r.price_list_name || '-' },
    { title: 'Type', dataIndex: 'type', key: 'type', render: (v) => v || '-' },
    { title: 'Rate', dataIndex: 'rate', key: 'rate', align: 'right', render: (v) => formatCurrency(v) },
    { title: 'Min Qty', dataIndex: 'min_qty', key: 'min', align: 'right', render: (v) => v ?? '-' },
    { title: 'Valid From', dataIndex: 'valid_from', key: 'from', render: (v) => formatDate(v) },
    { title: 'Valid To', dataIndex: 'valid_to', key: 'to', render: (v) => formatDate(v) },
  ];

  const packingColumns = [
    { title: 'Level', dataIndex: 'level_name', key: 'type', render: (v, r) => v || r.packing_type || '-' },
    { title: 'SKU', dataIndex: 'sku_code', key: 'sku', render: (v) => v || '-' },
    { title: 'Packs In Parent', dataIndex: 'quantity_in_parent', key: 'parent_qty', align: 'right', render: (v) => v ?? 'Root' },
    { title: 'Primary Units', dataIndex: 'total_base_qty', key: 'base_qty', align: 'right', render: (v) => formatNumber(v) },
    { title: 'Gross Weight', dataIndex: 'gross_weight', key: 'wt', align: 'right', render: (v, r) => v != null ? `${formatNumber(v)} ${r.weight_uom || ''}` : '-' },
    { title: 'Dimensions', key: 'dim', render: (_, r) => r.length && r.width && r.height ? `${r.length}x${r.width}x${r.height}` : '-' },
    { title: 'GTIN', dataIndex: 'barcode_gtin', key: 'gtin', render: (v, r) => v || r.barcode || '-' },
    { title: 'SSCC', dataIndex: 'barcode_sscc', key: 'sscc', render: (v) => v || '-' },
  ];

  const transColumns = [
    { title: 'Date', dataIndex: 'posting_date', key: 'date', render: (v) => formatDateTime(v) || formatDate(v) },
    { title: 'Voucher Type', dataIndex: 'voucher_type', key: 'vtype' },
    { title: 'Voucher No', dataIndex: 'voucher_no', key: 'vno' },
    { title: 'Warehouse', dataIndex: ['warehouse', 'name'], key: 'wh', render: (t, r) => t || r.warehouse_name || '-' },
    { title: 'Qty Change', dataIndex: 'qty_change', key: 'qc', align: 'right', render: (v) => {
      if (v == null) return '-';
      return <span style={{ color: v >= 0 ? '#52c41a' : '#f5222d' }}>{v >= 0 ? '+' : ''}{formatNumber(v)}</span>;
    }},
    { title: 'Balance Qty', dataIndex: 'balance_qty', key: 'bal', align: 'right', render: (v) => formatNumber(v) },
    { title: 'Rate', dataIndex: 'rate', key: 'rate', align: 'right', render: (v) => formatCurrency(v) },
  ];
  const attributeColumns = [
    { title: 'Attribute', dataIndex: 'name', key: 'name' },
    { title: 'Value', key: 'value', render: (_, r) => {
      const v = attrValues[r.id];
      if (!v) return '-';
      const uom = uoms.find(u => u.id === v.uom_id);
      return `${v.value || ''} ${uom ? (uom.abbreviation || uom.name) : ''}`.trim() || '-';
    }},
  ];

  const specColumns = [
    { title: 'Spec', dataIndex: 'spec_name', key: 'name' },
    { title: 'Value', key: 'value', render: (_, r) => {
      const v = specValues[r.spec_id];
      if (!v) return '-';
      const uom = uoms.find(u => u.id === (v.uom_id || r.uom_id || r.spec_uom_id));
      const uomStr = uom ? (uom.abbreviation || uom.name) : '';
      if (r.spec_data_type === 'range') {
        if (!v.min_value && !v.max_value) return '-';
        return `${v.min_value || '0'} - ${v.max_value || '∞'} ${uomStr}`.trim();
      }
      return `${v.value || ''} ${uomStr}`.trim() || '-';
    }},
  ];

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!item) {
    return (
      <div>
        <PageHeader title="Item Not Found" />
        <Empty description="The requested item was not found." />
      </div>
    );
  }

   const itemTypeName = item.item_type ? item.item_type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '-';
   const barcodeTypeName = BARCODE_TYPES.find((b) => b.value === item.barcode_type)?.label || item.barcode_type || '-';

  const barcodeFormat = (() => {
    const bt = (item.barcode_type || '').toUpperCase();
    if (bt === 'QRCODE' || bt === 'QR') return 'QR';
    if (bt === 'BARCODE_128' || bt === 'CODE128') return 'CODE128';
    if (bt === 'BARCODE_EAN13' || bt === 'EAN13') return 'EAN13';
    return 'CODE128';
  })();

  return (
    <div>
      <PageHeader title={`${item.item_code} - ${item.name}`} subtitle={itemTypeName}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/masters/items')}>
            Back to Items
          </Button>
        </Space>
      </PageHeader>

      <Card style={{ marginBottom: 16 }}>
        <Row gutter={24}>
          <Col xs={24} md={16}>
            <Descriptions title="Basic" column={{ xs: 1, sm: 2, md: 3 }} size="small" bordered style={{ marginBottom: 24 }}>
              <Descriptions.Item label="Item Code">{item.item_code}</Descriptions.Item>
              <Descriptions.Item label="Name">{item.name}</Descriptions.Item>
              <Descriptions.Item label="Type">{itemTypeName}</Descriptions.Item>
              <Descriptions.Item label="Category">{item.category?.name || item.category_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Brand">{item.brand || '-'}</Descriptions.Item>
              <Descriptions.Item label="Manufacturer">{item.manufacturer || '-'}</Descriptions.Item>
              <Descriptions.Item label="Dosage Form">{item.dosage_form || '-'}</Descriptions.Item>
              <Descriptions.Item label="Status"><StatusTag status={item.status || (item.is_active === false ? 'inactive' : 'active')} /></Descriptions.Item>
            </Descriptions>

            <Descriptions title="Units & Identification" column={{ xs: 1, sm: 2, md: 3 }} size="small" bordered style={{ marginBottom: 24 }}>
              <Descriptions.Item label="Primary UOM">{item.primary_uom?.name || item.primary_uom_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="Conversion Factor">{item.conversion_factor || '-'}</Descriptions.Item>
              <Descriptions.Item label="Pack Size">{item.pack_size || '-'}</Descriptions.Item>
              <Descriptions.Item label="Barcode Type">{barcodeTypeName}</Descriptions.Item>
              <Descriptions.Item label="Barcode Value">{item.barcode_value || '-'}</Descriptions.Item>
              <Descriptions.Item label="HSN Code">{item.hsn_code || '-'}</Descriptions.Item>
            </Descriptions>

            <Descriptions title="Tracking & Stock" column={{ xs: 1, sm: 2, md: 3 }} size="small" bordered style={{ marginBottom: 24 }}>
              <Descriptions.Item label="Has Batch">{item.has_batch ? 'Yes' : 'No'}</Descriptions.Item>
              <Descriptions.Item label="Has Serial">{item.has_serial ? 'Yes' : 'No'}</Descriptions.Item>
              <Descriptions.Item label="Has Expiry">{item.has_expiry ? 'Yes' : 'No'}</Descriptions.Item>
              <Descriptions.Item label="Shelf Life">{item.shelf_life_days ? `${item.shelf_life_days} days` : '-'}</Descriptions.Item>
              <Descriptions.Item label="Safety Stock">{item.safety_stock ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="Reorder Level">{item.reorder_level ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="Minimum Stock">{item.minimum_stock ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="Maximum Stock">{item.maximum_stock ?? '-'}</Descriptions.Item>
            </Descriptions>

            <Descriptions title="Pricing & Compliance" column={{ xs: 1, sm: 2, md: 3 }} size="small" bordered>
              <Descriptions.Item label="Purchase Price">{formatCurrency(item.purchase_price)}</Descriptions.Item>
              <Descriptions.Item label="Selling Price">{formatCurrency(item.selling_price)}</Descriptions.Item>
              <Descriptions.Item label="MRP">{formatCurrency(item.mrp)}</Descriptions.Item>
              <Descriptions.Item label="Discount %">{item.discount_percent != null ? `${item.discount_percent}%` : '-'}</Descriptions.Item>
              <Descriptions.Item label="Valuation Method">{item.valuation_method ? item.valuation_method.toUpperCase() : '-'}</Descriptions.Item>
              <Descriptions.Item label="GST Rate">{item.gst_rate != null ? `${item.gst_rate}%` : (item.tax_rate != null ? `${item.tax_rate}%` : '-')}</Descriptions.Item>
              <Descriptions.Item label="Controlled Substance">{item.is_controlled_substance ? 'Yes' : 'No'}</Descriptions.Item>
              <Descriptions.Item label="Schedule Type">{item.schedule_type || '-'}</Descriptions.Item>
            </Descriptions>

            {item.description && (
              <div style={{ marginTop: 24 }}>
                <strong>Description:</strong>
                <p style={{ marginTop: 4, color: 'rgba(0,0,0,0.65)' }}>{item.description}</p>
              </div>
            )}
          </Col>
          <Col xs={24} md={8} style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: 16 }}>
            <BarcodeDisplay
              // BUG-FE-020: model column is `barcode_value`; legacy alias
              // `barcode` is left as a fallback for older payloads.
              value={item.barcode_value || item.barcode || item.item_code}
              type={barcodeFormat}
              label={item.name}
              subtitle={item.item_code}
            />
          </Col>
        </Row>
      </Card>

      <Card>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'stock',
              label: 'Stock',
              children: (
                <Table
                  columns={stockColumns}
                  dataSource={stockData}
                  loading={stockLoading}
                  rowKey={(r) => r.id || `${r.warehouse_id}-${r.batch_number || 'nb'}`}
                  pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t, r) => `${r[0]}-${r[1]} of ${t}` }}
                  scroll={{ x: 'max-content' }}
                  size="small"
                />
              ),
            },
            {
              key: 'vendors',
              label: 'Vendors',
              children: (
                <Table
                  columns={vendorColumns}
                  dataSource={vendors}
                  loading={vendorsLoading}
                  rowKey={(r) => r.id || r.vendor_id}
                  pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t, r) => `${r[0]}-${r[1]} of ${t}` }}
                  scroll={{ x: 'max-content' }}
                  size="small"
                />
              ),
            },
            {
              key: 'price_history',
              label: 'Price History',
              children: (
                <Table
                  columns={priceColumns}
                  dataSource={priceHistory}
                  loading={priceLoading}
                  rowKey={(r) => r.id || `${r.price_list_id}-${r.valid_from}`}
                  pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t, r) => `${r[0]}-${r[1]} of ${t}` }}
                  scroll={{ x: 'max-content' }}
                  size="small"
                />
              ),
            },
            {
              key: 'packing',
              label: 'Packing',
              children: (
                <Table
                  columns={packingColumns}
                  dataSource={packing}
                  loading={packingLoading}
                  rowKey={(r) => r.id || r.packing_type}
                  pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t, r) => `${r[0]}-${r[1]} of ${t}` }}
                  scroll={{ x: 'max-content' }}
                  size="small"
                />
              ),
            },
            {
              key: 'transactions',
              label: 'Transactions',
              children: (
                <Table
                  columns={transColumns}
                  dataSource={transactions}
                  loading={transLoading}
                  rowKey={(r) => r.id || `${r.voucher_no}-${r.posting_date}`}
                  pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t, r) => `${r[0]}-${r[1]} of ${t}` }}
                  scroll={{ x: 'max-content' }}
                  size="small"
                />
              ),
            },
            {
              key: 'attributes',
              label: 'Attributes',
              children: (
                <Table
                  columns={attributeColumns}
                  dataSource={categoryAttributes}
                  rowKey="id"
                  pagination={false}
                  scroll={{ x: 'max-content' }}
                  size="small"
                />
              ),
            },
            {
              key: 'specs',
              label: 'Specs',
              children: (
                <Table
                  columns={specColumns}
                  dataSource={categorySpecs}
                  rowKey="id"
                  pagination={false}
                  scroll={{ x: 'max-content' }}
                  size="small"
                />
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
};

export default ItemDetail;
