import React, { useState, useEffect, useRef } from 'react';
import {
  Button, Card, Descriptions, Tabs, Table, Spin, Space, message,
  Tag, Empty, Typography, Divider, Progress, Popconfirm, Steps, Timeline,
  Row, Col,
} from 'antd';
import {
  ArrowLeftOutlined, PrinterOutlined, CheckOutlined,
  CloseCircleOutlined, SendOutlined, PlusOutlined,
  FileDoneOutlined, DollarOutlined, InboxOutlined,
  CarryOutOutlined, AuditOutlined, CheckCircleOutlined, PaperClipOutlined,
} from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import { useReactToPrint } from 'react-to-print';
import PageHeader from '../../components/PageHeader';
import { PurchaseOrderPrint } from '../../components/PrintTemplates';
import StatusTag from '../../components/StatusTag';
import AttachmentUploader from '../../components/AttachmentUploader';
import api from '../../config/api';
import {
  formatCurrency, formatDate, getErrorMessage, formatDateTime,
} from '../../utils/helpers';

const { Text, Title } = Typography;

const PO_STATUS_STEPS = [
  { key: 'draft', title: 'Draft', icon: <AuditOutlined /> },
  { key: 'pending_approval', title: 'Pending Approval', icon: <SendOutlined /> },
  { key: 'approved', title: 'Approved', icon: <CheckOutlined /> },
  { key: 'partially_received', title: 'Partially Received', icon: <InboxOutlined /> },
  { key: 'received', title: 'Received', icon: <CarryOutOutlined /> },
  { key: 'closed', title: 'Closed', icon: <CheckCircleOutlined /> },
];

const PurchaseOrderForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const printRef = useRef(null);

  const [po, setPo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('items');

  // Related data
  const [grnList, setGrnList] = useState([]);
  const [invoiceList, setInvoiceList] = useState([]);
  const [paymentList, setPaymentList] = useState([]);
  const [tabLoading, setTabLoading] = useState(false);

  // Action states
  const [actionLoading, setActionLoading] = useState(false);

  const handlePrint = useReactToPrint({
    content: () => printRef.current,
    documentTitle: po ? `PO_${po.po_number}` : 'PurchaseOrder',
  });

  useEffect(() => {
    if (id) {
      fetchPO();
    } else {
      // If no id, redirect to PO list (creation is handled via drawer in PurchaseOrders.jsx)
      navigate('/procurement/purchase-orders');
    }
  }, [id]);

  const fetchPO = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/procurement/purchase-orders/${id}`);
      setPo(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/procurement/purchase-orders');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (po && activeTab === 'grn_history') fetchGRNs();
    if (po && activeTab === 'payments') fetchPayments();
  }, [activeTab, po]);

  const fetchGRNs = async () => {
    setTabLoading(true);
    try {
      const res = await api.get(`/procurement/purchase-orders/${id}/grns`, { params: { page_size: 100 } });
      setGrnList(res.data.items || res.data.data || res.data || []);
    } catch {
      // If specific endpoint fails, try general GRN endpoint filtered by PO
      try {
        const res = await api.get('/warehouse/grn', { params: { po_id: id, page_size: 100 } });
        setGrnList(res.data.items || res.data.data || res.data || []);
      } catch {
        // silent
      }
    } finally {
      setTabLoading(false);
    }
  };

  const fetchPayments = async () => {
    setTabLoading(true);
    try {
      const [invRes, payRes] = await Promise.allSettled([
        api.get(`/procurement/purchase-orders/${id}/invoices`, { params: { page_size: 100 } }),
        api.get(`/procurement/purchase-orders/${id}/payments`, { params: { page_size: 100 } }),
      ]);
      if (invRes.status === 'fulfilled') {
        setInvoiceList(invRes.value.data.items || invRes.value.data.data || invRes.value.data || []);
      }
      if (payRes.status === 'fulfilled') {
        setPaymentList(payRes.value.data.items || payRes.value.data.data || payRes.value.data || []);
      }
    } catch {
      // silent
    } finally {
      setTabLoading(false);
    }
  };

  // Actions
  const handleSubmitForApproval = async () => {
    setActionLoading(true);
    try {
      await api.post(`/procurement/purchase-orders/${id}/submit`);
      message.success('PO submitted for approval');
      fetchPO();
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  };

  const handleApprove = async () => {
    setActionLoading(true);
    try {
      await api.post(`/procurement/purchase-orders/${id}/approve`);
      message.success('PO approved');
      fetchPO();
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async () => {
    setActionLoading(true);
    try {
      await api.post(`/procurement/purchase-orders/${id}/cancel`);
      message.success('PO cancelled');
      fetchPO();
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setActionLoading(false);
    }
  };

  const handleCreateGRN = () => {
    navigate(`/warehouse/grn/new?po_id=${id}`);
  };

  const handleCreateInvoice = () => {
    // Land on Invoices list with ?po_id= so the page auto-opens the drawer
    // and calls handlePOSelect to pre-fill vendor + items from this PO.
    navigate(`/accounts/invoices?new=1&po_id=${id}`);
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <Spin size="large" tip="Loading Purchase Order..." />
      </div>
    );
  }

  if (!po) {
    return (
      <div>
        <PageHeader title="Purchase Order Not Found" />
        <Empty description="The requested purchase order was not found." />
        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/procurement/purchase-orders')}>
            Back to Purchase Orders
          </Button>
        </div>
      </div>
    );
  }

  const poItems = po.items || [];
  const currentStepIdx = PO_STATUS_STEPS.findIndex((s) => s.key === po.status);
  const isCancelled = po.status === 'cancelled';

  // Calculate total received
  const totalOrderedQty = poItems.reduce((sum, i) => sum + Number(i.qty || i.quantity || 0), 0);
  const totalReceivedQty = poItems.reduce((sum, i) => sum + Number(i.received_qty || 0), 0);
  const overallProgress = totalOrderedQty > 0 ? Math.round((totalReceivedQty / totalOrderedQty) * 100) : 0;

  // Calculate tax and discount totals dynamically from items
  const discountTotal = po.discount_amount || po.discount_total || poItems.reduce((sum, i) => sum + (Number(i.qty || 0) * Number(i.rate || 0) * Number(i.discount_percent || i.discount_pct || 0)) / 100, 0);
  const cgstTotal = po.cgst_amount || po.cgst_total || poItems.reduce((sum, i) => sum + (Number(i.qty || 0) * Number(i.rate || 0) * (1 - Number(i.discount_percent || i.discount_pct || 0)/100) * Number(i.cgst_percent || i.cgst_rate || 0)) / 100, 0);
  const sgstTotal = po.sgst_amount || po.sgst_total || poItems.reduce((sum, i) => sum + (Number(i.qty || 0) * Number(i.rate || 0) * (1 - Number(i.discount_percent || i.discount_pct || 0)/100) * Number(i.sgst_percent || i.sgst_rate || 0)) / 100, 0);
  const igstTotal = po.igst_amount || po.igst_total || poItems.reduce((sum, i) => sum + (Number(i.qty || 0) * Number(i.rate || 0) * (1 - Number(i.discount_percent || i.discount_pct || 0)/100) * Number(i.igst_percent || i.igst_rate || 0)) / 100, 0);
  const taxTotal = po.tax_amount || po.tax_total || (cgstTotal + sgstTotal + igstTotal);

  // Parse vehicle/freight cost from remarks
  let vehicleCost = 0;
  if (po.remarks) {
    const match = po.remarks.match(/Includes vehicle cost:\s*(\d+(\.\d+)?)/);
    if (match) {
      vehicleCost = parseFloat(match[1]);
    }
  }

  return (
    <div>
      <div style={{ display: 'none' }}>
        <PurchaseOrderPrint ref={printRef} data={po} />
      </div>
      <PageHeader title={po.po_number} subtitle="Purchase Order Detail">
        <Space className="no-print">
          {po.status === 'draft' && (
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={handleSubmitForApproval}
              loading={actionLoading}
            >
              Submit for Approval
            </Button>
          )}
          {po.status === 'pending_approval' && (
            <Popconfirm title="Approve this Purchase Order?" onConfirm={handleApprove}>
              <Button type="primary" icon={<CheckOutlined />} loading={actionLoading}>
                Approve
              </Button>
            </Popconfirm>
          )}
          {['approved', 'partially_received'].includes(po.status) && (
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateGRN}>
              Create GRN
            </Button>
          )}
          {['approved', 'partially_received', 'received'].includes(po.status) && (
            <Button icon={<DollarOutlined />} onClick={handleCreateInvoice}>
              Create Invoice
            </Button>
          )}
          {!['closed', 'cancelled', 'received'].includes(po.status) && (
            <Popconfirm
              title="Cancel this Purchase Order?"
              onConfirm={handleCancel}
              okButtonProps={{ danger: true }}
            >
              <Button danger icon={<CloseCircleOutlined />} loading={actionLoading}>
                Cancel
              </Button>
            </Popconfirm>
          )}
          <Button icon={<PrinterOutlined />} onClick={handlePrint}>
            Print PO
          </Button>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/procurement/purchase-orders')}>
            Back
          </Button>
        </Space>
      </PageHeader>

      {/* Status Timeline */}
      <Card style={{ marginBottom: 16 }}>
        {isCancelled ? (
          <div style={{ textAlign: 'center', padding: '8px 0' }}>
            <Tag color="red" style={{ fontSize: 14, padding: '4px 16px' }}>This Purchase Order has been Cancelled</Tag>
          </div>
        ) : (
          <Steps
            current={currentStepIdx >= 0 ? currentStepIdx : 0}
            size="small"
            items={PO_STATUS_STEPS.map((step, idx) => ({
              title: step.title,
              icon: step.icon,
              status: idx < currentStepIdx ? 'finish' : idx === currentStepIdx ? 'process' : 'wait',
            }))}
          />
        )}
      </Card>

      {/* PO Header Info */}
      <Card style={{ marginBottom: 16 }}>
        <Row gutter={24}>
          <Col xs={24} lg={16}>
            <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
              <Descriptions.Item label="PO Number"><Text strong>{po.po_number}</Text></Descriptions.Item>
              <Descriptions.Item label="PO Date">{formatDate(po.po_date)}</Descriptions.Item>
              <Descriptions.Item label="Status"><StatusTag status={po.status} /></Descriptions.Item>
              <Descriptions.Item label="Vendor" span={2}>
                <Text strong>{po.vendor_name || po.vendor || '-'}</Text>
                {po.vendor_code && <Text type="secondary"> ({po.vendor_code})</Text>}
              </Descriptions.Item>
              <Descriptions.Item label="Expected Delivery">{formatDate(po.expected_delivery_date)}</Descriptions.Item>
              <Descriptions.Item label="MR Reference">{po.mr_number || po.mr_reference || '-'}</Descriptions.Item>
              <Descriptions.Item label="Quotation Ref">{po.quotation_number || po.quotation_reference || '-'}</Descriptions.Item>
              <Descriptions.Item label="Project">{po.project_name || po.project || '-'}</Descriptions.Item>
              <Descriptions.Item label="Warehouse">{po.warehouse_name || po.warehouse || '-'}</Descriptions.Item>
              <Descriptions.Item label="Payment Terms">{po.payment_terms || '-'}</Descriptions.Item>
              <Descriptions.Item label="Currency">{po.currency || 'INR'}</Descriptions.Item>
              <Descriptions.Item label="Billing Address" span={3}>{po.billing_address || '-'}</Descriptions.Item>
              <Descriptions.Item label="Shipping Address" span={3}>{po.shipping_address || '-'}</Descriptions.Item>
              <Descriptions.Item label="Remarks" span={3}>{po.remarks || '-'}</Descriptions.Item>
              <Descriptions.Item label="Created By">{po.created_by_name || po.created_by || '-'}</Descriptions.Item>
              <Descriptions.Item label="Created At">{formatDateTime(po.created_at)}</Descriptions.Item>
              <Descriptions.Item label="Approved By">{po.approved_by_name || po.approved_by || '-'}</Descriptions.Item>
            </Descriptions>
          </Col>
          <Col xs={24} lg={8}>
            <Card size="small" style={{ background: '#fafafa', height: '100%' }}>
              <div style={{ textAlign: 'center', marginBottom: 16 }}>
                <Text type="secondary">Grand Total</Text>
                <Title level={3} style={{ margin: '4px 0', color: '#eb2f96' }}>
                  {formatCurrency(po.grand_total)}
                </Title>
              </div>
              <Divider style={{ margin: '12px 0' }} />
              <Row style={{ padding: '4px 0' }}>
                <Col span={14}><Text type="secondary">Subtotal:</Text></Col>
                <Col span={10} style={{ textAlign: 'right' }}><Text>{formatCurrency(po.subtotal)}</Text></Col>
              </Row>
              {(discountTotal > 0) && (
                <Row style={{ padding: '4px 0' }}>
                  <Col span={14}><Text type="secondary">Discount:</Text></Col>
                  <Col span={10} style={{ textAlign: 'right' }}><Text type="danger">-{formatCurrency(discountTotal)}</Text></Col>
                </Row>
              )}
              {(cgstTotal > 0) && (
                <Row style={{ padding: '4px 0' }}>
                  <Col span={14}><Text type="secondary">CGST:</Text></Col>
                  <Col span={10} style={{ textAlign: 'right' }}><Text>{formatCurrency(cgstTotal)}</Text></Col>
                </Row>
              )}
              {(sgstTotal > 0) && (
                <Row style={{ padding: '4px 0' }}>
                  <Col span={14}><Text type="secondary">SGST:</Text></Col>
                  <Col span={10} style={{ textAlign: 'right' }}><Text>{formatCurrency(sgstTotal)}</Text></Col>
                </Row>
              )}
              {(igstTotal > 0) && (
                <Row style={{ padding: '4px 0' }}>
                  <Col span={14}><Text type="secondary">IGST:</Text></Col>
                  <Col span={10} style={{ textAlign: 'right' }}><Text>{formatCurrency(igstTotal)}</Text></Col>
                </Row>
              )}
              <Row style={{ padding: '4px 0' }}>
                <Col span={14}><Text type="secondary">Tax Total:</Text></Col>
                <Col span={10} style={{ textAlign: 'right' }}><Text>{formatCurrency(taxTotal)}</Text></Col>
              </Row>
              {vehicleCost > 0 && (
                <Row style={{ padding: '4px 0' }}>
                  <Col span={14}><Text type="secondary">Vehicle / Freight Cost:</Text></Col>
                  <Col span={10} style={{ textAlign: 'right' }}><Text>+{formatCurrency(vehicleCost)}</Text></Col>
                </Row>
              )}
              <Divider style={{ margin: '12px 0' }} />
              <div style={{ textAlign: 'center' }}>
                <Text type="secondary">Receiving Progress</Text>
                <Progress
                  percent={overallProgress}
                  status={overallProgress >= 100 ? 'success' : 'active'}
                  strokeColor={overallProgress >= 100 ? '#52c41a' : '#eb2f96'}
                  style={{ marginTop: 8 }}
                />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {totalReceivedQty} of {totalOrderedQty} units received
                </Text>
              </div>
            </Card>
          </Col>
        </Row>
      </Card>

      {/* Tabs: Items, GRN History, Payments */}
      <Card>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'items',
              label: (
                <span><FileDoneOutlined /> Items ({poItems.length})</span>
              ),
              children: (
                <Table
                  dataSource={poItems}
                  rowKey={(r) => r.id || r.item_id}
                  size="small"
                  pagination={false}
                  scroll={{ x: 'max-content' }}
                  columns={[
                    { title: '#', width: 40, render: (_, __, idx) => idx + 1 },
                    {
                      title: 'Item Code',
                      dataIndex: 'item_code',
                      key: 'code',
                      width: 120,
                      render: (v, r) => v || (r.item && r.item.item_code) || '-',
                    },
                    {
                      title: 'Item Name',
                      dataIndex: 'item_name',
                      key: 'name',
                      width: 220,
                      render: (v, r) => v || (r.item && (r.item.item_name || r.item.name)) || '-',
                    },
                    {
                      title: 'UOM',
                      dataIndex: 'uom',
                      key: 'uom',
                      width: 70,
                      render: (v, r) => v || r.unit || '-',
                    },
                    {
                      title: 'Ordered Qty',
                      dataIndex: 'qty',
                      key: 'qty',
                      width: 100,
                      align: 'right',
                      render: (v, r) => v || r.quantity || 0,
                    },
                    {
                      title: 'Received Qty',
                      dataIndex: 'received_qty',
                      key: 'received',
                      width: 120,
                      align: 'right',
                      render: (receivedQty, record) => {
                        const ordered = record.qty || record.quantity || 0;
                        const received = receivedQty || 0;
                        const pct = ordered > 0 ? Math.round((received / ordered) * 100) : 0;
                        return (
                          <div>
                            <Text>{received} / {ordered}</Text>
                            <Progress
                              percent={pct}
                              size="small"
                              status={pct >= 100 ? 'success' : 'active'}
                              showInfo={false}
                              strokeColor={pct >= 100 ? '#52c41a' : '#eb2f96'}
                            />
                          </div>
                        );
                      },
                    },
                    {
                      title: 'Rate',
                      dataIndex: 'rate',
                      key: 'rate',
                      width: 100,
                      align: 'right',
                      render: (v, r) => formatCurrency(v || r.unit_price),
                    },
                    {
                      title: 'Disc%',
                      dataIndex: 'discount_percent',
                      key: 'disc',
                      width: 70,
                      align: 'right',
                      render: (v, r) => `${v || r.discount_pct || 0}%`,
                    },
                    {
                      title: 'CGST%',
                      dataIndex: 'cgst_percent',
                      key: 'cgst',
                      width: 70,
                      align: 'right',
                      render: (v, r) => `${v || r.cgst_rate || 0}%`,
                    },
                    {
                      title: 'SGST%',
                      dataIndex: 'sgst_percent',
                      key: 'sgst',
                      width: 70,
                      align: 'right',
                      render: (v, r) => `${v || r.sgst_rate || 0}%`,
                    },
                    {
                      title: 'IGST%',
                      dataIndex: 'igst_percent',
                      key: 'igst',
                      width: 70,
                      align: 'right',
                      render: (v, r) => `${v || r.igst_rate || 0}%`,
                    },
                    {
                      title: 'Tax Amount',
                      dataIndex: 'tax_amount',
                      key: 'tax_amt',
                      width: 100,
                      align: 'right',
                      render: (v) => formatCurrency(v),
                    },
                    {
                      title: 'Amount',
                      dataIndex: 'amount',
                      key: 'amount',
                      width: 120,
                      align: 'right',
                      render: (v, r) => <Text strong>{formatCurrency(v || r.total)}</Text>,
                    },
                  ]}
                  summary={(pageData) => {
                    let itemsTotal = 0;
                    pageData.forEach((r) => {
                      itemsTotal += parseFloat(r.amount || r.total || 0);
                    });
                    
                    let vCost = 0;
                    if (po.remarks) {
                      const match = po.remarks.match(/Includes vehicle cost:\s*(\d+(\.\d+)?)/);
                      if (match) vCost = parseFloat(match[1]);
                    }

                    return (
                      <Table.Summary>
                        {vCost > 0 && (
                          <>
                            <Table.Summary.Row>
                              <Table.Summary.Cell colSpan={12} align="right"><Text type="secondary">Items Subtotal:</Text></Table.Summary.Cell>
                              <Table.Summary.Cell align="right"><Text type="secondary">{formatCurrency(itemsTotal)}</Text></Table.Summary.Cell>
                            </Table.Summary.Row>
                            <Table.Summary.Row>
                              <Table.Summary.Cell colSpan={12} align="right"><Text type="secondary">Vehicle / Logistics Cost:</Text></Table.Summary.Cell>
                              <Table.Summary.Cell align="right"><Text type="secondary">+{formatCurrency(vCost)}</Text></Table.Summary.Cell>
                            </Table.Summary.Row>
                          </>
                        )}
                        <Table.Summary.Row>
                          <Table.Summary.Cell colSpan={12} align="right"><Text strong>Grand Total:</Text></Table.Summary.Cell>
                          <Table.Summary.Cell align="right"><Text strong style={{ color: '#eb2f96' }}>{formatCurrency(po.grand_total)}</Text></Table.Summary.Cell>
                        </Table.Summary.Row>
                      </Table.Summary>
                    );
                  }}
                />
              ),
            },
            {
              key: 'grn_history',
              label: (
                <span><InboxOutlined /> GRN History</span>
              ),
              children: (
                <Table
                  dataSource={grnList}
                  loading={tabLoading}
                  rowKey="id"
                  size="small"
                  pagination={{ pageSize: 20, showSizeChanger: true }}
                  scroll={{ x: 'max-content' }}
                  locale={{ emptyText: <Empty description="No GRNs created against this PO yet" /> }}
                  columns={[
                    {
                      title: 'GRN Number',
                      dataIndex: 'grn_number',
                      key: 'grn',
                      width: 150,
                      render: (text, record) => (
                        <a onClick={() => navigate(`/warehouse/grn/${record.id}`)}>{text || '-'}</a>
                      ),
                    },
                    {
                      title: 'GRN Date',
                      dataIndex: 'grn_date',
                      key: 'date',
                      width: 120,
                      render: (v) => formatDate(v),
                    },
                    {
                      title: 'Received By',
                      dataIndex: 'received_by_name',
                      key: 'by',
                      width: 140,
                      render: (v, r) => v || r.received_by || '-',
                    },
                    {
                      title: 'Items',
                      dataIndex: 'item_count',
                      key: 'items',
                      width: 70,
                      align: 'right',
                      render: (v, r) => v || (r.items && r.items.length) || '-',
                    },
                    {
                      title: 'Total Qty Received',
                      dataIndex: 'total_received_qty',
                      key: 'qty',
                      width: 130,
                      align: 'right',
                      render: (v, r) => {
                        if (v) return v;
                        if (r.items) return r.items.reduce((s, i) => s + (i.received_qty || i.qty || 0), 0);
                        return '-';
                      },
                    },
                    {
                      title: 'QC Status',
                      dataIndex: 'qc_status',
                      key: 'qc',
                      width: 120,
                      render: (s) => s ? <StatusTag status={s} /> : '-',
                    },
                    {
                      title: 'Status',
                      dataIndex: 'status',
                      key: 'status',
                      width: 120,
                      render: (s) => <StatusTag status={s} />,
                    },
                  ]}
                />
              ),
            },
            {
              key: 'payments',
              label: (
                <span><DollarOutlined /> Payment Status</span>
              ),
              children: (
                <>
                  <Divider orientation="left">Linked Invoices</Divider>
                  <Table
                    dataSource={invoiceList}
                    loading={tabLoading}
                    rowKey="id"
                    size="small"
                    pagination={false}
                    scroll={{ x: 'max-content' }}
                    locale={{ emptyText: <Empty description="No invoices linked to this PO" /> }}
                    columns={[
                      {
                        title: 'Invoice Number',
                        dataIndex: 'invoice_number',
                        key: 'inv',
                        width: 150,
                        render: (text, record) => (
                          <a onClick={() => navigate(`/accounts/invoices/${record.id}`)}>{text || '-'}</a>
                        ),
                      },
                      { title: 'Invoice Date', dataIndex: 'invoice_date', key: 'date', width: 120, render: (v) => formatDate(v) },
                      { title: 'Due Date', dataIndex: 'due_date', key: 'due', width: 120, render: (v) => formatDate(v) },
                      { title: 'Amount', dataIndex: 'total_amount', key: 'amt', width: 130, align: 'right', render: (v) => formatCurrency(v) },
                      { title: 'Paid', dataIndex: 'paid_amount', key: 'paid', width: 130, align: 'right', render: (v) => formatCurrency(v) },
                      { title: 'Balance', dataIndex: 'balance_amount', key: 'bal', width: 130, align: 'right', render: (v) => formatCurrency(v) },
                      { title: 'Status', dataIndex: 'status', key: 'status', width: 120, render: (s) => <StatusTag status={s} /> },
                    ]}
                  />

                  <Divider orientation="left" style={{ marginTop: 32 }}>Payments</Divider>
                  <Table
                    dataSource={paymentList}
                    loading={tabLoading}
                    rowKey="id"
                    size="small"
                    pagination={false}
                    scroll={{ x: 'max-content' }}
                    locale={{ emptyText: <Empty description="No payments recorded for this PO" /> }}
                    columns={[
                      {
                        title: 'Payment No',
                        dataIndex: 'payment_number',
                        key: 'pay',
                        width: 150,
                        render: (text, record) => (
                          <a onClick={() => navigate(`/accounts/payments/${record.id}`)}>{text || '-'}</a>
                        ),
                      },
                      { title: 'Payment Date', dataIndex: 'payment_date', key: 'date', width: 120, render: (v) => formatDate(v) },
                      { title: 'Mode', dataIndex: 'payment_mode', key: 'mode', width: 120, render: (v) => v ? v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '-' },
                      { title: 'Reference', dataIndex: 'reference_number', key: 'ref', width: 150, render: (v) => v || '-' },
                      { title: 'Amount', dataIndex: 'amount', key: 'amt', width: 130, align: 'right', render: (v) => <Text strong>{formatCurrency(v)}</Text> },
                      { title: 'Status', dataIndex: 'status', key: 'status', width: 120, render: (s) => <StatusTag status={s} /> },
                    ]}
                  />

                  {/* Payment Summary */}
                  {(invoiceList.length > 0 || paymentList.length > 0) && (
                    <Card size="small" style={{ marginTop: 16, maxWidth: 400 }}>
                      <Descriptions size="small" column={1}>
                        <Descriptions.Item label="PO Grand Total">
                          <Text strong>{formatCurrency(po.grand_total)}</Text>
                        </Descriptions.Item>
                        <Descriptions.Item label="Total Invoiced">
                          {formatCurrency(invoiceList.reduce((s, i) => s + (i.total_amount || 0), 0))}
                        </Descriptions.Item>
                        <Descriptions.Item label="Total Paid">
                          <Text type="success">
                            {formatCurrency(paymentList.reduce((s, p) => s + (p.amount || 0), 0))}
                          </Text>
                        </Descriptions.Item>
                        <Descriptions.Item label="Outstanding">
                          <Text type="danger">
                            {formatCurrency(
                              (po.grand_total || 0) -
                              paymentList.reduce((s, p) => s + (p.amount || 0), 0)
                            )}
                          </Text>
                        </Descriptions.Item>
                      </Descriptions>
                    </Card>
                  )}
                </>
              ),
            },
            {
              key: 'timeline',
              label: (
                <span><CarryOutOutlined /> Activity</span>
              ),
              children: (
                <Timeline
                  mode="left"
                  items={[
                    ...(po.activity_log || po.history || []).map((log) => ({
                      color: log.action === 'approved' ? 'green' : log.action === 'cancelled' ? 'red' : 'blue',
                      children: (
                        <div>
                          <Text strong>
                            {(log.action || log.event || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                          </Text>
                          <br />
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {log.user_name || log.user || 'System'} - {formatDateTime(log.timestamp || log.created_at)}
                          </Text>
                          {log.remarks && (
                            <>
                              <br />
                              <Text style={{ fontSize: 12 }}>{log.remarks}</Text>
                            </>
                          )}
                        </div>
                      ),
                    })),
                    // Fallback entries from PO data
                    ...(!(po.activity_log || po.history || []).length
                      ? [
                          {
                            color: 'blue',
                            children: (
                              <div>
                                <Text strong>PO Created</Text>
                                <br />
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {po.created_by_name || po.created_by || 'System'} - {formatDateTime(po.created_at)}
                                </Text>
                              </div>
                            ),
                          },
                          ...(po.approved_at
                            ? [{
                                color: 'green',
                                children: (
                                  <div>
                                    <Text strong>PO Approved</Text>
                                    <br />
                                    <Text type="secondary" style={{ fontSize: 12 }}>
                                      {po.approved_by_name || po.approved_by || 'System'} - {formatDateTime(po.approved_at)}
                                    </Text>
                                  </div>
                                ),
                              }]
                            : []),
                          ...(po.status === 'cancelled'
                            ? [{
                                color: 'red',
                                children: (
                                  <div>
                                    <Text strong>PO Cancelled</Text>
                                    <br />
                                    <Text type="secondary" style={{ fontSize: 12 }}>
                                      {po.cancelled_by_name || 'System'} - {formatDateTime(po.cancelled_at || po.updated_at)}
                                    </Text>
                                  </div>
                                ),
                              }]
                            : []),
                        ]
                      : []),
                  ]}
                />
              ),
            },
            // Wave 11.1 BUG_0092 — attachments tab on PO detail
            {
              key: 'attachments',
              label: <span><PaperClipOutlined /> Attachments</span>,
              children: (
                <AttachmentUploader
                  entityType="purchase_order"
                  entityId={id}
                  label="PO Document"
                />
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
};

export default PurchaseOrderForm;
