import React, { useState, useEffect } from 'react';
import {
  Card, Descriptions, Tabs, Table, Spin, Space, Button, message,
  Rate, Tag, Empty,
} from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import { formatCurrency, formatDate, getErrorMessage } from '../../utils/helpers';

const VendorDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [vendor, setVendor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('info');
  const [vendorItems, setVendorItems] = useState([]);
  const [vendorContracts, setVendorContracts] = useState([]);
  const [vendorRatings, setVendorRatings] = useState([]);
  const [vendorPOs, setVendorPOs] = useState([]);
  const [tabLoading, setTabLoading] = useState(false);

  useEffect(() => {
    if (id) fetchVendor();
  }, [id]);

  useEffect(() => {
    if (vendor && activeTab !== 'info') fetchTabData(activeTab);
  }, [activeTab, vendor]);

  const fetchVendor = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/masters/vendors/${id}`);
      setVendor(res.data);
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/masters/vendors');
    } finally {
      setLoading(false);
    }
  };

  const fetchTabData = async (tab) => {
    setTabLoading(true);
    try {
      if (tab === 'items') {
        const res = await api.get(`/masters/vendors/${id}/items`, { params: { page_size: 200 } });
        setVendorItems(res.data.items || res.data.data || res.data || []);
      } else if (tab === 'contracts') {
        const res = await api.get(`/masters/vendors/${id}/contracts`, { params: { page_size: 100 } });
        setVendorContracts(res.data.items || res.data.data || res.data || []);
      } else if (tab === 'ratings') {
        const res = await api.get(`/masters/vendors/${id}/ratings`, { params: { page_size: 100 } });
        setVendorRatings(res.data.items || res.data.data || res.data || []);
      } else if (tab === 'po_history') {
        const res = await api.get(`/masters/vendors/${id}/purchase-orders`, { params: { page_size: 100 } });
        setVendorPOs(res.data.items || res.data.data || res.data || []);
      }
    } catch { /* silent */ } finally {
      setTabLoading(false);
    }
  };

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 100 }}><Spin size="large" /></div>;
  }

  if (!vendor) {
    return <div><PageHeader title="Vendor Not Found" /><Empty /></div>;
  }

  return (
    <div>
      <PageHeader title={`${vendor.vendor_code} - ${vendor.name}`} subtitle="Vendor Detail">
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/masters/vendors')}>Back to Vendors</Button>
      </PageHeader>
      <Card>
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
          {
            key: 'info', label: 'Info',
            children: (
              <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
                <Descriptions.Item label="Vendor Code">{vendor.vendor_code}</Descriptions.Item>
                <Descriptions.Item label="Name">{vendor.name}</Descriptions.Item>
                <Descriptions.Item label="Contact">{vendor.contact_person || '-'}</Descriptions.Item>
                <Descriptions.Item label="Email">{vendor.email || '-'}</Descriptions.Item>
                <Descriptions.Item label="Phone">{vendor.phone || '-'}</Descriptions.Item>
                <Descriptions.Item label="Alt Phone">{vendor.alt_phone || '-'}</Descriptions.Item>
                <Descriptions.Item label="Address" span={2}>{[vendor.address_line1, vendor.address_line2].filter(Boolean).join(', ') || '-'}</Descriptions.Item>
                <Descriptions.Item label="City">{vendor.city || '-'}</Descriptions.Item>
                <Descriptions.Item label="State">{vendor.state || '-'}</Descriptions.Item>
                <Descriptions.Item label="Pincode">{vendor.pincode || '-'}</Descriptions.Item>
                <Descriptions.Item label="Country">{vendor.country || '-'}</Descriptions.Item>
                <Descriptions.Item label="GST">{vendor.gst_number || '-'}</Descriptions.Item>
                <Descriptions.Item label="PAN">{vendor.pan_number || '-'}</Descriptions.Item>
                <Descriptions.Item label="Bank">{vendor.bank_name || '-'}</Descriptions.Item>
                <Descriptions.Item label="Account">{vendor.bank_account || '-'}</Descriptions.Item>
                <Descriptions.Item label="IFSC">{vendor.bank_ifsc || '-'}</Descriptions.Item>
                <Descriptions.Item label="Payment Terms">{vendor.payment_terms_days ? `${vendor.payment_terms_days} days` : '-'}</Descriptions.Item>
                <Descriptions.Item label="Vendor Types">
                  {(vendor.vendor_types || []).length
                    ? <Space size={4} wrap>{vendor.vendor_types.map((t) => <Tag key={t.id}>{t.name}</Tag>)}</Space>
                    : vendor.vendor_type_name || vendor.vendor_type || '-'}
                </Descriptions.Item>
                <Descriptions.Item label="Vendor Category">{vendor.vendor_category_name || vendor.vendor_category?.name || '-'}</Descriptions.Item>
                <Descriptions.Item label="Credit Limit">{formatCurrency(vendor.credit_limit)}</Descriptions.Item>
                <Descriptions.Item label="Rating"><Rate disabled allowHalf value={vendor.rating || 0} /></Descriptions.Item>
                <Descriptions.Item label="Status"><StatusTag status={vendor.status} /></Descriptions.Item>
              </Descriptions>
            ),
          },
          {
            key: 'items', label: 'Items Supplied',
            children: (
              <Table dataSource={vendorItems} loading={tabLoading} rowKey={(r) => r.id || r.item_id} size="small"
                pagination={{ pageSize: 20, showSizeChanger: true }} scroll={{ x: 'max-content' }}
                columns={[
                  { title: 'Item Code', dataIndex: ['item', 'item_code'], key: 'code', render: (t, r) => t || r.item_code || '-' },
                  { title: 'Item Name', dataIndex: ['item', 'name'], key: 'name', render: (t, r) => t || r.item_name || '-' },
                  { title: 'Lead Time', dataIndex: 'lead_time_days', key: 'lt', render: (v) => v ? `${v} days` : '-' },
                  { title: 'Last Price', dataIndex: 'last_price', key: 'lp', align: 'right', render: (v) => formatCurrency(v) },
                  { title: 'Preferred', dataIndex: 'is_preferred', key: 'p', render: (v) => v ? <Tag color="green">Yes</Tag> : <Tag>No</Tag> },
                ]}
              />
            ),
          },
          {
            key: 'contracts', label: 'Contracts',
            children: (
              <Table dataSource={vendorContracts} loading={tabLoading} rowKey="id" size="small"
                pagination={{ pageSize: 20, showSizeChanger: true }} scroll={{ x: 'max-content' }}
                columns={[
                  { title: 'Contract No', dataIndex: 'contract_number', key: 'no' },
                  { title: 'Start Date', dataIndex: 'start_date', key: 'start', render: (v) => formatDate(v) },
                  { title: 'End Date', dataIndex: 'end_date', key: 'end', render: (v) => formatDate(v) },
                  { title: 'Value', dataIndex: 'contract_value', key: 'val', align: 'right', render: (v) => formatCurrency(v) },
                  { title: 'Status', dataIndex: 'status', key: 'st', render: (s) => <StatusTag status={s} /> },
                ]}
              />
            ),
          },
          {
            key: 'ratings', label: 'Ratings',
            children: (
              <Table dataSource={vendorRatings} loading={tabLoading} rowKey="id" size="small"
                pagination={{ pageSize: 20, showSizeChanger: true }} scroll={{ x: 'max-content' }}
                columns={[
                  { title: 'Date', dataIndex: 'rating_date', key: 'date', render: (v) => formatDate(v) },
                  { title: 'Criteria', dataIndex: 'criteria', key: 'crit' },
                  { title: 'Score', dataIndex: 'score', key: 'score', render: (v) => <Rate disabled allowHalf value={v || 0} style={{ fontSize: 14 }} /> },
                  { title: 'Remarks', dataIndex: 'remarks', key: 'rem', ellipsis: true },
                ]}
              />
            ),
          },
          {
            key: 'po_history', label: 'PO History',
            children: (
              <Table dataSource={vendorPOs} loading={tabLoading} rowKey="id" size="small"
                pagination={{ pageSize: 20, showSizeChanger: true }} scroll={{ x: 'max-content' }}
                columns={[
                  { title: 'PO Number', dataIndex: 'po_number', key: 'po' },
                  { title: 'Date', dataIndex: 'po_date', key: 'date', render: (v) => formatDate(v) },
                  { title: 'Amount', dataIndex: 'total_amount', key: 'amt', align: 'right', render: (v) => formatCurrency(v) },
                  { title: 'Status', dataIndex: 'status', key: 'st', render: (s) => <StatusTag status={s} /> },
                ]}
              />
            ),
          },
        ]} />
      </Card>
    </div>
  );
};

export default VendorDetail;
