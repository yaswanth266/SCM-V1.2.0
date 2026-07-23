import React, { useState, useEffect } from 'react';
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
  RefreshControl,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import { router, useLocalSearchParams } from 'expo-router';
import { API_BASE_URL } from '../constants/config';

// ─── Icons ────────────────────────────────────────────────────────────────────
const Icon = ({ name, size = 18, color = '#7A6D66' }: { name: string; size?: number; color?: string }) => {
  const s = size;
  if (name === 'arrow-left') return (
    <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: s * 0.5, height: s * 0.5, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: color, transform: [{ rotate: '45deg' }, { translateX: s * 0.05 }] }} />
      <View style={{ position: 'absolute', width: s * 0.7, height: 2, backgroundColor: color, left: s * 0.15 }} />
    </View>
  );
  if (name === 'plus') return (
    <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: s * 0.7, height: 2, backgroundColor: color }} />
      <View style={{ position: 'absolute', width: 2, height: s * 0.7, backgroundColor: color }} />
    </View>
  );
  if (name === 'chevron-right') return (
    <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: s * 0.35, height: s * 0.35, borderTopWidth: 2, borderRightWidth: 2, borderColor: color, transform: [{ rotate: '45deg' }, { translateX: -s * 0.05 }] }} />
    </View>
  );
  if (name === 'x') return (
    <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: s * 0.7, height: 2, backgroundColor: color, transform: [{ rotate: '45deg' }] }} />
      <View style={{ position: 'absolute', width: s * 0.7, height: 2, backgroundColor: color, transform: [{ rotate: '-45deg' }] }} />
    </View>
  );
  if (name === 'file-text') return (
    <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: s * 0.65, height: s * 0.8, borderRadius: 2, borderWidth: 1.8, borderColor: color, padding: 3, justifyContent: 'center', gap: 2.5 }}>
        <View style={{ width: '70%', height: 1.5, backgroundColor: color }} />
        <View style={{ width: '90%', height: 1.5, backgroundColor: color }} />
        <View style={{ width: '50%', height: 1.5, backgroundColor: color }} />
      </View>
    </View>
  );
  if (name === 'check') return (
    <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: s * 0.2, height: s * 0.38, borderBottomWidth: 2, borderRightWidth: 2, borderColor: color, transform: [{ rotate: '45deg' }, { translateY: -s * 0.04 }] }} />
    </View>
  );
  if (name === 'send') return (
    <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: s * 0.75, height: s * 0.75, borderTopWidth: 1.8, borderRightWidth: 1.8, borderColor: color, transform: [{ rotate: '45deg' }] }} />
      <View style={{ position: 'absolute', width: 2, height: s * 0.6, backgroundColor: color, transform: [{ rotate: '-45deg' }] }} />
    </View>
  );
  if (name === 'edit') return (
    <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: s * 0.55, height: s * 0.55, borderWidth: 1.8, borderColor: color, transform: [{ rotate: '45deg' }] }} />
      <View style={{ position: 'absolute', bottom: 0, left: 0, width: s * 0.3, height: 1.8, backgroundColor: color }} />
    </View>
  );
  return null;
};

// ─── Searchable Dropdown ──────────────────────────────────────────────────────
const SearchableDropdown = ({
  label, value, onValueChange, items, placeholder = 'Select...', disabled = false,
}: {
  label: string; value: string; onValueChange: (v: string) => void;
  items: { label: string; value: string; sub?: string }[];
  placeholder?: string; disabled?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = items.find(i => i.value === value);
  const filtered = items.filter(i =>
    !search || i.label.toLowerCase().includes(search.toLowerCase()) || (i.sub && i.sub.toLowerCase().includes(search.toLowerCase()))
  );
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TouchableOpacity
        style={[styles.dropdownTrigger, disabled && { backgroundColor: '#F8FAFC', opacity: 0.7 }]}
        onPress={() => { if (!disabled) { setSearch(''); setOpen(true); } }}
        disabled={disabled}
      >
        <Text style={[styles.dropdownTriggerText, !selected && { color: '#94A3B8' }]} numberOfLines={1}>
          {selected ? selected.label : placeholder}
        </Text>
        <View style={styles.dropdownArrow} />
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.dropdownModalBg} activeOpacity={1} onPress={() => setOpen(false)}>
          <TouchableOpacity style={styles.dropdownModalContent} activeOpacity={1}>
            <View style={styles.dropdownModalHeader}>
              <Text style={styles.dropdownModalTitle}>{label.replace(' *', '')}</Text>
              <TouchableOpacity onPress={() => setOpen(false)} style={styles.dropdownCloseBtn}>
                <Text style={styles.dropdownCloseBtnText}>Close</Text>
              </TouchableOpacity>
            </View>
            <View style={{ paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 }}>
              <TextInput
                style={styles.dropdownSearchInput}
                placeholder={`Search ${label.replace(' *', '').toLowerCase()}...`}
                placeholderTextColor="#94A3B8"
                value={search}
                onChangeText={setSearch}
                autoCapitalize="none"
              />
            </View>
            <FlatList
              data={filtered}
              keyExtractor={(item, idx) => item.value || String(idx)}
              style={{ maxHeight: 300 }}
              ListEmptyComponent={<View style={{ padding: 20, alignItems: 'center' }}><Text style={{ color: '#94A3B8', fontSize: 13 }}>No matches found</Text></View>}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.dropdownItemRow, item.value === value && styles.dropdownItemRowActive]}
                  onPress={() => { onValueChange(item.value); setOpen(false); }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.dropdownItemText, item.value === value && styles.dropdownItemTextActive]}>{item.label}</Text>
                    {item.sub ? <Text style={{ fontSize: 11, color: '#64748B', marginTop: 1 }}>{item.sub}</Text> : null}
                  </View>
                  {item.value === value && <Icon name="check" size={14} color="#481238" />}
                </TouchableOpacity>
              )}
            />
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
};

// ─── Status Badge ─────────────────────────────────────────────────────────────
const StatusBadge = ({ status }: { status: string }) => {
  const map: Record<string, { bg: string; text: string; label: string }> = {
    pending_approval:   { bg: '#FEF3C7', text: '#D97706', label: 'Pending Approval' },
    approved:           { bg: '#DCFCE7', text: '#16A34A', label: 'Approved' },
    fulfilled:          { bg: '#D1FAE5', text: '#059669', label: 'Fulfilled' },
  };
  const s = map[status] || { bg: '#F1F5F9', text: '#475569', label: status };
  return (
    <View style={{ backgroundColor: s.bg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
      <Text style={{ fontSize: 11, fontWeight: '800', color: s.text }}>{s.label.toUpperCase()}</Text>
    </View>
  );
};

const formatDateTime = (dateStr: string | null | undefined): string => {
  if (!dateStr) return '-';
  try {
    let normalized = dateStr;
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      const [year, month, day] = normalized.split('-');
      return `${day}/${month}/${year} 00:00:00`;
    }
    if (!normalized.endsWith('Z') && !normalized.includes('+') && !normalized.includes('-')) {
      if (normalized.includes('T')) {
        normalized = normalized + 'Z';
      } else if (normalized.includes(' ')) {
        normalized = normalized.replace(' ', 'T') + 'Z';
      }
    }
    const d = new Date(normalized);
    if (isNaN(d.getTime())) return '-';
    const options: Intl.DateTimeFormatOptions = {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    };
    return new Intl.DateTimeFormat('en-IN', options).format(d).replace(',', '');
  } catch (e) {
    return dateStr || '-';
  }
};

// ─── Status Flow Steps ────────────────────────────────────────────────────────
const STATUS_FLOW = ['pending_approval', 'approved', 'fulfilled'];
const StatusFlow = ({ currentStatus }: { currentStatus: string }) => {
  const currentIdx = STATUS_FLOW.indexOf(currentStatus);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingVertical: 8 }}>
        {STATUS_FLOW.map((s, idx) => {
          const isCurrent = s === currentStatus;
          const isPast = idx < currentIdx;
          const label = s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
          return (
            <View key={s} style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{
                paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20,
                backgroundColor: isCurrent ? '#481238' : isPast ? '#DCFCE7' : '#F1F5F9',
              }}>
                <Text style={{
                  fontSize: 11, fontWeight: isCurrent ? '800' : '600',
                  color: isCurrent ? '#FFFFFF' : isPast ? '#16A34A' : '#94A3B8',
                }}>{label}</Text>
              </View>
              {idx < STATUS_FLOW.length - 1 && (
                <View style={{ width: 20, height: 1.5, backgroundColor: '#E2E8F0', marginHorizontal: 2 }} />
              )}
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
};

// ─── Custom Pagination Footer ──────────────────────────────────────────────────
const PaginationFooter = ({
  page,
  pageSize,
  total,
  onPageChange,
  loading = false,
  themeColor = '#7C3AED',
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (newPage: number) => void;
  loading?: boolean;
  themeColor?: string;
}) => {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const startItem = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, total);

  if (total <= 0) return null;

  return (
    <View style={paginationStyles.container}>
      <Text style={paginationStyles.infoText}>
        Showing <Text style={{ fontWeight: '700', color: '#1E293B' }}>{startItem}-{endItem}</Text> of <Text style={{ fontWeight: '700', color: '#1E293B' }}>{total}</Text> items
      </Text>
      <View style={paginationStyles.controlsRow}>
        <TouchableOpacity
          style={[paginationStyles.pageBtn, { backgroundColor: themeColor }, (page <= 1 || loading) && paginationStyles.pageBtnDisabled]}
          disabled={page <= 1 || loading}
          onPress={() => onPageChange(page - 1)}
        >
          <Text style={[paginationStyles.pageBtnText, (page <= 1 || loading) && paginationStyles.pageBtnTextDisabled]}>‹ Prev</Text>
        </TouchableOpacity>

        <View style={paginationStyles.pageBadge}>
          <Text style={paginationStyles.pageBadgeText}>Page {page} of {totalPages}</Text>
        </View>

        <TouchableOpacity
          style={[paginationStyles.pageBtn, { backgroundColor: themeColor }, (page >= totalPages || loading) && paginationStyles.pageBtnDisabled]}
          disabled={page >= totalPages || loading}
          onPress={() => onPageChange(page + 1)}
        >
          <Text style={[paginationStyles.pageBtnText, (page >= totalPages || loading) && paginationStyles.pageBtnTextDisabled]}>Next ›</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const paginationStyles = StyleSheet.create({
  container: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    marginTop: 12,
    marginBottom: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  infoText: {
    fontSize: 12,
    color: '#64748B',
    marginBottom: 10,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  pageBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#7C3AED',
  },
  pageBtnDisabled: {
    backgroundColor: '#E2E8F0',
  },
  pageBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  pageBtnTextDisabled: {
    color: '#94A3B8',
  },
  pageBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#F1F5F9',
    borderRadius: 6,
  },
  pageBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#334155',
  },
});

// ─── Main Component ───────────────────────────────────────────────────────────
export default function TemplateIndentsScreen() {
  const typeTitle = 'Template Indent';
  const themeColor = '#7C3AED';
  const themeBg: [string, string] = ['#481238', '#3A0F40'];

  const [token, setToken] = useState('');
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [indents, setIndents] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // Detail modal
  const [selectedIndent, setSelectedIndent] = useState<any>(null);
  const [detailVisible, setDetailVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  // Form modal
  const [formVisible, setFormVisible] = useState(false);
  const [formMode, setFormMode] = useState<'new' | 'edit'>('new');
  const [formIndentId, setFormIndentId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Lookup data
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  
  // Available templates for selected project
  const [availableTemplates, setAvailableTemplates] = useState<any[]>([]);
  const [selTemplateId, setSelTemplateId] = useState('');
  const [templateItems, setTemplateItems] = useState<any[]>([]);
  const [loadingTemplate, setLoadingTemplate] = useState(false);

  // Form fields
  const [selProjectId, setSelProjectId] = useState('');
  const [selWarehouseId, setSelWarehouseId] = useState('');
  const [selVehicleCode, setSelVehicleCode] = useState('');
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [indentDate, setIndentDate] = useState('');
  const [requiredDate, setRequiredDate] = useState('');
  const [remarks, setRemarks] = useState('');

  // ─── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      try {
        const tok = await AsyncStorage.getItem('user_token');
        const usr = await AsyncStorage.getItem('user_profile');
        if (!tok || !usr) { router.replace('/'); return; }
        setToken(tok);
        const parsedUser = JSON.parse(usr);
        setUser(parsedUser);
        fetchList(tok, 1, '', '');
        fetchLookups(tok, parsedUser);
      } catch { router.replace('/'); }
    };
    init();
  }, []);

  const fetchList = async (tok: string, pageNum: number, searchQ: string, statusQ: string) => {
    try {
      if (pageNum === 1) setLoading(true); else setLoadingMore(true);
      const params: any = { page: pageNum, page_size: 20, template_type: 'dp_project' };
      if (searchQ) params.search = searchQ;
      if (statusQ) params.status = statusQ;
      const res = await axios.get(`${API_BASE_URL}/api/v1/indent/indents`, {
        headers: { Authorization: `Bearer ${tok}` }, params,
      });
      const data = res.data;
      const items = data.items || data.data || [];
      setIndents(items);
      setTotal(data.total ?? data.total_items ?? data.count ?? items.length);
      setPage(pageNum);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  };

  const loadMore = () => {
    if (indents.length < total && !loading && !loadingMore && !refreshing) {
      fetchList(token, page + 1, search, filterStatus);
    }
  };

  const fetchLookups = async (tok: string, parsedUser: any) => {
    try {
      const [whRes, projRes, vehRes] = await Promise.allSettled([
        axios.get(`${API_BASE_URL}/api/v1/masters/warehouses`, { headers: { Authorization: `Bearer ${tok}` }, params: { page_size: 200 } }),
        axios.get(`${API_BASE_URL}/api/v1/masters/projects`, { headers: { Authorization: `Bearer ${tok}` }, params: { page_size: 200 } }),
        axios.get(`${API_BASE_URL}/api/v1/masters/vehicles`, { headers: { Authorization: `Bearer ${tok}` }, params: { is_active: true } }),
      ]);
      if (whRes.status === 'fulfilled') {
        const d = whRes.value.data;
        const list = (d.items || d.data || d || []);
        setWarehouses(list);
        if (parsedUser?.warehouse_id) setSelWarehouseId(String(parsedUser.warehouse_id));
        else if (list.length === 1) setSelWarehouseId(String(list[0].id));
      }
      if (projRes.status === 'fulfilled') {
        const d = projRes.value.data;
        setProjects(d.items || d.data || d || []);
      }
      if (vehRes.status === 'fulfilled') {
        const d = vehRes.value.data;
        setVehicles(d.items || d.data || d || []);
      }
    } catch { /* silent */ }
  };

  const fetchTemplatesForProject = async (projectId: string) => {
    if (!projectId) {
      setAvailableTemplates([]);
      setSelTemplateId('');
      setTemplateItems([]);
      return;
    }
    setLoadingTemplate(true);
    try {
      const res = await axios.get(`${API_BASE_URL}/api/v1/masters/project-indent-templates/by-project/${projectId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = res.data || [];
      setAvailableTemplates(data);
      if (data.length === 0) {
        setSelTemplateId('');
        setTemplateItems([]);
        Alert.alert('⚠️ No Templates', 'No indent templates configured for this project.');
      } else if (data.length === 1) {
        setSelTemplateId(String(data[0].id));
        handleTemplateSelect(String(data[0].id), data);
      }
    } catch (e: any) {
      setAvailableTemplates([]);
      setTemplateItems([]);
      Alert.alert('Error', e?.response?.data?.detail || 'Failed to load templates for project.');
    } finally {
      setLoadingTemplate(false);
    }
  };

  const handleTemplateSelect = (templateIdStr: string, list = availableTemplates) => {
    setSelTemplateId(templateIdStr);
    const matched = list.find((t: any) => String(t.id) === templateIdStr);
    if (matched && matched.items) {
      setTemplateItems(matched.items.map((item: any, idx: number) => ({
        key: item.id || idx,
        item_id: item.item_id,
        item_code: item.item_code || '',
        item_name: item.item_name || '',
        requested_qty: Number(item.quantity || 0),
        uom: item.uom_name || '',
        uom_id: item.uom_id,
        remarks: 'Fixed template item',
      })));
    } else {
      setTemplateItems([]);
    }
  };

  const checkDuplicateIndent = async (vehicleCode: string, alertIfFound = true): Promise<string | null> => {
    if (!vehicleCode || formMode !== 'new') return null;
    try {
      const res = await axios.get(`${API_BASE_URL}/api/v1/indent/indents`, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          template_type: 'dp_project',
          vehicle_code: vehicleCode,
          page_size: 20,
        },
      });
      const items = res.data?.items || res.data?.data || res.data || [];
      const activeDuplicate = items.find((i: any) =>
        String(i.vehicle_code) === String(vehicleCode) &&
        !['cancelled', 'rejected'].includes(i.status)
      );
      if (activeDuplicate) {
        if (alertIfFound) {
          Alert.alert(
            'Error',
            `An indent (${activeDuplicate.indent_number}) is already raised against vehicle ${vehicleCode}. Please select another vehicle.`
          );
        }
        return activeDuplicate.indent_number || 'Existing Indent';
      }
    } catch { /* silent */ }
    return null;
  };

  const openNewForm = () => {
    setFormMode('new');
    setFormIndentId(null);
    
    // Autofetch project ID from user profile or first available project
    const defaultProjId = user?.project_id ? String(user.project_id) : (projects.length > 0 ? String(projects[0].id) : '');
    setSelProjectId(defaultProjId);
    if (defaultProjId) {
      fetchTemplatesForProject(defaultProjId);
    } else {
      setAvailableTemplates([]);
    }
    
    setSelTemplateId('');
    setSelVehicleCode('');
    setVehicleNumber('');
    setRemarks('');
    setTemplateItems([]);
    // Auto-fill current date-time as DD/MM/YYYY HH:mm:ss
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateTimeStr = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    setIndentDate(dateTimeStr);
    const d = new Date(); d.setDate(d.getDate() + 7);
    setRequiredDate(d.toISOString().split('T')[0]);
    setFormVisible(true);
  };

  const openEditForm = (indent: any) => {
    setFormMode('edit');
    setFormIndentId(indent.id);
    setSelProjectId(String(indent.project_id || ''));
    if (indent.project_id) fetchTemplatesForProject(String(indent.project_id));
    setSelTemplateId(String(indent.template_id || ''));
    setSelWarehouseId(String(indent.warehouse_id || ''));
    setSelVehicleCode(indent.vehicle_code || '');
    setVehicleNumber(indent.vehicle_number || '');
    setRemarks(indent.remarks || '');
    setRequiredDate(indent.required_date ? indent.required_date.split('T')[0] : '');
    setIndentDate(indent.indent_date ? formatDateTime(indent.indent_date) : '');
    const items = (indent.items || []).map((it: any, idx: number) => ({
      key: it.id || idx,
      item_id: it.item_id,
      item_code: it.item_code || '',
      item_name: it.item_name || '',
      requested_qty: Number(it.requested_qty || it.qty || 0),
      uom: it.uom || it.unit || '',
      uom_id: it.uom_id,
      remarks: it.remarks || '',
    }));
    setTemplateItems(items);
    setDetailVisible(false);
    setFormVisible(true);
  };

  const openDetail = async (id: number) => {
    setDetailLoading(true);
    setDetailVisible(true);
    setSelectedIndent(null);
    try {
      const res = await axios.get(`${API_BASE_URL}/api/v1/indent/indents/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setSelectedIndent(res.data);
      const items = (res.data.items || []).map((it: any, idx: number) => ({
        key: it.id || idx, item_id: it.item_id, item_code: it.item_code || '',
        item_name: it.item_name || '', requested_qty: Number(it.requested_qty || it.qty || 0),
        uom: it.uom || it.unit || '', uom_id: it.uom_id, remarks: it.remarks || '',
      }));
      setTemplateItems(items);
    } catch { Alert.alert('Error', 'Could not load indent details.'); setDetailVisible(false); }
    finally { setDetailLoading(false); }
  };

  const handleAction = async (id: number, action: string) => {
    const labels: Record<string, string> = { submit: 'submitted for approval', reject: 'rejected', cancel: 'cancelled', approve: 'approved' };
    try {
      await axios.post(`${API_BASE_URL}/api/v1/indent/indents/${id}/${action}`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      Alert.alert('Success', `Indent ${labels[action] || action} successfully!`);
      setDetailVisible(false);
      fetchList(token, 1, search, filterStatus);
    } catch (e: any) {
      Alert.alert('Error', e?.response?.data?.detail || `Failed to ${action} indent.`);
    }
  };

  const handleSubmitForm = async () => {
    if (!selProjectId) { Alert.alert('Validation', 'Please select a project.'); return; }
    if (!selTemplateId) { Alert.alert('Validation', 'Please select a template name.'); return; }
    if (!selWarehouseId) { Alert.alert('Validation', 'Please select a warehouse.'); return; }
    if (!requiredDate || !/^\d{4}-\d{2}-\d{2}$/.test(requiredDate)) {
      Alert.alert('Validation', 'Please enter Required Date in YYYY-MM-DD format.'); return;
    }
    if (templateItems.length === 0) { Alert.alert('Validation', 'No template items found for selected template.'); return; }

    const matchedTmpl = availableTemplates.find((t: any) => String(t.id) === selTemplateId);

    // Parse DD/MM/YYYY HH:mm:ss back to ISO string
    let parsedIndentDate = new Date().toISOString();
    if (indentDate) {
      const parts = indentDate.split(' ');
      if (parts.length === 2) {
        const dateParts = parts[0].split('/');
        const timeParts = parts[1].split(':');
        if (dateParts.length === 3 && timeParts.length === 3) {
          const day = parseInt(dateParts[0], 10);
          const month = parseInt(dateParts[1], 10) - 1;
          const year = parseInt(dateParts[2], 10);
          const hour = parseInt(timeParts[0], 10);
          const min = parseInt(timeParts[1], 10);
          const sec = parseInt(timeParts[2], 10);
          const d = new Date(year, month, day, hour, min, sec);
          if (!isNaN(d.getTime())) {
            parsedIndentDate = d.toISOString();
          }
        }
      }
    }

    if (formMode === 'new' && selVehicleCode) {
      const dupIndentNum = await checkDuplicateIndent(selVehicleCode, true);
      if (dupIndentNum) return;
    }

    setSubmitting(true);
    try {
      const payload = {
        warehouse_id: parseInt(selWarehouseId),
        indent_type: 'regular',
        template_type: 'dp_project',
        template_id: parseInt(selTemplateId),
        template_name: matchedTmpl ? matchedTmpl.template_name : undefined,
        indent_date: parsedIndentDate,
        required_date: requiredDate,
        project_id: parseInt(selProjectId),
        vehicle_code: selVehicleCode || null,
        vehicle_number: vehicleNumber || null,
        remarks: remarks || '',
        items: templateItems.map(it => ({
          item_id: it.item_id,
          requested_qty: it.requested_qty,
          uom_id: it.uom_id || null,
          remarks: it.remarks || '',
        })),
      };

      let targetId = formIndentId;
      if (formMode === 'new') {
        const res = await axios.post(`${API_BASE_URL}/api/v1/indent/indents`, payload, {
          headers: { Authorization: `Bearer ${token}` },
        });
        targetId = res.data.id || res.data.data?.id;
      } else {
        await axios.put(`${API_BASE_URL}/api/v1/indent/indents/${formIndentId}`, payload, {
          headers: { Authorization: `Bearer ${token}` },
        });
      }

      if (targetId) {
        await axios.post(`${API_BASE_URL}/api/v1/indent/indents/${targetId}/submit`, {}, {
          headers: { Authorization: `Bearer ${token}` },
        });
        Alert.alert('Success', formMode === 'new' ? 'Indent created and submitted for approval!' : 'Indent updated and submitted!');
      }

      setFormVisible(false);
      fetchList(token, 1, search, filterStatus);
      if (targetId) openDetail(targetId);
    } catch (e: any) {
      const resData = e?.response?.data;
      let msg = 'Failed to save indent.';
      if (typeof resData?.detail === 'string') {
        msg = resData.detail;
      } else if (typeof resData?.message === 'string') {
        msg = resData.message;
      } else if (Array.isArray(resData?.detail)) {
        msg = resData.detail.map((d: any) => (typeof d === 'string' ? d : d.msg || d.detail || JSON.stringify(d))).join('\n');
      } else if (typeof resData === 'string') {
        msg = resData;
      } else if (e?.message) {
        msg = e.message;
      }
      Alert.alert('Error', msg);
    } finally {
      setSubmitting(false);
    }
  };

  const formatDate = (d?: string) => {
    if (!d) return '-';
    try { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
    catch { return d; }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    fetchList(token, 1, search, filterStatus);
  };

  const STATUS_OPTIONS = ['', 'pending_approval', 'approved', 'fulfilled'];
  const STATUS_LABELS: Record<string, string> = {
    '': 'All', pending_approval: 'Pending Approval', approved: 'Approved', fulfilled: 'Fulfilled',
  };

  // ─── RENDER ───────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <LinearGradient colors={themeBg} style={styles.header} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}>
        <View style={styles.headerTop}>
          <TouchableOpacity style={styles.headerBtn} onPress={() => router.replace('/dashboard')}>
            <Icon name="arrow-left" size={20} color="#FFF" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle} numberOfLines={1}>{typeTitle}</Text>
            <Text style={styles.headerSub}>Template-based fixed indents</Text>
          </View>
          <TouchableOpacity style={styles.headerBtn} onPress={openNewForm}>
            <Icon name="plus" size={20} color="#FFF" />
          </TouchableOpacity>
        </View>
      </LinearGradient>

      {/* Search + Filter Bar */}
      <View style={styles.filterBar}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search by indent number..."
          placeholderTextColor="#94A3B8"
          value={search}
          onChangeText={(v) => {
            setSearch(v);
            fetchList(token, 1, v, filterStatus);
          }}
        />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {STATUS_OPTIONS.map(st => (
              <TouchableOpacity
                key={st}
                style={[styles.filterChip, filterStatus === st && styles.filterChipActive]}
                onPress={() => { setFilterStatus(st); fetchList(token, 1, search, st); }}
              >
                <Text style={[styles.filterChipText, filterStatus === st && styles.filterChipTextActive]}>
                  {STATUS_LABELS[st]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      </View>

      {/* List */}
      {loading && page === 1 ? (
        <View style={styles.centeredBox}>
          <ActivityIndicator size="large" color={themeColor} />
          <Text style={styles.loadingText}>Loading template indents...</Text>
        </View>
      ) : indents.length === 0 ? (
        <ScrollView contentContainerStyle={styles.centeredBox} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}>
          <Icon name="file-text" size={48} color="#CBD5E1" />
          <Text style={styles.emptyText}>No template indents found</Text>
          <TouchableOpacity style={[styles.createBtn, { backgroundColor: themeColor }]} onPress={openNewForm}>
            <Text style={styles.createBtnText}>Create Template Indent</Text>
          </TouchableOpacity>
        </ScrollView>
      ) : (
        <FlatList
          data={indents}
          keyExtractor={(item) => item.id.toString()}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          ListFooterComponent={
            <PaginationFooter
              page={page}
              pageSize={20}
              total={total}
              loading={loading || loadingMore}
              themeColor={themeColor}
              onPageChange={(p) => fetchList(token, p, search, filterStatus)}
            />
          }
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.card} activeOpacity={0.7} onPress={() => openDetail(item.id)}>
              <View style={styles.cardHeader}>
                <View style={[styles.cardIconBox, { backgroundColor: '#F0E8F8' }]}>
                  <Icon name="file-text" size={16} color={themeColor} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{item.indent_number || `Indent #${item.id}`}</Text>
                  <Text style={styles.cardSub}>{item.project_name || '-'}</Text>
                </View>
                <StatusBadge status={item.status} />
              </View>
              <View style={styles.cardBody}>
                <View style={styles.cardRow}>
                  <Text style={styles.cardLabel}>Template Name</Text>
                  <Text style={[styles.cardValue, { color: '#7C3AED', fontWeight: '800' }]}>{item.template_name || '-'}</Text>
                </View>
                <View style={styles.cardRow}>
                  <Text style={styles.cardLabel}>Warehouse</Text>
                  <Text style={styles.cardValue}>{item.warehouse_name || '-'}</Text>
                </View>
                <View style={styles.cardRow}>
                  <Text style={styles.cardLabel}>Vehicle Code</Text>
                  <Text style={styles.cardValue}>{item.vehicle_code || '-'}</Text>
                </View>
                <View style={styles.cardRow}>
                  <Text style={styles.cardLabel}>Vehicle Number</Text>
                  <Text style={styles.cardValue}>{item.vehicle_number || '-'}</Text>
                </View>
                <View style={styles.cardRow}>
                  <Text style={styles.cardLabel}>Required</Text>
                  <Text style={styles.cardValue}>{formatDate(item.required_date)}</Text>
                </View>
                <View style={styles.cardRow}>
                  <Text style={styles.cardLabel}>Raised By</Text>
                  <Text style={styles.cardValue}>{item.raised_by_name || '-'}</Text>
                </View>
              </View>
              <View style={styles.cardFooter}>
                <Text style={styles.cardDate}>{formatDate(item.indent_date)}</Text>
                <Icon name="chevron-right" size={16} color="#94A3B8" />
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      {/* ─── DETAIL MODAL ─────────────────────────────────────────────────── */}
      <Modal visible={detailVisible} animationType="slide" onRequestClose={() => setDetailVisible(false)}>
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setDetailVisible(false)}>
              <Icon name="arrow-left" size={20} color="#334155" />
            </TouchableOpacity>
            <Text style={styles.modalTitle} numberOfLines={1}>
              {selectedIndent?.indent_number || 'Indent Detail'}
            </Text>
            <View style={{ width: 24 }} />
          </View>

          {detailLoading || !selectedIndent ? (
            <View style={styles.centeredBox}><ActivityIndicator size="large" color={themeColor} /></View>
          ) : (
            <ScrollView contentContainerStyle={styles.modalScroll}>
              <View style={styles.section}>
                <StatusFlow currentStatus={selectedIndent.status} />
              </View>

              <View style={styles.infoCard}>
                <InfoRow label="Indent #" value={selectedIndent.indent_number || '-'} />
                <InfoRow label="Date & Time" value={formatDateTime(selectedIndent.indent_date || selectedIndent.created_at)} />
                <InfoRow label="Emp Code" value={selectedIndent.raised_by_emp_code || selectedIndent.employee_code || user?.employee_code || '-'} />
                <InfoRow label="Emp Name" value={selectedIndent.raised_by_name || selectedIndent.created_by_name || user?.full_name || '-'} />
                <InfoRow label="Position" value={selectedIndent.position_name || selectedIndent.raising_position || user?.position || '-'} />
                <InfoRow label="Project" value={selectedIndent.project_name || '-'} />
                <InfoRow label="Template Name" value={selectedIndent.template_name || '-'} />
                <InfoRow label="Warehouse" value={selectedIndent.warehouse_name || '-'} />
                <InfoRow label="Vehicle Code" value={selectedIndent.vehicle_code || '-'} />
                <InfoRow label="Vehicle Number" value={selectedIndent.vehicle_number || '-'} />
                <InfoRow label="Required Date" value={formatDate(selectedIndent.required_date)} />
                {selectedIndent.remarks ? <InfoRow label="Remarks" value={selectedIndent.remarks} /> : null}
              </View>

              <View style={[styles.section, { marginTop: 4 }]}>
                <Text style={styles.sectionTitle}>📦 Fixed Items List</Text>
                {(selectedIndent.items || []).length === 0 ? (
                  <Text style={{ color: '#94A3B8', fontSize: 13, textAlign: 'center', padding: 16 }}>No items</Text>
                ) : (
                  (selectedIndent.items || []).map((it: any, idx: number) => (
                    <View key={it.id || idx} style={styles.itemRow}>
                      <View style={styles.itemNum}><Text style={styles.itemNumText}>{idx + 1}</Text></View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.itemName}>{it.item_name || it.item_code || '-'}</Text>
                        <Text style={styles.itemMeta}>Code: {it.item_code || '-'} · UOM: {it.uom || it.unit || '-'}</Text>
                      </View>
                      <View style={styles.itemQty}>
                        <Text style={styles.itemQtyNum}>{it.requested_qty || it.qty || 0}</Text>
                        <Text style={styles.itemQtyUnit}>{it.uom || ''}</Text>
                      </View>
                    </View>
                  ))
                )}
              </View>

              <View style={styles.actionBar}>
                {selectedIndent.status === 'pending_approval' && selectedIndent.can_approve_now === true && selectedIndent.raised_by !== user?.id && (
                  <TouchableOpacity
                    style={[styles.actionBtn, { backgroundColor: '#16A34A', flex: 1 }]}
                    onPress={() => Alert.alert('Approve?', 'Approve this indent?', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Approve', onPress: () => handleAction(selectedIndent.id, 'approve') },
                    ])}
                  >
                    <Icon name="check" size={14} color="#FFF" />
                    <Text style={[styles.actionBtnText, { color: '#FFF' }]}>Approve</Text>
                  </TouchableOpacity>
                )}
              </View>
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>

      {/* ─── FORM MODAL ───────────────────────────────────────────────────── */}
      <Modal visible={formVisible} animationType="slide" onRequestClose={() => setFormVisible(false)}>
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setFormVisible(false)}>
              <Icon name="x" size={20} color="#334155" />
            </TouchableOpacity>
            <Text style={styles.modalTitle} numberOfLines={1}>
              {formMode === 'new' ? 'New Template Indent' : 'Edit Indent'}
            </Text>
            <View style={{ width: 24 }} />
          </View>

          {submitting ? (
            <View style={styles.centeredBox}>
              <ActivityIndicator size="large" color={themeColor} />
              <Text style={styles.loadingText}>Saving indent...</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled">
              {/* Employee Info Header - Frozen */}
              <View style={[styles.infoCard, { marginBottom: 16 }]}>
                <InfoRow label="Emp Code" value={user?.employee_code || user?.emp_code || '-'} />
                <InfoRow label="Emp Name" value={user?.full_name || user?.name || user?.username || '-'} />
                <InfoRow label="Position" value={user?.position_name || user?.position || user?.designation || '-'} />
              </View>

              {/* Date & Timestamp - Editable */}
              <Text style={styles.fieldLabel}>Date & Timestamp *</Text>
              <TextInput
                style={styles.formInput}
                value={indentDate}
                onChangeText={setIndentDate}
                placeholder="DD/MM/YYYY HH:mm:ss"
                placeholderTextColor="#94A3B8"
              />

              {/* Project (Frozen) */}
              <SearchableDropdown
                label="Project *"
                value={selProjectId}
                onValueChange={(v) => { setSelProjectId(v); fetchTemplatesForProject(v); }}
                items={projects.map(p => ({ label: p.name || p.project_name || `#${p.id}`, value: String(p.id) }))}
                placeholder="Select project..."
                disabled={true}
              />

              {/* Template Name */}
              <SearchableDropdown
                label="Template Name *"
                value={selTemplateId}
                onValueChange={(v) => handleTemplateSelect(v)}
                items={availableTemplates.map(t => ({ label: t.template_name, value: String(t.id) }))}
                placeholder={availableTemplates.length > 0 ? "Select template name..." : "Select project first"}
                disabled={formMode === 'edit' || availableTemplates.length === 0}
              />

              {/* Warehouse */}
              <SearchableDropdown
                label="Source Warehouse *"
                value={selWarehouseId}
                onValueChange={setSelWarehouseId}
                items={warehouses.map(w => ({ label: w.name || w.warehouse_name || `#${w.id}`, value: String(w.id), sub: w.code ? `Code: ${w.code}` : undefined }))}
                placeholder="Select warehouse..."
              />

              {/* Vehicle Code */}
              <SearchableDropdown
                label="Vehicle Code"
                value={selVehicleCode}
                onValueChange={(v) => {
                  setSelVehicleCode(v);
                  const matched = vehicles.find((vh: any) => vh.vehicle_code === v);
                  if (matched) setVehicleNumber(matched.vehicle_number || '');
                  else setVehicleNumber('');
                  if (v) checkDuplicateIndent(v);
                }}
                items={vehicles.map((v: any) => ({
                  label: `${v.vehicle_code} (${v.vehicle_number || '-'})`,
                  value: v.vehicle_code,
                  sub: v.vehicle_type || undefined,
                }))}
                placeholder="Select vehicle code..."
              />

              {/* Vehicle Number (Frozen - Auto-filled) */}
              <Text style={styles.fieldLabel}>Vehicle Number</Text>
              <TextInput
                style={[styles.formInput, { backgroundColor: '#F1F5F9', color: '#64748B' }]}
                value={vehicleNumber}
                editable={false}
                placeholder="Auto-filled from vehicle code"
                placeholderTextColor="#94A3B8"
              />

              <Text style={styles.fieldLabel}>Required Date * (YYYY-MM-DD)</Text>
              <TextInput
                style={styles.formInput}
                value={requiredDate}
                onChangeText={setRequiredDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor="#94A3B8"
                keyboardType="numeric"
              />

              {/* Template Items Preview */}
              {loadingTemplate ? (
                <View style={{ padding: 20, alignItems: 'center' }}>
                  <ActivityIndicator color={themeColor} />
                  <Text style={{ color: '#64748B', marginTop: 8, fontSize: 13 }}>Loading template items...</Text>
                </View>
              ) : templateItems.length > 0 ? (
                <View style={[styles.section, { marginTop: 4, marginBottom: 12 }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <Text style={styles.sectionTitle}>📦 Fixed Items ({templateItems.length})</Text>
                    <View style={{ backgroundColor: '#D1FAE5', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 }}>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: '#059669' }}>Auto-configured</Text>
                    </View>
                  </View>
                  {templateItems.map((it, idx) => (
                    <View key={it.key || idx} style={styles.itemRow}>
                      <View style={styles.itemNum}><Text style={styles.itemNumText}>{idx + 1}</Text></View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.itemName}>{it.item_name || it.item_code || '-'}</Text>
                        <Text style={styles.itemMeta}>Code: {it.item_code || '-'} · {it.uom || ''}</Text>
                      </View>
                      <View style={styles.itemQty}>
                        <Text style={styles.itemQtyNum}>{it.requested_qty}</Text>
                        <Text style={styles.itemQtyUnit}>{it.uom}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              ) : selProjectId ? (
                <View style={{ backgroundColor: '#FEF3C7', borderRadius: 10, padding: 14, marginBottom: 12, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, color: '#92400E', textAlign: 'center' }}>
                    ⚠️ Select a template name above to display its fixed items.
                  </Text>
                </View>
              ) : (
                <View style={{ backgroundColor: '#F0E8F8', borderRadius: 10, padding: 14, marginBottom: 12, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, color: '#5B21B6', textAlign: 'center' }}>
                    Select a project and template name above to automatically load its fixed items.
                  </Text>
                </View>
              )}

              <Text style={styles.fieldLabel}>Remarks (optional)</Text>
              <TextInput
                style={[styles.formInput, { height: 72, textAlignVertical: 'top' }]}
                multiline
                value={remarks}
                onChangeText={setRemarks}
                placeholder="Any additional notes..."
                placeholderTextColor="#94A3B8"
              />

              <View style={{ marginTop: 8 }}>
                <TouchableOpacity
                  style={[styles.submitBtn, { backgroundColor: themeColor }]}
                  onPress={handleSubmitForm}
                  disabled={submitting}
                >
                  <Text style={styles.submitBtnText}>Submit for Approval</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Helper ───────────────────────────────────────────────────────────────────
const InfoRow = ({ label, value }: { label: string; value: string }) => (
  <View style={styles.infoRow}>
    <Text style={styles.infoLabel}>{label}</Text>
    <Text style={styles.infoValue}>{value}</Text>
  </View>
);

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container:     { flex: 1, backgroundColor: '#F6F2F0' },
  header:        { paddingTop: Platform.OS === 'ios' ? 0 : 12, paddingBottom: 14 },
  headerTop:     { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, height: 48 },
  headerBtn:     { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle:   { fontSize: 16, fontWeight: '800', color: '#FFF' },
  headerSub:     { fontSize: 11, color: 'rgba(255,255,255,0.7)' },

  filterBar:     { paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#FFF', borderBottomWidth: 1, borderBottomColor: '#E2E8F0' },
  searchInput:   { height: 40, backgroundColor: '#F1F5F9', borderRadius: 8, paddingHorizontal: 12, fontSize: 13, color: '#0F172A' },
  filterChip:    { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, backgroundColor: '#F1F5F9' },
  filterChipActive:     { backgroundColor: '#7C3AED' },
  filterChipText:       { fontSize: 11, fontWeight: '600', color: '#64748B' },
  filterChipTextActive: { color: '#FFF', fontWeight: '800' },

  centeredBox:   { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  loadingText:   { marginTop: 12, fontSize: 14, color: '#64748B' },
  emptyText:     { fontSize: 15, fontWeight: '600', color: '#64748B', marginTop: 12, marginBottom: 16 },
  createBtn:     { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  createBtnText: { color: '#FFF', fontSize: 14, fontWeight: '800' },

  card:          { backgroundColor: '#FFF', borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: '#E2E8F0' },
  cardHeader:    { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  cardIconBox:   { width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  cardTitle:     { fontSize: 14, fontWeight: '800', color: '#0F172A' },
  cardSub:       { fontSize: 11, color: '#64748B' },
  cardBody:      { gap: 4, marginBottom: 10 },
  cardRow:       { flexDirection: 'row', justifyContent: 'space-between' },
  cardLabel:     { fontSize: 12, color: '#64748B' },
  cardValue:     { fontSize: 12, fontWeight: '600', color: '#0F172A' },
  cardFooter:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8, borderTopWidth: 1, borderTopColor: '#F1F5F9' },
  cardDate:      { fontSize: 11, color: '#94A3B8' },

  modalContainer:{ flex: 1, backgroundColor: '#F8FAFC' },
  modalHeader:   { height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: '#E2E8F0', backgroundColor: '#FFF' },
  modalTitle:    { fontSize: 15, fontWeight: '800', color: '#0F172A', flex: 1, textAlign: 'center' },
  modalScroll:   { padding: 16 },

  section:       { marginBottom: 16 },
  sectionTitle:  { fontSize: 14, fontWeight: '800', color: '#0F172A', marginBottom: 10 },

  infoCard:      { backgroundColor: '#FFF', borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: '#E2E8F0', gap: 8 },
  infoRow:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 3 },
  infoLabel:     { fontSize: 12, color: '#64748B', fontWeight: '600', flex: 1 },
  infoValue:     { fontSize: 12, fontWeight: '700', color: '#0F172A', flex: 2, textAlign: 'right' },

  itemRow:       { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F8FAFC', borderRadius: 10, padding: 10, marginBottom: 6, borderWidth: 1, borderColor: '#E2E8F0' },
  itemNum:       { width: 24, height: 24, borderRadius: 12, backgroundColor: '#E0F2FE', alignItems: 'center', justifyContent: 'center', marginRight: 10 },
  itemNumText:   { fontSize: 11, fontWeight: '800', color: '#0369A1' },
  itemName:      { fontSize: 13, fontWeight: '700', color: '#0F172A' },
  itemMeta:      { fontSize: 11, color: '#64748B', marginTop: 2 },
  itemQty:       { alignItems: 'flex-end', minWidth: 50 },
  itemQtyNum:    { fontSize: 15, fontWeight: '900', color: '#481238' },
  itemQtyUnit:   { fontSize: 10, color: '#94A3B8' },

  actionBar:     { flexDirection: 'row', gap: 10, marginTop: 16, marginBottom: 8 },
  actionBtn:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 10 },
  actionBtnText: { fontSize: 13, fontWeight: '700' },

  fieldLabel:    { fontSize: 13, fontWeight: '700', color: '#334155', marginBottom: 6 },
  formInput:     { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: '#0F172A', marginBottom: 12 },

  submitBtn:     { height: 48, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  submitBtnText: { color: '#FFF', fontSize: 14, fontWeight: '800' },

  // Dropdown styles
  dropdownTrigger:       { height: 44, backgroundColor: '#FFF', borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  dropdownTriggerText:   { fontSize: 14, color: '#0F172A', flex: 1 },
  dropdownArrow:         { width: 0, height: 0, borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 6, borderStyle: 'solid', borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: '#94A3B8', marginLeft: 8 },
  dropdownModalBg:       { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 40 },
  dropdownModalContent:  { backgroundColor: '#FFF', borderRadius: 16, maxHeight: '80%', overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12, elevation: 8 },
  dropdownModalHeader:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#F1F5F9', backgroundColor: '#FAF5FF' },
  dropdownModalTitle:    { fontSize: 15, fontWeight: '800', color: '#481238' },
  dropdownCloseBtn:      { paddingHorizontal: 8, paddingVertical: 4 },
  dropdownCloseBtnText:  { fontSize: 13, fontWeight: '700', color: '#481238' },
  dropdownSearchInput:   { height: 40, backgroundColor: '#F1F5F9', borderRadius: 8, borderWidth: 1, borderColor: '#E2E8F0', paddingHorizontal: 12, fontSize: 13, color: '#0F172A' },
  dropdownItemRow:       { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F1F5F9', flexDirection: 'row', alignItems: 'center' },
  dropdownItemRowActive: { backgroundColor: '#F3E8FF' },
  dropdownItemText:      { fontSize: 14, color: '#334155', fontWeight: '600' },
  dropdownItemTextActive:{ color: '#481238', fontWeight: '800' },
});
