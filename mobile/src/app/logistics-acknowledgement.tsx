import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Alert,
  TextInput,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import { router } from 'expo-router';
import { API_BASE_URL } from '../constants/config';
import { CameraView, useCameraPermissions } from 'expo-camera';

// ─── Custom Premium Vector Icons ───────────────────────────────────────────────
const Icon = ({ name, size = 18, color = '#7A6D66' }: { name: string; size?: number; color?: string }) => {
  const s = size;
  if (name === 'camera') {
    return (
      <View style={{ width: s, height: s, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: s * 0.75, height: s * 0.5, borderWidth: 1.8, borderColor: color, borderRadius: 3, marginTop: 2 }} />
        <View style={{ width: s * 0.3, height: 4, borderWidth: 1.8, borderColor: color, borderBottomWidth: 0, borderTopLeftRadius: 2, borderTopRightRadius: 2, position: 'absolute', top: 1, alignSelf: 'center' }} />
        <View style={{ width: s * 0.26, height: s * 0.26, borderRadius: (s * 0.26)/2, borderWidth: 1.8, borderColor: color, position: 'absolute', alignSelf: 'center', top: s * 0.3 }} />
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
  if (name === 'truck') {
    return (
      <View style={{ width: s, height: s, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: s * 0.55, height: s * 0.4, borderWidth: 1.8, borderColor: color, borderRadius: 2, marginRight: s * 0.15 }} />
        <View style={{ width: s * 0.25, height: s * 0.3, borderWidth: 1.8, borderColor: color, borderLeftWidth: 0, position: 'absolute', right: 0, top: s * 0.3, borderTopRightRadius: 2 }} />
        <View style={{ flexDirection: 'row', gap: s * 0.2, marginTop: 2 }}>
          <View style={{ width: s * 0.16, height: s * 0.16, borderRadius: s * 0.08, borderWidth: 1.5, borderColor: color }} />
          <View style={{ width: s * 0.16, height: s * 0.16, borderRadius: s * 0.08, borderWidth: 1.5, borderColor: color }} />
        </View>
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
  if (name === 'check-circle') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.75, height: s * 0.75, borderRadius: (s * 0.75) / 2, borderWidth: 1.8, borderColor: color, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: s * 0.2, height: s * 0.38, borderBottomWidth: 1.8, borderRightWidth: 1.8, borderColor: color, transform: [{ rotate: '45deg' }, { translateY: -s * 0.04 }, { translateX: s * 0.02 }] }} />
        </View>
      </View>
    );
  }
  if (name === 'search') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.45, height: s * 0.45, borderRadius: (s * 0.45)/2, borderWidth: 1.8, borderColor: color, transform: [{ translateX: -1 }, { translateY: -1 }] }} />
        <View style={{ position: 'absolute', width: s * 0.35, height: 2, backgroundColor: color, transform: [{ rotate: '45deg' }, { translateX: s * 0.2 }, { translateY: s * 0.2 }] }} />
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

const Feather = ({ name, size, color }: { name: string; size?: number; color?: string }) => (
  <Icon name={name} size={size} color={color} />
);

export default function LogisticsAcknowledgementScreen() {
  const [token, setToken] = useState<string>('');
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Search/Scan barcode input
  const [barcodeInput, setBarcodeInput] = useState<string>('');
  const [activeScanType, setActiveScanType] = useState<'consignment' | 'package' | null>(null);
  const [consignmentData, setConsignmentData] = useState<any>(null);
  const [packageData, setPackageData] = useState<any>(null);

  const [scanning, setScanning] = useState<boolean>(false);
  const [permission, requestPermission] = useCameraPermissions();

  const startScanning = async () => {
    if (!permission || !permission.granted) {
      const res = await requestPermission();
      if (!res.granted) {
        Alert.alert('Permission Required', 'Camera permission is required to scan barcodes.');
        return;
      }
    }
    setScanning(true);
  };

  const handleBarCodeScanned = ({ data }: { data: string }) => {
    setScanning(false);
    if (data) {
      setBarcodeInput(data);
      handleScanOrLoad(data);
    }
  };


  // Form input fields
  const [acknowledgedByName, setAcknowledgedByName] = useState<string>('');
  const [acknowledgedByPhone, setAcknowledgedByPhone] = useState<string>('');
  const [acknowledgedByEmployeeCode, setAcknowledgedByEmployeeCode] = useState<string>('');
  const [acknowledgedByDesignation, setAcknowledgedByDesignation] = useState<string>('');
  const [acknowledgedByDepartment, setAcknowledgedByDepartment] = useState<string>('');
  const [remarks, setRemarks] = useState<string>('');
  const [packagingCondition, setPackagingCondition] = useState<'INTACT' | 'DAMAGED'>('INTACT');
  const [sealIntact, setSealIntact] = useState<boolean>(true);

  // Item quantities map: package_item_id -> { receivedQty: string, acceptedQty: string, condition: string }
  const [itemQtys, setItemQtys] = useState<Record<number, { receivedQty: string; acceptedQty: string; condition: string }>>({});

  useEffect(() => {
    const loadSession = async () => {
      try {
        const savedToken = await AsyncStorage.getItem('user_token');
        const savedUserStr = await AsyncStorage.getItem('user_profile');

        if (!savedToken || !savedUserStr) {
          router.replace('/');
          return;
        }

        const parsedUser = JSON.parse(savedUserStr);
        const activeApiUrl = API_BASE_URL;

        setToken(savedToken);
        setUser(parsedUser);

        // Pre-fill signatory details
        setAcknowledgedByName(`${parsedUser.first_name || ''} ${parsedUser.last_name || ''}`.trim() || parsedUser.username || '');
        setAcknowledgedByEmployeeCode(parsedUser.employee_code || '');
        setAcknowledgedByPhone(parsedUser.phone || '9998880000');
        setAcknowledgedByDesignation(parsedUser.designation || 'Storekeeper');
        setAcknowledgedByDepartment(parsedUser.department || 'SCM');

        setLoading(false);
      } catch (err) {
        console.error('Failed to load session:', err);
        setLoading(false);
      }
    };
    loadSession();
  }, []);

  const handleScanOrLoad = async (code = barcodeInput) => {
    if (!code.trim()) {
      Alert.alert('Validation Error', 'Please enter or scan a consignment or package barcode.');
      return;
    }
    setLoading(true);
    setConsignmentData(null);
    setPackageData(null);
    setActiveScanType(null);
    setItemQtys({});

    try {
      const response = await axios.get(
        `${API_BASE_URL}/api/v1/consignment/scan-any/${encodeURIComponent(code.trim())}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (response.data) {
        const { type, data } = response.data;
        if (type === 'parent') {
          setConsignmentData(data);
          setActiveScanType('consignment');
          Alert.alert('Consignment Loaded', `Consignment details for ${data.consignment_number} fetched successfully.`);
          
          if (data.receiver_name) setAcknowledgedByName(data.receiver_name);
          if (data.receiver_employee_code) setAcknowledgedByEmployeeCode(data.receiver_employee_code);
          if (data.receiver_position_code) setAcknowledgedByDesignation(data.receiver_position_code);
        } else if (type === 'child') {
          setPackageData(data);
          setActiveScanType('package');
          Alert.alert('Package Loaded', `Package details for ${data.package_number} fetched successfully.`);

          if (data.receiver_name) setAcknowledgedByName(data.receiver_name);
          if (data.receiver_employee_code) setAcknowledgedByEmployeeCode(data.receiver_employee_code);
          if (data.receiver_position_code) setAcknowledgedByDesignation(data.receiver_position_code);

          // Initialize item quantities record
          const initialQtys: typeof itemQtys = {};
          (data.items || []).forEach((item: any) => {
            initialQtys[item.id] = {
              receivedQty: String(item.quantity_packed),
              acceptedQty: String(item.quantity_packed),
              condition: 'GOOD',
            };
          });
          setItemQtys(initialQtys);
        }
      }
    } catch (err: any) {
      console.error(err);
      const errMsg = err.response?.data?.detail || 'Barcode not recognized. Please scan a valid consignment or package code.';
      Alert.alert('Fetch Error', errMsg);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmConsignmentDelivery = async () => {
    if (!consignmentData) return;
    setSubmitting(true);
    try {
      await axios.post(
        `${API_BASE_URL}/api/v1/consignment/${consignmentData.id}/deliver`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      Alert.alert('Success', `Consignment ${consignmentData.consignment_number} marked as DELIVERED successfully!`);
      // Reload details
      handleScanOrLoad(consignmentData.consignment_number);
    } catch (err: any) {
      console.error(err);
      const errMsg = err.response?.data?.detail || 'Failed to confirm consignment delivery.';
      Alert.alert('Error', errMsg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitPackageAcknowledgement = async () => {
    if (!packageData) return;

    if (!acknowledgedByName.trim()) {
      Alert.alert('Validation Error', 'Receiver Name is required.');
      return;
    }
    if (!acknowledgedByEmployeeCode.trim()) {
      Alert.alert('Validation Error', 'Receiver Employee Code is required.');
      return;
    }
    if (!acknowledgedByPhone.trim()) {
      Alert.alert('Validation Error', 'Contact Number is required.');
      return;
    }

    // Validate item quantities and serial number matches
    const itemsPayload = [];
    for (const item of packageData.items || []) {
      const qtyState = itemQtys[item.id] || { receivedQty: '0', acceptedQty: '0', condition: 'GOOD' };
      const qtyRec = parseFloat(qtyState.receivedQty) || 0;
      const qtyAcc = parseFloat(qtyState.acceptedQty) || 0;

      if (qtyRec > item.quantity_packed) {
        Alert.alert('Validation Error', `Received quantity for ${item.material_name} cannot exceed packed quantity (${item.quantity_packed}).`);
        return;
      }
      if (qtyAcc > qtyRec) {
        Alert.alert('Validation Error', `Accepted quantity for ${item.material_name} cannot exceed received quantity (${qtyRec}).`);
        return;
      }

      if (item.serial_numbers && item.serial_numbers.length > 0) {
        // For serial/asset items, number of accepted items must match selected/available serials count
        // In mobile, we accept the default serial list if it matches accepted quantity, or check size
        if (qtyAcc !== item.serial_numbers.length && qtyAcc !== 0) {
          Alert.alert(
            'Validation Error',
            `For serial-tracked item ${item.material_name}, accepted quantity (${qtyAcc}) must match packed serials count (${item.serial_numbers.length}) or be 0.`
          );
          return;
        }
      }

      itemsPayload.push({
        package_item_id: item.id,
        quantity_received: qtyRec,
        quantity_accepted: qtyAcc,
        quantity_rejected: Math.max(0, qtyRec - qtyAcc),
        quantity_damaged: 0,
        item_condition: qtyState.condition,
        serial_numbers_received: item.serial_numbers || [],
      });
    }

    setSubmitting(true);
    try {
      const payload = {
        package_id: packageData.id,
        acknowledged_by_name: acknowledgedByName,
        acknowledged_by_designation: acknowledgedByDesignation || 'Storekeeper',
        acknowledged_by_phone: acknowledgedByPhone,
        acknowledged_by_employee_code: acknowledgedByEmployeeCode,
        receiver_signature_url: '/uploads/mock-signature.png', // mock signature URL
        photos: [],
        remarks: remarks || 'Received via mobile app',
        packaging_condition: packagingCondition,
        seal_intact: sealIntact,
        seal_number_verified: !!packageData.seal_number,
        items: itemsPayload,
      };

      await axios.post(
        `${API_BASE_URL}/api/v1/consignment/acknowledge`,
        payload,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      Alert.alert('Success', `Package delivery for ${packageData.package_number} acknowledged successfully!`);
      // Reset page
      setPackageData(null);
      setActiveScanType(null);
      setBarcodeInput('');
    } catch (err: any) {
      console.error(err);
      const errMsg = err.response?.data?.detail || 'Failed to submit receipt acknowledgement.';
      Alert.alert('Submission Error', errMsg);
    } finally {
      setSubmitting(false);
    }
  };

  const updateItemQty = (itemId: number, field: 'receivedQty' | 'acceptedQty' | 'condition', value: string) => {
    setItemQtys((prev) => {
      const current = prev[itemId] || { receivedQty: '0', acceptedQty: '0', condition: 'GOOD' };
      const updated = { ...current, [field]: value };
      
      // Enforce: accepted quantity <= received quantity
      if (field === 'receivedQty') {
        const rVal = parseFloat(value) || 0;
        const aVal = parseFloat(current.acceptedQty) || 0;
        if (aVal > rVal) {
          updated.acceptedQty = value;
        }
      }
      if (field === 'acceptedQty') {
        const aVal = parseFloat(value) || 0;
        const rVal = parseFloat(current.receivedQty) || 0;
        if (aVal > rVal) {
          updated.receivedQty = value;
        }
      }

      return { ...prev, [itemId]: updated };
    });
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#4A1060" />
        <Text style={styles.loadingText}>Configuring logistics interface...</Text>
      </SafeAreaView>
    );
  }

  const getStatusText = (status: string) => {
    switch (status) {
      case 'DRAFT': return 'Draft';
      case 'PACKED': return 'Packed';
      case 'IN_TRANSIT': return 'In Transit';
      case 'DELIVERED': return 'Delivered';
      case 'CONSIGNMENT_RECEIVED': return 'Received';
      case 'UNPACKED': return 'Unpacked';
      case 'PARTIALLY_UNPACKED': return 'Partially Unpacked';
      default: return status;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'UNPACKED':
      case 'CONSIGNMENT_RECEIVED':
        return '#10B981';
      case 'IN_TRANSIT':
      case 'PARTIALLY_UNPACKED':
        return '#F59E0B';
      default:
        return '#64748B';
    }
  };

  if (scanning) {
    return (
      <SafeAreaView style={styles.scannerContainer}>
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{

            barcodeTypes: ["qr", "ean13", "code128", "code39"],
          }}
          onBarcodeScanned={handleBarCodeScanned}
        />
        <View style={styles.scannerOverlay}>
          <View style={styles.scannerHeader}>
            <TouchableOpacity style={styles.scannerCloseBtn} onPress={() => setScanning(false)}>
              <Feather name="x" size={24} color="#FFFFFF" />
            </TouchableOpacity>
            <Text style={styles.scannerTitle}>Scan Barcode / QR Code</Text>
          </View>
          <View style={styles.scannerTargetContainer}>
            <View style={styles.scannerTarget} />
            <Text style={styles.scannerInstruction}>Align code inside the frame to scan</Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>

      {/* AppBar */}
      <LinearGradient
        colors={['#481238', '#3A0F40', '#481238']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.appBar}
      >
        <View style={styles.appBarContent}>
          <TouchableOpacity onPress={() => router.replace('/acknowledgement-selector')} style={styles.backBtn}>
            <Feather name="arrow-left" size={20} color="#ffffff" />
          </TouchableOpacity>
          <View style={styles.appBarTitleContainer}>
            <Text style={styles.appBarTitle}>Logistics Acknowledgement</Text>
            <Text style={styles.appBarSub}>SCM Consignment & Package Verification</Text>
          </View>
        </View>
      </LinearGradient>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Search Scan Bar */}
        <View style={styles.scanSection}>
          <Text style={styles.sectionLabel}>Scan or Enter Consignment / Package Code</Text>
          <View style={styles.searchRow}>
            <TextInput
              style={styles.searchInput}
              placeholder="e.g. PKG-AP-2026-00002-PAR1"
              placeholderTextColor="#94A3B8"
              value={barcodeInput}
              onChangeText={setBarcodeInput}
              autoCapitalize="characters"
            />
            <TouchableOpacity style={styles.scanBtn} onPress={startScanning}>
              <Feather name="camera" size={18} color="#FFFFFF" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.searchBtn} onPress={() => handleScanOrLoad()}>
              <Feather name="search" size={18} color="#FFFFFF" />
            </TouchableOpacity>
          </View>

        </View>

        {/* CASE A: Consignment Details */}
        {activeScanType === 'consignment' && consignmentData && (
          <View style={styles.detailsCard}>
            <View style={styles.cardHeader}>
              <Feather name="truck" size={22} color="#4A1060" />
              <View style={styles.headerInfo}>
                <Text style={styles.cardTitle}>{consignmentData.consignment_number}</Text>
                <Text style={styles.cardSub}>Consignment Reference</Text>
              </View>
              <View style={[styles.statusBadge, { backgroundColor: getStatusColor(consignmentData.status) }]}>
                <Text style={styles.statusBadgeText}>{getStatusText(consignmentData.status)}</Text>
              </View>
            </View>

            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Destination:</Text>
              <Text style={styles.infoVal}>{consignmentData.destination_warehouse_name || 'N/A'}</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Receiver Staff:</Text>
              <Text style={styles.infoVal}>{consignmentData.receiver_name || 'N/A'} ({consignmentData.receiver_employee_code || 'N/A'})</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Total Packages:</Text>
              <Text style={styles.infoVal}>{consignmentData.total_packages || 0}</Text>
            </View>

            <Text style={styles.packagesTitle}>Consignment Packages</Text>
            {(consignmentData.packages || []).map((pkg: any) => (
              <View key={pkg.id} style={styles.packageItemCard}>
                <View style={styles.packageItemHeader}>
                  <Feather name="package" size={16} color="#64748B" />
                  <Text style={styles.packageNumText}>{pkg.package_number}</Text>
                  <View style={[styles.statusBadgeSmall, { backgroundColor: getStatusColor(pkg.status) }]}>
                    <Text style={styles.statusBadgeTextSmall}>{getStatusText(pkg.status)}</Text>
                  </View>
                </View>
                <View style={styles.packageItemMeta}>
                  <Text style={styles.pkgMetaText}>Type: {pkg.package_type}</Text>
                  <Text style={styles.pkgMetaText}>Weight: {pkg.gross_weight_kg || 0} kg</Text>
                  <Text style={styles.pkgMetaText}>Items: {pkg.material_count || 0}</Text>
                </View>
              </View>
            ))}

            {submitting ? (
              <ActivityIndicator size="small" color="#4A1060" style={{ marginTop: 20 }} />
            ) : (
              <TouchableOpacity
                style={[
                  styles.submitBtn,
                  ['CONSIGNMENT_RECEIVED', 'UNPACKED', 'RECEIVED'].includes(consignmentData.status) && styles.submitBtnDisabled
                ]}
                disabled={['CONSIGNMENT_RECEIVED', 'UNPACKED', 'RECEIVED'].includes(consignmentData.status)}
                onPress={handleConfirmConsignmentDelivery}
              >
                <Text style={styles.submitBtnText}>Confirm Consignment Delivery</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* CASE B: Package Details & Verification */}
        {activeScanType === 'package' && packageData && (
          <View style={styles.detailsCard}>
            <View style={styles.cardHeader}>
              <Feather name="package" size={22} color="#4A1060" />
              <View style={styles.headerInfo}>
                <Text style={styles.cardTitle}>{packageData.package_number}</Text>
                <Text style={styles.cardSub}>Package Manifest ({packageData.package_type})</Text>
              </View>
              <View style={[styles.statusBadge, { backgroundColor: getStatusColor(packageData.status) }]}>
                <Text style={styles.statusBadgeText}>{getStatusText(packageData.status)}</Text>
              </View>
            </View>

            {packageData.consignment_status && !['CONSIGNMENT_RECEIVED', 'PARTIALLY_UNPACKED'].includes(packageData.consignment_status) && !['UNPACKED', 'PARTIALLY_UNPACKED', 'RECEIVED', 'PARTIALLY_RECEIVED'].includes(packageData.status) && (
              <View style={styles.warningBanner}>
                <Text style={styles.warningText}>
                  ⚠️ Consignment {packageData.consignment_number} must be acknowledged first before individual packages can be unpacked. Please scan the consignment barcode first.
                </Text>
              </View>
            )}

            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Receiver Target:</Text>
              <Text style={styles.infoVal}>{packageData.receiver_name || 'N/A'} ({packageData.receiver_employee_code || 'N/A'})</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Gross Weight:</Text>
              <Text style={styles.infoVal}>{packageData.gross_weight_kg || 0} kg</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Seal Number:</Text>
              <Text style={styles.infoVal}>{packageData.seal_number || 'N/A'}</Text>
            </View>

            <Text style={styles.packagesTitle}>Materials Manifest</Text>
            {(packageData.items || []).map((item: any) => {
              const qtyState = itemQtys[item.id] || { receivedQty: '0', acceptedQty: '0', condition: 'GOOD' };
              return (
                <View key={item.id} style={styles.manifestItemCard}>
                  <Text style={styles.matNameText}>{item.material_name}</Text>
                  <Text style={styles.matCodeText}>Code: {item.material_code}  |  Batch: {item.batch_number || '—'}</Text>
                  <Text style={styles.matPackedText}>Packed Qty: {item.quantity_packed}</Text>
                  
                  <View style={styles.qtysRow}>
                    <View style={styles.qtyCol}>
                      <Text style={styles.inputLabel}>Received</Text>
                      <TextInput
                        style={styles.qtyInput}
                        keyboardType="numeric"
                        value={qtyState.receivedQty}
                        onChangeText={(v) => updateItemQty(item.id, 'receivedQty', v)}
                      />
                    </View>
                    <View style={styles.qtyCol}>
                      <Text style={styles.inputLabel}>Accepted</Text>
                      <TextInput
                        style={styles.qtyInput}
                        keyboardType="numeric"
                        value={qtyState.acceptedQty}
                        onChangeText={(v) => updateItemQty(item.id, 'acceptedQty', v)}
                      />
                    </View>
                  </View>

                  <Text style={styles.inputLabel}>Condition</Text>
                  <View style={styles.conditionToggles}>
                    {['GOOD', 'DAMAGED', 'DEFECTIVE'].map((cond) => (
                      <TouchableOpacity
                        key={cond}
                        style={[
                          styles.condToggleBtn,
                          qtyState.condition === cond && styles.condToggleBtnActive
                        ]}
                        onPress={() => updateItemQty(item.id, 'condition', cond)}
                      >
                        <Text style={[
                          styles.condToggleBtnText,
                          qtyState.condition === cond && styles.condToggleBtnTextActive
                        ]}>
                          {cond}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  {item.serial_numbers && item.serial_numbers.length > 0 && (
                    <View style={styles.serialBox}>
                      <Text style={styles.serialBoxTitle}>Tracked Serials:</Text>
                      <Text style={styles.serialBoxList}>{item.serial_numbers.join(', ')}</Text>
                    </View>
                  )}
                </View>
              );
            })}

            <Text style={styles.packagesTitle}>Signatory & Receipt details</Text>
            
            <Text style={styles.formLabel}>Receiver Name *</Text>
            <TextInput
              style={styles.formInput}
              value={acknowledgedByName}
              onChangeText={setAcknowledgedByName}
            />

            <Text style={styles.formLabel}>Employee Code *</Text>
            <TextInput
              style={styles.formInput}
              value={acknowledgedByEmployeeCode}
              onChangeText={setAcknowledgedByEmployeeCode}
            />

            <Text style={styles.formLabel}>Contact Number *</Text>
            <TextInput
              style={styles.formInput}
              keyboardType="phone-pad"
              value={acknowledgedByPhone}
              onChangeText={setAcknowledgedByPhone}
            />

            <Text style={styles.formLabel}>Designation</Text>
            <TextInput
              style={styles.formInput}
              value={acknowledgedByDesignation}
              onChangeText={setAcknowledgedByDesignation}
            />

            <Text style={styles.formLabel}>Department</Text>
            <TextInput
              style={styles.formInput}
              value={acknowledgedByDepartment}
              onChangeText={setAcknowledgedByDepartment}
            />

            <Text style={styles.formLabel}>Packaging Condition</Text>
            <View style={styles.toggleRow}>
              <TouchableOpacity
                style={[styles.toggleBtn, packagingCondition === 'INTACT' && styles.toggleBtnActive]}
                onPress={() => setPackagingCondition('INTACT')}
              >
                <Text style={[styles.toggleBtnText, packagingCondition === 'INTACT' && styles.toggleBtnTextActive]}>Intact</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toggleBtn, packagingCondition === 'DAMAGED' && styles.toggleBtnActive]}
                onPress={() => setPackagingCondition('DAMAGED')}
              >
                <Text style={[styles.toggleBtnText, packagingCondition === 'DAMAGED' && styles.toggleBtnTextActive]}>Damaged</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.formLabel}>Seal Intact?</Text>
            <View style={styles.toggleRow}>
              <TouchableOpacity
                style={[styles.toggleBtn, sealIntact === true && styles.toggleBtnActive]}
                onPress={() => setSealIntact(true)}
              >
                <Text style={[styles.toggleBtnText, sealIntact === true && styles.toggleBtnTextActive]}>Yes</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toggleBtn, sealIntact === false && styles.toggleBtnActive]}
                onPress={() => setSealIntact(false)}
              >
                <Text style={[styles.toggleBtnText, sealIntact === false && styles.toggleBtnTextActive]}>No</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.formLabel}>Remarks</Text>
            <TextInput
              style={[styles.formInput, styles.textArea]}
              multiline={true}
              numberOfLines={3}
              value={remarks}
              onChangeText={setRemarks}
            />

            {submitting ? (
              <ActivityIndicator size="small" color="#4A1060" style={{ marginTop: 20 }} />
            ) : (
              <TouchableOpacity
                style={[
                  styles.submitBtn,
                  (['UNPACKED', 'RECEIVED'].includes(packageData.status) || 
                    (packageData.consignment_status && !['CONSIGNMENT_RECEIVED', 'PARTIALLY_UNPACKED'].includes(packageData.consignment_status))) && 
                    styles.submitBtnDisabled
                ]}
                disabled={
                  ['UNPACKED', 'RECEIVED'].includes(packageData.status) || 
                  (packageData.consignment_status && !['CONSIGNMENT_RECEIVED', 'PARTIALLY_UNPACKED'].includes(packageData.consignment_status))
                }
                onPress={handleSubmitPackageAcknowledgement}
              >
                <Text style={styles.submitBtnText}>Submit Package Acknowledgement</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F6F2F0',
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#F6F2F0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#4A1060',
    fontWeight: '600',
  },
  appBar: {
    paddingTop: Platform.OS === 'ios' ? 0 : 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  appBarContent: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  appBarTitleContainer: {
    justifyContent: 'center',
  },
  appBarTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#ffffff',
  },
  appBarSub: {
    fontSize: 10,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.7)',
    marginTop: 1,
  },
  scrollContent: {
    padding: 16,
  },
  scanSection: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#EDE7E3',
    marginBottom: 16,
    shadowColor: '#2A0E2F',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.03,
    shadowRadius: 4,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#4A1060',
    marginBottom: 8,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  searchInput: {
    flex: 1,
    height: 42,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 8,
    paddingHorizontal: 12,
    backgroundColor: '#F8FAFC',
    fontSize: 14,
    color: '#0F172A',
  },
  searchBtn: {
    width: 44,
    height: 42,
    backgroundColor: '#4A1060',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailsCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#EDE7E3',
    shadowColor: '#2A0E2F',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.03,
    shadowRadius: 4,
    marginBottom: 20,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
    paddingBottom: 12,
  },
  headerInfo: {
    flex: 1,
    marginLeft: 10,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0F172A',
  },
  cardSub: {
    fontSize: 11,
    color: '#64748B',
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
  },
  statusBadgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
  },
  infoRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  infoLabel: {
    width: 120,
    fontSize: 13,
    fontWeight: '600',
    color: '#64748B',
  },
  infoVal: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: '#1E293B',
  },
  packagesTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#4A1060',
    marginTop: 20,
    marginBottom: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#4A1060',
    paddingLeft: 8,
  },
  packageItemCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 12,
    marginBottom: 10,
  },
  packageItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  packageNumText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0F172A',
    marginLeft: 6,
    flex: 1,
  },
  statusBadgeSmall: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  statusBadgeTextSmall: {
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '700',
  },
  packageItemMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  pkgMetaText: {
    fontSize: 11,
    color: '#64748B',
    fontWeight: '500',
  },
  manifestItemCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 12,
    marginBottom: 12,
  },
  matNameText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 2,
  },
  matCodeText: {
    fontSize: 11,
    color: '#64748B',
    marginBottom: 6,
  },
  matPackedText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#4A1060',
    marginBottom: 12,
  },
  qtysRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  qtyCol: {
    flex: 1,
  },
  inputLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748B',
    marginBottom: 4,
  },
  qtyInput: {
    height: 38,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 6,
    backgroundColor: '#ffffff',
    paddingHorizontal: 8,
    fontSize: 14,
    fontWeight: '600',
    color: '#0F172A',
  },
  conditionToggles: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 12,
  },
  condToggleBtn: {
    flex: 1,
    height: 32,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
  },
  condToggleBtnActive: {
    backgroundColor: '#4A1060',
    borderColor: '#4A1060',
  },
  condToggleBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748B',
  },
  condToggleBtnTextActive: {
    color: '#ffffff',
  },
  serialBox: {
    backgroundColor: '#E0F2FE',
    borderRadius: 6,
    padding: 8,
    marginTop: 4,
  },
  serialBoxTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0369A1',
    marginBottom: 2,
  },
  serialBoxList: {
    fontSize: 11,
    color: '#0E7490',
    lineHeight: 14,
  },
  formLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
    marginBottom: 6,
    marginTop: 10,
  },
  formInput: {
    height: 40,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 8,
    paddingHorizontal: 12,
    backgroundColor: '#FFFFFF',
    fontSize: 14,
    color: '#0F172A',
    marginBottom: 12,
  },
  textArea: {
    height: 80,
    textAlignVertical: 'top',
    paddingTop: 8,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  toggleBtn: {
    flex: 1,
    height: 38,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
  },
  toggleBtnActive: {
    backgroundColor: '#4A1060',
    borderColor: '#4A1060',
  },
  toggleBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748B',
  },
  toggleBtnTextActive: {
    color: '#ffffff',
  },
  submitBtn: {
    height: 46,
    backgroundColor: '#4A1060',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
  },
  submitBtnDisabled: {
    backgroundColor: '#CBD5E1',
  },
  submitBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  warningBanner: {
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FDE68A',
    borderRadius: 8,
    padding: 10,
    marginBottom: 14,
  },
  warningText: {
    fontSize: 12,
    color: '#B45309',
    lineHeight: 16,
    fontWeight: '600',
  },
  scanBtn: {
    width: 44,
    height: 42,
    backgroundColor: '#7C3AED',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scannerContainer: {
    flex: 1,
    backgroundColor: '#000000',
  },
  scannerOverlay: {
    flex: 1,
    backgroundColor: 'transparent',
    justifyContent: 'space-between',
    padding: 16,
  },
  scannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: Platform.OS === 'ios' ? 10 : 30,
    backgroundColor: 'rgba(0,0,0,0.6)',
    padding: 12,
    borderRadius: 8,
  },
  scannerCloseBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scannerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#ffffff',
    marginLeft: 10,
  },
  scannerTargetContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 80,
  },
  scannerTarget: {
    width: 250,
    height: 250,
    borderWidth: 2.5,
    borderColor: '#10B981',
    borderRadius: 16,
    backgroundColor: 'transparent',
  },
  scannerInstruction: {
    fontSize: 14,
    color: '#ffffff',
    marginTop: 16,
    fontWeight: '600',
    textAlign: 'center',
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: -1, height: 1 },
    textShadowRadius: 10,
  },
});

