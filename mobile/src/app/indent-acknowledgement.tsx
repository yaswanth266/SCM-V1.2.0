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
  if (name === 'calendar') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.75, height: s * 0.75, borderRadius: 2, borderWidth: 1.8, borderColor: color, paddingTop: 4 }}>
          <View style={{ width: '100%', height: 1.5, backgroundColor: color, marginBottom: 3 }} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 2, paddingHorizontal: 2 }}>
            <View style={{ width: 2, height: 2, backgroundColor: color }} />
            <View style={{ width: 2, height: 2, backgroundColor: color }} />
          </View>
        </View>
      </View>
    );
  }
  if (name === 'user') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.4, height: s * 0.4, borderRadius: (s * 0.4)/2, borderWidth: 1.8, borderColor: color }} />
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
  if (name === 'chevron-right') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.35, height: s * 0.35, borderTopWidth: 2, borderRightWidth: 2, borderColor: color, transform: [{ rotate: '45deg' }, { translateX: -s * 0.05 }] }} />
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
  return null;
};

export default function AcknowledgementScreen() {
  const [token, setToken] = useState<string>('');
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // List & Tabs
  const [acknowledgements, setAcknowledgements] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<string>('all'); // all, received, partial, completed
  const [page, setPage] = useState<number>(1);
  const [total, setTotal] = useState<number>(0);

  // Detail Modal
  const [selectedAck, setSelectedAck] = useState<any>(null);
  const [detailModalVisible, setDetailModalVisible] = useState<boolean>(false);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);

  // New Acknowledgement Form Modal
  const [formModalVisible, setFormModalVisible] = useState<boolean>(false);
  const [formLoading, setFormLoading] = useState<boolean>(false);
  const [pendingIndents, setPendingIndents] = useState<any[]>([]);
  const [selectedIndentId, setSelectedIndentId] = useState<string>('');
  const [employeeCode, setEmployeeCode] = useState<string>('');
  const [overallRemarks, setOverallRemarks] = useState<string>('');
  const [ackItems, setAckItems] = useState<any[]>([]);
  const [loadingIndentDetail, setLoadingIndentDetail] = useState<boolean>(false);
  const [indentPickerVisible, setIndentPickerVisible] = useState<boolean>(false);
  const [indentSearch, setIndentSearch] = useState<string>('');
  const [scannedItems, setScannedItems] = useState<any[]>([]);
  const [barcodeInput, setBarcodeInput] = useState<string>('');
  const [selectedIndentDetail, setSelectedIndentDetail] = useState<any>(null);

  const handleBarcodeScan = (code: string) => {
    const scanResult = {
      value: code,
      timestamp: new Date().toISOString(),
      mode: 'scan',
    };
    setScannedItems((prev) => [...prev, scanResult]);

    const matchedIdx = ackItems.findIndex(
      (item) =>
        (item.barcode && item.barcode.toLowerCase() === code.toLowerCase()) ||
        (item.item_code && item.item_code.toLowerCase() === code.toLowerCase())
    );

    if (matchedIdx >= 0) {
      setAckItems((prev) =>
        prev.map((item, idx) => {
          if (idx === matchedIdx) {
            const currentQty = parseFloat(item.received_qty || '0');
            const newQty = Math.min(item.remaining_qty || item.approved_qty || 0, currentQty + 1);
            return { ...item, received_qty: newQty.toString() };
          }
          return item;
        })
      );
      Alert.alert('Barcode Matched', `Item: ${ackItems[matchedIdx].item_name}\nQuantity incremented.`);
    } else {
      Alert.alert('Barcode Scanned', `Scanned: ${code}\nNo matching item found in this indent.`);
    }
  };

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
        const parsedUser = JSON.parse(savedUserStr);
        setUser(parsedUser);
        setEmployeeCode(parsedUser?.employee_code || '');
        const url = API_BASE_URL;

        fetchAcknowledgements(url, savedToken, 1, activeTab);
        fetchPendingIndents(url, savedToken);
      } catch (e) {
        console.error(e);
        router.replace('/');
      }
    };
    loadSession();
  }, []);

  // ─── Fetch List ─────────────────────────────────────────────────────────────
  const fetchAcknowledgements = async (
    apiBase: string,
    authToken: string,
    pageNum: number,
    tab: string
  ) => {
    try {
      if (pageNum === 1) setLoading(true);
      const params: any = { page: pageNum, page_size: 15 };
      if (tab !== 'all') params.status = tab;

      const response = await axios.get(`${apiBase}/api/v1/indent/acknowledgements`, {
        headers: { Authorization: `Bearer ${authToken}` },
        params,
      });

      const resData = response.data;
      const items = resData.items || resData.data || response.data || [];
      if (pageNum === 1) {
        setAcknowledgements(items);
      } else {
        setAcknowledgements((prev) => [...prev, ...items]);
      }
      setTotal(resData.total || items.length);
      setPage(pageNum);
    } catch (e) {
      console.error(e);
      Alert.alert('Error', 'Failed to retrieve acknowledgements list.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    fetchAcknowledgements(API_BASE_URL, token, 1, activeTab);
  };

  const loadMore = () => {
    if (acknowledgements.length < total && !loading) {
      fetchAcknowledgements(API_BASE_URL, token, page + 1, activeTab);
    }
  };

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    fetchAcknowledgements(API_BASE_URL, token, 1, tab);
  };

  // ─── Fetch Details ──────────────────────────────────────────────────────────
  const openAckDetails = async (ackId: number) => {
    setDetailLoading(true);
    setDetailModalVisible(true);
    try {
      const res = await axios.get(`${API_BASE_URL}/api/v1/indent/acknowledgements/${ackId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setSelectedAck(res.data);
    } catch (e) {
      console.error(e);
      Alert.alert('Error', 'Failed to retrieve acknowledgement details.');
      setDetailModalVisible(false);
    } finally {
      setDetailLoading(false);
    }
  };

  // ─── Form Logic ─────────────────────────────────────────────────────────────
  const fetchPendingIndents = async (apiBase: string, authToken: string) => {
    try {
      const res = await axios.get(`${apiBase}/api/v1/indent/indents`, {
        headers: { Authorization: `Bearer ${authToken}` },
        params: { page_size: 100, pending_acknowledgement: true },
      });
      const data = res.data.items || res.data.data || res.data || [];
      setPendingIndents(data);
    } catch (e) {
      console.error(e);
    }
  };

  const openNewForm = () => {
    setSelectedIndentId('');
    setOverallRemarks('');
    setAckItems([]);
    setIndentSearch('');
    setScannedItems([]);
    setBarcodeInput('');
    setSelectedIndentDetail(null);
    setFormModalVisible(true);
    fetchPendingIndents(API_BASE_URL, token);
  };

  const handleSelectIndent = async (indentId: string) => {
    setSelectedIndentId(indentId);
    if (!indentId) {
      setAckItems([]);
      setSelectedIndentDetail(null);
      return;
    }

    setLoadingIndentDetail(true);
    try {
      const detailRes = await axios.get(`${API_BASE_URL}/api/v1/indent/indents/${indentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const indent = detailRes.data;
      setSelectedIndentDetail(indent);

      // Fetch prior acknowledgements to compute remaining quantity
      let priorByLine: any = {};
      try {
        const priorRes = await axios.get(`${API_BASE_URL}/api/v1/indent/indents/${indentId}/acknowledgements`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const priorAcks = priorRes.data || [];
        priorAcks.forEach((ack: any) => {
          if (Array.isArray(ack.items)) {
            ack.items.forEach((ai: any) => {
              const k = ai.indent_item_id || ai.item_id;
              if (k) {
                priorByLine[k] = (priorByLine[k] || 0) + Number(ai.received_qty || 0);
              }
            });
          }
        });
      } catch (_e) {}

      const formatted = (indent.items || []).map((item: any) => {
        const approved = Number(item.approved_qty || item.requested_qty || 0);
        const already = Number(priorByLine[item.id] || 0);
        const remaining = Math.max(0, approved - already);
        return {
          id: item.id,
          item_id: item.item_id,
          item_code: item.item_code || item.item?.item_code || '',
          item_name: item.item_name || item.item?.name || '',
          uom: item.uom || item.uom_name || '',
          approved_qty: approved,
          already_received_qty: already,
          remaining_qty: remaining,
          received_qty: '0', // Default to 0 to match web app
          remarks: '',
          barcode: item.item?.barcode || item.barcode || '',
        };
      });

      setAckItems(formatted);
    } catch (e) {
      console.error(e);
      Alert.alert('Error', 'Failed to retrieve selected indent items.');
    } finally {
      setLoadingIndentDetail(false);
    }
  };

  const handleSubmitAcknowledgement = async () => {
    if (!selectedIndentId) {
      Alert.alert('Validation Error', 'Please select an indent.');
      return;
    }
    if (!employeeCode) {
      Alert.alert('Validation Error', 'Please enter your Employee Code.');
      return;
    }

    const validItems = ackItems.map((item) => ({
      indent_item_id: item.id,
      item_id: item.item_id,
      received_qty: parseFloat(item.received_qty || '0'),
      remarks: item.remarks || '',
    })).filter((i) => i.received_qty > 0);

    if (validItems.length === 0) {
      Alert.alert('Validation Error', 'Please enter a received quantity greater than 0 for at least one item.');
      return;
    }

    setFormLoading(true);
    try {
      const payload = {
        indent_id: parseInt(selectedIndentId),
        employee_code: employeeCode,
        remarks: overallRemarks,
        scan_timestamp: new Date().toISOString(),
        items: validItems,
        scanned_barcodes: scannedItems.map((s) => ({
          value: s.value,
          timestamp: s.timestamp,
          mode: s.mode,
        })),
      };

      await axios.post(`${API_BASE_URL}/api/v1/indent/acknowledgements`, payload, {
        headers: { Authorization: `Bearer ${token}` },
      });

      Alert.alert('Success', 'Acknowledgement recorded successfully.');
      setFormModalVisible(false);
      handleRefresh();
    } catch (err: any) {
      const errMsg = err.response?.data?.detail || 'Failed to submit acknowledgement.';
      Alert.alert('Submission Failed', errMsg);
    } finally {
      setFormLoading(false);
    }
  };

  // Status Style
  const getStatusStyle = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'received':
        return { bg: '#D1FAE5', text: '#059669' };
      case 'partial':
        return { bg: '#FEF3C7', text: '#D97706' };
      case 'completed':
        return { bg: '#DBEAFE', text: '#2563EB' };
      default:
        return { bg: '#E2E8F0', text: '#475569' };
    }
  };

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
            onPress={() => router.replace('/acknowledgement-selector')}
          >
            <Icon name="arrow-left" size={20} color="#FFFFFF" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Acknowledgements</Text>
          <TouchableOpacity style={styles.headerButton} onPress={openNewForm}>
            <Icon name="plus" size={20} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </LinearGradient>

      {/* Tabs */}
      <View style={styles.tabContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabScroll}>
          {['all', 'received', 'partial', 'completed'].map((tab) => (
            <TouchableOpacity
              key={tab}
              style={[styles.tab, activeTab === tab && styles.tabActive]}
              onPress={() => handleTabChange(tab)}
            >
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                {tab.toUpperCase()}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* List */}
      {loading && page === 1 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#4A1060" />
          <Text style={styles.loadingText}>Loading acknowledgements...</Text>
        </View>
      ) : acknowledgements.length === 0 ? (
        <ScrollView
          contentContainerStyle={styles.emptyContainer}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        >
          <Icon name="package" size={48} color="#CBD5E1" />
          <Text style={styles.emptyText}>No acknowledgements found</Text>
          <TouchableOpacity style={styles.emptyButton} onPress={openNewForm}>
            <Text style={styles.emptyButtonText}>Record Goods Receipt</Text>
          </TouchableOpacity>
        </ScrollView>
      ) : (
        <FlatList
          data={acknowledgements}
          keyExtractor={(item) => item.id.toString()}
          contentContainerStyle={styles.listContent}
          onEndReached={loadMore}
          onEndReachedThreshold={0.2}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          renderItem={({ item }) => {
            const statusStyle = getStatusStyle(item.status);
            const dateStr = item.acknowledged_at ? new Date(item.acknowledged_at).toLocaleDateString() : '-';

            return (
              <TouchableOpacity
                style={styles.card}
                activeOpacity={0.7}
                onPress={() => openAckDetails(item.id)}
              >
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>
                    {item.indent_number || item.indent?.indent_number || `Ack #${item.id}`}
                  </Text>
                  <View style={[styles.statusTag, { backgroundColor: statusStyle.bg }]}>
                    <Text style={[styles.statusText, { color: statusStyle.text }]}>
                      {item.status?.toUpperCase() || 'RECEIVED'}
                    </Text>
                  </View>
                </View>

                <View style={styles.cardDetails}>
                  <View style={styles.detailRow}>
                    <Icon name="calendar" size={14} color="#7C3AED" />
                    <Text style={styles.detailText}>Ack Date: {dateStr}</Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Icon name="user" size={14} color="#7C3AED" />
                    <Text style={styles.detailText}>By: {item.acknowledged_by_name || '-'}</Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Icon name="package" size={14} color="#7C3AED" />
                    <Text style={styles.detailText}>Items Count: {item.received_items_count || item.items?.length || 0}</Text>
                  </View>
                </View>

                <View style={styles.cardFooter}>
                  <Text style={styles.cardFooterType}>Warehouse: {item.warehouse_name || '-'}</Text>
                  <Icon name="chevron-right" size={16} color="#7C3AED" />
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}

      {/* ─── Detail Modal ─── */}
      <Modal
        visible={detailModalVisible}
        animationType="slide"
        onRequestClose={() => setDetailModalVisible(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          {/* Header */}
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setDetailModalVisible(false)}>
              <Icon name="arrow-left" size={20} color="#334155" />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Acknowledgement Detail</Text>
            <View style={{ width: 20 }} />
          </View>

          {detailLoading || !selectedAck ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#4A1060" />
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.modalScroll}>
              <View style={styles.infoCard}>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Indent Number</Text>
                  <Text style={styles.infoValue}>{selectedAck.indent_number || selectedAck.indent?.indent_number || '-'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Warehouse</Text>
                  <Text style={styles.infoValue}>{selectedAck.warehouse_name || '-'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Status</Text>
                  <View style={[styles.statusTag, { backgroundColor: getStatusStyle(selectedAck.status).bg, alignSelf: 'flex-start' }]}>
                    <Text style={[styles.statusText, { color: getStatusStyle(selectedAck.status).text }]}>
                      {selectedAck.status?.toUpperCase() || 'RECEIVED'}
                    </Text>
                  </View>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Employee Code</Text>
                  <Text style={styles.infoValue}>{selectedAck.employee_code || '-'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Acknowledged By</Text>
                  <Text style={styles.infoValue}>{selectedAck.acknowledged_by_name || '-'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Acknowledged At</Text>
                  <Text style={styles.infoValue}>
                    {selectedAck.acknowledged_at ? new Date(selectedAck.acknowledged_at).toLocaleString() : '-'}
                  </Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Scan Timestamp</Text>
                  <Text style={styles.infoValue}>
                    {selectedAck.scan_timestamp ? new Date(selectedAck.scan_timestamp).toLocaleString() : '-'}
                  </Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Remarks</Text>
                  <Text style={styles.infoValue}>{selectedAck.remarks || '-'}</Text>
                </View>
              </View>

              <Text style={styles.sectionHeading}>Items Received</Text>
              {(selectedAck.items || []).map((item: any, idx: number) => (
                <View key={item.id || idx} style={styles.itemRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName}>
                      {item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.name}` : '-')}
                    </Text>
                    <Text style={styles.itemMeta}>
                      Code: {item.item_code || item.item?.item_code || '-'} • UOM: {item.uom || '-'}
                    </Text>
                    <Text style={styles.itemMeta}>
                      Approved Qty: {item.approved_qty || item.indent_item?.approved_qty || '-'}
                    </Text>
                    {item.remarks ? <Text style={styles.itemRemarks}>Remarks: {item.remarks}</Text> : null}
                  </View>
                  <View style={styles.itemQtyContainer}>
                    <Text style={[styles.qtyLabel, { fontWeight: 'bold', color: '#10B981', fontSize: 14 }]}>
                      Recv: {item.received_qty}
                    </Text>
                  </View>
                </View>
              ))}

              {/* Scanned Barcodes List */}
              {selectedAck.scanned_barcodes && selectedAck.scanned_barcodes.length > 0 && (
                <View style={{ marginTop: 20 }}>
                  <Text style={styles.sectionHeading}>Scanned Barcodes</Text>
                  {selectedAck.scanned_barcodes.map((bc: any, idx: number) => (
                    <View key={idx} style={[styles.infoRow, { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' }]}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: '#1E293B' }}>{bc.value}</Text>
                        <Text style={{ fontSize: 11, color: '#64748B' }}>
                          {bc.timestamp ? new Date(bc.timestamp).toLocaleTimeString() : ''}
                        </Text>
                      </View>
                      <View style={{ backgroundColor: '#F1F5F9', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 }}>
                        <Text style={{ fontSize: 10, color: '#475569', fontWeight: 'bold' }}>{bc.mode || 'scan'}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>

      {/* ─── Create Form Modal ─── */}
      <Modal
        visible={formModalVisible}
        animationType="slide"
        onRequestClose={() => setFormModalVisible(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setFormModalVisible(false)}>
              <Icon name="x" size={20} color="#334155" />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Record Goods Receipt</Text>
            <View style={{ width: 20 }} />
          </View>

          {formLoading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#4A1060" />
              <Text style={styles.loadingText}>Saving acknowledgement...</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.modalScroll}>
              {/* ── Indent Dropdown ── */}
              <Text style={styles.fieldLabel}>Select Indent *</Text>
              <TouchableOpacity
                style={styles.dropdownBtn}
                onPress={() => setIndentPickerVisible(true)}
                activeOpacity={0.7}
              >
                <Text style={selectedIndentId ? styles.dropdownBtnText : styles.dropdownBtnPlaceholder} numberOfLines={1}>
                  {selectedIndentId
                    ? (pendingIndents.find((i: any) => i.id.toString() === selectedIndentId)?.indent_number || 'Selected')
                    : 'Select pending indent...'}
                </Text>
                <Icon name="chevron-right" size={16} color="#94A3B8" />
              </TouchableOpacity>

              {/* Indent Picker Modal */}
              <Modal
                visible={indentPickerVisible}
                animationType="slide"
                transparent
                onRequestClose={() => setIndentPickerVisible(false)}
              >
                <View style={styles.pickerOverlay}>
                  <View style={styles.pickerSheet}>
                    <View style={styles.pickerSheetHeader}>
                      <Text style={styles.pickerSheetTitle}>Select Indent</Text>
                      <TouchableOpacity onPress={() => setIndentPickerVisible(false)}>
                        <Icon name="x" size={20} color="#334155" />
                      </TouchableOpacity>
                    </View>
                    <TextInput
                      style={styles.pickerSearch}
                      placeholder="Search indent number..."
                      placeholderTextColor="#94A3B8"
                      value={indentSearch}
                      onChangeText={setIndentSearch}
                    />
                    <FlatList
                      data={pendingIndents.filter((i: any) =>
                        !indentSearch || i.indent_number?.toLowerCase().includes(indentSearch.toLowerCase())
                      )}
                      keyExtractor={(item: any) => item.id.toString()}
                      style={{ maxHeight: 360 }}
                      ListEmptyComponent={
                        <Text style={{ textAlign: 'center', color: '#94A3B8', padding: 24 }}>No pending indents found</Text>
                      }
                      renderItem={({ item }: { item: any }) => (
                        <TouchableOpacity
                          style={[
                            styles.pickerItem,
                            selectedIndentId === item.id.toString() && styles.pickerItemActive,
                          ]}
                          onPress={() => {
                            handleSelectIndent(item.id.toString());
                            setIndentPickerVisible(false);
                            setIndentSearch('');
                          }}
                        >
                          <Text style={[
                            styles.pickerItemText,
                            selectedIndentId === item.id.toString() && styles.pickerItemTextActive,
                          ]}>
                            {item.indent_number}
                          </Text>
                          <Text style={styles.pickerItemSub}>
                            {item.warehouse_name || ''}{item.warehouse_name && item.project_name ? ' · ' : ''}{item.project_name || ''}
                          </Text>
                        </TouchableOpacity>
                      )}
                    />
                  </View>
                </View>
              </Modal>

              <Text style={styles.fieldLabel}>Employee Code *</Text>
              <TextInput
                style={styles.formInput}
                placeholder="Enter employee code"
                value={employeeCode}
                onChangeText={setEmployeeCode}
              />

              {/* Indent Detail Summary (mirroring web descriptions) */}
              {selectedIndentDetail && (
                <View style={styles.infoCard}>
                  <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>Indent #</Text>
                    <Text style={styles.infoValue}>{selectedIndentDetail.indent_number || '-'}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>Warehouse</Text>
                    <Text style={styles.infoValue}>{selectedIndentDetail.warehouse_name || '-'}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>Required Date</Text>
                    <Text style={styles.infoValue}>
                      {selectedIndentDetail.required_date ? new Date(selectedIndentDetail.required_date).toLocaleDateString() : '-'}
                    </Text>
                  </View>
                </View>
              )}

              {/* Scan Received Goods section */}
              {selectedIndentId ? (
                <View style={[styles.formItemCard, { marginTop: 12 }]}>
                  <Text style={[styles.fieldLabel, { fontWeight: '700' }]}>Scan Received Goods</Text>
                  <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                    <TextInput
                      style={[styles.formInput, { flex: 1, marginBottom: 0 }]}
                      placeholder="Scan barcode or type item code..."
                      value={barcodeInput}
                      onChangeText={setBarcodeInput}
                      onSubmitEditing={() => {
                        if (barcodeInput.trim()) {
                          handleBarcodeScan(barcodeInput.trim());
                          setBarcodeInput('');
                        }
                      }}
                    />
                    <TouchableOpacity
                      style={[styles.actionBtn, styles.btnPrimary, { height: 40, justifyContent: 'center', marginTop: 0, paddingHorizontal: 16 }]}
                      onPress={() => {
                        if (barcodeInput.trim()) {
                          handleBarcodeScan(barcodeInput.trim());
                          setBarcodeInput('');
                        }
                      }}
                    >
                      <Text style={[styles.actionBtnText, { fontSize: 13 }]}>Scan</Text>
                    </TouchableOpacity>
                  </View>
                  {scannedItems.length > 0 && (
                    <View style={{ marginTop: 12 }}>
                      <Text style={{ fontSize: 12, color: '#64748B' }}>{scannedItems.length} item(s) scanned:</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                        {scannedItems.map((s, idx) => (
                          <View key={idx} style={{ backgroundColor: '#DBEAFE', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 }}>
                            <Text style={{ fontSize: 11, color: '#1E40AF', fontWeight: '600' }}>{s.value}</Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  )}
                </View>
              ) : null}

              {loadingIndentDetail ? (
                <View style={{ padding: 32, alignItems: 'center' }}>
                  <ActivityIndicator color="#4A1060" />
                  <Text style={styles.loadingText}>Loading indent items...</Text>
                </View>
              ) : ackItems.length > 0 ? (
                <View style={{ marginTop: 12 }}>
                  <Text style={styles.sectionHeading}>Confirm Quantities Received</Text>
                  {ackItems.map((item, index) => (
                    <View key={item.id} style={styles.formItemCard}>
                      <Text style={styles.itemName}>
                        {item.item_name ? item.item_name : `Item ID: ${item.item_id}`}
                      </Text>
                      <Text style={styles.itemMeta}>Code: {item.item_code || '-'} • UOM: {item.uom || '-'}</Text>
                      <Text style={styles.itemMeta}>
                        Approved: {item.approved_qty} • Already Recv: {item.already_received_qty}
                      </Text>

                      <View style={[styles.formItemRow, { gap: 12, marginTop: 8 }]}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.fieldLabel}>Receive Now Qty *</Text>
                          <TextInput
                            style={styles.formInput}
                            keyboardType="numeric"
                            value={item.received_qty}
                            onChangeText={(text) => {
                              const updated = [...ackItems];
                              updated[index].received_qty = text;
                              setAckItems(updated);
                            }}
                          />
                        </View>
                        <View style={{ flex: 1.5 }}>
                          <Text style={styles.fieldLabel}>Remarks</Text>
                          <TextInput
                            style={styles.formInput}
                            placeholder="Damaged, short..."
                            value={item.remarks}
                            onChangeText={(text) => {
                              const updated = [...ackItems];
                              updated[index].remarks = text;
                              setAckItems(updated);
                            }}
                          />
                        </View>
                      </View>
                    </View>
                  ))}

                  <Text style={[styles.fieldLabel, { marginTop: 12 }]}>Overall Remarks</Text>
                  <TextInput
                    style={[styles.formInput, { height: 60 }]}
                    placeholder="Any observations about the shipment..."
                    multiline
                    value={overallRemarks}
                    onChangeText={setOverallRemarks}
                  />
                </View>
              ) : selectedIndentId ? (
                <Text style={styles.emptyText}>No items found in selected indent.</Text>
              ) : null}

              <View style={[styles.actionButtonsContainer, { marginTop: 24 }]}>
                <TouchableOpacity
                  style={[styles.actionBtn, styles.btnPrimary]}
                  onPress={handleSubmitAcknowledgement}
                >
                  <Text style={styles.actionBtnText}>Confirm Acknowledgement</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          )}
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
  },
  headerButton: {
    padding: 8,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#FFFFFF',
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
    fontSize: 12,
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
  actionBtnText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 15,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#475569',
    marginBottom: 6,
  },
  dropdownBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#FFFFFF',
    marginBottom: 16,
  },
  dropdownBtnText: {
    fontSize: 14,
    color: '#1E293B',
    fontWeight: '500',
    flex: 1,
  },
  dropdownBtnPlaceholder: {
    fontSize: 14,
    color: '#94A3B8',
    flex: 1,
  },
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
    paddingBottom: 32,
    maxHeight: '70%',
  },
  pickerSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  pickerSheetTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1E293B',
  },
  pickerSearch: {
    margin: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 8,
    paddingHorizontal: 12,
    height: 40,
    fontSize: 14,
    color: '#1E293B',
    backgroundColor: '#F8FAFC',
  },
  pickerItem: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F8FAFC',
  },
  pickerItemActive: {
    backgroundColor: '#F0E8F8',
  },
  pickerItemText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1E293B',
  },
  pickerItemTextActive: {
    color: '#4A1060',
  },
  pickerItemSub: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
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
});
