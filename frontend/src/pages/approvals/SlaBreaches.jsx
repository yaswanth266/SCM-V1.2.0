import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card, Table, Button, Tag, Space, message, Tooltip, Modal, Empty, Spin,
} from 'antd';
import {
  ReloadOutlined, ThunderboltOutlined, ClockCircleOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons';
import api from '../../config/api';
import { formatDateTime, getErrorMessage } from '../../utils/helpers';
import useAuthStore from '../../store/authStore';

const SlaBreaches = () => {
  const navigate = useNavigate();
  const { hasPermission } = useAuthStore();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);

  const fetchBreaches = async () => {
    setLoading(true);
    try {
      const res = await api.get('/approvals/sla-breaches');
      setRows(res.data?.results || []);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchBreaches(); }, []);

  const handleRun = async (dryRun) => {
    setRunning(true);
    try {
      const res = await api.post('/approvals/process-escalations', {
        dry_run: dryRun,
      });
      const { scanned, escalated, skipped_no_target } = res.data;
      Modal.info({
        title: dryRun ? 'Dry-run summary' : 'Escalation pass complete',
        content: (
          <div style={{ lineHeight: 1.7 }}>
            Breached requests scanned: <b>{scanned}</b><br />
            Escalated{dryRun ? ' (would be)' : ''}: <b>{escalated}</b><br />
            Skipped (no escalation target configured): <b>{skipped_no_target}</b>
          </div>
        ),
      });
      fetchBreaches();
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const renderOverdue = (h) => {
    let color = 'green';
    if (h > 24) color = 'red';
    else if (h > 4) color = 'orange';
    return (
      <Tag color={color} style={{ fontFamily: 'monospace', fontWeight: 600 }}>
        {h.toFixed(1)} h overdue
      </Tag>
    );
  };

  const columns = [
    {
      title: 'Document',
      render: (_, r) => (
        <span style={{ fontFamily: 'monospace', fontSize: 12.5 }}>
          {r.document_number || `${r.document_type}-${r.document_id}`}
        </span>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'document_type',
      render: (t) => <Tag color="purple">{t}</Tag>,
    },
    {
      title: 'Requester',
      dataIndex: 'requested_by_name',
      render: (n, r) => n || `User #${r.requested_by}`,
    },
    {
      title: 'Submitted',
      render: (_, r) => (
        <Tooltip title={r.requested_at}>
          <span>{formatDateTime(r.requested_at)}</span>
        </Tooltip>
      ),
    },
    {
      title: 'Level',
      dataIndex: 'current_level',
      width: 70,
      render: (l) => <Tag color="blue">L{l}</Tag>,
    },
    {
      title: 'SLA',
      dataIndex: 'sla_hours',
      width: 80,
      render: (h) => `${h}h`,
    },
    {
      title: 'Overdue',
      dataIndex: 'overdue_hours',
      render: (h) => renderOverdue(h),
    },
    {
      title: 'Escalation target',
      render: (_, r) =>
        r.escalation_user_id
          ? <span>{r.escalation_user_name || `User #${r.escalation_user_id}`}</span>
          : <Tag color="default">Not configured</Tag>,
    },
    {
      title: 'Status',
      render: (_, r) =>
        r.already_escalated_to
          ? (
            <Tooltip title={`Routed at ${r.escalated_at}`}>
              <Tag color="green">
                Escalated → {r.already_escalated_to_name || `User #${r.already_escalated_to}`}
                {r.escalation_count > 1 && ` (×${r.escalation_count})`}
              </Tag>
            </Tooltip>
          )
          : <Tag color="red">Not yet bumped</Tag>,
    },
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>SLA Breaches</h2>
          <div style={{ color: '#7A6D66', fontSize: 13 }}>
            Pending approvals whose level has breached its <code>escalation_after_hours</code>.
            Run the scan to bump them to their fallback approver.
          </div>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={fetchBreaches}>
            Refresh
          </Button>
          <Button onClick={() => handleRun(true)} loading={running}>
            Dry run
          </Button>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            danger
            onClick={() => handleRun(false)}
            loading={running}
          >
            Run escalation pass
          </Button>
        </Space>
      </div>

      <Card>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <Spin />
          </div>
        ) : rows.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No SLA breaches right now. 🎉"
          />
        ) : (
          <Table
            rowKey="request_id"
            dataSource={rows}
            columns={columns}
            pagination={{ pageSize: 25 }}
          />
        )}
      </Card>
    </div>
  );
};

export default SlaBreaches;
