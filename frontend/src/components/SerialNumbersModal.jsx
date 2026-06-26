import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Modal, Input, Button, Typography, Tag, Tooltip, Space, Badge } from 'antd';
import {
  BarcodeOutlined, CheckOutlined, DeleteOutlined,
  SearchOutlined, ThunderboltOutlined, CopyOutlined,
  CloseCircleFilled, CheckCircleFilled, ScanOutlined,
} from '@ant-design/icons';

const { Text } = Typography;

/* ─── tiny progress ring ─────────────────────────────────────────── */
function ProgressRing({ filled, needed, size = 52 }) {
  const r = (size - 6) / 2;
  const circ = 2 * Math.PI * r;
  const pct = needed > 0 ? Math.min(filled / needed, 1) : 0;
  const dash = pct * circ;
  const color = pct >= 1 ? '#22c55e' : pct > 0 ? '#f59e0b' : '#e2e8f0';
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={5} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={color} strokeWidth={5}
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.4s ease, stroke 0.3s ease' }}
      />
      <text
        x="50%" y="50%"
        textAnchor="middle" dominantBaseline="central"
        style={{ transform: 'rotate(90deg)', transformOrigin: '50% 50%', fontSize: 11, fontWeight: 700, fill: color, fontFamily: 'monospace' }}
      >
        {filled}/{needed}
      </text>
    </svg>
  );
}

/* ─── main component ─────────────────────────────────────────────── */
const SerialNumbersModal = ({
  value = [],
  onChange,
  itemName = '',
  itemCode = '',
  quantity,
  hasSerial = false,
  readOnly = false,
  size = 'small',
  mode = 'manual',
  availableSerials = [],
  width,
}) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState([]);
  const [search, setSearch] = useState('');
  const [bulkInput, setBulkInput] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [justAdded, setJustAdded] = useState(new Set());
  const bulkRef = useRef(null);
  const searchRef = useRef(null);

  const needed = quantity != null ? Math.max(0, Number(quantity)) : value.length;
  const filledCount = value.filter((s) => s && s.trim()).length;
  const draftFilled = draft.filter((s) => s && s.trim()).length;
  const allFilled = needed > 0 && filledCount >= needed;

  useEffect(() => {
    if (open) {
      setDraft([...value]);
      setSearch('');
      setBulkInput('');
      setShowBulk(false);
      setJustAdded(new Set());
    }
  }, [open]);

  /* filtered available options */
  const filteredAvailable = useMemo(() => {
    const pool = availableSerials.filter(sn => !draft.includes(sn));
    if (!search.trim()) return pool;
    const q = search.toLowerCase();
    return pool.filter(sn => sn.toLowerCase().includes(q));
  }, [availableSerials, draft, search]);

  if (!hasSerial) return <Text type="secondary" style={{ fontSize: size === 'small' ? 11 : 13 }}>—</Text>;

  const handleSave = () => { onChange(draft.filter(s => s && s.trim())); setOpen(false); };
  const removeSerial = (sn) => setDraft(prev => prev.filter(s => s !== sn));
  const clearAll = () => setDraft([]);

  /* Bulk paste/scan handler — splits by newline, comma, tab, semicolon */
  const applyBulk = () => {
    const incoming = bulkInput
      .split(/[\n,;\t]+/)
      .map(s => s.trim())
      .filter(Boolean);
    const toAdd = incoming.filter(sn => !draft.includes(sn));
    setDraft(prev => [...prev, ...toAdd]);
    setJustAdded(new Set(toAdd));
    setTimeout(() => setJustAdded(new Set()), 1500);
    setBulkInput('');
    setShowBulk(false);
  };

  const toggleSerial = (sn) => {
    if (draft.includes(sn)) {
      removeSerial(sn);
    } else {
      setDraft(prev => [...prev, sn]);
      setJustAdded(new Set([sn]));
      setTimeout(() => setJustAdded(new Set()), 900);
    }
  };

  const selectAll = () => {
    const remaining = filteredAvailable.filter(sn => !draft.includes(sn));
    setDraft(prev => [...prev, ...remaining]);
    setJustAdded(new Set(remaining));
    setTimeout(() => setJustAdded(new Set()), 1200);
  };

  /* ── trigger chip shown in table cell ── */
  const chipColor = allFilled ? { bg: '#f0fdf4', border: '#86efac', text: '#15803d' }
    : filledCount > 0 ? { bg: '#fffbeb', border: '#fcd34d', text: '#92400e' }
    : { bg: '#f8fafc', border: '#cbd5e1', text: '#475569' };

  if (readOnly) {
    if (value.length === 0) return <Text type="secondary" style={{ fontSize: 11 }}>—</Text>;
    return (
      <Tooltip title={<div style={{ maxWidth: 280 }}>{value.join(' · ')}</div>} placement="top">
        <Tag color="blue" style={{ cursor: 'default', fontSize: 11, borderRadius: 6 }}>
          <BarcodeOutlined style={{ marginRight: 3 }} />{value.length} serial{value.length > 1 ? 's' : ''}
        </Tag>
      </Tooltip>
    );
  }

  const isOverLimit = needed > 0 && draftFilled > needed;
  const isExact = needed > 0 && draftFilled === needed;

  return (
    <>
      {/* ── Trigger chip ── */}
      <Tooltip
        title={value.length > 0 ? `${filledCount} of ${needed} serial(s) selected — click to edit` : 'Click to select serial numbers'}
        placement="top"
      >
        <span
          role="button" tabIndex={0}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === 'Enter') setOpen(true); }}
          style={{
            cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '3px 10px', borderRadius: 20,
            background: chipColor.bg, border: `1.5px solid ${chipColor.border}`,
            color: chipColor.text, fontSize: size === 'small' ? 11 : 13,
            fontWeight: 600, transition: 'all 0.2s',
            userSelect: 'none',
          }}
          onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.03)'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.12)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = 'none'; }}
        >
          <BarcodeOutlined />
          {value.length > 0 ? `${filledCount}/${needed} S/N` : 'Select S/N'}
          {allFilled && <CheckCircleFilled style={{ color: '#22c55e', fontSize: 12 }} />}
        </span>
      </Tooltip>

      {/* ── Modal ── */}
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        width={width || 640}
        destroyOnHidden
        centered
        styles={{
          header: { background: '#0f172a', borderBottom: '1px solid #1e293b', padding: '16px 24px', borderRadius: '12px 12px 0 0' },
          body: { background: '#0f172a', padding: '0', maxHeight: '75vh', overflowY: 'auto' },
          footer: { background: '#0f172a', borderTop: '1px solid #1e293b', padding: '12px 24px', borderRadius: '0 0 12px 12px' },
          content: { padding: 0, borderRadius: 12, overflow: 'hidden', boxShadow: '0 25px 60px rgba(0,0,0,0.5)' },
          mask: { backdropFilter: 'blur(4px)' },
        }}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <BarcodeOutlined style={{ color: '#fff', fontSize: 18 }} />
            </div>
            <div>
              <div style={{ color: '#f1f5f9', fontWeight: 700, fontSize: 15 }}>Serial Numbers</div>
              {itemName && (
                <div style={{ color: '#64748b', fontSize: 12, fontWeight: 400 }}>
                  {itemName}{itemCode ? ` · ${itemCode}` : ''}
                </div>
              )}
            </div>
          </div>
        }
        footer={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Button
              type="text" size="small" danger
              onClick={clearAll} disabled={draft.length === 0}
              style={{ color: draft.length > 0 ? '#f87171' : '#475569', fontSize: 12 }}
            >
              Clear All
            </Button>
            <Space>
              <Button onClick={() => setOpen(false)} style={{ borderColor: '#334155', color: '#94a3b8', background: 'transparent' }}>
                Cancel
              </Button>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                onClick={handleSave}
                disabled={isOverLimit}
                style={{
                  background: isExact ? 'linear-gradient(135deg, #22c55e, #16a34a)' : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                  border: 'none', fontWeight: 700,
                  boxShadow: '0 4px 14px rgba(99,102,241,0.4)',
                }}
              >
                Save ({draftFilled} serial{draftFilled !== 1 ? 's' : ''})
              </Button>
            </Space>
          </div>
        }
      >
        {/* ── Stats bar ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 16,
          padding: '16px 24px', borderBottom: '1px solid #1e293b',
          background: '#0f172a',
        }}>
          <ProgressRing filled={draftFilled} needed={needed} size={54} />
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              <div>
                <div style={{ color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Required</div>
                <div style={{ color: '#f1f5f9', fontSize: 20, fontWeight: 800, fontFamily: 'monospace' }}>{needed}</div>
              </div>
              <div>
                <div style={{ color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Selected</div>
                <div style={{
                  fontSize: 20, fontWeight: 800, fontFamily: 'monospace',
                  color: isOverLimit ? '#f87171' : isExact ? '#22c55e' : '#f59e0b',
                }}>{draftFilled}</div>
              </div>
              {availableSerials.length > 0 && (
                <div>
                  <div style={{ color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>In Stock</div>
                  <div style={{ color: '#38bdf8', fontSize: 20, fontWeight: 800, fontFamily: 'monospace' }}>{availableSerials.length}</div>
                </div>
              )}
            </div>
            {isOverLimit && (
              <div style={{ color: '#f87171', fontSize: 11, marginTop: 4 }}>
                ⚠ {draftFilled - needed} over limit — remove some serials
              </div>
            )}
            {isExact && (
              <div style={{ color: '#22c55e', fontSize: 11, marginTop: 4 }}>
                ✓ Exactly {needed} selected — ready to save
              </div>
            )}
          </div>

          {/* Action buttons */}
          <Space direction="vertical" size={6}>
            <Tooltip title="Bulk paste from clipboard or scan list">
              <Button
                size="small" icon={<ScanOutlined />}
                onClick={() => { setShowBulk(v => !v); setTimeout(() => bulkRef.current?.focus(), 100); }}
                style={{
                  background: showBulk ? '#312e81' : '#1e293b', border: '1px solid #334155',
                  color: '#a5b4fc', fontSize: 12, borderRadius: 8,
                }}
              >
                Bulk Paste
              </Button>
            </Tooltip>
            {availableSerials.length > 0 && filteredAvailable.length > 0 && (
              <Tooltip title={`Auto-select first ${needed - draftFilled} available`}>
                <Button
                  size="small" icon={<ThunderboltOutlined />}
                  onClick={() => {
                    const toFill = needed - draftFilled;
                    if (toFill <= 0) return;
                    const take = filteredAvailable.slice(0, toFill);
                    setDraft(prev => [...prev, ...take]);
                    setJustAdded(new Set(take));
                    setTimeout(() => setJustAdded(new Set()), 1200);
                  }}
                  disabled={draftFilled >= needed}
                  style={{
                    background: '#1e293b', border: '1px solid #334155',
                    color: '#fbbf24', fontSize: 12, borderRadius: 8,
                  }}
                >
                  Auto-fill
                </Button>
              </Tooltip>
            )}
          </Space>
        </div>

        {/* ── Bulk paste panel ── */}
        {showBulk && (
          <div style={{
            padding: '12px 24px', background: '#1a1033',
            borderBottom: '1px solid #312e81',
            animation: 'slideDown 0.2s ease',
          }}>
            <div style={{ color: '#a5b4fc', fontSize: 12, marginBottom: 6, fontWeight: 600 }}>
              <CopyOutlined style={{ marginRight: 6 }} />
              Paste serial numbers (comma, newline, or semicolon separated)
            </div>
            <Input.TextArea
              ref={bulkRef}
              rows={3}
              value={bulkInput}
              onChange={e => setBulkInput(e.target.value)}
              placeholder={'SN-001\nSN-002, SN-003\nSN-004;SN-005'}
              style={{ background: '#0f172a', border: '1px solid #4338ca', color: '#e2e8f0', borderRadius: 8, fontFamily: 'monospace', fontSize: 12 }}
              onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) applyBulk(); }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <Button size="small" onClick={() => { setShowBulk(false); setBulkInput(''); }} style={{ color: '#94a3b8', background: 'transparent', border: '1px solid #334155' }}>
                Cancel
              </Button>
              <Button size="small" type="primary" onClick={applyBulk} disabled={!bulkInput.trim()}
                style={{ background: '#4f46e5', border: 'none' }}>
                Apply ({bulkInput.split(/[\n,;\t]+/).filter(s => s.trim()).length} serials)
              </Button>
            </div>
          </div>
        )}

        {/* ── Selected chips ── */}
        {draft.length > 0 && (
          <div style={{ padding: '14px 24px', borderBottom: '1px solid #1e293b' }}>
            <div style={{ color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              Selected
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {draft.map(sn => (
                <span
                  key={sn}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    background: justAdded.has(sn) ? '#14532d' : '#1e293b',
                    border: `1px solid ${justAdded.has(sn) ? '#22c55e' : '#334155'}`,
                    borderRadius: 20, padding: '3px 10px',
                    color: justAdded.has(sn) ? '#86efac' : '#e2e8f0',
                    fontSize: 12, fontFamily: 'monospace', fontWeight: 600,
                    transition: 'all 0.3s ease',
                    animation: justAdded.has(sn) ? 'popIn 0.3s ease' : undefined,
                  }}
                >
                  {sn}
                  <CloseCircleFilled
                    style={{ color: '#475569', cursor: 'pointer', fontSize: 13 }}
                    onClick={() => removeSerial(sn)}
                    onMouseEnter={e => { e.target.style.color = '#f87171'; }}
                    onMouseLeave={e => { e.target.style.color = '#475569'; }}
                  />
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ── Available serials picker (select mode) ── */}
        {mode === 'select' && (
          <div style={{ padding: '14px 24px' }}>
            {availableSerials.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '32px 0', color: '#475569' }}>
                <BarcodeOutlined style={{ fontSize: 32, display: 'block', marginBottom: 8 }} />
                <div style={{ fontSize: 13 }}>No available serials in stock</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>Select a batch/bin first to load available serial numbers</div>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <Input
                    ref={searchRef}
                    size="small"
                    prefix={<SearchOutlined style={{ color: '#475569' }} />}
                    placeholder="Search serial numbers..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    style={{ background: '#1e293b', border: '1px solid #334155', color: '#e2e8f0', borderRadius: 8, flex: 1 }}
                    allowClear
                  />
                  <Button
                    size="small" icon={<CheckOutlined />}
                    onClick={selectAll}
                    disabled={filteredAvailable.length === 0 || draftFilled >= needed}
                    style={{ background: '#1e293b', border: '1px solid #334155', color: '#34d399', borderRadius: 8, fontSize: 12 }}
                  >
                    Select All ({filteredAvailable.length})
                  </Button>
                </div>

                <div style={{ color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                  Available in stock
                </div>

                {filteredAvailable.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 16, color: '#475569', fontSize: 12 }}>
                    {search ? `No serials match "${search}"` : 'All available serials are already selected'}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
                    {filteredAvailable.map(sn => {
                      const isSelected = draft.includes(sn);
                      const isLimitReached = !isSelected && needed > 0 && draftFilled >= needed;
                      return (
                        <Tooltip key={sn} title={isLimitReached ? 'Remove a serial first to swap' : isSelected ? 'Click to remove' : 'Click to select'}>
                          <span
                            onClick={() => !isLimitReached && toggleSerial(sn)}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 5,
                              padding: '4px 12px', borderRadius: 20, fontSize: 12,
                              fontFamily: 'monospace', fontWeight: 600, cursor: isLimitReached ? 'not-allowed' : 'pointer',
                              background: isSelected ? '#14532d' : '#1e293b',
                              border: `1.5px solid ${isSelected ? '#22c55e' : isLimitReached ? '#1e293b' : '#334155'}`,
                              color: isSelected ? '#86efac' : isLimitReached ? '#374151' : '#94a3b8',
                              transition: 'all 0.15s ease',
                              opacity: isLimitReached ? 0.5 : 1,
                            }}
                            onMouseEnter={e => { if (!isLimitReached) e.currentTarget.style.borderColor = isSelected ? '#f87171' : '#6366f1'; }}
                            onMouseLeave={e => { e.currentTarget.style.borderColor = isSelected ? '#22c55e' : '#334155'; }}
                          >
                            {isSelected && <CheckCircleFilled style={{ color: '#22c55e', fontSize: 11 }} />}
                            {sn}
                          </span>
                        </Tooltip>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Manual mode ── */}
        {mode === 'manual' && (
          <div style={{ padding: '14px 24px' }}>
            {draft.length === 0 && (
              <div style={{ textAlign: 'center', padding: '24px 0', color: '#475569' }}>
                <BarcodeOutlined style={{ fontSize: 28, display: 'block', marginBottom: 8 }} />
                <div style={{ fontSize: 13 }}>No serial numbers entered yet</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>Use "Bulk Paste" above or add rows below</div>
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
              {draft.map((serial, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    width: 24, height: 24, borderRadius: 6, flexShrink: 0,
                    background: serial?.trim() ? '#14532d' : '#1e293b',
                    border: `1px solid ${serial?.trim() ? '#22c55e' : '#334155'}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#64748b', fontSize: 10, fontWeight: 700,
                  }}>{i + 1}</span>
                  <Input
                    size="small"
                    placeholder={`Serial #${i + 1}`}
                    value={serial}
                    onChange={(e) => {
                      const updated = [...draft]; updated[i] = e.target.value; setDraft(updated);
                    }}
                    style={{
                      flex: 1, background: '#1e293b',
                      border: `1px solid ${serial?.trim() ? '#334155' : '#374151'}`,
                      color: '#e2e8f0', borderRadius: 8, fontFamily: 'monospace', fontSize: 12,
                    }}
                    prefix={<Text style={{ color: '#475569', fontSize: 10 }}>S/N</Text>}
                    suffix={serial?.trim()
                      ? <CheckCircleFilled style={{ color: '#22c55e', fontSize: 12 }} />
                      : null}
                  />
                  <Button
                    type="text" size="small" danger
                    icon={<DeleteOutlined />}
                    onClick={() => { const u = [...draft]; u.splice(i, 1); setDraft(u); }}
                    style={{ color: '#475569', flexShrink: 0 }}
                  />
                </div>
              ))}
            </div>
            <Button
              type="dashed" icon={<CheckOutlined />} block size="small"
              onClick={() => setDraft(prev => [...prev, ''])}
              style={{ marginTop: 12, borderColor: '#334155', color: '#6366f1', background: 'transparent', borderRadius: 8 }}
            >
              + Add Row
            </Button>
          </div>
        )}

        <style>{`
          @keyframes popIn { 0% { transform: scale(0.7); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
          @keyframes slideDown { 0% { opacity: 0; transform: translateY(-8px); } 100% { opacity: 1; transform: translateY(0); } }
        `}</style>
      </Modal>
    </>
  );
};

export default SerialNumbersModal;
