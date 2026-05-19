import React, { useEffect, useState, useCallback } from 'react';
import { Card, Tree, Button, Tag, message, Modal, Empty, Space, Spin, Row, Col, Typography } from 'antd';
import { ReloadOutlined, ApartmentOutlined, ThunderboltOutlined } from '@ant-design/icons';
import PageHeader from '../../components/PageHeader';
import StatCard from '../../components/StatCard';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const { Text } = Typography;

const TYPE_COLORS = {
  asset: 'green',
  liability: 'red',
  equity: 'blue',
  income: 'cyan',
  expense: 'orange',
};

function toTreeData(nodes) {
  return nodes.map((n) => ({
    key: `acc-${n.id}`,
    title: (
      <span>
        <Text strong>{n.code}</Text> &nbsp;{n.name}{' '}
        <Tag color={TYPE_COLORS[n.type] || 'default'} style={{ marginLeft: 8 }}>{n.type}</Tag>
        {n.is_group ? <Tag>group</Tag> : null}
      </span>
    ),
    children: n.children && n.children.length ? toTreeData(n.children) : undefined,
  }));
}

export default function ChartOfAccounts() {
  const [loading, setLoading] = useState(false);
  const [tree, setTree] = useState([]);
  const [seedConfirm, setSeedConfirm] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const fetchTree = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/accounts/chart-of-accounts/tree');
      setTree(res.data || []);
    } catch (e) {
      message.error(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTree(); }, [fetchTree]);

  const seedCoA = async () => {
    setSeeding(true);
    try {
      const res = await api.post('/accounts/seed-coa');
      const d = res.data || {};
      message.success(
        `Seeded ${d.accounts_inserted} accounts (${d.accounts_skipped} skipped) and ${d.mappings_inserted} mappings (${d.mappings_skipped} skipped).`
      );
      setSeedConfirm(false);
      fetchTree();
    } catch (e) {
      message.error(getErrorMessage(e));
    } finally {
      setSeeding(false);
    }
  };

  const total = tree.reduce(function counter(acc, n) {
    return acc + 1 + (n.children || []).reduce(counter, 0);
  }, 0);

  const byType = {};
  function walk(n) {
    byType[n.type] = (byType[n.type] || 0) + 1;
    (n.children || []).forEach(walk);
  }
  tree.forEach(walk);

  return (
    <div>
      <PageHeader
        title="Chart of Accounts"
        subtitle="Browse and configure your General Ledger account hierarchy"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchTree} loading={loading}>Refresh</Button>
            <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => setSeedConfirm(true)}>
              Seed Default Chart
            </Button>
          </Space>
        }
      />

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={12} md={4}><StatCard title="Total Accounts" value={total} icon={<ApartmentOutlined />} /></Col>
        <Col xs={12} sm={6} md={4}><StatCard title="Assets" value={byType.asset || 0} valueStyle={{ color: '#52c41a' }} /></Col>
        <Col xs={12} sm={6} md={4}><StatCard title="Liabilities" value={byType.liability || 0} valueStyle={{ color: '#ff4d4f' }} /></Col>
        <Col xs={12} sm={6} md={4}><StatCard title="Equity" value={byType.equity || 0} valueStyle={{ color: '#1890ff' }} /></Col>
        <Col xs={12} sm={6} md={4}><StatCard title="Income" value={byType.income || 0} valueStyle={{ color: '#13c2c2' }} /></Col>
        <Col xs={12} sm={6} md={4}><StatCard title="Expenses" value={byType.expense || 0} valueStyle={{ color: '#fa8c16' }} /></Col>
      </Row>

      <Card>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
        ) : tree.length === 0 ? (
          <Empty
            description="No accounts yet — click 'Seed Default Chart' to create the standard Indian healthcare CoA"
          />
        ) : (
          <Tree
            showLine
            defaultExpandAll
            treeData={toTreeData(tree)}
            blockNode
          />
        )}
      </Card>

      <Modal
        title="Seed Default Chart of Accounts?"
        open={seedConfirm}
        onCancel={() => setSeedConfirm(false)}
        onOk={seedCoA}
        confirmLoading={seeding}
        okText="Seed"
      >
        <p>This creates the standard Indian healthcare/SCM chart:</p>
        <ul>
          <li>Assets (Cash, Bank, AR, GST Input, Pharmacy/Consumable/Surgical/General Stock, Fixed Assets)</li>
          <li>Liabilities (AP, GR-IR Clearing, GST Output, TDS, Salaries Payable)</li>
          <li>Equity (Share Capital, Retained Earnings)</li>
          <li>Income (Sales, Other)</li>
          <li>COGS (Pharmacy/Consumables/Surgical/Adjustment/Write-off)</li>
          <li>Operating Expenses (Salaries, Rent, Utilities, Freight, Office)</li>
        </ul>
        <p>Plus 7 default GL mappings (GRN, Invoice, Payment, Issue, Return, Consumption, Opening Stock).</p>
        <p><Text type="secondary">Idempotent — running again only adds what's missing.</Text></p>
      </Modal>
    </div>
  );
}
