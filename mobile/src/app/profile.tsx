import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import { router } from 'expo-router';
import { API_BASE_URL } from '../constants/config';

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
  if (name === 'user') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.42, height: size * 0.42, borderRadius: (size * 0.42) / 2, borderWidth: 1.8, borderColor: color }} />
        <View style={{ width: size * 0.8, height: size * 0.3, borderTopLeftRadius: 6, borderTopRightRadius: 6, borderWidth: 1.8, borderColor: color, borderBottomWidth: 0, marginTop: 1 }} />
      </View>
    );
  }
  if (name === 'mail') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.82, height: size * 0.6, borderRadius: 3, borderWidth: 1.8, borderColor: color }}>
          <View style={{ width: '100%', alignItems: 'center', paddingTop: 2 }}>
            <View style={{ width: size * 0.38, height: size * 0.22, borderBottomWidth: 1.5, borderRightWidth: 1.5, borderLeftWidth: 1.5, borderColor: color }} />
          </View>
        </View>
      </View>
    );
  }
  if (name === 'shield') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.7, height: size * 0.78, borderBottomLeftRadius: size * 0.35, borderBottomRightRadius: size * 0.35, borderTopLeftRadius: 2, borderTopRightRadius: 2, borderWidth: 1.8, borderColor: color }} />
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
  if (name === 'check-circle') {
    return (
      <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 1.8, borderColor: color, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.22, height: size * 0.38, borderBottomWidth: 2, borderRightWidth: 2, borderColor: color, transform: [{ rotate: '45deg' }, { translateY: -size * 0.05 }, { translateX: size * 0.02 }] }} />
      </View>
    );
  }
  if (name === 'check') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.25, height: size * 0.48, borderBottomWidth: 2, borderRightWidth: 2, borderColor: color, transform: [{ rotate: '45deg' }, { translateY: -size * 0.04 }] }} />
      </View>
    );
  }
  if (name === 'refresh-cw') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.6, height: size * 0.6, borderRadius: (size * 0.6) / 2, borderWidth: 1.8, borderColor: color, borderTopColor: 'transparent', transform: [{ rotate: '45deg' }] }} />
      </View>
    );
  }
  return null;
};

// ─── Row component ────────────────────────────────────────────────────────────
function InfoRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <View style={styles.infoIconWrap}>
        <Icon name={icon} size={16} color="#7A6D66" />
      </View>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} numberOfLines={2}>{value}</Text>
    </View>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function Profile() {
  const [user, setUser]           = useState<any>(null);
  const [loading, setLoading]     = useState(true);
  const [token, setToken]         = useState('');
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    const init = async () => {
      const savedUser   = await AsyncStorage.getItem('user_profile');
      const savedToken  = await AsyncStorage.getItem('user_token');
      if (!savedToken || !savedUser) { router.replace('/'); return; }
      setUser(JSON.parse(savedUser));
      setToken(savedToken);
      setLoading(false);
    };
    init();
  }, []);

  const handleSwitchPosition = async (positionId: number, positionName: string) => {
    if (switching) return;
    setSwitching(true);
    try {
      await axios.post(`${API_BASE_URL}/api/v1/me/active-position/${positionId}`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const response = await axios.get(`${API_BASE_URL}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const refreshedUser = response.data;
      await AsyncStorage.setItem('user_profile', JSON.stringify(refreshedUser));
      setUser(refreshedUser);
      Alert.alert('Position Switched', `Successfully switched acting position to ${positionName}`);
    } catch (e: any) {
      console.error(e);
      const detail = e?.response?.data?.detail || 'Could not switch position';
      Alert.alert('Error', typeof detail === 'string' ? detail : 'Could not switch position');
    } finally {
      setSwitching(false);
    }
  };

  const handleSwitchRole = async (roleId: number, roleName: string) => {
    if (switching) return;
    setSwitching(true);
    try {
      await axios.post(`${API_BASE_URL}/api/v1/me/active-role/${roleId}`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const response = await axios.get(`${API_BASE_URL}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const refreshedUser = response.data;
      await AsyncStorage.setItem('user_profile', JSON.stringify(refreshedUser));
      setUser(refreshedUser);
      Alert.alert('Role Switched', `Successfully switched active role to ${roleName}`);
    } catch (e: any) {
      console.error(e);
      const detail = e?.response?.data?.detail || 'Could not switch role';
      Alert.alert('Error', typeof detail === 'string' ? detail : 'Could not switch role');
    } finally {
      setSwitching(false);
    }
  };

  const handleLogout = async () => {
    Alert.alert(
      'Log out',
      'Are you sure you want to log out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Log out',
          style: 'destructive',
          onPress: async () => {
            await AsyncStorage.removeItem('user_token');
            await AsyncStorage.removeItem('user_profile');
            router.replace('/');
          },
        },
      ]
    );
  };

  if (loading || !user) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color="#481238" />
      </View>
    );
  }

  const fullName  = user?.full_name  || user?.username || 'User';
  const roleNames = user?.roles?.map((r: any) => r.name).join(', ') || 'Viewer';
  const initials  = fullName.substring(0, 2).toUpperCase();

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
            <Text style={styles.appBarTitle}>My Profile</Text>
            <View style={{ width: 44 }} />
          </View>
        </SafeAreaView>
      </LinearGradient>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* ── Avatar Hero ── */}
        <LinearGradient
          colors={['#4A1060', '#3A0F40']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.heroCard}
        >
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <Text style={styles.heroName}>{fullName}</Text>
          <View style={styles.heroBadge}>
            <Icon name="check-circle" size={14} color="rgba(255,255,255,0.8)" />
            <Text style={styles.heroBadgeText}>Authenticated</Text>
          </View>
        </LinearGradient>

        {/* ── Profile Details Card ── */}
        <View style={styles.detailsCard}>
          <Text style={styles.cardSectionTitle}>Account Details</Text>

          <InfoRow icon="user"   label="Username" value={user?.username || 'N/A'} />
          <InfoRow icon="mail"   label="Email"    value={user?.email    || 'N/A'} />
          <InfoRow icon="shield" label="Roles"    value={roleNames}                />

          {/* Status */}
          <View style={styles.statusBadge}>
            <View style={styles.statusDot} />
            <Text style={styles.statusText}>Account Active</Text>
          </View>
        </View>

        {/* ── Switch Active Position (if multiple positions exist) ── */}
        {user?.positions && user.positions.length > 1 && (
          <View style={styles.detailsCard}>
            <Text style={styles.cardSectionTitle}>Switch Position</Text>
            {user.positions.map((pos: any, idx: number) => {
              const isActive = pos.id === user.position_id;
              return (
                <TouchableOpacity
                  key={pos.id ?? idx}
                  style={[styles.switcherRow, isActive && styles.activeSwitcherRow]}
                  activeOpacity={0.7}
                  onPress={() => !isActive && handleSwitchPosition(pos.id, pos.name)}
                  disabled={switching}
                >
                  <View style={styles.switcherLeft}>
                    <Text style={[styles.switcherName, isActive && styles.activeSwitcherName]}>
                      {pos.name}
                    </Text>
                    {pos.role_name ? (
                      <Text style={styles.switcherSub}>{pos.role_name}</Text>
                    ) : null}
                  </View>
                  {isActive ? (
                    <View style={styles.activePill}>
                      <Icon name="check" size={12} color="#16A34A" />
                      <Text style={styles.activePillText}>Active</Text>
                    </View>
                  ) : (
                    <View style={styles.inactiveSwitchBtn}>
                      <Icon name="refresh-cw" size={12} color="#481238" />
                      <Text style={styles.inactiveSwitchText}>Switch</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* ── Switch Active Role (if multiple roles exist and no multiple positions) ── */}
        {(!user?.positions || user.positions.length <= 1) && user?.roles && user.roles.length > 1 && (
          <View style={styles.detailsCard}>
            <Text style={styles.cardSectionTitle}>Switch Role</Text>
            {user.roles.map((role: any, idx: number) => {
              const isActive = role.code === user.role;
              return (
                <TouchableOpacity
                  key={role.id ?? idx}
                  style={[styles.switcherRow, isActive && styles.activeSwitcherRow]}
                  activeOpacity={0.7}
                  onPress={() => !isActive && handleSwitchRole(role.id, role.name)}
                  disabled={switching}
                >
                  <View style={styles.switcherLeft}>
                    <Text style={[styles.switcherName, isActive && styles.activeSwitcherName]}>
                      {role.name}
                    </Text>
                  </View>
                  {isActive ? (
                    <View style={styles.activePill}>
                      <Icon name="check" size={12} color="#16A34A" />
                      <Text style={styles.activePillText}>Active</Text>
                    </View>
                  ) : (
                    <View style={styles.inactiveSwitchBtn}>
                      <Icon name="refresh-cw" size={12} color="#481238" />
                      <Text style={styles.inactiveSwitchText}>Switch</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* ── Assigned Roles Card ── */}
        {user?.roles && user.roles.length > 0 && (
          <View style={styles.rolesCard}>
            <Text style={styles.cardSectionTitle}>Assigned Roles</Text>
            {user.roles.map((role: any, idx: number) => (
              <View key={role.id ?? idx} style={styles.roleRow}>
                <View style={styles.roleIconDot} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.roleName}>{role.name}</Text>
                  {!!role.code && (
                    <Text style={styles.roleCode}>{role.code}</Text>
                  )}
                </View>
              </View>
            ))}
          </View>
        )}

        {/* ── Log out ── */}
        <TouchableOpacity style={styles.logoutButton} activeOpacity={0.85} onPress={handleLogout}>
          <Icon name="log-out" size={18} color="#ffffff" />
          <Text style={styles.logoutButtonText}>Log out</Text>
        </TouchableOpacity>
      </ScrollView>
      {switching && (
        <View style={styles.overlayLoader}>
          <ActivityIndicator size="large" color="#ffffff" />
          <Text style={styles.overlayText}>Switching active profile...</Text>
        </View>
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
    width: 44,
    height: 44,
    borderRadius: 22,
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
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  heroCard: {
    borderRadius: 20,
    paddingVertical: 28,
    paddingHorizontal: 20,
    alignItems: 'center',
    marginBottom: 20,
  },
  avatarCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderWidth: 2.5,
    borderColor: 'rgba(255,255,255,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  avatarText: {
    fontSize: 26,
    fontWeight: '800',
    color: '#ffffff',
  },
  heroName: {
    fontSize: 22,
    fontWeight: '800',
    color: '#ffffff',
    marginBottom: 10,
    textAlign: 'center',
  },
  heroBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 5,
    gap: 6,
  },
  heroBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.9)',
  },
  detailsCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#EDE7E3',
    shadowColor: '#2A0E2F',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
  },
  cardSectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#94A3B8',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  infoIconWrap: {
    width: 22,
    marginRight: 10,
    marginTop: 1,
  },
  infoLabel: {
    width: 80,
    fontSize: 13,
    fontWeight: '600',
    color: '#7A6D66',
    marginRight: 8,
  },
  infoValue: {
    flex: 1,
    fontSize: 13.5,
    color: '#1A1220',
    fontWeight: '500',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F0FDF4',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginTop: 6,
    alignSelf: 'flex-start',
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#16A34A',
  },
  statusText: {
    fontSize: 12.5,
    fontWeight: '600',
    color: '#16A34A',
  },
  rolesCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#EDE7E3',
    shadowColor: '#2A0E2F',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
  },
  roleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F0EEEC',
    gap: 12,
  },
  roleIconDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#481238',
    opacity: 0.7,
  },
  roleName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1A1220',
  },
  roleCode: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  logoutButton: {
    height: 50,
    backgroundColor: '#D80048',
    borderRadius: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
    shadowColor: '#D80048',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.22,
    shadowRadius: 10,
  },
  logoutButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  // Switcher Styles
  switcherRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F5F2EF',
  },
  activeSwitcherRow: {
    backgroundColor: '#FAF8F7',
  },
  switcherLeft: {
    flex: 1,
    paddingRight: 10,
  },
  switcherName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#3C3028',
  },
  activeSwitcherName: {
    color: '#481238',
    fontWeight: '700',
  },
  switcherSub: {
    fontSize: 11.5,
    color: '#8A7A71',
    marginTop: 2,
  },
  activePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#EAFDF0',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 4,
  },
  activePillText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#16A34A',
  },
  inactiveSwitchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#481238',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 4,
  },
  inactiveSwitchText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#481238',
  },
  overlayLoader: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  overlayText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
});
