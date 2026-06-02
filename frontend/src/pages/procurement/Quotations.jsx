import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Drawer, Form, Input, InputNumber, Select, Space, DatePicker,
  Popconfirm, message, Row, Col, Table, Card, Descriptions,
  Divider, Typography, Tooltip, Tag, Empty, Spin, Modal, Switch,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  ArrowLeftOutlined, CheckOutlined, CloseOutlined,
  MinusCircleOutlined, StarOutlined,
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

const legacyVendorType = (val) => {
  const value = String(val?.code || val?.name || val || '').trim().toLowerCase();
  if (!value) return 'material';
  if (value === 'both' || value.includes('both')) return 'both';
  if (value === 'transport' || value.includes('transport') || value.includes('logistics')) return 'transport';
  if (value === 'service' || value.includes('service')) return 'service';
  return 'material';
};

const isMaterialSupplierVendor = (vendor) => {
  const typeCodes = Array.isArray(vendor?.vendor_types)
    ? vendor.vendor_types.map((type) => legacyVendorType(type))
    : [];
  const primaryType = legacyVendorType(vendor?.vendor_type_name || vendor?.vendor_type);
  return typeCodes.includes('material')
    || typeCodes.includes('both')
    || primaryType === 'material'
    || primaryType === 'both';
};

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
      const filtered = items.filter(isMaterialSupplierVendor);
      setVendors(filtered.map((v) => ({
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
        cgst_rate: item.cgst_rate || 0,
        sgst_rate: item.sgst_rate || 0,
        igst_rate: item.igst_rate || 0,
        tax_percent: item.tax_percent || item.tax_rate || 0,
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
    const cgst = (discounted * (item.cgst_rate || 0)) / 100;
    const sgst = (discounted * (item.sgst_rate || 0)) / 100;
    const igst = (discounted * (item.igst_rate || 0)) / 100;
    const tax = cgst + sgst + igst;
    return Number((discounted + tax).toFixed(2));
  };

  const calcSubtotal = () => {
    return quotationItems.reduce((sum, item) => {
      const base = (item.qty || 0) * (item.rate || 0);
      return sum + base - (base * (item.discount || 0)) / 100;
    }, 0);
  };

  const calcTaxComponents = () => {
    let cgst = 0, sgst = 0, igst = 0;
    quotationItems.forEach((item) => {
      const base = (item.qty || 0) * (item.rate || 0);
      const discounted = base - (base * (item.discount || 0)) / 100;
      cgst += (discounted * (item.cgst_rate || 0)) / 100;
      sgst += (discounted * (item.sgst_rate || 0)) / 100;
      igst += (discounted * (item.igst_rate || 0)) / 100;
    });
    return { cgst, sgst, igst };
  };

  const calcCGSTTotal = () => calcTaxComponents().cgst;
  const calcSGSTTotal = () => calcTaxComponents().sgst;
  const calcIGSTTotal = () => calcTaxComponents().igst;

  const calcTaxTotal = () => {
    const { cgst, sgst, igst } = calcTaxComponents();
    return cgst + sgst + igst;
  };

  const calcGrandTotal = () => calcSubtotal() + calcTaxTotal();

  const updateQuotationItem = (key, field, value) => {
    setQuotationItems((prev) =>
      prev.map((item) => {
        if (item.key !== key) return item;
        let updated = { ...item, [field]: value };
        if ((field === 'cgst_rate' || field === 'sgst_rate') && value > 0) {
          updated.igst_rate = 0;
        } else if (field === 'igst_rate' && value > 0) {
          updated.cgst_rate = 0;
          updated.sgst_rate = 0;
        }
        updated.amount = calcItemAmount(updated);
        return updated;
      })
    );
  };

  const addQuotationItemRow = () => {
    setQuotationItems((prev) => [
      ...prev,
      { key: Date.now(), item_id: null, item_name: '', qty: 1, uom: '', rate: 0, discount: 0, cgst_rate: 0, sgst_rate: 0, igst_rate: 0, tax_percent: 0, amount: 0 },
    ]);
  };

  const removeQuotationItemRow = (key) => {
    setQuotationItems((prev) => prev.filter((i) => i.key !== key));
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const validItems = editingQuotation
        ? quotationItems.filter(
            (i) => i.item_id && Number(i.rate) > 0 && Number(i.discount || 0) < 100
          )
        : quotationItems.filter((i) => i.item_id && Number(i.qty) > 0);

      if (validItems.length === 0) {
        message.error(editingQuotation
          ? 'Please add at least one item with a rate (and discount < 100%)'
          : 'Please add at least one item with a quantity'
        );
        return;
      }
      setSubmitting(true);

      if (editingQuotation) {
        const payload = {
          ...values,
          quotation_date: formatDateForAPI(values.quotation_date),
          valid_until: formatDateForAPI(values.valid_until),
          total_amount: Number(calcSubtotal().toFixed(2)),
          cgst_amount: Number(calcCGSTTotal().toFixed(2)),
          sgst_amount: Number(calcSGSTTotal().toFixed(2)),
          igst_amount: Number(calcIGSTTotal().toFixed(2)),
          tax_amount: Number(calcTaxTotal().toFixed(2)),
          grand_total: Number(calcGrandTotal().toFixed(2)),
          items: validItems.map((item) => ({
            item_id: item.item_id,
            qty: item.qty,
            uom_id: item.uom_id || item.primary_uom_id || 1,
            rate: item.rate,
            discount_pct: item.discount || item.discount_pct || 0,
            cgst_rate: item.cgst_rate || 0,
            sgst_rate: item.sgst_rate || 0,
            igst_rate: item.igst_rate || 0,
            tax_rate: (item.cgst_rate || 0) + (item.sgst_rate || 0) + (item.igst_rate || 0),
            amount: item.amount,
          })),
        };
        await api.put(`/procurement/quotations/${editingQuotation.id}`, payload);
        message.success('Quotation updated');
      } else {
        const rfqPayload = {
          mr_id: values.mr_id || null,
          title: `RFQ Sourcing - ${new Date().toLocaleDateString()}`,
          vendor_ids: values.vendor_ids || [],
          rfq_date: formatDateForAPI(values.quotation_date),
          valid_until: formatDateForAPI(values.valid_until),
          currency: "INR",
          delivery_days: values.delivery_days || 0,
          payment_terms: values.payment_terms || "",
          remarks: values.remarks || "",
          items: validItems.map((item) => ({
            item_id: item.item_id,
            qty: item.qty,
            uom_id: item.uom_id || item.primary_uom_id || 1,
            rate: item.rate || 0,
            discount_pct: item.discount || item.discount_pct || 0,
            tax_rate: item.tax_percent || item.tax_rate || 0,
            remarks: item.remarks || "",
          })),
        };
        await api.post('/procurement/rfqs', rfqPayload);
        message.success('RFQ and supplier invitations created successfully!');
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
    ...(editingQuotation ? [
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
        title: 'CGST %',
        dataIndex: 'cgst_rate',
        width: 80,
        render: (val, record) => (
          <InputNumber min={0} max={100} value={val} onChange={(v) => updateQuotationItem(record.key, 'cgst_rate', v)} style={{ width: '100%' }} />
        ),
      },
      {
        title: 'SGST %',
        dataIndex: 'sgst_rate',
        width: 80,
        render: (val, record) => (
          <InputNumber min={0} max={100} value={val} onChange={(v) => updateQuotationItem(record.key, 'sgst_rate', v)} style={{ width: '100%' }} />
        ),
      },
      {
        title: 'IGST %',
        dataIndex: 'igst_rate',
        width: 80,
        render: (val, record) => (
          <InputNumber min={0} max={100} value={val} onChange={(v) => updateQuotationItem(record.key, 'igst_rate', v)} style={{ width: '100%' }} />
        ),
      },
      {
        title: 'Amount',
        dataIndex: 'amount',
        width: 110,
        align: 'right',
        render: (val) => formatCurrency(val),
      }
    ] : []),
    {
      title: '',
      width: 40,
      align: 'center',
      render: (_, record) => (
        <Button
          type="text"
          danger
          icon={<DeleteOutlined />}
          onClick={() => removeQuotationItemRow(record.key)}
          disabled={quotationItems.length === 1}
        />
      ),
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
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
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
              {editingQuotation ? (
                <Form.Item name="vendor_id" label="Vendor" rules={[{ required: true, message: 'Required' }]}>
                  <Select
                    options={vendors}
                    placeholder="Select vendor"
                    showSearch
                    optionFilterProp="label"
                    onSearch={(v) => loadVendors(v)}
                  />
                </Form.Item>
              ) : (
                <Form.Item name="vendor_ids" label="Vendors" rules={[{ required: true, message: 'Required' }]}>
                  <Select
                    mode="multiple"
                    options={vendors}
                    placeholder="Select multiple vendors"
                    showSearch
                    optionFilterProp="label"
                    onSearch={(v) => loadVendors(v)}
                  />
                </Form.Item>
              )}
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
            <Col span={8}>
              <Form.Item name="payment_terms" label="Payment Terms">
                <Input placeholder="e.g. Net 30 days" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="remarks" label="Remarks">
                <Input placeholder="Any remarks..." />
              </Form.Item>
            </Col>
            {!editingQuotation && (
              <Col span={8}>
                <Form.Item name="with_vehicle" label="Vehicle Needed?" valuePropName="checked" initialValue={false}>
                  <Switch checkedChildren="Yes" unCheckedChildren="No" />
                </Form.Item>
              </Col>
            )}
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
          summary={editingQuotation ? () => (
            <Table.Summary>
              <Table.Summary.Row>
                <Table.Summary.Cell colSpan={9} align="right"><Text strong>Subtotal:</Text></Table.Summary.Cell>
                <Table.Summary.Cell align="right"><Text>{formatCurrency(calcSubtotal())}</Text></Table.Summary.Cell>
                <Table.Summary.Cell />
              </Table.Summary.Row>
              {calcCGSTTotal() > 0 && (
                <Table.Summary.Row>
                  <Table.Summary.Cell colSpan={9} align="right"><Text strong>CGST:</Text></Table.Summary.Cell>
                  <Table.Summary.Cell align="right"><Text>{formatCurrency(calcCGSTTotal())}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell />
                </Table.Summary.Row>
              )}
              {calcSGSTTotal() > 0 && (
                <Table.Summary.Row>
                  <Table.Summary.Cell colSpan={9} align="right"><Text strong>SGST:</Text></Table.Summary.Cell>
                  <Table.Summary.Cell align="right"><Text>{formatCurrency(calcSGSTTotal())}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell />
                </Table.Summary.Row>
              )}
              {calcIGSTTotal() > 0 && (
                <Table.Summary.Row>
                  <Table.Summary.Cell colSpan={9} align="right"><Text strong>IGST:</Text></Table.Summary.Cell>
                  <Table.Summary.Cell align="right"><Text>{formatCurrency(calcIGSTTotal())}</Text></Table.Summary.Cell>
                  <Table.Summary.Cell />
                </Table.Summary.Row>
              )}
              <Table.Summary.Row>
                <Table.Summary.Cell colSpan={9} align="right"><Text strong>Tax Total:</Text></Table.Summary.Cell>
                <Table.Summary.Cell align="right"><Text>{formatCurrency(calcTaxTotal())}</Text></Table.Summary.Cell>
                <Table.Summary.Cell />
              </Table.Summary.Row>
              <Table.Summary.Row>
                <Table.Summary.Cell colSpan={9} align="right"><Text strong style={{ fontSize: 15 }}>Grand Total:</Text></Table.Summary.Cell>
                <Table.Summary.Cell align="right"><Text strong style={{ fontSize: 15 }}>{formatCurrency(calcGrandTotal())}</Text></Table.Summary.Cell>
                <Table.Summary.Cell />
              </Table.Summary.Row>
            </Table.Summary>
          ) : undefined}
        />
      </Drawer>
    </div>
  );
};

export default Quotations;

