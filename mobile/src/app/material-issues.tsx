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
import { CameraView, useCameraPermissions } from 'expo-camera';

// ─── Custom Vector Icons ─────────────────────────────────────────────────────
const Icon = ({ name, size = 18, color = '#7A6D66' }: { name: string; size?: number; color?: string }) => {
  const s = size;
  if (name === 'camera') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.75, height: s * 0.55, borderWidth: 1.8, borderColor: color, borderRadius: 3, marginTop: 2 }} />
        <View style={{ position: 'absolute', top: 1, width: s * 0.3, height: 2, backgroundColor: color, borderRadius: 1 }} />
        <View style={{ position: 'absolute', width: s * 0.25, height: s * 0.25, borderRadius: s * 0.125, borderWidth: 1.5, borderColor: color, top: s * 0.32 }} />
      </View>
    );
  }
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
  if (name === 'trash-2') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.6, height: s * 0.65, borderWidth: 1.8, borderColor: color, borderRadius: 2 }} />
        <View style={{ position: 'absolute', top: 1, width: s * 0.75, height: 1.8, backgroundColor: color }} />
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

// ─── Searchable Dropdown Select Component ─────────────────────────────────────
const SearchableDropdownSelect = ({
  label,
  value,
  onValueChange,
  items,
  placeholder = 'Select an option',
  allowClear = false,
}: {
  label: string;
  value: string;
  onValueChange: (val: string) => void;
  items: { label: string; value: string; subLabel?: string }[];
  placeholder?: string;
  allowClear?: boolean;
}) => {
  const [modalVisible, setModalVisible] = useState(false);
  const [searchText, setSearchText] = useState('');

  const selectedItem = items.find((item) => item.value === value);

  const filteredItems = items.filter(
    (item) =>
      !searchText ||
      item.label.toLowerCase().includes(searchText.toLowerCase()) ||
      (item.subLabel && item.subLabel.toLowerCase().includes(searchText.toLowerCase()))
  );

  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TouchableOpacity
        style={styles.dropdownTrigger}
        onPress={() => {
          setSearchText('');
          setModalVisible(true);
        }}
      >
        <Text style={[styles.dropdownTriggerText, !selectedItem && { color: '#94A3B8' }]} numberOfLines={1}>
          {selectedItem ? selectedItem.label : placeholder}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {allowClear && value ? (
            <TouchableOpacity
              onPress={(e) => {
                e.stopPropagation();
                onValueChange('');
              }}
              style={{ padding: 4 }}
            >
              <Icon name="x" size={14} color="#94A3B8" />
            </TouchableOpacity>
          ) : null}
          <View style={styles.dropdownArrow} />
        </View>
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
              <Text style={styles.dropdownModalTitle}>{label.replace(' *', '')}</Text>
              <TouchableOpacity onPress={() => setModalVisible(false)} style={styles.dropdownCloseBtn}>
                <Text style={styles.dropdownCloseBtnText}>Close</Text>
              </TouchableOpacity>
            </View>

            <View style={{ paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 }}>
              <TextInput
                style={styles.dropdownSearchInput}
                placeholder={`Search ${label.replace(' *', '').toLowerCase()}...`}
                placeholderTextColor="#94A3B8"
                value={searchText}
                onChangeText={setSearchText}
                autoCapitalize="none"
              />
            </View>

            <FlatList
              data={filteredItems}
              keyExtractor={(item, index) => item.value || String(index)}
              style={{ maxHeight: 300 }}
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
                  <View style={{ flex: 1 }}>
                    <Text style={[
                      styles.dropdownItemText,
                      item.value === value && styles.dropdownItemTextActive,
                    ]}>
                      {item.label}
                    </Text>
                    {item.subLabel ? (
                      <Text style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>
                        {item.subLabel}
                      </Text>
                    ) : null}
                  </View>
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <View style={{ padding: 16, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, color: '#94A3B8' }}>No matches found</Text>
                </View>
              }
            />
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
};

// ─── Asset / Consumable / Serial Codes Selection Modal ───────────────────────
const AssetCodesTreeModal = ({
  visible,
  onClose,
  onSave,
  itemName = '',
  itemCode = '',
  itemType = 'asset',
  targetQty = 0,
  selectedCodes = [],
  rawRows = [],
  batchId = null,
  binId = null,
}: {
  visible: boolean;
  onClose: () => void;
  onSave: (selected: string[]) => void;
  itemName: string;
  itemCode: string;
  itemType: string;
  targetQty: number;
  selectedCodes: string[];
  rawRows: any[];
  batchId?: any;
  binId?: any;
}) => {
  const [selected, setSelected] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [scannerVisible, setScannerVisible] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [scannedLock, setScannedLock] = useState(false);

  const isAsset = itemType === 'asset';
  const isConsumable = itemType === 'consumable';

  useEffect(() => {
    if (visible) {
      setSelected(selectedCodes || []);
      setSearchQuery('');
      setScannerVisible(false);
      setScannedLock(false);
    }
  }, [visible, selectedCodes]);

  const allCodesWithMetadata = React.useMemo(() => {
    const list: any[] = [];
    const filteredRows = (rawRows || []).filter((row) => {
      if (batchId !== null && batchId !== undefined && batchId !== '') {
        if (String(row.batch_id) !== String(batchId)) return false;
      }
      if (binId !== null && binId !== undefined && binId !== '') {
        if (String(row.bin_id) !== String(binId)) return false;
      }
      return true;
    });

    filteredRows.forEach((row) => {
      const locName = row.location || 'Main Area';
      const binName = row.bin_code || row.bin_name || 'No Bin';
      const batchName = row.batch_number || row.batch_name || 'No Batch';
      const expiry = row.expiry_date ? new Date(row.expiry_date).toLocaleDateString() : null;

      let codes: string[] = [];
      if (isAsset && row.asset_codes && row.asset_codes.length > 0) {
        codes = row.asset_codes;
      } else if (isConsumable && row.consumable_codes && row.consumable_codes.length > 0) {
        codes = row.consumable_codes;
      } else if (row.serial_numbers && row.serial_numbers.length > 0) {
        codes = row.serial_numbers;
      }

      codes.forEach((code) => {
        list.push({
          code,
          location: locName,
          bin: binName,
          batch: batchName,
          expiry,
        });
      });
    });
    return list;
  }, [rawRows, batchId, binId, isAsset, isConsumable]);

  const filteredCodes = React.useMemo(() => {
    return allCodesWithMetadata.filter((c) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase();
      return (
        c.code.toLowerCase().includes(q) ||
        c.batch.toLowerCase().includes(q) ||
        c.bin.toLowerCase().includes(q)
      );
    });
  }, [allCodesWithMetadata, searchQuery]);

  const toggleCode = (code: string) => {
    setSelected((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  };

  const handleOpenScanner = async () => {
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) {
        Alert.alert('Camera Permission Required', 'Please grant camera access to scan QR codes and barcodes.');
        return;
      }
    }
    setScannedLock(false);
    setScannerVisible(true);
  };

  const handleBarcodeScanned = ({ data }: { type: string; data: string }) => {
    if (scannedLock) return;
    const scannedText = (data || '').trim();
    if (!scannedText) return;

    setScannedLock(true);

    const matched = allCodesWithMetadata.find(
      (c) => c.code.trim().toLowerCase() === scannedText.toLowerCase() || scannedText.toLowerCase().includes(c.code.trim().toLowerCase())
    );

    if (matched) {
      if (selected.includes(matched.code)) {
        Alert.alert('Already Selected ℹ️', `Code "${matched.code}" is already selected.`, [
          { text: 'Scan Next', onPress: () => setScannedLock(false) },
          { text: 'Done', onPress: () => setScannerVisible(false) },
        ]);
      } else {
        setSelected((prev) => [...prev, matched.code]);
        Alert.alert('Code Scanned! ✅', `Selected: ${matched.code}\n📍 ${matched.location} · Bin: ${matched.bin}`, [
          { text: 'Scan Next', onPress: () => setScannedLock(false) },
          { text: 'Done', onPress: () => setScannerVisible(false) },
        ]);
      }
    } else {
      Alert.alert(
        'Code Not Found ❌',
        `Scanned: "${scannedText}"\nNo matching ${isAsset ? 'asset' : isConsumable ? 'consumable' : 'serial'} code found in current warehouse stock.`,
        [
          { text: 'Try Again', onPress: () => setScannedLock(false) },
          { text: 'Close Scanner', onPress: () => setScannerVisible(false) },
        ]
      );
    }
  };

  const titleText = isAsset ? 'Select Asset Codes' : isConsumable ? 'Select Consumable Codes' : 'Select Serial Numbers';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#F8FAFC' }}>
        {/* Modal Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#E2E8F0' }}>
          <TouchableOpacity onPress={onClose} style={{ padding: 4 }}>
            <Icon name="x" size={22} color="#334155" />
          </TouchableOpacity>
          <View style={{ flex: 1, marginHorizontal: 10, alignItems: 'center' }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: '#0F172A' }} numberOfLines={1}>{titleText}</Text>
            <Text style={{ fontSize: 11, color: '#64748B', marginTop: 1 }} numberOfLines={1}>{itemName} ({itemCode})</Text>
          </View>
          <TouchableOpacity
            style={{ backgroundColor: selected.length === targetQty ? '#10B981' : '#4F46E5', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, flexShrink: 0 }}
            onPress={() => {
              onSave(selected);
              onClose();
            }}
          >
            <Text style={{ color: '#FFFFFF', fontWeight: '700', fontSize: 12 }}>Apply ({selected.length})</Text>
          </TouchableOpacity>
        </View>

        {/* Required Qty Info Bar */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#EFF6FF', borderBottomWidth: 1, borderBottomColor: '#DBEAFE' }}>
          <Text style={{ fontSize: 12, color: '#1E40AF', fontWeight: '600' }}>
            Required Qty: {targetQty}
          </Text>
          <Text style={{ fontSize: 12, color: selected.length === targetQty ? '#059669' : '#D97706', fontWeight: '700' }}>
            Selected: {selected.length} / {targetQty}
          </Text>
        </View>

        {/* Search & Camera Scanner trigger */}
        <View style={{ padding: 12, backgroundColor: '#FFFFFF', flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <TextInput
            style={{ flex: 1, height: 42, backgroundColor: '#F1F5F9', borderRadius: 8, paddingHorizontal: 12, fontSize: 13, color: '#0F172A' }}
            placeholder="Search code, batch, or bin..."
            placeholderTextColor="#94A3B8"
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          <TouchableOpacity
            style={{
              backgroundColor: '#0F766E',
              paddingHorizontal: 12,
              height: 42,
              borderRadius: 8,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
            }}
            onPress={handleOpenScanner}
          >
            <Icon name="camera" size={16} color="#FFFFFF" />
            <Text style={{ color: '#FFFFFF', fontWeight: '700', fontSize: 12 }}>Scan Code</Text>
          </TouchableOpacity>
        </View>

        {/* Codes List */}
        <FlatList
          data={filteredCodes}
          keyExtractor={(item) => item.code}
          contentContainerStyle={{ padding: 12 }}
          renderItem={({ item }) => {
            const isChecked = selected.includes(item.code);

            return (
              <TouchableOpacity
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  padding: 12,
                  marginBottom: 8,
                  borderRadius: 10,
                  backgroundColor: isChecked ? '#F0F9FF' : '#FFFFFF',
                  borderWidth: isChecked ? 2 : 1,
                  borderColor: isChecked ? '#0284C7' : '#E2E8F0',
                }}
                onPress={() => toggleCode(item.code)}
              >
                <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: isChecked ? '#0284C7' : '#94A3B8', backgroundColor: isChecked ? '#0284C7' : 'transparent', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                  {isChecked && <Text style={{ color: '#FFF', fontSize: 12, fontWeight: '900' }}>✓</Text>}
                </View>

                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', color: '#0F172A' }}>
                    {item.code}
                  </Text>
                  <Text style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>
                    📍 {item.location} · Bin: {item.bin} · Batch: {item.batch}
                  </Text>
                  {item.expiry && (
                    <Text style={{ fontSize: 10, color: '#DC2626', marginTop: 1 }}>⌛ Exp: {item.expiry}</Text>
                  )}
                </View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={{ padding: 32, alignItems: 'center' }}>
              <Text style={{ fontSize: 13, color: '#94A3B8', textAlign: 'center' }}>
                No stock codes found for this item in selected warehouse.
              </Text>
            </View>
          }
        />

        {/* Sticky Bottom Action Bar */}
        <View style={{ padding: 12, backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: '#E2E8F0' }}>
          <TouchableOpacity
            style={{ backgroundColor: selected.length === targetQty ? '#10B981' : '#4F46E5', paddingVertical: 13, borderRadius: 10, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 3, elevation: 2 }}
            onPress={() => {
              onSave(selected);
              onClose();
            }}
          >
            <Text style={{ color: '#FFFFFF', fontWeight: '800', fontSize: 14 }}>
              Apply Selection ({selected.length} / {targetQty})
            </Text>
          </TouchableOpacity>
        </View>

        {/* QR / Barcode Scanner Modal */}
        <Modal visible={scannerVisible} animationType="slide" onRequestClose={() => setScannerVisible(false)}>
          <SafeAreaView style={{ flex: 1, backgroundColor: '#000000' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#0F172A' }}>
              <View>
                <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '700' }}>Scan QR / Barcode</Text>
                <Text style={{ color: '#94A3B8', fontSize: 11, marginTop: 2 }}>{titleText} ({itemName})</Text>
              </View>
              <TouchableOpacity onPress={() => setScannerVisible(false)} style={{ padding: 4 }}>
                <Icon name="x" size={24} color="#FFFFFF" />
              </TouchableOpacity>
            </View>

            <View style={{ flex: 1, position: 'relative' }}>
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{
                  barcodeTypes: [
                    'qr',
                    'ean13',
                    'code128',
                    'code39',
                    'upc_a',
                    'upc_e',
                    'ean8',
                    'pdf417',
                    'aztec',
                    'datamatrix',
                  ],
                }}
                onBarcodeScanned={handleBarcodeScanned}
              />

              {/* Viewfinder Target */}
              <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                <View
                  style={{
                    width: 270,
                    height: 270,
                    borderWidth: 2.5,
                    borderColor: '#10B981',
                    borderRadius: 16,
                    backgroundColor: 'transparent',
                    justifyContent: 'center',
                    alignItems: 'center',
                  }}
                >
                  <View style={{ backgroundColor: 'rgba(15, 23, 42, 0.75)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12 }}>
                    <Text style={{ color: '#10B981', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 }}>ALIGN QR / BARCODE</Text>
                  </View>
                </View>
              </View>
            </View>

            <View style={{ padding: 16, backgroundColor: '#0F172A', alignItems: 'center' }}>
              <Text style={{ color: '#94A3B8', fontSize: 12, textAlign: 'center', marginBottom: 10 }}>
                Selected: {selected.length} / {targetQty} codes
              </Text>
              <TouchableOpacity
                style={{ backgroundColor: '#334155', paddingHorizontal: 24, paddingVertical: 10, borderRadius: 8 }}
                onPress={() => setScannerVisible(false)}
              >
                <Text style={{ color: '#FFFFFF', fontWeight: '700', fontSize: 13 }}>Done Scanning</Text>
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        </Modal>
      </SafeAreaView>
    </Modal>
  );
};

// ─── Custom Pagination Footer ──────────────────────────────────────────────────
const PaginationFooter = ({
  page,
  pageSize,
  total,
  onPageChange,
  loading = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (newPage: number) => void;
  loading?: boolean;
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
          style={[paginationStyles.pageBtn, (page <= 1 || loading) && paginationStyles.pageBtnDisabled]}
          disabled={page <= 1 || loading}
          onPress={() => onPageChange(page - 1)}
        >
          <Text style={[paginationStyles.pageBtnText, (page <= 1 || loading) && paginationStyles.pageBtnTextDisabled]}>‹ Prev</Text>
        </TouchableOpacity>

        <View style={paginationStyles.pageBadge}>
          <Text style={paginationStyles.pageBadgeText}>Page {page} of {totalPages}</Text>
        </View>

        <TouchableOpacity
          style={[paginationStyles.pageBtn, (page >= totalPages || loading) && paginationStyles.pageBtnDisabled]}
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
    backgroundColor: '#481238',
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

export default function MaterialIssuesScreen() {
  const [token, setToken] = useState<string>('');
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);

  // List State
  const [issues, setIssues] = useState<any[]>([]);
  const [page, setPage] = useState<number>(1);
  const [total, setTotal] = useState<number>(0);
  const [search, setSearch] = useState<string>('');

  // Masters
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [allItems, setAllItems] = useState<any[]>([]);
  const [usersList, setUsersList] = useState<any[]>([]);
  const [indentsList, setIndentsList] = useState<any[]>([]);
  const [vehiclesList, setVehiclesList] = useState<any[]>([]);

  // Detail Modal
  const [selectedIssue, setSelectedIssue] = useState<any>(null);
  const [detailModalVisible, setDetailModalVisible] = useState<boolean>(false);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);

  // Form Modal
  const [formModalVisible, setFormModalVisible] = useState<boolean>(false);
  const [formLoading, setFormLoading] = useState<boolean>(false);
  const [selectedIndentId, setSelectedIndentId] = useState<string>('');
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>('');
  const [selectedDestWarehouseId, setSelectedDestWarehouseId] = useState<string>('');
  const [selectedVehicleCode, setSelectedVehicleCode] = useState<string>('');
  const [vehicleNumber, setVehicleNumber] = useState<string>('');
  const [serviceCode, setServiceCode] = useState<string>('');
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [department, setDepartment] = useState<string>('');
  const [selectedIssuedTo, setSelectedIssuedTo] = useState<string>('');
  const [issueDate, setIssueDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [remarks, setRemarks] = useState<string>('');
  const [formItems, setFormItems] = useState<any[]>([]);

  // Stock Balance & FEFO Batches State
  const [stockMap, setStockMap] = useState<{ [itemId: number]: number }>({});
  const [itemStockDetails, setItemStockDetails] = useState<{
    [itemId: number]: { batches: any[]; bins: any[]; rawRows: any[] };
  }>({});

  // Code Picker Tree Modal State
  const [codeModalVisible, setCodeModalVisible] = useState<boolean>(false);
  const [activeCodeLineIdx, setActiveCodeLineIdx] = useState<number | null>(null);

  // Pickers Modals
  const [itemPickerVisible, setItemPickerVisible] = useState<boolean>(false);
  const [itemSearch, setItemSearch] = useState<string>('');

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

        fetchIssues(API_BASE_URL, savedToken, 1, search);
        fetchMasters(API_BASE_URL, savedToken);
      } catch (e) {
        console.error(e);
        router.replace('/');
      }
    };
    loadSession();
  }, []);

  const fetchMasters = async (apiBase: string, authToken: string) => {
    try {
      const headers = { Authorization: `Bearer ${authToken}` };
      const [whRes, projRes, itemRes, usrRes, indRes, vehRes] = await Promise.all([
        axios.get(`${apiBase}/api/v1/masters/warehouses`, { headers, params: { page_size: 100 } }),
        axios.get(`${apiBase}/api/v1/masters/projects`, { headers, params: { page_size: 100 } }),
        axios.get(`${apiBase}/api/v1/masters/items`, { headers, params: { page_size: 200 } }),
        axios.get(`${apiBase}/api/v1/users/lookup`, { headers }),
        axios.get(`${apiBase}/api/v1/indent/indents`, { headers, params: { available_for_issue: true, page_size: 100 } }),
        axios.get(`${apiBase}/api/v1/masters/vehicles`, { headers, params: { limit: 100 } }),
      ]);

      setWarehouses(whRes.data.items || whRes.data || []);
      setProjects(projRes.data.items || projRes.data || []);
      setAllItems(itemRes.data.items || itemRes.data || []);
      setUsersList(usrRes.data || []);
      setIndentsList(indRes.data.items || indRes.data || []);
      setVehiclesList(vehRes.data || []);
    } catch (e: any) {
      if (e.response?.status === 401) {
        await AsyncStorage.removeItem('user_token');
        router.replace('/');
        return;
      }
      console.error('Failed to load masters:', e);
    }
  };

  const fetchIssues = async (apiBase: string, authToken: string, pageNum: number, searchQuery: string) => {
    try {
      if (pageNum === 1) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      const params: any = { page: pageNum, page_size: 15 };
      if (searchQuery) params.search = searchQuery;

      const res = await axios.get(`${apiBase}/api/v1/warehouse/material-issues`, {
        headers: { Authorization: `Bearer ${authToken}` },
        params,
      });

      const items = res.data.items || res.data || [];
      setIssues(items);
      setTotal(res.data.total ?? res.data.total_items ?? res.data.count ?? items.length);
      setPage(pageNum);
    } catch (e: any) {
      if (e.response?.status === 401) {
        await AsyncStorage.removeItem('user_token');
        router.replace('/');
        return;
      }
      console.error(e);
      Alert.alert('Error', 'Failed to retrieve material issues.');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    fetchIssues(API_BASE_URL, token, 1, search);
  };

  const loadMore = () => {
    if (issues.length < total && !loading && !loadingMore && !refreshing) {
      fetchIssues(API_BASE_URL, token, page + 1, search);
    }
  };

  const openDetails = async (issueId: number) => {
    setDetailLoading(true);
    setDetailModalVisible(true);
    try {
      const res = await axios.get(`${API_BASE_URL}/api/v1/warehouse/material-issues/${issueId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setSelectedIssue(res.data);
    } catch (e) {
      console.error(e);
      Alert.alert('Error', 'Failed to retrieve issue details.');
      setDetailModalVisible(false);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleConfirmIssue = async (issueId: number) => {
    try {
      await axios.post(`${API_BASE_URL}/api/v1/warehouse/material-issues/${issueId}/issue`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      Alert.alert('Success', 'Material issue confirmed and marked as Issued!');
      setDetailModalVisible(false);
      handleRefresh();
    } catch (err: any) {
      Alert.alert('Action Failed', err.response?.data?.detail || 'Failed to confirm material issue.');
    }
  };

  const refreshStockForItems = async (warehouseIdStr: string, itemIds: number[]) => {
    if (!warehouseIdStr || !itemIds || itemIds.length === 0) {
      setStockMap({});
      return;
    }
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const res = await axios.get(`${API_BASE_URL}/api/v1/inventory/stock-balance`, {
        headers,
        params: {
          warehouse_id: parseInt(warehouseIdStr),
          item_id: itemIds.join(','),
          page_size: 200,
        },
      });
      const rows = res.data?.items || res.data?.data || res.data || [];
      const map: { [key: number]: number } = {};
      itemIds.forEach((id) => {
        map[id] = 0;
      });
      if (Array.isArray(rows)) {
        rows.forEach((r: any) => {
          if (r.item_id) {
            map[r.item_id] = (map[r.item_id] || 0) + (parseFloat(r.available_qty) || 0);
          }
        });
      }
      setStockMap((prev) => ({ ...prev, ...map }));
    } catch (e) {
      console.error('refreshStockForItems error:', e);
    }
  };

  const fetchItemStockDetails = async (warehouseIdStr: string, itemId: number) => {
    if (!warehouseIdStr || !itemId) return;
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const res = await axios.get(`${API_BASE_URL}/api/v1/inventory/stock-balance/${itemId}/breakdown`, {
        headers,
      });
      const allRows = res.data?.items || res.data?.data || res.data || [];
      if (!Array.isArray(allRows)) return;

      const rows = allRows.filter((r: any) => Number(r.warehouse_id) === Number(warehouseIdStr));

      const batchMap = new Map();
      const binMap = new Map();

      rows.forEach((r: any) => {
        const bid = r.batch_id;
        const bName = r.batch_number || r.batch_name || (bid ? `Batch ${bid}` : 'No Batch');
        const bidKey = bid === null ? 'null_batch' : String(bid);
        if (!batchMap.has(bidKey)) {
          batchMap.set(bidKey, {
            id: bid,
            batch_number: bName,
            expiry_date: r.expiry_date,
            qty: parseFloat(r.available_qty) || 0,
            rate: parseFloat(r.valuation_rate) || 0,
          });
        } else {
          batchMap.get(bidKey).qty += parseFloat(r.available_qty) || 0;
        }

        const bnid = r.bin_id;
        const bCode = r.bin_code || r.bin_name || (bnid ? `Bin ${bnid}` : 'Main Area');
        const bnidKey = bnid === null ? 'null_bin' : String(bnid);
        if (!binMap.has(bnidKey)) {
          binMap.set(bnidKey, {
            id: bnid,
            code: bCode,
            qty: parseFloat(r.available_qty) || 0,
          });
        } else {
          binMap.get(bnidKey).qty += parseFloat(r.available_qty) || 0;
        }
      });

      // Sort FEFO batches by expiry_date
      const batches = Array.from(batchMap.values()).sort((a, b) => {
        if (!a.expiry_date) return 1;
        if (!b.expiry_date) return -1;
        return new Date(a.expiry_date).getTime() - new Date(b.expiry_date).getTime();
      });

      const bins = Array.from(binMap.values());

      setItemStockDetails((prev) => ({
        ...prev,
        [itemId]: { batches, bins, rawRows: rows },
      }));

      // Auto-assign FEFO batch & bin to form items if not already selected
      if (batches.length > 0 || bins.length > 0) {
        setFormItems((prevItems) =>
          prevItems.map((line) => {
            if (line.item_id !== itemId) return line;
            const updated = { ...line };
            if (!updated.selected_batch_id && batches.length > 0) {
              updated.selected_batch_id = batches[0].id;
              updated.batch_number_text = batches[0].batch_number;
            }
            if (!updated.selected_bin_id && bins.length > 0) {
              updated.selected_bin_id = bins[0].id;
              updated.bin_code_text = bins[0].code;
            }
            return updated;
          })
        );
      }
    } catch (e) {
      console.error('fetchItemStockDetails error:', e);
    }
  };

  const formatApiError = (err: any, fallback: string): string => {
    if (!err) return fallback;
    if (err.response?.data) {
      const data = err.response.data;
      if (typeof data.detail === 'string') return data.detail;
      if (Array.isArray(data.detail)) {
        return data.detail
          .map((item: any) => {
            if (typeof item === 'string') return item;
            if (item?.msg) {
              const loc = Array.isArray(item.loc)
                ? item.loc.filter((x: any) => typeof x === 'string' && x !== 'body').join(' -> ')
                : '';
              return loc ? `${loc}: ${item.msg}` : item.msg;
            }
            return JSON.stringify(item);
          })
          .join('\n');
      }
      if (typeof data.message === 'string') return data.message;
      if (typeof data === 'string') return data;
    }
    if (err.message) return err.message;
    return fallback;
  };

  const handleWarehouseChange = (whIdStr: string) => {
    setSelectedWarehouseId(whIdStr);
    if (!whIdStr) {
      setStockMap({});
      setItemStockDetails({});
      return;
    }
    if (formItems.length > 0) {
      const itemIds = Array.from(new Set(formItems.map((l: any) => l.item_id).filter(Boolean)));
      refreshStockForItems(whIdStr, itemIds as number[]);
      itemIds.forEach((id: any) => fetchItemStockDetails(whIdStr, id));
    }
  };

  // Re-fetch stock balances & breakdown whenever selectedWarehouseId or token changes
  useEffect(() => {
    if (selectedWarehouseId && formItems.length > 0 && token) {
      const itemIds = Array.from(new Set(formItems.map((l: any) => l.item_id).filter(Boolean)));
      if (itemIds.length > 0) {
        refreshStockForItems(selectedWarehouseId, itemIds as number[]);
        itemIds.forEach((id: any) => fetchItemStockDetails(selectedWarehouseId, id));
      }
    }
  }, [selectedWarehouseId, token]);

  const prefillFromIndent = async (indentIdStr: string) => {
    if (!indentIdStr) {
      setSelectedIndentId('');
      return;
    }
    try {
      setSelectedIndentId(indentIdStr);
      const res = await axios.get(`${API_BASE_URL}/api/v1/indent/indents/${indentIdStr}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const ind = res.data;
      if (!ind) return;

      const targetWh = ind.warehouse_id ? String(ind.warehouse_id) : selectedWarehouseId;
      if (ind.warehouse_id) setSelectedWarehouseId(String(ind.warehouse_id));
      if (ind.destination_warehouse_id) setSelectedDestWarehouseId(String(ind.destination_warehouse_id));
      if (ind.department) setDepartment(ind.department);
      if (ind.raised_by) setSelectedIssuedTo(String(ind.raised_by));
      if (ind.vehicle_code) setSelectedVehicleCode(ind.vehicle_code);
      if (ind.vehicle_number) setVehicleNumber(ind.vehicle_number);
      if (ind.service_code) setServiceCode(ind.service_code);
      if (ind.project_id) setSelectedProjectId(String(ind.project_id));

      if (ind.items && ind.items.length > 0) {
        const loadedLines = ind.items
          .map((it: any) => ({
            item_id: it.item_id,
            item_code: it.item_code || '',
            item_name: it.item_name || it.name || '',
            item_type: it.item_type || '',
            qty: String(
              it.issue_remaining_qty ?? Math.max((it.approved_qty || it.requested_qty || 0) - (it.issued_qty || 0), 0)
            ),
            uom_id: it.uom_id || 1,
            uom_name: it.uom_name || 'Pcs',
            rate: String(it.rate || it.purchase_price || 0),
            has_serial: !!it.has_serial,
            serial_text: '',
            batch_number_text: '',
            bin_code_text: '',
            selected_batch_id: null,
            selected_bin_id: null,
          }))
          .filter((line: any) => parseFloat(line.qty) > 0);

        if (loadedLines.length > 0) {
          setFormItems(loadedLines);
          if (targetWh) {
            const itemIds = loadedLines.map((l: any) => l.item_id).filter(Boolean);
            refreshStockForItems(targetWh, itemIds);
            itemIds.forEach((id: number) => fetchItemStockDetails(targetWh, id));
          }
          Alert.alert('Indent Loaded', `Loaded ${loadedLines.length} item(s) from Indent ${ind.indent_number}`);
        }
      }
    } catch (e) {
      console.error(e);
      Alert.alert('Error', 'Failed to load indent details.');
    }
  };

  const openNewForm = () => {
    setSelectedIndentId('');
    setSelectedWarehouseId('');
    setSelectedDestWarehouseId('');
    setSelectedVehicleCode('');
    setVehicleNumber('');
    setServiceCode('');
    setSelectedProjectId('');
    setDepartment('');
    setSelectedIssuedTo('');
    setIssueDate(new Date().toISOString().split('T')[0]);
    setRemarks('');
    setFormItems([]);
    setStockMap({});
    setItemStockDetails({});
    setFormModalVisible(true);
  };

  const handleAddItemLine = (item: any) => {
    const defaultUomId = item.primary_uom_id || item.uom_id || 1;
    const defaultUomName = item.primary_uom?.name || item.uom_name || 'Pcs';

    const newLine = {
      item_id: item.id,
      item_code: item.item_code,
      item_name: item.name,
      item_type: item.item_type || '',
      qty: '1',
      uom_id: defaultUomId,
      uom_name: defaultUomName,
      rate: String(item.standard_rate || item.last_purchase_rate || item.selling_price || 0),
      has_serial: !!item.has_serial,
      has_batch: !!item.has_batch,
      serial_text: '',
      batch_number_text: '',
      bin_code_text: '',
      selected_batch_id: null,
      selected_bin_id: null,
    };

    setFormItems((prev) => [...prev, newLine]);
    if (selectedWarehouseId) {
      refreshStockForItems(selectedWarehouseId, [item.id]);
      fetchItemStockDetails(selectedWarehouseId, item.id);
    }
    setItemPickerVisible(false);
  };

  const handleRemoveItemLine = (index: number) => {
    setFormItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmitForm = async () => {
    if (!selectedWarehouseId) {
      Alert.alert('Validation Error', 'Please select a source warehouse.');
      return;
    }
    if (formItems.length === 0) {
      Alert.alert('Validation Error', 'Please add at least one item to the issue.');
      return;
    }

    const payloadItems = [];
    for (const line of formItems) {
      const q = parseFloat(line.qty || '0');
      const r = parseFloat(line.rate || '0');
      if (isNaN(q) || q <= 0) {
        Alert.alert('Validation Error', `Quantity must be greater than zero for ${line.item_name}`);
        return;
      }

      let serials: string[] = [];
      if (line.serial_text && line.serial_text.trim()) {
        serials = line.serial_text
          .split(',')
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0);
      }

      const isSerialOrAsset = line.has_serial || ['asset', 'consumable'].includes(String(line.item_type || '').toLowerCase());
      if (isSerialOrAsset && serials.length === 0) {
        Alert.alert(
          'Serial / Asset Codes Required',
          `Item "${line.item_name}" requires serial or asset codes. Please tap "Select Serials/Assets" to assign ${q} code(s).`
        );
        return;
      }
      if (isSerialOrAsset && serials.length !== q) {
        Alert.alert(
          'Serial Count Mismatch',
          `Item "${line.item_name}" requires ${q} serial/asset code(s), but ${serials.length} code(s) were assigned.`
        );
        return;
      }

      payloadItems.push({
        item_id: line.item_id,
        qty: q,
        uom_id: line.uom_id,
        rate: r,
        batch_id: line.selected_batch_id || null,
        bin_id: line.selected_bin_id || null,
        serial_numbers: serials.length > 0 ? serials : null,
        batch_number_text: line.batch_number_text || null,
        bin_code_text: line.bin_code_text || null,
      });
    }

    setFormLoading(true);
    try {
      const payload = {
        warehouse_id: parseInt(selectedWarehouseId),
        destination_warehouse_id: selectedDestWarehouseId ? parseInt(selectedDestWarehouseId) : null,
        indent_id: selectedIndentId ? parseInt(selectedIndentId) : null,
        vehicle_code: selectedVehicleCode || null,
        vehicle_number: vehicleNumber || null,
        service_code: serviceCode || null,
        issue_date: issueDate,
        department: department || null,
        issued_to: selectedIssuedTo ? parseInt(selectedIssuedTo) : null,
        project_id: selectedProjectId ? parseInt(selectedProjectId) : null,
        remarks: remarks || null,
        items: payloadItems,
      };

      await axios.post(`${API_BASE_URL}/api/v1/warehouse/material-issues`, payload, {
        headers: { Authorization: `Bearer ${token}` },
      });

      Alert.alert('Success', 'Material Issue created successfully!');
      setFormModalVisible(false);
      handleRefresh();
    } catch (err: any) {
      Alert.alert('Submission Failed', formatApiError(err, 'Failed to create material issue.'));
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
          <TouchableOpacity style={styles.headerButton} onPress={() => router.replace('/dashboard')}>
            <Icon name="arrow-left" size={20} color="#FFFFFF" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Material Issues</Text>
          <TouchableOpacity style={styles.headerButton} onPress={openNewForm}>
            <Icon name="plus" size={20} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </LinearGradient>

      {/* Search Bar */}
      <View style={styles.searchBarContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search issue # or remarks..."
          placeholderTextColor="#94A3B8"
          value={search}
          onChangeText={(val) => {
            setSearch(val);
            fetchIssues(API_BASE_URL, token, 1, val);
          }}
        />
      </View>

      {/* List */}
      {loading && page === 1 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#481238" />
          <Text style={styles.loadingText}>Loading material issues...</Text>
        </View>
      ) : issues.length === 0 ? (
        <ScrollView
          contentContainerStyle={styles.emptyContainer}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        >
          <Icon name="package" size={48} color="#CBD5E1" />
          <Text style={styles.emptyText}>No material issues found</Text>
          <TouchableOpacity style={styles.emptyButton} onPress={openNewForm}>
            <Text style={styles.emptyButtonText}>Create Material Issue</Text>
          </TouchableOpacity>
        </ScrollView>
      ) : (
        <FlatList
          data={issues}
          keyExtractor={(item) => item.id.toString()}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
          ListFooterComponent={
            <PaginationFooter
              page={page}
              pageSize={15}
              total={total}
              loading={loading || loadingMore}
              onPageChange={(p) => fetchIssues(API_BASE_URL, token, p, search)}
            />
          }
          renderItem={({ item }) => {
            const isIssued = item.status === 'issued' || item.status === 'acknowledged';

            return (
              <TouchableOpacity
                style={styles.card}
                activeOpacity={0.7}
                onPress={() => openDetails(item.id)}
              >
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>{item.issue_number}</Text>
                  <View style={[styles.statusTag, { backgroundColor: isIssued ? '#DBEAFE' : '#FEF3C7' }]}>
                    <Text style={[styles.statusText, { color: isIssued ? '#1E40AF' : '#D97706' }]}>
                      {item.status?.toUpperCase() || 'DRAFT'}
                    </Text>
                  </View>
                </View>

                <View style={styles.cardDetails}>
                  <Text style={styles.detailText}>Warehouse: {item.warehouse_name || '-'}</Text>
                  {item.destination_warehouse_name ? (
                    <Text style={styles.detailText}>Dest Warehouse: {item.destination_warehouse_name}</Text>
                  ) : null}
                  <Text style={styles.detailText}>Issued To: {item.issued_to_name || '-'}</Text>
                  <Text style={styles.detailText}>Items: {item.items?.length || 0}</Text>
                </View>

                <View style={styles.cardFooter}>
                  <Text style={styles.cardFooterType}>
                    Date: {item.issue_date ? new Date(item.issue_date).toLocaleDateString() : '-'}
                  </Text>
                  <Icon name="chevron-right" size={16} color="#481238" />
                </View>
              </TouchableOpacity>
            );
          }}
        />
      )}

      {/* Detail Modal */}
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
            <Text style={styles.modalTitle}>Material Issue Details</Text>
            <View style={{ width: 20 }} />
          </View>

          {detailLoading || !selectedIssue ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#481238" />
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.modalScroll}>
              <View style={styles.infoCard}>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Issue Number</Text>
                  <Text style={styles.infoValue}>{selectedIssue.issue_number}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Status</Text>
                  <Text style={[styles.infoValue, { color: selectedIssue.status === 'issued' ? '#10B981' : '#D97706' }]}>
                    {selectedIssue.status?.toUpperCase()}
                  </Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Source Warehouse</Text>
                  <Text style={styles.infoValue}>{selectedIssue.warehouse_name || '-'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Dest Warehouse</Text>
                  <Text style={styles.infoValue}>{selectedIssue.destination_warehouse_name || '-'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Project</Text>
                  <Text style={styles.infoValue}>{selectedIssue.project_name || '-'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Vehicle Code</Text>
                  <Text style={styles.infoValue}>{selectedIssue.vehicle_code || '-'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Vehicle Number</Text>
                  <Text style={styles.infoValue}>{selectedIssue.vehicle_number || '-'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Issued To</Text>
                  <Text style={styles.infoValue}>{selectedIssue.issued_to_name || '-'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Remarks</Text>
                  <Text style={styles.infoValue}>{selectedIssue.remarks || '-'}</Text>
                </View>
              </View>

              <Text style={styles.sectionHeading}>Issued Items</Text>
              {(selectedIssue.items || []).map((it: any, idx: number) => (
                <View key={it.id || idx} style={styles.itemRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName}>{it.item_name || it.item_code}</Text>
                    <Text style={styles.itemMeta}>Code: {it.item_code}</Text>
                    {it.serial_numbers && it.serial_numbers.length > 0 && (
                      <Text style={[styles.itemMeta, { color: '#4F46E5', fontWeight: '600', marginTop: 2 }]}>
                        Codes: {it.serial_numbers.join(', ')}
                      </Text>
                    )}
                  </View>
                  <Text style={{ fontWeight: '700', color: '#0F172A' }}>
                    {it.qty} {it.uom_name || ''}
                  </Text>
                </View>
              ))}

              {selectedIssue.status === 'draft' && (
                <TouchableOpacity
                  style={[styles.submitBtn, { marginTop: 24, backgroundColor: '#10B981' }]}
                  onPress={() => handleConfirmIssue(selectedIssue.id)}
                >
                  <Text style={styles.submitBtnText}>Confirm & Dispatch Issue</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>

      {/* Create Form Modal */}
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
            <Text style={styles.modalTitle}>New Material Issue</Text>
            <View style={{ width: 20 }} />
          </View>

          {formLoading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#481238" />
              <Text style={styles.loadingText}>Saving material issue...</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.modalScroll}>
              <SearchableDropdownSelect
                label="Reference Indent (Optional)"
                value={selectedIndentId}
                onValueChange={prefillFromIndent}
                items={indentsList.map((ind) => ({
                  label: `${ind.indent_number}${ind.warehouse_name ? ` · ${ind.warehouse_name}` : ''}${ind.raised_by_name ? ` · ${ind.raised_by_name}` : ''}`,
                  value: String(ind.id),
                  subLabel: `Status: ${ind.status || 'Approved'}`,
                }))}
                placeholder="Search & Select Approved Indent"
                allowClear
              />

              <SearchableDropdownSelect
                label="Source Warehouse *"
                value={selectedWarehouseId}
                onValueChange={handleWarehouseChange}
                items={warehouses.map((wh) => ({
                  label: wh.name || wh.warehouse_name || `Warehouse #${wh.id}`,
                  value: String(wh.id),
                  subLabel: wh.code ? `Code: ${wh.code}` : undefined,
                }))}
                placeholder="Search & Select Source Warehouse"
              />

              <SearchableDropdownSelect
                label="Destination Warehouse (Optional)"
                value={selectedDestWarehouseId}
                onValueChange={setSelectedDestWarehouseId}
                items={warehouses.map((wh) => ({
                  label: wh.name || wh.warehouse_name || `Warehouse #${wh.id}`,
                  value: String(wh.id),
                  subLabel: wh.code ? `Code: ${wh.code}` : undefined,
                }))}
                placeholder="Search & Select Dest Warehouse"
                allowClear
              />

              <SearchableDropdownSelect
                label="Vehicle Code (Optional)"
                value={selectedVehicleCode}
                onValueChange={(val) => {
                  setSelectedVehicleCode(val);
                  const matched = vehiclesList.find((v) => v.vehicle_code === val);
                  if (matched && matched.vehicle_number) {
                    setVehicleNumber(matched.vehicle_number);
                  }
                }}
                items={vehiclesList.map((v) => ({
                  label: `${v.vehicle_code} (${v.vehicle_number || '-'})`,
                  value: v.vehicle_code,
                  subLabel: v.vehicle_type || undefined,
                }))}
                placeholder="Search & Select Vehicle Code"
                allowClear
              />

              <Text style={styles.fieldLabel}>Vehicle Number</Text>
              <TextInput
                style={styles.formInput}
                placeholder="e.g. TS09AB1234"
                value={vehicleNumber}
                onChangeText={setVehicleNumber}
              />

              <Text style={styles.fieldLabel}>Service Code</Text>
              <TextInput
                style={styles.formInput}
                placeholder="e.g. SRV-102"
                value={serviceCode}
                onChangeText={setServiceCode}
              />

              <Text style={styles.fieldLabel}>Department</Text>
              <TextInput
                style={styles.formInput}
                placeholder="e.g. Electrical, Plumbing..."
                value={department}
                onChangeText={setDepartment}
              />

              <SearchableDropdownSelect
                label="Project (Optional)"
                value={selectedProjectId}
                onValueChange={setSelectedProjectId}
                items={projects.map((p) => ({
                  label: p.name || p.project_name || `Project #${p.id}`,
                  value: String(p.id),
                }))}
                placeholder="Search & Select Project"
                allowClear
              />

              <SearchableDropdownSelect
                label="Issued To (Optional)"
                value={selectedIssuedTo}
                onValueChange={setSelectedIssuedTo}
                items={usersList.map((u) => ({
                  label: u.name || u.full_name || u.username,
                  value: String(u.id),
                  subLabel: u.employee_code || u.email || undefined,
                }))}
                placeholder="Search & Select User"
                allowClear
              />

              <Text style={styles.fieldLabel}>Issue Date</Text>
              <TextInput
                style={styles.formInput}
                placeholder="YYYY-MM-DD"
                value={issueDate}
                onChangeText={setIssueDate}
              />

              <Text style={styles.fieldLabel}>Remarks</Text>
              <TextInput
                style={styles.formInput}
                placeholder="Notes..."
                value={remarks}
                onChangeText={setRemarks}
              />

              {/* Items Section */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, marginBottom: 8 }}>
                <Text style={styles.sectionHeading}>Items List *</Text>
                <TouchableOpacity
                  style={[styles.emptyButton, { paddingVertical: 6, paddingHorizontal: 12 }]}
                  onPress={() => setItemPickerVisible(true)}
                >
                  <Text style={[styles.emptyButtonText, { fontSize: 12 }]}>+ Add Item</Text>
                </TouchableOpacity>
              </View>

              {formItems.map((line, idx) => {
                const availQty = stockMap[line.item_id] ?? 0;
                const details = itemStockDetails[line.item_id] || { batches: [], bins: [], rawRows: [] };
                const isTracked = line.has_serial || line.item_type === 'asset' || line.item_type === 'consumable';
                const codeLabel = line.item_type === 'asset'
                  ? 'Asset Codes'
                  : line.item_type === 'consumable'
                  ? 'Consumable Codes'
                  : 'Serial Numbers';

                const parsedCodes = line.serial_text
                  ? line.serial_text.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0)
                  : [];

                return (
                  <View key={idx} style={styles.formItemCard}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.formItemTitle}>{line.item_name}</Text>
                        <Text style={{ fontSize: 11, color: '#64748B' }}>Code: {line.item_code} · {line.uom_name || 'Pcs'}</Text>
                        <View style={{ marginTop: 4, alignSelf: 'flex-start' }}>
                          <View style={{ backgroundColor: availQty > 0 ? '#DCFCE7' : '#FEE2E2', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12, borderWidth: 1, borderColor: availQty > 0 ? '#22C55E' : '#EF4444' }}>
                            <Text style={{ fontSize: 10, fontWeight: '700', color: availQty > 0 ? '#15803D' : '#B91C1C' }}>
                              Avail Qty: {availQty} {line.uom_name || ''}
                            </Text>
                          </View>
                        </View>
                      </View>
                      <TouchableOpacity onPress={() => handleRemoveItemLine(idx)}>
                        <Icon name="trash-2" size={18} color="#EF4444" />
                      </TouchableOpacity>
                    </View>

                    <Text style={[styles.fieldLabel, { marginTop: 4 }]}>Quantity *</Text>
                    <TextInput
                      style={styles.formInput}
                      keyboardType="numeric"
                      value={line.qty}
                      onChangeText={(val) => {
                        setFormItems((prev) =>
                          prev.map((item, i) => (i === idx ? { ...item, qty: val } : item))
                        );
                      }}
                    />

                    {/* FEFO Batches Select / Input */}
                    {details.batches && details.batches.length > 0 ? (
                      <SearchableDropdownSelect
                        label="Batch Number (FEFO Stock)"
                        value={line.batch_number_text || ''}
                        onValueChange={(val) => {
                          const matched = details.batches.find((b) => b.batch_number === val || String(b.id) === val);
                          setFormItems((prev) =>
                            prev.map((item, i) =>
                              i === idx
                                ? {
                                    ...item,
                                    batch_number_text: matched ? matched.batch_number : val,
                                    selected_batch_id: matched ? matched.id : null,
                                  }
                                : item
                            )
                          );
                        }}
                        items={details.batches.map((b) => ({
                          label: `${b.batch_number}${b.expiry_date ? ` (Exp: ${new Date(b.expiry_date).toLocaleDateString()})` : ''} · Qty: ${b.qty}`,
                          value: b.batch_number,
                        }))}
                        placeholder="Select Batch (FEFO Sorted)"
                        allowClear
                      />
                    ) : (
                      <>
                        <Text style={styles.fieldLabel}>Batch Number (Optional)</Text>
                        <TextInput
                          style={styles.formInput}
                          placeholder="Source batch #..."
                          value={line.batch_number_text}
                          onChangeText={(val) => {
                            setFormItems((prev) =>
                              prev.map((item, i) => (i === idx ? { ...item, batch_number_text: val } : item))
                            );
                          }}
                        />
                      </>
                    )}

                    {/* Bin Select / Input */}
                    {details.bins && details.bins.length > 0 ? (
                      <SearchableDropdownSelect
                        label="Bin Location"
                        value={line.bin_code_text || ''}
                        onValueChange={(val) => {
                          const matched = details.bins.find((b) => b.code === val || String(b.id) === val);
                          setFormItems((prev) =>
                            prev.map((item, i) =>
                              i === idx
                                ? {
                                    ...item,
                                    bin_code_text: matched ? matched.code : val,
                                    selected_bin_id: matched ? matched.id : null,
                                  }
                                : item
                            )
                          );
                        }}
                        items={details.bins.map((b) => ({
                          label: `${b.code} · Qty: ${b.qty}`,
                          value: b.code,
                        }))}
                        placeholder="Select Bin Location"
                        allowClear
                      />
                    ) : (
                      <>
                        <Text style={styles.fieldLabel}>Bin Code / Location (Optional)</Text>
                        <TextInput
                          style={styles.formInput}
                          placeholder="Bin code..."
                          value={line.bin_code_text}
                          onChangeText={(val) => {
                            setFormItems((prev) =>
                              prev.map((item, i) => (i === idx ? { ...item, bin_code_text: val } : item))
                            );
                          }}
                        />
                      </>
                    )}

                    {/* Dedicated Asset / Consumable / Serial Code Picker Trigger */}
                    {isTracked && (
                      <View style={{ marginTop: 8 }}>
                        <Text style={styles.fieldLabel}>{codeLabel}</Text>
                        <TouchableOpacity
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            backgroundColor: parsedCodes.length > 0 ? '#F0F9FF' : '#F8FAFC',
                            borderWidth: 1.5,
                            borderColor: parsedCodes.length > 0 ? '#0284C7' : '#CBD5E1',
                            borderRadius: 8,
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                          }}
                          onPress={() => {
                            setActiveCodeLineIdx(idx);
                            setCodeModalVisible(true);
                          }}
                        >
                          <Text
                            style={{
                              flex: 1,
                              fontSize: 13,
                              fontWeight: '700',
                              color: parsedCodes.length > 0 ? '#0284C7' : '#475569',
                              marginRight: 8,
                            }}
                            numberOfLines={1}
                          >
                            {parsedCodes.length > 0
                              ? `${parsedCodes.length} ${codeLabel} Selected`
                              : `Select ${codeLabel}`}
                          </Text>
                          <View
                            style={{
                              backgroundColor: '#0284C7',
                              paddingHorizontal: 10,
                              paddingVertical: 6,
                              borderRadius: 6,
                              flexShrink: 0,
                            }}
                          >
                            <Text style={{ fontSize: 12, fontWeight: '800', color: '#FFF' }}>
                              Pick ({parsedCodes.length}/{Math.round(parseFloat(line.qty || '1'))})
                            </Text>
                          </View>
                        </TouchableOpacity>

                        {parsedCodes.length > 0 && (
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                            {parsedCodes.map((code: string, cIdx: number) => (
                              <View key={cIdx} style={{ backgroundColor: line.item_type === 'asset' ? '#CFFAFE' : line.item_type === 'consumable' ? '#FFEDD5' : '#E0E7FF', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12, borderWidth: 1, borderColor: line.item_type === 'asset' ? '#06B6D4' : line.item_type === 'consumable' ? '#F97316' : '#6366F1' }}>
                                <Text style={{ fontSize: 11, fontWeight: '700', color: line.item_type === 'asset' ? '#0891B2' : line.item_type === 'consumable' ? '#EA580C' : '#4F46E5' }}>{code}</Text>
                              </View>
                            ))}
                          </View>
                        )}
                      </View>
                    )}
                  </View>
                );
              })}

              <TouchableOpacity
                style={[styles.submitBtn, { marginTop: 24 }]}
                onPress={handleSubmitForm}
              >
                <Text style={styles.submitBtnText}>Create Material Issue</Text>
              </TouchableOpacity>
            </ScrollView>
          )}

          {/* Item Picker Modal */}
          <Modal
            visible={itemPickerVisible}
            animationType="slide"
            transparent
            onRequestClose={() => setItemPickerVisible(false)}
          >
            <View style={styles.pickerOverlay}>
              <View style={styles.pickerSheet}>
                <View style={styles.pickerSheetHeader}>
                  <Text style={styles.pickerSheetTitle}>Select Item</Text>
                  <TouchableOpacity onPress={() => setItemPickerVisible(false)}>
                    <Icon name="x" size={20} color="#334155" />
                  </TouchableOpacity>
                </View>
                <TextInput
                  style={styles.pickerSearch}
                  placeholder="Search item name or code..."
                  placeholderTextColor="#94A3B8"
                  value={itemSearch}
                  onChangeText={setItemSearch}
                />
                <FlatList
                  data={allItems.filter((it: any) =>
                    !itemSearch ||
                    it.name?.toLowerCase().includes(itemSearch.toLowerCase()) ||
                    it.item_code?.toLowerCase().includes(itemSearch.toLowerCase())
                  )}
                  keyExtractor={(item: any) => item.id.toString()}
                  style={{ maxHeight: 360 }}
                  renderItem={({ item }: { item: any }) => (
                    <TouchableOpacity
                      style={styles.pickerItem}
                      onPress={() => handleAddItemLine(item)}
                    >
                      <Text style={styles.pickerItemText}>{item.name}</Text>
                      <Text style={styles.pickerItemSub}>Code: {item.item_code}</Text>
                    </TouchableOpacity>
                  )}
                />
              </View>
            </View>
          </Modal>
        </SafeAreaView>
      </Modal>

      {/* Asset / Consumable / Serial Codes Selection Tree Modal */}
      {activeCodeLineIdx !== null && formItems[activeCodeLineIdx] && (
        <AssetCodesTreeModal
          visible={codeModalVisible}
          onClose={() => {
            setCodeModalVisible(false);
            setActiveCodeLineIdx(null);
          }}
          onSave={(selectedCodes) => {
            const idx = activeCodeLineIdx;
            setFormItems((prev) =>
              prev.map((item, i) =>
                i === idx
                  ? {
                      ...item,
                      serial_text: selectedCodes.join(', '),
                      serial_numbers: selectedCodes,
                    }
                  : item
              )
            );
          }}
          itemName={formItems[activeCodeLineIdx].item_name}
          itemCode={formItems[activeCodeLineIdx].item_code}
          itemType={formItems[activeCodeLineIdx].item_type}
          targetQty={Math.round(parseFloat(formItems[activeCodeLineIdx].qty || '1'))}
          selectedCodes={
            formItems[activeCodeLineIdx].serial_text
              ? formItems[activeCodeLineIdx].serial_text
                  .split(',')
                  .map((s: string) => s.trim())
                  .filter((s: string) => s.length > 0)
              : []
          }
          rawRows={
            itemStockDetails[formItems[activeCodeLineIdx].item_id]?.rawRows || []
          }
          batchId={formItems[activeCodeLineIdx].selected_batch_id}
          binId={formItems[activeCodeLineIdx].selected_bin_id}
        />
      )}
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
    gap: 4,
    marginBottom: 12,
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
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
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
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 6,
  },
  dropdownTrigger: {
    height: 44,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  dropdownTriggerText: {
    fontSize: 14,
    color: '#0F172A',
    fontWeight: '500',
    flex: 1,
  },
  dropdownArrow: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderTopWidth: 6,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#64748B',
  },
  dropdownModalBg: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 40,
  },
  dropdownModalContent: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    maxHeight: '80%',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  dropdownModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
    backgroundColor: '#FAF5FF',
  },
  dropdownModalTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#481238',
  },
  dropdownCloseBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  dropdownCloseBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#481238',
  },
  dropdownSearchInput: {
    height: 40,
    backgroundColor: '#F1F5F9',
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 13,
    color: '#0F172A',
  },
  dropdownItemRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  dropdownItemRowActive: {
    backgroundColor: '#F3E8FF',
  },
  dropdownItemText: {
    fontSize: 14,
    color: '#334155',
    fontWeight: '600',
  },
  dropdownItemTextActive: {
    color: '#481238',
    fontWeight: '800',
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
  pickerContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  chipBtn: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipBtnActive: {
    backgroundColor: '#481238',
    borderColor: '#481238',
  },
  chipText: {
    fontSize: 12,
    color: '#475569',
    fontWeight: '600',
  },
  chipTextActive: {
    color: '#FFFFFF',
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
  pickerItemText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F172A',
  },
  pickerItemSub: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
  },
});
