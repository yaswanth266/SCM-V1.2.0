import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, message, Row, Col, Table, Card, Descriptions, Tabs,
  Divider, Typography, Tooltip, Tag, Empty, Spin, Rate, Modal,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  ArrowLeftOutlined, CheckOutlined, CloseOutlined,
  SwapOutlined, MinusCircleOutlined, StarOutlined,
  TrophyOutlined, ShoppingCartOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import ItemSelector from '../../components/ItemSelector';
import api from '../../config/api';
import {
  formatDate, formatCurrency, getErrorMessage, formatDateForAPI,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text, Title } = Typography;

const Quotations = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingQuotation, setEditingQuotation] = useState(null);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterVendor, setFilterVendor] = useState(undefined);

  // Detail view
  const [detailQuotation, setDetailQuotation] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Comparison view
  const [compareMode, setCompareMode] = useState(false);
  const [compareMR, setCompareMR] = useState(null);
  const [compareQuotations, setCompareQuotations] = useState([]);
  const [compareLoading, setCompareLoading] = useState(false);
  const [mrList, setMrList] = useState([]);
  const [mrSearchLoading, setMrSearchLoading] = useState(false);

  // Drawer data
  const [vendors, setVendors] = useState([]);
  const [mrOptions, setMrOptions] = useState([]);
  const [quotationItems, setQuotationItems] = useState([]);

  // Lookup
  const loadVendors = useCallback(async (search = '') => {
    try {
      const res = await api.get('/masters/vendors', {
        params: { page_size: 100, search, status: 'active' },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setVendors(items.map((v) => ({
        label: `[${v.vendor_code}] ${v.name}`,
        value: v.id,
        vendor: v,
      })));
    } catch {
      // silent
    }
  }, []);

  const loadMROptions = useCallback(async (search = '') => {
    try {
      const res = await api.get('/procurement/material-requests', {
        params: { page_size: 50, search, status: 'approved' },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setMrOptions(items.map((mr) => ({
        label: `${mr.mr_number} - ${mr.department_name || mr.request_type || ''}`,
        value: mr.id,
        mr,
      })));
    } catch {
      // silent
    }
  }, []);

  const fetchQuotations = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterVendor) qp.vendor_id = filterVendor;
      return await api.get('/procurement/quotations', { params: qp });
    },
    [filterStatus, filterVendor]
  );

  const handleAdd = () => {
    setEditingQuotation(null);
    form.resetFields();
    form.setFieldsValue({
      quotation_date: dayjs(),
      valid_until: dayjs().add(30, 'day'),
    });
    setQuotationItems([]);
    loadVendors();
    loadMROptions();
    setDrawerOpen(true);
  };

  const handleMRSelect = async (mrId) => {
    if (!mrId) {
      setQuotationItems([]);
      return;
    }
    try {
      const res = await api.get(`/procurement/material-requests/${mrId}`);
      const mrData = res.data;
      const items = (mrData.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_name: item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.item_name || item.item.name}` : ''),
        item_code: item.item_code || (item.item ? item.item.item_code : ''),
        qty: item.qty || item.quantity || 0,
        uom: item.uom || item.uom_name || item.unit || '',
        uom_id: item.uom_id || null,
        primary_uom_id: item.primary_uom_id || null,
        rate: 0,
        discount: 0,
        // BUG-PRO-145 fix: default to the item's tax_rate from the master if
        // available, else 0. Hard-coding 18 silently overrode every non-18%
        // item (medicines @ 12, books @ 0, luxury @ 28) every time.
        tax_percent: Number(item.tax_rate || 0),
        amount: 0,
      }));
      setQuotationItems(items);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleEdit = async (record) => {
    setEditingQuotation(record);
    loadVendors();
    loadMROptions();
    try {
      const res = await api.get(`/procurement/quotations/${record.id}`);
      const data = res.data;
      form.setFieldsValue({
        ...data,
        quotation_date: data.quotation_date ? dayjs(data.quotation_date) : null,
        valid_until: data.valid_until ? dayjs(data.valid_until) : null,
      });
      const items = (data.items || []).map((item, idx) => ({
        key: item.id || Date.now() + idx,
        item_id: item.item_id,
        item_name: item.item_name || '',
        item_code: item.item_code || '',
        qty: item.qty || item.quantity || 0,
        uom: item.uom || item.uom_name || '',
        uom_id: item.uom_id || null,
        rate: item.rate || item.unit_price || 0,
        discount: item.discount || item.discount_pct || item.discount_percent || 0,
        tax_percent: item.tax_percent || item.tax_rate || 18,
        amount: item.amount || item.total || 0,
      }));
      setQuotationItems(items.length > 0 ? items : []);
    } catch (err) {
      message.error(getErrorMessage(err));
      return;
    }
    setDrawerOpen(true);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/procurement/quotations/${id}`);
      message.success('Quotation deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const calcItemAmount = (item) => {
    const base = (item.qty || 0) * (item.rate || 0);
    const discounted = base - (base * (item.discount || 0)) / 100;
    const tax = (discounted * (item.tax_percent || 0)) / 100;
    return Number((discounted + tax).toFixed(2));
  };

  const calcSubtotal = () => {
    return quotationItems.reduce((sum, item) => {
      const base = (item.qty || 0) * (item.rate || 0);
      return sum + base - (base * (item.discount || 0)) / 100;
    }, 0);
  };

  const calcTaxTotal = () => {
    return quotationItems.reduce((sum, item) => {
      const base = (item.qty || 0) * (item.rate || 0);
      const discounted = base - (base * (item.discount || 0)) / 100;
      return sum + (discounted * (item.tax_percent || 0)) / 100;
    }, 0);
  };

  const calcGrandTotal = () => calcSubtotal() + calcTaxTotal();

  const updateQuotationItem = (key, field, value) => {
    setQuotationItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        const updated = { ...item, [field]: value };
        updated.amount = calcItemAmount(updated);
        return updated;
      })
    );
  };

  const addQuotationItemRow = () => {
    setQuotationItems((prev) => [
      ...prev,
      // BUG-PRO-145 fix: tax_percent default 0 — populated from item master on selection.
      { key: Date.now(), item_id: null, item_name: '', qty: 1, uom: '', rate: 0, discount: 0, tax_percent: 0, amount: 0 },
    ]);
  };

  const removeQuotationItemRow = (key) => {
    setQuotationItems((prev) => prev.filter((i) => i.key !== key));
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      // BUG-PRO-146 fix: a 100% discount on a >0 rate produces an effective
      // amount of 0 — that's a giveaway, not a quotation, and the backend
      // doesn't reject it. Treat such rows as invalid here.
      const validItems = quotationItems.filter(
        (i) => i.item_id && Number(i.rate) > 0 && Number(i.discount || 0) < 100
      );
      if (validItems.length === 0) {
        message.error('Please add at least one item with a rate (and discount < 100%)');
        return;
      }
      setSubmitting(true);

      const payload = {
        ...values,
        quotation_date: formatDateForAPI(values.quotation_date),
        valid_until: formatDateForAPI(values.valid_until),
        total_amount: Number(calcSubtotal().toFixed(2)),
        tax_amount: Number(calcTaxTotal().toFixed(2)),
        grand_total: Number(calcGrandTotal().toFixed(2)),
        items: validItems.map((item) => ({
          item_id: item.item_id,
          qty: item.qty,
          uom_id: item.uom_id || item.primary_uom_id || 1,
          rate: item.rate,
          discount_pct: item.discount || item.discount_pct || 0,
          tax_rate: item.tax_percent || item.tax_rate || 0,
          // BUG-PRO-144 fix: include the per-item computed amount so reports
          // and exports don't see a 0 amount on freshly-created quotations.
          // Backend already recomputes this via calculate_line_amount, but
          // sending it ensures the FE/BE views agree.
          amount: Number(((Number(item.qty) || 0) * (Number(item.rate) || 0) - ((Number(item.qty) || 0) * (Number(item.rate) || 0) * (Number(item.discount || 0))) / 100).toFixed(2)),
        })),
      };

      if (editingQuotation) {
        await api.put(`/procurement/quotations/${editingQuotation.id}`, payload);
        message.success('Quotation updated');
      } else {
        await api.post('/procurement/quotations', payload);
        message.success('Quotation created');
      }
      setDrawerOpen(false);
      form.resetFields();
      setEditingQuotation(null);
      setQuotationItems([]);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAccept = async (id) => {
    try {
      await api.put(`/procurement/quotations/${id}/accept`);
      message.success('Quotation accepted');
      setRefreshKey((k) => k + 1);
      if (detailQuotation && detailQuotation.id === id) {
        setDetailQuotation((prev) => ({ ...prev, status: 'accepted' }));
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleReject = async (id) => {
    try {
      await api.put(`/procurement/quotations/${id}/reject`);
      message.success('Quotation rejected');
      setRefreshKey((k) => k + 1);
      if (detailQuotation && detailQuotation.id === id) {
        setDetailQuotation((prev) => ({ ...prev, status: 'rejected' }));
      }
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // Detail view
  const handleViewQuotation = async (record) => {
    setDetailLoading(true);
    setDetailQuotation(null);
    try {
      const res = await api.get(`/procurement/quotations/${record.id}`);
      setDetailQuotation(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  };

  // --- COMPARISON VIEW ---
  const openCompareMode = async () => {
    setCompareMode(true);
    setCompareMR(null);
    setCompareQuotations([]);
    try {
      const res = await api.get('/procurement/material-requests', {
        params: { page_size: 100, status: 'approved' },
      });
      const data = res.data;
      setMrList((data.items || data.data || data || []).map((mr) => ({
        label: `${mr.mr_number} - ${mr.department_name || mr.request_type || ''}`,
        value: mr.id,
        mr,
      })));
    } catch {
      // silent
    }
  };

  const loadComparisonData = async (mrId) => {
    if (!mrId) {
      setCompareMR(null);
      setCompareQuotations([]);
      return;
    }
    setCompareLoading(true);
    try {
      const [mrRes, quotRes] = await Promise.all([
        api.get(`/procurement/material-requests/${mrId}`),
        api.get('/procurement/quotations', { params: { mr_id: mrId, page_size: 100 } }),
      ]);
      setCompareMR(mrRes.data);
      const quots = quotRes.data.items || quotRes.data.data || quotRes.data || [];
      // For each quotation, fetch details if items are not included
      const enriched = await Promise.all(
        quots.map(async (q) => {
          if (q.items && q.items.length > 0) return q;
          try {
            const detRes = await api.get(`/procurement/quotations/${q.id}`);
            return detRes.data;
          } catch {
            return q;
          }
        })
      );
      setCompareQuotations(enriched);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setCompareLoading(false);
    }
  };

  const createPOFromQuotation = async (quotation) => {
    try {
      await api.post('/procurement/purchase-orders/from-quotation', {
        quotation_id: quotation.id,
      });
      message.success(`PO created from quotation ${quotation.quotation_number}`);
      setCompareMode(false);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // Build comparison table data
  const buildComparisonData = () => {
    if (!compareMR || compareQuotations.length === 0) return [];
    const mrItems = compareMR.items || [];

    return mrItems.map((mrItem) => {
      const row = {
        key: mrItem.item_id || mrItem.id,
        item_name: mrItem.item_name || (mrItem.item ? (mrItem.item.item_name || mrItem.item.name) : '-'),
        item_code: mrItem.item_code || (mrItem.item ? mrItem.item.item_code : ''),
        qty: mrItem.qty || mrItem.quantity || 0,
        uom: mrItem.uom || mrItem.unit || '',
      };

      // Find rate for each vendor quotation
      let minRate = Infinity;
      compareQuotations.forEach((q) => {
        const qItem = (q.items || []).find(
          (qi) => qi.item_id === mrItem.item_id
        );
        const rate = qItem ? (qItem.rate || qItem.unit_price || 0) : null;
        row[`vendor_${q.id}_rate`] = rate;
        row[`vendor_${q.id}_delivery`] = q.delivery_days || q.lead_time || '-';
        if (rate !== null && rate < minRate) minRate = rate;
      });
      row._minRate = minRate === Infinity ? null : minRate;

      return row;
    });
  };

  const comparisonColumns = () => {
    const cols = [
      { title: 'Item Code', dataIndex: 'item_code', key: 'code', width: 120, fixed: 'left' },
      { title: 'Item Name', dataIndex: 'item_name', key: 'name', width: 200, fixed: 'left' },
      { title: 'Qty', dataIndex: 'qty', key: 'qty', width: 70, align: 'right' },
      { title: 'UOM', dataIndex: 'uom', key: 'uom', width: 70 },
    ];

    compareQuotations.forEach((q) => {
      cols.push({
        title: (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 600 }}>{q.vendor_name || q.vendor || `Vendor ${q.vendor_id}`}</div>
            <div style={{ fontSize: 11, color: '#888' }}>{q.quotation_number}</div>
            {q.vendor_rating !== undefined && q.vendor_rating !== null && (
              <Rate disabled value={q.vendor_rating || 0} style={{ fontSize: 11 }} />
            )}
          </div>
        ),
        children: [
          {
            title: 'Rate',
            dataIndex: `vendor_${q.id}_rate`,
            key: `vendor_${q.id}_rate`,
            width: 120,
            align: 'right',
            render: (val, record) => {
              if (val === null || val === undefined) return <Text type="secondary">N/A</Text>;
              const isLowest = val === record._minRate && record._minRate > 0;
              return (
                <Text
                  strong={isLowest}
                  style={isLowest ? { color: '#52c41a', background: '#f6ffed', padding: '2px 6px', borderRadius: 4 } : {}}
                >
                  {formatCurrency(val)}
                  {isLowest && <TrophyOutlined style={{ marginLeft: 4, color: '#52c41a' }} />}
                </Text>
              );
            },
          },
          {
            title: 'Delivery',
            dataIndex: `vendor_${q.id}_delivery`,
            key: `vendor_${q.id}_delivery`,
            width: 90,
            align: 'center',
            render: (val) => (val && val !== '-' ? `${val} days` : '-'),
          },
        ],
      });
    });

    return cols;
  };

  // Quotation item drawer columns
  const quotItemColumns = [
    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
    {
      title: 'Item',
      dataIndex: 'item_id',
      width: 250,
      render: (val, record) => (
        record.item_name || (
          <ItemSelector
            value={val}
            onChange={(itemId, item) => {
              updateQuotationItem(record.key, 'item_id', itemId);
              if (item) {
                updateQuotationItem(record.key, 'item_name', item.item_name || item.name || '');
                updateQuotationItem(record.key, 'uom', item.uom || item.primary_uom_name || item.default_uom || '');
                updateQuotationItem(record.key, 'uom_id', item.primary_uom_id || item.uom_id || null);
              }
            }}
            style={{ width: '100%' }}
          />
        )
      ),
    },
    {
      title: 'Qty',
      dataIndex: 'qty',
      width: 80,
      render: (val, record) => (
        <InputNumber min={0.01} value={val} onChange={(v) => updateQuotationItem(record.key, 'qty', v)} style={{ width: '100%' }} />
      ),
    },
    {
      title: 'UOM',
      dataIndex: 'uom',
      width: 70,
      render: (val) => val || '-',
    },
    {
      title: 'Rate',
      dataIndex: 'rate',
      width: 110,
      render: (val, record) => (
        <InputNumber min={0} value={val} onChange={(v) => updateQuotationItem(record.key, 'rate', v)} style={{ width: '100%' }} prefix="₹" />
      ),
    },
    {
      title: 'Disc %',
      dataIndex: 'discount',
      width: 80,
      render: (val, record) => (
        <InputNumber min={0} max={100} value={val} onChange={(v) => updateQuotationItem(record.key, 'discount', v)} style={{ width: '100%' }} />
      ),
    },
    {
      title: 'Tax %',
      dataIndex: 'tax_percent',
      width: 80,
      render: (val, record) => (
        <InputNumber min={0} max={100} value={val} onChange={(v) => updateQuotationItem(record.key, 'tax_percent', v)} style={{ width: '100%' }} />
      ),
    },
    {
      title: 'Amount',
      dataIndex: 'amount',
      width: 110,
      align: 'right',
      render: (val) => formatCurrency(val),
    },
    {
      title: '',
      width: 40,
      render: (_, record) =>
        quotationItems.length > 1 ? (
          <MinusCircleOutlined style={{ color: '#ff4d4f', cursor: 'pointer' }} onClick={() => removeQuotationItemRow(record.key)} />
        ) : null,
    },
  ];

  const columns = [
    {
      title: 'Quotation No',
      dataIndex: 'quotation_number',
      key: 'quotation_number',
      width: 150,
      sorter: true,
      fixed: 'left',
      render: (text, record) => <a onClick={() => handleViewQuotation(record)}>{text}</a>,
    },
    {
      title: 'MR Ref',
      dataIndex: 'mr_number',
      key: 'mr',
      width: 130,
      render: (v, r) => v || r.mr_reference || '-',
    },
    {
      title: 'Vendor',
      dataIndex: 'vendor_name',
      key: 'vendor',
      width: 200,
      ellipsis: true,
      render: (v, r) => v || r.vendor || '-',
    },
    {
      title: 'Quotation Date',
      dataIndex: 'quotation_date',
      key: 'quotation_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Valid Until',
      dataIndex: 'valid_until',
      key: 'valid_until',
      width: 120,
      render: (v) => {
        if (!v) return '-';
        const isExpired = dayjs(v).isBefore(dayjs());
        return <Text type={isExpired ? 'danger' : undefined}>{formatDate(v)}</Text>;
      },
    },
    {
      title: 'Amount',
      dataIndex: 'total_amount',
      key: 'total_amount',
      width: 120,
      align: 'right',
      render: (v) => formatCurrency(v),
    },
    {
      title: 'Grand Total',
      dataIndex: 'grand_total',
      key: 'grand_total',
      width: 130,
      align: 'right',
      sorter: true,
      render: (v) => <Text strong>{formatCurrency(v)}</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => handleViewQuotation(record)} />
          {(record.status === 'draft' || record.status === 'pending') && (
            <>
              <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
              <Tooltip title="Accept">
                <Popconfirm title="Accept this quotation?" onConfirm={() => handleAccept(record.id)}>
                  <Button type="link" size="small" style={{ color: '#52c41a' }} icon={<CheckOutlined />} />
                </Popconfirm>
              </Tooltip>
              <Tooltip title="Reject">
                <Popconfirm title="Reject this quotation?" onConfirm={() => handleReject(record.id)} okButtonProps={{ danger: true }}>
                  <Button type="link" size="small" danger icon={<CloseOutlined />} />
                </Popconfirm>
              </Tooltip>
            </>
          )}
          {record.status === 'draft' && (
            <Popconfirm title="Delete this quotation?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
              <Button type="link" size="small" danger icon={<DeleteOutlined />} />
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
          // BUG-PRO-045 fix: backend enum is 'submitted', not 'pending'. The
          // old "Pending → pending" filter never matched any quotation.
          { label: 'Submitted', value: 'submitted' },
          { label: 'Accepted', value: 'accepted' },
          { label: 'Rejected', value: 'rejected' },
          { label: 'Expired', value: 'expired' },
        ]}
      />
    </Space>
  );

  // --- COMPARISON VIEW ---
  if (compareMode) {
    const compData = buildComparisonData();

    return (
      <div>
        <PageHeader title="Quotation Comparison" subtitle="Compare vendor quotations for a Material Request">
          <Button icon={<ArrowLeftOutlined />} onClick={() => setCompareMode(false)}>
            Back to Quotations
          </Button>
        </PageHeader>

        <Card style={{ marginBottom: 16 }}>
          <Row gutter={16} align="middle">
            <Col span={8}>
              <Text strong>Select Material Request:</Text>
              <Select
                style={{ width: '100%', marginTop: 8 }}
                placeholder="Select MR to compare quotations"
                options={mrList}
                showSearch
                optionFilterProp="label"
                onChange={(val) => loadComparisonData(val)}
                allowClear
              />
            </Col>
            {compareMR && (
              <Col span={16}>
                <Descriptions size="small" column={4}>
                  <Descriptions.Item label="MR Number">{compareMR.mr_number}</Descriptions.Item>
                  <Descriptions.Item label="Type">{compareMR.request_type}</Descriptions.Item>
                  <Descriptions.Item label="Required Date">{formatDate(compareMR.required_date)}</Descriptions.Item>
                  <Descriptions.Item label="Quotations Received">{compareQuotations.length}</Descriptions.Item>
                </Descriptions>
              </Col>
            )}
          </Row>
        </Card>

        {compareLoading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
            <Spin size="large" tip="Loading comparison data..." />
          </div>
        )}

        {!compareLoading && compareMR && compareQuotations.length === 0 && (
          <Card>
            <Empty description="No quotations found for this Material Request" />
          </Card>
        )}

        {!compareLoading && compareQuotations.length > 0 && (
          <>
            <Card style={{ marginBottom: 16 }}>
              <Table
                dataSource={compData}
                columns={comparisonColumns()}
                rowKey="key"
                pagination={false}
                size="small"
                scroll={{ x: 500 + compareQuotations.length * 220 }}
                bordered
              />
            </Card>

            <Card title="Vendor Summary">
              <Row gutter={16}>
                {compareQuotations.map((q) => {
                  const totalAmount = (q.items || []).reduce((sum, i) => sum + ((i.rate || i.unit_price || 0) * (i.qty || i.quantity || 0)), 0);
                  return (
                    <Col key={q.id} xs={24} sm={12} md={8} lg={6} style={{ marginBottom: 16 }}>
                      <Card
                        size="small"
                        hoverable
                        style={{ borderTop: '3px solid #eb2f96' }}
                        actions={[
                          <Popconfirm
                            key="select"
                            title={`Create PO from ${q.quotation_number}?`}
                            onConfirm={() => createPOFromQuotation(q)}
                          >
                            <Button type="link" icon={<ShoppingCartOutlined />}>Select Vendor</Button>
                          </Popconfirm>,
                        ]}
                      >
                        <div style={{ textAlign: 'center', marginBottom: 8 }}>
                          <Text strong style={{ fontSize: 14 }}>{q.vendor_name || q.vendor || 'Vendor'}</Text>
                        </div>
                        <div style={{ textAlign: 'center', marginBottom: 8 }}>
                          <Text type="secondary" style={{ fontSize: 12 }}>{q.quotation_number}</Text>
                        </div>
                        {(q.vendor_rating !== undefined && q.vendor_rating !== null) && (
                          <div style={{ textAlign: 'center', marginBottom: 8 }}>
                            <Rate disabled value={q.vendor_rating || 0} style={{ fontSize: 14 }} />
                          </div>
                        )}
                        <Descriptions size="small" column={1}>
                          <Descriptions.Item label="Grand Total">
                            <Text strong>{formatCurrency(q.grand_total || totalAmount)}</Text>
                          </Descriptions.Item>
                          <Descriptions.Item label="Delivery">
                            {q.delivery_days ? `${q.delivery_days} days` : '-'}
                          </Descriptions.Item>
                          <Descriptions.Item label="Payment Terms">
                            {q.payment_terms || '-'}
                          </Descriptions.Item>
                          <Descriptions.Item label="Valid Until">
                            {formatDate(q.valid_until)}
                          </Descriptions.Item>
                        </Descriptions>
                      </Card>
                    </Col>
                  );
                })}
              </Row>
            </Card>
          </>
        )}
      </div>
    );
  }

  // --- DETAIL VIEW ---
  if (detailLoading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}><Spin size="large" /></div>;
  }

  if (detailQuotation) {
    const qItems = detailQuotation.items || [];

    return (
      <div>
        <PageHeader title={detailQuotation.quotation_number} subtitle="Quotation Detail">
          <Space>
            {(detailQuotation.status === 'draft' || detailQuotation.status === 'pending') && (
              <>
                <Popconfirm title="Accept this quotation?" onConfirm={() => handleAccept(detailQuotation.id)}>
                  <Button type="primary" icon={<CheckOutlined />}>Accept</Button>
                </Popconfirm>
                <Popconfirm title="Reject this quotation?" onConfirm={() => handleReject(detailQuotation.id)} okButtonProps={{ danger: true }}>
                  <Button danger icon={<CloseOutlined />}>Reject</Button>
                </Popconfirm>
              </>
            )}
            <Button icon={<ArrowLeftOutlined />} onClick={() => setDetailQuotation(null)}>Back to List</Button>
          </Space>
        </PageHeader>

        <Card>
          <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
            <Descriptions.Item label="Quotation Number">{detailQuotation.quotation_number}</Descriptions.Item>
            <Descriptions.Item label="MR Reference">{detailQuotation.mr_number || detailQuotation.mr_reference || '-'}</Descriptions.Item>
            <Descriptions.Item label="Vendor">{detailQuotation.vendor_name || detailQuotation.vendor || '-'}</Descriptions.Item>
            <Descriptions.Item label="Quotation Date">{formatDate(detailQuotation.quotation_date)}</Descriptions.Item>
            <Descriptions.Item label="Valid Until">{formatDate(detailQuotation.valid_until)}</Descriptions.Item>
            <Descriptions.Item label="Delivery Days">{detailQuotation.delivery_days || '-'}</Descriptions.Item>
            <Descriptions.Item label="Payment Terms">{detailQuotation.payment_terms || '-'}</Descriptions.Item>
            <Descriptions.Item label="Status"><StatusTag status={detailQuotation.status} /></Descriptions.Item>
            <Descriptions.Item label="Grand Total"><Text strong>{formatCurrency(detailQuotation.grand_total)}</Text></Descriptions.Item>
            <Descriptions.Item label="Remarks" span={3}>{detailQuotation.remarks || '-'}</Descriptions.Item>
          </Descriptions>

          <Divider orientation="left">Items</Divider>
          <Table
            dataSource={qItems}
            rowKey={(r) => r.id || r.item_id}
            size="small"
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
              { title: 'Item Code', dataIndex: 'item_code', key: 'code', width: 120, render: (v, r) => v || (r.item && r.item.item_code) || '-' },
              { title: 'Item Name', dataIndex: 'item_name', key: 'name', width: 200, render: (v, r) => v || (r.item && (r.item.item_name || r.item.name)) || '-' },
              { title: 'Qty', dataIndex: 'qty', key: 'qty', width: 80, align: 'right', render: (v, r) => v || r.quantity || '-' },
              { title: 'UOM', dataIndex: 'uom', key: 'uom', width: 70 },
              { title: 'Rate', dataIndex: 'rate', key: 'rate', width: 110, align: 'right', render: (v, r) => formatCurrency(v || r.unit_price) },
              { title: 'Disc %', dataIndex: 'discount', key: 'disc', width: 80, align: 'right', render: (v) => `${v || 0}%` },
              { title: 'Tax %', dataIndex: 'tax_percent', key: 'tax', width: 80, align: 'right', render: (v) => `${v || 0}%` },
              { title: 'Amount', dataIndex: 'amount', key: 'amt', width: 120, align: 'right', render: (v, r) => formatCurrency(v || r.total) },
            ]}
            summary={() => (
              <Table.Summary>
                <Table.Summary.Row>
                  <Table.Summary.Cell colSpan={8} align="right"><Text strong>Grand Total:</Text></Table.Summary.Cell>
                  <Table.Summary.Cell align="right"><Text strong>{formatCurrency(detailQuotation.grand_total)}</Text></Table.Summary.Cell>
                </Table.Summary.Row>
              </Table.Summary>
            )}
          />
        </Card>
      </div>
    );
  }

  // --- LIST VIEW ---
  return (
    <div>
      <PageHeader title="Quotations" subtitle="Manage vendor quotations">
        <Space>
          <Button icon={<SwapOutlined />} onClick={openCompareMode}>
            Compare Quotations
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            Create Quotation
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchQuotations}
        rowKey="id"
        searchPlaceholder="Search by quotation number or vendor..."
        exportFileName="quotations"
        toolbar={toolbar}
        scroll={{ x: 1500 }}
      />

      {/* Create / Edit Drawer */}
      <Drawer
        title={editingQuotation ? `Edit ${editingQuotation.quotation_number}` : 'Create Quotation'}
        width={1000}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setEditingQuotation(null);
          form.resetFields();
          setQuotationItems([]);
        }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); setEditingQuotation(null); form.resetFields(); setQuotationItems([]); }}>
              Cancel
            </Button>
            <Button type="primary" onClick={handleSubmit} loading={submitting}>
              {editingQuotation ? 'Update' : 'Create'}
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="mr_id" label="Material Request">
                <Select
                  options={mrOptions}
                  placeholder="Select MR (optional)"
                  showSearch
                  optionFilterProp="label"
                  allowClear
                  onChange={handleMRSelect}
                  onSearch={(v) => loadMROptions(v)}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="vendor_id" label="Vendor" rules={[{ required: true, message: 'Required' }]}>
                <Select
                  options={vendors}
                  placeholder="Select vendor"
                  showSearch
                  optionFilterProp="label"
                  onSearch={(v) => loadVendors(v)}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item name="quotation_date" label="Quotation Date" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="valid_until" label="Valid Until" rules={[{ required: true, message: 'Required' }]}>
                <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="delivery_days" label="Delivery Days">
                <InputNumber min={0} style={{ width: '100%' }} placeholder="e.g. 15" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="payment_terms" label="Payment Terms">
                <Input placeholder="e.g. Net 30 days" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="remarks" label="Remarks">
                <Input placeholder="Any remarks..." />
              </Form.Item>
            </Col>
          </Row>
        </Form>

        <Divider orientation="left">Items</Divider>
        <Table
          dataSource={quotationItems}
          columns={quotItemColumns}
          rowKey="key"
          pagination={false}
          size="small"
          scroll={{ x: 900 }}
          footer={() => (
            <Button type="dashed" onClick={addQuotationItemRow} icon={<PlusOutlined />} block>
              Add Item
            </Button>
          )}
          summary={() => (
            <Table.Summary>
              <Table.Summary.Row>
                <Table.Summary.Cell colSpan={7} align="right"><Text strong>Subtotal:</Text></Table.Summary.Cell>
                <Table.Summary.Cell align="right"><Text>{formatCurrency(calcSubtotal())}</Text></Table.Summary.Cell>
                <Table.Summary.Cell />
              </Table.Summary.Row>
              <Table.Summary.Row>
                <Table.Summary.Cell colSpan={7} align="right"><Text strong>Tax:</Text></Table.Summary.Cell>
                <Table.Summary.Cell align="right"><Text>{formatCurrency(calcTaxTotal())}</Text></Table.Summary.Cell>
                <Table.Summary.Cell />
              </Table.Summary.Row>
              <Table.Summary.Row>
                <Table.Summary.Cell colSpan={7} align="right"><Text strong style={{ fontSize: 15 }}>Grand Total:</Text></Table.Summary.Cell>
                <Table.Summary.Cell align="right"><Text strong style={{ fontSize: 15 }}>{formatCurrency(calcGrandTotal())}</Text></Table.Summary.Cell>
                <Table.Summary.Cell />
              </Table.Summary.Row>
            </Table.Summary>
          )}
        />
      </Drawer>
    </div>
  );
};

export default Quotations;

