import React from 'react';
import StockTransfer from './StockTransfer';

// StockTransferForm is handled inline within StockTransfer via Drawer.
// This component re-exports StockTransfer for route compatibility.
const StockTransferForm = () => {
  return <StockTransfer />;
};

export default StockTransferForm;
