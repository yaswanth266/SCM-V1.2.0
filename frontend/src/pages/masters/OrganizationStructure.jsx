import React, { useEffect, useMemo, useState } from 'react';
import {
  App as AntApp, Button, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Tabs,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, SyncOutlined, UserAddOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import PageHeader from '../../components/PageHeader';
import DataTable from '../../components/DataTable';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

const toArray = (data) => data?.items || data?.data || data || [];

const ENDPOINTS = {
  projects: '/masters/org-projects',
  offices: '/masters/offices',
  positions: '/masters/positions',
  employees: '/masters/employees',
};

const OrganizationStructure = () => {
  const { message } = AntApp.useApp();
  const [activeTab, setActiveTab] = useState('projects');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRow, setEditingRow] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [projects, setProjects] = useState([]);
  const [offices, setOffices] = useState([]);
  const [positions, setPositions] = useState([]);
  const [roles, setRoles] = useState([]);
  const [form] = Form.useForm();
  const [userForm] = Form.useForm();

  const loadLookups = async () => {
    try {
      const [projectRes, officeRes, positionRes, roleRes] = await Promise.all([
        api.get(ENDPOINTS.projects, { params: { page_size: 1000 } }),
        api.get(ENDPOINTS.offices, { params: { page_size: 1000 } }),
        api.get(ENDPOINTS.positions, { params: { page_size: 1000 } }),
        api.get('/settings/roles', { params: { page_size: 1000, include_inactive: true } }),
      ]);
      setProjects(toArray(projectRes.data));
      setOffices(toArray(officeRes.data));
      setPositions(toArray(positionRes.data));
      setRoles(toArray(roleRes.data));
    } catch {
      setProjects([]);
      setOffices([]);
      setPositions([]);
      setRoles([]);
    }
  };

  useEffect(() => {
    loadLookups();
  }, [refreshKey]);

  const projectOptions = useMemo(() => projects.map((row) => ({ label: `${row.code} - ${row.name}`, value: row.id })), [projects]);
  const officeOptions = useMemo(() => offices.map((row) => ({ label: row.name, value: row.id })), [offices]);
  const positionOptions = useMemo(
    () => positions.map((row) => ({ label: `${row.code} - ${row.name}`, value: row.id })),
    [positions],
  );
  const roleOptions = useMemo(
    () => roles.map((row) => ({
      label: `${row.code || row.name} - ${row.name}${row.is_active === false ? ' (Inactive)' : ''}`,
      value: row.id,
    })),
    [roles],
  );

  const fetchRows = (entity) => (params) => api.get(ENDPOINTS[entity], { params });

  const openAdd = () => {
    setEditingRow(null);
    form.resetFields();
    form.setFieldsValue({ status: activeTab === 'employees' ? 'Active' : 'active' });
    setModalOpen(true);
  };

  const openEdit = (record) => {
    setEditingRow(record);
    form.resetFields();
    form.setFieldsValue({
      ...record,
      dob: record.dob ? dayjs(record.dob) : undefined,
    });
    setModalOpen(true);
  };

  const closeModal = () => {
    if (submitting) return;
    setModalOpen(false);
    setEditingRow(null);
    form.resetFields();
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const payload = {
        ...values,
        dob: values.dob ? values.dob.format('YYYY-MM-DD') : undefined,
      };
      setSubmitting(true);
      const endpoint = ENDPOINTS[activeTab];
      if (editingRow) {
        await api.put(`${endpoint}/${editingRow.id}`, payload);
        message.success('Record updated');
      } else {
        await api.post(endpoint, payload);
        message.success('Record created');
      }
      setModalOpen(false);
      setEditingRow(null);
      form.resetFields();
      setRefreshKey((key) => key + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (record) => {
    try {
      await api.delete(`${ENDPOINTS[activeTab]}/${record.id}`);
      message.success('Record removed');
      setRefreshKey((key) => key + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    }
  };

  const handleSyncEmployees = async () => {
    setSyncing(true);
    try {
      const res = await api.post('/masters/employees/sync-api', null, { timeout: 180000 });
      const data = res.data || {};
      message.success(
        `HR sync completed. Fetched ${data.fetched || 0} of ${data.api_total || data.fetched || 0}. Created ${data.created || 0}, updated ${data.updated || 0}, linked users ${data.linked_users || 0}.`,
      );
      setRefreshKey((key) => key + 1);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setSyncing(false);
    }
  };

  const openCreateUser = (employee) => {
    const username = (employee.employee_code || '').replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    const nameParts = (employee.name || '').trim().split(/\s+/);
    setSelectedEmployee(employee);
    userForm.resetFields();
    userForm.setFieldsValue({
      username,
      email: employee.email || `${username || `emp_${employee.id}`}@bavya-scm.local`,
      first_name: nameParts[0] || employee.employee_code,
      last_name: nameParts.slice(1).join(' '),
      user_type: 'staff',
    });
    setUserModalOpen(true);
  };

  const handleCreateUser = async () => {
    if (!selectedEmployee) return;
    try {
      const values = await userForm.validateFields();
      setCreatingUser(true);
      const res = await api.post(`/masters/employees/${selectedEmployee.id}/create-user`, values);
      message.success(res.data?.message || 'User created from employee');
      setUserModalOpen(false);
      setSelectedEmployee(null);
      userForm.resetFields();
      setRefreshKey((key) => key + 1);
    } catch (err) {
      if (err.errorFields) return;
      message.error(getErrorMessage(err));
    } finally {
      setCreatingUser(false);
    }
  };

  const actionColumn = {
    title: 'Actions',
    width: 120,
    fixed: 'right',
    render: (_, record) => (
      <Space>
        <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
        <Popconfirm title="Remove this record?" onConfirm={() => handleDelete(record)}>
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      </Space>
    ),
  };

  const employeeActionColumn = {
    ...actionColumn,
    render: (_, record) => (
      <Space>
        {!record.user_id && (
          <Button size="small" icon={<UserAddOutlined />} onClick={() => openCreateUser(record)}>
            User
          </Button>
        )}
        {record.user_id && <span style={{ color: '#5b3f45', fontSize: 12 }}>{record.username}</span>}
        <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)} />
        <Popconfirm title="Remove this record?" onConfirm={() => handleDelete(record)}>
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      </Space>
    ),
  };

  const columnsByTab = {
    projects: [
      { title: 'Code', dataIndex: 'code', width: 140 },
      { title: 'Project Name', dataIndex: 'name' },
      { title: 'Status', dataIndex: 'status', width: 120 },
      { title: 'Description', dataIndex: 'description', ellipsis: true },
      actionColumn,
    ],
    offices: [
      { title: 'Office', dataIndex: 'name', width: 220 },
      { title: 'Level', dataIndex: 'level', width: 120 },
      { title: 'State', dataIndex: 'state', width: 140 },
      { title: 'District', dataIndex: 'district', width: 140 },
      { title: 'Cluster', dataIndex: 'cluster', width: 140 },
      { title: 'Location', dataIndex: 'specific_location', width: 180 },
      actionColumn,
    ],
    positions: [
      { title: 'Code', dataIndex: 'code', width: 150 },
      { title: 'Position', dataIndex: 'name', width: 220 },
      { title: 'Role', dataIndex: 'role_name', width: 170 },
      { title: 'Role Code', dataIndex: 'role_code', width: 150 },
      { title: 'Level', dataIndex: 'level_name', width: 120 },
      { title: 'Department', dataIndex: 'department', width: 150 },
      { title: 'Project', dataIndex: 'project_name', width: 180 },
      { title: 'Office', dataIndex: 'office_name', width: 180 },
      { title: 'Reports To', dataIndex: 'parent_position_name', width: 180 },
      actionColumn,
    ],
    employees: [
      { title: 'Employee Code', dataIndex: 'employee_code', width: 160 },
      { title: 'Name', dataIndex: 'name', width: 220 },
      { title: 'Status', dataIndex: 'status', width: 110 },
      { title: 'Phone', dataIndex: 'phone', width: 140 },
      { title: 'Email', dataIndex: 'email', width: 220 },
      { title: 'Position', dataIndex: 'position_name', width: 200 },
      employeeActionColumn,
    ],
  };

  const renderFormFields = () => {
    if (activeTab === 'projects') {
      return (
        <>
          <Form.Item name="code" label="Project Code" rules={[{ required: true, message: 'Project code is required' }]}>
            <Input maxLength={50} />
          </Form.Item>
          <Form.Item name="name" label="Project Name" rules={[{ required: true, message: 'Project name is required' }]}>
            <Input maxLength={255} />
          </Form.Item>
          <Form.Item name="status" label="Status">
            <Select options={[{ label: 'Active', value: 'active' }, { label: 'Inactive', value: 'inactive' }, { label: 'Completed', value: 'completed' }]} />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} />
          </Form.Item>
        </>
      );
    }

    if (activeTab === 'offices') {
      return (
        <>
          <Form.Item name="name" label="Office Name" rules={[{ required: true, message: 'Office name is required' }]}>
            <Input maxLength={255} />
          </Form.Item>
          <Space.Compact block>
            <Form.Item name="level" label="Level" style={{ width: '50%' }}>
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="cluster_type" label="Cluster Type" style={{ width: '50%' }}>
              <Input maxLength={50} />
            </Form.Item>
          </Space.Compact>
          <Space.Compact block>
            <Form.Item name="country" label="Country" style={{ width: '50%' }}>
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item name="state" label="State" style={{ width: '50%' }}>
              <Input maxLength={100} />
            </Form.Item>
          </Space.Compact>
          <Space.Compact block>
            <Form.Item name="district" label="District" style={{ width: '50%' }}>
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item name="mandal" label="Mandal" style={{ width: '50%' }}>
              <Input maxLength={100} />
            </Form.Item>
          </Space.Compact>
          <Form.Item name="cluster" label="Cluster">
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="specific_location" label="Specific Location">
            <Input maxLength={255} />
          </Form.Item>
          <Form.Item name="address" label="Address">
            <Input.TextArea rows={3} />
          </Form.Item>
        </>
      );
    }

    if (activeTab === 'positions') {
      return (
        <>
          <Form.Item name="code" label="Position Code" rules={[{ required: true, message: 'Position code is required' }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="name" label="Position Name" rules={[{ required: true, message: 'Position name is required' }]}>
            <Input maxLength={255} />
          </Form.Item>
          <Space.Compact block>
            <Form.Item name="role_id" label="Role" style={{ width: '50%' }}>
              <Select allowClear showSearch optionFilterProp="label" options={roleOptions} />
            </Form.Item>
            <Form.Item name="level_name" label="Level" style={{ width: '50%' }}>
              <Input maxLength={50} />
            </Form.Item>
          </Space.Compact>
          <Form.Item name="role_name" label="Role Name Override">
            <Input maxLength={100} placeholder="Optional fallback for imported roles" />
          </Form.Item>
          <Form.Item name="level_rank" label="Level Rank">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Space.Compact block>
            <Form.Item name="department" label="Department" style={{ width: '50%' }}>
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item name="section" label="Section" style={{ width: '50%' }}>
              <Input maxLength={100} />
            </Form.Item>
          </Space.Compact>
          <Form.Item name="project_id" label="Project">
            <Select allowClear showSearch optionFilterProp="label" options={projectOptions} />
          </Form.Item>
          <Form.Item name="office_id" label="Office">
            <Select allowClear showSearch optionFilterProp="label" options={officeOptions} />
          </Form.Item>
          <Form.Item name="parent_position_id" label="Reports To">
            <Select allowClear showSearch optionFilterProp="label" options={positionOptions.filter((option) => option.value !== editingRow?.id)} />
          </Form.Item>
        </>
      );
    }

    return (
      <>
        <Form.Item name="employee_code" label="Employee Code" rules={[{ required: true, message: 'Employee code is required' }]}>
          <Input maxLength={50} />
        </Form.Item>
        <Form.Item name="name" label="Employee Name" rules={[{ required: true, message: 'Employee name is required' }]}>
          <Input maxLength={255} />
        </Form.Item>
        <Form.Item name="position_id" label="Position">
          <Select allowClear showSearch optionFilterProp="label" options={positionOptions} />
        </Form.Item>
        <Space.Compact block>
          <Form.Item name="status" label="Status" style={{ width: '50%' }}>
            <Select options={[{ label: 'Active', value: 'Active' }, { label: 'Inactive', value: 'Inactive' }, { label: 'Relieved', value: 'Relieved' }]} />
          </Form.Item>
          <Form.Item name="gender" label="Gender" style={{ width: '50%' }}>
            <Select allowClear options={[{ label: 'Male', value: 'Male' }, { label: 'Female', value: 'Female' }, { label: 'Other', value: 'Other' }]} />
          </Form.Item>
        </Space.Compact>
        <Form.Item name="dob" label="Date of Birth">
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
        <Space.Compact block>
          <Form.Item name="phone" label="Phone" style={{ width: '50%' }}>
            <Input maxLength={15} />
          </Form.Item>
          <Form.Item name="email" label="Email" style={{ width: '50%' }}>
            <Input maxLength={100} />
          </Form.Item>
        </Space.Compact>
        <Space.Compact block>
          <Form.Item name="pan_number" label="PAN" style={{ width: '50%' }}>
            <Input maxLength={10} />
          </Form.Item>
          <Form.Item name="aadhaar_number" label="Aadhaar" style={{ width: '50%' }}>
            <Input maxLength={12} />
          </Form.Item>
        </Space.Compact>
        <Form.Item name="photo" label="Photo URL">
          <Input maxLength={255} />
        </Form.Item>
      </>
    );
  };

  const titleByTab = {
    projects: 'Project',
    offices: 'Office',
    positions: 'Position',
    employees: 'Employee',
  };

  return (
    <div>
      <PageHeader title="Organization Structure" subtitle="Projects, offices, positions, and employees">
        <Space>
          <Button icon={<SyncOutlined />} loading={syncing} onClick={handleSyncEmployees}>
            Sync API
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>Add {titleByTab[activeTab]}</Button>
        </Space>
      </PageHeader>
      <Tabs
        activeKey={activeTab}
        onChange={(key) => {
          setActiveTab(key);
          setRefreshKey((value) => value + 1);
        }}
        items={[
          { key: 'projects', label: 'Projects' },
          { key: 'offices', label: 'Offices' },
          { key: 'positions', label: 'Positions' },
          { key: 'employees', label: 'Employees' },
        ]}
      />
      <DataTable
        key={`${activeTab}-${refreshKey}`}
        columns={columnsByTab[activeTab]}
        fetchFunction={fetchRows(activeTab)}
        rowKey="id"
        searchPlaceholder={`Search ${titleByTab[activeTab].toLowerCase()}s...`}
        exportFileName={`organization_${activeTab}`}
        scroll={{ x: 'max-content' }}
      />
      <Modal
        title={`${editingRow ? 'Edit' : 'Add'} ${titleByTab[activeTab]}`}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={closeModal}
        confirmLoading={submitting}
        width={720}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          {renderFormFields()}
        </Form>
      </Modal>
      <Modal
        title={`Create User${selectedEmployee?.name ? ` - ${selectedEmployee.name}` : ''}`}
        open={userModalOpen}
        onOk={handleCreateUser}
        onCancel={() => {
          if (creatingUser) return;
          setUserModalOpen(false);
          setSelectedEmployee(null);
          userForm.resetFields();
        }}
        confirmLoading={creatingUser}
        width={560}
        destroyOnHidden
      >
        <Form form={userForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="username" label="Username" rules={[{ required: true, message: 'Username is required' }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="email" label="Email" rules={[{ required: true, message: 'Email is required' }, { type: 'email', message: 'Enter a valid email' }]}>
            <Input maxLength={255} />
          </Form.Item>
          <Space.Compact block>
            <Form.Item name="first_name" label="First Name" style={{ width: '50%' }} rules={[{ required: true, message: 'First name is required' }]}>
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item name="last_name" label="Last Name" style={{ width: '50%' }}>
              <Input maxLength={100} />
            </Form.Item>
          </Space.Compact>
          <Space.Compact block>
            <Form.Item name="password" label="Temporary Password" style={{ width: '50%' }} rules={[{ required: true, message: 'Password is required' }, { min: 8, message: 'Minimum 8 characters' }]}>
              <Input.Password maxLength={128} />
            </Form.Item>
            <Form.Item name="user_type" label="User Type" style={{ width: '50%' }}>
              <Select options={[{ label: 'Staff', value: 'staff' }, { label: 'Field Staff', value: 'field_staff' }, { label: 'Viewer', value: 'viewer' }, { label: 'Manager', value: 'manager' }]} />
            </Form.Item>
          </Space.Compact>
        </Form>
      </Modal>
    </div>
  );
};

export default OrganizationStructure;
