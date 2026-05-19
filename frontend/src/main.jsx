import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import App from './App';
import './styles/global.css';

// Build-time env flag: VITE_UAT switches colours to yellow+green so testers
// can tell UAT apart from production at a glance.
// BUG-FE-143: accept the common truthy spellings (`true`, `1`, `yes`) so a
// dotenv with `VITE_UAT=1` still triggers the UAT theme.
const IS_UAT = (() => {
  const v = String(import.meta.env.VITE_UAT || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
})();

const BRAND = IS_UAT
  ? {
      primary: '#16a34a',        // emerald-600
      primaryContainer: '#22c55e',
      primaryHover: '#15803d',
      link: '#16a34a',
      bgBase: '#fefce8',         // yellow-50 (very very light)
      bgLayout: '#fefce8',
      text: '#1a2e05',
      textSecondary: '#3f6212',
      border: 'rgba(101, 163, 13, 0.18)',
      borderSecondary: 'rgba(101, 163, 13, 0.08)',
      siderBg: '#14532d',
      siderSubBg: '#0f3a20',
      menuHover: '#1e6a3a',
      tagBg: '#dcfce7',
      tableHeaderBg: '#fef9c3',
      tableRowHover: '#fef3c7',
      inputSelectedBg: '#d1fae5',
      primaryShadow: '0 6px 16px rgba(22, 163, 74, 0.22)',
    }
  : {
      primary: '#b70051',
      primaryContainer: '#e11668',
      primaryHover: '#ff2a7d',
      link: '#b70051',
      bgBase: '#fcf9f8',
      bgLayout: '#fcf9f8',
      text: '#1b1c1c',
      textSecondary: '#5b3f45',
      border: 'rgba(143, 111, 117, 0.15)',
      borderSecondary: 'rgba(143, 111, 117, 0.08)',
      siderBg: '#1b1c1c',
      siderSubBg: '#141415',
      menuHover: '#2a1c22',
      tagBg: '#f0eded',
      tableHeaderBg: '#f0eded',
      tableRowHover: '#f6f3f2',
      inputSelectedBg: '#ffd9df',
      primaryShadow: '0 6px 16px rgba(183, 0, 81, 0.18)',
    };

// "Clinical Concierge" theme — dynamic per-env colors.
const theme = {
  token: {
    colorPrimary: BRAND.primary,
    colorInfo: BRAND.primary,
    colorSuccess: '#006b2a',
    colorWarning: '#e58f00',
    colorError: '#ba1a1a',
    colorLink: BRAND.link,

    colorBgBase: BRAND.bgBase,
    colorBgLayout: BRAND.bgLayout,
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',

    colorText: BRAND.text,
    colorTextSecondary: BRAND.textSecondary,
    colorBorder: BRAND.border,
    colorBorderSecondary: BRAND.borderSecondary,

    borderRadius: 12,
    borderRadiusLG: 16,
    borderRadiusSM: 8,
    borderRadiusXS: 6,

    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontSize: 14,
    fontSizeHeading1: 40,
    fontSizeHeading2: 28,
    fontSizeHeading3: 22,
    fontSizeHeading4: 18,
    fontWeightStrong: 700,

    boxShadow: '0 1px 2px rgba(27, 28, 28, 0.04)',
    boxShadowSecondary: '0 8px 20px rgba(27, 28, 28, 0.05)',
    boxShadowTertiary: '0 20px 40px rgba(27, 28, 28, 0.06)',

    controlHeight: 40,
    controlHeightLG: 48,
    controlHeightSM: 32,
    wireframe: false,
  },
  components: {
    Layout: {
      siderBg: BRAND.siderBg,
      headerBg: '#ffffff',
      bodyBg: BRAND.bgLayout,
      triggerBg: BRAND.siderBg,
    },
    Menu: {
      darkItemBg: BRAND.siderBg,
      darkSubMenuItemBg: BRAND.siderSubBg,
      darkItemSelectedBg: BRAND.primary,
      darkItemHoverBg: BRAND.menuHover,
      itemBorderRadius: 10,
      itemMarginInline: 8,
    },
    Button: {
      borderRadius: 12,
      borderRadiusLG: 14,
      fontWeight: 600,
      primaryShadow: BRAND.primaryShadow,
    },
    Card: {
      borderRadiusLG: 20,
      paddingLG: 28,
      headerFontSize: 18,
    },
    Drawer: {
      borderRadiusLG: 24,
    },
    Modal: {
      borderRadiusLG: 20,
    },
    Table: {
      headerBg: BRAND.tableHeaderBg,
      headerSplitColor: 'transparent',
      borderColor: BRAND.borderSecondary,
      rowHoverBg: BRAND.tableRowHover,
      // BUG-FE-145: textSecondary on tableHeaderBg failed WCAG AA
      // contrast (~3:1). Use the primary text color for headers — the
      // bold weight + neutral background already differentiates them
      // visually from data rows.
      headerColor: BRAND.text,
      cellPaddingBlock: 16,
      cellPaddingInline: 20,
    },
    Input: {
      borderRadius: 10,
      activeBorderColor: BRAND.primary,
      hoverBorderColor: BRAND.primaryContainer,
      paddingBlock: 10,
    },
    InputNumber: {
      borderRadius: 10,
      paddingBlock: 10,
    },
    Select: {
      borderRadius: 10,
      optionSelectedBg: BRAND.inputSelectedBg,
      optionSelectedColor: BRAND.primary,
    },
    Tag: {
      borderRadiusSM: 999,
      defaultBg: BRAND.tagBg,
    },
    Tabs: {
      itemSelectedColor: BRAND.primary,
      inkBarColor: BRAND.primary,
    },
    Tooltip: {
      colorBgSpotlight: BRAND.siderBg,
    },
  },
};

// Stale-bundle auto-recovery: after every deploy, vite generates new chunk
// hashes. Browsers that had the old index.html cached try to lazy-import the
// old hash → 404 → "Failed to fetch dynamically imported module". Catching
// it globally and reloading once per session pulls the fresh index.html.
if (typeof window !== 'undefined') {
  const RELOAD_FLAG = 'staleBundleReloaded';
  const isChunkLoadError = (msg = '') =>
    /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk \d+ failed/i.test(msg);
  const reloadIfStale = (rawMsg) => {
    if (!isChunkLoadError(rawMsg)) return false;
    if (sessionStorage.getItem(RELOAD_FLAG)) return false;
    sessionStorage.setItem(RELOAD_FLAG, '1');
    // Force fresh fetch of index.html (bypass cache)
    window.location.reload();
    return true;
  };
  window.addEventListener('error', (e) => reloadIfStale(e?.message));
  window.addEventListener('unhandledrejection', (e) => reloadIfStale(e?.reason?.message || String(e?.reason)));
}

// UAT visual marker — small persistent ribbon so testers never confuse envs.
// BUG-FE-144: previously appended via DOM with no id, so a hot-reload (or
// any DOM-replace path) duplicated the ribbon. We now mount it idempotently
// using a fixed id and skip re-appending if it's already there.
if (IS_UAT && typeof document !== 'undefined') {
  const RIBBON_ID = 'bavya-uat-ribbon';
  if (!document.getElementById(RIBBON_ID)) {
    const ribbon = document.createElement('div');
    ribbon.id = RIBBON_ID;
    ribbon.textContent = 'UAT · Test Environment';
    ribbon.style.cssText = [
      'position:fixed', 'top:0', 'right:0', 'z-index:99999',
      'background:linear-gradient(135deg,#facc15 0%,#16a34a 100%)',
      'color:#14532d', 'font:700 11px/1 Inter,sans-serif',
      'letter-spacing:0.08em', 'text-transform:uppercase',
      'padding:6px 14px', 'border-bottom-left-radius:10px',
      'box-shadow:0 2px 8px rgba(0,0,0,0.1)', 'pointer-events:none',
    ].join(';');
    document.body.appendChild(ribbon);
  }
}

try {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <ConfigProvider theme={theme}>
      <AntApp>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  );
} catch (e) {
  // BUG-FE-149: render a styled, user-friendly fallback rather than dumping
  // a raw stack trace as red <pre>. The full stack is logged to the console
  // for support diagnostics.
  // eslint-disable-next-line no-console
  console.error('[Bavya] Boot failure:', e);
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = [
      'min-height:100vh', 'display:flex', 'align-items:center',
      'justify-content:center', 'padding:32px',
      'font:14px/1.6 Inter,sans-serif', 'color:#1b1c1c',
      'background:#fcf9f8',
    ].join(';');
    const card = document.createElement('div');
    card.style.cssText = [
      'max-width:520px', 'background:#ffffff', 'border-radius:16px',
      'padding:32px', 'box-shadow:0 8px 24px rgba(0,0,0,0.08)',
      'text-align:center',
    ].join(';');
    card.innerHTML = `
      <h2 style="margin:0 0 12px;font-size:20px;color:#b70051;">
        Bavya SCM couldn't start
      </h2>
      <p style="margin:0 0 16px;color:#5b3f45;">
        We hit an unexpected error while loading the app. Refresh the page,
        or contact <a href="mailto:it@bhspl.in" style="color:#b70051;">IT support</a>
        if this keeps happening.
      </p>
      <button id="bavya-boot-retry" style="
        background:#b70051;color:#fff;border:0;border-radius:10px;
        padding:10px 22px;font-weight:600;cursor:pointer;
      ">Reload</button>
    `;
    wrap.appendChild(card);
    root.appendChild(wrap);
    const btn = document.getElementById('bavya-boot-retry');
    if (btn) btn.addEventListener('click', () => window.location.reload());
  }
}
