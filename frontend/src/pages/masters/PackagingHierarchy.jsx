import React, { useEffect, useState } from 'react';
import { usePackagingApi } from './usePackagingApi';
import api from '../../config/api';
import {
    Button,
    Input,
    Select,
    Card,
    Spin,
    Typography,
    Drawer,
    Form,
    InputNumber,
    Space,
    Popconfirm,
    List,
    Divider
} from 'antd';
import {
    DeleteOutlined,
    PlusOutlined,
    SaveOutlined,
    SettingOutlined
} from '@ant-design/icons';

const { Title, Text } = Typography;

export const ItemPackagingConfig = ({ itemId, itemName, baseUOM, availableLevels }) => {
    const { fetchHierarchy, saveHierarchy } = usePackagingApi();
    const [loading, setLoading] = useState(false);
    const [packagings, setPackagings] = useState([]);

    useEffect(() => {
        const loadData = async () => {
            if (!itemId) return;
            const data = await fetchHierarchy(itemId);
            if (data?.length) {
                setPackagings(data);
            } else {
                setPackagings([]);
            }
        };
        loadData();
    }, [itemId]);

    // Real-time client-side Debounced/Cascading UI state computation
    useEffect(() => {
        if (!availableLevels || availableLevels.length === 0 || packagings.length === 0) return;

        let updated = false;
        const newPackagings = [...packagings];

        newPackagings.forEach((pack, index) => {
            const isRoot = index === 0;
            const levelInfo = availableLevels.find(l => String(l.id) === String(pack.level_id));
            const levelName = levelInfo?.level_name || '';

            if (isRoot) {
                const expectedQty = pack.qty_per_parent || 1;
                const expectedSku = `${itemName} ${baseUOM} * ${expectedQty} ${levelName}`;
                if (pack.total_base_qty !== expectedQty || pack.sku_name !== expectedSku) {
                    newPackagings[index] = { ...pack, total_base_qty: expectedQty, sku_name: expectedSku };
                    updated = true;
                }
            } else {
                const parentPack = newPackagings[index - 1]; // Relies on linear UI structure mapping
                if (parentPack) {
                    const expectedBaseQty = (parentPack.total_base_qty || 1) * (pack.qty_per_parent || 1);
                    const expectedSku = `${parentPack.sku_name} * ${pack.qty_per_parent || 1} ${levelName}`;

                    if (pack.total_base_qty !== expectedBaseQty || pack.sku_name !== expectedSku) {
                        newPackagings[index] = { ...pack, total_base_qty: expectedBaseQty, sku_name: expectedSku };
                        updated = true;
                    }
                }
            }
        });

        if (updated) {
            setPackagings(newPackagings);
        }
    }, [JSON.stringify(packagings.map(p => ({ qty: p.qty_per_parent, level_id: p.level_id }))), availableLevels, itemName, baseUOM]);

    const handleFieldChange = (index, field, value) => {
        const newPackagings = [...packagings];
        newPackagings[index] = { ...newPackagings[index], [field]: value };
        setPackagings(newPackagings);
    };

    const addLevel = () => {
        if (!availableLevels || availableLevels.length === 0) return;
        const nextLevel = availableLevels.find(l => !packagings.some(p => String(p.level_id) === String(l.id)));
        setPackagings([
            ...packagings,
            { id: null, level_id: nextLevel?.id || '', parent_id: null, qty_per_parent: 1, sku_code: '', total_base_qty: 1, sku_name: '' }
        ]);
    };

    const removeLevel = (index) => {
        const newPackagings = [...packagings];
        newPackagings.splice(index, 1);
        setPackagings(newPackagings);
    };

    const onSubmit = async () => {
        setLoading(true);
        try {
            const payload = packagings.map((p, idx, arr) => ({
                id: p.id || null,
                level_id: parseInt(p.level_id),
                parent_id: idx > 0 ? arr[idx - 1].id || null : null,
                qty_per_parent: parseInt(p.qty_per_parent),
                sku_code: p.sku_code || null
            }));
            const savedData = await saveHierarchy(itemId, { packagings: payload });
            if (savedData?.length) setPackagings(savedData);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#f9fafb', padding: '16px', borderRadius: '8px' }}>
                <Title level={4} style={{ margin: 0 }}>{itemName} Packaging Configuration</Title>
                <Text type="secondary">Base UOM: {baseUOM}</Text>
            </div>

            <div>
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', marginBottom: '16px' }}>
                        <thead>
                            <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                                <th style={{ padding: '12px' }}>Container Type</th>
                                <th style={{ padding: '12px' }}>Qty per Parent</th>
                                <th style={{ padding: '12px' }}>SKU Code</th>
                                <th style={{ padding: '12px' }}>Total Base Qty</th>
                                <th style={{ padding: '12px', width: '33%' }}>Generated SKU Name</th>
                                <th style={{ padding: '12px' }}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {packagings.map((pack, index) => (
                                <tr key={index} style={{ borderBottom: '1px solid #e5e7eb' }}>
                                    <td style={{ padding: '12px' }}>
                                        <select
                                            value={pack.level_id}
                                            onChange={(e) => handleFieldChange(index, 'level_id', e.target.value)}
                                            style={{ padding: '6px 12px', borderRadius: '4px', border: '1px solid #d9d9d9', width: '100%', background: '#fff' }}
                                        >
                                            <option value="">Select Container Type...</option>
                                            {(availableLevels || [])
                                                .filter(l => {
                                                    if (String(l.id) === String(pack.level_id)) return true;
                                                    return !packagings.some((p, idx) => idx !== index && String(p.level_id) === String(l.id));
                                                })
                                                .map(l => (
                                                    <option key={l.id} value={l.id}>{l.level_name}</option>
                                                ))
                                            }
                                        </select>
                                    </td>
                                    <td style={{ padding: '12px' }}>
                                        <Input
                                            type="number"
                                            value={pack.qty_per_parent}
                                            onChange={e => handleFieldChange(index, 'qty_per_parent', parseInt(e.target.value) || 0)}
                                            style={{ width: '100px' }}
                                        />
                                    </td>
                                    <td style={{ padding: '12px' }}>
                                        <Input
                                            value={pack.sku_code || ''}
                                            onChange={e => handleFieldChange(index, 'sku_code', e.target.value)}
                                        />
                                    </td>
                                    <td style={{ padding: '12px' }}>
                                        <div style={{ backgroundColor: '#f3f4f6', padding: '6px 12px', borderRadius: '4px', textAlign: 'center', color: '#4b5563' }}>
                                            {pack.total_base_qty || 1}
                                        </div>
                                    </td>
                                    <td style={{ padding: '12px' }}>
                                        <div style={{ backgroundColor: '#eff6ff', color: '#1e40af', padding: '6px 12px', borderRadius: '4px', fontSize: '14px', wordBreak: 'break-word', border: '1px solid #dbeafe' }}>
                                            {pack.sku_name}
                                        </div>
                                    </td>
                                    <td style={{ padding: '12px' }}>
                                        <Button
                                            type="primary"
                                            danger
                                            icon={<DeleteOutlined />}
                                            onClick={() => removeLevel(index)}
                                        />
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <div style={{ display: 'flex', gap: '16px', marginTop: '16px' }}>
                    <Button icon={<PlusOutlined />} onClick={addLevel}>
                        Add Container
                    </Button>
                    <Button type="primary" icon={<SaveOutlined />} onClick={onSubmit} loading={loading}>
                        Save Hierarchy
                    </Button>
                </div>
            </div>

            <Card style={{ marginTop: '32px', backgroundColor: '#111827', color: '#fff' }} variant="borderless">
                <h3 style={{ marginBottom: '8px', color: '#9ca3af', fontWeight: 'bold', textTransform: 'uppercase', fontSize: '12px', letterSpacing: '0.05em' }}>
                    Hierarchy Preview
                </h3>
                {packagings.map((p, i) => (
                    <div key={i} style={{ paddingLeft: `${i * 20}px`, padding: '4px 0 4px ' + (i * 20) + 'px' }}>
                        └─ 📦 <span style={{ color: '#93c5fd', fontWeight: 'bold' }}>
                            {availableLevels.find(l => String(l.id) === String(p.level_id))?.level_name}
                        </span> ({p.qty_per_parent})
                        <span style={{ color: '#6b7280', marginLeft: '16px' }}>↳ Base Items: {p.total_base_qty}</span>
                    </div>
                )).reverse()}
            </Card>
        </div>
    );
};

export default function PackagingHierarchyPage() {
    const { fetchLevels, createLevel, deleteLevel } = usePackagingApi();
    const [selectedItem, setSelectedItem] = useState(null);
    const [items, setItems] = useState([]);
    const [availableLevels, setAvailableLevels] = useState([]);
    const [drawerVisible, setDrawerVisible] = useState(false);
    const [form] = Form.useForm();
    const [drawerLoading, setDrawerLoading] = useState(false);

    const loadLevels = async () => {
        const levels = await fetchLevels();
        setAvailableLevels(levels);
    };

    useEffect(() => {
        loadLevels();
    }, []);

    useEffect(() => {
        const fetchItems = async () => {
            try {
                const response = await api.get('/masters/items?page_size=10000');
                const data = response.data;
                setItems(data.items || data || []);
            } catch (err) {
                console.error("Failed to fetch items", err);
            }
        };
        fetchItems();
    }, []);

    const handleCreateLevel = async (values) => {
        setDrawerLoading(true);
        try {
            await createLevel(values);
            form.resetFields();
            // Automatically pre-populate next order
            const nextOrder = values.level_order + 1;
            form.setFieldsValue({ level_order: nextOrder });
            await loadLevels();
        } catch (err) {
            // Error notification is already handled in hook (message.error)
        } finally {
            setDrawerLoading(false);
        }
    };

    const handleDeleteLevel = async (levelId) => {
        setDrawerLoading(true);
        try {
            await deleteLevel(levelId);
            await loadLevels();
        } catch (err) {
            // Error is handled in hook
        } finally {
            setDrawerLoading(false);
        }
    };

    const openDrawer = () => {
        const maxOrder = availableLevels.reduce((max, lvl) => lvl.level_order > max ? lvl.level_order : max, 0);
        form.setFieldsValue({
            level_name: '',
            level_order: maxOrder + 1
        });
        setDrawerVisible(true);
    };

    return (
        <Card
            title="Packaging Hierarchy Configuration"
            style={{ margin: '24px' }}
            extra={
                <Button
                    type="primary"
                    icon={<SettingOutlined />}
                    onClick={openDrawer}
                >
                    Manage Container Type
                </Button>
            }
        >
            <div style={{ marginBottom: '24px' }}>
                <Typography.Text strong style={{ display: 'block', marginBottom: '8px' }}>
                    Select Item
                </Typography.Text>
                <Select
                    showSearch
                    placeholder="Search and select an item by name or code..."
                    optionFilterProp="label"
                    style={{ width: '100%' }}
                    onChange={(value) => {
                        const item = items.find(i => String(i.id) === String(value));
                        setSelectedItem(item || null);
                    }}
                    filterOption={(input, option) =>
                        (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                    }
                    options={items.map(i => ({
                        value: String(i.id),
                        label: `${i.name || i.item_name} (${i.item_code})`
                    }))}
                />
            </div>

            {selectedItem ? (
                <div style={{ marginTop: '24px', paddingTop: '24px', borderTop: '1px solid #f0f0f0' }}>
                    <ItemPackagingConfig
                        itemId={selectedItem.id}
                        itemName={selectedItem.name || selectedItem.item_name}
                        baseUOM={selectedItem.primary_uom?.name || selectedItem.uom_name || 'Unit'}
                        availableLevels={availableLevels}
                    />
                </div>
            ) : (
                <div style={{ textAlign: 'center', padding: '48px', backgroundColor: '#fafafa', borderRadius: '8px', border: '1px dashed #d9d9d9', color: '#8c8c8c' }}>
                    Please select an item to configure its packaging hierarchy.
                </div>
            )}

            <Drawer
                title="Manage Container Type"
                width={450}
                onClose={() => setDrawerVisible(false)}
                open={drawerVisible}
            >
                <List
                    loading={drawerLoading}
                    dataSource={availableLevels}
                    renderItem={(item) => (
                        <List.Item
                            key={item.id}
                            actions={[
                                <Popconfirm
                                    title="Delete Container Type"
                                    description={`Are you sure you want to delete "${item.level_name}"?`}
                                    onConfirm={() => handleDeleteLevel(item.id)}
                                    okText="Yes"
                                    cancelText="No"
                                    placement="left"
                                >
                                    <Button
                                        type="text"
                                        danger
                                        icon={<DeleteOutlined />}
                                    />
                                </Popconfirm>
                            ]}
                            style={{
                                padding: '12px 16px',
                                borderRadius: '8px',
                                marginBottom: '8px',
                                border: '1px solid #f0f0f0',
                                background: '#fafafa',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <div style={{
                                    width: '28px',
                                    height: '28px',
                                    borderRadius: '50%',
                                    backgroundColor: '#e6f4ff',
                                    color: '#0958d9',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontWeight: 'bold',
                                    fontSize: '14px'
                                }}>
                                    {item.level_order}
                                </div>
                                <div>
                                    <Typography.Text strong style={{ fontSize: '15px' }}>{item.level_name}</Typography.Text>
                                </div>
                            </div>
                        </List.Item>
                    )}
                />

                <Divider orientation="left" style={{ margin: '24px 0 16px 0' }}>Add New Container Type</Divider>

                <Form
                    form={form}
                    layout="vertical"
                    onFinish={handleCreateLevel}
                    autoComplete="off"
                    requiredMark="optional"
                >
                    <Form.Item
                        name="level_name"
                        label="Container Type Name"
                        rules={[
                            { required: true, message: 'Please enter container type name' },
                            { whitespace: true, message: 'Container type name cannot be empty spaces' }
                        ]}
                    >
                        <Input placeholder="e.g. Case, Pallet, Box" maxLength={50} />
                    </Form.Item>

                    <Form.Item
                        name="level_order"
                        label="Container Type Order"
                        tooltip="Lower numbers represent base container types (e.g. Unit = 1, Strip = 2)"
                        rules={[
                            { required: true, message: 'Please enter container type order' }
                        ]}
                    >
                        <InputNumber min={1} max={100} style={{ width: '100%' }} />
                    </Form.Item>

                    <Form.Item style={{ marginTop: '24px', marginBottom: 0 }}>
                        <Button type="primary" htmlType="submit" block loading={drawerLoading} icon={<PlusOutlined />}>
                            Add Container Type
                        </Button>
                    </Form.Item>
                </Form>
            </Drawer>
        </Card>
    );
}
