import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Spin, message, Empty, Button } from 'antd';
import { ReloadOutlined, PlusOutlined, UnorderedListOutlined } from '@ant-design/icons';
import api from '../../config/api';
import BavyaKanban from '../../components/BavyaKanban';
import { formatDate, formatCurrency, getErrorMessage } from '../../utils/helpers';

const COLUMNS = [
  { key: 'draft',              label: 'Draft',         color: '#7A6D66' },
  { key: 'pending_approval',   label: 'To Approve',    color: '#481890' },
  { key: 'approved',           label: 'Approved',      color: '#2E7D52' },
  { key: 'partially_ordered',  label: 'Partial Order', color: '#F09000' },
  { key: 'ordered',            label: 'Ordered',       color: '#D80048' },
];

const STATUS_TO_COL = COLUMNS.reduce((acc, c) => {
  acc[c.key] = c.key;
  return acc;
}, {});

const MaterialRequestsKanban = () => {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = async () => {
    setLoading(true);
    try {
      // Backend caps page_size at 100 (Pydantic le=100). Stay under it.
      const res = await api.get('/procurement/material-requests', {
        params: { page_size: 100 },
      });
      const data = res.data;
      const rows = Array.isArray(data) ? data : (data.results || data.items || data.data || []);
      const mapped = rows.map((r) => ({
        id: r.id,
        columnKey: STATUS_TO_COL[r.status] || 'draft',
        ref: r.mr_number || r.reference || `MR-${r.id}`,
        title: r.purpose || r.remarks || r.title || `Material Request #${r.id}`,
        warehouse: r.warehouse_name || r.warehouse?.name,
        priority: r.priority || r.request_type,
        date: r.required_date,
        amount: r.estimated_amount || r.total_amount,
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
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, columnKey: newCol } : i)));
    try {
      if (newCol === 'pending_approval') {
        await api.post(`/procurement/material-requests/${id}/submit`);
      } else if (newCol === 'approved') {
        await api.post(`/procurement/material-requests/${id}/approve`);
      } else {
        await api.put(`/procurement/material-requests/${id}`, { status: newCol });
      }
      message.success('Material Request moved');
    } catch (err) {
      message.error(getErrorMessage(err));
      fetchAll();
    }
  };

  const renderCard = (item) => {
    const col = COLUMNS.find((c) => c.key === item.columnKey);
    return (
      <>
        <div className="ref" style={{ '--col-color': col?.color }}>
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
        {item.amount != null && Number(item.amount) > 0 && (
          <div style={{ fontFamily: "var(--bavya-display)", fontWeight: 700, fontSize: 14, color: '#1A1220' }}>
            {formatCurrency(item.amount)}
          </div>
        )}
      </>
    );
  };

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
          <h2 style={{ margin: 0, fontSize: 22 }}>Material Request Board</h2>
          <div style={{ color: '#7A6D66', fontSize: 13 }}>
            Drag a card between columns to change its stage. Backend rules still apply.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button icon={<ReloadOutlined />} onClick={fetchAll}>
            Refresh
          </Button>
          <Button
            icon={<UnorderedListOutlined />}
            onClick={() => navigate('/procurement/material-requests')}
          >
            List view
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => navigate('/procurement/material-requests/new')}
          >
            New MR
          </Button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
          <Spin size="large" />
        </div>
      ) : items.length === 0 ? (
        <Empty description="No material requests in any stage" />
      ) : (
        <BavyaKanban
          columns={COLUMNS}
          items={items}
          renderCard={renderCard}
          onMove={handleMove}
          onCardClick={(item) => navigate(`/procurement/material-requests/${item.id}`)}
        />
      )}
    </div>
  );
};

export default MaterialRequestsKanban;
