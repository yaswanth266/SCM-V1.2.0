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
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { API_BASE_URL } from '../constants/config';

// ─── Custom Vector Icons ─────────────────────────────────────────────────────
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
        </View>
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
  if (name === 'truck') {
    return (
      <View style={{ width: s, height: s, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: s * 0.55, height: s * 0.4, borderWidth: 1.8, borderColor: color, borderRadius: 2, marginRight: s * 0.15 }} />
        <View style={{ width: s * 0.25, height: s * 0.3, borderWidth: 1.8, borderColor: color, borderLeftWidth: 0, position: 'absolute', right: 0, top: s * 0.3, borderTopRightRadius: 2 }} />
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
  if (name === 'camera') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.8, height: s * 0.6, borderRadius: 3, borderWidth: 1.8, borderColor: color, marginTop: s * 0.1 }} />
        <View style={{ width: s * 0.25, height: s * 0.25, borderRadius: (s * 0.25) / 2, borderWidth: 1.8, borderColor: color, position: 'absolute', top: s * 0.3 }} />
      </View>
    );
  }
  if (name === 'image') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.75, height: s * 0.65, borderRadius: 2, borderWidth: 1.8, borderColor: color }} />
        <View style={{ width: s * 0.2, height: s * 0.2, borderRadius: (s * 0.2) / 2, borderWidth: 1.5, borderColor: color, position: 'absolute', top: s * 0.1, left: s * 0.15 }} />
      </View>
    );
  }
  return null;
};

// ─── Photo Thumbnail ──────────────────────────────────────────────────────────
const PhotoThumb = ({ url, onRemove }: { url: string; onRemove: () => void }) => (
  <View style={{ position: 'relative', marginRight: 8, marginBottom: 8 }}>
    <Image
      source={{ uri: url.startsWith('http') ? url : `${API_BASE_URL}${url}` }}
      style={styles.photoThumb}
    />
    <TouchableOpacity style={styles.photoRemoveBtn} onPress={onRemove}>
      <Text style={{ color: '#fff', fontSize: 12, fontWeight: '900', lineHeight: 16, textAlign: 'center' }}>×</Text>
    </TouchableOpacity>
  </View>
);

export default function MaterialAcknowledgementScreen() {
  const [token, setToken] = useState<string>('');
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // List & Search
  const [acknowledgements, setAcknowledgements] = useState<any[]>([]);
  const [page, setPage] = useState<number>(1);
  const [total, setTotal] = useState<number>(0);
  const [search, setSearch] = useState<string>('');

  // Detail Modal
  const [selectedAck, setSelectedAck] = useState<any>(null);
  const [detailModalVisible, setDetailModalVisible] = useState<boolean>(false);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);

  // Form Modal
  const [formModalVisible, setFormModalVisible] = useState<boolean>(false);
  const [formLoading, setFormLoading] = useState<boolean>(false);
  const [pendingIssues, setPendingIssues] = useState<any[]>([]);
  const [selectedIssueId, setSelectedIssueId] = useState<string>('');
  const [selectedIssueDetail, setSelectedIssueDetail] = useState<any>(null);
  const [employeeCode, setEmployeeCode] = useState<string>('');
  const [overallRemarks, setOverallRemarks] = useState<string>('');
  const [ackItems, setAckItems] = useState<any[]>([]);
  const [loadingIssueDetail, setLoadingIssueDetail] = useState<boolean>(false);
  const [issuePickerVisible, setIssuePickerVisible] = useState<boolean>(false);
  const [issueSearch, setIssueSearch] = useState<string>('');

  // Photos
  const [overallPhotos, setOverallPhotos] = useState<{ uri: string; url: string }[]>([]);
  const [uploadingPhoto, setUploadingPhoto] = useState<boolean>(false);

  // Initialization
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

        fetchAcknowledgements(API_BASE_URL, savedToken, 1, search);
        fetchPendingIssues(API_BASE_URL, savedToken);
      } catch (e) {
        console.error(e);
        router.replace('/');
      }
    };
    loadSession();
  }, []);

  const fetchAcknowledgements = async (
    apiBase: string,
    authToken: string,
    pageNum: number,
    searchQuery: string
  ) => {
    try {
      if (pageNum === 1) setLoading(true);
      const params: any = { page: pageNum, page_size: 15 };
      if (searchQuery) params.search = searchQuery;

      const response = await axios.get(`${apiBase}/api/v1/indent/material-acknowledgements`, {
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
      Alert.alert('Error', 'Failed to retrieve vehicle acknowledgements.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    fetchAcknowledgements(API_BASE_URL, token, 1, search);
  };

  const loadMore = () => {
    if (acknowledgements.length < total && !loading) {
      fetchAcknowledgements(API_BASE_URL, token, page + 1, search);
    }
  };

  const openAckDetails = async (ackId: number) => {
    setDetailLoading(true);
    setDetailModalVisible(true);
    try {
      const res = await axios.get(`${API_BASE_URL}/api/v1/indent/material-acknowledgements/${ackId}`, {
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

  const fetchPendingIssues = async (apiBase: string, authToken: string) => {
    try {
      const res = await axios.get(`${apiBase}/api/v1/warehouse/vehicle-issues`, {
        headers: { Authorization: `Bearer ${authToken}` },
        params: { page_size: 100, status: 'issued' },
      });
      const data = res.data.items || res.data.data || res.data || [];
      setPendingIssues(data);
    } catch (e) {
      console.error(e);
    }
  };

  const openNewForm = () => {
    setSelectedIssueId('');
    setSelectedIssueDetail(null);
    setOverallRemarks('');
    setAckItems([]);
    setOverallPhotos([]);
    setIssueSearch('');
    setFormModalVisible(true);
    fetchPendingIssues(API_BASE_URL, token);
  };

  const handleSelectIssue = async (issueId: string) => {
    setSelectedIssueId(issueId);
    if (!issueId) {
      setAckItems([]);
      setSelectedIssueDetail(null);
      return;
    }

    setLoadingIssueDetail(true);
    try {
      const detailRes = await axios.get(`${API_BASE_URL}/api/v1/warehouse/vehicle-issues/${issueId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const issue = detailRes.data;
      setSelectedIssueDetail(issue);

      const formatted = (issue.items || []).map((item: any) => {
        const serials = Array.isArray(item.serial_numbers) ? item.serial_numbers : [];
        return {
          id: item.id,
          item_id: item.item_id,
          item_code: item.item_code || item.item?.item_code || '',
          item_name: item.item_name || item.item?.name || '',
          item_type: item.item_type || item.item?.item_type || '',
          uom_name: item.uom_name || item.uom?.name || '',
          issued_qty: Number(item.qty || 0),
          received_qty: String(item.qty || 0),
          remarks: '',
          has_serial: item.has_serial || false,
          serial_numbers: [...serials],
          serial_text: serials.join(', '),
          photos: [] as string[],
        };
      });

      setAckItems(formatted);
    } catch (e) {
      console.error(e);
      Alert.alert('Error', 'Failed to retrieve selected vehicle issue items.');
    } finally {
      setLoadingIssueDetail(false);
    }
  };

  const handleReceiveAll = () => {
    setAckItems((prev) =>
      prev.map((item) => ({ ...item, received_qty: String(item.issued_qty) }))
    );
  };

  // ─── Photo Helpers ─────────────────────────────────────────────────────────
  const uploadPhotoToServer = async (uri: string): Promise<string | null> => {
    try {
      const filename = uri.split('/').pop() || 'photo.jpg';
      const ext = filename.split('.').pop()?.toLowerCase() || 'jpg';
      const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

      const formData = new FormData();
      formData.append('file', { uri, name: filename, type: mimeType } as any);

      const res = await axios.post(`${API_BASE_URL}/api/v1/indent/upload-photo`, formData, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'multipart/form-data',
        },
      });
      return res.data.url as string;
    } catch (e: any) {
      console.error('Photo upload error:', e?.response?.data || e?.message);
      return null;
    }
  };

  const pickPhoto = async (isItemWise: boolean, itemIndex?: number) => {
    const permResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permResult.granted) {
      Alert.alert('Permission Required', 'Please allow access to your photo library to upload photos.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.8,
    });

    if (result.canceled || !result.assets?.length) return;

    const uri = result.assets[0].uri;
    setUploadingPhoto(true);
    try {
      const url = await uploadPhotoToServer(uri);
      if (!url) {
        Alert.alert('Upload Failed', 'Could not upload photo. Please check your connection and try again.');
        return;
      }
      if (isItemWise && itemIndex !== undefined) {
        setAckItems((prev) =>
          prev.map((it, i) =>
            i === itemIndex ? { ...it, photos: [...(it.photos || []), url] } : it
          )
        );
      } else {
        setOverallPhotos((prev) => [...prev, { uri, url }]);
      }
    } finally {
      setUploadingPhoto(false);
    }
  };

  const takePhoto = async (isItemWise: boolean, itemIndex?: number) => {
    const permResult = await ImagePicker.requestCameraPermissionsAsync();
    if (!permResult.granted) {
      Alert.alert('Permission Required', 'Please allow camera access to take photos.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      quality: 0.8,
    });

    if (result.canceled || !result.assets?.length) return;

    const uri = result.assets[0].uri;
    setUploadingPhoto(true);
    try {
      const url = await uploadPhotoToServer(uri);
      if (!url) {
        Alert.alert('Upload Failed', 'Could not upload photo. Please try again.');
        return;
      }
      if (isItemWise && itemIndex !== undefined) {
        setAckItems((prev) =>
          prev.map((it, i) =>
            i === itemIndex ? { ...it, photos: [...(it.photos || []), url] } : it
          )
        );
      } else {
        setOverallPhotos((prev) => [...prev, { uri, url }]);
      }
    } finally {
      setUploadingPhoto(false);
    }
  };

  const showPhotoOptions = (isItemWise: boolean, itemIndex?: number) => {
    Alert.alert(
      'Add Photo',
      'Choose a method to add a photo',
      [
        { text: 'Take Photo', onPress: () => takePhoto(isItemWise, itemIndex) },
        { text: 'Choose from Library', onPress: () => pickPhoto(isItemWise, itemIndex) },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  // ─── Submit ────────────────────────────────────────────────────────────────
  const handleSubmitAcknowledgement = async () => {
    if (!selectedIssueId) {
      Alert.alert('Validation Error', 'Please select a vehicle material issue.');
      return;
    }
    if (!employeeCode.trim()) {
      Alert.alert('Validation Error', 'Please enter your Employee Code.');
      return;
    }

    const payloadItems = [];
    for (const item of ackItems) {
      const recv = parseFloat(item.received_qty || '0');
      if (isNaN(recv) || recv < 0) {
        Alert.alert('Validation Error', `Invalid quantity entered for item ${item.item_name}`);
        return;
      }
      if (recv > item.issued_qty) {
        Alert.alert(
          'Validation Error',
          `Received quantity (${recv}) cannot exceed issued quantity (${item.issued_qty}) for item ${item.item_name}`
        );
        return;
      }

      let serials: string[] = [];
      if (item.serial_text && item.serial_text.trim()) {
        serials = item.serial_text
          .split(',')
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0);
      } else if (item.serial_numbers) {
        serials = item.serial_numbers;
      }

      payloadItems.push({
        item_id: item.item_id,
        received_qty: recv,
        remarks: item.remarks || '',
        serial_numbers: serials.length > 0 ? serials : null,
        photos: item.photos || [],
      });
    }

    if (payloadItems.length === 0) {
      Alert.alert('Validation Error', 'At least one item is required for acknowledgement.');
      return;
    }

    setFormLoading(true);
    try {
      const payload = {
        vehicle_issue_id: parseInt(selectedIssueId),
        employee_code: employeeCode.trim(),
        remarks: overallRemarks,
        photos: overallPhotos.map((p) => p.url),
        items: payloadItems,
      };

      await axios.post(`${API_BASE_URL}/api/v1/indent/material-acknowledgements`, payload, {
        headers: { Authorization: `Bearer ${token}` },
      });

      Alert.alert('Success', 'Vehicle Material Acknowledgement recorded successfully!');
      setFormModalVisible(false);
      handleRefresh();
    } catch (err: any) {
      const errMsg = err.response?.data?.detail || 'Failed to submit material acknowledgement.';
      Alert.alert('Submission Failed', errMsg);
    } finally {
      setFormLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <LinearGradient
        colors={['#481238', '#3A0F40', '#481238']}
        style={styles.header}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
      >
        <View style={styles.headerTop}>
          <TouchableOpacity
            style={styles.headerButton}
            onPress={() => router.replace('/acknowledgement-selector')}
          >
            <Icon name="arrow-left" size={20} color="#FFFFFF" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Vehicle Acknowledgements</Text>
          <TouchableOpacity style={styles.headerButton} onPress={openNewForm}>
            <Icon name="plus" size={20} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </LinearGradient>

      {/* Search Bar */}
      <View style={styles.searchBarContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search by issue or ack number..."
          placeholderTextColor="#94A3B8"
          value={search}
          onChangeText={(val) => {
            setSearch(val);
            fetchAcknowledgements(API_BASE_URL, token, 1, val);
          }}
        />
      </View>

      {/* List */}
      {loading && page === 1 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#481238" />
          <Text style={styles.loadingText}>Loading vehicle acknowledgements...</Text>
        </View>
      ) : acknowledgements.length === 0 ? (
        <ScrollView
          contentContainerStyle={styles.emptyContainer}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        >
          <Icon name="truck" size={48} color="#CBD5E1" />
          <Text style={styles.emptyText}>No vehicle material acknowledgements found</Text>
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
            const dateStr = item.acknowledged_at ? new Date(item.acknowledged_at).toLocaleDateString() : '-';

            return (
              <TouchableOpacity
                style={styles.card}
                activeOpacity={0.7}
                onPress={() => openAckDetails(item.id)}
              >
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>
                    {item.acknowledgement_number || `Ack #${item.id}`}
                  </Text>
                  <View style={[styles.statusTag, { backgroundColor: '#DBEAFE' }]}>
                    <Text style={[styles.statusText, { color: '#1E40AF' }]}>
                      {item.status?.toUpperCase() || 'ACKNOWLEDGED'}
                    </Text>
                  </View>
                </View>

                <View style={styles.cardDetails}>
                  <View style={styles.detailRow}>
                    <Icon name="truck" size={14} color="#D97706" />
                    <Text style={styles.detailText}>Issue #: {item.vehicle_issue_number || '-'}</Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Icon name="calendar" size={14} color="#D97706" />
                    <Text style={styles.detailText}>Date: {dateStr}</Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Icon name="user" size={14} color="#D97706" />
                    <Text style={styles.detailText}>By: {item.acknowledged_by_name || '-'}</Text>
                  </View>
                </View>

                <View style={styles.cardFooter}>
                  <Text style={styles.cardFooterType}>
                    Vehicle: {item.vehicle_code || '-'} ({item.vehicle_number || '-'})
                  </Text>
                  <Icon name="chevron-right" size={16} color="#D97706" />
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}

      {/* ─── Detail Modal ─────────────────────────────────────────────────────── */}
      <Modal
        visible={detailModalVisible}
        animationType="slide"
        onRequestClose={() => setDetailModalVisible(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setDetailModalVisible(false)}>
              <Icon name="arrow-left" size={20} color="#334155" />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Vehicle Ack Details</Text>
            <View style={{ width: 20 }} />
          </View>

          {detailLoading || !selectedAck ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#481238" />
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.modalScroll}>
              <View style={styles.infoCard}>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Ack Number</Text>
                  <Text style={styles.infoValue}>{selectedAck.acknowledgement_number || '-'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Vehicle Issue #</Text>
                  <Text style={styles.infoValue}>{selectedAck.vehicle_issue_number || '-'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Vehicle</Text>
                  <Text style={styles.infoValue}>
                    {selectedAck.vehicle_code || '-'} ({selectedAck.vehicle_number || '-'})
                  </Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Warehouse</Text>
                  <Text style={styles.infoValue}>{selectedAck.warehouse_name || '-'}</Text>
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
                  <Text style={styles.infoLabel}>Date & Time</Text>
                  <Text style={styles.infoValue}>
                    {selectedAck.acknowledged_at ? new Date(selectedAck.acknowledged_at).toLocaleString() : '-'}
                  </Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Remarks</Text>
                  <Text style={styles.infoValue}>{selectedAck.remarks || '-'}</Text>
                </View>
              </View>

              {/* Overall Photos */}
              {selectedAck.photos && selectedAck.photos.length > 0 && (
                <View style={[styles.infoCard, { marginBottom: 16 }]}>
                  <Text style={[styles.infoLabel, { marginBottom: 8, fontWeight: '700', color: '#334155' }]}>
                    📷 Acknowledgement Photos
                  </Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={{ flexDirection: 'row' }}>
                      {selectedAck.photos.map((url: string, idx: number) => (
                        <Image
                          key={idx}
                          source={{ uri: url.startsWith('http') ? url : `${API_BASE_URL}${url}` }}
                          style={[styles.photoThumb, { marginRight: 8 }]}
                        />
                      ))}
                    </View>
                  </ScrollView>
                </View>
              )}

              <Text style={styles.sectionHeading}>Items Received</Text>
              {(selectedAck.items || []).map((item: any, idx: number) => (
                <View key={item.id || idx} style={styles.detailItemCard}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.itemName}>{item.item_name || item.item_code || '-'}</Text>
                      <Text style={styles.itemMeta}>Code: {item.item_code || '-'}</Text>
                      {item.remarks ? <Text style={styles.itemRemarks}>Remarks: {item.remarks}</Text> : null}
                      {item.serial_numbers && item.serial_numbers.length > 0 ? (
                        <Text style={styles.itemRemarks}>Serials: {item.serial_numbers.join(', ')}</Text>
                      ) : null}
                    </View>
                    <View style={styles.itemQtyContainer}>
                      <Text style={[styles.qtyLabel, { fontWeight: 'bold', color: '#10B981', fontSize: 14 }]}>
                        Recv: {item.received_qty}
                      </Text>
                    </View>
                  </View>
                  {/* Item Photos */}
                  {item.photos && item.photos.length > 0 && (
                    <View style={{ marginTop: 8 }}>
                      <Text style={[styles.itemMeta, { fontWeight: '700', marginBottom: 4 }]}>Item Photos:</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        <View style={{ flexDirection: 'row' }}>
                          {item.photos.map((url: string, pIdx: number) => (
                            <Image
                              key={pIdx}
                              source={{ uri: url.startsWith('http') ? url : `${API_BASE_URL}${url}` }}
                              style={[styles.photoThumb, { marginRight: 6 }]}
                            />
                          ))}
                        </View>
                      </ScrollView>
                    </View>
                  )}
                </View>
              ))}
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>

      {/* ─── Form Modal ───────────────────────────────────────────────────────── */}
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
            <Text style={styles.modalTitle}>Record Vehicle Receipt</Text>
            <View style={{ width: 20 }} />
          </View>

          {formLoading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#481238" />
              <Text style={styles.loadingText}>Saving vehicle acknowledgement...</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.modalScroll}>
              <Text style={styles.fieldLabel}>Select Issued Vehicle Material *</Text>
              <TouchableOpacity
                style={styles.dropdownBtn}
                onPress={() => setIssuePickerVisible(true)}
                activeOpacity={0.7}
              >
                <Text style={selectedIssueId ? styles.dropdownBtnText : styles.dropdownBtnPlaceholder} numberOfLines={1}>
                  {selectedIssueId
                    ? (pendingIssues.find((i: any) => i.id.toString() === selectedIssueId)?.issue_number || 'Selected')
                    : 'Select issued vehicle issue...'}
                </Text>
                <Icon name="chevron-right" size={16} color="#94A3B8" />
              </TouchableOpacity>

              {/* Issue Picker Modal */}
              <Modal
                visible={issuePickerVisible}
                animationType="slide"
                transparent
                onRequestClose={() => setIssuePickerVisible(false)}
              >
                <View style={styles.pickerOverlay}>
                  <View style={styles.pickerSheet}>
                    <View style={styles.pickerSheetHeader}>
                      <Text style={styles.pickerSheetTitle}>Select Issued Vehicle Issue</Text>
                      <TouchableOpacity onPress={() => setIssuePickerVisible(false)}>
                        <Icon name="x" size={20} color="#334155" />
                      </TouchableOpacity>
                    </View>
                    <TextInput
                      style={styles.pickerSearch}
                      placeholder="Search issue or vehicle number..."
                      placeholderTextColor="#94A3B8"
                      value={issueSearch}
                      onChangeText={setIssueSearch}
                    />
                    <FlatList
                      data={pendingIssues.filter((i: any) =>
                        !issueSearch ||
                        i.issue_number?.toLowerCase().includes(issueSearch.toLowerCase()) ||
                        i.vehicle_number?.toLowerCase().includes(issueSearch.toLowerCase())
                      )}
                      keyExtractor={(item: any) => item.id.toString()}
                      style={{ maxHeight: 360 }}
                      ListEmptyComponent={
                        <Text style={{ textAlign: 'center', color: '#94A3B8', padding: 24 }}>No pending vehicle issues found</Text>
                      }
                      renderItem={({ item }: { item: any }) => (
                        <TouchableOpacity
                          style={[
                            styles.pickerItem,
                            selectedIssueId === item.id.toString() && styles.pickerItemActive,
                          ]}
                          onPress={() => {
                            handleSelectIssue(item.id.toString());
                            setIssuePickerVisible(false);
                            setIssueSearch('');
                          }}
                        >
                          <Text style={[
                            styles.pickerItemText,
                            selectedIssueId === item.id.toString() && styles.pickerItemTextActive,
                          ]}>
                            {item.issue_number}
                          </Text>
                          <Text style={styles.pickerItemSub}>
                            Vehicle: {item.vehicle_code} ({item.vehicle_number}) · {item.warehouse_name || ''}
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

              <Text style={styles.fieldLabel}>Overall Remarks</Text>
              <TextInput
                style={[styles.formInput, { height: 60 }]}
                placeholder="Overall receipt comments..."
                multiline
                value={overallRemarks}
                onChangeText={setOverallRemarks}
              />

              {/* Vehicle Issue Details Header */}
              {selectedIssueDetail && (
                <View style={styles.infoCard}>
                  <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>Vehicle Code</Text>
                    <Text style={styles.infoValue}>{selectedIssueDetail.vehicle_code || '-'}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>Vehicle Number</Text>
                    <Text style={styles.infoValue}>{selectedIssueDetail.vehicle_number || '-'}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>Warehouse</Text>
                    <Text style={styles.infoValue}>{selectedIssueDetail.warehouse_name || '-'}</Text>
                  </View>
                </View>
              )}

              {loadingIssueDetail ? (
                <View style={{ padding: 32, alignItems: 'center' }}>
                  <ActivityIndicator color="#481238" />
                  <Text style={styles.loadingText}>Loading items...</Text>
                </View>
              ) : ackItems.length > 0 ? (
                <View style={{ marginTop: 12 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <Text style={styles.sectionHeading}>Confirm Items Received</Text>
                    <TouchableOpacity onPress={handleReceiveAll} style={styles.receiveAllBtn}>
                      <Text style={styles.receiveAllText}>Receive All</Text>
                    </TouchableOpacity>
                  </View>

                  {ackItems.map((item, idx) => (
                    <View key={item.id || idx} style={styles.formItemCard}>
                      <Text style={styles.formItemTitle}>
                        {item.item_name} ({item.item_code})
                      </Text>
                      <Text style={styles.formItemSub}>
                        Issued Qty: {item.issued_qty} {item.uom_name}
                      </Text>

                      <Text style={[styles.fieldLabel, { marginTop: 8 }]}>Received Qty *</Text>
                      <TextInput
                        style={styles.formInput}
                        keyboardType="numeric"
                        value={item.received_qty}
                        onChangeText={(text) => {
                          setAckItems((prev) =>
                            prev.map((it, i) => (i === idx ? { ...it, received_qty: text } : it))
                          );
                        }}
                      />

                      {(item.has_serial || item.item_type === 'asset' || item.item_type === 'consumable' || (item.serial_numbers && item.serial_numbers.length > 0)) && (
                        <View style={{ marginTop: 8, marginBottom: 8, padding: 8, backgroundColor: '#F1F5F9', borderRadius: 8 }}>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                            <Text style={{ fontSize: 12, fontWeight: '700', color: '#1E293B' }}>
                              Asset / Consumable / Serial Codes (Auto-selected)
                            </Text>
                            <View style={{ backgroundColor: '#DBEAFE', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10 }}>
                              <Text style={{ fontSize: 10, color: '#1D4ED8', fontWeight: 'bold' }}>
                                {item.serial_numbers ? item.serial_numbers.length : 0} Selected
                              </Text>
                            </View>
                          </View>
                          {item.serial_numbers && item.serial_numbers.length > 0 ? (
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                              {item.serial_numbers.map((code: string, cIdx: number) => (
                                <View key={cIdx} style={{ backgroundColor: '#E0E7FF', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12 }}>
                                  <Text style={{ fontSize: 11, color: '#3730A3', fontWeight: '600' }}>{code}</Text>
                                </View>
                              ))}
                            </View>
                          ) : null}
                          <Text style={[styles.fieldLabel, { marginTop: 6, fontSize: 11 }]}>Edit Selected Codes (comma-separated)</Text>
                          <TextInput
                            style={[styles.formInput, { fontSize: 12, height: 36 }]}
                            placeholder="Code1, Code2..."
                            value={item.serial_text}
                            onChangeText={(text) => {
                              const parsedArr = text.split(',').map((s) => s.trim()).filter(Boolean);
                              setAckItems((prev) =>
                                prev.map((it, i) =>
                                  i === idx ? { ...it, serial_text: text, serial_numbers: parsedArr } : it
                                )
                              );
                            }}
                          />
                        </View>
                      )}

                      {/* Item-wise Photos */}
                      <Text style={[styles.fieldLabel, { marginTop: 4 }]}>Item Photos</Text>
                      <View style={styles.photoRow}>
                        <TouchableOpacity
                          style={styles.photoAddBtn}
                          onPress={() => showPhotoOptions(true, idx)}
                          disabled={uploadingPhoto}
                        >
                          {uploadingPhoto ? (
                            <ActivityIndicator size="small" color="#481238" />
                          ) : (
                            <>
                              <Icon name="camera" size={14} color="#481238" />
                              <Text style={styles.photoAddBtnText}>Add Photo</Text>
                            </>
                          )}
                        </TouchableOpacity>
                        {(item.photos || []).map((url: string, pIdx: number) => (
                          <PhotoThumb
                            key={pIdx}
                            url={url}
                            onRemove={() =>
                              setAckItems((prev) =>
                                prev.map((it, i) =>
                                  i === idx
                                    ? { ...it, photos: (it.photos || []).filter((_: string, pi: number) => pi !== pIdx) }
                                    : it
                                )
                              )
                            }
                          />
                        ))}
                      </View>

                      <Text style={[styles.fieldLabel, { marginTop: 4 }]}>Line Remarks</Text>
                      <TextInput
                        style={styles.formInput}
                        placeholder="Item condition / notes..."
                        value={item.remarks}
                        onChangeText={(text) => {
                          setAckItems((prev) =>
                            prev.map((it, i) => (i === idx ? { ...it, remarks: text } : it))
                          );
                        }}
                      />
                    </View>
                  ))}

                  {/* ─── Overall Proof Photos ─────────────────────────────────── */}
                  <View style={styles.overallPhotoSection}>
                    <Text style={styles.sectionHeading}>📎 Overall Receipt Photos</Text>
                    <Text style={styles.overallPhotoHint}>
                      Attach receipt copy, vehicle photo, or handover evidence
                    </Text>
                    <View style={styles.photoRow}>
                      <TouchableOpacity
                        style={styles.photoAddBtn}
                        onPress={() => showPhotoOptions(false)}
                        disabled={uploadingPhoto}
                      >
                        {uploadingPhoto ? (
                          <ActivityIndicator size="small" color="#481238" />
                        ) : (
                          <>
                            <Icon name="image" size={14} color="#481238" />
                            <Text style={styles.photoAddBtnText}>Add Photo</Text>
                          </>
                        )}
                      </TouchableOpacity>
                      {overallPhotos.map((photo, pIdx) => (
                        <PhotoThumb
                          key={pIdx}
                          url={photo.url}
                          onRemove={() =>
                            setOverallPhotos((prev) => prev.filter((_, i) => i !== pIdx))
                          }
                        />
                      ))}
                    </View>
                  </View>

                  <TouchableOpacity
                    style={[styles.submitBtn, { marginTop: 20 }]}
                    onPress={handleSubmitAcknowledgement}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.submitBtnText}>Submit Acknowledgement</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
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
    backgroundColor: '#F6F2F0',
  },
  header: {
    paddingTop: Platform.OS === 'ios' ? 0 : 12,
    paddingBottom: 12,
  },
  headerTop: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  headerButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBarContainer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  searchInput: {
    height: 40,
    backgroundColor: '#F1F5F9',
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 13,
    color: '#0F172A',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#64748B',
  },
  emptyContainer: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 12,
    marginBottom: 16,
  },
  emptyButton: {
    backgroundColor: '#481238',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  emptyButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  listContent: {
    padding: 16,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0F172A',
  },
  statusTag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '800',
  },
  cardDetails: {
    gap: 6,
    marginBottom: 12,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
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
  modalContainer: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  modalHeader: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0F172A',
  },
  modalScroll: {
    padding: 16,
  },
  infoCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    gap: 8,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  infoLabel: {
    fontSize: 13,
    color: '#64748B',
  },
  infoValue: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0F172A',
  },
  sectionHeading: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 8,
  },
  detailItemCard: {
    backgroundColor: '#FFFFFF',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    marginBottom: 8,
  },
  itemName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F172A',
  },
  itemMeta: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
  },
  itemRemarks: {
    fontSize: 11,
    color: '#D97706',
    marginTop: 2,
  },
  itemQtyContainer: {
    alignItems: 'flex-end',
  },
  qtyLabel: {
    fontSize: 12,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 6,
  },
  formInput: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: '#0F172A',
    marginBottom: 12,
  },
  dropdownBtn: {
    height: 44,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 8,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  dropdownBtnText: {
    fontSize: 14,
    color: '#0F172A',
    fontWeight: '600',
  },
  dropdownBtnPlaceholder: {
    fontSize: 14,
    color: '#94A3B8',
  },
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
  },
  pickerSheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  pickerSheetTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0F172A',
  },
  pickerSearch: {
    height: 40,
    backgroundColor: '#F1F5F9',
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 13,
    marginBottom: 12,
  },
  pickerItem: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  pickerItemActive: {
    backgroundColor: '#F0E8F8',
  },
  pickerItemText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F172A',
  },
  pickerItemTextActive: {
    color: '#481238',
  },
  pickerItemSub: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
  },
  receiveAllBtn: {
    backgroundColor: '#E0F2FE',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 6,
  },
  receiveAllText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0369A1',
  },
  formItemCard: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  formItemTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#0F172A',
  },
  formItemSub: {
    fontSize: 12,
    color: '#64748B',
    marginBottom: 8,
  },
  submitBtn: {
    height: 48,
    backgroundColor: '#481238',
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  submitBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  // Photo styles
  photoRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    marginBottom: 12,
  },
  photoAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F0E8F8',
    borderWidth: 1.5,
    borderColor: '#481238',
    borderStyle: 'dashed',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginRight: 8,
    marginBottom: 8,
    minWidth: 96,
    justifyContent: 'center',
  },
  photoAddBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#481238',
  },
  photoThumb: {
    width: 72,
    height: 72,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  photoRemoveBtn: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#EF4444',
    alignItems: 'center',
    justifyContent: 'center',
  },
  overallPhotoSection: {
    backgroundColor: '#FFF7F0',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#FED7AA',
    marginTop: 8,
    marginBottom: 8,
  },
  overallPhotoHint: {
    fontSize: 12,
    color: '#92400E',
    marginBottom: 10,
    fontStyle: 'italic',
  },
});
