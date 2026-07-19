import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Image,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
  Alert,
  Modal,
  Animated,
  PanResponder,
  Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import { router } from 'expo-router';
import { API_BASE_URL } from '../constants/config';


// Custom lightweight icons to eliminate external vector icon library dependency issues
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
  if (name === 'x') {
    return (
      <View style={{ width: s, height: s, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ position: 'absolute', width: s * 0.7, height: 2, backgroundColor: color, transform: [{ rotate: '45deg' }] }} />
        <View style={{ position: 'absolute', width: s * 0.7, height: 2, backgroundColor: color, transform: [{ rotate: '-45deg' }] }} />
      </View>
    );
  }
  if (name === 'user') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.42, height: size * 0.42, borderRadius: (size * 0.42)/2, borderWidth: 1.5, borderColor: color }} />
        <View style={{ width: size * 0.8, height: size * 0.3, borderTopLeftRadius: 6, borderTopRightRadius: 6, borderWidth: 1.5, borderColor: color, borderBottomWidth: 0, marginTop: 1 }} />
      </View>
    );
  }
  if (name === 'lock') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.5, height: size * 0.4, borderTopLeftRadius: size * 0.25, borderTopRightRadius: size * 0.25, borderWidth: 1.5, borderColor: color, borderBottomWidth: 0, marginBottom: -1 }} />
        <View style={{ width: size * 0.7, height: size * 0.45, borderRadius: 3, borderWidth: 1.5, borderColor: color }} />
      </View>
    );
  }
  if (name === 'mail') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.85, height: size * 0.6, borderRadius: 2, borderWidth: 1.5, borderColor: color, justifyContent: 'flex-start' }}>
          <View style={{ width: '100%', height: '50%', borderBottomWidth: 1, borderLeftWidth: 1, borderRightWidth: 1, borderColor: color, transform: [{ rotate: '45deg' }, { scale: 0.7 }, { translateY: -size*0.05 }] }} />
        </View>
      </View>
    );
  }
  if (name === 'settings') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.45, height: size * 0.45, borderRadius: (size * 0.45)/2, borderWidth: 2, borderColor: color }} />
        {[0, 45, 90, 135].map((angle, idx) => (
          <View key={idx} style={{ position: 'absolute', width: size * 0.85, height: 2, backgroundColor: color, transform: [{ rotate: `${angle}deg` }], borderRadius: 1 }} />
        ))}
        <View style={{ position: 'absolute', width: size * 0.35, height: size * 0.35, borderRadius: (size * 0.35)/2, backgroundColor: '#ffffff' }} />
      </View>
    );
  }
  if (name === 'globe') {
    return (
      <View style={{ width: size, height: size, borderRadius: size/2, borderWidth: 1.5, borderColor: color, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.4, height: size, borderLeftWidth: 1.5, borderRightWidth: 1.5, borderColor: color, borderRadius: size*0.2 }} />
        <View style={{ position: 'absolute', width: size, height: 1.5, backgroundColor: color }} />
      </View>
    );
  }
  if (name === 'chevron-down') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.4, height: size * 0.4, transform: [{ rotate: '45deg' }, { translateY: -size*0.06 }, { translateX: -size*0.06 }], borderBottomWidth: 1.8, borderRightWidth: 1.8, borderColor: color }} />
      </View>
    );
  }
  if (name === 'eye') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.85, height: size * 0.5, borderRadius: size * 0.25, borderWidth: 1.5, borderColor: color, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: size * 0.28, height: size * 0.28, borderRadius: (size * 0.28)/2, backgroundColor: color }} />
        </View>
      </View>
    );
  }
  if (name === 'eye-off') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.85, height: size * 0.5, borderRadius: size * 0.25, borderWidth: 1.5, borderColor: color, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: size * 0.28, height: size * 0.28, borderRadius: (size * 0.28)/2, backgroundColor: color }} />
        </View>
        <View style={{ position: 'absolute', width: size * 1.1, height: 1.5, backgroundColor: color, transform: [{ rotate: '-45deg' }] }} />
      </View>
    );
  }
  if (name === 'check') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.25, height: size * 0.5, borderBottomWidth: 2, borderRightWidth: 2, borderColor: color, transform: [{ rotate: '45deg' }, { translateY: -size*0.06 }, { translateX: size*0.02 }] }} />
      </View>
    );
  }
  if (name === 'check-circle') {
    return (
      <View style={{ width: size, height: size, borderRadius: size/2, backgroundColor: '#F0FDF4', borderWidth: 1.5, borderColor: '#16A34A', alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.22, height: size * 0.4, borderBottomWidth: 1.8, borderRightWidth: 1.8, borderColor: '#16A34A', transform: [{ rotate: '45deg' }, { translateY: -size*0.05 }, { translateX: size*0.02 }] }} />
      </View>
    );
  }
  if (name === 'arrow-right') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.65, height: 1.8, backgroundColor: color }} />
        <View style={{ position: 'absolute', width: size * 0.32, height: size * 0.32, borderTopWidth: 1.8, borderRightWidth: 1.8, borderColor: color, transform: [{ rotate: '45deg' }, { translateX: size*0.08 }] }} />
      </View>
    );
  }
  if (name === 'help-circle') {
    return (
      <View style={{ width: size, height: size, borderRadius: size/2, borderWidth: 1.5, borderColor: color, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: color, fontSize: size * 0.65, fontWeight: 'bold', textAlign: 'center', lineHeight: size * 0.8 }}>?</Text>
      </View>
    );
  }
  if (name === 'shield') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.7, height: size * 0.8, borderBottomLeftRadius: size * 0.35, borderBottomRightRadius: size * 0.35, borderTopLeftRadius: 1, borderTopRightRadius: 1, borderWidth: 1.8, borderColor: color }} />
      </View>
    );
  }
  if (name === 'log-out') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center' }}>
        <View style={{ width: size * 0.65, height: size * 0.75, borderWidth: 1.8, borderColor: color, borderRightWidth: 0, borderRadius: 2 }} />
        <View style={{ position: 'absolute', left: size * 0.32, flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ width: size * 0.45, height: 1.8, backgroundColor: color }} />
          <View style={{ width: size * 0.22, height: size * 0.22, borderTopWidth: 1.8, borderRightWidth: 1.8, borderColor: color, transform: [{ rotate: '45deg' }, { translateX: -size*0.06 }] }} />
        </View>
      </View>
    );
  }
  if (name === 'chevron-right') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.3, height: size * 0.3, borderTopWidth: 1.8, borderRightWidth: 1.8, borderColor: color, transform: [{ rotate: '45deg' }, { translateX: -size*0.05 }] }} />
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
          <View style={{ width: size * 0.2, height: size * 0.38, borderBottomWidth: 1.8, borderRightWidth: 1.8, borderColor: color, transform: [{ rotate: '45deg' }, { translateY: -size*0.04 }, { translateX: size*0.02 }] }} />
        </View>
      </View>
    );
  }
  if (name === 'thumbs-up') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.7, height: size * 0.78, borderBottomLeftRadius: size * 0.35, borderBottomRightRadius: size * 0.35, borderTopLeftRadius: 1, borderTopRightRadius: 1, borderWidth: 1.8, borderColor: color, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: size * 0.18, height: size * 0.32, borderBottomWidth: 1.5, borderRightWidth: 1.5, borderColor: color, transform: [{ rotate: '45deg' }, { translateY: -size*0.02 }] }} />
        </View>
      </View>
    );
  }
  return null;
};

const Feather = ({ name, size, color }: { name: string; size?: number; color?: string }) => (
  <Icon name={name} size={size} color={color} />
);

export default function App() {
  const [screen, setScreen] = useState<'splash' | 'login'>('splash');


  // Animated values for draggable bottom sheet
  const sheetY = useRef(new Animated.Value(0)).current;
  const currentSnap = useRef<'normal' | 'minimized' | 'expanded'>('normal');
  const isKeyboardVisible = useRef(false);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (evt, gestureState) => {
        return Math.abs(gestureState.dy) > 5;
      },
      onPanResponderGrant: () => {
        sheetY.extractOffset();
      },
      onPanResponderMove: (evt, gestureState) => {
        let val = gestureState.dy;
        if (val < 0) {
          // If pulling UP (negative dy)
          if (!isKeyboardVisible.current) {
            // Apply extremely heavy resistance if keyboard is closed (effectively blocking upward pull)
            val = val * 0.02;
          } else {
            // Pull up freely if keyboard is open
            if (val < -220) {
              val = -220 + (val + 220) * 0.25;
            }
          }
        } else {
          // Pull down to minimize
          if (val > 280) {
            val = 280 + (val - 280) * 0.25;
          }
        }
        sheetY.setValue(val);
      },
      onPanResponderRelease: (evt, gestureState) => {
        sheetY.flattenOffset();
        const dragThreshold = 80;

        // Detect clean tap (minimal movement) to restore to normal from minimized
        if (Math.abs(gestureState.dy) < 5 && Math.abs(gestureState.dx) < 5) {
          if (currentSnap.current === 'minimized') {
            Animated.spring(sheetY, {
              toValue: 0,
              useNativeDriver: true,
              tension: 40,
              friction: 8,
            }).start(() => {
              currentSnap.current = 'normal';
            });
          }
          return;
        }

        const startState = currentSnap.current;
        let targetValue = 0;
        let endState: 'normal' | 'minimized' | 'expanded' = 'normal';

        if (startState === 'normal') {
          if (gestureState.dy > dragThreshold || gestureState.vy > 0.3) {
            // Dragged down -> Minimize
            targetValue = 240;
            endState = 'minimized';
          } else if (isKeyboardVisible.current && (gestureState.dy < -dragThreshold || gestureState.vy < -0.3)) {
            // Dragged up (only when keyboard is open) -> Expand
            targetValue = -180;
            endState = 'expanded';
          } else {
            // Snap back to Normal
            targetValue = 0;
            endState = 'normal';
          }
        } else if (startState === 'minimized') {
          if (gestureState.dy < -dragThreshold || gestureState.vy < -0.3) {
            // Dragged up -> Normal
            targetValue = 0;
            endState = 'normal';
          } else {
            // Snap back to Minimized
            targetValue = 240;
            endState = 'minimized';
          }
        } else if (startState === 'expanded') {
          if (gestureState.dy > dragThreshold || gestureState.vy > 0.3 || !isKeyboardVisible.current) {
            // Dragged down or keyboard closed -> Normal
            targetValue = 0;
            endState = 'normal';
          } else {
            // Snap back to Expanded
            targetValue = -180;
            endState = 'expanded';
          }
        }

        Animated.spring(sheetY, {
          toValue: targetValue,
          useNativeDriver: true,
          tension: 40,
          friction: 8,
        }).start(() => {
          currentSnap.current = endState;
        });
      },
    })
  ).current;

  // Form states
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Active fields for focus styles
  const [focusField, setFocusField] = useState<'username' | 'password' | null>(null);

  // Load saved API URL or remember-me status on startup
  useEffect(() => {
    const bootstrapAsync = async () => {
      try {
        // One-time migration: remove stale manual URL key from older app versions
        await AsyncStorage.removeItem('API_URL');

        const rememberedUser = await AsyncStorage.getItem('remembered_username');
        if (rememberedUser) {
          setUsername(rememberedUser);
        }
      } catch (e) {
        console.error('Error loading bootstrap data:', e);
      }
    };

    bootstrapAsync();
  }, []);

  // Handle Splash transition
  useEffect(() => {
    if (screen === 'splash') {
      const timer = setTimeout(async () => {
        const savedToken = await AsyncStorage.getItem('user_token');
        if (savedToken) {
          router.replace('/dashboard');
        } else {
          setScreen('login');
        }
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [screen]);

  // Listen to keyboard show/hide events to restrict card movement to keyboard-open states
  useEffect(() => {
    const showSubscription = Keyboard.addListener('keyboardDidShow', () => {
      isKeyboardVisible.current = true;
    });
    const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
      isKeyboardVisible.current = false;
      // Auto snap bottom sheet back to normal position when keyboard closes
      Animated.spring(sheetY, {
        toValue: 0,
        useNativeDriver: true,
        tension: 40,
        friction: 8,
      }).start(() => {
        currentSnap.current = 'normal';
      });
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  // Handle submit/login request to backend
  const handleLogin = async () => {
    setError('');
    if (!username.trim() || !password) {
      setError('Please enter your username and password.');
      return;
    }

    setLoading(true);
    try {
      const response = await axios.post(`${API_BASE_URL}/api/v1/auth/login`, {
        username: username.trim(),
        password: password,
        remember: remember,
        login_type: 'employee',
      });

      const { access_token, user: userData } = response.data;

      await AsyncStorage.setItem('user_token', access_token);
      await AsyncStorage.setItem('user_profile', JSON.stringify(userData));

      if (remember) {
        await AsyncStorage.setItem('remembered_username', username.trim());
      } else {
        await AsyncStorage.removeItem('remembered_username');
      }

      router.replace('/dashboard');
      setPassword(''); // Clear password
    } catch (err: any) {
      console.error(err);
      if (err.response) {
        const msg = err.response.data?.detail || 'Invalid username or password.';
        setError(msg);
      } else if (err.request) {
        setError(`Cannot connect to server. Please check your network connection.`);
      } else {
        setError('An unexpected error occurred. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  // Render Screens
  if (screen === 'splash') {
    return (
      <LinearGradient
        colors={['#2B0C32', '#140417']}
        style={styles.splashContainer}
      >
        <SafeAreaView style={styles.splashContent}>
          <Image
            source={require('../../assets/bavya-mark.png')}
            style={styles.splashLogo}
            resizeMode="contain"
          />
          <View style={styles.splashTextContainer}>
            <Text style={styles.splashTitle}>BAVYA SCM</Text>
            <Text style={styles.splashSubtitle}>SUPPLY CHAIN MANAGEMENT</Text>
          </View>
          <Text style={styles.splashTagline}>
            Here, every supply chain creates a lifeline.
          </Text>
          <ActivityIndicator size="small" color="#FF8FA8" style={styles.splashLoader} />
        </SafeAreaView>
      </LinearGradient>
    );
  }

  return (

    <LinearGradient
      colors={['#1F0824', '#0F0312']}
      style={styles.loginContainer}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardContainer}
      >
        {/* Top Stack Container for the dark header space */}
        <View style={styles.topStackContainer}>
          {/* Top Control Bar */}
          <SafeAreaView style={styles.topSafeBar}>
            <View style={styles.topControlBar}>
              <View style={styles.langBtn}>
                <Feather name="globe" size={12} color="rgba(255, 255, 255, 0.45)" />
                <Text style={styles.langText}>EN</Text>
              </View>
            </View>
          </SafeAreaView>

          {/* Centered Brand area inside remaining dark space */}
          <Animated.View style={[
            styles.brandHeroContainer,
            { transform: [{ translateY: Animated.multiply(sheetY, 0.5) }] }
          ]}>
            <View style={styles.brandHeroArea}>
              <Image
                source={require('../../assets/bavya-mark.png')}
                style={styles.brandLogo}
                resizeMode="contain"
              />
              <Text style={styles.brandTitle}>BAVYA SCM</Text>
              <Text style={styles.brandSubtitle}>SUPPLY CHAIN MANAGEMENT</Text>
              <Text style={styles.taglineNote}>
                Procurement, Warehousing, and Fleet Operations
              </Text>
            </View>
          </Animated.View>
        </View>

        {/* Native Bottom Sheet container */}
        <Animated.View 
          {...panResponder.panHandlers}
          style={[styles.bottomSheet, { transform: [{ translateY: sheetY }] }]}
        >
          <View style={styles.dragHandleArea}>
            <View style={styles.bottomSheetHandle} />
          </View>
          
          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={styles.bottomSheetScroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.formTitle}>Account Sign In</Text>
            <Text style={styles.formSubtitle}>Access the Bavya Health SCM network.</Text>

            {error ? (
              <View style={styles.errorCard}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            {/* Username Box */}
            <View style={[
              styles.inputWrapper,
              focusField === 'username' && styles.inputWrapperFocused
            ]}>
              <View style={styles.iconPrefix}>
                <Feather name="user" size={16} color={focusField === 'username' ? '#4A0E4E' : '#64748B'} />
              </View>
              <TextInput
                style={styles.textInput}
                value={username}
                onChangeText={(val) => {
                  setUsername(val);
                  if (error) setError('');
                }}
                placeholder="Employee username"
                placeholderTextColor="#94A3B8"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!loading}
                onFocus={() => setFocusField('username')}
                onBlur={() => setFocusField(null)}
              />
            </View>

            {/* Password Box */}
            <View style={[
              styles.inputWrapper,
              focusField === 'password' && styles.inputWrapperFocused
            ]}>
              <View style={styles.iconPrefix}>
                <Feather name="lock" size={16} color={focusField === 'password' ? '#4A0E4E' : '#64748B'} />
              </View>
              <TextInput
                style={styles.textInput}
                value={password}
                onChangeText={(val) => {
                  setPassword(val);
                  if (error) setError('');
                }}
                placeholder="Password"
                placeholderTextColor="#94A3B8"
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!loading}
                onFocus={() => setFocusField('password')}
                onBlur={() => setFocusField(null)}
              />
              <TouchableOpacity
                style={styles.iconSuffix}
                onPress={() => setShowPassword(!showPassword)}
              >
                <Feather name={showPassword ? 'eye-off' : 'eye'} size={18} color="#94A3B8" />
              </TouchableOpacity>
            </View>

            {/* Options Checkbox Row */}
            <View style={styles.optionsRow}>
              <TouchableOpacity
                style={styles.checkboxRow}
                onPress={() => setRemember(!remember)}
              >
                <View style={[styles.checkbox, remember && styles.checkboxChecked]}>
                  {remember && <Feather name="check" size={10} color="#ffffff" />}
                </View>
                <Text style={styles.checkboxLabel}>Keep me signed in</Text>
              </TouchableOpacity>
              <TouchableOpacity>
                <Text style={styles.forgotText}>Forgot password?</Text>
              </TouchableOpacity>
            </View>

            {/* Solid Corporate Action Button */}
            <TouchableOpacity
              style={styles.submitBtnContainer}
              onPress={handleLogin}
              disabled={loading}
              activeOpacity={0.9}
            >
              <View style={styles.submitBtn}>
                {loading ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <>
                    <Text style={styles.submitBtnText}>Sign in</Text>
                    <Feather name="arrow-right" size={14} color="#ffffff" />
                  </>
                )}
              </View>
            </TouchableOpacity>

            {/* Structured IT Support Panel */}
            <View style={styles.helpPanel}>
              <View style={styles.helpHeaderRow}>
                <Feather name="help-circle" size={14} color="#4A0E4E" />
                <Text style={styles.helpPanelTitle}>First time signing in?</Text>
              </View>
              <Text style={styles.helpPanelText}>
                Use your district credentials or contact stores admin.
              </Text>
              <TouchableOpacity style={styles.helpLinkBtn}>
                <Text style={styles.helpLinkText}>Contact IT Support →</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  // Splash Screen Styles
  splashContainer: {
    flex: 1,
  },
  splashContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  splashLogo: {
    width: 130,
    height: 130,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 15,
  },
  splashTextContainer: {
    alignItems: 'center',
    marginTop: 24,
    marginBottom: 40,
  },
  splashTitle: {
    fontSize: 30,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: 2,
  },
  splashSubtitle: {
    fontSize: 12,
    fontWeight: '600',
    color: 'rgba(255, 255, 255, 0.65)',
    letterSpacing: 4,
    marginTop: 8,
  },
  splashTagline: {
    fontSize: 14,
    color: 'rgba(255, 255, 255, 0.78)',
    textAlign: 'center',
    paddingHorizontal: 24,
    lineHeight: 22,
  },
  splashLoader: {
    marginTop: 48,
  },



  // Premium Bottom Sheet Redesign Layout
  loginContainer: {
    flex: 1,
  },
  topStackContainer: {
    flex: 1,
  },
  brandHeroContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  keyboardContainer: {
    flex: 1,
  },
  topSafeBar: {
    zIndex: 10,
  },
  topControlBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: Platform.OS === 'ios' ? 0 : 12,
  },
  settingsBtn: {
    padding: 6,
  },
  langBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 12,
  },
  langText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#ffffff',
  },

  // Brand Header Canvas
  brandHeroArea: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 0,
    paddingBottom: 0,
  },
  brandLogo: {
    width: 64,
    height: 64,
    marginBottom: 10,
  },
  brandTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: 2,
  },
  brandSubtitle: {
    fontSize: 9.5,
    fontWeight: '600',
    color: 'rgba(255, 255, 255, 0.4)',
    letterSpacing: 3,
    marginTop: 2,
  },
  taglineNote: {
    fontSize: 12,
    color: 'rgba(255, 255, 255, 0.7)',
    marginTop: 10,
    fontWeight: '500',
    letterSpacing: 0.5,
  },

  // Native Bottom Sheet Card
  bottomSheet: {
    backgroundColor: '#F8FAFC',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: -10 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 8,
  },
  dragHandleArea: {
    width: '100%',
    paddingTop: 14,
    paddingBottom: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomSheetHandle: {
    width: 36,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#E2E8F0',
    alignSelf: 'center',
  },
  scrollView: {
    flexGrow: 0,
  },
  bottomSheetScroll: {
    paddingHorizontal: 28,
    paddingBottom: 28,
  },
  formTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 4,
  },
  formSubtitle: {
    fontSize: 13.5,
    color: '#64748B',
    marginBottom: 24,
  },
  errorCard: {
    backgroundColor: '#FEE2E2',
    borderWidth: 1,
    borderColor: '#FCA5A5',
    borderRadius: 8,
    padding: 12,
    marginBottom: 18,
  },
  errorText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#B91C1C',
    lineHeight: 18,
  },
  inputWrapper: {
    height: 48,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
    backgroundColor: '#ffffff',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    marginBottom: 14,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.02,
    shadowRadius: 2,
  },
  inputWrapperFocused: {
    borderColor: '#4A0E4E',
    shadowColor: '#4A0E4E',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
  },
  iconPrefix: {
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textInput: {
    flex: 1,
    height: '100%',
    fontSize: 14.5,
    color: '#0F172A',
  },
  iconSuffix: {
    padding: 6,
  },
  optionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 2,
    marginBottom: 24,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  checkbox: {
    width: 17,
    height: 17,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#CBD5E1',
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxChecked: {
    backgroundColor: '#4A0E4E',
    borderColor: '#4A0E4E',
  },
  checkboxLabel: {
    fontSize: 13,
    color: '#475569',
  },
  forgotText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#D80048',
  },
  submitBtnContainer: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  submitBtn: {
    height: 50,
    backgroundColor: '#4A0E4E',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  submitBtnText: {
    color: '#ffffff',
    fontSize: 15.5,
    fontWeight: '700',
  },
  helpPanel: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    padding: 14,
    marginTop: 24,
  },
  helpHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  helpPanelTitle: {
    fontSize: 13.5,
    fontWeight: '700',
    color: '#0F172A',
  },
  helpPanelText: {
    fontSize: 12,
    color: '#475569',
    lineHeight: 16,
    marginBottom: 8,
  },
  helpLinkBtn: {
    alignSelf: 'flex-start',
  },
  helpLinkText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#D80048',
  },
  helpRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 8,
  },
  helpText: {
    fontSize: 13,
    color: '#64748B',
  },
  helpLink: {
    fontSize: 13,
    fontWeight: '700',
    color: '#D80048',
  },
  footer: {
    alignItems: 'center',
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    marginTop: 24,
  },
  footerEnv: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    color: '#94A3B8',
  },
  // Modal Settings Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(26, 18, 32, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 320,
    borderWidth: 1,
    borderColor: '#E8DFD9',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 15,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1A1220',
    marginBottom: 16,
    textAlign: 'center',
  },
  modalLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#54463F',
    marginBottom: 8,
  },
  modalInput: {
    borderWidth: 1.5,
    borderColor: '#E8DFD9',
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 44,
    fontSize: 14,
    color: '#1A1220',
    backgroundColor: '#FBF7F4',
    marginBottom: 8,
  },
  modalHint: {
    fontSize: 11,
    color: '#7A6D66',
    lineHeight: 16,
    marginBottom: 20,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  modalButton: {
    flex: 1,
    height: 40,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCancel: {
    backgroundColor: '#F4EEEA',
  },
  modalCancelText: {
    color: '#54463F',
    fontWeight: '600',
    fontSize: 14,
  },
  modalSave: {
    backgroundColor: '#D80048',
  },
  modalSaveText: {

    color: '#ffffff',
    fontWeight: '600',
    fontSize: 14,
  },
  modalScanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#4A1060',
    paddingVertical: 10,
    borderRadius: 8,
    marginBottom: 16,
  },
  modalScanBtnText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 13,
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

