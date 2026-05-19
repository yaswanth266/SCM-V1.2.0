import React from 'react';
import { Tag } from 'antd';
import { STATUS_COLORS, STATUS_LABELS } from '../utils/constants';

const StatusTag = ({ status, style }) => {
  if (!status) return <Tag color="default">N/A</Tag>;

  const normalized = status.toLowerCase();
  const color = STATUS_COLORS[normalized] || '#8c8c8c';
  const label =
    STATUS_LABELS[normalized] ||
    status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <Tag
      style={{
        color: '#fff',
        backgroundColor: color,
        borderColor: color,
        ...style,
      }}
    >
      {label}
    </Tag>
  );
};

export default StatusTag;
