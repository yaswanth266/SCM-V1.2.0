import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Image,
  TouchableOpacity,
  ScrollView,
  Alert,
  Platform,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import { router, useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';

// ─── Lightweight Icon Renderer ───────────────────────────────────────────────
const Icon = ({ name, size = 18, color = '#7A6D66' }: { name: string; size?: number; color?: string }) => {
  if (name === 'user') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.42, height: size * 0.42, borderRadius: (size * 0.42) / 2, borderWidth: 1.5, borderColor: color }} />
        <View style={{ width: size * 0.8, height: size * 0.3, borderTopLeftRadius: 6, borderTopRightRadius: 6, borderWidth: 1.5, borderColor: color, borderBottomWidth: 0, marginTop: 1 }} />
      </View>
    );
  }
  if (name === 'bell') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.68, height: size * 0.6, borderRadius: size * 0.34, borderTopLeftRadius: size * 0.34, borderTopRightRadius: size * 0.34, borderWidth: 1.8, borderColor: color, borderBottomWidth: 0, marginBottom: 1 }} />
        <View style={{ width: size * 0.3, height: size * 0.15, borderBottomLeftRadius: size * 0.15, borderBottomRightRadius: size * 0.15, borderWidth: 1.8, borderTopWidth: 0, borderColor: color }} />
        <View style={{ width: size * 0.22, height: size * 0.1, borderBottomLeftRadius: size * 0.05, borderBottomRightRadius: size * 0.05, borderWidth: 1.5, borderTopWidth: 0, borderColor: color, marginTop: 1 }} />
      </View>
    );
  }
  if (name === 'chevron-right') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.3, height: size * 0.3, borderTopWidth: 1.8, borderRightWidth: 1.8, borderColor: color, transform: [{ rotate: '45deg' }, { translateX: -size * 0.05 }] }} />
      </View>
    );
  }
  if (name === 'file-text') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.65, height: size * 0.8, borderRadius: 2, borderWidth: 1.8, borderColor: color, padding: 3, justifyContent: 'center', gap: 2.5 }}>
          <View style={{ width: '70%', height: 1.5, backgroundColor: color }} />
          <View style={{ width: '90%', height: 1.5, backgroundColor: color }} />
          <View style={{ width: '50%', height: 1.5, backgroundColor: color }} />
        </View>
      </View>
    );
  }
  if (name === 'check-square') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.75, height: size * 0.75, borderRadius: 3, borderWidth: 1.8, borderColor: color, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: size * 0.2, height: size * 0.38, borderBottomWidth: 1.8, borderRightWidth: 1.8, borderColor: color, transform: [{ rotate: '45deg' }, { translateY: -size * 0.04 }, { translateX: size * 0.02 }] }} />
        </View>
      </View>
    );
  }
  if (name === 'thumbs-up') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.7, height: size * 0.78, borderBottomLeftRadius: size * 0.35, borderBottomRightRadius: size * 0.35, borderTopLeftRadius: 1, borderTopRightRadius: 1, borderWidth: 1.8, borderColor: color, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: size * 0.18, height: size * 0.32, borderBottomWidth: 1.5, borderRightWidth: 1.5, borderColor: color, transform: [{ rotate: '45deg' }, { translateY: -size * 0.02 }] }} />
        </View>
      </View>
    );
  }
  if (name === 'log-out') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center' }}>
        <View style={{ width: size * 0.65, height: size * 0.75, borderWidth: 1.8, borderColor: color, borderRightWidth: 0, borderRadius: 2 }} />
        <View style={{ position: 'absolute', left: size * 0.32, flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ width: size * 0.45, height: 1.8, backgroundColor: color }} />
          <View style={{ width: size * 0.22, height: size * 0.22, borderTopWidth: 1.8, borderRightWidth: 1.8, borderColor: color, transform: [{ rotate: '45deg' }, { translateX: -size * 0.06 }] }} />
        </View>
      </View>
    );
  }
  if (name === 'truck') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: size * 0.55, height: size * 0.4, borderWidth: 1.8, borderColor: color, borderRadius: 2, marginRight: size * 0.15 }} />
        <View style={{ width: size * 0.25, height: size * 0.3, borderWidth: 1.8, borderColor: color, borderLeftWidth: 0, position: 'absolute', right: 0, top: size * 0.3, borderTopRightRadius: 2 }} />
        <View style={{ flexDirection: 'row', gap: size * 0.2, marginTop: 2 }}>
          <View style={{ width: size * 0.16, height: size * 0.16, borderRadius: size * 0.08, borderWidth: 1.5, borderColor: color }} />
          <View style={{ width: size * 0.16, height: size * 0.16, borderRadius: size * 0.08, borderWidth: 1.5, borderColor: color }} />
        </View>
      </View>
    );
  }
  if (name === 'shopping-cart') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: size * 0.6, height: size * 0.4, borderWidth: 1.8, borderColor: color, borderTopWidth: 0, borderRightWidth: 1.8, borderBottomLeftRadius: 2, marginRight: 2 }} />
        <View style={{ width: size * 0.2, height: 1.8, backgroundColor: color, alignSelf: 'flex-start', marginLeft: 2 }} />
        <View style={{ flexDirection: 'row', gap: size * 0.2, marginTop: 2 }}>
          <View style={{ width: size * 0.16, height: size * 0.16, borderRadius: size * 0.08, borderWidth: 1.5, borderColor: color }} />
          <View style={{ width: size * 0.16, height: size * 0.16, borderRadius: size * 0.08, borderWidth: 1.5, borderColor: color }} />
        </View>
      </View>
    );
  }
  if (name === 'archive') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center', gap: 2 }}>
        <View style={{ width: size * 0.75, height: size * 0.25, borderWidth: 1.8, borderColor: color, borderRadius: 1 }} />
        <View style={{ width: size * 0.65, height: size * 0.4, borderWidth: 1.8, borderColor: color, borderTopWidth: 0, borderBottomLeftRadius: 1, borderBottomRightRadius: 1 }} />
        <View style={{ width: size * 0.25, height: 1.5, backgroundColor: color, position: 'absolute', top: size * 0.45 }} />
      </View>
    );
  }
  if (name === 'database') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center', gap: 1.8 }}>
        <View style={{ width: size * 0.65, height: size * 0.2, borderRadius: size * 0.1, borderWidth: 1.8, borderColor: color }} />
        <View style={{ width: size * 0.65, height: size * 0.2, borderRadius: size * 0.1, borderWidth: 1.8, borderColor: color }} />
        <View style={{ width: size * 0.65, height: size * 0.2, borderRadius: size * 0.1, borderWidth: 1.8, borderColor: color }} />
      </View>
    );
  }
  if (name === 'pie-chart') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: size * 0.75, height: size * 0.75, borderRadius: (size * 0.75) / 2, borderWidth: 1.8, borderColor: color, borderRightColor: 'transparent', borderBottomColor: 'transparent', transform: [{ rotate: '45deg' }] }} />
        <View style={{ width: size * 0.4, height: size * 0.4, borderTopLeftRadius: size * 0.4, borderTopWidth: 1.8, borderLeftWidth: 1.8, borderColor: color, position: 'absolute', top: size * 0.15, right: size * 0.15 }} />
      </View>
    );
  }
  if (name === 'dollar-sign') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: size * 0.4, height: size * 0.7, borderWidth: 1.8, borderColor: color, borderRadius: 4 }} />
        <View style={{ width: 1.8, height: size * 0.85, backgroundColor: color, position: 'absolute' }} />
      </View>
    );
  }
  if (name === 'tool') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: size * 0.5, height: size * 0.5, borderWidth: 1.8, borderColor: color, borderBottomRightRadius: 0, transform: [{ rotate: '45deg' }] }} />
        <View style={{ width: size * 0.18, height: size * 0.5, backgroundColor: color, transform: [{ rotate: '-45deg' }] }} />
      </View>
    );
  }
  if (name === 'x') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ position: 'absolute', width: size * 0.7, height: 2, backgroundColor: color, transform: [{ rotate: '45deg' }] }} />
        <View style={{ position: 'absolute', width: size * 0.7, height: 2, backgroundColor: color, transform: [{ rotate: '-45deg' }] }} />
      </View>
    );
  }
  return null;
};

const Feather = ({ name, size, color }: { name: string; size?: number; color?: string }) => (
  <Icon name={name} size={size} color={color} />
);

// ─── Component ───────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [token, setToken] = useState<string>('');
  const [apiUrl, setApiUrl] = useState<string>('');
  const [user, setUser] = useState<any>(null);
  const [allowedKeys, setAllowedKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [unreadCount, setUnreadCount] = useState<number>(0);

  useFocusEffect(
    useCallback(() => {
      let isMounted = true;

      const loadSessionAndData = async () => {
        try {
          const savedToken = await AsyncStorage.getItem('user_token');
          const savedUserStr = await AsyncStorage.getItem('user_profile');
          const savedApiUrl = await AsyncStorage.getItem('API_URL');

          if (!savedToken || !savedUserStr) {
            if (isMounted) router.replace('/');
            return;
          }

          const parsedUser = JSON.parse(savedUserStr);
          const activeApiUrl = savedApiUrl || 'http://10.2.1.31:8000';

          if (isMounted) {
            setToken(savedToken);
            setUser(parsedUser);
            setApiUrl(activeApiUrl);
          }

          // Fetch sidebar permissions and unread notifications directly using the fresh token/url
          try {
            const response = await axios.get(`${activeApiUrl}/api/v1/me/sidebar`, {
              headers: { Authorization: `Bearer ${savedToken}` },
            });
            if (isMounted && response.data && response.data.allowed_keys) {
              setAllowedKeys(response.data.allowed_keys);
            }
          } catch (e) {
            console.error('Failed to fetch sidebar permissions:', e);
          }

          try {
            const response = await axios.get(`${activeApiUrl}/api/v1/notifications/unread-count`, {
              headers: { Authorization: `Bearer ${savedToken}` },
            });
            if (isMounted && response.data && typeof response.data.unread_count === 'number') {
              setUnreadCount(response.data.unread_count);
            }
          } catch (e) {
            // Silently ignore
          }
        } catch (e) {
          console.error('Error loading session:', e);
          if (isMounted) router.replace('/');
        } finally {
          if (isMounted) setLoading(false);
        }
      };

      loadSessionAndData();

      return () => {
        isMounted = false;
      };
    }, [])
  );

  const getWebUrl = (apiUri: string) => {
    try {
      const url = new URL(apiUri);
      if (url.port === '8000') {
        url.port = '3000';
      }
      return url.origin;
    } catch (e) {
      return apiUri.replace(':8000', ':3000');
    }
  };

  const openWebPage = async (path: string) => {
    try {
      const webBase = getWebUrl(apiUrl);
      const url = `${webBase}${path}?token=${encodeURIComponent(token)}`;
      await WebBrowser.openBrowserAsync(url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.AUTOMATIC,
      });
    } catch (error) {
      console.error('Failed to open WebBrowser:', error);
      Alert.alert('Navigation Error', 'Could not open the requested page.');
    }
  };

  if (loading || !user) {
    return (
      <View style={[styles.homeContainer, { justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ color: '#4A0E4E', fontWeight: 'bold' }}>Loading dashboard...</Text>
      </View>
    );
  }

  const fullName = user?.full_name || user?.username || 'User';

  const activeRole = user?.role?.toLowerCase() || '';
  const isSuperAdminOrAdmin = activeRole === 'super_admin' || activeRole === 'admin';

  const activePositionObj = user?.positions?.find((p: any) => p.id === user.position_id);
  const activeRoleObj = user?.roles?.find((r: any) => r.code === user.role);
  const displayRoleName = activePositionObj?.name || activeRoleObj?.name || user?.role || 'Viewer';

  const showIndents = allowedKeys.length > 0
    ? (allowedKeys.includes('indent') || allowedKeys.includes('indent-indents'))
    : (isSuperAdminOrAdmin || activeRole === 'field_staff' || activeRole === 'lab_technician' || activeRole === 'store_keeper' || activeRole === 'storekeeper' || activeRole === 'viewer');

  const showAcknowledgment = allowedKeys.length > 0
    ? (allowedKeys.includes('indent-acknowledgement') || allowedKeys.includes('indent'))
    : (isSuperAdminOrAdmin || activeRole === 'field_staff' || activeRole === 'lab_technician' || activeRole === 'viewer');

  const showApprovals = allowedKeys.length > 0
    ? (allowedKeys.includes('approvals') || allowedKeys.includes('approvals-pending'))
    : (isSuperAdminOrAdmin || activeRole === 'field_supervisor' || activeRole === 'warehouse_manager' || activeRole === 'purchase_manager' || activeRole === 'accounts_manager' || activeRole === 'project_manager');

  const showLogistics = allowedKeys.length > 0
    ? (allowedKeys.includes('logistics') || allowedKeys.includes('logistics-dashboard'))
    : isSuperAdminOrAdmin;

  return (
    <View style={styles.homeContainer}>
      {/* ── App Bar ── */}
      <LinearGradient
        colors={['#481238', '#3A0F40', '#481238']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.appBar}
      >
        <SafeAreaView style={styles.appBarSafe}>
          <View style={styles.appBarContent}>
            {/* Left: Logo + Title */}
            <View style={styles.appBarLeft}>
              <Image
                source={require('../../assets/bavya-mark.png')}
                style={styles.appBarLogo}
              />
              <View style={styles.appBarTextContainer}>
                <Text style={styles.appBarTitle}>BAVYA SCM</Text>
                <Text style={styles.appBarSub}>SUPPLY CHAIN MANAGEMENT</Text>
              </View>
            </View>

            {/* Right: Notifications + Profile */}
            <View style={styles.appBarRight}>
              {/* Bell / Notifications button */}
              <TouchableOpacity
                style={styles.appBarIconBtn}
                activeOpacity={0.7}
                onPress={() => router.push('/notifications')}
              >
                <Feather name="bell" size={20} color="#ffffff" />
                {unreadCount > 0 && (
                  <View style={styles.notifBadge}>
                    <Text style={styles.notifBadgeText}>
                      {unreadCount > 9 ? '9+' : String(unreadCount)}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>

              {/* Profile avatar button */}
              <TouchableOpacity
                style={styles.appBarAvatar}
                activeOpacity={0.7}
                onPress={() => router.push('/profile')}
              >
                <Text style={styles.appBarAvatarText}>
                  {fullName.substring(0, 2).toUpperCase()}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </SafeAreaView>
      </LinearGradient>

      <ScrollView contentContainerStyle={styles.homeScroll}>
        {/* ── Greeting Banner ── */}
        <LinearGradient
          colors={['#4A1060', '#3A0F40']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.greetingCard}
        >
          <View>
            <Text style={styles.greetingLabel}>Welcome back 👋</Text>
            <Text style={styles.greetingName}>{fullName}</Text>
          </View>
          <View style={styles.greetingRolePill}>
            <Text style={styles.greetingRoleText} numberOfLines={1}>
              {displayRoleName}
            </Text>
          </View>
        </LinearGradient>

        {/* ── Dashboard Module Cards ── */}
        {(showIndents || showAcknowledgment || showApprovals) && (
          <View style={styles.dashboardSection}>
            <Text style={styles.sectionTitle}>Quick Access</Text>

            {showIndents && (
              <TouchableOpacity
                style={styles.moduleCard}
                activeOpacity={0.7}
                onPress={() => router.push('/indents')}
              >
                <View style={[styles.moduleIconContainer, { backgroundColor: '#F0E8F8' }]}>
                  <Feather name="file-text" size={20} color="#481890" />
                </View>
                <View style={styles.moduleTextContainer}>
                  <Text style={styles.moduleTitle}>Field Indents</Text>
                  <Text style={styles.moduleDesc}>Create and track material indents for your location.</Text>
                </View>
                <Feather name="chevron-right" size={18} color="#94A3B8" />
              </TouchableOpacity>
            )}

             {showAcknowledgment && (
              <TouchableOpacity
                style={styles.moduleCard}
                activeOpacity={0.7}
                onPress={() => router.push('/acknowledgement-selector')}
              >
                <View style={[styles.moduleIconContainer, { backgroundColor: '#E6F7F0' }]}>
                  <Feather name="check-square" size={20} color="#10B981" />
                </View>
                <View style={styles.moduleTextContainer}>
                  <Text style={styles.moduleTitle}>Acknowledgement</Text>
                  <Text style={styles.moduleDesc}>Acknowledge received materials and confirm quantities.</Text>
                </View>
                <Feather name="chevron-right" size={18} color="#94A3B8" />
              </TouchableOpacity>
            )}

            {showApprovals && (
              <TouchableOpacity
                style={styles.moduleCard}
                activeOpacity={0.7}
                onPress={() => router.push('/approvals')}
              >
                <View style={[styles.moduleIconContainer, { backgroundColor: '#FDE8EE' }]}>
                  <Feather name="thumbs-up" size={20} color="#D80048" />
                </View>
                <View style={styles.moduleTextContainer}>
                  <Text style={styles.moduleTitle}>Pending Approvals</Text>
                  <Text style={styles.moduleDesc}>Review and approve pending workflow requests.</Text>
                </View>
                <Feather name="chevron-right" size={18} color="#94A3B8" />
              </TouchableOpacity>
            )}
          </View>
        )}

      </ScrollView>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  homeContainer: {
    flex: 1,
    backgroundColor: '#F6F2F0',
  },
  appBar: {
    paddingTop: Platform.OS === 'ios' ? 0 : 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  appBarSafe: {
    justifyContent: 'center',
  },
  appBarContent: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  appBarLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  appBarLogo: {
    width: 32,
    height: 32,
    marginRight: 10,
  },
  appBarTextContainer: {
    justifyContent: 'center',
  },
  appBarTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: 1,
  },
  appBarSub: {
    fontSize: 9,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.65)',
    letterSpacing: 2,
    marginTop: 1,
  },
  appBarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  appBarIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  notifBadge: {
    position: 'absolute',
    top: 3,
    right: 3,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#FF3B6A',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 2,
  },
  notifBadgeText: {
    fontSize: 8,
    fontWeight: '800',
    color: '#fff',
  },
  appBarAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.22)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  appBarAvatarText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
  },
  homeScroll: {
    padding: 20,
    alignItems: 'stretch',
  },
  greetingCard: {
    borderRadius: 16,
    paddingHorizontal: 20,
    paddingVertical: 18,
    marginBottom: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  greetingLabel: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.72)',
    marginBottom: 4,
  },
  greetingName: {
    fontSize: 20,
    fontWeight: '800',
    color: '#ffffff',
  },
  greetingRolePill: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    maxWidth: 130,
  },
  greetingRoleText: {
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.9)',
  },
  dashboardSection: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1E293B',
    marginBottom: 12,
  },
  moduleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#EDE7E3',
    marginBottom: 12,
    shadowColor: '#2A0E2F',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
  },
  moduleIconContainer: {
    width: 44,
    height: 44,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  moduleTextContainer: {
    flex: 1,
  },
  moduleTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 2,
  },
  moduleDesc: {
    fontSize: 12,
    color: '#64748B',
    lineHeight: 17,
  },
  logoutButton: {
    height: 48,
    backgroundColor: '#D80048',
    borderRadius: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    shadowColor: '#D80048',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    marginTop: 4,
    marginBottom: 28,
  },
  logoutButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
});
