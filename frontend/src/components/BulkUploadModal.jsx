import React, { useState } from 'react';
import {
  Modal, Button, Upload, message, Table, Tag, Space, Alert, Progress, Tooltip,
} from 'antd';
import {
  InboxOutlined, DownloadOutlined, CloudUploadOutlined,
  CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import api from '../config/api';
import { getErrorMessage } from '../utils/helpers';

const { Dragger } = Upload;

const BulkUploadModal = ({ open, onClose, onUploadSuccess }) => {
  const [fileList, setFileList] = useState([]);
  const [validating, setValidating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [validationResult, setValidationResult] = useState(null);

  const handleDownloadTemplate = () => {
    // Direct API call to trigger template streaming
    api.get('/inventory/items-bulk/template', { responseType: 'blob' })
      .then((res) => {
        const url = window.URL.createObjectURL(new Blob([res.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', 'items_bulk_upload_template.csv');
        document.body.appendChild(link);
        link.click();
        link.parentNode.removeChild(link);
        message.success('Template downloaded successfully');
      })
      .catch((err) => {
        message.error('Failed to download template: ' + getErrorMessage(err));
      });
  };

  const beforeUpload = (file) => {
    const isCsv = file.type === 'text/csv' || file.name.endsWith('.csv');
    if (!isCsv) {
      message.error('You can only upload CSV files!');
      return Upload.LIST_IGNORE;
    }
    setFileList([file]);
    handleValidate(file);
    return false; // Prevent auto-upload
  };

  const handleRemove = () => {
    setFileList([]);
    setValidationResult(null);
  };

  const handleValidate = async (file) => {
    setValidating(true);
    setValidationResult(null);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('dry_run', 'true');

    try {
      const res = await api.post('/inventory/items-bulk/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setValidationResult(res.data);
      if (res.data.success) {
        message.success('CSV validation successful! All rows are valid.');
      } else {
        message.warning('CSV validation found errors. Please review the table below.');
      }
    } catch (err) {
      console.error(err);
      let errorMsg = 'Validation failed';
      if (err.response?.data?.detail) {
        const detail = err.response.data.detail;
        if (typeof detail === 'object' && detail.message) {
          errorMsg = detail.message;
          if (detail.report) {
            setValidationResult(detail);
          }
        } else if (typeof detail === 'string') {
          errorMsg = detail;
        } else {
          errorMsg = JSON.stringify(detail);
        }
      } else {
        errorMsg = getErrorMessage(err);
      }
      message.error(errorMsg);
    } finally {
      setValidating(false);
    }
  };

  const handleImport = async () => {
    if (fileList.length === 0) return;
    setImporting(true);
    const formData = new FormData();
    formData.append('file', fileList[0]);
    formData.append('dry_run', 'false');

    try {
      const res = await api.post('/inventory/items-bulk/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      message.success(res.data.message || 'Items imported successfully');
      setFileList([]);
      setValidationResult(null);
      onUploadSuccess();
      onClose();
    } catch (err) {
      console.error(err);
      let errorMsg = 'Import failed';
      if (err.response?.data?.detail) {
        const detail = err.response.data.detail;
        if (typeof detail === 'object' && detail.message) {
          errorMsg = detail.message;
          if (detail.report) {
            setValidationResult(detail);
          }
        } else if (typeof detail === 'string') {
          errorMsg = detail;
        } else {
          errorMsg = JSON.stringify(detail);
        }
      } else {
        errorMsg = getErrorMessage(err);
      }
      message.error(errorMsg);
    } finally {
      setImporting(false);
    }
  };

  const reportColumns = [
    {
      title: 'Row',
      dataIndex: 'row_index',
      key: 'row_index',
      width: 70,
      align: 'center',
    },
    {
      title: 'Item Name',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
    },
    {
      title: 'Validation Status',
      dataIndex: 'status',
      key: 'status',
      width: 140,
      align: 'center',
      render: (status) => {
        const color = status === 'valid' ? 'green' : 'red';
        const label = status === 'valid' ? 'Valid' : 'Invalid';
        return <Tag color={color}>{label.toUpperCase()}</Tag>;
      },
    },
    {
      title: 'Errors / Warnings',
      key: 'messages',
      render: (_, record) => {
        const errors = record.errors || [];
        const warnings = record.warnings || [];
        return (
          <Space direction="vertical" size={2}>
            {errors.map((err, i) => (
              <span key={`e-${i}`} style={{ color: '#ff4d4f', fontSize: '12px' }}>
                <CloseCircleOutlined /> {err}
              </span>
            ))}
            {warnings.map((warn, i) => (
              <span key={`w-${i}`} style={{ color: '#faad14', fontSize: '12px' }}>
                <ExclamationCircleOutlined /> {warn}
              </span>
            ))}
            {errors.length === 0 && warnings.length === 0 && (
              <span style={{ color: '#52c41a', fontSize: '12px' }}>
                <CheckCircleOutlined /> Ready to import
              </span>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <Modal
      open={open}
      onCancel={() => {
        if (!importing) {
          handleRemove();
          onClose();
        }
      }}
      title={null}
      footer={null}
      centered
      width={720}
      styles={{ body: { padding: 0 } }}
      style={{ borderRadius: 24, overflow: 'hidden' }}
    >
      <div style={{
        background: 'linear-gradient(135deg, #1f1124 0%, #0d0610 100%)',
        padding: '36px 32px',
        color: '#fff',
        position: 'relative',
        overflow: 'hidden'
      }}>
        {/* Glow Effects */}
        <div style={{
          position: 'absolute',
          top: '-80px',
          right: '-80px',
          width: '200px',
          height: '200px',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(144, 0, 120, 0.2) 0%, transparent 70%)',
          filter: 'blur(20px)',
          pointerEvents: 'none'
        }} />
        <div style={{
          position: 'absolute',
          bottom: '-80px',
          left: '-80px',
          width: '200px',
          height: '200px',
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(216, 0, 72, 0.15) 0%, transparent 70%)',
          filter: 'blur(20px)',
          pointerEvents: 'none'
        }} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div>
            <h2 style={{ color: '#fff', margin: 0, fontSize: '22px', fontWeight: 700 }}>
              Bulk Upload Items
            </h2>
            <p style={{ color: 'rgba(255,255,255,0.5)', margin: 0, fontSize: '13px' }}>
              Import item master details using a CSV spreadsheet
            </p>
          </div>
          <Button
            type="link"
            icon={<DownloadOutlined />}
            onClick={handleDownloadTemplate}
            style={{ color: '#ff4d4f', border: '1px solid rgba(255, 77, 79, 0.3)', borderRadius: 8, height: 38 }}
          >
            Download CSV Template
          </Button>
        </div>

        <div style={{ marginBottom: 24 }}>
          <Dragger
            accept=".csv"
            fileList={fileList}
            beforeUpload={beforeUpload}
            onRemove={handleRemove}
            showUploadList={true}
            style={{
              background: 'rgba(255,255,255,0.03)',
              border: '2px dashed rgba(255,255,255,0.15)',
              borderRadius: 16,
              padding: '24px'
            }}
          >
            <p className="ant-upload-drag-icon" style={{ color: '#ff4d4f', fontSize: 40, marginBottom: 8 }}>
              {validating ? <LoadingOutlined /> : <CloudUploadOutlined />}
            </p>
            <p style={{ color: '#fff', fontSize: '15px', fontWeight: 600, margin: '0 0 4px 0' }}>
              {validating ? 'Analyzing file structure...' : 'Click or drag CSV file here to upload'}
            </p>
            <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: '12px', margin: 0 }}>
              Ensure columns match the standard template schema. Level 1, 2, and 3 categories are mandatory.
            </p>
          </Dragger>
        </div>

        {/* Validation Summary and Reports */}
        {validationResult && (
          <div style={{ marginBottom: 24 }}>
            <div style={{
              display: 'flex',
              gap: 16,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 12,
              padding: '16px',
              marginBottom: 16
            }}>
              <div>
                <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, textTransform: 'uppercase' }}>Total Rows</span>
                <h3 style={{ color: '#fff', margin: 0, fontSize: 20 }}>{validationResult.total_rows}</h3>
              </div>
              <div style={{ borderLeft: '1px solid rgba(255,255,255,0.08)', paddingLeft: 16 }}>
                <span style={{ color: '#52c41a', fontSize: 11, textTransform: 'uppercase' }}>Valid Rows</span>
                <h3 style={{ color: '#52c41a', margin: 0, fontSize: 20 }}>{validationResult.valid_rows}</h3>
              </div>
              <div style={{ borderLeft: '1px solid rgba(255,255,255,0.08)', paddingLeft: 16 }}>
                <span style={{ color: '#ff4d4f', fontSize: 11, textTransform: 'uppercase' }}>Invalid Rows</span>
                <h3 style={{ color: '#ff4d4f', margin: 0, fontSize: 20 }}>{validationResult.error_rows}</h3>
              </div>
            </div>

            <div style={{
              background: 'rgba(0,0,0,0.2)',
              borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.05)',
              maxHeight: 240,
              overflowY: 'auto'
            }}>
              <Table
                dataSource={validationResult.report}
                columns={reportColumns}
                rowKey="row_index"
                pagination={false}
                size="small"
                theme="dark"
                rowClassName={() => 'dark-table-row'}
                style={{
                  background: 'transparent',
                }}
              />
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: 12 }}>
          <Button
            onClick={() => {
              handleRemove();
              onClose();
            }}
            disabled={importing}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.15)',
              color: '#fff',
              borderRadius: 10,
              height: 40,
            }}
          >
            Cancel
          </Button>
          <Button
            type="primary"
            onClick={handleImport}
            loading={importing}
            disabled={
              fileList.length === 0 ||
              validating ||
              (validationResult && !validationResult.success)
            }
            style={{
              background: 'linear-gradient(90deg, #d80030 0%, #900078 100%)',
              border: 0,
              color: '#fff',
              borderRadius: 10,
              height: 40,
              fontWeight: 600,
              boxShadow: fileList.length > 0 ? '0 4px 12px rgba(216,0,72,0.25)' : 'none',
            }}
          >
            Import Items ({validationResult ? validationResult.valid_rows : 0})
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default BulkUploadModal;
