import React, { useRef } from 'react';
import { Button, Space } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import { useReactToPrint } from 'react-to-print';
import Barcode from 'react-barcode';
import { QRCodeSVG } from 'qrcode.react';

const PrintLabel = ({
  value,
  type = 'CODE128',
  title,
  subtitle,
  copies = 1,
  labelWidth = '50mm',
  labelHeight = '30mm',
  showPrintButton = true,
  children,
}) => {
  const printRef = useRef(null);

  const handlePrint = useReactToPrint({
    content: () => printRef.current,
    documentTitle: `Label_${value || 'blank'}`,
  });

  if (!value) {
    return null;
  }

  const isQR = type === 'QR' || type === 'QRCODE';

  const renderLabel = () => (
    <div
      className="print-label-container"
      style={{
        width: labelWidth,
        minHeight: labelHeight,
        pageBreakAfter: 'always',
      }}
    >
      {title && <div className="print-label-title">{title}</div>}
      {isQR ? (
        <QRCodeSVG value={value} size={80} level="M" includeMargin={false} />
      ) : (
        <Barcode
          value={value}
          format={type}
          width={1.5}
          height={40}
          displayValue={true}
          fontSize={10}
          margin={2}
          background="#ffffff"
          lineColor="#000000"
        />
      )}
      {subtitle && <div className="print-label-subtitle">{subtitle}</div>}
      {children}
    </div>
  );

  const labels = Array.from({ length: copies }, (_, i) => (
    <React.Fragment key={i}>{renderLabel()}</React.Fragment>
  ));

  return (
    <div>
      {showPrintButton && (
        <div className="no-print" style={{ marginBottom: 12 }}>
          <Button
            type="primary"
            icon={<PrinterOutlined />}
            onClick={handlePrint}
          >
            Print Label{copies > 1 ? `s (${copies})` : ''}
          </Button>
        </div>
      )}
      <div ref={printRef}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            justifyContent: 'center',
          }}
        >
          {labels}
        </div>
      </div>
    </div>
  );
};

export default PrintLabel;
