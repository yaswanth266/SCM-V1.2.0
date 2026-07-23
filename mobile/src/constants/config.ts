/**
 * Central app configuration.
 *
 * When deploying to a new server, change ONLY this file and rebuild the APK.
 * No other file needs to be touched.
 *
 * Examples:
 *   API_BASE_URL = 'http://192.168.1.50:8000'   ← office LAN IP
 *   API_BASE_URL = 'https://api.bavyascm.in'    ← production domain
 *   API_BASE_URL = 'http://10.0.2.2:8000'       ← Android emulator (localhost)
 */

// FastAPI backend address (proxied through the frontend port 8003)
export const API_BASE_URL = 'http://103.174.161.68:8003';

// Vite/React web frontend address (port 8003)
// Used by the dashboard when opening web pages in the in-app browser.
export const WEB_BASE_URL = 'http://103.174.161.68:8003';
