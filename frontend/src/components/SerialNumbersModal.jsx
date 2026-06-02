import React, { useState, useEffect } from 'react';
import {
  Modal, Input, Button, Typography, Tag, Space, Tooltip, Select,
} from 'antd';
import {
  PlusOutlined, DeleteOutlined, CheckOutlined,
  BarcodeOutlined,
} from '@ant-design/icons';

const { Text } = Typography;

/**
 * SerialNumbersModal
 *
 * A reusable modal for entering/editing serial numbers for an item.
 *
 * Two modes:
 *   mode="manual" (default) — indexed input fields for typing serials manually
 *   mode="select"           — multi-select dropdown from available serials list
 *
 * Props:
 *   value           – array of serial numbers (controlled)
 *   onChange        – (newSerials: string[]) => void
 *   itemName        – item name for display
 *   itemCode        – item code for display
 *   quantity        – required number of serials (defaults to value.length if 0)
 *   hasSerial       – boolean, whether item is serial-tracked
 *   readOnly        – boolean, hide edit button and show plain tags
 *   size            – 'small' | 'default' (default 'small')
 *   mode            – 'manual' | 'select' (default 'manual')
 *   availableSerials – array of serials to show in dropdown (for select mode)
 */
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
}) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState([]);

  const needed = quantity != null ? Math.max(0, Number(quantity)) : value.length;
  const filledCount = value.filter((s) => s && s.trim()).length;
  const allFilled = needed > 0 && filledCount >= needed;

  // Reset draft when opening
  useEffect(() => {
    if (open) {
      setDraft([...value]);
    }
  }, [open, value]);

  if (!hasSerial) {
    return <Text type="secondary" style={{ fontSize: size === 'small' ? 11 : 13 }}>—</Text>;
  }

  const handleOpen = () => setOpen(true);
  const handleClose = () => setOpen(false);

  const handleSave = () => {
    onChange(draft);
    setOpen(false);
  };

  // --- Manual mode helpers ---
  const updateSerial = (index, val) => {
    const updated = [...draft];
    updated[index] = val;
    setDraft(updated);
  };

  const addSerial = () => {
    setDraft((prev) => [...prev, '']);
  };

  const removeSerial = (index) => {
    setDraft((prev) => prev.filter((_, i) => i !== index));
  };

  const clearAll = () => {
    setDraft([]);
  };

  const fillAllPlaceholders = () => {
    const filled = draft.filter((s) => s && s.trim());
    const missing = needed - filled.length;
    if (missing > 0) {
      const newSerials = [];
      for (let i = 0; i < missing; i++) {
        const nextNum = filled.length + i + 1;
        newSerials.push(`SN-${String(nextNum).padStart(3, '0')}`);
      }
      setDraft([...filled, ...newSerials]);
    }
  };

  // --- Compact display (shown in table cell) ---
  if (readOnly) {
    if (value.length === 0) return <Text type="secondary" style={{ fontSize: 11 }}>—</Text>;
    return (
      <Tooltip title={value.join(', ')}>
        <Tag color="blue" style={{ cursor: 'default', fontSize: 11 }}>
          <BarcodeOutlined style={{ marginRight: 4 }} />
          {value.length} serial{value.length > 1 ? 's' : ''}
        </Tag>
      </Tooltip>
    );
  }

  // Editable state — show clickable chip
  const buttonStyle = {
    cursor: 'pointer',
    fontSize: size === 'small' ? 11 : 13,
    padding: '2px 8px',
    borderRadius: 4,
    border: '1px solid',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: allFilled ? '#f6ffed' : '#fffbe6',
    borderColor: allFilled ? '#b7eb8f' : '#ffe58f',
    color: allFilled ? '#135200' : '#ad6800',
    transition: 'all 0.2s',
  };

  // Build unique options for select mode (merge current value + available)
  const selectOptions = Array.from(
    new Set([...draft, ...availableSerials])
  ).map((sn) => ({
    label: sn,
    value: sn,
  }));

  const isCountMismatch =
    mode === 'select' &&
    draft.length > 0 &&
    draft.length !== needed;

  return (
    <>
      <Tooltip
        title={
          value.length > 0
            ? mode === 'select'
              ? `Click to select/manage ${value.length} serial(s)`
              : `Click to edit ${value.length} serial(s)`
            : mode === 'select'
              ? 'Click to select serial numbers'
              : 'Click to enter serial numbers'
        }
      >
        <span
          onClick={handleOpen}
          style={buttonStyle}
          onMouseEnter={(e) => {
            e.currentTarget.style.boxShadow = allFilled
              ? '0 0 0 2px rgba(82, 196, 26, 0.2)'
              : '0 0 0 2px rgba(250, 173, 20, 0.2)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.boxShadow = 'none';
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') handleOpen(); }}
        >
          <BarcodeOutlined />
          {value.length > 0 ? (
            <span>
              {filledCount}/{needed} serial{needed > 1 ? 's' : ''}
            </span>
          ) : (
            <span>{mode === 'select' ? 'Select serials' : 'Enter serials'}</span>
          )}
          {allFilled && <CheckOutlined style={{ fontSize: 10 }} />}
        </span>
      </Tooltip>

      <Modal
        title={
          <Space>
            <BarcodeOutlined />
            <span>Serial Numbers</span>
            {itemName && (
              <Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>
                — {itemName}{itemCode ? ` (${itemCode})` : ''}
              </Text>
            )}
          </Space>
        }
        open={open}
        onCancel={handleClose}
        width={mode === 'select' ? 480 : 520}
        footer={
          <Space>
            {mode === 'manual' && (
              <>
                <Button onClick={clearAll} danger type="text" size="small">
                  Clear All
                </Button>
                <Button onClick={fillAllPlaceholders} size="small">
                  Fill Placeholders
                </Button>
              </>
            )}
            <Button onClick={handleClose}>Cancel</Button>
            <Button type="primary" onClick={handleSave} icon={<CheckOutlined />}>
              Save ({draft.filter((s) => s && s.trim()).length} serials)
            </Button>
          </Space>
        }
        destroyOnClose
      >
        <div style={{ marginBottom: 12 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Required: <Text strong>{needed}</Text> serial number{needed > 1 ? 's' : ''}
            {' | '}Selected: <Text strong>{draft.filter((s) => s && s.trim()).length}</Text>
            {mode === 'select' && availableSerials.length > 0 && (
              <>
                {' | '}Available in stock:{' '}
                <Text strong>{availableSerials.length}</Text>
              </>
            )}
            {isCountMismatch && (
              <Text type="warning" style={{ marginLeft: 8, fontSize: 11 }}>
                (count doesn't match required qty)
              </Text>
            )}
          </Text>
        </div>

        {mode === 'select' ? (
          /* --- SELECT MODE: multi-select dropdown --- */
          <div>
            {availableSerials.length === 0 && draft.length === 0 ? (
              <Text type="secondary" style={{ fontSize: 12, display: 'block', textAlign: 'center', padding: 24 }}>
                Select a batch and bin first to see available serial numbers in stock.
              </Text>
            ) : (
              <Select
                mode="multiple"
                placeholder="Select serial numbers from stock..."
                value={draft}
                onChange={(selected) => setDraft(selected)}
                options={selectOptions}
                style={{ width: '100%' }}
                status={isCountMismatch ? 'warning' : undefined}
                size="small"
                showSearch
                optionFilterProp="label"
                dropdownRender={(menu) => (
                  <div>
                    {menu}
                    <div
                      style={{
                        padding: '4px 8px',
                        borderTop: '1px solid #e8e8e8',
                        color: 'rgba(0, 0, 0, 0.45)',
                        fontSize: 12,
                      }}
                    >
                      Selected: {draft.length} / {needed} required
                    </div>
                  </div>
                )}
              />
            )}
            {draft.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <Space wrap size={[4, 4]}>
                  {draft.map((sn) => (
                    <Tag
                      key={sn}
                      closable
                      onClose={() => setDraft((prev) => prev.filter((s) => s !== sn))}
                      color="blue"
                    >
                      {sn}
                    </Tag>
                  ))}
                </Space>
              </div>
            )}
          </div>
        ) : (
          /* --- MANUAL MODE: indexed input fields --- */
          <>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                maxHeight: 400,
                overflowY: 'auto',
              }}
            >
              {draft.map((serial, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 0',
                  }}
                >
                  <Tag
                    color={serial && serial.trim() ? 'success' : 'default'}
                    style={{
                      minWidth: 28,
                      textAlign: 'center',
                      fontSize: 11,
                      lineHeight: '20px',
                      margin: 0,
                      flexShrink: 0,
                    }}
                  >
                    {i + 1}
                  </Tag>
                  <Input
                    size="small"
                    placeholder={`Serial #${i + 1}`}
                    value={serial}
                    onChange={(e) => updateSerial(i, e.target.value)}
                    style={{ flex: 1 }}
                    status={serial && serial.trim() ? 'success' : undefined}
                    prefix={<Text type="secondary" style={{ fontSize: 10 }}>S/N</Text>}
                  />
                  {serial && serial.trim() && (
                    <CheckOutlined style={{ color: '#52c41a', fontSize: 12, flexShrink: 0 }} />
                  )}
                  <Tooltip title="Remove this serial">
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => removeSerial(i)}
                      style={{ flexShrink: 0 }}
                    />
                  </Tooltip>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <Button type="dashed" icon={<PlusOutlined />} onClick={addSerial} size="small" block>
                Add Serial Number Row
              </Button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
};

export default SerialNumbersModal;
