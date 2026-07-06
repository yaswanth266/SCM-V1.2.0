import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
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

// ─── Lightweight Icon Renderer ───────────────────────────────────────────────
const Icon = ({ name, size = 18, color = '#7A6D66' }: { name: string; size?: number; color?: string }) => {
  if (name === 'arrow-left') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.32, height: size * 0.32, borderBottomWidth: 2, borderLeftWidth: 2, borderColor: color, transform: [{ rotate: '45deg' }, { translateX: size * 0.06 }] }} />
        <View style={{ position: 'absolute', width: size * 0.6, height: 2, backgroundColor: color }} />
      </View>
    );
  }
  if (name === 'bell') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.68, height: size * 0.6, borderRadius: size * 0.34, borderTopLeftRadius: size * 0.34, borderTopRightRadius: size * 0.34, borderWidth: 1.8, borderColor: color, borderBottomWidth: 0, marginBottom: 1 }} />
        <View style={{ width: size * 0.3, height: size * 0.15, borderBottomLeftRadius: size * 0.15, borderBottomRightRadius: size * 0.15, borderWidth: 1.8, borderTopWidth: 0, borderColor: color }} />
      </View>
    );
  }
  if (name === 'check-all') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.24, height: size * 0.42, borderBottomWidth: 2, borderRightWidth: 2, borderColor: color, transform: [{ rotate: '45deg' }, { translateY: -size * 0.04 }] }} />
        <View style={{ position: 'absolute', left: 4, width: size * 0.24, height: size * 0.42, borderBottomWidth: 2, borderRightWidth: 2, borderColor: color, transform: [{ rotate: '45deg' }, { translateY: -size * 0.04 }] }} />
      </View>
    );
  }
  if (name === 'inbox') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.8, height: size * 0.65, borderRadius: 3, borderWidth: 1.8, borderColor: color, justifyContent: 'flex-end', paddingBottom: 2 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
            <View style={{ width: size * 0.22, height: size * 0.16, borderTopLeftRadius: size * 0.1, borderTopRightRadius: size * 0.1, borderWidth: 1.5, borderBottomWidth: 0, borderColor: color }} />
          </View>
        </View>
      </View>
    );
  }
  return null;
};

// ─── Notification type → colours ─────────────────────────────────────────────
const TYPE_META: Record<string, { dot: string; bg: string; label: string }> = {
  approval:     { dot: '#7C3AED', bg: '#F5F3FF', label: 'Approval' },
  indent:       { dot: '#2563EB', bg: '#EFF6FF', label: 'Indent' },
  alert:        { dot: '#DC2626', bg: '#FEF2F2', label: 'Alert' },
  info:         { dot: '#0284C7', bg: '#F0F9FF', label: 'Info' },
  warning:      { dot: '#D97706', bg: '#FFFBEB', label: 'Warning' },
  success:      { dot: '#16A34A', bg: '#F0FDF4', label: 'Success' },
  default:      { dot: '#64748B', bg: '#F8FAFC', label: 'Notification' },
};

function getMeta(type: string) {
  return TYPE_META[type?.toLowerCase?.()] || TYPE_META.default;
}

function timeAgo(dateStr: string) {
  if (!dateStr) return '';
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function Notifications() {
  const [token, setToken]           = useState('');
  const [apiUrl, setApiUrl]         = useState('');
  const [items, setItems]           = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);

  // Load session
  useEffect(() => {
    const init = async () => {
      const t   = await AsyncStorage.getItem('user_token');
      const url = await AsyncStorage.getItem('API_URL');
      if (!t) { router.replace('/'); return; }
      setToken(t);
      setApiUrl(url || 'http://10.2.1.31:8000');
    };
    init();
  }, []);

  // Fetch notifications
  const fetchNotifications = useCallback(async (showLoader = true) => {
    if (!token || !apiUrl) return;
    if (showLoader) setLoading(true);
    try {
      const res = await axios.get(`${apiUrl}/api/v1/notifications?page_size=50`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setItems(res.data?.items || []);
    } catch (e) {
      console.error('Failed to load notifications:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token, apiUrl]);

  useEffect(() => {
    if (token && apiUrl) fetchNotifications();
  }, [token, apiUrl, fetchNotifications]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchNotifications(false);
  };

  const markRead = async (id: number) => {
    try {
      await axios.post(`${apiUrl}/api/v1/notifications/${id}/read`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setItems(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
    } catch (_) {}
  };

  const markAllRead = async () => {
    setMarkingAll(true);
    try {
      await axios.post(`${apiUrl}/api/v1/notifications/read-all`, {}, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setItems(prev => prev.map(n => ({ ...n, is_read: true })));
    } catch (_) {}
    setMarkingAll(false);
  };

  const unread = items.filter(n => !n.is_read).length;

  // ── Render each notification row ──
  const renderItem = ({ item }: { item: any }) => {
    const meta = getMeta(item.type);
    return (
      <TouchableOpacity
        style={[styles.notifCard, !item.is_read && styles.notifCardUnread]}
        activeOpacity={0.75}
        onPress={() => !item.is_read && markRead(item.id)}
      >
        {/* Coloured accent dot */}
        <View style={[styles.notifDot, { backgroundColor: meta.dot }]} />

        {/* Icon area */}
        <View style={[styles.notifIconBox, { backgroundColor: meta.bg }]}>
          <Icon name="bell" size={16} color={meta.dot} />
        </View>

        {/* Content */}
        <View style={styles.notifContent}>
          <View style={styles.notifTopRow}>
            <Text style={[styles.notifTitle, !item.is_read && styles.notifTitleUnread]} numberOfLines={1}>
              {item.title || meta.label}
            </Text>
            <Text style={styles.notifTime}>{timeAgo(item.created_at)}</Text>
          </View>
          {!!item.message && (
            <Text style={styles.notifMessage} numberOfLines={2}>{item.message}</Text>
          )}
          {!item.is_read && (
            <View style={[styles.notifTypePill, { backgroundColor: meta.bg }]}>
              <Text style={[styles.notifTypePillText, { color: meta.dot }]}>New</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* ── App Bar ── */}
      <LinearGradient
        colors={['#481238', '#3A0F40', '#481238']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.appBar}
      >
        <SafeAreaView>
          <View style={styles.appBarContent}>
            <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
              <Icon name="arrow-left" size={20} color="#ffffff" />
            </TouchableOpacity>
            <Text style={styles.appBarTitle}>Notifications</Text>
            {unread > 0 ? (
              <TouchableOpacity
                style={styles.markAllBtn}
                onPress={markAllRead}
                disabled={markingAll}
              >
                {markingAll
                  ? <ActivityIndicator size="small" color="#ffffff" />
                  : <Text style={styles.markAllText}>Mark all read</Text>
                }
              </TouchableOpacity>
            ) : (
              <View style={{ width: 80 }} />
            )}
          </View>
        </SafeAreaView>
      </LinearGradient>

      {/* ── Content ── */}
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#481238" />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.centered}>
          <View style={styles.emptyIcon}>
            <Icon name="inbox" size={40} color="#C4BAB5" />
          </View>
          <Text style={styles.emptyTitle}>All caught up!</Text>
          <Text style={styles.emptyDesc}>You have no notifications right now.</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={item => String(item.id)}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor="#481238"
              colors={['#481238']}
            />
          }
          ListHeaderComponent={
            unread > 0 ? (
              <View style={styles.unreadBanner}>
                <View style={styles.unreadDot} />
                <Text style={styles.unreadBannerText}>{unread} unread notification{unread !== 1 ? 's' : ''}</Text>
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F6F2F0',
  },
  appBar: {
    paddingTop: Platform.OS === 'ios' ? 0 : 12,
  },
  appBarContent: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    justifyContent: 'space-between',
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  appBarTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.4,
  },
  markAllBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.15)',
    minWidth: 80,
    alignItems: 'center',
  },
  markAllText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: 60,
  },
  emptyIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#F0EBE8',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1A1220',
    marginBottom: 6,
  },
  emptyDesc: {
    fontSize: 14,
    color: '#7A6D66',
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 32,
  },
  unreadBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    gap: 8,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#FF3B6A',
  },
  unreadBannerText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#475569',
  },
  notifCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#EDE7E3',
    shadowColor: '#2A0E2F',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 5,
    position: 'relative',
    overflow: 'hidden',
  },
  notifCardUnread: {
    borderColor: '#D4C8F0',
    backgroundColor: '#FDFBFF',
  },
  notifDot: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
    borderTopLeftRadius: 14,
    borderBottomLeftRadius: 14,
  },
  notifIconBox: {
    width: 38,
    height: 38,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
    marginLeft: 8,
    flexShrink: 0,
  },
  notifContent: {
    flex: 1,
  },
  notifTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 3,
  },
  notifTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#475569',
    marginRight: 8,
  },
  notifTitleUnread: {
    color: '#0F172A',
    fontWeight: '700',
  },
  notifTime: {
    fontSize: 11,
    color: '#94A3B8',
    flexShrink: 0,
  },
  notifMessage: {
    fontSize: 12.5,
    color: '#64748B',
    lineHeight: 18,
    marginBottom: 6,
  },
  notifTypePill: {
    alignSelf: 'flex-start',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  notifTypePillText: {
    fontSize: 10.5,
    fontWeight: '700',
  },
});
