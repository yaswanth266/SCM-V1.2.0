import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  App as AntApp, Button, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tabs, Tag,
} from 'antd';
import { CloudSyncOutlined, DeleteOutlined, EditOutlined, PlusOutlined, SyncOutlined, UserAddOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import PageHeader from '../../../components/PageHeader';
import DataTable from '../../../components/DataTable';
import api from '../../../config/api';
import { getErrorMessage } from '../../../utils/helpers';

const toArray = (data) => data?.items || data?.data || data || [];

const renderHierarchy = (chain) => {
  if (!chain || !Array.isArray(chain) || chain.length === 0) {
    return <span style={{ color: '#aaa', fontStyle: 'italic' }}>No hierarchy</span>;
  }
  return (
    <Space size={[0, 2]} wrap>
      {chain.map((pos, i) => (
        <React.Fragment key={pos.id}>
          {i > 0 && <span style={{ color: '#bbb', fontSize: 11 }}>›</span>}
          <Tag
            color={
              pos.role_name?.includes('MANAGER') || pos.role_name?.includes('COO') ? 'blue' :
              pos.role_name?.includes('OFFICER') ? 'geekblue' :
              pos.role_name === 'OE' ? 'purple' :
              pos.role_name === 'DEO' || pos.role_name === 'LAB TECHNICIAN' || pos.role_name === 'STOREKEEPER' ? 'cyan' :
              pos.level_name ? 'default' : 'default'
            }
            style={{ fontSize: 11, lineHeight: '18px', margin: 0 }}
          >
            {pos.role_name || pos.name}
          </Tag>
        </React.Fragment>
      ))}
    </Space>
  );
};

const deduplicatePositions = (positions) => {
  if (!Array.isArray(positions)) return [];
  const unique = [];
  const seenRoleIds = new Set();
  const seenRoleNames = new Set();
  for (const p of positions) {
    if (!p) continue;
    if (typeof p !== 'object') {
      unique.push(p);
      continue;
    }
    const roleId = p.role_id;
    const roleName = (p.role_name || p.role_code || p.name || p.position_name || '').trim().toLowerCase();
    if (roleId != null) {
      if (seenRoleIds.has(roleId)) continue;
      seenRoleIds.add(roleId);
      if (roleName) seenRoleNames.add(roleName);
      unique.push(p);
    } else if (roleName) {
      if (seenRoleNames.has(roleName)) continue;
      seenRoleNames.add(roleName);
      unique.push(p);
    } else {
      unique.push(p);
    }
  }
  return unique;
};

const ENDPOINTS = {
  projects: '/masters/org-projects',
  offices: '/masters/offices',
  positions: '/masters/positions',
  employees: '/masters/employees',
};

const OrganizationStructure = () => {
  const navigate = useNavigate();
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

  const [positionFilters, setPositionFilters] = useState({
    project_id: undefined,
    office_id: undefined,
    department: undefined,
    status: undefined,
    employee_code: undefined,
  });

  const [employeeFilters, setEmployeeFilters] = useState({
    position_id: undefined,
    status: undefined,
    gender: undefined,
    employee_code: undefined,
  });

  // Refs hold the LATEST filter values synchronously so fetchRows never reads
  // a stale closure even when called on a freshly remounted DataTable.
  const positionFiltersRef = useRef(positionFilters);
  positionFiltersRef.current = positionFilters;
  const employeeFiltersRef  = useRef(employeeFilters);
  employeeFiltersRef.current  = employeeFilters;

  const handlePositionFilterChange = (field, value) => {
    // Update ref immediately so fetchRows reads the right value even before
    // the React state update has propagated to the next render.
    positionFiltersRef.current = { ...positionFiltersRef.current, [field]: value };
    setPositionFilters({ ...positionFiltersRef.current });
    // Force DataTable remount so the mount-effect fetch uses the updated params.
    setRefreshKey((k) => k + 1);
  };

  const handleEmployeeFilterChange = (field, value) => {
    employeeFiltersRef.current = { ...employeeFiltersRef.current, [field]: value };
    setEmployeeFilters({ ...employeeFiltersRef.current });
    setRefreshKey((k) => k + 1);
  };

  const handleResetFilters = () => {
    if (activeTab === 'positions') {
      const cleared = { project_id: undefined, office_id: undefined, department: undefined, status: undefined, employee_code: undefined };
      positionFiltersRef.current = cleared;
      setPositionFilters(cleared);
    } else if (activeTab === 'employees') {
      const cleared = { position_id: undefined, status: undefined, gender: undefined, employee_code: undefined };
      employeeFiltersRef.current = cleared;
      setEmployeeFilters(cleared);
    }
    setRefreshKey((k) => k + 1);
  };

  const departmentOptions = useMemo(() => {
    const depts = new Set(positions.map((p) => p.department).filter(Boolean));
    return Array.from(depts).sort().map((d) => ({ label: d, value: d }));
  }, [positions]);

  // Build the extra-param objects that get merged into every DataTable fetch call.
  // DataTable re-fetches page 1 automatically whenever these change.
  const positionExtraParams = useMemo(() => {
    const p = {};
    if (positionFilters.project_id != null) p.project_id = positionFilters.project_id;
    if (positionFilters.office_id  != null) p.office_id  = positionFilters.office_id;
    if (positionFilters.department != null) p.department = positionFilters.department;
    if (positionFilters.status     != null) p.status     = positionFilters.status;
    if (positionFilters.employee_code != null) p.employee_code = positionFilters.employee_code;
    return p;
  }, [positionFilters]);

  const employeeExtraParams = useMemo(() => {
    const p = {};
    if (employeeFilters.position_id != null) p.position_id = employeeFilters.position_id;
    if (employeeFilters.status      != null) p.status      = employeeFilters.status;
    if (employeeFilters.gender      != null) p.gender      = employeeFilters.gender;
    if (employeeFilters.employee_code != null) p.employee_code = employeeFilters.employee_code;
    return p;
  }, [employeeFilters]);

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
    () => positions.map((row) => ({
      label: `${row.code} - ${row.name}${row.employee_name ? ` (${row.employee_name})` : ''}`,
      value: row.id,
    })),
    [positions],
  );
  const roleOptions = useMemo(
    () => roles.map((row) => ({
      label: `${row.code || row.name} - ${row.name}${row.is_active === false ? ' (Inactive)' : ''}`,
      value: row.id,
    })),
    [roles],
  );

  // fetchRows reads from refs so it always has current filter values, even on
  // a freshly remounted DataTable whose closure was captured before state settled.
  const fetchRows = (entity) => (params) => {
    const finalParams = { ...params };
    if (entity === 'positions') {
      const f = positionFiltersRef.current;
      if (f.project_id != null) finalParams.project_id = f.project_id;
      if (f.office_id  != null) finalParams.office_id  = f.office_id;
      if (f.department != null) finalParams.department = f.department;
      if (f.status     != null) finalParams.status     = f.status;
      if (f.employee_code != null) finalParams.employee_code = f.employee_code;
    } else if (entity === 'employees') {
      const f = employeeFiltersRef.current;
      if (f.position_id != null) finalParams.position_id = f.position_id;
      if (f.status      != null) finalParams.status      = f.status;
      if (f.gender      != null) finalParams.gender      = f.gender;
      if (f.employee_code != null) finalParams.employee_code = f.employee_code;
    }
    return api.get(ENDPOINTS[entity], { params: finalParams });
  };

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
      if (activeTab === 'employees' && payload.phone) {
        payload.phone = payload.phone.replace(/[\s\-()]/g, '');
      }
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
      const task_id = res.data?.task_id;
      if (!task_id) {
        throw new Error('No sync task started from the server');
      }

      // Start polling
      const pollInterval = 3000;
      const maxAttempts = 100;
      let attempts = 0;

      const runPoll = async () => {
        try {
          attempts++;
          if (attempts > maxAttempts) {
            throw new Error('Sync tracking timed out on client. The sync may still be running on the server.');
          }

          const statusRes = await api.get(`/masters/employees/sync-status/${task_id}`);
          const taskData = statusRes.data || {};

          if (taskData.status === 'completed') {
            const data = taskData.result || {};
            message.success(
              `HR sync completed. Fetched ${data.fetched || 0} of ${data.api_total || data.fetched || 0}. Created ${data.created || 0}, updated ${data.updated || 0}, linked users ${data.linked_users || 0}.`,
            );
            setRefreshKey((key) => key + 1);
            setSyncing(false);
          } else if (taskData.status === 'failed') {
            throw new Error(taskData.error || 'Sync task failed on server');
          } else {
            setTimeout(runPoll, pollInterval);
          }
        } catch (pollErr) {
          message.error(getErrorMessage(pollErr));
          setSyncing(false);
        }
      };

      setTimeout(runPoll, pollInterval);

    } catch (err) {
      message.error(getErrorMessage(err));
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
      {
        title: 'Employee',
        key: 'employee',
        width: 180,
        render: (_, record) => {
          if (record.employee_name) {
            return `${record.employee_code ? `[${record.employee_code}] ` : ''}${record.employee_name}`;
          }
          return <span style={{ color: '#aaa', fontStyle: 'italic' }}>Unassigned</span>;
        },
      },
      { title: 'Role', dataIndex: 'role_name', width: 150 },
      { title: 'Role Code', dataIndex: 'role_code', width: 100 },
      { title: 'Level', dataIndex: 'level_name', width: 100 },
      { title: 'Rank', dataIndex: 'level_rank', width: 70 },
      { title: 'Department', dataIndex: 'department', width: 130 },
      { title: 'Section', dataIndex: 'section', width: 120 },
      { title: 'Job', dataIndex: 'job_name', width: 140 },
      { title: 'Job Family', dataIndex: 'job_family_name', width: 140 },
      { title: 'Status', dataIndex: 'position_status', width: 100 },
      { title: 'Start Date', dataIndex: 'start_date', width: 110, render: (v) => v ? dayjs(v).format('YYYY-MM-DD') : '-' },
      { title: 'Project', dataIndex: 'project_name', width: 150 },
      { title: 'Office', dataIndex: 'office_name', width: 150 },
      { title: 'Reports To', dataIndex: 'parent_position_name', width: 150, render: (text) => text || <span style={{ color: '#aaa', fontStyle: 'italic' }}>N/A</span> },
      {
        title: 'Hierarchy',
        key: 'hierarchy',
        width: 320,
        render: (_, record) => renderHierarchy(record.hierarchy),
      },
      actionColumn,
    ],
    employees: [
      { title: 'Employee Code', dataIndex: 'employee_code', width: 160 },
      { title: 'Name', dataIndex: 'name', width: 220 },
      { title: 'Status', dataIndex: 'status', width: 100 },
      { title: 'Gender', dataIndex: 'gender', width: 90 },
      { title: 'DOB', dataIndex: 'dob', width: 110, render: (v) => v ? dayjs(v).format('YYYY-MM-DD') : '-' },
      { title: 'Phone', dataIndex: 'phone', width: 140 },
      { title: 'Email', dataIndex: 'email', width: 220 },
      { title: 'PAN', dataIndex: 'pan_number', width: 120 },
      { title: 'Aadhaar', dataIndex: 'aadhaar_number', width: 130 },
      {
        title: 'Positions',
        key: 'positions',
        width: 280,
        render: (_, record) => {
          // Helper: format a single position object as "code – name"
          const posLabel = (p) => {
            if (typeof p !== 'object' || !p) return typeof p === 'string' ? p : '';
            const code = p.code || '';
            const name = p.name || '';
            return code && name ? `${code} – ${name}` : code || name;
          };

          // Multiple positions (positions relationship loaded)
          if (record.positions && Array.isArray(record.positions) && record.positions.length > 0) {
            const uniquePositions = deduplicatePositions(record.positions);
            return (
              <Space size={[0, 4]} wrap>
                {uniquePositions.map((p, i) => {
                  const label = posLabel(p);
                  return label ? <Tag key={i} color="blue">{label}</Tag> : null;
                })}
              </Space>
            );
          }

          // Pipe-separated fallback for legacy multi-position data
          if (record.position_name && record.position_name.includes('|')) {
            const parts = record.position_name.split('|').map((s) => s.trim()).filter(Boolean);
            if (parts.length > 1) {
              return (
                <Space size={[0, 4]} wrap>
                  {parts.map((p, i) => <Tag key={i} color="blue">{p}</Tag>)}
                </Space>
              );
            }
          }

          // Single position – show code – name
          if (record.position_name || record.position_code) {
            const label = record.position_code
              ? `${record.position_code} – ${record.position_name || ''}`
              : record.position_name;
            return <Tag color="blue">{label}</Tag>;
          }

          return record.designation || <span style={{ color: '#aaa', fontStyle: 'italic' }}>None</span>;
        },
      },
      {
        title: 'Hierarchy',
        key: 'hierarchy',
        width: 320,
        render: (_, record) => renderHierarchy(record.hierarchy),
      },
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
          <Form.Item
            name="phone"
            label="Phone"
            style={{ width: '50%' }}
            rules={[
              {
                validator: (_, value) => {
                  if (!value) return Promise.resolve();
                  const cleaned = value.replace(/[\s\-()]/g, '');
                  if (/^(?:\+?91|0)?[6-9]\d{9}$/.test(cleaned) || /^\+?[1-9]\d{9,14}$/.test(cleaned)) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('Enter a valid 10-digit mobile number, optionally with country code'));
                }
              }
            ]}
          >
            <Input maxLength={20} />
          </Form.Item>
          <Form.Item name="email" label="Email" style={{ width: '50%' }} rules={[{ type: 'email', message: 'Enter a valid email' }]}>
            <Input maxLength={100} />
          </Form.Item>
        </Space.Compact>
        <Space.Compact block>
          <Form.Item
            name="pan_number"
            label="PAN"
            style={{ width: '50%' }}
            rules={[
              { pattern: /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/, message: 'Enter a valid 10-character PAN number (e.g., ABCDE1234F)' }
            ]}
          >
            <Input maxLength={10} style={{ textTransform: 'uppercase' }} onChange={(e) => form.setFieldsValue({ pan_number: e.target.value.toUpperCase() })} />
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
          <Button icon={<CloudSyncOutlined />} onClick={() => navigate('/masters/organization-structure/hr-sync')}>
            HR Sync Dashboard
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
      {/* Filter Bar */}
      {(activeTab === 'positions' || activeTab === 'employees') && (
        <div style={{
          marginBottom: 16,
          padding: 16,
          background: '#fff',
          borderRadius: 8,
          border: '1px solid #f0f0f0',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'center',
        }}>
          <span style={{ fontWeight: 500, marginRight: 4 }}>Filters:</span>
          
          {activeTab === 'positions' && (
            <>
              <Input
                placeholder="Filter by Employee Code"
                style={{ width: 180 }}
                allowClear
                value={positionFilters.employee_code}
                onChange={(e) => handlePositionFilterChange('employee_code', e.target.value)}
              />
              <Select
                placeholder="Filter by Project"
                style={{ width: 180 }}
                allowClear
                options={projectOptions}
                value={positionFilters.project_id}
                onChange={(val) => handlePositionFilterChange('project_id', val)}
              />
              <Select
                placeholder="Filter by Office"
                style={{ width: 180 }}
                allowClear
                options={officeOptions}
                value={positionFilters.office_id}
                onChange={(val) => handlePositionFilterChange('office_id', val)}
              />
              <Select
                placeholder="Filter by Department"
                style={{ width: 180 }}
                allowClear
                options={departmentOptions}
                value={positionFilters.department}
                onChange={(val) => handlePositionFilterChange('department', val)}
              />
              <Select
                placeholder="Filter by Status"
                style={{ width: 140 }}
                allowClear
                options={[
                  { label: 'Active', value: 'active' },
                  { label: 'Inactive', value: 'inactive' },
                ]}
                value={positionFilters.status}
                onChange={(val) => handlePositionFilterChange('status', val)}
              />
            </>
          )}

          {activeTab === 'employees' && (
            <>
              <Input
                placeholder="Filter by Employee Code"
                style={{ width: 180 }}
                allowClear
                value={employeeFilters.employee_code}
                onChange={(e) => handleEmployeeFilterChange('employee_code', e.target.value)}
              />
              <Select
                placeholder="Filter by Position"
                style={{ width: 220 }}
                allowClear
                showSearch
                optionFilterProp="label"
                options={positionOptions}
                value={employeeFilters.position_id}
                onChange={(val) => handleEmployeeFilterChange('position_id', val)}
              />
              <Select
                placeholder="Filter by Status"
                style={{ width: 140 }}
                allowClear
                options={[
                  { label: 'Active', value: 'Active' },
                  { label: 'Inactive', value: 'Inactive' },
                  { label: 'Relieved', value: 'Relieved' },
                ]}
                value={employeeFilters.status}
                onChange={(val) => handleEmployeeFilterChange('status', val)}
              />
              <Select
                placeholder="Filter by Gender"
                style={{ width: 120 }}
                allowClear
                options={[
                  { label: 'Male', value: 'Male' },
                  { label: 'Female', value: 'Female' },
                  { label: 'Other', value: 'Other' },
                ]}
                value={employeeFilters.gender}
                onChange={(val) => handleEmployeeFilterChange('gender', val)}
              />
            </>
          )}

          <Button onClick={handleResetFilters}>Reset</Button>
        </div>
      )}
      <DataTable
        key={`${activeTab}-${refreshKey}`}
        columns={columnsByTab[activeTab]}
        fetchFunction={fetchRows(activeTab)}
        extraParams={
          activeTab === 'positions' ? positionExtraParams
          : activeTab === 'employees' ? employeeExtraParams
          : undefined
        }
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
              <Input.Password
                maxLength={128}
                onCopy={(e) => e.preventDefault()}
                onPaste={(e) => e.preventDefault()}
                onCut={(e) => e.preventDefault()}
              />
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
