import React, { useState, useCallback, useEffect } from 'react';
import {
  Button, Select, Space, DatePicker, Card, Row, Col, Table, Tabs,
  Typography, message, Spin, Divider,
} from 'antd';
import {
  DownloadOutlined, PrinterOutlined, ReloadOutlined,
  BankOutlined, FileTextOutlined, ProjectOutlined,
} from '@ant-design/icons';
import { useRef } from 'react';
import { useReactToPrint } from 'react-to-print';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import StatCard from '../../components/StatCard';
import api from '../../config/api';
import {
  formatDate, formatCurrency, getErrorMessage, formatDateForAPI,
  downloadExcel,
} from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { Text } = Typography;
const { RangePicker } = DatePicker;

const Ledger = () => {
  const [activeTab, setActiveTab] = useState('vendor');
  const [loading, setLoading] = useState(false);

  // Selector state
  const [selectedEntity, setSelectedEntity] = useState(null);
  const [dateRange, setDateRange] = useState([dayjs().subtract(3, 'month'), dayjs()]);

  // Data
  const [ledgerEntries, setLedgerEntries] = useState([]);
  const [openingBalance, setOpeningBalance] = useState(0);
  const [closingBalance, setClosingBalance] = useState(0);
  const [totalDebit, setTotalDebit] = useState(0);
  const [totalCredit, setTotalCredit] = useState(0);

  // Lookups
  const [vendors, setVendors] = useState([]);
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [projects, setProjects] = useState([]);

  const printRef = useRef(null);
  const handlePrint = useReactToPrint({
    content: () => printRef.current,
    documentTitle: `ledger_${activeTab}_${dayjs().format('YYYYMMDD')}`,
  });

  const loadVendors = useCallback(async () => {
    try {
      const res = await api.get('/masters/vendors', { params: { page_size: 200 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setVendors(items.map((v) => ({
        label: `[${v.vendor_code || v.code}] ${v.name}`,
        value: v.id,
      })));
    } catch {
      // silent
    }
  }, []);

  const loadPurchaseOrders = useCallback(async () => {
    try {
      const res = await api.get('/procurement/purchase-orders', { params: { page_size: 200 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setPurchaseOrders(items.map((po) => ({
        label: `${po.po_number} - ${po.vendor_name || ''} (${formatCurrency(po.grand_total || 0)})`,
        value: po.id,
      })));
    } catch {
      // silent
    }
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const res = await api.get('/masters/projects', { params: { page_size: 200 } });
      const data = res.data;
      const items = data.items || data.data || data || [];
      setProjects(items.map((p) => ({
        label: p.name || p.project_name,
        value: p.id,
      })));
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    loadVendors();
    loadPurchaseOrders();
    loadProjects();
  }, [loadVendors, loadPurchaseOrders, loadProjects]);

  const fetchLedger = useCallback(async () => {
    if (!selectedEntity) {
      setLedgerEntries([]);
      setOpeningBalance(0);
      setClosingBalance(0);
      setTotalDebit(0);
      setTotalCredit(0);
      return;
    }

    setLoading(true);
    try {
      const params = {
        ledger_type: activeTab,
        entity_id: selectedEntity,
      };
      if (dateRange && dateRange[0]) {
        params.date_from = formatDateForAPI(dateRange[0]);
        params.date_to = formatDateForAPI(dateRange[1]);
      }

      const res = await api.get('/accounts/ledger', { params });
      const data = res.data;
      const entries = data.entries || data.items || data.data || data || [];
      const opening = data.opening_balance || 0;

      setOpeningBalance(opening);

      // Compute running balance
      let runningBalance = opening;
      const processedEntries = entries.map((entry, idx) => {
        const debit = entry.debit || 0;
        const credit = entry.credit || 0;
        runningBalance = runningBalance + debit - credit;
        return {
          ...entry,
          key: entry.id || idx,
          running_balance: runningBalance,
        };
      });

      setLedgerEntries(processedEntries);

      const totDebit = processedEntries.reduce((sum, e) => sum + (e.debit || 0), 0);
      const totCredit = processedEntries.reduce((sum, e) => sum + (e.credit || 0), 0);
      setTotalDebit(totDebit);
      setTotalCredit(totCredit);
      setClosingBalance(data.closing_balance != null ? data.closing_balance : opening + totDebit - totCredit);
    } catch (err) {
      message.error(getErrorMessage(err));
      setLedgerEntries([]);
    } finally {
      setLoading(false);
    }
  }, [activeTab, selectedEntity, dateRange]);

  useEffect(() => {
    if (selectedEntity) {
      fetchLedger();
    }
  }, [fetchLedger, selectedEntity]);

  const handleTabChange = (key) => {
    setActiveTab(key);
    setSelectedEntity(null);
    setLedgerEntries([]);
    setOpeningBalance(0);
    setClosingBalance(0);
    setTotalDebit(0);
    setTotalCredit(0);
  };

  const handleExport = () => {
    if (ledgerEntries.length === 0) {
      message.warning('No data to export');
      return;
    }
    const exportData = [
      { Date: '', Reference: '', Narration: 'Opening Balance', Debit: '', Credit: '', Balance: formatCurrency(openingBalance) },
      ...ledgerEntries.map((entry) => ({
        Date: formatDate(entry.posting_date || entry.date),
        Reference: entry.reference || entry.reference_number || '',
        Narration: entry.narration || entry.description || '',
        Debit: entry.debit || '',
        Credit: entry.credit || '',
        Balance: entry.running_balance,
      })),
      { Date: '', Reference: '', Narration: 'Closing Balance', Debit: totalDebit, Credit: totalCredit, Balance: closingBalance },
    ];
    downloadExcel(exportData, `ledger_${activeTab}_${dayjs().format('YYYYMMDD')}`, 'Ledger');
    message.success('Export completed');
  };

  const getEntityOptions = () => {
    if (activeTab === 'vendor') return vendors;
    if (activeTab === 'po') return purchaseOrders;
    if (activeTab === 'project') return projects;
    return [];
  };

  const getEntityPlaceholder = () => {
    if (activeTab === 'vendor') return 'Select vendor';
    if (activeTab === 'po') return 'Select purchase order';
    if (activeTab === 'project') return 'Select project';
    return 'Select...';
  };

  const ledgerColumns = [
    {
      title: 'Date',
      dataIndex: 'posting_date',
      key: 'posting_date',
      width: 120,
      render: (val, r) => formatDate(val || r.date),
    },
    {
      title: 'Reference',
      dataIndex: 'reference',
      key: 'reference',
      width: 180,
      render: (val, r) => val || r.reference_number || '-',
    },
    {
      title: 'Narration',
      dataIndex: 'narration',
      key: 'narration',
      ellipsis: true,
      render: (val, r) => val || r.description || '-',
    },
    {
      title: 'Debit',
      dataIndex: 'debit',
      key: 'debit',
      width: 140,
      align: 'right',
      render: (val) => val ? <Text style={{ color: '#f5222d' }}>{formatCurrency(val)}</Text> : '-',
    },
    {
      title: 'Credit',
      dataIndex: 'credit',
      key: 'credit',
      width: 140,
      align: 'right',
      render: (val) => val ? <Text style={{ color: '#52c41a' }}>{formatCurrency(val)}</Text> : '-',
    },
    {
      title: 'Balance',
      dataIndex: 'running_balance',
      key: 'running_balance',
      width: 150,
      align: 'right',
      render: (val) => (
        <Text strong style={{ color: val >= 0 ? '#eb2f96' : '#f5222d' }}>
          {formatCurrency(Math.abs(val))}
          {val < 0 ? ' Cr' : val > 0 ? ' Dr' : ''}
        </Text>
      ),
    },
  ];

  const tabItems = [
    { key: 'vendor', label: <span><BankOutlined /> By Vendor</span> },
    { key: 'po', label: <span><FileTextOutlined /> By PO</span> },
    { key: 'project', label: <span><ProjectOutlined /> By Project</span> },
  ];

  const netBalance = closingBalance;

  return (
    <div>
      <PageHeader title="Account Ledger" subtitle="View account ledger by vendor, PO, or project">
        <Space>
          <Button icon={<DownloadOutlined />} onClick={handleExport} disabled={ledgerEntries.length === 0}>
            Export to Excel
          </Button>
          <Button icon={<PrinterOutlined />} onClick={handlePrint} disabled={ledgerEntries.length === 0}>
            Print Ledger
          </Button>
        </Space>
      </PageHeader>

      <Card bodyStyle={{ paddingBottom: 0 }}>
        <Tabs
          activeKey={activeTab}
          onChange={handleTabChange}
          items={tabItems}
        />
      </Card>

      {/* Selector & Filters */}
      <Card style={{ marginTop: 16 }}>
        <Row gutter={16} align="middle">
          <Col span={10}>
            <Select
              placeholder={getEntityPlaceholder()}
              options={getEntityOptions()}
              showSearch
              optionFilterProp="label"
              allowClear
              style={{ width: '100%' }}
              value={selectedEntity}
              onChange={(v) => setSelectedEntity(v)}
            />
          </Col>
          <Col span={10}>
            <RangePicker
              value={dateRange}
              onChange={(v) => setDateRange(v)}
              format={DATE_FORMAT}
              style={{ width: '100%' }}
              allowClear
            />
          </Col>
          <Col span={4}>
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              onClick={fetchLedger}
              loading={loading}
              block
            >
              Load
            </Button>
          </Col>
        </Row>
      </Card>

      {/* Summary Cards */}
      {selectedEntity && (
        <Row gutter={16} style={{ marginTop: 16 }}>
          <Col span={8}>
            <StatCard
              icon={<span style={{ fontSize: 18 }}>Dr</span>}
              iconColor="#f5222d"
              iconBg="#fff1f0"
              value={formatCurrency(totalDebit)}
              label="Total Debit"
            />
          </Col>
          <Col span={8}>
            <StatCard
              icon={<span style={{ fontSize: 18 }}>Cr</span>}
              iconColor="#52c41a"
              iconBg="#f6ffed"
              value={formatCurrency(totalCredit)}
              label="Total Credit"
            />
          </Col>
          <Col span={8}>
            <StatCard
              icon={<span style={{ fontSize: 18 }}>=</span>}
              iconColor={netBalance >= 0 ? '#eb2f96' : '#f5222d'}
              iconBg={netBalance >= 0 ? '#e6f7ff' : '#fff1f0'}
              value={`${formatCurrency(Math.abs(netBalance))} ${netBalance < 0 ? 'Cr' : netBalance > 0 ? 'Dr' : ''}`}
              label="Net Balance"
            />
          </Col>
        </Row>
      )}

      {/* Ledger Table */}
      <div ref={printRef} style={{ marginTop: 16 }}>
        {loading ? (
          <Card>
            <div style={{ textAlign: 'center', padding: 60 }}>
              <Spin size="large" />
            </div>
          </Card>
        ) : selectedEntity ? (
          <Card>
            {/* Opening Balance */}
            <Table
              dataSource={ledgerEntries}
              columns={ledgerColumns}
              rowKey="key"
              pagination={false}
              size="middle"
              scroll={{ x: 900 }}
              bordered
              title={() => (
                <Row justify="space-between">
                  <Col>
                    <Text strong>Opening Balance:</Text>
                  </Col>
                  <Col>
                    <Text strong style={{ color: openingBalance >= 0 ? '#eb2f96' : '#f5222d' }}>
                      {formatCurrency(Math.abs(openingBalance))} {openingBalance < 0 ? 'Cr' : openingBalance > 0 ? 'Dr' : ''}
                    </Text>
                  </Col>
                </Row>
              )}
              summary={() => (
                <Table.Summary fixed>
                  <Table.Summary.Row style={{ background: '#fafafa' }}>
                    <Table.Summary.Cell index={0} colSpan={3}>
                      <Text strong>Totals</Text>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={1} align="right">
                      <Text strong style={{ color: '#f5222d' }}>{formatCurrency(totalDebit)}</Text>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={2} align="right">
                      <Text strong style={{ color: '#52c41a' }}>{formatCurrency(totalCredit)}</Text>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={3} align="right">
                      <Text strong style={{ color: closingBalance >= 0 ? '#eb2f96' : '#f5222d' }}>
                        {formatCurrency(Math.abs(closingBalance))} {closingBalance < 0 ? 'Cr' : closingBalance > 0 ? 'Dr' : ''}
                      </Text>
                    </Table.Summary.Cell>
                  </Table.Summary.Row>
                  <Table.Summary.Row style={{ background: '#e6f7ff' }}>
                    <Table.Summary.Cell index={0} colSpan={5}>
                      <Text strong>Closing Balance</Text>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={1} align="right">
                      <Text strong style={{ fontSize: 16, color: closingBalance >= 0 ? '#eb2f96' : '#f5222d' }}>
                        {formatCurrency(Math.abs(closingBalance))} {closingBalance < 0 ? 'Cr' : closingBalance > 0 ? 'Dr' : ''}
                      </Text>
                    </Table.Summary.Cell>
                  </Table.Summary.Row>
                </Table.Summary>
              )}
              locale={{
                emptyText: 'No ledger entries found for the selected period',
              }}
            />
          </Card>
        ) : (
          <Card>
            <div style={{ textAlign: 'center', padding: 60, color: '#bfbfbf' }}>
              <BankOutlined style={{ fontSize: 48, marginBottom: 16 }} />
              <div style={{ fontSize: 16 }}>
                Select a {activeTab === 'vendor' ? 'vendor' : activeTab === 'po' ? 'purchase order' : 'project'} and date range to view the ledger
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
};

export default Ledger;
