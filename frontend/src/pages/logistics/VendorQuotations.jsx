import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Select, Space, Card, Row, Col, Table, message, Tag, Rate,
  Popconfirm, Drawer, Form, Input, InputNumber, Descriptions, Tabs,
  Typography, Divider, Spin, Empty,
} from 'antd';
import {
  PlusOutlined, EyeOutlined, CheckCircleOutlined, CloseCircleOutlined,
  StarFilled, ArrowLeftOutlined, TrophyOutlined,
} from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import StatCard from '../../components/StatCard';
import api from '../../config/api';
import {
  formatDate, formatCurrency, formatNumber, getErrorMessage,
} from '../../utils/helpers';

const { Text, Title } = Typography;
const { TextArea } = Input;

const VEHICLE_TYPES = [
  { label: 'Mini Truck', value: 'mini_truck' },
  { label: 'LCV', value: 'lcv' },
  { label: 'Truck (10T)', value: 'truck_10t' },
  { label: 'Truck (20T)', value: 'truck_20t' },
  { label: 'Trailer', value: 'trailer' },
  { label: 'Container', value: 'container' },
  { label: 'Tempo', value: 'tempo' },
  { label: 'Courier', value: 'courier' },
];

const VendorQuotations = () => {
  const [requirements, setRequirements] = useState([]);
  const [selectedRequirement, setSelectedRequirement] = useState(null);
  const [requirementDetail, setRequirementDetail] = useState(null);
  const [quotations, setQuotations] = useState([]);
  const [loadingQuotations, setLoadingQuotations] = useState(false);
  const [loadingRequirements, setLoadingRequirements] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [viewMode, setViewMode] = useState('comparison');

  // List view state
  const [filterStatus, setFilterStatus] = useState(undefined);

  // Drawer for creating quotation
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [vendors, setVendors] = useState([]);

  // Detail view
  const [detailQuotation, setDetailQuotation] = useState(null);

  useEffect(() => {
    fetchRequirements();
  }, []);

  const fetchRequirements = async () => {
    setLoadingRequirements(true);
    try {
      // Bug fix BUG_0021/0071 — was filtering only 'open' but TRs in
      // 'quotation_received' should also accept more quotations. Show all
      // TRs that are still soliciting quotes.
      const res = await api.get('/logistics/transport-requirements', {
        params: { page_size: 200, status: 'open,quotation_received,draft' },
      });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setRequirements(items.map((r) => ({
        label: `${r.requirement_number} - ${r.material_description || r.destination_address || r.destination || ''}`,
        value: r.id,
        record: r,
      })));
      if (items.length === 0) {
        message.info('No transport requirements available. Create a TR first under Logistics → Transport Requirements.');
      }
    } catch (e) {
      message.error('Failed to load transport requirements: ' + (e?.response?.data?.detail || e?.message || ''));
    }
    finally { setLoadingRequirements(false); }
  };

  const fetchQuotationsForRequirement = async (reqId) => {
    setLoadingQuotations(true);
    setQuotations([]);
    try {
      const [quotRes, reqRes] = await Promise.all([
        api.get(`/logistics/transport-requirements/${reqId}/quotations`, { params: { page_size: 100 } }),
        api.get(`/logistics/transport-requirements/${reqId}`),
      ]);
      const items = quotRes.data.items || quotRes.data.data || quotRes.data || [];
      setQuotations(items);
      setRequirementDetail(reqRes.data);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoadingQuotations(false);
    }
  };

  const handleRequirementSelect = (reqId) => {
    setSelectedRequirement(reqId);
    if (reqId) {
      fetchQuotationsForRequirement(reqId);
    } else {
      setQuotations([]);
      setRequirementDetail(null);
    }
  };

  const fetchAllQuotations = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      return await api.get('/logistics/vendor-quotations', { params: qp });
    },
    [filterStatus]
  );

  const loadVendors = async () => {
    try {
      const res = await api.get('/masters/vendors', { params: { page_size: 200 } });
      const data = res.data;
      setVendors((data.items || data.data || data || []).map((v) => ({ label: v.name || v.vendor_name, value: v.id })));
    } catch { /* silent */ }
  };

  const handleCreateQuotation = () => {
    form.resetFields();
    if (selectedRequirement) {
      form.setFieldsValue({ transport_requirement_id: selectedRequirement });
    }
    loadVendors();
    setDrawerOpen(true);
  };

  const handleSubmitQuotation = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      await api.post('/logistics/vendor-quotations', values);
      message.success('Quotation created');
      setDrawerOpen(false);
      form.resetFields();
      if (selectedRequirement) {
        fetchQuotationsForRequirement(selectedRequirement);
      }
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
      await api.put(`/logistics/vendor-quotations/${id}/accept`);
      message.success('Quotation accepted');
      if (selectedRequirement) fetchQuotationsForRequirement(selectedRequirement);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleReject = async (id) => {
    try {
      await api.put(`/logistics/vendor-quotations/${id}/reject`);
      message.success('Quotation rejected');
      if (selectedRequirement) fetchQuotationsForRequirement(selectedRequirement);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSelectVendor = async (quotationId) => {
    try {
      await api.put(`/logistics/vendor-quotations/${quotationId}/select`);
      message.success('Vendor selected and transport order will be created');
      if (selectedRequirement) fetchQuotationsForRequirement(selectedRequirement);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  // Comparison data
  const cheapest = quotations.length > 0 ? Math.min(...quotations.filter((q) => q.quoted_amount).map((q) => q.quoted_amount)) : 0;
  const bestRated = quotations.length > 0 ? Math.max(...quotations.filter((q) => q.vendor_rating).map((q) => q.vendor_rating || 0)) : 0;

  const comparisonRows = [
    { criteria: 'Quoted Amount', key: 'quoted_amount', format: (v) => formatCurrency(v), highlight: (v) => v === cheapest ? '#f6ffed' : null },
    { criteria: 'Vehicle Availability', key: 'vehicle_availability', format: (v) => v ? 'Available' : 'Not Available' },
    { criteria: 'Vehicle Type', key: 'vehicle_type', format: (v) => { const found = VEHICLE_TYPES.find((t) => t.value === v); return found ? found.label : (v || '-'); } },
    { criteria: 'Estimated Delivery Days', key: 'estimated_delivery_days', format: (v) => v ? `${v} days` : '-' },
    { criteria: 'Vendor Rating', key: 'vendor_rating', format: (v) => v || 0, isRating: true, highlight: (v) => v === bestRated && bestRated > 0 ? '#e6f7ff' : null },
    { criteria: 'Previous Performance', key: 'previous_performance', format: (v) => v ? `${v}%` : '-' },
  ];

  const comparisonColumns = [
    { title: 'Criteria', dataIndex: 'criteria', key: 'criteria', width: 200, fixed: 'left', render: (v) => <Text strong>{v}</Text> },
    ...quotations.map((q, idx) => ({
      title: (
        <div style={{ textAlign: 'center' }}>
          <div>{q.vendor_name || q.vendor || `Vendor ${idx + 1}`}</div>
          <StatusTag status={q.status} />
        </div>
      ),
      dataIndex: `vendor_${idx}`,
      key: `vendor_${idx}`,
      width: 180,
      align: 'center',
      render: (_, row) => {
        const val = q[row.key];
        const bg = row.highlight ? row.highlight(val) : null;
        if (row.isRating) {
          return (
            <div style={{ background: bg, padding: '4px 8px', borderRadius: 4 }}>
              <Rate disabled value={val || 0} style={{ fontSize: 14 }} />
            </div>
          );
        }
        return (
          <div style={{ background: bg, padding: '4px 8px', borderRadius: 4 }}>
            {row.format(val)}
          </div>
        );
      },
    })),
  ];

  const comparisonData = comparisonRows.map((row) => ({ ...row }));

  // All quotations list columns
  const listColumns = [
    {
      title: 'Quotation #',
      dataIndex: 'quotation_number',
      key: 'quotation_number',
      width: 150,
      sorter: true,
      fixed: 'left',
    },
    {
      title: 'Requirement #',
      dataIndex: 'requirement_number',
      key: 'requirement_number',
      width: 160,
      render: (v, r) => v || r.transport_requirement?.requirement_number || '-',
    },
    { title: 'Vendor', dataIndex: 'vendor_name', key: 'vendor', width: 180, render: (v, r) => v || r.vendor || '-' },
    { title: 'Quoted Amount', dataIndex: 'quoted_amount', key: 'amount', width: 140, align: 'right', sorter: true, render: (v) => formatCurrency(v) },
    { title: 'Vehicle Type', dataIndex: 'vehicle_type', key: 'vt', width: 130, render: (v) => { const f = VEHICLE_TYPES.find((t) => t.value === v); return f ? f.label : (v || '-'); } },
    { title: 'Delivery Days', dataIndex: 'estimated_delivery_days', key: 'days', width: 120, align: 'right', render: (v) => v || '-' },
    { title: 'Rating', dataIndex: 'vendor_rating', key: 'rating', width: 150, render: (v) => <Rate disabled value={v || 0} style={{ fontSize: 12 }} /> },
    { title: 'Status', dataIndex: 'status', key: 'status', width: 120, render: (s) => <StatusTag status={s} /> },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          {record.status === 'pending' && (
            <>
              <Popconfirm title="Accept this quotation?" onConfirm={() => handleAccept(record.id)}>
                <Button type="link" size="small" icon={<CheckCircleOutlined />} style={{ color: '#52c41a' }} />
              </Popconfirm>
              <Popconfirm title="Reject this quotation?" onConfirm={() => handleReject(record.id)} okButtonProps={{ danger: true }}>
                <Button type="link" size="small" danger icon={<CloseCircleOutlined />} />
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ];

  const listToolbar = (
    <Space style={{ marginLeft: 12 }}>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 150 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Pending', value: 'pending' },
          { label: 'Accepted', value: 'accepted' },
          { label: 'Rejected', value: 'rejected' },
          { label: 'Selected', value: 'selected' },
        ]}
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="Vendor Quotations" subtitle="Compare and manage transport vendor quotations">
        <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateQuotation}>Add Quotation</Button>
      </PageHeader>

      <Tabs
        activeKey={viewMode}
        onChange={setViewMode}
        items={[
          {
            key: 'comparison',
            label: 'Comparison Dashboard',
            children: (
              <>
                <Card style={{ marginBottom: 16 }}>
                  <Row gutter={16} align="middle">
                    <Col flex="auto">
                      <Text strong style={{ marginRight: 12 }}>Select Transport Requirement:</Text>
                      <Select
                        placeholder="Search and select a requirement..."
                        style={{ width: 500 }}
                        value={selectedRequirement}
                        onChange={handleRequirementSelect}
                        options={requirements}
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        loading={loadingRequirements}
                      />
                    </Col>
                  </Row>
                </Card>

                {selectedRequirement && requirementDetail && (
                  <Card size="small" style={{ marginBottom: 16 }}>
                    <Descriptions size="small" column={{ xs: 1, sm: 2, md: 4 }}>
                      <Descriptions.Item label="Requirement #">{requirementDetail.requirement_number}</Descriptions.Item>
                      <Descriptions.Item label="Type">{requirementDetail.requirement_type?.replace(/_/g, ' ')}</Descriptions.Item>
                      <Descriptions.Item label="Destination">{requirementDetail.destination || '-'}</Descriptions.Item>
                      <Descriptions.Item label="Vehicle Required">{requirementDetail.vehicle_type_required || '-'}</Descriptions.Item>
                    </Descriptions>
                  </Card>
                )}

                {loadingQuotations ? (
                  <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
                ) : selectedRequirement && quotations.length > 0 ? (
                  <>
                    <Card title="Quotation Comparison" style={{ marginBottom: 16 }}>
                      <Table
                        dataSource={comparisonData}
                        columns={comparisonColumns}
                        rowKey="key"
                        pagination={false}
                        size="middle"
                        bordered
                        scroll={{ x: 200 + quotations.length * 180 }}
                      />
                    </Card>

                    <Row gutter={16}>
                      {quotations.map((q, idx) => (
                        <Col key={q.id} xs={24} sm={12} md={8} lg={6} style={{ marginBottom: 16 }}>
                          <Card
                            size="small"
                            title={
                              <Space>
                                {q.vendor_name || `Vendor ${idx + 1}`}
                                {q.quoted_amount === cheapest && <Tag color="green">Lowest Price</Tag>}
                                {q.vendor_rating === bestRated && bestRated > 0 && <Tag color="blue">Best Rated</Tag>}
                              </Space>
                            }
                            extra={<StatusTag status={q.status} />}
                            actions={
                              q.status === 'pending' || q.status === 'accepted'
                                ? [
                                    <Popconfirm key="select" title="Select this vendor for transport order?" onConfirm={() => handleSelectVendor(q.id)}>
                                      <Button type="primary" size="small" icon={<TrophyOutlined />}>Select Vendor</Button>
                                    </Popconfirm>,
                                  ]
                                : undefined
                            }
                          >
                            <Descriptions size="small" column={1}>
                              <Descriptions.Item label="Amount">
                                <Text strong style={{ color: q.quoted_amount === cheapest ? '#52c41a' : undefined }}>
                                  {formatCurrency(q.quoted_amount)}
                                </Text>
                              </Descriptions.Item>
                              <Descriptions.Item label="Vehicle">{q.vehicle_type || '-'}</Descriptions.Item>
                              <Descriptions.Item label="Delivery">{q.estimated_delivery_days ? `${q.estimated_delivery_days} days` : '-'}</Descriptions.Item>
                              <Descriptions.Item label="Rating"><Rate disabled value={q.vendor_rating || 0} style={{ fontSize: 12 }} /></Descriptions.Item>
                              <Descriptions.Item label="Performance">{q.previous_performance ? `${q.previous_performance}%` : '-'}</Descriptions.Item>
                            </Descriptions>
                          </Card>
                        </Col>
                      ))}
                    </Row>
                  </>
                ) : selectedRequirement ? (
                  <Card><Empty description="No quotations found for this requirement" /></Card>
                ) : (
                  <Card><Empty description="Select a transport requirement to compare vendor quotations" /></Card>
                )}
              </>
            ),
          },
          {
            key: 'list',
            label: 'All Quotations',
            children: (
              <DataTable
                key={refreshKey}
                columns={listColumns}
                fetchFunction={fetchAllQuotations}
                rowKey="id"
                searchPlaceholder="Search quotations..."
                exportFileName="vendor_quotations"
                toolbar={listToolbar}
                scroll={{ x: 1600 }}
              />
            ),
          },
        ]}
      />

      <Drawer
        title="Add Vendor Quotation"
        width={600}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); form.resetFields(); }}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => { setDrawerOpen(false); form.resetFields(); }}>Cancel</Button>
            <Button type="primary" onClick={handleSubmitQuotation} loading={submitting}>Submit Quotation</Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item name="transport_requirement_id" label="Transport Requirement" rules={[{ required: true, message: 'Required' }]}>
            <Select options={requirements} placeholder="Select requirement" allowClear showSearch optionFilterProp="label" />
          </Form.Item>
          <Form.Item name="vendor_id" label="Vendor" rules={[{ required: true, message: 'Required' }]}>
            <Select options={vendors} placeholder="Select vendor" allowClear showSearch optionFilterProp="label" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="quoted_amount" label="Quoted Amount" rules={[{ required: true, message: 'Required' }]}>
                <InputNumber min={0} style={{ width: '100%' }} placeholder="Amount" prefix="INR" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="vehicle_type" label="Vehicle Type" rules={[{ required: true, message: 'Required' }]}>
                <Select options={VEHICLE_TYPES} placeholder="Select vehicle type" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="vehicle_availability" label="Vehicle Available?" valuePropName="checked" initialValue={true}>
                <Select options={[{ label: 'Yes', value: true }, { label: 'No', value: false }]} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="estimated_delivery_days" label="Estimated Delivery Days" rules={[{ required: true, message: 'Required' }]}>
                <InputNumber min={1} style={{ width: '100%' }} placeholder="Days" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="vendor_rating" label="Vendor Rating">
                <Rate />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="previous_performance" label="Previous Performance (%)">
                <InputNumber min={0} max={100} style={{ width: '100%' }} placeholder="Performance score" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remarks" label="Remarks">
            <TextArea rows={3} placeholder="Additional notes..." />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
};

export default VendorQuotations;

