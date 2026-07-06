import React, { useEffect, useState, useCallback } from 'react';
import {
  App as AntApp, Button, Card, Col, Row, Space, Statistic, Table, Tag, Tooltip, Typography, Divider, Alert,
} from 'antd';
import {
  SyncOutlined, ReloadOutlined, InfoCircleOutlined, CheckCircleOutlined,
  CloseCircleOutlined, CloudSyncOutlined, TeamOutlined, SolutionOutlined,
} from '@ant-design/icons';
import PageHeader from '../../../components/PageHeader';
import api from '../../../config/api';
import { getErrorMessage } from '../../../utils/helpers';

const { Text, Title } = Typography;

const toArray = (data) => data?.items || data?.data || data || [];

const HRSyncDashboard = () => {
  const { message } = AntApp.useApp();

  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [lastSyncResult, setLastSyncResult] = useState(null);
  const [syncError, setSyncError] = useState(null);
  const [syncHistory, setSyncHistory] = useState([]);

  // DB counts
  const [dbEmployees, setDbEmployees] = useState(0);
  const [dbPositions, setDbPositions] = useState(0);
  const [dbProjects, setDbProjects] = useState(0);
  const [dbOffices, setDbOffices] = useState(0);
  const [loading, setLoading] = useState(false);

  // Known HR API source totals (verified from the actual API)
  const HR_SOURCE = { employees: 2802, positions: 3701 };

  // HR API source counts (updated from backend response if available)
  const [sourceCounts, setSourceCounts] = useState({
    employees: HR_SOURCE.employees,
    positions: HR_SOURCE.positions,
  });

  // Fetch current DB state
  const fetchDBCounts = useCallback(async () => {
    setLoading(true);
    try {
      const [empRes, posRes, projRes, offRes] = await Promise.allSettled([
        api.get('/masters/employees', { params: { page_size: 1 } }),
        api.get('/masters/positions', { params: { page_size: 1 } }),
        api.get('/masters/org-projects', { params: { page_size: 1 } }),
        api.get('/masters/offices', { params: { page_size: 1 } }),
      ]);

      const getTotal = (res) => {
        if (res.status !== 'fulfilled') return 0;
        const d = res.value.data;
        return d?.count || d?.total || d?.pagination?.total || toArray(d).length || 0;
      };

      setDbEmployees(getTotal(empRes));
      setDbPositions(getTotal(posRes));
      setDbProjects(getTotal(projRes));
      setDbOffices(getTotal(offRes));
    } catch (err) {
      console.error('Failed to fetch DB counts', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDBCounts();
  }, [fetchDBCounts]);

  // Fetch sync history
  const fetchSyncHistory = useCallback(async () => {
    try {
      // Try to get sync log from backend
      const res = await api.get('/masters/employees/sync-history', { params: { page_size: 10 } }).catch(() => null);
      if (res?.data) {
        setSyncHistory(toArray(res.data));
      }
    } catch {
      // Endpoint may not exist - that's ok
    }
  }, []);

  useEffect(() => {
    fetchSyncHistory();
  }, [fetchSyncHistory]);

  // Handle full sync
  const handleFullSync = async () => {
    setSyncing(true);
    setSyncError(null);
    setLastSyncResult(null);

    try {
      const res = await api.post('/masters/employees/sync-api', null, { timeout: 300000 });
      const task_id = res.data?.task_id;
      if (!task_id) {
        throw new Error('No sync task started from the server');
      }

      // Start polling
      const pollInterval = 3000; // 3 seconds
      const maxAttempts = 100; // 5 minutes total
      let attempts = 0;

      const runPoll = async () => {
        try {
          attempts++;
          if (attempts > maxAttempts) {
            throw new Error('Sync tracking timed out on client. The sync may still be running on the server.');
          }

          const statusRes = await api.get(`/masters/employees/sync-status/${task_id}`);
          const taskData = statusRes.data || {};

          if (taskData.status === 'completed') {
            const data = taskData.result || {};
            setLastSyncResult({
              success: true,
              fetched: data.fetched || 0,
              apiTotal: data.api_total || data.fetched || 0,
              created: data.created || 0,
              updated: data.updated || 0,
              linkedUsers: data.linked_users || 0,
              roleLinks: data.role_links_applied || 0,
              timestamp: new Date().toISOString(),
            });

            // Update source counts from response
            if (data.api_total) {
              setSourceCounts(prev => ({ ...prev, employees: data.api_total }));
            }
            if (data.positions_total) {
              setSourceCounts(prev => ({ ...prev, positions: data.positions_total }));
            }

            message.success(
              `HR sync completed. Fetched ${data.fetched || 0} of ${data.api_total || data.fetched || 0}. ` +
              `Created ${data.created || 0}, updated ${data.updated || 0}.`
            );

            // Refresh DB counts
            await fetchDBCounts();
            await fetchSyncHistory();
            setSyncing(false);
          } else if (taskData.status === 'failed') {
            throw new Error(taskData.error || 'Sync task failed on server');
          } else {
            // Still running or starting, schedule next poll
            setTimeout(runPoll, pollInterval);
          }
        } catch (pollErr) {
          const errMsg = getErrorMessage(pollErr);
          setSyncError(errMsg);
          setLastSyncResult({ success: false, error: errMsg, timestamp: new Date().toISOString() });
          message.error(errMsg);
          setSyncing(false);
        }
      };

      // Kick off the first poll
      setTimeout(runPoll, pollInterval);

    } catch (err) {
      const errMsg = getErrorMessage(err);
      setSyncError(errMsg);
      setLastSyncResult({ success: false, error: errMsg, timestamp: new Date().toISOString() });
      message.error(errMsg);
      setSyncing(false);
    }
  };

  // Sync result card
  const renderSyncResult = () => {
    if (!lastSyncResult) return null;

    return (
      <Card
        title={
          <Space>
            {lastSyncResult.success ? (
              <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 18 }} />
            ) : (
              <CloseCircleOutlined style={{ color: '#f5222d', fontSize: 18 }} />
            )}
            <span>Last Sync Result</span>
          </Space>
        }
        size="small"
        style={{ marginTop: 16 }}
      >
        {lastSyncResult.success ? (
          <Row gutter={[16, 8]}>
            <Col span={6}><Statistic title="Fetched" value={lastSyncResult.fetched} suffix={`/ ${lastSyncResult.apiTotal}`} /></Col>
            <Col span={6}><Statistic title="Created" value={lastSyncResult.created} valueStyle={{ color: '#52c41a' }} /></Col>
            <Col span={6}><Statistic title="Updated" value={lastSyncResult.updated} valueStyle={{ color: '#1677ff' }} /></Col>
            <Col span={6}><Statistic title="Linked Users" value={lastSyncResult.linkedUsers} /></Col>
          </Row>
        ) : (
          <Alert type="error" message="Sync Failed" description={lastSyncResult.error} showIcon />
        )}
        <div style={{ marginTop: 8, color: '#8c8c8c', fontSize: 12 }}>
          {new Date(lastSyncResult.timestamp).toLocaleString()}
        </div>
      </Card>
    );
  };

  const statCardStyle = { height: '100%' };

  return (
    <div>
      <PageHeader
        title="HR Sync Dashboard"
        subtitle="Sync employee and position data from HR API to SCM database"
      >
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchDBCounts} loading={loading}>
            Refresh Counts
          </Button>
          <Button
            type="primary"
            icon={<SyncOutlined />}
            loading={syncing}
            onClick={handleFullSync}
            size="large"
          >
            {syncing ? 'Syncing...' : 'Run Full HR Sync'}
          </Button>
        </Space>
      </PageHeader>

      {/* Quick Actions */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col span={24}>
          <Card size="small">
            <Space>
              <Text strong>Need a backend token for the CLI sync script?</Text>
              <Button size="small" onClick={() => {
                const token = localStorage.getItem('token');
                if (token) {
                  navigator.clipboard.writeText(token).then(() => {
                    message.success('Token copied to clipboard! Use: node scripts/sync-hr-api.js --token=<token>');
                  }).catch(() => {
                    message.info(`Token: ${token.slice(0, 20)}...${token.slice(-10)} (copy from localStorage)`);
                  });
                } else {
                  message.warning('No token found. Please log in first.');
                }
              }}>Copy JWT Token</Button>
              <Button size="small" onClick={() => {
                message.info(`Run: HR_API_KEY=sk_... BACKEND_TOKEN=<token> node scripts/sync-hr-api.js --backend=${window.location.origin}/api/v1`);
              }}>Show CLI Command</Button>
            </Space>
          </Card>
        </Col>
      </Row>

      {/* Source vs DB Comparison */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} md={6}>
          <Card style={statCardStyle}>
            <Statistic
              title={
                <Space>
                  <TeamOutlined />
                  <span>Employees (DB)</span>
                </Space>
              }
              value={dbEmployees}
              loading={loading}
              valueStyle={{ color: '#1677ff', fontSize: 32, fontWeight: 700 }}
              suffix={
                sourceCounts.employees ? (
                  <Text type="secondary" style={{ fontSize: 14 }}>
                    / {sourceCounts.employees} source
                  </Text>
                ) : null
              }
            />                <div style={{ marginTop: 8 }}>
                  {dbEmployees < HR_SOURCE.employees ? (
                    <Tag color="orange" icon={<InfoCircleOutlined />}>
                      {HR_SOURCE.employees - dbEmployees} missing
                    </Tag>
                  ) : (
                    <Tag color="green" icon={<CheckCircleOutlined />}>
                      All synced
                    </Tag>
                  )}
                </div>
          </Card>
        </Col>

        <Col xs={24} sm={12} md={6}>
          <Card style={statCardStyle}>
            <Statistic
              title={
                <Space>
                  <SolutionOutlined />
                  <span>Positions (DB)</span>
                </Space>
              }
              value={dbPositions}
              loading={loading}
              valueStyle={{ color: '#722ed1', fontSize: 32, fontWeight: 700 }}
              suffix={
                sourceCounts.positions ? (
                  <Text type="secondary" style={{ fontSize: 14 }}>
                    / {sourceCounts.positions} source
                  </Text>
                ) : null
              }
            />                <div style={{ marginTop: 8 }}>
                  {dbPositions < HR_SOURCE.positions ? (
                    <Tag color="orange" icon={<InfoCircleOutlined />}>
                      {HR_SOURCE.positions - dbPositions} missing
                    </Tag>
                  ) : (
                    <Tag color="green" icon={<CheckCircleOutlined />}>
                      All synced
                    </Tag>
                  )}
                </div>
          </Card>
        </Col>

        <Col xs={24} sm={12} md={6}>
          <Card style={statCardStyle}>
            <Statistic
              title={
                <Space>
                  <CloudSyncOutlined />
                  <span>Projects (DB)</span>
                </Space>
              }
              value={dbProjects}
              loading={loading}
              valueStyle={{ color: '#fa8c16', fontSize: 32, fontWeight: 700 }}
            />
          </Card>
        </Col>

        <Col xs={24} sm={12} md={6}>
          <Card style={statCardStyle}>
            <Statistic
              title={
                <Space>
                  <CloudSyncOutlined />
                  <span>Offices (DB)</span>
                </Space>
              }
              value={dbOffices}
              loading={loading}
              valueStyle={{ color: '#52c41a', fontSize: 32, fontWeight: 700 }}
            />
          </Card>
        </Col>
      </Row>

      {/* Sync Result */}
      {renderSyncResult()}

      {/* Divider */}
      <Divider />

      {/* Quick Info */}
      <Card title="Sync Information" size="small">
        <Row gutter={16}>
          <Col span={12}>
            <Text strong>HR API Source:</Text>
            <div style={{ marginTop: 4 }}>
              <Tag>http://103.174.161.68:8001/api/employees/</Tag>
            </div>
          </Col>
          <Col span={12}>
            <Text strong>Expected Totals:</Text>
            <div style={{ marginTop: 4 }}>
              <Space>
                <Tag icon={<TeamOutlined />} color="blue">2,802 Employees</Tag>
                <Tag icon={<SolutionOutlined />} color="purple">~3,701 Positions</Tag>
              </Space>
            </div>
          </Col>
        </Row>
        <div style={{ marginTop: 12 }}>
          <Alert
            type="info"
            message="After syncing, visit the Organization Structure page to view and manage all employees and positions."
            showIcon
          />
        </div>
      </Card>

      {/* Sync History */}
      {syncHistory.length > 0 && (
        <>
          <Divider />
          <Card title="Sync History" size="small">
            <Table
              dataSource={syncHistory}
              rowKey={(r) => r.id || r.timestamp || Math.random()}
              columns={[
                { title: 'Timestamp', dataIndex: 'created_at', key: 'ts', width: 180, render: (v) => v ? new Date(v).toLocaleString() : '-' },
                { title: 'Fetched', dataIndex: 'fetched', key: 'fetched', width: 100 },
                { title: 'Created', dataIndex: 'created', key: 'created', width: 100 },
                { title: 'Updated', dataIndex: 'updated', key: 'updated', width: 100 },
                { title: 'Linked Users', dataIndex: 'linked_users', key: 'linked_users', width: 120 },
                { title: 'Status', dataIndex: 'status', key: 'status', width: 100, render: (v) => <Tag color={v === 'success' ? 'green' : 'red'}>{v || 'N/A'}</Tag> },
              ]}
              pagination={{ pageSize: 5, showTotal: (t) => `${t} sync records` }}
              size="small"
            />
          </Card>
        </>
      )}
    </div>
  );
};

export default HRSyncDashboard;
