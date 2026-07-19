import { Slot, router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect } from 'react';

export default function Layout() {
  useEffect(() => {
    const interceptor = axios.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response && error.response.status === 401) {
          const isLoginRequest = error.config?.url?.includes('/api/v1/auth/login');
          if (!isLoginRequest) {
            try {
              await AsyncStorage.removeItem('user_token');
              await AsyncStorage.removeItem('user_profile');
              router.replace('/');
            } catch (e) {
              console.error('Failed to clear session on 401:', e);
            }
          }
        }
        return Promise.reject(error);
      }
    );

    return () => {
      axios.interceptors.response.eject(interceptor);
    };
  }, []);

  return (
    <SafeAreaProvider>
      <Slot />
    </SafeAreaProvider>
  );
}

