import React from 'react';
import Barcode from 'react-barcode';
import { QRCodeSVG } from 'qrcode.react';

const BarcodeDisplay = ({
  value,
  type = 'CODE128',
  width = 2,
  height = 80,
  displayValue = true,
  label,
  subtitle,
  qrSize = 128,
}) => {
  if (!value) {
    return (
      <div className="barcode-display">
        <span style={{ color: '#bfbfbf' }}>No barcode value</span>
      </div>
    );
  }

  // M7 fix: case-insensitive type detection so "qr", "QR", "qrcode" all work
  const upperType = (type || 'CODE128').toUpperCase();
  const isQR = upperType === 'QR' || upperType === 'QRCODE';

  return (
    <div className="barcode-display">
      {label && <div className="barcode-display-label">{label}</div>}
      {isQR ? (
        <QRCodeSVG
          value={value}
          size={qrSize}
          level="M"
          includeMargin={false}
        />
      ) : (
        <Barcode
          value={value}
          format={upperType}
          width={width}
          height={height}
          displayValue={displayValue}
          fontSize={14}
          margin={4}
          background="#ffffff"
          lineColor="#000000"
        />
      )}
      {subtitle && <div className="barcode-display-label">{subtitle}</div>}
    </div>
  );
};

export default BarcodeDisplay;
