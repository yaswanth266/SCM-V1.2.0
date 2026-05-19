import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Modal, Input, Empty, Spin, message, Select, Steps, Badge, Tag, Button, Switch, Upload,
} from 'antd';
import {
  PlayCircleFilled, BookOutlined, FileTextOutlined, ShoppingCartOutlined,
  HomeOutlined, DollarOutlined, AppstoreOutlined, SearchOutlined, CloseOutlined,
  ReloadOutlined, ArrowRightOutlined, ThunderboltFilled, ArrowLeftOutlined,
  FullscreenOutlined, UploadOutlined,
} from '@ant-design/icons';
import api from '../../config/api';
import { getErrorMessage } from '../../utils/helpers';

// Per-module visual identity — matches launcher palette
const MODULE_VISUAL = {
  indent:      { color: '#481890', bg: '#EEE6F7', icon: <FileTextOutlined /> },
  procurement: { color: '#D80048', bg: '#FDE6EC', icon: <ShoppingCartOutlined /> },
  warehouse:   { color: '#F09000', bg: '#FFEAD2', icon: <HomeOutlined /> },
  accounts:    { color: '#2E7D52', bg: '#E6F4EC', icon: <DollarOutlined /> },
  general:     { color: '#7A6D66', bg: '#F4EEEA', icon: <AppstoreOutlined /> },
};

// Bucket definitions — order matters for render
const BUCKETS = [
  {
    key: 'f1',
    label: 'Flow 1 — Fulfillment from stock',
    accent: '#481890',
    bg: 'linear-gradient(135deg, #EEE6F7 0%, #F8F4FD 100%)',
    test: (code) => /^f1[_-]/i.test(code || ''),
  },
  {
    key: 'f2',
    label: 'Flow 2 — Procurement when stock missing',
    accent: '#D80048',
    bg: 'linear-gradient(135deg, #FDE6EC 0%, #FFF4F7 100%)',
    test: (code) => /^f2[_-]/i.test(code || ''),
  },
  {
    key: 'common',
    label: 'General',
    accent: '#7A6D66',
    bg: 'linear-gradient(135deg, #F4EEEA 0%, #FBF8F5 100%)',
    test: () => true, // catch-all (last)
  },
];

// Best-effort step number extraction from a title like "Flow 1 · Step 3 — ..."
const extractStep = (title) => {
  if (!title) return null;
  const m = String(title).match(/Step\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
};

// Detect media type from URL extension
const mediaKind = (url) => {
  const u = String(url || '').toLowerCase().split('?')[0];
  if (/\.(gif)$/.test(u)) return 'gif';
  if (/\.(png|jpe?g|webp)$/.test(u)) return 'image';
  if (/\.(mp4|webm|mov|m4v)$/.test(u)) return 'video';
  return 'unknown';
};

// Smart media player with HEAD-probe 404 fallback. Always renders edge-to-edge
// inside its parent (the modal sizes the viewport).
const MediaPlayer = ({ url, fallbackText }) => {
  const [errored, setErrored] = useState(false);
  const [bust, setBust] = useState(0);
  const wrapRef = useRef(null);
  const videoRef = useRef(null);
  useEffect(() => { setErrored(false); setBust(0); }, [url]);

  const goFullscreen = () => {
    const el = videoRef.current || wrapRef.current;
    if (!el) return;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (fn) fn.call(el).catch(() => {});
  };

  if (!url) {
    return (
      <div className="bavya-lms-media-fallback">
        <ThunderboltFilled style={{ fontSize: 36, color: '#F09000' }} />
        <div className="bavya-lms-media-fallback-title">Walkthrough being recorded</div>
        <div className="bavya-lms-media-fallback-desc">{fallbackText || 'Check back soon.'}</div>
      </div>
    );
  }

  const isSafe =
    /^https?:\/\//i.test(url)
    || url.startsWith('/uploads/')
    || url.startsWith('/static/');
  if (!isSafe) {
    return (
      <div style={{
        padding: 32, background: '#fff2f0', color: '#cf1322',
        borderRadius: 8, textAlign: 'center', fontWeight: 600,
      }}>
        Refusing to play tutorial — its video URL uses an unsafe scheme.
        Please contact an administrator.
      </div>
    );
  }

  if (errored) {
    return (
      <div className="bavya-lms-media-fallback">
        <ThunderboltFilled style={{ fontSize: 36, color: '#F09000' }} />
        <div className="bavya-lms-media-fallback-title">Walkthrough being recorded — check back soon</div>
        <div className="bavya-lms-media-fallback-desc">{fallbackText || ''}</div>
      </div>
    );
  }

  const wrapStyle = {
    position: 'relative',
    width: '100%',
    height: '100%',
    minHeight: 0,
    background: '#000',
    borderRadius: 8,
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
  const fitStyle = {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    display: 'block',
  };
  const fsBtn = (
    <Button
      icon={<FullscreenOutlined />}
      onClick={goFullscreen}
      style={{ position: 'absolute', top: 12, right: 12, zIndex: 2 }}
    >
      Fullscreen
    </Button>
  );

  const kind = mediaKind(url);
  if (kind === 'gif') {
    const src = bust ? `${url}${url.includes('?') ? '&' : '?'}t=${bust}` : url;
    return (
      <div ref={wrapRef} style={wrapStyle}>
        <img
          key={src}
          src={src}
          alt="tutorial"
          onError={() => setErrored(true)}
          style={fitStyle}
        />
        <Button
          icon={<ReloadOutlined />}
          onClick={() => setBust(Date.now())}
          style={{ position: 'absolute', top: 12, right: 130, zIndex: 2 }}
        >
          Restart
        </Button>
        {fsBtn}
      </div>
    );
  }
  if (kind === 'image') {
    return (
      <div ref={wrapRef} style={wrapStyle}>
        <img src={url} alt="tutorial" onError={() => setErrored(true)} style={fitStyle} />
        {fsBtn}
      </div>
    );
  }
  // Default: video
  return (
    <div ref={wrapRef} style={wrapStyle}>
      <video
        ref={videoRef}
        key={url}
        src={url}
        controls
        autoPlay
        playsInline
        controlsList="nodownload"
        onError={() => setErrored(true)}
        style={fitStyle}
      />
      {fsBtn}
    </div>
  );
};

const Lms = () => {
  const navigate = useNavigate();
  const [videos, setVideos] = useState([]);
  const [userRoles, setUserRoles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(null);
  const [search, setSearch] = useState('');
  const [filterModule, setFilterModule] = useState(undefined);
  const [showAll, setShowAll] = useState(false); // super_admin toggle (local: hides role tags)
  const [seenMap, setSeenMap] = useState({}); // {code: true}

  const isSuperAdmin = userRoles.includes('super_admin');

  // Resolve a stable "username" for localStorage keying
  const username = useMemo(() => {
    try {
      const raw = localStorage.getItem('user');
      if (raw) {
        const u = JSON.parse(raw);
        if (u?.username) return u.username;
      }
    } catch (_) { /* ignore */ }
    return userRoles.length ? `roles:${userRoles.join(',')}` : 'anon';
  }, [userRoles]);

  const seenKey = `bavya_lms_seen::${username}`;

  // Load seen state per username
  useEffect(() => {
    try {
      const raw = localStorage.getItem(seenKey);
      setSeenMap(raw ? JSON.parse(raw) : {});
    } catch (_) {
      setSeenMap({});
    }
  }, [seenKey]);

  const markSeen = useCallback((code) => {
    if (!code) return;
    setSeenMap((prev) => {
      if (prev[code]) return prev;
      const next = { ...prev, [code]: true };
      try { localStorage.setItem(seenKey, JSON.stringify(next)); } catch (_) {}
      return next;
    });
  }, [seenKey]);

  useEffect(() => {
    setLoading(true);
    api.get('/lms/videos')
      .then((res) => {
        setVideos(res.data?.items || []);
        setUserRoles(res.data?.user_roles || []);
      })
      .catch((err) => message.error(getErrorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  const modules = useMemo(
    () => [...new Set(videos.map((v) => v.module).filter(Boolean))],
    [videos]
  );

  const filtered = useMemo(() => videos.filter((v) => {
    if (filterModule && v.module !== filterModule) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (v.title || '').toLowerCase().includes(q)
      || (v.description || '').toLowerCase().includes(q)
      || (v.code || '').toLowerCase().includes(q)
    );
  }), [videos, filterModule, search]);

  // Bucket the filtered items
  const buckets = useMemo(() => {
    const out = BUCKETS.map((b) => ({ ...b, items: [] }));
    filtered.forEach((v) => {
      const idx = out.findIndex((b) => b.test(v.code));
      const target = idx >= 0 ? idx : out.length - 1;
      out[target].items.push(v);
    });
    // Sort each bucket by step (then sort_order)
    out.forEach((b) => {
      b.items.sort((a, c) => {
        const sa = extractStep(a.title) ?? 999;
        const sc = extractStep(c.title) ?? 999;
        if (sa !== sc) return sa - sc;
        return (a.sort_order || 0) - (c.sort_order || 0);
      });
    });
    return out.filter((b) => b.items.length > 0);
  }, [filtered]);

  // "My next step" — first card matching role and unseen
  const nextStep = useMemo(() => {
    if (!videos.length) return null;
    const matchesRole = (v) => {
      if (!v.role_codes) return true;
      const codes = String(v.role_codes).split(/[,\s]+/).filter(Boolean);
      if (!codes.length) return true;
      return codes.some((c) => userRoles.includes(c));
    };
    return videos.find((v) => matchesRole(v) && !seenMap[v.code]) || null;
  }, [videos, userRoles, seenMap]);

  const tileRefs = useRef({});

  const openVideo = useCallback((v) => {
    setActive(v);
    markSeen(v.code);
  }, [markSeen]);

  const jumpToNext = () => {
    if (!nextStep) return;
    const el = tileRefs.current[nextStep.code];
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setTimeout(() => openVideo(nextStep), 350);
  };

  const clearFilters = () => {
    setSearch('');
    setFilterModule(undefined);
  };

  // Active step (for highlighting timeline) when modal is open
  const activeBucketKey = active
    ? (BUCKETS.find((b) => b.test(active.code))?.key || 'common')
    : null;
  const activeStep = active ? extractStep(active.title) : null;

  return (
    <div className="bavya-lms">
      <div className="bavya-lms-topbar">
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => navigate('/launcher')}
          className="bavya-lms-back"
        >
          Back to home
        </Button>
      </div>
      <div className="bavya-lms-hero">
        <div className="bavya-lms-eyebrow">
          <BookOutlined /> Learning Center
        </div>
        <h1>
          Tutorials for <em>your role</em>.
        </h1>
        <div className="bavya-lms-sub">
          {userRoles.length > 0
            ? `Curated for: ${userRoles.join(' · ')}`
            : 'Curated short videos showing exactly what you need to do in the system.'}
        </div>

        {nextStep && (
          <div
            className="bavya-lms-next"
            onClick={jumpToNext}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && jumpToNext()}
          >
            <span className="bavya-lms-next-label">Resume where you left off</span>
            <span className="bavya-lms-next-title">
              {extractStep(nextStep.title) ? `Step ${extractStep(nextStep.title)}: ` : ''}
              {nextStep.title}
            </span>
            <ArrowRightOutlined />
          </div>
        )}

        <div className="bavya-lms-toolbar">
          <div className="bavya-lms-search">
            <SearchOutlined />
            <input
              placeholder="Search tutorials…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <CloseOutlined
                onClick={() => setSearch('')}
                style={{ cursor: 'pointer', color: '#7A6D66' }}
              />
            )}
          </div>
          <Select
            allowClear
            placeholder="All modules"
            style={{ width: 180 }}
            value={filterModule}
            onChange={setFilterModule}
            options={modules.map((m) => ({ label: m.charAt(0).toUpperCase() + m.slice(1), value: m }))}
            popupMatchSelectWidth={false}
          />
          {isSuperAdmin && (
            <div className="bavya-lms-allroles">
              <Switch
                size="small"
                checked={showAll}
                onChange={setShowAll}
              />
              <span>Show all roles</span>
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
          <Spin size="large" />
        </div>
      ) : buckets.length === 0 ? (
        <div style={{ padding: 60, textAlign: 'center' }}>
          <Empty description={
            videos.length === 0
              ? (userRoles.length === 0
                  ? 'No tutorials assigned to your role yet — please contact an administrator to be assigned.'
                  : 'No tutorials are currently published for your roles.')
              : (search || filterModule
                  ? 'Nothing matches your filters'
                  : 'No tutorials match.')
          }>
            {(search || filterModule) && (
              <Button type="primary" onClick={clearFilters}>Clear filters</Button>
            )}
          </Empty>
        </div>
      ) : (
        <div className="bavya-lms-buckets">
          {buckets.map((bucket) => {
            // Build timeline steps for this bucket
            const steps = bucket.items.map((v) => {
              const n = extractStep(v.title);
              const titleClean = String(v.title || '').replace(/^.*?Step\s+\d+\s*[—–-]\s*/i, '').trim();
              return {
                title: n ? `Step ${n}` : (titleClean.split(' ').slice(0, 2).join(' ') || '•'),
                description: titleClean.length > 28 ? titleClean.slice(0, 26) + '…' : titleClean,
              };
            });
            // Determine current index for highlight
            let currentIdx = -1;
            if (active && activeBucketKey === bucket.key) {
              currentIdx = bucket.items.findIndex((it) => it.code === active.code);
            }
            return (
              <section
                key={bucket.key}
                className="bavya-lms-bucket"
                style={{ '--bucket-accent': bucket.accent, '--bucket-bg': bucket.bg }}
              >
                <div className="bavya-lms-bucket-head">
                  <h2 className="bavya-lms-bucket-title">{bucket.label}</h2>
                  <span className="bavya-lms-bucket-count">{bucket.items.length} tutorial{bucket.items.length === 1 ? '' : 's'}</span>
                </div>
                {steps.length > 1 && (
                  <div className="bavya-lms-bucket-steps">
                    <Steps
                      progressDot
                      size="small"
                      current={currentIdx >= 0 ? currentIdx : 0}
                      items={steps}
                      onChange={(i) => openVideo(bucket.items[i])}
                    />
                  </div>
                )}
                <div className="bavya-lms-grid">
                  {bucket.items.map((v) => {
                    const visual = MODULE_VISUAL[v.module] || MODULE_VISUAL.general;
                    const stepN = extractStep(v.title);
                    const seen = !!seenMap[v.code];
                    return (
                      <div
                        key={v.code || v.id}
                        ref={(el) => { if (el) tileRefs.current[v.code] = el; }}
                        className={`bavya-lms-tile${seen ? ' is-seen' : ''}`}
                        style={{ '--tile-color': visual.color, '--tile-bg': visual.bg }}
                        onClick={() => openVideo(v)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => e.key === 'Enter' && openVideo(v)}
                      >
                        <div className="bavya-lms-tile-thumb">
                          <PlayCircleFilled />
                          {stepN != null ? (
                            <div className="bavya-lms-step-badge" title={`Step ${stepN}`}>{stepN}</div>
                          ) : null}
                          <div className="bavya-lms-tile-num">{(v.code || '').toUpperCase()}</div>
                          {seen && <Badge className="bavya-lms-seen-badge" status="success" text="Watched" />}
                        </div>
                        <div className="bavya-lms-tile-body">
                          <div className="bavya-lms-tile-mod">
                            <span className="bavya-lms-tile-modico">{visual.icon}</span>
                            <span>{v.module || 'general'}</span>
                          </div>
                          <div className="bavya-lms-tile-title">{v.title}</div>
                          <div className="bavya-lms-tile-desc">{v.description || 'Tutorial walkthrough'}</div>
                          {!showAll && v.role_codes && (
                            <div className="bavya-lms-tile-roles">
                              {String(v.role_codes).split(/[,\s]+/).filter(Boolean).slice(0, 4).map((rc) => (
                                <Tag key={rc} color={userRoles.includes(rc) ? visual.color : 'default'} style={{ marginRight: 4 }}>
                                  {rc}
                                </Tag>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <Modal
        open={!!active}
        onCancel={() => setActive(null)}
        footer={null}
        width="92vw"
        style={{ maxWidth: 1400, top: 24 }}
        bodyStyle={{ padding: 0, height: 'calc(92vh - 64px)', display: 'flex', flexDirection: 'column' }}
        destroyOnHidden
        className="bavya-lms-modal"
        title={
          active && (
            <div className="bavya-lms-modal-title">
              {activeStep != null ? (
                <span className="bavya-lms-modal-num">Step {activeStep}</span>
              ) : (
                <span className="bavya-lms-modal-num">
                  {videos.findIndex((x) => x.code === active.code) + 1}.
                </span>
              )}
              <span>{active.title}</span>
            </div>
          )
        }
      >
        {active && (
          <>
            {active.description && (
              <p className="bavya-lms-modal-desc">{active.description}</p>
            )}
            <div style={{ flex: 1, minHeight: 0, padding: '0 24px' }}>
              <MediaPlayer
                url={String(active.video_url || '').trim()}
                fallbackText={active.description}
              />
            </div>
            <div className="bavya-lms-modal-meta" style={{ padding: '12px 24px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
              <span>
                For: <strong>{active.role_codes}</strong>
                {active.module ? <> · Module: <strong>{active.module}</strong></> : null}
                {active.code ? <> · Code: <code>{active.code}</code></> : null}
              </span>
              {(userRoles.includes('super_admin') || userRoles.includes('admin')) && (
                <Upload
                  name="file"
                  accept=".mp4,.webm,.mov,.m4v,.gif"
                  showUploadList={false}
                  customRequest={async ({ file, onSuccess, onError }) => {
                    try {
                      const fd = new FormData();
                      fd.append('file', file);
                      const r = await api.post(`/lms/videos/${active.id}/upload`, fd, {
                        headers: { 'Content-Type': 'multipart/form-data' },
                      });
                      message.success('Video uploaded — refreshing tutorial');
                      // refresh in place
                      setActive((prev) => prev ? { ...prev, video_url: r.data.video_url } : prev);
                      setVideos((prev) => prev.map((v) => v.id === active.id ? { ...v, video_url: r.data.video_url } : v));
                      onSuccess && onSuccess(r.data);
                    } catch (err) {
                      message.error(getErrorMessage(err));
                      onError && onError(err);
                    }
                  }}
                >
                  <Button icon={<UploadOutlined />} type="primary">Replace video (MP4/WebM)</Button>
                </Upload>
              )}
            </div>
          </>
        )}
      </Modal>
    </div>
  );
};

export default Lms;

