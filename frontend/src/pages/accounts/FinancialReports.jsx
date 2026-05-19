import React, { useState, useCallback } from 'react';
import {
  Card, Tabs, Table, DatePicker, Button, Space, Statistic, Row, Col, Tag, message, Spin, Empty,
} from 'antd';
import { ReloadOutlined, FileDoneOutlined, BankOutlined, DollarOutlined, AppstoreOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import api from '../../config/api';
import { formatCurrency, getErrorMessage } from '../../utils/helpers';

const { RangePicker } = DatePicker;

function TrialBalance() {
  const [asOf, setAsOf] = useState(dayjs());
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState({ rows: [], totals: { total_debit: 0, total_credit: 0, difference: 0 } });

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/accounts/reports/trial-balance', {
        params: { as_of: asOf.format('YYYY-MM-DD') },
      });
      setData(res.data || { rows: [], totals: {} });
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, [asOf]);

  React.useEffect(() => { fetch(); }, [fetch]);

  const cols = [
    { title: 'Code', dataIndex: 'account_code', width: 100 },
    { title: 'Account', dataIndex: 'account_name' },
    { title: 'Type', dataIndex: 'account_type', render: (t) => <Tag>{t}</Tag>, width: 100 },
    { title: 'Debit', dataIndex: 'total_debit', align: 'right', render: (v) => formatCurrency(v), width: 140 },
    { title: 'Credit', dataIndex: 'total_credit', align: 'right', render: (v) => formatCurrency(v), width: 140 },
    {
      title: 'Balance', dataIndex: 'balance', align: 'right', width: 140,
      render: (v) => <span style={{ fontWeight: 600 }}>{formatCurrency(v)}</span>,
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <DatePicker value={asOf} onChange={(v) => v && setAsOf(v)} />
        <Button type="primary" icon={<ReloadOutlined />} onClick={fetch} loading={loading}>Refresh</Button>
      </Space>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}><Card><Statistic title="Total Debit" value={data.totals?.total_debit || 0} prefix="₹" precision={2} /></Card></Col>
        <Col span={8}><Card><Statistic title="Total Credit" value={data.totals?.total_credit || 0} prefix="₹" precision={2} /></Card></Col>
        <Col span={8}>
          <Card>
            <Statistic
              title="Difference"
              value={data.totals?.difference || 0}
              prefix="₹"
              precision={2}
              valueStyle={{ color: Math.abs(data.totals?.difference || 0) < 0.01 ? '#52c41a' : '#ff4d4f' }}
            />
          </Card>
        </Col>
      </Row>
      <Card>
        <Table
          rowKey="account_id"
          loading={loading}
          dataSource={data.rows}
          columns={cols}
          pagination={{ pageSize: 50, showSizeChanger: false }}
          size="small"
        />
      </Card>
    </div>
  );
}

function ProfitLoss() {
  const [range, setRange] = useState([dayjs().startOf('year'), dayjs()]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);

  const fetch = useCallback(async () => {
    if (!range || range.length !== 2) return;
    setLoading(true);
    try {
      const res = await api.get('/accounts/reports/profit-loss', {
        params: { from_date: range[0].format('YYYY-MM-DD'), to_date: range[1].format('YYYY-MM-DD') },
      });
      setData(res.data);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, [range]);

  React.useEffect(() => { fetch(); }, [fetch]);

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <RangePicker value={range} onChange={setRange} />
        <Button type="primary" icon={<ReloadOutlined />} onClick={fetch} loading={loading}>Refresh</Button>
      </Space>
      {loading ? <Spin /> : data ? (
        <Row gutter={16}>
          <Col span={8}><Card><Statistic title="Total Income" value={data.total_income || 0} prefix="₹" precision={2} valueStyle={{ color: '#52c41a' }} /></Card></Col>
          <Col span={8}><Card><Statistic title="Total Expense" value={data.total_expense || 0} prefix="₹" precision={2} valueStyle={{ color: '#ff4d4f' }} /></Card></Col>
          <Col span={8}>
            <Card>
              <Statistic
                title="Net Profit / Loss"
                value={data.net_profit || 0}
                prefix="₹"
                precision={2}
                valueStyle={{ color: (data.net_profit || 0) >= 0 ? '#52c41a' : '#ff4d4f' }}
              />
            </Card>
          </Col>
        </Row>
      ) : <Empty />}
    </div>
  );
}

function BalanceSheet() {
  const [asOf, setAsOf] = useState(dayjs());
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/accounts/reports/balance-sheet', {
        params: { as_of: asOf.format('YYYY-MM-DD') },
      });
      setData(res.data);
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, [asOf]);

  React.useEffect(() => { fetch(); }, [fetch]);

  const sectionCols = [
    { title: 'Code', dataIndex: 'account_code', width: 100 },
    { title: 'Account', dataIndex: 'account_name' },
    { title: 'Balance', dataIndex: 'balance', align: 'right', render: (v) => formatCurrency(v), width: 160 },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <DatePicker value={asOf} onChange={(v) => v && setAsOf(v)} />
        <Button type="primary" icon={<ReloadOutlined />} onClick={fetch} loading={loading}>Refresh</Button>
      </Space>
      {loading ? <Spin /> : data ? (
        <Row gutter={16}>
          <Col span={12}>
            <Card title={`Assets — ${formatCurrency(data.totals?.total_assets || 0)}`}>
              <Table size="small" rowKey="account_id" dataSource={data.assets} columns={sectionCols} pagination={false} />
            </Card>
          </Col>
          <Col span={12}>
            <Card title={`Liabilities & Equity`} extra={<span>L: {formatCurrency(data.totals?.total_liabilities || 0)} • E: {formatCurrency((data.totals?.total_equity || 0) + (data.totals?.retained_earnings || 0))}</span>}>
              <h4>Liabilities</h4>
              <Table size="small" rowKey="account_id" dataSource={data.liabilities} columns={sectionCols} pagination={false} />
              <h4 style={{ marginTop: 16 }}>Equity</h4>
              <Table size="small" rowKey="account_id" dataSource={data.equity} columns={sectionCols} pagination={false} />
              <p style={{ marginTop: 12 }}>
                <strong>Retained Earnings (Income − Expense): </strong>
                {formatCurrency(data.totals?.retained_earnings || 0)}
              </p>
            </Card>
          </Col>
        </Row>
      ) : <Empty />}
    </div>
  );
}

function StockValuation() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState({ rows: [], totals: { total_qty: 0, total_value: 0 } });

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/accounts/reports/stock-valuation');
      setData(res.data || { rows: [], totals: {} });
    } catch (e) { message.error(getErrorMessage(e)); }
    finally { setLoading(false); }
  }, []);

  React.useEffect(() => { fetch(); }, [fetch]);

  const cols = [
    { title: 'Item Code', dataIndex: 'item_code', width: 140 },
    { title: 'Item', dataIndex: 'item_name' },
    { title: 'Total Qty', dataIndex: 'total_qty', align: 'right', render: (v) => v?.toLocaleString(), width: 120 },
    { title: 'Avg Rate', dataIndex: 'avg_rate', align: 'right', render: (v) => formatCurrency(v), width: 140 },
    { title: 'Total Value', dataIndex: 'total_value', align: 'right', render: (v) => <strong>{formatCurrency(v)}</strong>, width: 160 },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<ReloadOutlined />} onClick={fetch} loading={loading}>Refresh</Button>
      </Space>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={12}><Card><Statistic title="Total Stock Qty" value={data.totals?.total_qty || 0} precision={2} /></Card></Col>
        <Col span={12}><Card><Statistic title="Total Stock Value" value={data.totals?.total_value || 0} prefix="₹" precision={2} /></Card></Col>
      </Row>
      <Card>
        <Table
          rowKey="item_id"
          loading={loading}
          dataSource={data.rows}
          columns={cols}
          pagination={{ pageSize: 50, showSizeChanger: false }}
          size="small"
        />
      </Card>
    </div>
  );
}

export default function FinancialReports() {
  return (
    <div>
      <PageHeader
        title="Financial Reports"
        subtitle="Trial Balance, Profit & Loss, Balance Sheet, Stock Valuation"
      />
      <Tabs
        defaultActiveKey="tb"
        items={[
          { key: 'tb', label: <span><FileDoneOutlined /> Trial Balance</span>, children: <TrialBalance /> },
          { key: 'pl', label: <span><DollarOutlined /> Profit & Loss</span>, children: <ProfitLoss /> },
          { key: 'bs', label: <span><BankOutlined /> Balance Sheet</span>, children: <BalanceSheet /> },
          { key: 'sv', label: <span><AppstoreOutlined /> Stock Valuation</span>, children: <StockValuation /> },
        ]}
      />
    </div>
  );
}
