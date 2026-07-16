import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { message } from 'antd';
import useAuthStore from '../store/authStore';
import useCarrierAuthStore from '../store/carrierAuthStore';
import useVendorAuthStore from '../store/vendorAuthStore';

const Eye = ({ open }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    {open ? (
      <>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ) : (
      <>
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
        <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </>
    )}
  </svg>
);

const ArrowRight = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14M13 5l7 7-7 7" />
  </svg>
);

const Login = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, loading, token } = useAuthStore();
  const carrierLogin = useCarrierAuthStore((s) => s.login);
  const carrierLoading = useCarrierAuthStore((s) => s.loading);
  const carrierToken = useCarrierAuthStore((s) => s.token);
  const vendorLogin = useVendorAuthStore((s) => s.login);
  const vendorLoading = useVendorAuthStore((s) => s.loading);
  const vendorToken = useVendorAuthStore((s) => s.token);
  const [error, setError] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const pathname = location.pathname;
  const isTransporterPage = pathname === '/login/transporter';
  const isVendorPage = pathname === '/login/vendor';

  const tab = isTransporterPage ? 'partner' : isVendorPage ? 'supplier' : 'employee';
  // BUG-FE-157: detect Caps Lock so users don't burn lockout attempts on a
  // password they typed in the wrong case.
  const [capsLockOn, setCapsLockOn] = useState(false);

  // BUG-FE-158: honor the deep-link captured by ProtectedRoute, falling
  // back to /launcher only when no `from` is provided.
  const redirectTo = (location.state && location.state.from) || '/launcher';

  useEffect(() => {
    if (token) {
      navigate(redirectTo, { replace: true });
    }
  }, [token, navigate, redirectTo]);

  // Carrier session redirect — independent of employee session.
  useEffect(() => {
    if (carrierToken) {
      navigate('/carrier', { replace: true });
    }
  }, [carrierToken, navigate]);

  // Supplier (material vendor) session redirect — independent of both.
  useEffect(() => {
    if (vendorToken) {
      navigate('/supplier', { replace: true });
    }
  }, [vendorToken, navigate]);

  useEffect(() => {
    // BUG-FE-156: only pre-fill username when the user explicitly opted in
    // (`remember_user_enabled`). Otherwise the previous user's name leaks on
    // a shared workstation, which is a privacy/security issue. When opt-in
    // is missing we still surface the "Remember me" flag as off.
    const rememberedUser = localStorage.getItem('remember_user');
    const optIn = localStorage.getItem('remember_user_enabled') === '1';
    if (rememberedUser && optIn) {
      setUsername(rememberedUser);
      setRemember(true);
    } else {
      setRemember(false);
      // best-effort: clear stale value if the opt-in flag is missing
      if (rememberedUser && !optIn) {
        localStorage.removeItem('remember_user');
      }
    }
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!username.trim() || !password) {
      setError('Please enter your username and password.');
      return;
    }
    // Tab routing: partner → carrier auth, supplier → vendor auth, employee → regular auth.
    let result;
    if (tab === 'partner') {
      result = await carrierLogin(username, password);
    } else if (tab === 'supplier') {
      result = await vendorLogin(username, password);
    } else {
      result = await login(username, password, remember, { login_type: 'employee' });
    }
    if (!result.success) {
      setError(result.error);
    }
    // Navigation handled by token-watch useEffects.
  };

  const handleForgot = () => {
    // BUG-FE-155: provide a real action — open a pre-populated mail draft
    // to the IT support address so the user gets a one-click flow instead of
    // a static "contact admin" message. Falls back to a toast if mailto is
    // blocked by the browser.
    const subject = encodeURIComponent('Password reset request — Bavya SCM');
    const body = encodeURIComponent(
      `Username: ${username || '(please fill)'}\n\nDescribe the issue here.`,
    );
    const mailto = `mailto:it@bhspl.in?subject=${subject}&body=${body}`;
    try {
      window.location.href = mailto;
    } catch {
      message.info('Please email it@bhspl.in to reset your password.');
    }
  };

  return (
    <div className="bavya-login">
      {/* ───────── Brand pane ───────── */}
      <section className="bavya-login-brand">
        <div className="grid-overlay" aria-hidden />
        <header className="brand-header">
          <img src="/SCM_640logo1.png" alt="Bavya SCM" />
        </header>
        <div className="brand-hero">
          <h1>
            {tab === 'partner' ? (
              <>
                Transporter Control &{' '}
                <em>Freight Dispatch.</em>
              </>
            ) : tab === 'supplier' ? (
              <>
                B2B Procurement &{' '}
                <em>Material Supply.</em>
              </>
            ) : (
              <>
                Here, every supply chain creates a <em>lifeline.</em>
              </>
            )}
          </h1>
          <p>
            {tab === 'partner' ? (
              "Access active service orders, schedule fleet vehicles for gate entry checkpoint check-ins, record live transit delay warning logs, and sign off geofenced digital PODs."
            ) : tab === 'supplier' ? (
              "Submit competitive quotation bids on active SCM campaigns, review awarded purchase orders, manage packaging lists, and trace material delivery gating."
            ) : (
              "Procurement, warehousing, fleet and partner visibility — purpose-built for Bavya Health's 108 ambulances, mobile medical units, NTEP programs and district supply hubs."
            )}
          </p>
        </div>
      </section>

      {/* ───────── Form pane ───────── */}
      <section className="bavya-login-form-pane">
        <div className="form-top">
          <button type="button" className="lang">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
            </svg>
            English (IN)
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>

        <div className="form-body">
          <form className="form-card" onSubmit={handleSubmit} noValidate>
            <h2>
              {tab === 'partner' ? (
                <>Sign in to <em>Transporter Portal</em></>
              ) : tab === 'supplier' ? (
                <>Sign in to <em>Vendor Portal</em></>
              ) : (
                <>Sign in to <em>Bavya&nbsp;SCM</em></>
              )}
            </h2>



            {/* BUG-FE-161: surface "Account locked" / "Account disabled"
                hints with a stronger visual style so users notice they need
                to contact admin rather than retry the password. */}
            {error && (
              <div
                className={`bavya-login-error${/lock|disable|inactive/i.test(error) ? ' is-locked' : ''}`}
                role="alert"
                aria-live="assertive"
              >
                {error}
              </div>
            )}
            {capsLockOn && (
              <div className="bavya-login-warning" role="status" aria-live="polite">
                Caps Lock is on
              </div>
            )}

            <div className="field">
              <span className="pfx">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 21a8 8 0 0 1 16 0" />
                </svg>
              </span>
              <input
                type="text"
                id="login-username"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  // BUG-FE-162: clear stale "wrong password" error when the
                  // user starts typing a new username — otherwise the toast
                  // lingers and looks like a bug.
                  if (error) setError('');
                }}
                placeholder=" "
                autoComplete="username"
                autoFocus
                disabled={loading}
                maxLength={150}
              />
              <label htmlFor="login-username">
                {tab === 'partner' ? 'Transporter username' : tab === 'supplier' ? 'Supplier username' : 'Employee username'}
              </label>
            </div>

            <div className="field">
              <span className="pfx">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </span>
              <input
                type={showPassword ? 'text' : 'password'}
                id="login-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError('');
                }}
                onKeyDown={(e) => {
                  // BUG-FE-157: surface caps-lock state. getModifierState is
                  // available on KeyboardEvent in every supported browser.
                  if (typeof e.getModifierState === 'function') {
                    setCapsLockOn(e.getModifierState('CapsLock'));
                  }
                }}
                onKeyUp={(e) => {
                  if (typeof e.getModifierState === 'function') {
                    setCapsLockOn(e.getModifierState('CapsLock'));
                  }
                }}
                onCopy={(e) => e.preventDefault()}
                onPaste={(e) => e.preventDefault()}
                onCut={(e) => e.preventDefault()}
                placeholder=" "
                autoComplete="current-password"
                disabled={loading}
                maxLength={128}
              />
              <label htmlFor="login-password">Password</label>
              <span className="sfx">
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  title={showPassword ? 'Hide password' : 'Show password'}
                  tabIndex={-1}
                >
                  <Eye open={!showPassword} />
                </button>
              </span>
            </div>

            <div className="row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Keep me signed in on this device
              </label>
              <a href="#" onClick={(e) => { e.preventDefault(); handleForgot(); }} className="forgot">
                Forgot password?
              </a>
            </div>

            <button type="submit" className="btn-primary" disabled={loading || carrierLoading || vendorLoading}>
              {(loading || carrierLoading || vendorLoading) ? 'Signing in…' : 'Sign in'}
              {!(loading || carrierLoading || vendorLoading) && <ArrowRight />}
            </button>



            <div className="help-card">
              <div className="ic">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <path d="M12 17h.01" />
                </svg>
              </div>
              <div className="body">
                <b>First time signing in?</b>
                Use the invite link sent to your BHSPL email, or reach out to the stores admin
                for your district.
                <br />
                <a href="mailto:it@bhspl.in">Contact IT →</a>
              </div>
            </div>

            <div className="help-card download-app-card" style={{ marginTop: '16px', background: 'linear-gradient(135deg, rgba(72, 24, 144, 0.04) 0%, rgba(183, 0, 81, 0.04) 100%)', border: '1px dashed rgba(183, 0, 81, 0.2)' }}>
              <div className="ic" style={{ color: '#b70051' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                  <line x1="12" y1="18" x2="12.01" y2="18" />
                </svg>
              </div>
              <div className="body">
                <b>Bavya SCM Mobile App</b>
                Scan QR codes, receive material dispatches, and track field indents on the go.
                <br />
                <a href="/BHSPL_SCM.apk" download="BHSPL_SCM.apk" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', marginTop: '6px', fontWeight: 'bold', color: '#b70051', textDecoration: 'none' }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Download Android APK →
                </a>
              </div>
            </div>
          </form>
        </div>

        <footer className="form-footer">
          <div className="links">
            <a href="#">Terms</a>
            <a href="#">Privacy</a>
            <a href="#">DPDP Act</a>
            <a href="#">Security</a>
          </div>
          {/* BUG-FE-160: read env label from Vite so UAT/staging deploys
              don't keep showing 'scm-prod-01'. Falls back to a neutral label. */}
          <span className="env">
            {import.meta.env?.VITE_ENV_LABEL
              || (import.meta.env?.VITE_UAT === 'true' || import.meta.env?.VITE_UAT === '1' ? 'scm-uat-01' : 'scm-prod-01')}
            {' · '}
            {new Date().getFullYear()}
          </span>
        </footer>
      </section>
    </div>
  );
};

export default Login;
