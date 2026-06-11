#!/usr/bin/env node

/**
 * HR API Sync Script — Fetch ALL employees (2,802) and positions (3,701)
 * from the external HR API and push them into the SCM database.
 *
 * Usage:
 *   node scripts/sync-hr-api.js [options]
 *
 * Required:
 *   HR_API_KEY=<key>            X-API-Key header value
 *   BACKEND_TOKEN=<token>       JWT token for the SCM backend
 *
 * Options:
 *   --backend=<url>             SCM backend base URL (default: http://localhost:8000/api/v1)
 *   --dry-run                   Fetch only, no writes (+ saves ./hr-api-data.json)
 *   --verbose                   Detailed progress per page
 *   --save-json                 Save fetched data to hr-api-data.json (always true in dry-run)
 *   --help                      Show this help
 *
 * Quick start — login to the app, open DevTools → Application → Local Storage,
 * copy the "token" value, then run:
 *
 *   node scripts/sync-hr-api.js --token=<paste-token-here>
 *
 * Quickest start — just click "Run Full HR Sync" on the HR Sync Dashboard page.
 */

const HR_API_EMP    = 'http://103.174.161.68:8001/api/employees/';
const HR_API_POS    = 'http://103.174.161.68:8001/api/positions/';
const HR_EMP_COUNT  = 2802;   // verified source total
const HR_POS_COUNT  = 3701;   // verified source total

// ── Arg parsing ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(require('fs').readFileSync(__filename, 'utf-8').split('\n').slice(0, 32).join('\n'));
  process.exit(0);
}
const get = (pfx, fallback) => {
  const m = args.find(a => a.startsWith(pfx));
  const env = { key:'HR_API_KEY', token:'BACKEND_TOKEN', backend:'BACKEND_URL' }[pfx.replace(/^-+/,'').split('=')[0]];
  return m ? m.split('=')[1] || fallback : (env ? process.env[env] : undefined) || fallback;
};
const HR_API_KEY   = get('--key=', process.env.HR_API_KEY);
const BACKEND_URL  = (get('--backend=', process.env.BACKEND_URL) || 'http://localhost:8000/api/v1').replace(/\/+$/, '');
const BACKEND_TOKEN= get('--token=', process.env.BACKEND_TOKEN);
const DRY_RUN      = args.includes('--dry-run') || process.env.DRY_RUN === 'true';
const VERBOSE      = args.includes('--verbose') || process.env.VERBOSE === 'true';
const SAVE_JSON    = args.includes('--save-json') || DRY_RUN;

if (!HR_API_KEY) { console.error('ERROR: HR_API_KEY is required.'); process.exit(1); }
if (!BACKEND_TOKEN && !DRY_RUN) {
  console.warn('ERROR: BACKEND_TOKEN (JWT) is required for live sync. Use --dry-run to test fetch only.');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────
const sleep   = ms => new Promise(r => setTimeout(r, ms));
const log     = msg => console.log(`[${new Date().toISOString().slice(0,19).replace('T',' ')}] ${msg}`);
const vlog    = msg => { if (VERBOSE) log(msg); };

/** Fetch *every* page from a paginated HR API endpoint. */
async function fetchAllPages(baseUrl, label) {
  const all = [];
  let count = 0, url = baseUrl;
  while (url) {
    vlog(`  ${label}: fetching ${url.split('?')[1] || url}...`);
    const r = await fetch(url, { headers: { 'X-API-Key': HR_API_KEY } });
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${label}: ${r.statusText}`);
    const d = await r.json();
    count = d.count;
    const recs = d.results || [];
    all.push(...recs);
    log(`  ${label}: page fetched ${recs.length} records (total: ${count}, fetched so far: ${all.length})`);
    url = d.next || null;
    if (url) await sleep(30);  // tiny delay between pages
  }
  log(`  ✅ ${label}: DONE — ${all.length} of ${count} fetched`);
  return all;
}

// ── Fetch employees (with embedded projects/offices) ─────────────────────
function extractEmployee(row) {
  const e = row.employee || {};
  return {
    id: e.id, name: e.name, employee_code: e.employee_code,
    photo: e.photo, status: e.status, dob: e.dob, gender: e.gender,
    pan_number: e.pan_number, aadhaar_number: e.aadhaar_number,
    email: e.email, phone: e.phone,
  };
}

// ── Fetch all data from HR API (parallel employees + positions) ──────────
async function fetchAllFromHRAPI() {
  log(`Connecting to HR API...`);
  log(`  Employees: ${HR_API_EMP}`);
  log(`  Positions: ${HR_API_POS}`);
  log(`  Auth: X-API-Key: ${HR_API_KEY.slice(0,6)}…${HR_API_KEY.slice(-4)}`);

  const start = Date.now();

  // Run both fetches IN PARALLEL — cuts ~50% off wall-clock time
  const [employees, positions] = await Promise.all([
    fetchAllPages(HR_API_EMP,  'Employees'),
    fetchAllPages(HR_API_POS,  'Positions'),
  ]);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  // Derive counts
  const totalEmp = employees.length;
  const totalPos = positions.length;

  log('');
  log(`╔═══════════════════════════════════════════════╗`);
  log(`║           HR API FETCH COMPLETE               ║`);
  log(`╚═══════════════════════════════════════════════╝`);
  log(`  Employees: ${totalEmp} (source: ${HR_EMP_COUNT})`);
  log(`  Positions: ${totalPos} (source: ${HR_POS_COUNT})`);
  log(`  Time: ${elapsed}s`);

  // Map employee IDs to codes for the positions fallback
  const empCodeMap = new Map(employees.map(e => [e.id, e.employee_code]));
  const empNameMap = new Map(employees.map(e => [e.id, e.name]));

  // Attach employee_code/name to positions when assigned_employee exists
  const enrichedPositions = positions.map(p => {
    const ae = p.assigned_employee || {};
    const eid = ae.id;
    return {
      id: p.id, name: p.name, code: p.code,
      office_id: p.office_id, office_name: p.office_name,
      office_level: p.office_level, office_hierarchy: p.office_hierarchy,
      department_id: p.department_id, department_name: p.department_name,
      section_id: p.section_id, section_name: p.section_name,
      role_id: p.role_id, role_name: p.role_name,
      job_id: p.job_id, job_name: p.job_name, job_family_name: p.job_family_name,
      project_name: p.project_name,
      status: p.status, level: p.level, level_name: p.level_name, level_rank: p.level_rank,
      start_date: p.start_date, created_at: p.created_at,
      reporting_to: p.reporting_to, reporting_to_names: p.reporting_to_names,
      reporting_to_details: p.reporting_to_details,
      assigned_employee: ae || null,
      employee_id: eid || null,
      employee_code: (eid ? empCodeMap.get(eid) : null) || null,
      employee_name: (eid ? empNameMap.get(eid) : null) || ae.name || null,
      employee_status: ae.status || null,
    };
  });

  return { employees, positions: enrichedPositions, totalEmp, totalPos };
}

// ── Sync to backend ──────────────────────────────────────────────────────
async function syncToBackend(data) {
  const { employees, positions } = data;

  log(`\n=== Backend Sync ===`);
  log(`  URL: ${BACKEND_URL}`);
  log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  log(`  Employees: ${employees.length}`);
  log(`  Positions: ${positions.length}`);

  if (DRY_RUN) {
    log('\n  [DRY RUN] To save fetched data: --save-json or remove --dry-run');
    return null;
  }

  const ac = new AbortController();
  const acTimeout = setTimeout(() => ac.abort(), 300_000);

  // Build employee→position lookup map (O(n) instead of O(n*m))
  const posByEmpId = new Map();
  for (const p of positions) {
    if (p.employee_id != null) posByEmpId.set(p.employee_id, p);
  }

  // 1) Build payload for the dedicated sync-api endpoint
  const payload = {
    hr_api_employees: HR_EMP_COUNT,
    hr_api_positions: HR_POS_COUNT,
    trigger: 'full_sync',
    employees: employees.map(e => ({
      ...e,
      position_name: posByEmpId.get(e.id)?.name || null,
    })),
    positions,
  };

  log('\n  1) Trying /masters/employees/sync-api …');

  const tryUrls = [
    `${BACKEND_URL}/masters/employees/sync-api`,
    `${BACKEND_URL.replace('/api/v1', '')}/masters/employees/sync-api`,
    `${BACKEND_URL}/masters/employees/bulk-sync`,
  ];

  for (const url of tryUrls) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type':'application/json',
                   'Authorization':`Bearer ${BACKEND_TOKEN}`,
                   'X-HR-Sync':'1' },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      clearTimeout(acTimeout);
      if (r.ok) {
        const result = await r.json();
        log(`  ✅ Sync API SUCCESS`);
        log(`     Fetched: ${result.fetched || result.employees_fetched || employees.length}`);
        log(`     Created: ${result.created || 0}  Updated: ${result.updated || 0}`);
        log(`     Positions: ${result.positions_created || 0} created, ${result.positions_updated || 0} updated`);
        log(`     Linked users: ${result.linked_users || 0}`);
        return result;
      }
      const txt = await r.text().catch(() => '');
      log(`  ⚠ ${url} → HTTP ${r.status}: ${txt.slice(0, 120)}`);
    } catch (e) {
      if (e.name === 'AbortError') { log('  ✗ Request timed out'); break; }
      log(`  ⚠ ${url} → ${e.message}`);
    }
  }

  // 2) Fallback: create/update employees individually
  log('\n  2) Falling back to individual employee create/update…');
  let created = 0, updated = 0, errors = 0;

  for (let i = 0; i < employees.length; i++) {
    const e = employees[i];
    const pos = positions.find(p => p.employee_id === e.id);

    const body = {
      employee_code: e.employee_code, name: e.name, status: e.status,
      phone: e.phone, email: e.email, gender: e.gender, dob: e.dob,
      pan_number: e.pan_number, aadhaar_number: e.aadhaar_number, photo: e.photo,
      position_id: pos?.id, position_name: pos?.name,
      position_code: pos?.code, role_name: pos?.role_name,
      department: pos?.department_name, level_name: pos?.level_name,
    };

    try {
      // Quick search by employee_code
      const sr = await fetch(`${BACKEND_URL}/masters/employees?search=${e.employee_code}&page_size=1`, {
        headers: { 'Authorization':`Bearer ${BACKEND_TOKEN}` },
        signal: AbortSignal.timeout(8_000),
      });
      const sd = await sr.json().catch(() => ({}));
      const existing = (sd.items || sd.data || []).find(x => x.employee_code === e.employee_code);

      const res = await fetch(
        existing ? `${BACKEND_URL}/masters/employees/${existing.id}`
                 : `${BACKEND_URL}/masters/employees`, {
        method: existing ? 'PUT' : 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${BACKEND_TOKEN}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) existing ? updated++ : created++;
      else errors++;
    } catch { errors++; }

    if ((i+1) % 100 === 0) log(`  Progress: ${i+1}/${employees.length}  created=${created} updated=${updated} errors=${errors}`);
  }
  log(`  ✅ Done: ${created} created, ${updated} updated, ${errors} errors`);

  // 3) Create positions individually
  log('\n  3) Syncing positions individually…');
  let posCreated = 0, posUpdated = 0, posErrors = 0;

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const body = {
      name: p.name, code: p.code, office_id: p.office_id,
      department: p.department_name, section: p.section_name,
      role_name: p.role_name, level_name: p.level_name, level_rank: p.level_rank,
      project_name: p.project_name, status: p.status,
      employee_id: p.employee_id,
    };

    try {
      const sr = await fetch(`${BACKEND_URL}/masters/positions?search=${p.code}&page_size=1`, {
        headers: { 'Authorization':`Bearer ${BACKEND_TOKEN}` },
        signal: AbortSignal.timeout(8_000),
      });
      const sd = await sr.json().catch(() => ({}));
      const existing = (sd.items || sd.data || []).find(x => x.code === p.code || x.id === p.id);

      const res = await fetch(
        existing ? `${BACKEND_URL}/masters/positions/${existing.id}`
                 : `${BACKEND_URL}/masters/positions`, {
        method: existing ? 'PUT' : 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${BACKEND_TOKEN}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) existing ? posUpdated++ : posCreated++;
      else posErrors++;
    } catch { posErrors++; }

    if ((i+1) % 200 === 0) log(`  Positions: ${i+1}/${positions.length}  created=${posCreated} updated=${posUpdated} errors=${posErrors}`);
  }
  log(`  ✅ Positions done: ${posCreated} created, ${posUpdated} updated, ${posErrors} errors`);

  return { created, updated, errors, posCreated, posUpdated, posErrors };
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║    HR API → SCM Backend  (2,802 emp / 3,701 pos)  ║');
  console.log('╚═══════════════════════════════════════════════╝\n');

  const t0 = Date.now();

  // Step 1 — parallel fetch from both HR API endpoints
  const data = await fetchAllFromHRAPI();

  // Save to JSON when in dry-run or --save-json
  if (SAVE_JSON) {
    const outPath = 'hr-api-data.json';
    const fs = require('fs');
    fs.writeFileSync(outPath, JSON.stringify({ fetchedAt: new Date().toISOString(), ...data }, null, 2));
    log(`\n📁 Data saved to ${outPath} (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`);
    log(`   Import into DB by running with --token=<backend-jwt>`);
  }

  // Step 2 — push to backend
  const result = await syncToBackend(data);

  const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║                SYNC COMPLETE                  ║');
  console.log('╚═══════════════════════════════════════════════╝');
  log(`  Time: ${totalTime}s`);
  log(`  Employees fetched: ${data.employees.length}  /  ${HR_EMP_COUNT}`);
  log(`  Positions fetched: ${data.positions.length}  /  ${HR_POS_COUNT}`);
  if (result && typeof result === 'object') {
    for (const [k, v] of Object.entries(result)) log(`  ${k}: ${v}`);
  }
  log('\n✅ Done!');
}

main().catch(err => {
  console.error(`\n❌ FAILED: ${err.message}`);
  process.exit(1);
});
