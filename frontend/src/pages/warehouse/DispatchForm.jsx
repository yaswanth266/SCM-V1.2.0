import React, { useState, useEffect, useCallback } from 'react';
import {
  Button, Form, Input, InputNumber, Select, Space, DatePicker,
  message, Row, Col, Table, Card, Divider, Typography, Tag, Spin, Popconfirm, Tooltip, Radio
} from 'antd';
import {
  PlusOutlined, ArrowLeftOutlined, SaveOutlined, MinusCircleOutlined,
  CheckOutlined, EditOutlined, DeleteOutlined, BarcodeOutlined
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import PageHeader from '../../components/PageHeader';
import ItemSelector from '../../components/ItemSelector';
import SerialNumbersModal from '../../components/SerialNumbersModal';
import api from '../../config/api';
import { formatDate, getErrorMessage, formatDateForAPI, formatNumber } from '../../utils/helpers';
import { DATE_FORMAT } from '../../utils/constants';

const { TextArea } = Input;
const { Text } = Typography;

const DispatchForm = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryIssueId = searchParams.get('issue_id');
  const isNew = !id || id === 'new';
  const [form] = Form.useForm();

  const [loading, setLoading] = useState(!isNew);
  const [submitting, setSubmitting] = useState(false);
  const [editMode, setEditMode] = useState(isNew);

  // Lookups
  const [indents, setIndents] = useState([]);
  const [materialIssues, setMaterialIssues] = useState([]);
  const [uoms, setUoms] = useState([]);

  // Reference items
  const [selectedIndentItems, setSelectedIndentItems] = useState([]);
  const [selectedIssueItems, setSelectedIssueItems] = useState([]);
  const [selectedIndent, setSelectedIndent] = useState(null);
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [loadingIndent, setLoadingIndent] = useState(false);
  const [loadingIssue, setLoadingIssue] = useState(false);

  const [warehouses, setWarehouses] = useState([]);
  const [usersLookup, setUsersLookup] = useState([]);

  const destinationType = Form.useWatch('destination_type', form) || 'USER';
  const dispatchType = Form.useWatch('dispatch_type', form) || 'THIRD_PARTY';

  const loadLookups = useCallback(async () => {
    try {
      // For dispatch: fetch approved indents (not restricted to available_for_issue)
      // because a dispatched MI may reference a fully-issued indent that is no longer
      // 'available for issue' but must still appear in the dropdown.
      const [indentRes, issueRes, uomRes, warehouseRes, userRes] = await Promise.allSettled([
        api.get('/indents', { params: { page_size: 100, status: 'approved' } }),
        api.get('/warehouse/material-issues', { params: { page_size: 100, status: 'issued' } }),
        api.get('/masters/uom', { params: { page_size: 100 } }),
        api.get('/masters/warehouses', { params: { page_size: 200 } }),
        api.get('/users/lookup', { params: { page_size: 200 } }),
      ]);

      if (indentRes.status === 'fulfilled') {
        const data = indentRes.value.data;
        const items = data.items || data.data || data || [];
        setIndents(items.map(i => ({ label: i.indent_number, value: i.id })));
      }
      if (issueRes.status === 'fulfilled') {
        const data = issueRes.value.data;
        // Backend already filters by status='issued'; map to options.
        // Include indent_number in the label so users can see which indent the MI was raised against.
        const items = data.items || data.data || data || [];
        setMaterialIssues(items.map(i => ({
          label: i.indent_number
            ? `${i.issue_number} · Indent: ${i.indent_number}`
            : i.issue_number,
          value: i.id,
        })));
      }
      if (uomRes.status === 'fulfilled') {
        const data = uomRes.value.data;
        const items = data.items || data.data || data || [];
        setUoms(items.map(i => ({ label: i.name, value: i.name })));
      }
      if (warehouseRes.status === 'fulfilled') {
        const data = warehouseRes.value.data;
        const items = data.items || data.data || data || [];
        setWarehouses(items.map(w => ({ label: w.name, value: w.id })));
      }
      if (userRes.status === 'fulfilled') {
        const data = userRes.value.data;
        const items = data.items || data.data || data || [];
        setUsersLookup(items.map(u => ({ label: `${u.first_name} ${u.last_name || ''}`.trim(), value: u.id })));
      }
    } catch (err) {
      console.error('Failed to load lookups', err);
    }
  }, []);

  const handleIndentSelect = async (indentId) => {
    if (!indentId) { setSelectedIndentItems([]); setSelectedIndent(null); return; }
    setLoadingIndent(true);
    try {
      const res = await api.get(`/indents/${indentId}`);
      setSelectedIndent(res.data);
      setSelectedIndentItems((res.data.items || []).map(item => ({
        ...item,
        dispatched_quantity: 0,
        serial_numbers: [],
        key: item.id || Math.random()
      })));
    } catch (err) {
      message.error('Failed to load indent items');
    } finally {
      setLoadingIndent(false);
    }
  };

  const handleIssueSelect = async (issueId) => {
    if (!issueId) {
      setSelectedIssueItems([]);
      setSelectedIssue(null);
      form.setFieldValue('indent_id_ref', undefined);
      setSelectedIndentItems([]);
      setSelectedIndent(null);
      return;
    }
    setLoadingIssue(true);
    try {
      const res = await api.get(`/warehouse/material-issues/${issueId}`);
      const issueData = res.data;
      setSelectedIssue(issueData);
      // Inject the MI option with indent label into the dropdown so label renders correctly
      const miLabel = issueData.indent_number
        ? `${issueData.issue_number} · Indent: ${issueData.indent_number}`
        : issueData.issue_number;
      setMaterialIssues(prev =>
        prev.some(i => i.value === issueData.id)
          ? prev.map(i => i.value === issueData.id ? { ...i, label: miLabel } : i)
          : [...prev, { label: miLabel, value: issueData.id }]
      );
      setSelectedIssueItems((issueData.items || []).map(item => ({
        ...item,
        dispatched_quantity: item.qty || 0,
        serial_numbers: item.serial_numbers || [],
        key: item.id || Math.random()
      })));

      if (issueData.indent_id) {
        // Fetch the linked indent details so we can show its info card and items
        setLoadingIndent(true);
        try {
          const indentRes = await api.get(`/indents/${issueData.indent_id}`);
          const indentData = indentRes.data;
          setSelectedIndent(indentData);
          setSelectedIndentItems((indentData.items || []).map(item => ({
            ...item,
            dispatched_quantity: 0,
            serial_numbers: [],
            key: item.id || Math.random()
          })));
          // Ensure the indent option is present in the dropdown so the label renders
          const indentOption = { label: indentData.indent_number, value: indentData.id };
          setIndents(prev =>
            prev.some(i => i.value === indentData.id) ? prev : [...prev, indentOption]
          );
          // Set the form value AFTER the option is injected so Ant Design can resolve the label
          form.setFieldValue('indent_id_ref', indentData.id);
        } catch (indentErr) {
          console.error('Failed to load linked indent details', indentErr);
          form.setFieldValue('indent_id_ref', issueData.indent_id);
        } finally {
          setLoadingIndent(false);
        }
      } else {
        form.setFieldValue('indent_id_ref', undefined);
        setSelectedIndentItems([]);
        setSelectedIndent(null);
      }
    } catch (err) {
      console.error('Failed to load material issue details', err);
      message.error('Failed to load material issue items');
    } finally {
      setLoadingIssue(false);
    }
  };


  const fetchDispatch = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/warehouse/dispatch/${id}`);
      const data = res.data;
      form.setFieldsValue({
        ...data,
        dispatch_date: data.dispatch_date ? dayjs(data.dispatch_date) : null,
        expected_delivery_date: data.expected_delivery_date ? dayjs(data.expected_delivery_date) : null,
      });
      if (data.items && data.items.length > 0) {
        const firstItem = data.items[0];
        if (firstItem.indent_id) {
          const indentRes = await api.get(`/indents/${firstItem.indent_id}`);
          const indentData = indentRes.data;
          setSelectedIndent(indentData);
          setSelectedIndentItems((indentData.items || []).map(item => {
            const matched = data.items.find(di => di.material_id === item.item_id);
            return {
              ...item,
              dispatched_quantity: matched ? matched.dispatched_quantity : 0,
              serial_numbers: matched ? (matched.serial_numbers || []) : [],
              key: item.id || Math.random()
            };
          }));
          // Ensure the indent option exists in the dropdown so the label renders correctly
          setIndents(prev =>
            prev.some(i => i.value === indentData.id)
              ? prev
              : [...prev, { label: indentData.indent_number, value: indentData.id }]
          );
          form.setFieldValue('indent_id_ref', indentData.id);
        }
        if (firstItem.material_issue_id) {
          const issueRes = await api.get(`/warehouse/material-issues/${firstItem.material_issue_id}`);
          const issueData = issueRes.data;
          setSelectedIssue(issueData);
          setSelectedIssueItems((issueData.items || []).map(item => {
            const matched = data.items.find(di => di.material_id === item.item_id);
            return {
              ...item,
              dispatched_quantity: matched ? matched.dispatched_quantity : (item.qty || 0),
              serial_numbers: matched ? (matched.serial_numbers || []) : (item.serial_numbers || []),
              key: item.id || Math.random()
            };
          }));
          // Ensure the material issue option exists in the dropdown so the label renders
          setMaterialIssues(prev =>
            prev.some(i => i.value === issueData.id)
              ? prev
              : [...prev, { label: issueData.issue_number, value: issueData.id }]
          );
          form.setFieldValue('issue_id_ref', issueData.id);
        }
      }
    } catch (err) {
      message.error(getErrorMessage(err));
      navigate('/logistics/dispatch-orders');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLookups();
    if (!isNew) {
      fetchDispatch();
    } else {
      form.setFieldsValue({
        dispatch_date: dayjs(),
        status: 'Draft',
        destination_type: 'USER',
        dispatch_type: 'THIRD_PARTY',
        issue_id_ref: queryIssueId ? Number(queryIssueId) : undefined,
      });
      if (queryIssueId) handleIssueSelect(Number(queryIssueId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, queryIssueId]);

  useEffect(() => {
    if (selectedIndent && !indents.some(i => i.value === selectedIndent.id)) {
      setIndents(prev => [...prev, { label: selectedIndent.indent_number, value: selectedIndent.id }]);
    }
  }, [selectedIndent, indents]);

  useEffect(() => {
    if (selectedIssue && !materialIssues.some(i => i.value === selectedIssue.id)) {
      setMaterialIssues(prev => [...prev, { label: selectedIssue.issue_number, value: selectedIssue.id }]);
    }
  }, [selectedIssue, materialIssues]);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();

      const indentDispatchItems = selectedIndentItems
        .filter(item => item.dispatched_quantity > 0)
        .map(item => ({
          material_id: item.item_id,
          indent_id: values.indent_id_ref,
          material_issue_id: null,
          requested_quantity: item.requested_qty || 0,
          approved_quantity: item.approved_qty || 0,
          dispatched_quantity: item.dispatched_quantity,
          uom: item.uom_name || item.uom || '',
          request_date: item.required_date
            ? formatDateForAPI(item.required_date)
            : formatDateForAPI(values.dispatch_date || dayjs()),
          serial_numbers: item.serial_numbers && item.serial_numbers.length > 0
            ? item.serial_numbers : null,
        }));

      const issueDispatchItems = selectedIssueItems
        .filter(item => item.dispatched_quantity > 0)
        .map(item => ({
          material_id: item.item_id,
          indent_id: item.indent_id || values.indent_id_ref,
          material_issue_id: values.issue_id_ref,
          requested_quantity: item.requested_qty || 0,
          approved_quantity: item.qty || 0,
          dispatched_quantity: item.dispatched_quantity,
          uom: item.uom_name || item.uom || '',
          request_date: formatDateForAPI(values.dispatch_date || dayjs()),
          serial_numbers: item.serial_numbers && item.serial_numbers.length > 0
            ? item.serial_numbers : null,
        }));

      const finalItems = [...indentDispatchItems, ...issueDispatchItems];
      if (finalItems.length === 0) {
        message.error('Please enter dispatched quantity for at least one item');
        return;
      }

      setSubmitting(true);
      const payload = {
        ...values,
        dispatch_date: formatDateForAPI(values.dispatch_date),
        expected_delivery_date: values.expected_delivery_date
          ? formatDateForAPI(values.expected_delivery_date) : undefined,
        items: finalItems,
      };

      if (isNew) {
        await api.post('/warehouse/dispatch', payload);
        message.success('Dispatch created successfully');
      } else {
        await api.put(`/warehouse/dispatch/${id}`, payload);
        message.success('Dispatch updated successfully');
      }
      navigate('/logistics/dispatch-orders');
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '50px' }}><Spin size="large" /></div>;
  }

  return (
    <div className="page-container">
      <PageHeader title={isNew ? 'New Dispatch' : `Dispatch ${id}`}>
        <Space>
          <Button key="back" onClick={() => navigate('/logistics/dispatch-orders')} icon={<ArrowLeftOutlined />}>
            Back
          </Button>
          {editMode && (
            <Button key="save" type="primary" icon={<SaveOutlined />} loading={submitting} onClick={handleSubmit}>
              Save Dispatch
            </Button>
          )}
          {!editMode && form.getFieldValue('status') === 'Draft' && (
            <Button key="edit" type="primary" icon={<EditOutlined />} onClick={() => setEditMode(true)}>
              Edit
            </Button>
          )}
        </Space>
      </PageHeader>

      <Row gutter={[16, 16]}>
        {/* Left Side: Indent Reference */}
        <Col xs={24} lg={12}>
          <Card title="Indent Reference" size="small">
            <Form form={form} layout="vertical">
              <Form.Item name="indent_id_ref" label="Indent">
                <Select
                  showSearch
                  placeholder="Select an Indent"
                  options={indents}
                  onChange={handleIndentSelect}
                  allowClear
                  disabled={!editMode}
                />
              </Form.Item>
            </Form>
            {selectedIndent && (
              <div style={{
                background: '#fafafa', padding: '10px 14px',
                borderRadius: '6px', marginBottom: '14px', border: '1px solid #f0f0f0'
              }}>
                <Row gutter={16}>
                  <Col span={12}>
                    <Text type="secondary" style={{ fontSize: '12px', display: 'block' }}>Req. Warehouse</Text>
                    <Text strong style={{ fontSize: '13px' }}>{selectedIndent.warehouse_name || '—'}</Text>
                  </Col>
                  <Col span={12}>
                    <Text type="secondary" style={{ fontSize: '12px', display: 'block' }}>Req. User</Text>
                    <Text strong style={{ fontSize: '13px' }}>{selectedIndent.raised_by_name || '—'}</Text>
                  </Col>
                </Row>
              </div>
            )}
            <Table
              dataSource={selectedIndentItems}
              size="small"
              pagination={false}
              loading={loadingIndent}
              scroll={{ y: 300 }}
              columns={[
                { title: 'Material', render: (_, r) => r.item_name || r.item?.name },
                { title: 'Req. Qty', dataIndex: 'requested_qty', width: 90 },
                { title: 'Req. Date', dataIndex: 'required_date', render: d => formatDate(d), width: 100 },
              ]}
            />
          </Card>
        </Col>

        {/* Right Side: Material Issue Reference */}
        <Col xs={24} lg={12}>
          <Card title="Material Issue Reference" size="small">
            <Form form={form} layout="vertical">
              <Form.Item name="issue_id_ref" label="Material Issue">
                <Select
                  showSearch
                  placeholder="Select a Material Issue"
                  options={materialIssues}
                  onChange={handleIssueSelect}
                  allowClear
                  disabled={!editMode}
                />
              </Form.Item>
            </Form>
            {selectedIssue && (
              <div style={{
                background: '#fafafa', padding: '10px 14px',
                borderRadius: '6px', marginBottom: '14px', border: '1px solid #f0f0f0'
              }}>
                <Row gutter={16}>
                  <Col span={12}>
                    <Text type="secondary" style={{ fontSize: '12px', display: 'block' }}>Dispatch Warehouse</Text>
                    <Text strong style={{ fontSize: '13px' }}>{selectedIssue.destination_warehouse_name || '—'}</Text>
                  </Col>
                  <Col span={12}>
                    <Text type="secondary" style={{ fontSize: '12px', display: 'block' }}>Issued To</Text>
                    <Text strong style={{ fontSize: '13px' }}>{selectedIssue.issued_to_name || selectedIssue.issued_to || '—'}</Text>
                  </Col>
                </Row>
                <Row gutter={16} style={{ marginTop: 8 }}>
                  <Col span={24}>
                    <Text type="secondary" style={{ fontSize: '12px', display: 'block' }}>Indent Reference</Text>
                    {selectedIssue.indent_number ? (
                      <Text strong style={{ fontSize: '13px', color: '#1677ff' }}>
                        {selectedIssue.indent_number}
                      </Text>
                    ) : (
                      <Text type="secondary" style={{ fontSize: '13px' }}>No indent linked to this issue</Text>
                    )}
                  </Col>
                </Row>
              </div>
            )}
            <Table
              dataSource={selectedIssueItems}
              size="small"
              pagination={false}
              loading={loadingIssue}
              scroll={{ y: 300, x: 520 }}
              columns={[
                { title: 'Material', render: (_, r) => r.item_name || r.item?.name, ellipsis: true },
                { title: 'Appr. Qty', dataIndex: 'qty', width: 80, render: val => formatNumber(val) },
                { title: 'Disp. Qty', dataIndex: 'dispatched_quantity', width: 80, render: val => formatNumber(val) },
                { title: 'Batch', dataIndex: 'batch_number', width: 90 },
                {
                  title: 'Serial Nos',
                  dataIndex: 'serial_numbers',
                  width: 150,
                  render: (serials, record) => (
                    <SerialNumbersModal
                      value={serials || []}
                      itemName={record.item_name || record.item?.name}
                      itemCode={record.item_code}
                      quantity={Math.round(Number(record.dispatched_quantity || record.qty || 0))}
                      hasSerial={record.has_serial || (serials && serials.length > 0)}
                      size="small"
                      readOnly
                    />
                  ),
                },
              ]}
            />
            {selectedIssueItems.some(i => i.serial_numbers && i.serial_numbers.length > 0) && (
              <div style={{
                marginTop: 8, padding: '6px 10px',
                background: '#e6f7ff', border: '1px solid #91d5ff',
                borderRadius: 4, fontSize: 12, color: '#0050b3',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <BarcodeOutlined />
                Serial numbers from the Material Issue will be automatically carried over to this dispatch.
              </div>
            )}
          </Card>
        </Col>

        {/* Footer: Dispatch Details */}
        <Col span={24}>
          <Card size="small">
            <Form form={form} layout="horizontal">
              <Row gutter={24}>
                <Col span={24} style={{ marginBottom: '16px' }}>
                  <Form.Item name="dispatch_type" label="Shipment Type / Method" rules={[{ required: true }]}>
                    <Radio.Group buttonStyle="solid" disabled={!editMode}>
                      <Radio.Button value="THIRD_PARTY">Third Party Freight</Radio.Button>
                      <Radio.Button value="OWN_VEHICLE">Own Fleet Vehicle</Radio.Button>
                      <Radio.Button value="COURIER">Courier / AWB</Radio.Button>
                      <Radio.Button value="IN_PERSON">In-Person Handover</Radio.Button>
                    </Radio.Group>
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="dispatch_date" label="Dispatch Date" rules={[{ required: true }]}>
                    <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} disabled={!editMode} />
                  </Form.Item>
                </Col>
                {dispatchType !== 'THIRD_PARTY' && (
                  <Col span={8}>
                    <Form.Item name="expected_delivery_date" label="Expected Delivery Date" rules={[{ required: true, message: 'Please select expected delivery date' }]}>
                      <DatePicker style={{ width: '100%' }} format={DATE_FORMAT} disabled={!editMode} />
                    </Form.Item>
                  </Col>
                )}
                <Col span={8}>
                  <Form.Item name="status" label="Status" rules={[{ required: true }]}>
                    <Select disabled={!editMode}>
                      <Select.Option value="Draft">Draft</Select.Option>
                      <Select.Option value="Dispatched">Dispatched</Select.Option>
                      <Select.Option value="Delivered">Delivered</Select.Option>
                      <Select.Option value="Cancelled">Cancelled</Select.Option>
                    </Select>
                  </Form.Item>
                </Col>
                <Col span={8}>
                  <Form.Item name="destination_type" label="Destination Recipient Type" rules={[{ required: true }]}>
                    <Select disabled={!editMode}>
                      <Select.Option value="WAREHOUSE">Warehouse Transfer</Select.Option>
                      <Select.Option value="USER">Field User / Employee</Select.Option>
                      <Select.Option value="BRANCH">Internal Branch Office</Select.Option>
                      <Select.Option value="DEALER">Dealer / Distributor</Select.Option>
                    </Select>
                  </Form.Item>
                </Col>
                {destinationType === 'WAREHOUSE' && (
                  <Col span={8}>
                    <Form.Item name="destination_warehouse_id" label="Destination Warehouse" rules={[{ required: true, message: 'Please select destination warehouse' }]}>
                      <Select
                        placeholder="Choose recipient warehouse"
                        options={warehouses}
                        disabled={!editMode}
                        showSearch
                        filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
                      />
                    </Form.Item>
                  </Col>
                )}
                {destinationType === 'USER' && (
                  <Col span={8}>
                    <Form.Item name="destination_user_id" label="Destination SCM Field User" rules={[{ required: true, message: 'Please select recipient user' }]}>
                      <Select
                        placeholder="Choose recipient SCM user"
                        options={usersLookup}
                        disabled={!editMode}
                        showSearch
                        filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
                      />
                    </Form.Item>
                  </Col>
                )}
                <Col span={24}>
                  <Form.Item name="remarks" label="Remarks">
                    <TextArea rows={2} disabled={!editMode} placeholder="Enter delivery instructions or gate pass references..." />
                  </Form.Item>
                </Col>
              </Row>
            </Form>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default DispatchForm;