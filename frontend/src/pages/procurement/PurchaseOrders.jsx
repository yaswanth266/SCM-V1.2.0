import React, { useState, useEffect, useCallback } from 'react';
import {
  Button, Select, Space, Popconfirm, message, Tag, Typography, Tooltip
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, EyeOutlined,
  SendOutlined, CheckOutlined, CloseCircleOutlined,
  DownloadOutlined, HistoryOutlined
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import StatusTag from '../../components/StatusTag';
import api from '../../config/api';
import {
  formatDate, formatCurrency, getErrorMessage, downloadExcel
} from '../../utils/helpers';

const { Text } = Typography;

const PurchaseOrders = () => {
  const navigate = useNavigate();
  const [refreshKey, setRefreshKey] = useState(0);

  // Filters
  const [filterStatus, setFilterStatus] = useState(undefined);
  const [filterVendor, setFilterVendor] = useState(undefined);
  const [vendors, setVendors] = useState([]);

  useEffect(() => {
    // Clear query parameter from URL if redirected with edit_id
    const params = new URLSearchParams(window.location.search);
    const editId = params.get('edit_id');
    if (editId) {
      const newUrl = window.location.pathname;
      window.history.replaceState({}, document.title, newUrl);
      navigate(`/procurement/purchase-orders/${editId}/edit`);
    }
    loadLookups();
  }, []);

  const loadLookups = async () => {
    try {
      const res = await api.get('/masters/vendors', { params: { page_size: 200, status: 'active' } });
      const items = res.data?.items || res.data?.data || res.data || [];
      setVendors(items.map((v) => ({
        label: `[${v.vendor_code}] ${v.name}`,
        value: v.id,
      })));
    } catch { /* silent */ }
  };

  const fetchPOs = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterStatus) qp.status = filterStatus;
      if (filterVendor) qp.vendor_id = filterVendor;
      return await api.get('/procurement/purchase-orders', { params: qp });
    },
    [filterStatus, filterVendor]
  );

  const handleAdd = () => {
    navigate('/procurement/purchase-orders/new');
  };

  const handleEdit = (record) => {
    navigate(`/procurement/purchase-orders/${record.id}/edit`);
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/procurement/purchase-orders/${id}`);
      message.success('Purchase Order deleted');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleApprove = async (id) => {
    try {
      await api.post(`/procurement/purchase-orders/${id}/approve`);
      message.success('Purchase Order approved');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleCancel = async (id) => {
    try {
      await api.post(`/procurement/purchase-orders/${id}/cancel`);
      message.success('Purchase Order cancelled');
      setRefreshKey((k) => k + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleExport = async () => {
    try {
      const res = await api.get('/procurement/purchase-orders', { params: { page_size: 10000 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      const exportData = items.map((po) => ({
        'PO Number': po.po_number,
        'Vendor': po.vendor_name || '',
        'PO Date': formatDate(po.po_date),
        'Expected Delivery': formatDate(po.expected_delivery_date),
        'Grand Total': po.grand_total || 0,
        'Status': po.status,
      }));
      downloadExcel(exportData, 'purchase_orders', 'Purchase Orders');
      message.success('Export completed');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'Version',
      dataIndex: 'version_number',
      key: 'version',
      width: 90,
      render: (v, record) => (
        <Tag
          color={record.is_history_row ? 'default' : 'blue'}
          style={{ fontFamily: 'monospace', fontSize: 11 }}
        >
          {record.is_history_row ? <HistoryOutlined style={{ marginRight: 3 }} /> : null}
          v{v || '1.0'}
        </Tag>
      ),
    },
    {
      title: 'PO Number',
      dataIndex: 'po_number',
      key: 'po_number',
      width: 200,
      sorter: true,
      fixed: 'left',
      render: (text, record) => (
        <a
          onClick={() => navigate(`/procurement/purchase-orders/${record.id}`)}
          style={{ color: record.is_history_row ? '#888' : undefined }}
        >
          {text}
        </a>
      ),
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
      title: 'PO Date',
      dataIndex: 'po_date',
      key: 'po_date',
      width: 120,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Expected Delivery',
      dataIndex: 'expected_delivery_date',
      key: 'delivery',
      width: 140,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Supplier Delivery Date',
      dataIndex: 'supplier_delivery_date',
      key: 'supplier_delivery_date',
      width: 140,
      sorter: true,
      render: (v) => formatDate(v),
    },
    {
      title: 'Grand Total',
      dataIndex: 'grand_total',
      key: 'grand_total',
      width: 140,
      align: 'right',
      sorter: true,
      render: (v) => <Text strong>{formatCurrency(v)}</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 140,
      render: (s) => <StatusTag status={s} />,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 180,
      fixed: 'right',
      render: (_, record) => {
        if (record.is_history_row) {
          return (
            <Tooltip title="Read-only — this is a previous version">
              <Tag color="default" style={{ fontSize: 11 }}>Archived</Tag>
            </Tooltip>
          );
        }
        return (
          <Space size="small">
            <Button
              type="link"
              size="small"
              icon={<EyeOutlined />}
              onClick={() => navigate(`/procurement/purchase-orders/${record.id}`)}
            />
            {record.status === 'draft' && (
              <>
                <Button type="link" size="small" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
                <Tooltip title="Submit for Approval">
                  <Popconfirm title="Submit PO for approval?" onConfirm={async () => {
                    try {
                      await api.post(`/procurement/purchase-orders/${record.id}/submit`);
                      message.success('PO submitted for approval');
                      setRefreshKey((k) => k + 1);
                    } catch (err) { message.error(getErrorMessage(err)); }
                  }}>
                    <Button type="link" size="small" icon={<SendOutlined />} />
                  </Popconfirm>
                </Tooltip>
                <Popconfirm title="Delete this PO?" onConfirm={() => handleDelete(record.id)} okButtonProps={{ danger: true }}>
                  <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </>
            )}
            {record.status === 'pending_approval' && (
              <>
                <Tooltip title="Approve">
                  <Popconfirm title="Approve this PO?" onConfirm={() => handleApprove(record.id)}>
                    <Button type="link" size="small" style={{ color: '#52c41a' }} icon={<CheckOutlined />} />
                  </Popconfirm>
                </Tooltip>
                <Popconfirm title="Cancel this PO?" onConfirm={() => handleCancel(record.id)} okButtonProps={{ danger: true }}>
                  <Button type="link" size="small" danger icon={<CloseCircleOutlined />} />
                </Popconfirm>
              </>
            )}
          </Space>
        );
      },
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }}>
      <Select
        placeholder="Status"
        allowClear
        style={{ width: 160 }}
        value={filterStatus}
        onChange={(v) => { setFilterStatus(v); setRefreshKey((k) => k + 1); }}
        options={[
          { label: 'Draft', value: 'draft' },
          { label: 'Pending Approval', value: 'pending_approval' },
          { label: 'Approved', value: 'approved' },
          { label: 'Accepted by Supplier', value: 'accepted' },
          { label: 'Rejected by Supplier', value: 'rejected' },
          { label: 'Partially Received', value: 'partially_received' },
          { label: 'Received', value: 'received' },
          { label: 'Closed', value: 'closed' },
          { label: 'Cancelled', value: 'cancelled' },
        ]}
      />
      <Select
        placeholder="Vendor"
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ width: 200 }}
        value={filterVendor}
        onChange={(v) => { setFilterVendor(v); setRefreshKey((k) => k + 1); }}
        options={vendors}
      />
    </Space>
  );

  return (
    <div>
      <PageHeader title="Purchase Orders" subtitle="Manage purchase orders">
        <Space>
          <Button icon={<DownloadOutlined />} onClick={handleExport}>Export</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>Create PO</Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchPOs}
        rowKey="id"
        searchPlaceholder="Search by PO number or vendor..."
        exportFileName="purchase_orders"
        toolbar={toolbar}
        scroll={{ x: 1500 }}
        onRow={(record) => ({
          style: record.is_history_row
            ? { background: '#fafafa', color: '#8c8c8c' }
            : {},
        })}
      />
    </div>
  );
};

export default PurchaseOrders;
