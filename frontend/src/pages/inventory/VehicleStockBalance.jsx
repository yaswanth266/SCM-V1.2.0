import React, { useState, useCallback, useEffect } from 'react';
import { Button, Card, Row, Col, Select, Input, Table, Tag, Typography, Space, message, Tooltip } from 'antd';
import { SearchOutlined, DownloadOutlined, FilePdfOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import api from '../../config/api';
import { formatCurrency, formatNumber, getErrorMessage, formatDateTime, exportVehicleStockToExcel, printVehicleStockToPDF } from '../../utils/helpers';

const { Text } = Typography;

const VehicleStockBalance = () => {
  const [filterVehicle, setFilterVehicle] = useState('');
  const [filterItem, setFilterItem] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [vehicleOptions, setVehicleOptions] = useState([]);

  // Fetch unique vehicles for filter dropdown
  useEffect(() => {
    const fetchVehicles = async () => {
      try {
        const res = await api.get('/masters/vehicles', { params: { is_active: true, limit: 100 } });
        setVehicleOptions((res.data || []).map((v) => ({
          label: `${v.vehicle_code} (${v.vehicle_number})`,
          value: v.vehicle_code,
        })));
      } catch {
        // silent
      }
    };
    fetchVehicles();
  }, []);

  const fetchRecords = useCallback(
    async (params) => {
      const qp = { ...params };
      if (filterVehicle) qp.vehicle_code = filterVehicle;
      if (filterItem) qp.search = filterItem;
      return await api.get('/inventory/vehicle-stock-balance', { params: qp });
    },
    [filterVehicle, filterItem]
  );

  const handleExportExcel = async () => {
    try {
      const res = await api.get('/inventory/vehicle-stock-balance', {
        params: {
          page_size: 10000,
          vehicle_code: filterVehicle || undefined,
          search: filterItem || undefined,
        },
      });
      const data = res.data?.items || res.data || [];
      exportVehicleStockToExcel(data);
      message.success('Vehicle Stock Balance exported to Excel successfully');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleExportPDF = async () => {
    try {
      const res = await api.get('/inventory/vehicle-stock-balance', {
        params: {
          page_size: 10000,
          vehicle_code: filterVehicle || undefined,
          search: filterItem || undefined,
        },
      });
      const data = res.data?.items || res.data || [];
      printVehicleStockToPDF(data);
      message.success('Vehicle Stock Balance PDF report opened successfully');
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const columns = [
    {
      title: 'Vehicle Code',
      dataIndex: 'vehicle_code',
      key: 'vehicle_code',
      width: 140,
      sorter: true,
    },
    {
      title: 'Vehicle Number',
      dataIndex: 'vehicle_number',
      key: 'vehicle_number',
      width: 140,
      render: (v) => v || '-',
    },
    {
      title: 'Item Code',
      dataIndex: 'item_code',
      key: 'item_code',
      width: 150,
      sorter: true,
    },
    {
      title: 'Item Name',
      dataIndex: 'item_name',
      key: 'item_name',
      width: 220,
      ellipsis: true,
    },
    {
      title: 'Quantity',
      dataIndex: 'qty',
      key: 'qty',
      width: 120,
      align: 'right',
      sorter: true,
      render: (v) => <Text strong>{formatNumber(v || 0)}</Text>,
    },
    {
      title: 'UOM',
      dataIndex: 'uom_name',
      key: 'uom',
      width: 100,
      render: (v) => v || '-',
    },
    {
      title: 'Valuation Rate',
      dataIndex: 'valuation_rate',
      key: 'valuation_rate',
      width: 130,
      align: 'right',
      render: (v) => formatCurrency(v || 0),
    },
    {
      title: 'Stock Value',
      key: 'stock_value',
      width: 140,
      align: 'right',
      render: (_, r) => formatCurrency((r.qty || 0) * (r.valuation_rate || 0)),
    },
    {
      title: 'Last Updated',
      dataIndex: 'last_updated',
      key: 'last_updated',
      width: 160,
      render: (v) => formatDateTime(v),
    },
    {
      title: 'Serial / Asset Codes',
      key: 'serial_numbers',
      width: 220,
      render: (_, r) => {
        const codes = r.asset_codes && r.asset_codes.length > 0
          ? r.asset_codes
          : (r.consumable_codes && r.consumable_codes.length > 0 ? r.consumable_codes : r.serial_numbers);
        if (!codes || codes.length === 0) return '-';
        return (
          <Tooltip title={codes.join(', ')}>
            <div style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {codes.map((s) => <Tag key={s} color={r.asset_codes?.length ? 'cyan' : (r.consumable_codes?.length ? 'purple' : 'blue')}>{s}</Tag>)}
            </div>
          </Tooltip>
        );
      }
    },
  ];

  const toolbar = (
    <Space style={{ marginLeft: 12 }} wrap>
      <Select
        placeholder="Select Vehicle"
        allowClear
        showSearch
        optionFilterProp="label"
        style={{ width: 220 }}
        value={filterVehicle}
        onChange={(v) => { setFilterVehicle(v); setRefreshKey((k) => k + 1); }}
        options={vehicleOptions}
      />
      <Input
        placeholder="Search by Item Code/Name"
        allowClear
        prefix={<SearchOutlined />}
        style={{ width: 240 }}
        value={filterItem}
        onChange={(e) => setFilterItem(e.target.value)}
        onPressEnter={() => setRefreshKey((k) => k + 1)}
      />
      <Button type="primary" onClick={() => setRefreshKey((k) => k + 1)}>
        Apply Filters
      </Button>
    </Space>
  );

  return (
    <div style={{ padding: '24px' }}>
      <PageHeader title="Vehicle Stock Balance" subtitle="View and track materials currently stored in vehicles">
        <Space>
          <Button type="primary" icon={<DownloadOutlined />} onClick={handleExportExcel}>
            Export to Excel
          </Button>
          <Button type="primary" style={{ backgroundColor: '#0d9488', borderColor: '#0d9488' }} icon={<FilePdfOutlined />} onClick={handleExportPDF}>
            Print / Export PDF
          </Button>
        </Space>
      </PageHeader>

      <DataTable
        key={refreshKey}
        columns={columns}
        fetchFunction={fetchRecords}
        rowKey={(r) => r.id}
        searchPlaceholder="Filter items..."
        exportFileName="vehicle_stock_balance"
        toolbar={toolbar}
        scroll={{ x: 1200 }}
      />
    </div>
  );
};

export default VehicleStockBalance;
