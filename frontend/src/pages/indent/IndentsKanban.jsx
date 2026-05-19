import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Spin, message, Empty, Button } from 'antd';
import { ReloadOutlined, PlusOutlined, UnorderedListOutlined } from '@ant-design/icons';
import api from '../../config/api';
import BavyaKanban from '../../components/BavyaKanban';
import { formatDate, getErrorMessage } from '../../utils/helpers';

// Maps backend status enum → kanban column. Approved + partially_fulfilled +
// fulfilled get visually distinct columns so the SCM team can see exactly
// where things stand.
const COLUMNS = [
  { key: 'draft',              label: 'Draft',          color: '#7A6D66' },
  { key: 'pending_approval',   label: 'To Approve',     color: '#481890' },
  { key: 'approved',           label: 'Approved',       color: '#2E7D52' },
  { key: 'partially_fulfilled',label: 'Partial Fulfil', color: '#F09000' },
  { key: 'fulfilled',          label: 'Fulfilled',      color: '#D80048' },
];

const STATUS_TO_COL = COLUMNS.reduce((acc, c) => {
  acc[c.key] = c.key;
  return acc;
}, {});

const IndentsKanban = () => {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = async () => {
    setLoading(true);
    try {
      // Backend caps page_size at 100 (Pydantic le=100). Stay under it.
      const res = await api.get('/indent/indents', {
        params: { page_size: 100 },
      });
      const data = res.data;
      const rows = Array.isArray(data) ? data : (data.results || data.items || data.data || []);
      const mapped = rows.map((r) => ({
        id: r.id,
        columnKey: STATUS_TO_COL[r.status] || 'draft',
        ref: r.indent_number || `IND-${r.id}`,
        title: r.remarks || r.warehouse_name || r.warehouse?.name || `Indent #${r.id}`,
        warehouse: r.warehouse_name || r.warehouse?.name,
        priority: r.priority || r.indent_type,
        date: r.required_date || r.indent_date,
        items: r.item_count ?? (r.items ? r.items.length : null),
      }));
      setItems(mapped);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, []);

  const handleMove = async (id, newCol) => {
    // BUG-FE-IND-003 — the only user-driven kanban transitions are
    // draft → pending_approval (submit) and pending_approval → approved
    // (approve). Other status transitions (partially_fulfilled, fulfilled)
    // are owned by the lifecycle (issue + acknowledgement); the kanban
    // must NOT PUT-status as a fallback because IndentUpdate.status is
    // not a client-driven contract.
    const currentItem = items.find((i) => i.id === id);
    const fromCol = currentItem?.columnKey;

    // Optimistic
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, columnKey: newCol } : i)));

    const revert = () => {
      if (fromCol) {
        setItems((prev) =>
          prev.map((i) => (i.id === id ? { ...i, columnKey: fromCol } : i))
        );
      } else {
        fetchAll();
      }
    };

    try {
      if (newCol === 'pending_approval' && fromCol === 'draft') {
        await api.post(`/indent/indents/${id}/submit`);
      } else if (newCol === 'approved' && fromCol === 'pending_approval') {
        await api.post(`/indent/indents/${id}/approve`);
      } else {
        message.warning('That transition is driven by the lifecycle (issue / acknowledgement) — not the board.');
        revert();
        return;
      }
      message.success('Indent moved');
    } catch (err) {
      message.error(getErrorMessage(err));
      revert();
    }
  };

  const renderCard = (item) => (
    <>
      <div className="ref" style={{ '--col-color': COLUMNS.find((c) => c.key === item.columnKey)?.color }}>
        {item.ref}
      </div>
      <div className="title">{item.title}</div>
      <div className="meta">
        {item.warehouse && <span className="pill">{item.warehouse}</span>}
        {item.priority && (
          <span className={`pill ${item.priority === 'urgent' ? 'urgent' : ''}`}>
            {item.priority}
          </span>
        )}
        {item.date && <span>· need {formatDate(item.date)}</span>}
        {item.items != null && <span>· {item.items} item{item.items !== 1 ? 's' : ''}</span>}
      </div>
    </>
  );

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 22 }}>Indent Board</h2>
          <div style={{ color: '#7A6D66', fontSize: 13 }}>
            Drag a card between columns to change its stage. Backend rules still apply.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button icon={<ReloadOutlined />} onClick={fetchAll}>
            Refresh
          </Button>
          <Button icon={<UnorderedListOutlined />} onClick={() => navigate('/indent/indents')}>
            List view
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => navigate('/indent/indents?new=1')}
          >
            New Indent
          </Button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
          <Spin size="large" />
        </div>
      ) : items.length === 0 ? (
        <Empty description="No indents in any stage" />
      ) : (
        <BavyaKanban
          columns={COLUMNS}
          items={items}
          renderCard={renderCard}
          onMove={handleMove}
          onCardClick={(item) => navigate(`/indent/indents/${item.id}`)}
        />
      )}
    </div>
  );
};

export default IndentsKanban;
