import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Alert,
  TextInput,
  Modal,
  FlatList,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import { router } from 'expo-router';
import { API_BASE_URL } from '../constants/config';

// ─── Custom Premium Vector Icons ───────────────────────────────────────────────
const Icon = ({ name, size = 18, color = '#7A6D66' }: { name: string; size?: number; color?: string }) => {
  const s = size;
  if (name === 'arrow-left') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.5, height: s * 0.5, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: color, transform: [{ rotate: '45deg' }, { translateX: s * 0.05 }] }} />
        <View style={{ position: 'absolute', width: s * 0.7, height: 2, backgroundColor: color, left: s * 0.15 }} />
      </View>
    );
  }
  if (name === 'plus') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ position: 'absolute', width: s * 0.7, height: 2, backgroundColor: color }} />
        <View style={{ position: 'absolute', width: 2, height: s * 0.7, backgroundColor: color }} />
      </View>
    );
  }
  if (name === 'search') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.45, height: s * 0.45, borderRadius: (s * 0.45) / 2, borderWidth: 2, borderColor: color, transform: [{ translateX: -s * 0.08 }, { translateY: -s * 0.08 }] }} />
        <View style={{ position: 'absolute', width: s * 0.35, height: 2, backgroundColor: color, bottom: s * 0.15, right: s * 0.15, transform: [{ rotate: '45deg' }] }} />
      </View>
    );
  }
  if (name === 'calendar') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.75, height: s * 0.75, borderRadius: 2, borderWidth: 1.8, borderColor: color, paddingTop: 4 }}>
          <View style={{ width: '100%', height: 1.5, backgroundColor: color, marginBottom: 3 }} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 2, paddingHorizontal: 2 }}>
            <View style={{ width: 2, height: 2, backgroundColor: color }} />
            <View style={{ width: 2, height: 2, backgroundColor: color }} />
            <View style={{ width: 2, height: 2, backgroundColor: color }} />
            <View style={{ width: 2, height: 2, backgroundColor: color }} />
          </View>
        </View>
      </View>
    );
  }
  if (name === 'check') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.25, height: s * 0.5, borderBottomWidth: 2, borderRightWidth: 2, borderColor: color, transform: [{ rotate: '45deg' }, { translateY: -s * 0.05 }] }} />
      </View>
    );
  }
  if (name === 'x') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ position: 'absolute', width: s * 0.7, height: 2, backgroundColor: color, transform: [{ rotate: '45deg' }] }} />
        <View style={{ position: 'absolute', width: s * 0.7, height: 2, backgroundColor: color, transform: [{ rotate: '-45deg' }] }} />
      </View>
    );
  }
  if (name === 'clock') {
    return (
      <View style={{ width: s, height: s, borderRadius: s / 2, borderWidth: 1.8, borderColor: color, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 1.8, height: s * 0.35, backgroundColor: color }} />
        <View style={{ position: 'absolute', width: s * 0.25, height: 1.8, backgroundColor: color, top: s / 2, left: s / 2 }} />
      </View>
    );
  }
  if (name === 'user') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.4, height: s * 0.4, borderRadius: (s * 0.4) / 2, borderWidth: 1.8, borderColor: color }} />
        <View style={{ width: s * 0.75, height: s * 0.25, borderTopLeftRadius: 5, borderTopRightRadius: 5, borderWidth: 1.8, borderColor: color, borderBottomWidth: 0, marginTop: 1 }} />
      </View>
    );
  }
  if (name === 'package') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.7, height: s * 0.7, borderWidth: 1.8, borderColor: color, borderRadius: 2 }} />
        <View style={{ position: 'absolute', width: s * 0.7, height: 1.5, backgroundColor: color }} />
      </View>
    );
  }
  if (name === 'trash') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.6, height: s * 0.7, borderWidth: 1.8, borderColor: color, borderTopWidth: 0, borderRadius: 1 }} />
        <View style={{ width: s * 0.75, height: 1.8, backgroundColor: color, marginBottom: 1 }} />
        <View style={{ position: 'absolute', width: s * 0.3, height: 3, borderTopLeftRadius: 2, borderTopRightRadius: 2, borderWidth: 1.8, borderColor: color, borderBottomWidth: 0, top: 0 }} />
      </View>
    );
  }
  if (name === 'edit') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.6, height: s * 0.6, borderWidth: 1.8, borderColor: color, transform: [{ rotate: '45deg' }] }} />
        <View style={{ position: 'absolute', width: 2, height: 2, backgroundColor: color, bottom: 2, left: 2 }} />
      </View>
    );
  }
  if (name === 'chevron-right') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.35, height: s * 0.35, borderTopWidth: 2, borderRightWidth: 2, borderColor: color, transform: [{ rotate: '45deg' }, { translateX: -s * 0.05 }] }} />
      </View>
    );
  }
  return null;
};

// ─── Custom Premium Dropdown Select ─────────────────────────────────────────────
const DropdownSelect = ({
  label,
  value,
  onValueChange,
  items,
  placeholder = 'Select an option',
  searchable = false,
}: {
  label: string;
  value: string;
  onValueChange: (val: string) => void;
  items: { label: string; value: string }[];
  placeholder?: string;
  searchable?: boolean;
}) => {
  const [modalVisible, setModalVisible] = useState(false);
  const [searchText, setSearchText] = useState('');
  const selectedItem = items.find((item) => item.value === value);

  const filteredItems = searchable && searchText
    ? items.filter((item) =>
        item.label.toLowerCase().includes(searchText.toLowerCase())
      )
    : items;

  const openModal = () => {
    setSearchText('');
    setModalVisible(true);
  };

  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TouchableOpacity
        style={styles.dropdownTrigger}
        onPress={openModal}
      >
        <Text style={[styles.dropdownTriggerText, !selectedItem && { color: '#94A3B8' }]}>
          {selectedItem ? selectedItem.label : placeholder}
        </Text>
        <View style={styles.dropdownArrow} />
      </TouchableOpacity>

      <Modal
        visible={modalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <TouchableOpacity
          style={styles.dropdownModalBg}
          activeOpacity={1}
          onPress={() => setModalVisible(false)}
        >
          <TouchableOpacity
            style={styles.dropdownModalContent}
            activeOpacity={1}
          >
            <View style={styles.dropdownModalHeader}>
              <Text style={styles.dropdownModalTitle}>{label}</Text>
              <TouchableOpacity onPress={() => setModalVisible(false)} style={styles.dropdownCloseBtn}>
                <Text style={styles.dropdownCloseBtnText}>Close</Text>
              </TouchableOpacity>
            </View>

            {/* Search bar — only shown when searchable=true */}
            {searchable && (
              <View style={{ paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 }}>
                <TextInput
                  style={styles.dropdownSearchInput}
                  placeholder={`Search ${label.replace(' *', '').toLowerCase()}...`}
                  placeholderTextColor="#94A3B8"
                  value={searchText}
                  onChangeText={setSearchText}
                  autoCapitalize="none"
                  autoFocus={false}
                />
              </View>
            )}

            <FlatList
              data={filteredItems}
              keyExtractor={(item) => item.value}
              style={{ maxHeight: 320 }}
              ListEmptyComponent={
                <View style={{ padding: 20, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, color: '#94A3B8' }}>No matches found</Text>
                </View>
              }
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[
                    styles.dropdownItemRow,
                    item.value === value && styles.dropdownItemRowActive,
                  ]}
                  onPress={() => {
                    onValueChange(item.value);
                    setModalVisible(false);
                  }}
                >
                  <Text style={[
                    styles.dropdownItemText,
                    item.value === value && styles.dropdownItemTextActive,
                  ]}>
                    {item.label}
                  </Text>
                </TouchableOpacity>
              )}
            />
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
};

// ─── Main Indents Component ───────────────────────────────────────────────────
export default function IndentsScreen() {
  const [token, setToken] = useState<string>('');
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // Lists and searching
  const [indents, setIndents] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeTab, setActiveTab] = useState<string>('all'); // all, draft, pending_approval, approved, rejected
  const [page, setPage] = useState<number>(1);
  const [total, setTotal] = useState<number>(0);

  // Modals / Details
  const [selectedIndent, setSelectedIndent] = useState<any>(null);
  const [detailModalVisible, setDetailModalVisible] = useState<boolean>(false);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);

  // Create/Edit Indent Modal
  const [formModalVisible, setFormModalVisible] = useState<boolean>(false);
  const [formIsNew, setFormIsNew] = useState<boolean>(true);
  const [formIndentId, setFormIndentId] = useState<number | null>(null);
  const [formLoading, setFormLoading] = useState<boolean>(false);

  // Form Fields
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [uoms, setUoms] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);

  const [selectedWarehouse, setSelectedWarehouse] = useState<string>('');
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [selectedVehicleCode, setSelectedVehicleCode] = useState<string>('');
  const [vehicleNumber, setVehicleNumber] = useState<string>('');
  const [requiredDate, setRequiredDate] = useState<string>('');
  const [isUrgent, setIsUrgent] = useState<boolean>(false);
  const [remarks, setRemarks] = useState<string>('');
  const [formItems, setFormItems] = useState<any[]>([]);

  // Item Selector Dropdown
  const [itemSearchText, setItemSearchText] = useState<string>('');
  const [itemSearchResults, setItemSearchResults] = useState<any[]>([]);
  const [itemSearchLoading, setItemSearchLoading] = useState<boolean>(false);
  const [activeItemIndex, setActiveItemIndex] = useState<number | null>(null);

  // App Approvals Overrides
  const [approveOverrides, setApproveOverrides] = useState<any>({});

  // ─── Initialization ─────────────────────────────────────────────────────────
  useEffect(() => {
    const loadSession = async () => {
      try {
        const savedToken = await AsyncStorage.getItem('user_token');
        const savedUserStr = await AsyncStorage.getItem('user_profile');

        if (!savedToken || !savedUserStr) {
          router.replace('/');
          return;
        }

        setToken(savedToken);
        setUser(JSON.parse(savedUserStr));

        // Load lookups
        fetchLookups(API_BASE_URL, savedToken);
        // Load Indents
        fetchIndents(API_BASE_URL, savedToken, 1, searchQuery, activeTab);
      } catch (e) {
        console.error('Error loading indents session:', e);
        router.replace('/');
      }
    };
    loadSession();
  }, []);

  // ─── API Fetching ───────────────────────────────────────────────────────────
  const fetchIndents = async (
    apiBase: string,
    authToken: string,
    pageNum: number,
    search: string,
    tab: string
  ) => {
    try {
      if (pageNum === 1) setLoading(true);
      const statusParam = tab === 'all' ? undefined : tab;
      const response = await axios.get(`${apiBase}/api/v1/indent/indents`, {
        headers: { Authorization: `Bearer ${authToken}` },
        params: {
          page: pageNum,
          page_size: 15,
          search: search || undefined,
          status: statusParam,
        },
      });

      const resData = response.data;
      const items = resData.items || resData.data || [];
      if (pageNum === 1) {
        setIndents(items);
      } else {
        setIndents((prev) => [...prev, ...items]);
      }
      setTotal(resData.total || items.length);
      setPage(pageNum);
    } catch (e) {
      console.error('Error fetching indents:', e);
      Alert.alert('Error', 'Failed to retrieve field indents list.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    fetchIndents(API_BASE_URL, token, 1, searchQuery, activeTab);
  };

  const loadMore = () => {
    if (indents.length < total && !loading) {
      fetchIndents(API_BASE_URL, token, page + 1, searchQuery, activeTab);
    }
  };

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    fetchIndents(API_BASE_URL, token, 1, val, activeTab);
  };

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    fetchIndents(API_BASE_URL, token, 1, searchQuery, tab);
  };

  const fetchLookups = async (apiBase: string, authToken: string) => {
    try {
      const [whRes, projRes, uomRes, vehRes] = await Promise.all([
        axios.get(`${apiBase}/api/v1/masters/warehouses`, {
          headers: { Authorization: `Bearer ${authToken}` },
          params: { page_size: 200, is_active: true },
        }),
        axios.get(`${apiBase}/api/v1/masters/projects`, {
          headers: { Authorization: `Bearer ${authToken}` },
          params: { page_size: 200 },
        }),
        axios.get(`${apiBase}/api/v1/masters/uom`, {
          headers: { Authorization: `Bearer ${authToken}` },
          params: { page_size: 200 },
        }),
        axios.get(`${apiBase}/api/v1/masters/vehicles`, {
          headers: { Authorization: `Bearer ${authToken}` },
          params: { page_size: 200, is_active: true },
        }),
      ]);

      setWarehouses(whRes.data.items || whRes.data.data || whRes.data || []);
      setProjects(projRes.data.items || projRes.data.data || projRes.data || []);
      setUoms(uomRes.data.items || uomRes.data.data || uomRes.data || []);
      setVehicles(vehRes.data.items || vehRes.data.data || vehRes.data || []);
    } catch (e) {
      console.error('Lookup load error:', e);
    }
  };

  // ─── Indent Details ──────────────────────────────────────────────────────────
  const openIndentDetails = async (indentId: number) => {
    setDetailLoading(true);
    setDetailModalVisible(true);
    try {
      const res = await axios.get(`${API_BASE_URL}/api/v1/indent/indents/${indentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setSelectedIndent(res.data);
      // Initialize approve overrides
      const overrides: any = {};
      (res.data.items || []).forEach((item: any) => {
        overrides[item.id] = (item.approved_qty != null ? item.approved_qty : item.requested_qty).toString();
      });
      setApproveOverrides(overrides);
    } catch (e) {
      console.error('Error fetching indent detail:', e);
      Alert.alert('Error', 'Failed to retrieve indent details.');
      setDetailModalVisible(false);
    } finally {
      setDetailLoading(false);
    }
  };

  // ─── Actions ────────────────────────────────────────────────────────────────
  const handleSubmitForApproval = async (indentId: number) => {
    Alert.alert('Submit Indent', 'Are you sure you want to submit this indent for approval?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Submit',
        onPress: async () => {
          try {
            await axios.post(`${API_BASE_URL}/api/v1/indent/indents/${indentId}/submit`, {}, {
              headers: { Authorization: `Bearer ${token}` },
            });
            Alert.alert('Success', 'Indent submitted successfully.');
            setDetailModalVisible(false);
            handleRefresh();
          } catch (err: any) {
            console.log('Submit failed error:', err);
            let errMsg = 'Failed to submit indent.';
            if (err.response) {
              if (typeof err.response.data?.detail === 'string') {
                errMsg = err.response.data.detail;
              } else if (Array.isArray(err.response.data?.detail)) {
                errMsg = err.response.data.detail.map((d: any) => {
                  const path = Array.isArray(d.loc) ? d.loc.join('.') : 'error';
                  return `${path}: ${d.msg}`;
                }).join('\n');
              } else if (err.response.data?.message) {
                errMsg = err.response.data.message;
              } else {
                errMsg = JSON.stringify(err.response.data);
              }
            } else if (err.message) {
              errMsg = err.message;
            }
            Alert.alert('Error', errMsg);
          }
        },
      },
    ]);
  };

  const handleApprove = async () => {
    if (!selectedIndent) return;
    Alert.alert('Approve Indent', 'Are you sure you want to approve this indent?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Approve',
        onPress: async () => {
          try {
            const itemsOverride = Object.keys(approveOverrides).map((id) => ({
              id: parseInt(id),
              approved_qty: parseFloat(approveOverrides[id] || '0'),
            }));
            await axios.post(
              `${API_BASE_URL}/api/v1/indent/indents/${selectedIndent.id}/approve`,
              { items: itemsOverride },
              { headers: { Authorization: `Bearer ${token}` } }
            );
            Alert.alert('Success', 'Indent approved successfully.');
            setDetailModalVisible(false);
            handleRefresh();
          } catch (err: any) {
            const errMsg = err.response?.data?.detail || 'Failed to approve indent.';
            Alert.alert('Error', errMsg);
          }
        },
      },
    ]);
  };

  const handleReject = async () => {
    if (!selectedIndent) return;
    Alert.alert('Reject Indent', 'Are you sure you want to reject this indent?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reject',
        style: 'destructive',
        onPress: async () => {
          try {
            await axios.post(
              `${API_BASE_URL}/api/v1/indent/indents/${selectedIndent.id}/reject`,
              {},
              { headers: { Authorization: `Bearer ${token}` } }
            );
            Alert.alert('Success', 'Indent rejected successfully.');
            setDetailModalVisible(false);
            handleRefresh();
          } catch (err: any) {
            const errMsg = err.response?.data?.detail || 'Failed to reject indent.';
            Alert.alert('Error', errMsg);
          }
        },
      },
    ]);
  };

  // ─── Create/Edit Form Logic ─────────────────────────────────────────────────
  const handleVehicleCodeChange = (val: string) => {
    setSelectedVehicleCode(val);
    const matched = vehicles.find((v) => v.vehicle_code === val);
    if (matched && matched.vehicle_number) {
      setVehicleNumber(matched.vehicle_number);
    }
  };

  const openNewForm = () => {
    setFormIsNew(true);
    setFormIndentId(null);
    setSelectedWarehouse(warehouses.length === 1 ? warehouses[0].id.toString() : '');
    setSelectedProject(projects.length === 1 ? projects[0].id.toString() : '');
    setSelectedVehicleCode('');
    setVehicleNumber('');

    // Default required date is 7 days from now (YYYY-MM-DD)
    const sevenDaysLater = new Date();
    sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
    const dateStr = sevenDaysLater.toISOString().split('T')[0];
    setRequiredDate(dateStr);

    setIsUrgent(false);
    setRemarks('');
    setFormItems([{ key: Date.now().toString(), item_id: '', item_name: '', requested_qty: '1', uom_id: '', uom_name: '' }]);
    setFormModalVisible(true);
  };

  const openEditForm = async (indent: any) => {
    setFormIsNew(false);
    setFormIndentId(indent.id);
    setSelectedWarehouse(indent.warehouse_id?.toString() || '');
    setSelectedProject(indent.project_id?.toString() || '');
    setSelectedVehicleCode(indent.vehicle_code || '');
    setVehicleNumber(indent.vehicle_number || '');
    setRequiredDate(indent.required_date ? indent.required_date.split('T')[0] : '');
    setIsUrgent(indent.indent_type === 'urgent');
    setRemarks(indent.remarks || '');

    const formattedItems = (indent.items || []).map((it: any) => ({
      key: Date.now().toString() + Math.random().toString(),
      item_id: it.item_id?.toString(),
      item_name: it.item_name || (it.item ? `[${it.item.item_code}] ${it.item.name || it.item.item_name}` : ''),
      requested_qty: (it.requested_qty || it.qty || 1).toString(),
      uom_id: it.uom_id?.toString(),
      uom_name: it.uom || it.uom_name || '',
    }));

    setFormItems(formattedItems.length > 0 ? formattedItems : [{ key: Date.now().toString(), item_id: '', item_name: '', requested_qty: '1', uom_id: '', uom_name: '' }]);
    setDetailModalVisible(false);
    setFormModalVisible(true);
  };

  // Add Item Row
  const addFormItemRow = () => {
    setFormItems((prev) => [
      ...prev,
      { key: Date.now().toString() + Math.random().toString(), item_id: '', item_name: '', requested_qty: '1', uom_id: '', uom_name: '' },
    ]);
  };

  // Remove Item Row
  const removeFormItemRow = (key: string) => {
    if (formItems.length === 1) return;
    setFormItems((prev) => prev.filter((item) => item.key !== key));
  };

  // Update Item Row values
  const updateFormItemRow = (key: string, field: string, val: any) => {
    setFormItems((prev) =>
      prev.map((item) => (item.key === key ? { ...item, [field]: val } : item))
    );
  };

  // Item Search Fetch
  const handleItemSearch = async (text: string, index: number) => {
    setItemSearchText(text);
    setActiveItemIndex(index);
    if (!text || text.length < 2) {
      setItemSearchResults([]);
      return;
    }

    setItemSearchLoading(true);
    try {
      const response = await axios.get(`${API_BASE_URL}/api/v1/masters/items`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { search: text, page_size: 20, is_active: true, transactable: true },
      });
      const data = response.data.items || response.data.data || response.data || [];
      setItemSearchResults(data);
    } catch (e) {
      console.error(e);
    } finally {
      setItemSearchLoading(false);
    }
  };

  const handleSelectItem = (item: any, index: number) => {
    const updated = [...formItems];
    updated[index] = {
      ...updated[index],
      item_id: item.id.toString(),
      item_name: `[${item.item_code || item.code}] ${item.name || item.item_name}`,
      uom_id: item.primary_uom_id?.toString() || '',
      uom_name: item.primary_uom?.name || item.primary_uom_name || '',
    };
    setFormItems(updated);
    setItemSearchResults([]);
    setActiveItemIndex(null);
    setItemSearchText('');
  };

  // Save / Submit Indent
  const handleSaveForm = async (submitForApproval: boolean) => {
    const validItems = formItems.filter((i) => i.item_id);
    if (validItems.length === 0) {
      Alert.alert('Validation Error', 'Please add at least one valid item.');
      return;
    }

    // Validate quantities
    for (const item of validItems) {
      const qty = parseFloat(item.requested_qty || '0');
      if (isNaN(qty) || qty <= 0) {
        Alert.alert('Validation Error', 'Quantity must be greater than 0 for all items.');
        return;
      }
    }

    // Validate mandatory vehicle code
    if (!selectedVehicleCode || !selectedVehicleCode.trim()) {
      Alert.alert('Validation Error', 'Vehicle code is required.');
      return;
    }

    setFormLoading(true);
    try {
      const payload = {
        warehouse_id: selectedWarehouse ? parseInt(selectedWarehouse) : null,
        project_id: selectedProject ? parseInt(selectedProject) : null,
        vehicle_code: selectedVehicleCode,
        vehicle_number: vehicleNumber || null,
        indent_type: isUrgent ? 'urgent' : 'regular',
        required_date: requiredDate,
        remarks: remarks || '',
        items: validItems.map((it) => ({
          item_id: parseInt(it.item_id),
          requested_qty: parseFloat(it.requested_qty),
          uom_id: it.uom_id ? parseInt(it.uom_id) : null,
          remarks: '',
        })),
      };

      let id = formIndentId;
      if (formIsNew) {
        const res = await axios.post(`${API_BASE_URL}/api/v1/indent/indents`, payload, {
          headers: { Authorization: `Bearer ${token}` },
        });
        id = res.data.id || res.data.data?.id;
      } else {
        await axios.put(`${API_BASE_URL}/api/v1/indent/indents/${formIndentId}`, payload, {
          headers: { Authorization: `Bearer ${token}` },
        });
      }

      if (submitForApproval && id) {
        await axios.post(`${API_BASE_URL}/api/v1/indent/indents/${id}/submit`, {}, {
          headers: { Authorization: `Bearer ${token}` },
        });
        Alert.alert('Success', 'Indent saved and submitted for approval.');
      } else {
        Alert.alert('Success', 'Indent saved successfully as draft.');
      }

      setFormModalVisible(false);
      handleRefresh();
    } catch (err: any) {
      console.log('Save failed error:', err);
      let errMsg = 'An error occurred while saving the indent.';
      if (err.response) {
        if (typeof err.response.data?.detail === 'string') {
          errMsg = err.response.data.detail;
        } else if (Array.isArray(err.response.data?.detail)) {
          errMsg = err.response.data.detail.map((d: any) => {
            const path = Array.isArray(d.loc) ? d.loc.join('.') : 'error';
            return `${path}: ${d.msg}`;
          }).join('\n');
        } else if (err.response.data?.message) {
          errMsg = err.response.data.message;
        } else {
          errMsg = JSON.stringify(err.response.data);
        }
      } else if (err.message) {
        errMsg = err.message;
      }
      Alert.alert('Save Failed', errMsg);
    } finally {
      setFormLoading(false);
    }
  };

  // Status tag helper style
  const getStatusStyle = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'draft':
        return { bg: '#F1F5F9', text: '#64748B' };
      case 'pending_approval':
        return { bg: '#FEF3C7', text: '#D97706' };
      case 'approved':
        return { bg: '#D1FAE5', text: '#059669' };
      case 'rejected':
        return { bg: '#FEE2E2', text: '#DC2626' };
      default:
        return { bg: '#E2E8F0', text: '#475569' };
    }
  };

  const getStatusText = (status: string) => {
    return status?.replace(/_/g, ' ').toUpperCase() || 'UNKNOWN';
  };

  // Render Indent Card
  const renderIndentItem = ({ item }: { item: any }) => {
    const statusStyle = getStatusStyle(item.status);
    const dateStr = item.indent_date ? new Date(item.indent_date).toLocaleDateString() : '-';
    const itemsCount = item.items?.length || 0;

    return (
      <TouchableOpacity
        style={styles.card}
        activeOpacity={0.7}
        onPress={() => openIndentDetails(item.id)}
      >
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{item.indent_number || `Draft #${item.id}`}</Text>
          <View style={[styles.statusTag, { backgroundColor: statusStyle.bg }]}>
            <Text style={[styles.statusText, { color: statusStyle.text }]}>
              {getStatusText(item.status)}
            </Text>
          </View>
        </View>

        <View style={styles.cardDetails}>
          <View style={styles.detailRow}>
            <Icon name="calendar" size={14} color="#7C3AED" />
            <Text style={styles.detailText}>Date: {dateStr}</Text>
          </View>
          <View style={styles.detailRow}>
            <Icon name="package" size={14} color="#7C3AED" />
            <Text style={styles.detailText}>Warehouse: {item.warehouse_name || '-'}</Text>
          </View>
          {item.project_name && (
            <View style={styles.detailRow}>
              <Icon name="user" size={14} color="#7C3AED" />
              <Text style={styles.detailText}>Project: {item.project_name}</Text>
            </View>
          )}
          <View style={styles.detailRow}>
            <Icon name="package" size={14} color="#7C3AED" />
            <Text style={styles.detailText}>{itemsCount} line item(s)</Text>
          </View>
        </View>

        <View style={styles.cardFooter}>
          <Text style={styles.cardFooterType}>
            Type: {item.indent_type?.toUpperCase() || 'REGULAR'}
          </Text>
          <Icon name="chevron-right" size={16} color="#7C3AED" />
        </View>
      </TouchableOpacity>
    );
  };
  const warehouseItems = warehouses.map((wh: any) => ({
    label: wh.name || wh.warehouse_name || `Warehouse #${wh.id}`,
    value: wh.id.toString(),
  }));

  const projectItems = projects.map((proj: any) => ({
    label: proj.name || proj.project_name || `Project #${proj.id}`,
    value: proj.id.toString(),
  }));

  const uomItems = uoms.map((uom: any) => ({
    label: uom.abbreviation ? `${uom.name} (${uom.abbreviation})` : uom.name,
    value: uom.id.toString(),
  }));

  const vehicleItems = vehicles.map((v: any) => ({
    label: v.vehicle_number ? `${v.vehicle_code} (${v.vehicle_number})` : v.vehicle_code,
    value: v.vehicle_code,
  }));

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <LinearGradient
        colors={['#4A1060', '#3A0F40']}
        style={styles.header}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
      >
        <View style={styles.headerTop}>
          <TouchableOpacity
            style={styles.headerButton}
            onPress={() => router.replace('/dashboard')}
          >
            <Icon name="arrow-left" size={20} color="#FFFFFF" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Field Indents</Text>
          <TouchableOpacity style={styles.headerButton} onPress={openNewForm}>
            <Icon name="plus" size={20} color="#FFFFFF" />
          </TouchableOpacity>
        </View>

        {/* Search bar */}
        <View style={styles.searchBar}>
          <Icon name="search" size={18} color="#94A3B8" />
          <TextInput
            style={styles.searchInput}
            placeholder="Search by number, department..."
            placeholderTextColor="#94A3B8"
            value={searchQuery}
            onChangeText={handleSearchChange}
          />
        </View>
      </LinearGradient>

      {/* Tabs */}
      <View style={styles.tabContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabScroll}>
          {['all', 'draft', 'pending_approval', 'approved', 'rejected'].map((tab) => (
            <TouchableOpacity
              key={tab}
              style={[styles.tab, activeTab === tab && styles.tabActive]}
              onPress={() => handleTabChange(tab)}
            >
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                {tab.replace(/_/g, ' ').toUpperCase()}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Indents List */}
      {loading && page === 1 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#4A1060" />
          <Text style={styles.loadingText}>Loading indents...</Text>
        </View>
      ) : indents.length === 0 ? (
        <ScrollView
          contentContainerStyle={styles.emptyContainer}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        >
          <Icon name="package" size={48} color="#CBD5E1" />
          <Text style={styles.emptyText}>No field indents found</Text>
          <TouchableOpacity style={styles.emptyButton} onPress={openNewForm}>
            <Text style={styles.emptyButtonText}>Raise First Indent</Text>
          </TouchableOpacity>
        </ScrollView>
      ) : (
        <FlatList
          data={indents}
          keyExtractor={(item) => item.id.toString()}
          renderItem={renderIndentItem}
          contentContainerStyle={styles.listContent}
          onEndReached={loadMore}
          onEndReachedThreshold={0.2}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          ListFooterComponent={
            indents.length < total ? (
              <ActivityIndicator style={{ padding: 16 }} color="#4A1060" />
            ) : null
          }
        />
      )}

      {/* ─── Detail Modal ─── */}
      <Modal
        visible={detailModalVisible}
        animationType="slide"
        onRequestClose={() => setDetailModalVisible(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          {/* Modal Header */}
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setDetailModalVisible(false)}>
              <Icon name="arrow-left" size={20} color="#334155" />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>
              {selectedIndent ? selectedIndent.indent_number || `Draft #${selectedIndent.id}` : 'Indent Details'}
            </Text>
            <View style={{ width: 20 }} />
          </View>

          {detailLoading || !selectedIndent ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#4A1060" />
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.modalScroll}>
              {/* Status Header */}
              <View style={styles.modalStatusHeader}>
                <Text style={styles.statusLabel}>STATUS</Text>
                <View style={[styles.statusTag, { backgroundColor: getStatusStyle(selectedIndent.status).bg }]}>
                  <Text style={[styles.statusText, { color: getStatusStyle(selectedIndent.status).text }]}>
                    {getStatusText(selectedIndent.status)}
                  </Text>
                </View>
              </View>

              {/* Information Card */}
              <View style={styles.infoCard}>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Raised By</Text>
                  <Text style={styles.infoValue}>{selectedIndent.raised_by_name || '-'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Warehouse</Text>
                  <Text style={styles.infoValue}>{selectedIndent.warehouse_name || '-'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Project</Text>
                  <Text style={styles.infoValue}>{selectedIndent.project_name || '-'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Vehicle Code</Text>
                  <Text style={styles.infoValue}>{selectedIndent.vehicle_code || '-'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Vehicle Number</Text>
                  <Text style={styles.infoValue}>{selectedIndent.vehicle_number || '-'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Required Date</Text>
                  <Text style={styles.infoValue}>
                    {selectedIndent.required_date ? new Date(selectedIndent.required_date).toLocaleDateString() : '-'}
                  </Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Remarks</Text>
                  <Text style={styles.infoValue}>{selectedIndent.remarks || '-'}</Text>
                </View>
              </View>

              {/* Items List */}
              <Text style={styles.sectionHeading}>Items Requested</Text>
              {(selectedIndent.items || []).map((item: any, idx: number) => (
                <View key={item.id || idx} style={styles.itemRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName}>
                      {item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.name}` : '-')}
                    </Text>
                    <Text style={styles.itemMeta}>UOM: {item.uom || '-'}</Text>
                    {item.remarks ? <Text style={styles.itemRemarks}>Remarks: {item.remarks}</Text> : null}
                  </View>
                  <View style={styles.itemQtyContainer}>
                    <Text style={styles.qtyLabel}>Req: {item.requested_qty}</Text>
                    {selectedIndent.status === 'pending_approval' && selectedIndent.can_approve_now ? (
                      <View style={{ marginTop: 4 }}>
                        <Text style={styles.qtyLabel}>Approve Qty:</Text>
                        <TextInput
                          style={styles.qtyInput}
                          keyboardType="numeric"
                          value={approveOverrides[item.id] || ''}
                          onChangeText={(text) => {
                            setApproveOverrides((prev: any) => ({ ...prev, [item.id]: text }));
                          }}
                        />
                      </View>
                    ) : (
                      <Text style={styles.qtyLabel}>
                        Appr: {item.approved_qty != null ? item.approved_qty : '-'}
                      </Text>
                    )}
                  </View>
                </View>
              ))}

              {/* Approval History */}
              {selectedIndent.approval_history && selectedIndent.approval_history.length > 0 && (
                <View style={{ marginTop: 16 }}>
                  <Text style={styles.sectionHeading}>Approval History</Text>
                  {selectedIndent.approval_history.map((step: any, idx: number) => (
                    <View key={step.id || idx} style={styles.historyRow}>
                      <Icon name="clock" size={14} color="#94A3B8" />
                      <View style={{ marginLeft: 8, flex: 1 }}>
                        <Text style={styles.historyAction}>
                          {step.user_name} - {step.action?.toUpperCase()}
                        </Text>
                        <Text style={styles.historyMeta}>
                          Level {step.level} • {step.timestamp ? new Date(step.timestamp).toLocaleString() : ''}
                        </Text>
                        {step.remarks ? <Text style={styles.historyRemarks}>"{step.remarks}"</Text> : null}
                      </View>
                    </View>
                  ))}
                </View>
              )}

              {/* Action Buttons */}
              <View style={styles.actionButtonsContainer}>
                {selectedIndent.status === 'draft' && (
                  <>
                    <TouchableOpacity
                      style={[styles.actionBtn, styles.btnPrimary]}
                      onPress={() => handleSubmitForApproval(selectedIndent.id)}
                    >
                      <Text style={styles.actionBtnText}>Submit for Approval</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.actionBtn, styles.btnSecondary]}
                      onPress={() => openEditForm(selectedIndent)}
                    >
                      <Text style={styles.actionBtnTextDark}>Edit Draft</Text>
                    </TouchableOpacity>
                  </>
                )}

                {selectedIndent.status === 'pending_approval' && selectedIndent.can_approve_now && (
                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    <TouchableOpacity
                      style={[styles.actionBtn, styles.btnSuccess, { flex: 1 }]}
                      onPress={handleApprove}
                    >
                      <Text style={styles.actionBtnText}>Approve</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.actionBtn, styles.btnDanger, { flex: 1 }]}
                      onPress={handleReject}
                    >
                      <Text style={styles.actionBtnText}>Reject</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>

      {/* ─── Create/Edit Form Modal ─── */}
      <Modal
        visible={formModalVisible}
        animationType="slide"
        onRequestClose={() => setFormModalVisible(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ flex: 1 }}
          >
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <TouchableOpacity onPress={() => setFormModalVisible(false)}>
                <Icon name="x" size={20} color="#334155" />
              </TouchableOpacity>
              <Text style={styles.modalTitle}>
                {formIsNew ? 'New Indent' : 'Edit Indent'}
              </Text>
              <View style={{ width: 20 }} />
            </View>

            {formLoading ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#4A1060" />
                <Text style={styles.loadingText}>Saving Indent...</Text>
              </View>
            ) : (
              <ScrollView contentContainerStyle={styles.modalScroll}>
                {/* Warehouse Dropdown */}
                <DropdownSelect
                  label="Warehouse"
                  value={selectedWarehouse}
                  onValueChange={setSelectedWarehouse}
                  items={warehouseItems}
                  placeholder="Select Destination Warehouse"
                />

                {/* Project Dropdown */}
                <DropdownSelect
                  label="Project *"
                  value={selectedProject}
                  onValueChange={setSelectedProject}
                  items={projectItems}
                  placeholder="Select Associated Project"
                />

                {/* Vehicle Code Dropdown */}
                <DropdownSelect
                  label="Vehicle Code *"
                  value={selectedVehicleCode}
                  onValueChange={handleVehicleCodeChange}
                  items={vehicleItems}
                  placeholder="Search & Select Vehicle Code"
                  searchable
                />

                {/* Vehicle Number Input */}
                <Text style={styles.fieldLabel}>Vehicle Number</Text>
                <TextInput
                  style={styles.formInput}
                  placeholder="Vehicle Registration Number"
                  value={vehicleNumber}
                  onChangeText={setVehicleNumber}
                />

                {/* Required Date */}
                <Text style={styles.fieldLabel}>Required Date (YYYY-MM-DD) *</Text>
                <TextInput
                  style={styles.formInput}
                  placeholder="YYYY-MM-DD"
                  value={requiredDate}
                  onChangeText={setRequiredDate}
                />

                {/* Urgent Switch */}
                <View style={styles.switchRow}>
                  <Text style={styles.fieldLabel}>Urgent Indent</Text>
                  <Switch value={isUrgent} onValueChange={setIsUrgent} />
                </View>

                {/* Remarks */}
                <Text style={styles.fieldLabel}>Remarks</Text>
                <TextInput
                  style={[styles.formInput, { height: 60 }]}
                  placeholder="Additional instructions..."
                  multiline
                  value={remarks}
                  onChangeText={setRemarks}
                />

                {/* Form Items list */}
                <View style={styles.formItemsHeader}>
                  <Text style={styles.sectionHeading}>Items</Text>
                  <TouchableOpacity style={styles.addBtn} onPress={addFormItemRow}>
                    <Icon name="plus" size={14} color="#7C3AED" />
                    <Text style={styles.addBtnText}>Add Item</Text>
                  </TouchableOpacity>
                </View>

                {formItems.map((item, index) => (
                  <View key={item.key} style={[styles.formItemCard, activeItemIndex === index && { zIndex: 10, elevation: 10 }]}>
                    <View style={styles.formItemRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.fieldLabel}>Item Search *</Text>
                        <View style={{ position: 'relative', zIndex: 999 }}>
                          <TextInput
                            style={styles.formInput}
                            placeholder="Type item name..."
                            value={item.item_id ? item.item_name : itemSearchText && activeItemIndex === index ? itemSearchText : ''}
                            onChangeText={(text) => {
                              if (item.item_id) {
                                // Reset item if editing text
                                const updated = [...formItems];
                                updated[index] = { ...updated[index], item_id: '', item_name: '' };
                                setFormItems(updated);
                              }
                              handleItemSearch(text, index);
                            }}
                          />

                          {/* Search results dropdown overlay */}
                          {activeItemIndex === index && itemSearchResults.length > 0 && (
                            <View style={styles.searchResultsDropdown}>
                              {itemSearchLoading ? (
                                <ActivityIndicator style={{ padding: 8 }} />
                              ) : (
                                itemSearchResults.map((res) => (
                                  <TouchableOpacity
                                    key={res.id}
                                    style={styles.searchResultRow}
                                    onPress={() => handleSelectItem(res, index)}
                                  >
                                    <Text style={styles.searchResultText}>
                                      [{res.item_code || res.code}] {res.name || res.item_name}
                                    </Text>
                                  </TouchableOpacity>
                                ))
                              )}
                            </View>
                          )}
                        </View>
                      </View>
                    </View>

                    <View style={[styles.formItemRow, { gap: 12, marginTop: 8 }]}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.fieldLabel}>Quantity *</Text>
                        <TextInput
                          style={styles.formInput}
                          keyboardType="numeric"
                          value={item.requested_qty}
                          onChangeText={(text) => updateFormItemRow(item.key, 'requested_qty', text)}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <DropdownSelect
                          label="UOM"
                          value={item.uom_id?.toString() || ''}
                          onValueChange={(val) => {
                            updateFormItemRow(item.key, 'uom_id', val);
                            const selectedUom = uoms.find((u: any) => u.id.toString() === val);
                            if (selectedUom) {
                              updateFormItemRow(item.key, 'uom_name', selectedUom.name);
                            }
                          }}
                          items={uomItems}
                          placeholder="Select UOM"
                        />
                      </View>
                      <TouchableOpacity
                        style={styles.removeItemBtn}
                        onPress={() => removeFormItemRow(item.key)}
                      >
                        <Icon name="trash" size={20} color="#EF4444" />
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}

                {/* Form Action Buttons */}
                <View style={[styles.actionButtonsContainer, { marginTop: 24 }]}>
                  <TouchableOpacity
                    style={[styles.actionBtn, styles.btnPrimary]}
                    onPress={() => handleSaveForm(true)}
                  >
                    <Text style={styles.actionBtnText}>Submit Indent</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actionBtn, styles.btnSecondary]}
                    onPress={() => handleSaveForm(false)}
                  >
                    <Text style={styles.actionBtnTextDark}>Save as Draft</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            )}
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  header: {
    paddingTop: Platform.OS === 'ios' ? 12 : 24,
    paddingBottom: 16,
    paddingHorizontal: 16,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  headerButton: {
    padding: 8,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    paddingHorizontal: 12,
    height: 40,
  },
  searchInput: {
    flex: 1,
    marginLeft: 8,
    color: '#334155',
    fontSize: 14,
  },
  tabContainer: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  tabScroll: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#F1F5F9',
  },
  tabActive: {
    backgroundColor: '#4A1060',
  },
  tabText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
  },
  tabTextActive: {
    color: '#FFFFFF',
  },
  listContent: {
    padding: 16,
    gap: 12,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1E293B',
  },
  statusTag: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    fontSize: 11,
    fontWeight: 'bold',
  },
  cardDetails: {
    gap: 6,
    marginBottom: 12,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  detailText: {
    fontSize: 13,
    color: '#475569',
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    paddingTop: 10,
  },
  cardFooterType: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748B',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  loadingText: {
    marginTop: 8,
    color: '#64748B',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 64,
  },
  emptyText: {
    marginTop: 12,
    fontSize: 16,
    color: '#64748B',
    fontWeight: '500',
  },
  emptyButton: {
    marginTop: 16,
    backgroundColor: '#4A1060',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  emptyButtonText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 14,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1E293B',
  },
  modalScroll: {
    padding: 16,
  },
  modalStatusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F8FAFC',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
  },
  statusLabel: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#64748B',
  },
  infoCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 16,
    gap: 12,
    marginBottom: 20,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  infoLabel: {
    fontSize: 13,
    color: '#64748B',
  },
  infoValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1E293B',
    textAlign: 'right',
    flex: 1,
    marginLeft: 16,
  },
  sectionHeading: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#1E293B',
    marginBottom: 10,
    marginTop: 8,
  },
  itemRow: {
    flexDirection: 'row',
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  itemName: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#1E293B',
  },
  itemMeta: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
  },
  itemRemarks: {
    fontSize: 12,
    color: '#94A3B8',
    fontStyle: 'italic',
    marginTop: 2,
  },
  itemQtyContainer: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    marginLeft: 12,
  },
  qtyLabel: {
    fontSize: 12,
    color: '#64748B',
  },
  qtyInput: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#FFFFFF',
    borderRadius: 4,
    width: 60,
    height: 30,
    textAlign: 'center',
    padding: 2,
    fontSize: 12,
    color: '#1E293B',
    marginTop: 2,
  },
  historyRow: {
    flexDirection: 'row',
    marginBottom: 12,
    paddingLeft: 4,
  },
  historyAction: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#334155',
  },
  historyMeta: {
    fontSize: 11,
    color: '#64748B',
    marginTop: 2,
  },
  historyRemarks: {
    fontSize: 12,
    color: '#475569',
    fontStyle: 'italic',
    marginTop: 4,
  },
  actionButtonsContainer: {
    gap: 12,
    marginTop: 16,
    marginBottom: 32,
  },
  actionBtn: {
    height: 48,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPrimary: {
    backgroundColor: '#4A1060',
  },
  btnSecondary: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
  },
  btnSuccess: {
    backgroundColor: '#10B981',
  },
  btnDanger: {
    backgroundColor: '#EF4444',
  },
  actionBtnText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 15,
  },
  actionBtnTextDark: {
    color: '#334155',
    fontWeight: 'bold',
    fontSize: 15,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#475569',
    marginBottom: 6,
  },
  pickerContainer: {
    marginBottom: 16,
  },
  pillBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#F8FAFC',
  },
  pillBtnActive: {
    backgroundColor: '#4A1060',
    borderColor: '#4A1060',
  },
  pillText: {
    fontSize: 12,
    color: '#475569',
    fontWeight: '600',
  },
  pillTextActive: {
    color: '#FFFFFF',
  },
  formInput: {
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 8,
    paddingHorizontal: 12,
    height: 40,
    fontSize: 14,
    color: '#1E293B',
    backgroundColor: '#FFFFFF',
    marginBottom: 16,
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  formItemsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 12,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    paddingTop: 12,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#7C3AED',
  },
  addBtnText: {
    fontSize: 12,
    color: '#7C3AED',
    fontWeight: 'bold',
  },
  formItemCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 12,
    marginBottom: 12,
  },
  formItemRow: {
    flexDirection: 'row',
  },
  removeItemBtn: {
    alignSelf: 'flex-end',
    padding: 8,
    marginBottom: 16,
  },
  searchResultsDropdown: {
    position: 'absolute',
    top: 40,
    left: 0,
    right: 0,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 8,
    zIndex: 999,
    maxHeight: 150,
  },
  searchResultRow: {
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  searchResultText: {
    fontSize: 12,
    color: '#334155',
  },
  dropdownTrigger: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 8,
    paddingHorizontal: 12,
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  dropdownTriggerText: {
    fontSize: 14,
    color: '#1E293B',
  },
  dropdownArrow: {
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderStyle: 'solid',
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 6,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#64748B',
  },
  dropdownModalBg: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  dropdownModalContent: {
    width: '100%',
    maxHeight: '60%',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  dropdownModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
    paddingBottom: 12,
    marginBottom: 8,
  },
  dropdownModalTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1E293B',
  },
  dropdownCloseBtn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  dropdownCloseBtnText: {
    color: '#7C3AED',
    fontWeight: 'bold',
    fontSize: 14,
  },
  dropdownSearchInput: {
    height: 40,
    backgroundColor: '#F1F5F9',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    fontSize: 13,
    color: '#0F172A',
  },
  dropdownItemRow: {
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  dropdownItemRowActive: {
    backgroundColor: '#F8FAFC',
  },
  dropdownItemText: {
    fontSize: 14,
    color: '#334155',
  },
  dropdownItemTextActive: {
    fontWeight: 'bold',
    color: '#4A1060',
  },
});
