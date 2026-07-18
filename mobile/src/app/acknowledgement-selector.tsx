import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';

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
  if (name === 'file-text') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.65, height: s * 0.8, borderRadius: 2, borderWidth: 1.8, borderColor: color, padding: 3, justifyContent: 'center', gap: 2.5 }}>
          <View style={{ width: '70%', height: 1.5, backgroundColor: color }} />
          <View style={{ width: '90%', height: 1.5, backgroundColor: color }} />
          <View style={{ width: '50%', height: 1.5, backgroundColor: color }} />
        </View>
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
  if (name === 'chevron-right') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: s * 0.35, height: s * 0.35, borderTopWidth: 2, borderRightWidth: 2, borderColor: color, transform: [{ rotate: '45deg' }, { translateX: -s * 0.05 }] }} />
      </View>
    );
  }
  return null;
};

const Feather = ({ name, size, color }: { name: string; size?: number; color?: string }) => (
  <Icon name={name} size={size} color={color} />
);

export default function AcknowledgementSelectorScreen() {
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
          <TouchableOpacity onPress={() => router.replace('/dashboard')} style={styles.backBtn}>
            <Feather name="arrow-left" size={20} color="#ffffff" />
          </TouchableOpacity>
          <View style={styles.appBarTitleContainer}>
            <Text style={styles.appBarTitle}>Acknowledgement</Text>
            <Text style={styles.appBarSub}>Select Receipt Verification Module</Text>
          </View>
        </View>
      </LinearGradient>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.welcomeText}>Choose SCM Acknowledgement Module</Text>
        <Text style={styles.subtitleText}>
          Select the specific module to record receipt confirmation and stock ledger postings:
        </Text>

        <TouchableOpacity
          style={styles.selectorCard}
          activeOpacity={0.7}
          onPress={() => router.push('/indent-acknowledgement')}
        >
          <View style={[styles.iconContainer, { backgroundColor: '#F0E8F8' }]}>
            <Feather name="file-text" size={22} color="#481890" />
          </View>
          <View style={styles.textContainer}>
            <Text style={styles.cardTitle}>Field Indents</Text>
            <Text style={styles.cardDesc}>Acknowledge and accept material issues raised for field site indents.</Text>
          </View>
          <Feather name="chevron-right" size={18} color="#94A3B8" />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.selectorCard}
          activeOpacity={0.7}
          onPress={() => router.push('/logistics-acknowledgement')}
        >
          <View style={[styles.iconContainer, { backgroundColor: '#E0F2FE' }]}>
            <Feather name="truck" size={22} color="#0EA5E9" />
          </View>
          <View style={styles.textContainer}>
            <Text style={styles.cardTitle}>Logistics Delivery</Text>
            <Text style={styles.cardDesc}>Acknowledge package dispatches, verify seals, and record consignment receipt.</Text>
          </View>
          <Feather name="chevron-right" size={18} color="#94A3B8" />
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F6F2F0',
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
    padding: 20,
  },
  welcomeText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1E293B',
    marginBottom: 6,
  },
  subtitleText: {
    fontSize: 13,
    color: '#64748B',
    lineHeight: 18,
    marginBottom: 24,
  },
  selectorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#EDE7E3',
    marginBottom: 16,
    shadowColor: '#2A0E2F',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
  },
  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  textContainer: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 2,
  },
  cardDesc: {
    fontSize: 12,
    color: '#64748B',
    lineHeight: 17,
  },
});
