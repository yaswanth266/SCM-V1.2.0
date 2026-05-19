import React from 'react';
import StockAudit from './StockAudit';

// StockAuditForm is handled inline within StockAudit via Drawer.
// This component re-exports StockAudit for route compatibility.
const StockAuditForm = () => {
  return <StockAudit />;
};

export default StockAuditForm;
