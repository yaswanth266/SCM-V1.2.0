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
      <View style={{ width: s, height: s, borderRadius: s/2, borderWidth: 1.8, borderColor: color, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 1.8, height: s * 0.35, backgroundColor: color }} />
        <View style={{ position: 'absolute', width: s * 0.25, height: 1.8, backgroundColor: color, top: s/2, left: s/2 }} />
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
  if (name === 'document') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.65, height: s * 0.8, borderRadius: 2, borderWidth: 1.8, borderColor: color, padding: 3, justifyContent: 'center', gap: 2.5 }}>
          <View style={{ width: '70%', height: 1.5, backgroundColor: color }} />
          <View style={{ width: '95%', height: 1.5, backgroundColor: color }} />
          <View style={{ width: '50%', height: 1.5, backgroundColor: color }} />
        </View>
      </View>
    );
  }
  return null;
};

const formatDateTime = (dateStr: string | null | undefined): string => {
  if (!dateStr) return '-';
  try {
    let normalized = dateStr;
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      const [year, month, day] = normalized.split('-');
      return `${day}/${month}/${year} 00:00`;
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
      hour12: false,
    };
    
    const formatter = new Intl.DateTimeFormat('en-IN', options);
    return formatter.format(d).replace(',', '');
  } catch (e) {
    console.error('Error formatting datetime:', e);
    return '-';
  }
};

export default function ApprovalsScreen() {
  const [token, setToken] = useState<string>('');
  const [apiUrl, setApiUrl] = useState<string>('');
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // List & Filter
  const [approvals, setApprovals] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<string>('pending'); // pending, on_hold, approved, rejected
  const [page, setPage] = useState<number>(1);
  const [total, setTotal] = useState<number>(0);

  // Detail Modal
  const [detailModalVisible, setDetailModalVisible] = useState<boolean>(false);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [selectedRecord, setSelectedRecord] = useState<any>(null);
  const [detailData, setDetailData] = useState<any>(null);
  const [approvalSteps, setApprovalSteps] = useState<any[]>([]);
  const [qtyOverrides, setQtyOverrides] = useState<any>({});

  // Action Input
  const [actionComment, setActionComment] = useState<string>('');
  const [actionSubmitting, setActionSubmitting] = useState<boolean>(false);

  // ─── Initialization ─────────────────────────────────────────────────────────
  useEffect(() => {
    const loadSession = async () => {
      try {
        const savedToken = await AsyncStorage.getItem('user_token');
        const savedUserStr = await AsyncStorage.getItem('user_profile');
        const savedApiUrl = await AsyncStorage.getItem('API_URL');

        if (!savedToken || !savedUserStr) {
          router.replace('/');
          return;
        }

        setToken(savedToken);
        setUser(JSON.parse(savedUserStr));
        const url = savedApiUrl || 'http://10.2.1.31:8000';
        setApiUrl(url);

        fetchApprovals(url, savedToken, 1, activeTab);
      } catch (e) {
        console.error(e);
        router.replace('/');
      }
    };
    loadSession();
  }, []);

  // ─── Fetch List ─────────────────────────────────────────────────────────────
  const fetchApprovals = async (
    apiBase: string,
    authToken: string,
    pageNum: number,
    tab: string
  ) => {
    try {
      if (pageNum === 1) setLoading(true);
      const response = await axios.get(`${apiBase}/api/v1/approvals/pending`, {
        headers: { Authorization: `Bearer ${authToken}` },
        params: {
          page: pageNum,
          page_size: 15,
          status: tab,
        },
      });

      const resData = response.data;
      const items = resData.items || resData.data || response.data || [];
      if (pageNum === 1) {
        setApprovals(items);
      } else {
        setApprovals((prev) => [...prev, ...items]);
      }
      setTotal(resData.total || items.length);
      setPage(pageNum);
    } catch (e) {
      console.error(e);
      Alert.alert('Error', 'Failed to retrieve pending approvals.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    fetchApprovals(apiUrl, token, 1, activeTab);
  };

  const loadMore = () => {
    if (approvals.length < total && !loading) {
      fetchApprovals(apiUrl, token, page + 1, activeTab);
    }
  };

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    fetchApprovals(apiUrl, token, 1, tab);
  };

  // ─── Fetch Details ──────────────────────────────────────────────────────────
  const openApprovalDetails = async (record: any) => {
    setSelectedRecord(record);
    setDetailLoading(true);
    setDetailModalVisible(true);
    setDetailData(null);
    setApprovalSteps([]);
    setQtyOverrides({});
    setActionComment('');

    try {
      const [detailRes, stepsRes] = await Promise.allSettled([
        axios.get(`${apiUrl}/api/v1/approvals/pending/${record.id}/detail`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        axios.get(`${apiUrl}/api/v1/approvals/pending/${record.id}/steps`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);

      if (detailRes.status === 'fulfilled') {
        const dData = detailRes.value.data;
        setDetailData(dData);
        // Prepopulate overrides with quantities
        const overrides: any = {};
        if (dData && Array.isArray(dData.items)) {
          dData.items.forEach((item: any) => {
            overrides[item.id] = (item.approved_qty != null ? item.approved_qty : item.requested_qty || item.qty || 0).toString();
          });
        }
        setQtyOverrides(overrides);
      }
      if (stepsRes.status === 'fulfilled') {
        const stepsData = stepsRes.value.data;
        const stepsList = stepsData.items || stepsData.data || stepsData || [];
        const mappedSteps = stepsList.map((step: any) => {
          const histMatch = record.history?.find((h: any) => h.level === step.level && h.action_by === step.action_by);
          return {
            ...step,
            status: step.status || step.action || 'pending',
            approver_name: step.approver_name || histMatch?.action_by_name || `User #${step.action_by}`,
            remarks: step.remarks || step.comments,
            timestamp: step.action_date,
          };
        });
        setApprovalSteps(mappedSteps);
      }
    } catch (e) {
      console.error(e);
      Alert.alert('Error', 'Failed to retrieve approval details.');
    } finally {
      setDetailLoading(false);
    }
  };

  // ─── Post Actions ───────────────────────────────────────────────────────────
  const submitApprovalAction = async (action: 'approve' | 'reject' | 'hold') => {
    if (!selectedRecord) return;
    if (action === 'reject' && !actionComment.trim()) {
      Alert.alert('Validation Error', 'Please provide a reason/comment for rejection.');
      return;
    }

    Alert.alert(
      `${action.toUpperCase()} Approval`,
      `Are you sure you want to perform this action?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: async () => {
            setActionSubmitting(true);
            try {
              const body: any = { comments: actionComment };

              // Build qty overrides if present (specifically for indents)
              if (action === 'approve' && selectedRecord.document_type === 'indent' && Object.keys(qtyOverrides).length > 0) {
                body.item_overrides = Object.entries(qtyOverrides)
                  .filter(([, v]) => v !== '' && v != null && !isNaN(Number(v)))
                  .map(([id, v]) => ({
                    item_id: parseInt(id),
                    approved_qty: parseFloat(v as string),
                  }));
              }

              await axios.post(
                `${apiUrl}/api/v1/approvals/pending/${selectedRecord.id}/${action}`,
                body,
                { headers: { Authorization: `Bearer ${token}` } }
              );

              Alert.alert('Success', `Request ${action}d successfully.`);
              setDetailModalVisible(false);
              handleRefresh();
            } catch (err: any) {
              const errMsg = err.response?.data?.detail || `Failed to process ${action} action.`;
              Alert.alert('Error', errMsg);
            } finally {
              setActionSubmitting(false);
            }
          },
        },
      ]
    );
  };

  // Status Styling
  const getStatusStyle = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'pending':
        return { bg: '#FEF3C7', text: '#D97706' };
      case 'on_hold':
        return { bg: '#F1F5F9', text: '#64748B' };
      case 'approved':
        return { bg: '#D1FAE5', text: '#059669' };
      case 'rejected':
        return { bg: '#FEE2E2', text: '#DC2626' };
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
            onPress={() => router.replace('/dashboard')}
          >
            <Icon name="arrow-left" size={20} color="#FFFFFF" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Pending Approvals</Text>
          <View style={{ width: 40 }} />
        </View>
      </LinearGradient>

      {/* Tabs */}
      <View style={styles.tabContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabScroll}>
          {['pending', 'on_hold', 'approved', 'rejected'].map((tab) => (
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

      {/* List */}
      {loading && page === 1 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#4A1060" />
          <Text style={styles.loadingText}>Loading approvals...</Text>
        </View>
      ) : approvals.length === 0 ? (
        <ScrollView
          contentContainerStyle={styles.emptyContainer}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        >
          <Icon name="document" size={48} color="#CBD5E1" />
          <Text style={styles.emptyText}>No approvals found</Text>
        </ScrollView>
      ) : (
        <FlatList
          data={approvals}
          keyExtractor={(item) => item.id.toString()}
          contentContainerStyle={styles.listContent}
          onEndReached={loadMore}
          onEndReachedThreshold={0.2}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          renderItem={({ item }) => {
            const statusStyle = getStatusStyle(item.status);
            const dateStr = item.created_at ? formatDateTime(item.created_at) : '-';

            return (
              <TouchableOpacity
                style={styles.card}
                activeOpacity={0.7}
                onPress={() => openApprovalDetails(item)}
              >
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>{item.document_number || `Request #${item.id}`}</Text>
                  <View style={[styles.statusTag, { backgroundColor: statusStyle.bg }]}>
                    <Text style={[styles.statusText, { color: statusStyle.text }]}>
                      {item.status?.toUpperCase()}
                    </Text>
                  </View>
                </View>

                <View style={styles.cardDetails}>
                  <View style={styles.detailRow}>
                    <Icon name="calendar" size={14} color="#7C3AED" />
                    <Text style={styles.detailText}>Created: {dateStr}</Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Icon name="user" size={14} color="#7C3AED" />
                    <Text style={styles.detailText}>Requester: {item.requested_by_name || '-'}</Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Icon name="document" size={14} color="#7C3AED" />
                    <Text style={styles.detailText}>Type: {item.document_type?.replace(/_/g, ' ').toUpperCase()}</Text>
                  </View>
                </View>

                <View style={styles.cardFooter}>
                  <Text style={styles.cardFooterType}>
                    Current Level: {item.current_level} / {item.total_levels}
                  </Text>
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
            <Text style={styles.modalTitle}>Approval Request Detail</Text>
            <View style={{ width: 20 }} />
          </View>

          {detailLoading || !selectedRecord ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#4A1060" />
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.modalScroll}>
              {/* Document Overview (Descriptions Layout) */}
              <View style={styles.descriptionsCard}>
                <Text style={styles.descriptionsCardTitle}>Document Overview</Text>
                
                <View style={styles.descRow}>
                  <View style={styles.descCol}>
                    <Text style={styles.descLabel}>Doc Type</Text>
                    <Text style={styles.descValue}>
                      {selectedRecord.document_type?.replace(/_/g, ' ').toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.descCol}>
                    <Text style={styles.descLabel}>Doc Code</Text>
                    <Text style={styles.descValue}>{selectedRecord.document_number || '-'}</Text>
                  </View>
                </View>

                <View style={styles.descRow}>
                  <View style={styles.descCol}>
                    <Text style={styles.descLabel}>Requested By</Text>
                    <Text style={styles.descValue}>{selectedRecord.requested_by_name || '-'}</Text>
                  </View>
                  <View style={styles.descCol}>
                    <Text style={styles.descLabel}>Requested At</Text>
                    <Text style={styles.descValue}>
                      {selectedRecord.requested_at ? formatDateTime(selectedRecord.requested_at) : '-'}
                    </Text>
                  </View>
                </View>

                <View style={styles.descRow}>
                  <View style={styles.descCol}>
                    <Text style={styles.descLabel}>Priority</Text>
                    <View style={[
                      styles.smallStatusTag,
                      { backgroundColor: selectedRecord.priority === 'urgent' || selectedRecord.priority === 'high' ? '#FEE2E2' : '#F1F5F9' }
                    ]}>
                      <Text style={[
                        styles.smallStatusText,
                        { color: selectedRecord.priority === 'urgent' || selectedRecord.priority === 'high' ? '#DC2626' : '#475569' }
                      ]}>
                        {(selectedRecord.priority || 'normal').toUpperCase()}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.descCol}>
                    <Text style={styles.descLabel}>Level</Text>
                    <Text style={styles.descValue}>
                      {selectedRecord.current_level || 1} / {selectedRecord.total_levels || 1}
                    </Text>
                  </View>
                </View>

                <View style={styles.descRow}>
                  <View style={styles.descCol}>
                    <Text style={styles.descLabel}>Status</Text>
                    <View style={[
                      styles.smallStatusTag,
                      { backgroundColor: activeTab === 'pending' ? '#FEF3C7' : activeTab === 'approved' ? '#D1FAE5' : '#FEE2E2' }
                    ]}>
                      <Text style={[
                        styles.smallStatusText,
                        { color: activeTab === 'pending' ? '#D97706' : activeTab === 'approved' ? '#059669' : '#DC2626' }
                      ]}>
                        {selectedRecord.status?.toUpperCase()}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.descCol}>
                    <Text style={styles.descLabel}>Amount</Text>
                    <Text style={[styles.descValue, { fontWeight: '700', color: '#4A1060' }]}>
                      {selectedRecord.amount != null ? `₹${selectedRecord.amount}` : '-'}
                    </Text>
                  </View>
                </View>

                {(detailData?.project_name || detailData?.warehouse_name) && (
                  <View style={styles.descRow}>
                    {detailData?.project_name ? (
                      <View style={styles.descCol}>
                        <Text style={styles.descLabel}>Project</Text>
                        <Text style={styles.descValue}>{detailData.project_name}</Text>
                      </View>
                    ) : null}
                    {detailData?.warehouse_name ? (
                      <View style={styles.descCol}>
                        <Text style={styles.descLabel}>Warehouse</Text>
                        <Text style={styles.descValue}>{detailData.warehouse_name}</Text>
                      </View>
                    ) : null}
                  </View>
                )}
                
                {detailData?.remarks ? (
                  <View style={[styles.descRow, { borderBottomWidth: 0, paddingBottom: 0 }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.descLabel}>Remarks</Text>
                      <Text style={[styles.descValue, { textAlign: 'left', marginTop: 2 }]}>
                        {detailData.remarks}
                      </Text>
                    </View>
                  </View>
                ) : null}
              </View>

              {/* Stock Summary Banner */}
              {detailData && selectedRecord?.document_type === 'indent' && detailData.stock_summary && (
                (() => {
                  const ss = detailData.stock_summary;
                  const allIn = ss.in_stock_lines === ss.total_lines && ss.total_lines > 0;
                  const noneIn = ss.in_stock_lines === 0 && ss.total_lines > 0;
                  const bg = allIn ? '#ECFDF5' : noneIn ? '#FEF2F2' : '#FFFBEB';
                  const borderColor = allIn ? '#10B981' : noneIn ? '#EF4444' : '#F59E0B';
                  const textColor = allIn ? '#065F46' : noneIn ? '#991B1B' : '#92400E';
                  const label = allIn
                    ? `All ${ss.total_lines} lines available — approve to issue from stock`
                    : noneIn
                      ? `No stock for any line — approving will need a Material Request (procurement)`
                      : `${ss.in_stock_lines} of ${ss.total_lines} lines in stock — partial issue + MR for the rest`;
                  return (
                    <View style={[styles.stockSummaryBanner, { backgroundColor: bg, borderColor: borderColor }]}>
                      <Text style={[styles.stockSummaryText, { color: textColor }]}>
                        {label}
                      </Text>
                    </View>
                  );
                })()
              )}

              {/* Items List */}
              {detailData && detailData.items && detailData.items.length > 0 && (
                <View style={{ marginTop: 12 }}>
                  <Text style={styles.sectionHeading}>Requested Items ({detailData.items.length})</Text>
                  {detailData.items.map((item: any, idx: number) => {
                    const isIndent = selectedRecord.document_type === 'indent';
                    const requestedQty = item.qty ?? item.requested_qty ?? 0;
                    
                    return (
                      <View key={item.id || idx} style={styles.itemCard}>
                        {/* Item Header */}
                        <View style={styles.itemCardHeader}>
                          <Text style={styles.itemCardNumber}>#{idx + 1}</Text>
                          <Text style={styles.itemCardName} numberOfLines={2}>
                            {item.item_name || (item.item ? `[${item.item.item_code}] ${item.item.name}` : '-')}
                          </Text>
                        </View>

                        {/* Item Details Row */}
                        <View style={styles.itemCardDetails}>
                          <View style={styles.itemDetailCol}>
                            <Text style={styles.itemDetailLabel}>UOM</Text>
                            <Text style={styles.itemDetailValue}>{item.uom || '-'}</Text>
                          </View>
                          
                          <View style={styles.itemDetailCol}>
                            <Text style={styles.itemDetailLabel}>Requested</Text>
                            <Text style={styles.itemDetailValue}>{requestedQty}</Text>
                          </View>

                          {!isIndent && (item.rate != null || item.unit_price != null) && (
                            <View style={styles.itemDetailCol}>
                              <Text style={styles.itemDetailLabel}>Rate</Text>
                              <Text style={styles.itemDetailValue}>₹{item.rate != null ? item.rate : item.unit_price}</Text>
                            </View>
                          )}

                          {!isIndent && item.amount != null && (
                            <View style={styles.itemDetailCol}>
                              <Text style={styles.itemDetailLabel}>Amount</Text>
                              <Text style={[styles.itemDetailValue, { fontWeight: '700', color: '#4A1060' }]}>
                                ₹{item.amount}
                              </Text>
                            </View>
                          )}
                        </View>

                        {/* Stock Tag (Indent Only) */}
                        {isIndent && item.stock_status && (
                          <View style={[
                            styles.stockTag,
                            {
                              backgroundColor: item.stock_status === 'in_stock' ? '#ECFDF5'
                                : item.stock_status === 'partial' ? '#FFFBEB' : '#FEF2F2'
                            }
                          ]}>
                            <Text style={[
                              styles.stockText,
                              {
                                color: item.stock_status === 'in_stock' ? '#059669'
                                  : item.stock_status === 'partial' ? '#D97706' : '#DC2626'
                              }
                            ]}>
                              Available: {item.available_qty != null ? item.available_qty : '0'} — {
                                item.stock_status === 'in_stock' ? 'In stock'
                                  : item.stock_status === 'partial' ? 'Partial stock' : 'No stock'
                              }
                            </Text>
                          </View>
                        )}

                        {/* Action overriding (Indent Only & Active Tab Pending/On Hold) */}
                        {isIndent && (activeTab === 'pending' || activeTab === 'on_hold') ? (
                          <View style={styles.itemOverrideContainer}>
                            <Text style={styles.overrideLabel}>Approve Qty:</Text>
                            <TextInput
                              style={styles.overrideInput}
                              keyboardType="numeric"
                              value={qtyOverrides[item.id] || ''}
                              onChangeText={(text) => {
                                setQtyOverrides((prev: any) => ({ ...prev, [item.id]: text }));
                              }}
                            />
                          </View>
                        ) : isIndent ? (
                          <View style={styles.itemApprovedDisplay}>
                            <Text style={styles.overrideLabelDisplay}>Approved Qty:</Text>
                            <Text style={styles.overrideValueDisplay}>
                              {item.approved_qty != null ? item.approved_qty : requestedQty}
                            </Text>
                          </View>
                        ) : (
                          <View style={styles.itemApprovedDisplay}>
                            <Text style={styles.overrideLabelDisplay}>Approved Qty:</Text>
                            <Text style={styles.overrideValueDisplay}>
                              {item.approved_qty != null ? item.approved_qty : requestedQty}
                            </Text>
                          </View>
                        )}

                        {item.remarks ? (
                          <View style={styles.itemRemarksRow}>
                            <Text style={styles.itemRemarksText}>Remarks: {item.remarks}</Text>
                          </View>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              )}

              {/* Detail Summary (Subtotal, Tax, Grand Total) */}
              {detailData && (detailData.subtotal != null || detailData.tax_total != null || detailData.grand_total != null) && (
                <View style={styles.summaryCard}>
                  <Text style={styles.summaryCardTitle}>Summary Details</Text>
                  
                  {detailData.subtotal != null && (
                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabel}>Subtotal</Text>
                      <Text style={styles.summaryValue}>₹{detailData.subtotal.toFixed(2)}</Text>
                    </View>
                  )}
                  
                  {detailData.tax_total != null && (
                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabel}>Tax Total</Text>
                      <Text style={styles.summaryValue}>₹{detailData.tax_total.toFixed(2)}</Text>
                    </View>
                  )}
                  
                  {detailData.grand_total != null && (
                    <View style={[styles.summaryRow, { borderTopWidth: 1, borderTopColor: '#E2E8F0', paddingTop: 8, marginTop: 4 }]}>
                      <Text style={[styles.summaryLabel, { fontWeight: '700', color: '#1E293B' }]}>Grand Total</Text>
                      <Text style={[styles.summaryValue, { fontWeight: '800', color: '#eb2f96', fontSize: 15 }]}>
                        ₹{detailData.grand_total.toFixed(2)}
                      </Text>
                    </View>
                  )}
                </View>
              )}

              {/* Approval Timeline */}
              {approvalSteps.length > 0 && (
                <View style={styles.timelineCard}>
                  <Text style={styles.sectionHeading}>Approval Timeline</Text>
                  <View style={{ paddingLeft: 4, marginTop: 8 }}>
                    {approvalSteps.map((step: any, idx: number) => {
                      const isLast = idx === approvalSteps.length - 1;
                      const status = (step.status || 'pending').toLowerCase();
                      
                      let dotColor = '#94A3B8';
                      let statusText = 'Pending';
                      let statusColor = '#64748B';
                      let bgDot = '#F1F5F9';
                      
                      if (status === 'approved') {
                        dotColor = '#10B981';
                        statusText = 'Approved';
                        statusColor = '#059669';
                        bgDot = '#D1FAE5';
                      } else if (status === 'rejected') {
                        dotColor = '#EF4444';
                        statusText = 'Rejected';
                        statusColor = '#B91C1C';
                        bgDot = '#FEE2E2';
                      } else if (status === 'on_hold') {
                        dotColor = '#F59E0B';
                        statusText = 'On Hold';
                        statusColor = '#B45309';
                        bgDot = '#FEF3C7';
                      } else if (status === 'returned') {
                        dotColor = '#3B82F6';
                        statusText = 'Returned';
                        statusColor = '#1D4ED8';
                        bgDot = '#DBEAFE';
                      } else if (status === 'skipped') {
                        dotColor = '#94A3B8';
                        statusText = 'Skipped';
                        statusColor = '#475569';
                        bgDot = '#F1F5F9';
                      }

                      const dateStr = step.action_date || step.timestamp
                        ? formatDateTime(step.action_date || step.timestamp)
                        : null;

                      return (
                        <View key={step.id || idx} style={styles.timelineItem}>
                          {/* Left dot & line */}
                          <View style={styles.timelineLeftColumn}>
                            <View style={[styles.timelineDot, { backgroundColor: dotColor }]} />
                            {!isLast && <View style={[styles.timelineLine, { backgroundColor: '#CBD5E1' }]} />}
                          </View>
                          
                          {/* Right Content */}
                          <View style={styles.timelineContent}>
                            <View style={styles.timelineHeader}>
                              <Text style={styles.timelineStepTitle}>
                                {step.step_name || step.title || `Level ${step.level || step.level_number}`}
                              </Text>
                              <View style={[styles.timelineStatusTag, { backgroundColor: bgDot }]}>
                                <Text style={[styles.timelineStatusText, { color: statusColor }]}>
                                  {statusText}
                                </Text>
                              </View>
                            </View>

                            {step.approver_name || step.action_by_name ? (
                              <Text style={styles.timelineUser}>
                                {step.approver_name || step.action_by_name} {step.role || step.role_name ? `(${step.role || step.role_name})` : ''}
                              </Text>
                            ) : null}

                            {dateStr && (
                              <Text style={styles.timelineTime}>{dateStr}</Text>
                            )}

                            {(step.remarks || step.comments) ? (
                              <View style={styles.timelineRemarksBox}>
                                <Text style={styles.timelineRemarksText}>
                                  &ldquo;{step.remarks || step.comments}&rdquo;
                                </Text>
                              </View>
                            ) : null}
                          </View>
                        </View>
                      );
                    })}
                  </View>
                </View>
              )}

              {/* Comments Input (for approval actions) */}
              {(activeTab === 'pending' || activeTab === 'on_hold') && (
                <View style={{ marginTop: 16 }}>
                  <Text style={styles.fieldLabel}>Comments (Required for Rejection) *</Text>
                  <TextInput
                    style={[styles.formInput, { height: 60 }]}
                    placeholder="Enter approval comments/rejection reasons..."
                    multiline
                    value={actionComment}
                    onChangeText={setActionComment}
                  />

                  {actionSubmitting ? (
                    <ActivityIndicator style={{ padding: 16 }} color="#4A1060" />
                  ) : (
                    <View style={styles.actionButtonsContainer}>
                      <View style={{ flexDirection: 'row', gap: 12 }}>
                        <TouchableOpacity
                          style={[styles.actionBtn, styles.btnSuccess, { flex: 1.5 }]}
                          onPress={() => submitApprovalAction('approve')}
                        >
                          <Text style={styles.actionBtnText}>Approve</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.actionBtn, styles.btnDanger, { flex: 1 }]}
                          onPress={() => submitApprovalAction('reject')}
                        >
                          <Text style={styles.actionBtnText}>Reject</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.actionBtn, styles.btnSecondary, { flex: 1 }]}
                          onPress={() => submitApprovalAction('hold')}
                        >
                          <Text style={styles.actionBtnTextDark}>Hold</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  )}
                </View>
              )}
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
  stockSummaryBanner: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  stockSummaryText: {
    fontSize: 13,
    fontWeight: '600',
  },
  stockTag: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    marginTop: 4,
  },
  stockText: {
    fontSize: 11,
    fontWeight: '600',
  },
  timelineItem: {
    flexDirection: 'row',
    minHeight: 60,
  },
  timelineLeftColumn: {
    alignItems: 'center',
    width: 24,
  },
  timelineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 6,
    zIndex: 1,
  },
  timelineLine: {
    position: 'absolute',
    top: 16,
    bottom: 0,
    width: 2,
    left: 11,
  },
  timelineContent: {
    flex: 1,
    paddingLeft: 12,
    paddingBottom: 20,
  },
  timelineHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  timelineStepTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#1E293B',
  },
  timelineStatusTag: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  timelineStatusText: {
    fontSize: 11,
    fontWeight: 'bold',
  },
  timelineUser: {
    fontSize: 12,
    color: '#475569',
    marginTop: 2,
  },
  timelineTime: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
  },
  timelineRemarks: {
    fontSize: 12,
    color: '#64748B',
    fontStyle: 'italic',
    marginTop: 4,
    backgroundColor: '#F8FAFC',
    padding: 6,
    borderRadius: 4,
  },
  // Descriptions Grid
  descriptionsCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 16,
    marginBottom: 20,
  },
  descriptionsCardTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#1E293B',
    marginBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
    paddingBottom: 6,
  },
  descRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
    paddingBottom: 8,
    marginBottom: 8,
  },
  descCol: {
    flex: 1,
  },
  descLabel: {
    fontSize: 11,
    color: '#64748B',
    marginBottom: 2,
    textTransform: 'uppercase',
  },
  descValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1E293B',
  },
  smallStatusTag: {
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  smallStatusText: {
    fontSize: 10,
    fontWeight: 'bold',
  },
  
  // Item Cards
  itemCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  itemCardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 8,
    gap: 6,
  },
  itemCardNumber: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#64748B',
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  itemCardName: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#1E293B',
    flex: 1,
  },
  itemCardDetails: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 8,
  },
  itemDetailCol: {
    minWidth: 80,
  },
  itemDetailLabel: {
    fontSize: 11,
    color: '#94A3B8',
    marginBottom: 2,
  },
  itemDetailValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#334155',
  },
  itemOverrideContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    gap: 8,
  },
  overrideLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#475569',
    flex: 1,
  },
  overrideInput: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#FFFFFF',
    borderRadius: 4,
    width: 90,
    height: 36,
    textAlign: 'center',
    paddingHorizontal: 4,
    fontSize: 14,
    color: '#1E293B',
    fontWeight: '600',
  },
  itemApprovedDisplay: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    gap: 8,
  },
  overrideLabelDisplay: {
    fontSize: 12,
    color: '#64748B',
  },
  overrideValueDisplay: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#1E293B',
  },
  itemRemarksRow: {
    marginTop: 8,
    padding: 6,
    backgroundColor: '#F8FAFC',
    borderRadius: 4,
  },
  itemRemarksText: {
    fontSize: 11,
    color: '#64748B',
    fontStyle: 'italic',
  },

  // Detail Summary Card
  summaryCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 16,
    marginBottom: 20,
  },
  summaryCardTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#1E293B',
    marginBottom: 12,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  summaryLabel: {
    fontSize: 12,
    color: '#64748B',
  },
  summaryValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1E293B',
  },

  // Timeline Card
  timelineCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 16,
    marginBottom: 24,
  },
  timelineRemarksBox: {
    marginTop: 4,
    backgroundColor: '#F8FAFC',
    padding: 8,
    borderRadius: 6,
    borderLeftWidth: 3,
    borderLeftColor: '#CBD5E1',
  },
  timelineRemarksText: {
    fontSize: 12,
    color: '#475569',
    fontStyle: 'italic',
  },
});
