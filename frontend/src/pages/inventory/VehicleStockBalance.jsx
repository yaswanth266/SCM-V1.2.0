import React, { useState, useCallback, useEffect } from 'react';
import { Button, Card, Row, Col, Select, Input, Table, Tag, Typography, Space, message, Tooltip, Popover, List, Modal } from 'antd';
import { SearchOutlined, DownloadOutlined, FilePdfOutlined, BarcodeOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import BarcodeDisplay from '../../components/BarcodeDisplay';
import api from '../../config/api';
import { formatCurrency, formatNumber, getErrorMessage, formatDateTime, exportVehicleStockToExcel, printVehicleStockToPDF } from '../../utils/helpers';

const { Text } = Typography;

const VehicleStockBalance = () => {
  const [filterVehicle, setFilterVehicle] = useState(undefined);
  const [filterItem, setFilterItem] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [vehicleOptions, setVehicleOptions] = useState([]);

  // Barcode / QR display states
  const [barcodeDisplayOpen, setBarcodeDisplayOpen] = useState(false);
  const [barcodeDisplayVal, setBarcodeDisplayVal] = useState('');
  const [barcodeDisplayQRVal, setBarcodeDisplayQRVal] = useState('');
  const [barcodeDisplayLabel, setBarcodeDisplayLabel] = useState('');
  const [barcodeDisplaySub, setBarcodeDisplaySub] = useState('');

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
      title: 'Asset/Consumable Code',
      key: 'asset_codes',
      width: 160,
      render: (_, record) => {
        const isAsset = record.item_type === 'asset';
        const isConsumable = record.item_type === 'consumable';
        const list = (record.asset_codes && record.asset_codes.length > 0)
          ? record.asset_codes
          : ((record.consumable_codes && record.consumable_codes.length > 0)
            ? record.consumable_codes
            : (record.serial_numbers || []));

        if (!list || list.length === 0) return <Text type="secondary">-</Text>;

        const popoverTitle = isAsset ? "Asset Codes" : (isConsumable ? "Consumable Codes" : "Serial / Asset Codes");
        const popoverContent = (
          <div style={{ maxHeight: 200, overflowY: 'auto', minWidth: 200 }}>
            <List
              size="small"
              dataSource={list}
              renderItem={(code) => (
                <List.Item 
                  style={{ padding: '4px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <Tag color={isAsset ? "cyan" : (isConsumable ? "orange" : "blue")}>{code}</Tag>
                  <Tooltip title="View Barcode / QR Code">
                    <Button 
                      type="text" 
                      size="small" 
                      icon={<BarcodeOutlined style={{ color: '#1890ff' }} />} 
                      onClick={() => {
                        setBarcodeDisplayVal(code);
                        setBarcodeDisplayLabel(record.item_name || '');
                        setBarcodeDisplaySub(`${record.item_code || ''} | Vehicle: ${record.vehicle_code || '-'}`);
                        setBarcodeDisplayQRVal(`Code: ${code}\nVehicle Code: ${record.vehicle_code || '-'}\nVehicle Number: ${record.vehicle_number || '-'}\nItem Code: ${record.item_code || '-'}\nItem Name: ${record.item_name || '-'}`);
                        setBarcodeDisplayOpen(true);
                      }} 
                    />
                  </Tooltip>
                </List.Item>
              )}
            />
          </div>
        );

        return (
          <Popover
            content={popoverContent}
            title={popoverTitle}
            trigger="click"
            placement="bottom"
          >
            <Button type="link" size="small" style={{ padding: 0 }}>
              View ({list.length})
            </Button>
          </Popover>
        );
      },
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

      {/* Barcode / QR Code Viewer Modal */}
      <Modal
        title="Barcode / QR Code Viewer"
        open={barcodeDisplayOpen}
        onCancel={() => setBarcodeDisplayOpen(false)}
        footer={[
          <Button key="close" onClick={() => setBarcodeDisplayOpen(false)}>Close</Button>
        ]}
        width={360}
        centered
        destroyOnClose
      >
        <div style={{ display: 'flex', justifyContent: 'center', padding: '20px 0' }}>
          <BarcodeDisplay
            value={barcodeDisplayVal}
            qrValue={barcodeDisplayQRVal}
            type="CODE128"
            label={barcodeDisplayLabel}
            subtitle={barcodeDisplaySub}
            height={80}
            qrSize={140}
          />
        </div>
      </Modal>
    </div>
  );
};

export default VehicleStockBalance;
