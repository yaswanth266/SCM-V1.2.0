import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import * as XLSX from 'xlsx';
import { message } from 'antd';
import { DATE_FORMAT, DATETIME_FORMAT, STATUS_COLORS, STATUS_LABELS } from './constants';

dayjs.extend(utc);
dayjs.extend(timezone);

// All human-visible timestamps are in IST. Backend stores UTC — we convert on
// display.
const IST_TZ = 'Asia/Kolkata';

export const formatCurrency = (amount, currency = 'INR') => {
  if (amount == null) return '-';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
};

export const formatNumber = (num) => {
  if (num == null) return '-';
  return new Intl.NumberFormat('en-IN').format(num);
};

/**
 * Normalize legacy short doc numbers (e.g. "MR-00047") to the fiscal-year
 * format "BHSPL/FY/TYPE/sequence" used by all newer records. If the input
 * already contains "/", returned untouched. `date` is used to infer the FY
 * (Apr–Mar); missing date falls back to today's FY.
 */
export const formatDocNumber = (docNumber, date) => {
  if (!docNumber) return '';
  if (docNumber.includes('/')) return docNumber;
  const d = date ? new Date(date) : new Date();
  const y = d.getFullYear();
  const month = d.getMonth() + 1;
  const fyStart = month >= 4 ? y : y - 1;
  const fyStartShort = fyStart.toString().slice(-2);
  const fyEndShort = (fyStart + 1).toString().slice(-2);
  const fy = `${fyStartShort}-${fyEndShort}`;
  // BUG-FE-125: accept multi-segment legacy codes like "PO-AP-00012" by
  // capturing everything before the final dash-separated number.
  const m = docNumber.match(/^([A-Z][A-Z0-9_-]*?)[-_](\d+)$/i);
  if (!m) return docNumber;
  const [, prefix, seq] = m;
  return `BHSPL/${fy}/${prefix.toUpperCase()}/${seq.padStart(5, '0')}`;
};

// BUG-FE-126: bare date strings ("2026-04-28") are parsed by dayjs() in browser
// local TZ, so calling .tz('Asia/Kolkata') on a non-IST browser shifts them by
// up to a day (e.g. Apr 28 in UTC -> Apr 28 05:30 IST is fine, but Apr 28 in
// PST -> Apr 28 12:30 IST is fine; however a same-day 22:00 PST creation
// timestamp typed as date-only would land on Apr 29 IST). For YYYY-MM-DD strings
// we therefore *don't* convert TZ — we treat the date as already-IST.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Backend stores `DateTime` as naive UTC (no tz suffix). dayjs(str) parses
// such strings as browser-local, so a non-tagged UTC value displayed via
// .tz(IST) ends up +5:30 ahead. Force-parse as UTC, then convert to IST.
export const formatDate = (date) => {
  if (!date) return '-';
  if (typeof date === 'string' && DATE_ONLY_RE.test(date)) {
    return dayjs(date, 'YYYY-MM-DD').format(DATE_FORMAT);
  }
  return dayjs.utc(date).tz(IST_TZ).format(DATE_FORMAT);
};

export const formatDateTime = (date) => {
  if (!date) return '-';
  if (typeof date === 'string' && DATE_ONLY_RE.test(date)) {
    return dayjs(date, 'YYYY-MM-DD').format(DATETIME_FORMAT);
  }
  const d = dayjs.utc(date);
  return d.isValid() ? d.tz(IST_TZ).format(DATETIME_FORMAT) : dayjs(date).format(DATETIME_FORMAT);
};

export const formatDateForAPI = (date) => {
  // BUG-FE-127: distinguish between "no value" and "0" / falsy-but-valid.
  // Empty string / null / undefined return undefined so the caller can omit
  // the param. A real date that happens to evaluate falsy in JS is preserved.
  if (date === '' || date === null || date === undefined) return undefined;
  if (typeof date === 'string' && DATE_ONLY_RE.test(date)) {
    return date; // already in API format, preserve as-is
  }
  const parsed = dayjs(date);
  if (!parsed.isValid()) return undefined;
  return parsed.tz(IST_TZ).format('YYYY-MM-DD');
};

export const downloadExcel = (data, filename, sheetName = 'Sheet1') => {
  const ws = XLSX.utils.json_to_sheet(data);
  
  // Auto-fit column widths based on maximum cell content length
  if (Array.isArray(data) && data.length > 0) {
    const cols = [];
    const keys = Object.keys(data[0] || {});
    keys.forEach((key) => {
      let maxLen = key.length;
      data.forEach(row => {
        const valStr = String(row[key] !== null && row[key] !== undefined ? row[key] : '');
        if (valStr.length > maxLen) {
          maxLen = valStr.length;
        }
      });
      cols.push({ wch: Math.min(Math.max(maxLen + 3, 10), 50) }); // Enforce min 10, max 50 width
    });
    ws['!cols'] = cols;
  }
  
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, `${filename}_${dayjs().format('YYYYMMDD_HHmmss')}.xlsx`);
};

// BUG-FE-128: accept an `options.leading` flag so callers can opt into a
// leading-edge call (lodash-style). Default behaviour (trailing-edge only)
// is preserved for existing call-sites.
export const debounce = (func, wait = 300, options = {}) => {
  const { leading = false } = options;
  let timeout = null;
  let lastArgs = null;
  let lastInvokeTime = 0;
  const debounced = (...args) => {
    lastArgs = args;
    const now = Date.now();
    const callLeading = leading && (timeout === null) && (now - lastInvokeTime >= wait);
    if (callLeading) {
      lastInvokeTime = now;
      func(...args);
    }
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = null;
      if (!callLeading) {
        lastInvokeTime = Date.now();
        func(...lastArgs);
      }
    }, wait);
  };
  debounced.cancel = () => {
    if (timeout) clearTimeout(timeout);
    timeout = null;
    lastArgs = null;
  };
  return debounced;
};

export const getInitials = (name) => {
  if (!name) return '?';
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
};

export const truncate = (str, len = 50) => {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
};

export const generateId = () => {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
};

export const parseQueryParams = (search) => {
  return Object.fromEntries(new URLSearchParams(search));
};

export const buildQueryString = (params) => {
  const filtered = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== ''
  );
  return new URLSearchParams(filtered).toString();
};

export const getErrorMessage = (error) => {
  if (typeof error === 'string') return error;

  // BUG-FE-130: backend 422 validation errors are returned as
  // { success: false, message: 'Validation failed', errors: [{loc, msg, type}] }
  // NOT as { detail: [...] }. Handle 'errors' array first so the field-level
  // messages are surfaced instead of the generic 'Validation failed' fallback.
  const errorsArr = error?.response?.data?.errors;
  if (Array.isArray(errorsArr) && errorsArr.length > 0) {
    return errorsArr.map((d) => {
      const field = (d.loc || []).filter(l => l !== 'body').join(' → ') || '';
      // Strip the 'Value error, ' prefix Pydantic v2 adds to the msg
      const raw = d.msg || d.message || '';
      const msg = raw.replace(/^Value error,\s*/i, '');
      return field ? `${field}: ${msg}` : msg;
    }).join('\n');
  }

  if (error?.response?.data?.detail) {
    const detail = error.response.data.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) return detail.map((d) => {
      const field = (d.loc || []).filter(l => l !== 'body').join(' → ') || '';
      const raw = d.msg || d.message || '';
      const msg = raw.replace(/^Value error,\s*/i, '');
      return field ? `${field}: ${msg}` : msg;
    }).join('\n');
    // BUG-FE-123: previously fell through to JSON.stringify which leaks
    // internal field paths and types into the toast. Surface a generic
    // message instead and let the caller log the full object.
    if (detail && typeof detail === 'object') {
      // Common shapes: {message: '...'} or {error: '...'}
      if (typeof detail.message === 'string') return detail.message;
      if (typeof detail.error === 'string') return detail.error;
      return 'Request failed (see network log for details)';
    }
    return String(detail);
  }
  if (error?.response?.data?.message) return error.response.data.message;
  if (error?.message) return error.message;
  return 'An unexpected error occurred';
};

// BUG-FE-129: Translate FastAPI 422 validation errors into per-field errors and
// push them into an Antd Form via form.setFields(). Returns the list of field
// errors that were applied so the caller can decide whether to also toast.
//
// Usage:
//   try { await api.post(...); }
//   catch (err) {
//     const applied = applyFieldErrors(form, err);
//     if (!applied.length) message.error(getErrorMessage(err));
//   }
export const applyFieldErrors = (form, error) => {
  if (!form || typeof form.setFields !== 'function') return [];
  // Handle both 'errors' array (backend 422 custom format) and 'detail' array (raw FastAPI format)
  const source = error?.response?.data?.errors || error?.response?.data?.detail;
  if (!Array.isArray(source)) return [];
  const fieldEntries = [];
  for (const d of source) {
    const loc = (d.loc || []).filter((l) => l !== 'body');
    if (!loc.length) continue;
    // Antd NamePath: single string for top-level fields, array for nested.
    const name = loc.length === 1 ? loc[0] : loc;
    const raw = d.msg || d.message || 'Invalid value';
    const msg = raw.replace(/^Value error,\s*/i, '');
    fieldEntries.push({ name, errors: [msg] });
  }
  if (fieldEntries.length) {
    form.setFields(fieldEntries);
  }
  return fieldEntries;
};

// BUG-FE-124: unify with authStore.hasPermission — default-DENY when permissions
// list is empty (was default-allow which contradicted authStore behavior and
// silently exposed gated features to unprivileged users importing this helper).
// Accepts both legacy object permissions ({module, actions:[...]}) and
// dotted-string permissions ("module.action.resource") for compatibility.
export const hasPermission = (permissions, module, action) => {
  if (!permissions || permissions.length === 0) return false;
  return permissions.some((p) => {
    if (typeof p === 'string') {
      const [pMod, pAct] = p.split('.');
      return (pMod === module || pMod === '*') && (!action || pAct === action || pAct === '*');
    }
    return p && p.module === module && (!action || p.actions?.includes(action));
  });
};

export const sortByKey = (arr, key, order = 'asc') => {
  return [...arr].sort((a, b) => {
    if (a[key] < b[key]) return order === 'asc' ? -1 : 1;
    if (a[key] > b[key]) return order === 'asc' ? 1 : -1;
    return 0;
  });
};

export const groupBy = (arr, key) => {
  return arr.reduce((acc, item) => {
    const group = item[key] || 'Other';
    acc[group] = acc[group] || [];
    acc[group].push(item);
    return acc;
  }, {});
};

export const flattenTree = (tree, childrenKey = 'children') => {
  const result = [];
  const flatten = (nodes) => {
    nodes.forEach((node) => {
      result.push(node);
      if (node[childrenKey]?.length) {
        flatten(node[childrenKey]);
      }
    });
  };
  flatten(tree);
  return result;
};

export const calcTaxAmount = (amount, rate) => {
  return Number(((amount * rate) / 100).toFixed(2));
};

export const calcTotalWithTax = (amount, cgst = 0, sgst = 0, igst = 0) => {
  const cgstAmt = calcTaxAmount(amount, cgst);
  const sgstAmt = calcTaxAmount(amount, sgst);
  const igstAmt = calcTaxAmount(amount, igst);
  return Number((amount + cgstAmt + sgstAmt + igstAmt).toFixed(2));
};

export const getStatusColor = (status) => {
  if (!status) return '#8c8c8c';
  return STATUS_COLORS[status.toLowerCase()] || '#8c8c8c';
};

export const getStatusText = (status) => {
  if (!status) return 'Unknown';
  return STATUS_LABELS[status.toLowerCase()] || status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};

export const handleFormValidationFailed = (errorInfo) => {
  try {
    message.error('Form submission blocked. Please correct the highlighted errors.');
    const firstErrorField = errorInfo?.errorFields?.[0];
    if (firstErrorField) {
      const fieldName = Array.isArray(firstErrorField.name)
        ? firstErrorField.name.join('_')
        : firstErrorField.name;

      const element = document.getElementById(fieldName) ||
                      document.querySelector(`[name="${fieldName}"]`) ||
                      document.getElementById(`parent_${fieldName}`) ||
                      document.querySelector(`[id$="_${fieldName}"]`);

      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => {
          try {
            element.focus();
          } catch (e) {
            // silent
          }
        }, 300);
      }
    }
  } catch (err) {
    console.error('Error in handleFormValidationFailed:', err);
  }
};

export const exportDetailsToExcel = (record, type) => {
  let title = '';
  let headers = [];
  let items = [];

  if (type === 'material_issue' || type === 'vehicle_issue') {
    title = type === 'material_issue' ? 'MATERIAL ISSUE' : 'VEHICLE MATERIAL ISSUE';
    headers = [
      { label: 'Issue Number', value: record.issue_number },
      { label: 'Status', value: record.status },
      { label: 'Issue Date', value: formatDate(record.issue_date) },
      { label: 'Source Warehouse', value: record.warehouse_name },
      ...(type === 'material_issue' ? [{ label: 'Destination Warehouse', value: record.destination_warehouse_name }] : []),
      { label: 'Department', value: record.department },
      { label: 'Issued To', value: record.issued_to_name || record.issued_to },
      { label: 'Indent Reference', value: record.indent_number || record.indent_id },
      { label: 'Vehicle Code', value: record.vehicle_code },
      { label: 'Vehicle Number', value: record.vehicle_number },
      { label: 'Remarks', value: record.remarks },
    ];
    items = record.items || [];
  } else if (type === 'material_acknowledgement') {
    title = 'VEHICLE MATERIAL ACKNOWLEDGEMENT';
    headers = [
      { label: 'Ack Number', value: record.acknowledgement_number },
      { label: 'Vehicle Issue #', value: record.vehicle_issue_number },
      { label: 'Vehicle Code', value: record.vehicle_code },
      { label: 'Vehicle Number', value: record.vehicle_number },
      { label: 'Employee Code', value: record.employee_code },
      { label: 'Acknowledged By', value: record.acknowledged_by_name },
      { label: 'Acknowledged At', value: formatDateTime(record.acknowledged_at) },
      { label: 'Remarks', value: record.remarks },
    ];
    items = record.items || [];
  }

  let html = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8">
      <style>
        .title { background-color: #1e3a8a; color: #ffffff; font-weight: bold; font-size: 16px; text-align: center; height: 40px; border: 1px solid #cbd5e1; }
        .header-label { background-color: #f1f5f9; color: #475569; font-weight: bold; border: 1px solid #cbd5e1; }
        .header-value { background-color: #ffffff; color: #000000; border: 1px solid #cbd5e1; }
        .item-th { background-color: #0d9488; color: #ffffff; font-weight: bold; border: 1px solid #cbd5e1; }
        .item-row { background-color: #f0fdfa; color: #0f766e; border: 1px solid #cbd5e1; font-weight: bold; }
        .serial-row { background-color: #fef9c3; color: #854d0e; font-family: monospace; border: 1px solid #cbd5e1; }
        .section-divider { background-color: #e2e8f0; height: 20px; }
        td, th { padding: 8px; text-align: left; vertical-align: middle; }
        .text-right { text-align: right; }
      </style>
    </head>
    <body>
      <table>
        <tr>
          <th colspan="7" class="title">${title}</th>
        </tr>
  `;

  for (let i = 0; i < headers.length; i += 2) {
    const h1 = headers[i];
    const h2 = headers[i + 1];
    html += `
      <tr>
        <td class="header-label">${h1 ? h1.label : ''}</td>
        <td colspan="2" class="header-value">${h1 && h1.value !== null && h1.value !== undefined ? h1.value : '-'}</td>
        <td class="header-label">${h2 ? h2.label : ''}</td>
        <td colspan="3" class="header-value">${h2 && h2.value !== null && h2.value !== undefined ? h2.value : '-'}</td>
      </tr>
    `;
  }

  html += `
    <tr class="section-divider">
      <td colspan="7"></td>
    </tr>
    <tr>
      <th class="item-th" style="width: 5%;">#</th>
      <th class="item-th" style="width: 25%;">Item Code</th>
      <th class="item-th" style="width: 35%;">Item Name</th>
      <th class="item-th" style="width: 10%;">UOM</th>
      <th class="item-th style="width: 10%; text-align: right;">Qty</th>
      <th class="item-th style="width: 15%; text-align: right;">Rate</th>
      <th class="item-th style="width: 15%; text-align: right;">Amount</th>
    </tr>
  `;

  items.forEach((item, idx) => {
    const itemCode = item.item_code || '';
    const itemName = item.item_name || '';
    const uom = item.uom_name || item.uom || '-';
    const qty = Number(item.qty !== undefined ? item.qty : item.received_qty || 0);
    const rate = Number(item.rate || 0);
    const amount = Number(item.amount || (qty * rate) || 0);
    
    html += `
      <tr class="item-row">
        <td>${idx + 1}</td>
        <td>${itemCode}</td>
        <td>${itemName}</td>
        <td>${uom}</td>
        <td class="text-right">${formatNumber(qty)}</td>
        <td class="text-right">${type === 'material_acknowledgement' ? '-' : formatCurrency(rate)}</td>
        <td class="text-right">${type === 'material_acknowledgement' ? '-' : formatCurrency(amount)}</td>
      </tr>
    `;

    const serials = item.serial_numbers || [];
    const isSerialOrAsset = serials.length > 0 || item.has_serial || item.item_type === 'asset' || item.item_type === 'consumable';
    if (isSerialOrAsset) {
      if (serials.length > 0) {
        serials.forEach((serial, sIdx) => {
          const prefix = itemCode ? `${itemCode}-1-` : '';
          const displayCode = serial.startsWith(prefix) ? serial : `${prefix}${serial}`;
          html += `
            <tr class="serial-row">
              <td></td>
              <td style="color: #a16207; font-weight: bold;">[Code #${sIdx + 1}]</td>
              <td colspan="5" style="font-family: monospace;">${displayCode}</td>
            </tr>
          `;
        });
      } else {
        html += `
          <tr class="serial-row" style="background-color: #fef08a;">
            <td></td>
            <td style="color: #a16207; font-style: italic;">[Asset/Consumable]</td>
            <td colspan="5" style="color: #ca8a04; font-style: italic;">No specific codes/serials registered</td>
          </tr>
        `;
      }
    }
  });

  html += `
      </table>
    </body>
    </html>
  `;

  const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', `${type}_detail_${record.issue_number || record.acknowledgement_number || record.id}_${dayjs().format('YYYYMMDD_HHmmss')}.xls`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

export const printDetailsToPDF = (record, type) => {
  let title = '';
  let headers = [];
  let items = [];

  if (type === 'material_issue' || type === 'vehicle_issue') {
    title = type === 'material_issue' ? 'Material Issue' : 'Vehicle Material Issue';
    headers = [
      { label: 'Issue Number', value: record.issue_number },
      { label: 'Status', value: record.status },
      { label: 'Issue Date', value: formatDate(record.issue_date) },
      { label: 'Source Warehouse', value: record.warehouse_name },
      ...(type === 'material_issue' ? [{ label: 'Destination Warehouse', value: record.destination_warehouse_name }] : []),
      { label: 'Department', value: record.department },
      { label: 'Issued To', value: record.issued_to_name || record.issued_to },
      { label: 'Indent Reference', value: record.indent_number || record.indent_id },
      { label: 'Vehicle Code', value: record.vehicle_code },
      { label: 'Vehicle Number', value: record.vehicle_number },
      { label: 'Remarks', value: record.remarks },
    ];
    items = record.items || [];
  } else if (type === 'material_acknowledgement') {
    title = 'Vehicle Material Acknowledgement';
    headers = [
      { label: 'Ack Number', value: record.acknowledgement_number },
      { label: 'Vehicle Issue #', value: record.vehicle_issue_number },
      { label: 'Vehicle Code', value: record.vehicle_code },
      { label: 'Vehicle Number', value: record.vehicle_number },
      { label: 'Employee Code', value: record.employee_code },
      { label: 'Acknowledged By', value: record.acknowledged_by_name },
      { label: 'Acknowledged At', value: formatDateTime(record.acknowledged_at) },
      { label: 'Remarks', value: record.remarks },
    ];
    items = record.items || [];
  }

  let headerHTML = '<table class="info-table"><tbody>';
  for (let i = 0; i < headers.length; i += 2) {
    const h1 = headers[i];
    const h2 = headers[i + 1];
    headerHTML += `
      <tr>
        <td class="label">${h1 ? h1.label : ''}</td>
        <td class="value">${h1 && h1.value !== null && h1.value !== undefined ? h1.value : '-'}</td>
        <td class="label">${h2 ? h2.label : ''}</td>
        <td class="value">${h2 && h2.value !== null && h2.value !== undefined ? h2.value : '-'}</td>
      </tr>
    `;
  }
  headerHTML += '</tbody></table>';

  let itemsHTML = '';
  items.forEach((item, idx) => {
    const itemCode = item.item_code || '';
    const itemName = item.item_name || '';
    const uom = item.uom_name || item.uom || '-';
    const qty = Number(item.qty !== undefined ? item.qty : item.received_qty || 0);
    const rate = Number(item.rate || 0);
    const amount = Number(item.amount || (qty * rate) || 0);

    itemsHTML += `
      <tr class="item-row">
        <td>${idx + 1}</td>
        <td>${itemCode}</td>
        <td>${itemName}</td>
        <td>${uom}</td>
        <td class="text-right">${formatNumber(qty)}</td>
        <td class="text-right">${type === 'material_acknowledgement' ? '-' : formatCurrency(rate)}</td>
        <td class="text-right">${type === 'material_acknowledgement' ? '-' : formatCurrency(amount)}</td>
      </tr>
    `;

    const serials = item.serial_numbers || [];
    const isSerialOrAsset = serials.length > 0 || item.has_serial || item.item_type === 'asset' || item.item_type === 'consumable';
    if (isSerialOrAsset) {
      if (serials.length > 0) {
        serials.forEach((serial, sIdx) => {
          const prefix = itemCode ? `${itemCode}-1-` : '';
          const displayCode = serial.startsWith(prefix) ? serial : `${prefix}${serial}`;
          itemsHTML += `
            <tr class="serial-row">
              <td></td>
              <td class="serial-label">[Code #${sIdx + 1}]</td>
              <td colspan="5">${displayCode}</td>
            </tr>
          `;
        });
      } else {
        itemsHTML += `
          <tr class="serial-row" style="background-color: #fef08a; color: #a16207;">
            <td></td>
            <td style="font-style: italic;">[Asset/Consumable]</td>
            <td colspan="5" style="font-style: italic;">No specific codes/serials registered</td>
          </tr>
        `;
      }
    }
  });

  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <html>
      <head>
        <title>${title} - ${record.issue_number || record.acknowledgement_number || record.id}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; padding: 25px; color: #1e293b; }
          .page-title { text-align: center; color: #1e3a8a; font-size: 22px; font-weight: bold; margin-bottom: 25px; text-transform: uppercase; border-bottom: 3px solid #1e3a8a; padding-bottom: 12px; }
          .section-title { font-size: 15px; font-weight: bold; color: #0d9488; margin-top: 30px; margin-bottom: 12px; border-bottom: 2px solid #cbd5e1; padding-bottom: 6px; text-transform: uppercase; }
          .info-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
          .info-table td { padding: 10px 12px; border: 1px solid #cbd5e1; font-size: 13px; }
          .info-table td.label { background-color: #f1f5f9; font-weight: bold; width: 20%; color: #475569; }
          .info-table td.value { width: 30%; color: #0f172a; }
          .items-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
          .items-table th { background-color: #0d9488; color: white; padding: 10px 12px; border: 1px solid #cbd5e1; text-align: left; font-weight: bold; font-size: 13px; }
          .items-table td { padding: 9px 12px; border: 1px solid #cbd5e1; font-size: 13px; }
          .item-row { background-color: #f0fdfa; color: #0f766e; font-weight: bold; }
          .serial-row { background-color: #fef9c3; color: #854d0e; font-family: monospace; font-size: 12px; }
          .serial-label { color: #a16207; font-weight: bold; }
          .text-right { text-align: right; }
          .no-print-btn { background-color: #1e3a8a; color: white; padding: 10px 20px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; margin-bottom: 20px; font-size: 13px; display: inline-flex; align-items: center; gap: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
          .no-print-btn:hover { background-color: #1d4ed8; }
          @media print {
            .no-print-btn { display: none; }
            body { padding: 10px; }
          }
        </style>
      </head>
      <body>
        <button class="no-print-btn" onclick="window.print()">Print / Save as PDF</button>
        <div class="page-title">${title}</div>
        ${headerHTML}
        <div class="section-title">ITEMS & SERIAL CODE BREAKDOWN</div>
        <table class="items-table">
          <thead>
            <tr>
              <th style="width: 5%">#</th>
              <th style="width: 25%">Item Code</th>
              <th style="width: 35%">Item Name</th>
              <th style="width: 10%">UOM</th>
              <th style="width: 10%" class="text-right">Qty</th>
              <th style="width: 15%" class="text-right">Rate</th>
              <th style="width: 15%" class="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHTML}
          </tbody>
        </table>
      </body>
    </html>
  `);
  printWindow.document.close();
  setTimeout(() => {
    printWindow.focus();
  }, 300);
};

export const exportGlobalToExcel = (records, type) => {
  if (!records || records.length === 0) return;
  
  let title = '';
  if (type === 'material_issue') {
    title = 'MATERIAL ISSUES';
  } else if (type === 'vehicle_issue') {
    title = 'VEHICLE MATERIAL ISSUES';
  } else if (type === 'material_acknowledgement') {
    title = 'VEHICLE MATERIAL ACKNOWLEDGEMENTS';
  }

  let html = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8">
      <style>
        .global-title { background-color: #1e3a8a; color: #ffffff; font-weight: bold; font-size: 16px; text-align: center; height: 40px; border: 1px solid #cbd5e1; }
        .record-title { background-color: #3b82f6; color: #ffffff; font-weight: bold; font-size: 13px; border: 1px solid #cbd5e1; height: 30px; }
        .header-label { background-color: #f1f5f9; color: #475569; font-weight: bold; border: 1px solid #cbd5e1; }
        .header-value { background-color: #ffffff; color: #000000; border: 1px solid #cbd5e1; }
        .item-th { background-color: #0d9488; color: #ffffff; font-weight: bold; border: 1px solid #cbd5e1; }
        .item-row { background-color: #f0fdfa; color: #0f766e; border: 1px solid #cbd5e1; font-weight: bold; }
        .serial-row { background-color: #fef9c3; color: #854d0e; font-family: monospace; border: 1px solid #cbd5e1; }
        .section-divider { background-color: #cbd5e1; height: 15px; }
        td, th { padding: 8px; text-align: left; vertical-align: middle; }
        .text-right { text-align: right; }
      </style>
    </head>
    <body>
      <table>
        <tr>
          <th colspan="7" class="global-title">${title}</th>
        </tr>
  `;

  records.forEach((record, recIdx) => {
    let headers = [];
    if (type === 'material_issue' || type === 'vehicle_issue') {
      headers = [
        { label: 'Issue Number', value: record.issue_number },
        { label: 'Status', value: record.status },
        { label: 'Issue Date', value: formatDate(record.issue_date) },
        { label: 'Source Warehouse', value: record.warehouse_name },
        ...(type === 'material_issue' ? [{ label: 'Destination Warehouse', value: record.destination_warehouse_name }] : []),
        { label: 'Department', value: record.department },
        { label: 'Issued To', value: record.issued_to_name || record.issued_to },
        { label: 'Indent Reference', value: record.indent_number || record.indent_id },
        { label: 'Vehicle Code', value: record.vehicle_code },
        { label: 'Vehicle Number', value: record.vehicle_number },
        { label: 'Remarks', value: record.remarks },
      ];
    } else if (type === 'material_acknowledgement') {
      headers = [
        { label: 'Ack Number', value: record.acknowledgement_number },
        { label: 'Vehicle Issue #', value: record.vehicle_issue_number },
        { label: 'Vehicle Code', value: record.vehicle_code },
        { label: 'Vehicle Number', value: record.vehicle_number },
        { label: 'Employee Code', value: record.employee_code },
        { label: 'Acknowledged By', value: record.acknowledged_by_name },
        { label: 'Acknowledged At', value: formatDateTime(record.acknowledged_at) },
        { label: 'Remarks', value: record.remarks },
      ];
    }

    const items = record.items || [];
    const recordNo = record.issue_number || record.acknowledgement_number || record.id || '';

    // Record subtitle banner
    html += `
      <tr class="section-divider"><td colspan="7"></td></tr>
      <tr>
        <th colspan="7" class="record-title">Record #${recIdx + 1}: ${recordNo}</th>
      </tr>
    `;

    // Metadata details
    for (let i = 0; i < headers.length; i += 2) {
      const h1 = headers[i];
      const h2 = headers[i + 1];
      html += `
        <tr>
          <td class="header-label">${h1 ? h1.label : ''}</td>
          <td colspan="2" class="header-value">${h1 && h1.value !== null && h1.value !== undefined ? h1.value : '-'}</td>
          <td class="header-label">${h2 ? h2.label : ''}</td>
          <td colspan="3" class="header-value">${h2 && h2.value !== null && h2.value !== undefined ? h2.value : '-'}</td>
        </tr>
      `;
    }

    // Items table header
    html += `
      <tr>
        <th class="item-th" style="width: 5%;">#</th>
        <th class="item-th" style="width: 25%;">Item Code</th>
        <th class="item-th" style="width: 35%;">Item Name</th>
        <th class="item-th" style="width: 10%;">UOM</th>
        <th class="item-th" style="width: 10%; text-align: right;">Qty</th>
        <th class="item-th" style="width: 15%; text-align: right;">Rate</th>
        <th class="item-th" style="width: 15%; text-align: right;">Amount</th>
      </tr>
    `;

    // Items and Serials
    items.forEach((item, idx) => {
      const itemCode = item.item_code || '';
      const itemName = item.item_name || '';
      const uom = item.uom_name || item.uom || '-';
      const qty = Number(item.qty !== undefined ? item.qty : item.received_qty || 0);
      const rate = Number(item.rate || 0);
      const amount = Number(item.amount || (qty * rate) || 0);
      
      html += `
        <tr class="item-row">
          <td>${idx + 1}</td>
          <td>${itemCode}</td>
          <td>${itemName}</td>
          <td>${uom}</td>
          <td class="text-right">${formatNumber(qty)}</td>
          <td class="text-right">${type === 'material_acknowledgement' ? '-' : formatCurrency(rate)}</td>
          <td class="text-right">${type === 'material_acknowledgement' ? '-' : formatCurrency(amount)}</td>
        </tr>
      `;

      const serials = item.serial_numbers || [];
      const isSerialOrAsset = serials.length > 0 || item.has_serial || item.item_type === 'asset' || item.item_type === 'consumable';
      if (isSerialOrAsset) {
        const serials = item.serial_numbers || [];
        if (serials.length > 0) {
          serials.forEach((serial, sIdx) => {
            const prefix = itemCode ? `${itemCode}-1-` : '';
            const displayCode = serial.startsWith(prefix) ? serial : `${prefix}${serial}`;
            html += `
              <tr class="serial-row">
                <td></td>
                <td style="color: #a16207; font-weight: bold;">[Code #${sIdx + 1}]</td>
                <td colspan="5" style="font-family: monospace;">${displayCode}</td>
              </tr>
            `;
          });
        } else {
          html += `
            <tr class="serial-row" style="background-color: #fef08a;">
              <td></td>
              <td style="color: #a16207; font-style: italic;">[Asset/Consumable]</td>
              <td colspan="5" style="color: #ca8a04; font-style: italic;">No specific codes/serials registered</td>
            </tr>
          `;
        }
      }
    });
  });

  html += `
      </table>
    </body>
    </html>
  `;

  const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', `global_${type}_export_${dayjs().format('YYYYMMDD_HHmmss')}.xls`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

export const printGlobalToPDF = (records, type) => {
  if (!records || records.length === 0) return;

  let title = '';
  if (type === 'material_issue') {
    title = 'Material Issues';
  } else if (type === 'vehicle_issue') {
    title = 'Vehicle Material Issues';
  } else if (type === 'material_acknowledgement') {
    title = 'Vehicle Material Acknowledgements';
  }

  let bodyHTML = '';

  records.forEach((record, recIdx) => {
    let headers = [];
    if (type === 'material_issue' || type === 'vehicle_issue') {
      headers = [
        { label: 'Issue Number', value: record.issue_number },
        { label: 'Status', value: record.status },
        { label: 'Issue Date', value: formatDate(record.issue_date) },
        { label: 'Source Warehouse', value: record.warehouse_name },
        ...(type === 'material_issue' ? [{ label: 'Destination Warehouse', value: record.destination_warehouse_name }] : []),
        { label: 'Department', value: record.department },
        { label: 'Issued To', value: record.issued_to_name || record.issued_to },
        { label: 'Indent Reference', value: record.indent_number || record.indent_id },
        { label: 'Vehicle Code', value: record.vehicle_code },
        { label: 'Vehicle Number', value: record.vehicle_number },
        { label: 'Remarks', value: record.remarks },
      ];
    } else if (type === 'material_acknowledgement') {
      headers = [
        { label: 'Ack Number', value: record.acknowledgement_number },
        { label: 'Vehicle Issue #', value: record.vehicle_issue_number },
        { label: 'Vehicle Code', value: record.vehicle_code },
        { label: 'Vehicle Number', value: record.vehicle_number },
        { label: 'Employee Code', value: record.employee_code },
        { label: 'Acknowledged By', value: record.acknowledged_by_name },
        { label: 'Acknowledged At', value: formatDateTime(record.acknowledged_at) },
        { label: 'Remarks', value: record.remarks },
      ];
    }

    const items = record.items || [];
    const recordNo = record.issue_number || record.acknowledgement_number || record.id || '';

    let headerHTML = '<table class="info-table"><tbody>';
    for (let i = 0; i < headers.length; i += 2) {
      const h1 = headers[i];
      const h2 = headers[i + 1];
      headerHTML += `
        <tr>
          <td class="label">${h1 ? h1.label : ''}</td>
          <td class="value">${h1 && h1.value !== null && h1.value !== undefined ? h1.value : '-'}</td>
          <td class="label">${h2 ? h2.label : ''}</td>
          <td class="value">${h2 && h2.value !== null && h2.value !== undefined ? h2.value : '-'}</td>
        </tr>
      `;
    }
    headerHTML += '</tbody></table>';

    let itemsHTML = '';
    items.forEach((item, idx) => {
      const itemCode = item.item_code || '';
      const itemName = item.item_name || '';
      const uom = item.uom_name || item.uom || '-';
      const qty = Number(item.qty !== undefined ? item.qty : item.received_qty || 0);
      const rate = Number(item.rate || 0);
      const amount = Number(item.amount || (qty * rate) || 0);

      itemsHTML += `
        <tr class="item-row">
          <td>${idx + 1}</td>
          <td>${itemCode}</td>
          <td>${itemName}</td>
          <td>${uom}</td>
          <td class="text-right">${formatNumber(qty)}</td>
          <td class="text-right">${type === 'material_acknowledgement' ? '-' : formatCurrency(rate)}</td>
          <td class="text-right">${type === 'material_acknowledgement' ? '-' : formatCurrency(amount)}</td>
        </tr>
      `;

      const serials = item.serial_numbers || [];
      const isSerialOrAsset = serials.length > 0 || item.has_serial || item.item_type === 'asset' || item.item_type === 'consumable';
      if (isSerialOrAsset) {
        const serials = item.serial_numbers || [];
        if (serials.length > 0) {
          serials.forEach((serial, sIdx) => {
            const prefix = itemCode ? `${itemCode}-1-` : '';
            const displayCode = serial.startsWith(prefix) ? serial : `${prefix}${serial}`;
            itemsHTML += `
              <tr class="serial-row">
                <td></td>
                <td class="serial-label">[Code #${sIdx + 1}]</td>
                <td colspan="5">${displayCode}</td>
              </tr>
            `;
          });
        } else {
          itemsHTML += `
            <tr class="serial-row" style="background-color: #fef08a; color: #a16207;">
              <td></td>
              <td style="font-style: italic;">[Asset/Consumable]</td>
              <td colspan="5" style="font-style: italic;">No specific codes/serials registered</td>
            </tr>
          `;
        }
      }
    });

    bodyHTML += `
      <div class="record-section" style="${recIdx > 0 ? 'page-break-before: always;' : ''}">
        <div class="record-header-title">Record #${recIdx + 1}: ${recordNo}</div>
        ${headerHTML}
        <div class="section-title">ITEMS & SERIAL CODE BREAKDOWN</div>
        <table class="items-table">
          <thead>
            <tr>
              <th style="width: 5%">#</th>
              <th style="width: 25%">Item Code</th>
              <th style="width: 35%">Item Name</th>
              <th style="width: 10%">UOM</th>
              <th style="width: 10%" class="text-right">Qty</th>
              <th style="width: 15%" class="text-right">Rate</th>
              <th style="width: 15%" class="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHTML}
          </tbody>
        </table>
      </div>
    `;
  });

  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <html>
      <head>
        <title>${title}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; padding: 25px; color: #1e293b; }
          .page-title { text-align: center; color: #1e3a8a; font-size: 20px; font-weight: bold; margin-bottom: 25px; text-transform: uppercase; border-bottom: 3px solid #1e3a8a; padding-bottom: 12px; }
          .record-header-title { font-size: 15px; font-weight: bold; color: #ffffff; background-color: #3b82f6; padding: 8px 12px; margin-bottom: 15px; border-radius: 4px; }
          .section-title { font-size: 13px; font-weight: bold; color: #0d9488; margin-top: 20px; margin-bottom: 8px; border-bottom: 2px solid #cbd5e1; padding-bottom: 4px; text-transform: uppercase; }
          .info-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
          .info-table td { padding: 8px 10px; border: 1px solid #cbd5e1; font-size: 12px; }
          .info-table td.label { background-color: #f1f5f9; font-weight: bold; width: 20%; color: #475569; }
          .info-table td.value { width: 30%; color: #0f172a; }
          .items-table { width: 100%; border-collapse: collapse; margin-top: 10px; margin-bottom: 30px; }
          .items-table th { background-color: #0d9488; color: white; padding: 8px 10px; border: 1px solid #cbd5e1; text-align: left; font-weight: bold; font-size: 12px; }
          .items-table td { padding: 7px 10px; border: 1px solid #cbd5e1; font-size: 12px; }
          .item-row { background-color: #f0fdfa; color: #0f766e; font-weight: bold; }
          .serial-row { background-color: #fef9c3; color: #854d0e; font-family: monospace; font-size: 11px; }
          .serial-label { color: #a16207; font-weight: bold; }
          .text-right { text-align: right; }
          .no-print-btn { background-color: #1e3a8a; color: white; padding: 10px 20px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; margin-bottom: 25px; font-size: 13px; display: inline-flex; align-items: center; gap: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
          .no-print-btn:hover { background-color: #1d4ed8; }
          @media print {
            .no-print-btn { display: none; }
            body { padding: 10px; }
          }
        </style>
      </head>
      <body>
        <button class="no-print-btn" onclick="window.print()">Print / Save as PDF</button>
        <div class="page-title">${title}</div>
        ${bodyHTML}
      </body>
    </html>
  `);
  printWindow.document.close();
  setTimeout(() => {
    printWindow.focus();
  }, 300);
};

export const exportVehicleStockToExcel = (data) => {
  if (!data || data.length === 0) return;

  // Group data by vehicle
  const grouped = {};
  data.forEach((r) => {
    const key = `${r.vehicle_code} (${r.vehicle_number || '-'})`;
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(r);
  });

  let html = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8">
      <style>
        .title { background-color: #1e3a8a; color: #ffffff; font-weight: bold; font-size: 16px; text-align: center; height: 40px; border: 1px solid #cbd5e1; }
        .vehicle-header { background-color: #2563eb; color: #ffffff; font-weight: bold; font-size: 13px; border: 1px solid #cbd5e1; height: 32px; }
        .item-th { background-color: #0d9488; color: #ffffff; font-weight: bold; border: 1px solid #cbd5e1; }
        .item-row { background-color: #f0fdfa; color: #0f766e; border: 1px solid #cbd5e1; font-weight: bold; }
        .serial-row { background-color: #fef9c3; color: #b45309; font-family: monospace; border: 1px solid #cbd5e1; }
        .section-divider { background-color: #ffffff; height: 15px; }
        td, th { padding: 8px; text-align: left; vertical-align: middle; }
        .text-right { text-align: right; }
      </style>
    </head>
    <body>
      <table>
        <tr>
          <th colspan="8" class="title">VEHICLE STOCK BALANCE EXPORT</th>
        </tr>
  `;

  Object.entries(grouped).forEach(([vehicleInfo, items], vIdx) => {
    html += `
      <tr class="section-divider"><td colspan="8"></td></tr>
      <tr>
        <th colspan="8" class="vehicle-header">VEHICLE: ${vehicleInfo}</th>
      </tr>
      <tr>
        <th class="item-th" style="width: 5%;">#</th>
        <th class="item-th" style="width: 15%;">Item Code</th>
        <th class="item-th" style="width: 25%;">Item Name</th>
        <th class="item-th" style="width: 10%;">UOM</th>
        <th class="item-th" style="width: 10%; text-align: right;">Quantity</th>
        <th class="item-th" style="width: 12%; text-align: right;">Valuation Rate</th>
        <th class="item-th" style="width: 13%; text-align: right;">Stock Value</th>
        <th class="item-th" style="width: 10%;">Last Updated</th>
      </tr>
    `;

    items.forEach((item, idx) => {
      const qty = Number(item.qty || 0);
      const rate = Number(item.valuation_rate || 0);
      const value = qty * rate;
      const lastUpdatedStr = formatDateTime(item.last_updated);

      html += `
        <tr class="item-row">
          <td>${idx + 1}</td>
          <td>${item.item_code || '-'}</td>
          <td>${item.item_name || '-'}</td>
          <td>${item.uom_name || '-'}</td>
          <td class="text-right">${formatNumber(qty)}</td>
          <td class="text-right">${formatCurrency(rate)}</td>
          <td class="text-right">${formatCurrency(value)}</td>
          <td>${lastUpdatedStr}</td>
        </tr>
      `;

      const serials = item.serial_numbers || [];
      if (serials.length > 0) {
        html += `
          <tr class="serial-row">
            <td></td>
            <td style="color: #b45309; font-weight: bold;">[Asset/Consumable Codes]</td>
            <td colspan="6" style="font-family: monospace;">${serials.join(', ')}</td>
          </tr>
        `;
      }
    });
  });

  html += `
      </table>
    </body>
    </html>
  `;

  const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', `Vehicle_Stock_Balance_${dayjs().format('YYYYMMDD_HHmmss')}.xls`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

export const printVehicleStockToPDF = (data) => {
  if (!data || data.length === 0) return;

  // Group data by vehicle
  const grouped = {};
  data.forEach((r) => {
    const key = `${r.vehicle_code} (${r.vehicle_number || '-'})`;
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(r);
  });

  let title = 'Vehicle Stock Balance Report';
  let bodyHTML = '';

  Object.entries(grouped).forEach(([vehicleInfo, items], recIdx) => {
    let itemsHTML = '';
    items.forEach((item, idx) => {
      const qty = Number(item.qty || 0);
      const rate = Number(item.valuation_rate || 0);
      const value = qty * rate;
      const lastUpdatedStr = formatDateTime(item.last_updated);

      itemsHTML += `
        <tr class="item-row">
          <td>${idx + 1}</td>
          <td>${item.item_code || '-'}</td>
          <td>${item.item_name || '-'}</td>
          <td>${item.uom_name || '-'}</td>
          <td class="text-right">${formatNumber(qty)}</td>
          <td class="text-right">${formatCurrency(rate)}</td>
          <td class="text-right">${formatCurrency(value)}</td>
          <td>${lastUpdatedStr}</td>
        </tr>
      `;

      const serials = item.serial_numbers || [];
      if (serials.length > 0) {
        itemsHTML += `
          <tr class="serial-row">
            <td></td>
            <td class="serial-label">[Asset/Consumable Codes]</td>
            <td colspan="6" style="font-family: monospace;">${serials.join(', ')}</td>
          </tr>
        `;
      }
    });

    bodyHTML += `
      <div class="record-section" style="${recIdx > 0 ? 'page-break-before: always;' : ''}">
        <div class="vehicle-header-title">VEHICLE: ${vehicleInfo}</div>
        <table class="items-table">
          <thead>
            <tr>
              <th style="width: 5%">#</th>
              <th style="width: 15%">Item Code</th>
              <th style="width: 25%">Item Name</th>
              <th style="width: 10%">UOM</th>
              <th style="width: 10%" class="text-right">Quantity</th>
              <th style="width: 12%" class="text-right">Valuation Rate</th>
              <th style="width: 13%" class="text-right">Stock Value</th>
              <th style="width: 10%">Last Updated</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHTML}
          </tbody>
        </table>
      </div>
    `;
  });

  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <html>
      <head>
        <title>${title}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; padding: 25px; color: #1e293b; }
          .page-title { text-align: center; color: #1e3a8a; font-size: 20px; font-weight: bold; margin-bottom: 25px; text-transform: uppercase; border-bottom: 3px solid #1e3a8a; padding-bottom: 12px; }
          .vehicle-header-title { font-size: 14px; font-weight: bold; color: #ffffff; background-color: #2563eb; padding: 8px 12px; margin-top: 20px; margin-bottom: 10px; border-radius: 4px; }
          .items-table { width: 100%; border-collapse: collapse; margin-top: 10px; margin-bottom: 30px; }
          .items-table th { background-color: #0d9488; color: white; padding: 8px 10px; border: 1px solid #cbd5e1; text-align: left; font-weight: bold; font-size: 12px; }
          .items-table td { padding: 7px 10px; border: 1px solid #cbd5e1; font-size: 12px; }
          .item-row { background-color: #f0fdfa; color: #0f766e; font-weight: bold; }
          .serial-row { background-color: #fef9c3; color: #854d0e; font-size: 11px; }
          .serial-label { color: #b45309; font-weight: bold; }
          .text-right { text-align: right; }
          .no-print-btn { background-color: #1e3a8a; color: white; padding: 10px 20px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; margin-bottom: 25px; font-size: 13px; display: inline-flex; align-items: center; gap: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
          .no-print-btn:hover { background-color: #1d4ed8; }
          @media print {
            .no-print-btn { display: none; }
            body { padding: 10px; }
          }
        </style>
      </head>
      <body>
        <button class="no-print-btn" onclick="window.print()">Print / Save as PDF</button>
        <div class="page-title">${title}</div>
        ${bodyHTML}
      </body>
    </html>
  `);
  printWindow.document.close();
  setTimeout(() => {
    printWindow.focus();
  }, 300);
};

export const exportIndentToExcel = (record) => {
  const title = 'INDENT DETAIL REPORT';
  const headers = [
    { label: 'Indent Number', value: record.indent_number },
    { label: 'Status', value: record.status },
    { label: 'Date & Timestamp', value: formatDateTime(record.indent_date || record.created_at) },
    { label: 'Required Date', value: formatDate(record.required_date) },
    { label: 'Employee Code', value: record.raised_by_emp_code || record.employee_code },
    { label: 'Employee Name', value: record.created_by_name || record.raised_by_name },
    { label: 'Position', value: record.position_name || record.raising_position },
    { label: 'Indent Type', value: record.indent_type },
    { label: 'Department', value: record.department || record.department_name },
    { label: 'Warehouse', value: record.warehouse_name },
    { label: 'Project', value: record.project_name },
    { label: 'Vehicle Code', value: record.vehicle_code },
    { label: 'Vehicle Number', value: record.vehicle_number },
    { label: 'Remarks', value: record.remarks },
  ];
  const items = record.items || [];

  let html = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8">
      <style>
        .title { background-color: #581c87; color: #ffffff; font-weight: bold; font-size: 16px; text-align: center; height: 40px; border: 1px solid #cbd5e1; }
        .header-label { background-color: #f8fafc; color: #475569; font-weight: bold; border: 1px solid #cbd5e1; }
        .header-value { background-color: #ffffff; color: #0f172a; border: 1px solid #cbd5e1; }
        .item-th { background-color: #6b21a8; color: #ffffff; font-weight: bold; border: 1px solid #cbd5e1; }
        .item-row { background-color: #faf5ff; color: #581c87; border: 1px solid #cbd5e1; font-weight: 500; }
        .section-divider { background-color: #f1f5f9; height: 20px; }
        td, th { padding: 8px; text-align: left; vertical-align: middle; }
        .text-right { text-align: right; }
      </style>
    </head>
    <body>
      <table>
        <tr>
          <th colspan="6" class="title">${title}</th>
        </tr>
  `;

  for (let i = 0; i < headers.length; i += 2) {
    const h1 = headers[i];
    const h2 = headers[i + 1];
    html += `
      <tr>
        <td class="header-label">${h1 ? h1.label : ''}</td>
        <td colspan="2" class="header-value">${h1 && h1.value !== null && h1.value !== undefined ? h1.value : '-'}</td>
        <td class="header-label">${h2 ? h2.label : ''}</td>
        <td colspan="2" class="header-value">${h2 && h2.value !== null && h2.value !== undefined ? h2.value : '-'}</td>
      </tr>
    `;
  }

  html += `
    <tr class="section-divider">
      <td colspan="6"></td>
    </tr>
    <tr>
      <th class="item-th" style="width: 5%;">#</th>
      <th class="item-th" style="width: 25%;">Item Code</th>
      <th class="item-th" style="width: 40%;">Item Name</th>
      <th class="item-th" style="width: 15%; text-align: right;">Requested Qty</th>
      <th class="item-th" style="width: 15%;">UOM</th>
      <th class="item-th" style="width: 20%;">Remarks</th>
    </tr>
  `;

  items.forEach((item, idx) => {
    const itemCode = item.item_code || (item.item && item.item.item_code) || '';
    const itemName = item.item_name || (item.item && (item.item.item_name || item.item.name)) || '';
    const qty = Number(item.requested_qty !== undefined ? item.requested_qty : item.qty || 0);
    const uom = item.uom || item.unit || (item.item && item.item.primary_uom_name) || '-';
    const remarks = item.remarks || '-';
    
    html += `
      <tr class="item-row">
        <td>${idx + 1}</td>
        <td>${itemCode}</td>
        <td>${itemName}</td>
        <td class="text-right">${formatNumber(qty)}</td>
        <td>${uom}</td>
        <td>${remarks}</td>
      </tr>
    `;
  });

  html += `
      </table>
    </body>
    </html>
  `;

  const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', `indent_detail_${record.indent_number || record.id}_${dayjs().format('YYYYMMDD_HHmmss')}.xls`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

export const printIndentToPDF = (record) => {
  const title = record.template_name ? 'Template Indent Report' : 'Indent Report';
  
  // Clean headers to align exactly with the list
  const headers = [
    { label: 'Indent Number', value: record.indent_number || '-' },
    { label: 'Status', value: String(record.status || '-').toUpperCase() },
    { label: 'Indent Date', value: formatDate(record.indent_date || record.created_at) },
    { label: 'Project', value: record.project_name || record.project || '-' },
    { label: 'Template Name', value: record.template_name || '-' },
    { label: 'Raised By', value: record.created_by_name || record.raised_by_name || record.raised_by || '-' },
    { label: 'Vehicle Code', value: record.vehicle_code || '-' },
    { label: 'Vehicle Number', value: record.vehicle_number || '-' },
  ];
  
  const items = record.items || [];
  const history = record.approval_history || [];

  let headerHTML = '<table class="info-table"><tbody>';
  for (let i = 0; i < headers.length; i += 2) {
    const h1 = headers[i];
    const h2 = headers[i + 1];
    
    const getStatusStyle = (h) => {
      if (!h || h.label !== 'Status') return '';
      const s = String(h.value).toLowerCase();
      let color = '#8c8c8c';
      if (s.includes('approved') || s.includes('fulfilled')) color = '#22c55e';
      if (s.includes('pending')) color = '#3b82f6';
      if (s.includes('reject') || s.includes('cancel')) color = '#ef4444';
      return `<span class="status-badge" style="background-color: ${color};">${h.value}</span>`;
    };

    const val1 = h1 ? (h1.label === 'Status' ? getStatusStyle(h1) : h1.value) : '';
    const val2 = h2 ? (h2.label === 'Status' ? getStatusStyle(h2) : h2.value) : '';

    headerHTML += `
      <tr>
        <td class="label">${h1 ? h1.label : ''}</td>
        <td class="value">${val1 !== null && val1 !== undefined ? val1 : '-'}</td>
        <td class="label">${h2 ? h2.label : ''}</td>
        <td class="value">${val2 !== null && val2 !== undefined ? val2 : '-'}</td>
      </tr>
    `;
  }
  headerHTML += '</tbody></table>';

  let remarksHTML = '';
  if (record.remarks) {
    remarksHTML = `
      <div style="margin-top: 15px; margin-bottom: 15px; padding: 12px; background-color: #faf5ff; border-left: 4px solid #6b21a8; border-radius: 4px; font-size: 13px;">
        <strong>Remarks:</strong> ${record.remarks}
      </div>
    `;
  }

  let itemsHTML = '';
  items.forEach((item, idx) => {
    const itemCode = item.item_code || (item.item && item.item.item_code) || '';
    const itemName = item.item_name || (item.item && (item.item.item_name || item.item.name)) || '';
    const qty = Number(item.requested_qty !== undefined ? item.requested_qty : item.qty || 0);
    const uom = item.uom || item.unit || (item.item && item.item.primary_uom_name) || '-';
    const remarks = item.remarks || '-';

    itemsHTML += `
      <tr class="item-row">
        <td>${idx + 1}</td>
        <td>${itemCode}</td>
        <td>${itemName}</td>
        <td class="text-right">${formatNumber(qty)}</td>
        <td>${uom}</td>
        <td>${remarks}</td>
      </tr>
    `;
  });

  let historyHTML = '';
  if (history.length > 0) {
    historyHTML += `
      <div class="section-title">Approval & Rejection History</div>
      <table class="history-table">
        <thead>
          <tr>
            <th style="width: 25%">Approver</th>
            <th style="width: 20%">Role / Position</th>
            <th style="width: 15%">Action</th>
            <th style="width: 20%">Date & Time</th>
            <th style="width: 20%">Remarks</th>
          </tr>
        </thead>
        <tbody>
    `;
    history.forEach((h) => {
      let actionColor = '#3b82f6';
      if (h.action === 'approved') actionColor = '#22c55e';
      if (h.action === 'rejected') actionColor = '#ef4444';
      if (h.action === 'submitted') actionColor = '#f59e0b';

      historyHTML += `
        <tr>
          <td><strong>${h.user_name || ''}</strong></td>
          <td>${h.position_name || '-'}</td>
          <td><span class="status-badge" style="background-color: ${actionColor};">${String(h.action).toUpperCase()}</span></td>
          <td>${formatDateTime(h.timestamp)}</td>
          <td>${h.remarks || '-'}</td>
        </tr>
      `;
    });
    historyHTML += '</tbody></table>';
  }

  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <html>
      <head>
        <title>${title} - ${record.indent_number || record.id}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; padding: 25px; color: #1e293b; }
          .page-title { text-align: center; color: #581c87; font-size: 22px; font-weight: bold; margin-bottom: 25px; text-transform: uppercase; border-bottom: 3px solid #581c87; padding-bottom: 12px; }
          .section-title { font-size: 14px; font-weight: bold; color: #6b21a8; margin-top: 30px; margin-bottom: 12px; border-bottom: 2px solid #cbd5e1; padding-bottom: 6px; text-transform: uppercase; }
          .info-table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
          .info-table td { padding: 10px 12px; border: 1px solid #cbd5e1; font-size: 13px; }
          .info-table td.label { background-color: #f8fafc; font-weight: bold; width: 20%; color: #475569; }
          .info-table td.value { width: 30%; color: #0f172a; }
          .items-table, .history-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
          .items-table th, .history-table th { background-color: #6b21a8; color: white; padding: 10px 12px; border: 1px solid #cbd5e1; text-align: left; font-weight: bold; font-size: 13px; }
          .items-table td, .history-table td { padding: 9px 12px; border: 1px solid #cbd5e1; font-size: 13px; }
          .item-row { background-color: #faf5ff; color: #581c87; font-weight: bold; }
          .status-badge { color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; display: inline-block; }
          .text-right { text-align: right; }
          .no-print-btn { background-color: #6b21a8; color: white; padding: 10px 20px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; margin-bottom: 20px; font-size: 13px; display: inline-flex; align-items: center; gap: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
          .no-print-btn:hover { background-color: #7e22ce; }
          @media print {
            .no-print-btn { display: none; }
            body { padding: 10px; }
          }
        </style>
      </head>
      <body>
        <button class="no-print-btn" onclick="window.print()">Print / Save as PDF</button>
        <div class="page-title">${title}</div>
        ${headerHTML}
        ${remarksHTML}
        <div class="section-title">REQUESTED ITEMS LIST</div>
        <table class="items-table">
          <thead>
            <tr>
              <th style="width: 5%">#</th>
              <th style="width: 20%">Item Code</th>
              <th style="width: 35%">Item Name</th>
              <th style="width: 15%" class="text-right">Requested Qty</th>
              <th style="width: 10%">UOM</th>
              <th style="width: 15%">Remarks</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHTML}
          </tbody>
        </table>
        ${historyHTML}
      </body>
    </html>
  `);
  printWindow.document.close();
  setTimeout(() => {
    printWindow.focus();
  }, 300);
};

export const printVehicleIssueToPDF = (record) => {
  const title = 'Vehicle Material Issue Report';
  
  const headers = [
    { label: 'Issue Number', value: record.issue_number || '-' },
    { label: 'Status', value: String(record.status || '-').toUpperCase() },
    { label: 'Issue Date', value: formatDate(record.issue_date || record.created_at) },
    { label: 'Source Warehouse', value: record.warehouse_name || '-' },
    { label: 'Vehicle Code', value: record.vehicle_code || '-' },
    { label: 'Vehicle Number', value: record.vehicle_number || '-' },
    { label: 'Issued To / Employee', value: record.raised_by_name || record.created_by_name || record.issued_to_name || '-' },
    { label: 'Department', value: record.department || '-' },
  ];
  
  const items = record.items || [];

  let headerHTML = '<table class="info-table"><tbody>';
  for (let i = 0; i < headers.length; i += 2) {
    const h1 = headers[i];
    const h2 = headers[i + 1];
    
    const getStatusStyle = (h) => {
      if (!h || h.label !== 'Status') return '';
      const s = String(h.value).toLowerCase();
      let color = '#8c8c8c';
      if (s.includes('acknowledged') || s.includes('approved')) color = '#22c55e';
      if (s.includes('issued') || s.includes('pending')) color = '#3b82f6';
      if (s.includes('reject') || s.includes('cancel')) color = '#ef4444';
      return `<span class="status-badge" style="background-color: ${color};">${h.value}</span>`;
    };

    const val1 = h1 ? (h1.label === 'Status' ? getStatusStyle(h1) : h1.value) : '';
    const val2 = h2 ? (h2.label === 'Status' ? getStatusStyle(h2) : h2.value) : '';

    headerHTML += `
      <tr>
        <td class="label">${h1 ? h1.label : ''}</td>
        <td class="value">${val1 !== null && val1 !== undefined ? val1 : '-'}</td>
        <td class="label">${h2 ? h2.label : ''}</td>
        <td class="value">${val2 !== null && val2 !== undefined ? val2 : '-'}</td>
      </tr>
    `;
  }
  headerHTML += '</tbody></table>';

  let remarksHTML = '';
  if (record.remarks) {
    remarksHTML = `
      <div style="margin-top: 15px; margin-bottom: 15px; padding: 12px; background-color: #f0fdf4; border-left: 4px solid #16a34a; border-radius: 4px; font-size: 13px;">
        <strong>Remarks:</strong> ${record.remarks}
      </div>
    `;
  }

  let itemsHTML = '';
  items.forEach((item, idx) => {
    const itemCode = item.item_code || (item.item && item.item.item_code) || '';
    const itemName = item.item_name || (item.item && (item.item.item_name || item.item.name)) || '';
    const qty = Number(item.qty || 0);
    const uom = item.uom_name || item.uom || item.unit || '-';
    const batch = item.batch_number || '-';
    
    let serialsDisplay = '-';
    if (item.serial_numbers && item.serial_numbers.length > 0) {
      const prefix = itemCode ? `${itemCode}-1-` : '';
      serialsDisplay = item.serial_numbers.map(s => s.startsWith(prefix) ? s : `${prefix}${s}`).join(', ');
    }

    itemsHTML += `
      <tr class="item-row">
        <td>${idx + 1}</td>
        <td>${itemCode}</td>
        <td>${itemName}</td>
        <td class="text-right">${formatNumber(qty)}</td>
        <td>${uom}</td>
        <td>${batch}</td>
        <td>${serialsDisplay}</td>
      </tr>
    `;
  });

  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <html>
      <head>
        <title>${title} - ${record.issue_number || record.id}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; padding: 25px; color: #1e293b; }
          .page-title { text-align: center; color: #0f172a; font-size: 22px; font-weight: bold; margin-bottom: 25px; text-transform: uppercase; border-bottom: 3px solid #3b82f6; padding-bottom: 12px; }
          .section-title { font-size: 14px; font-weight: bold; color: #1e3a8a; margin-top: 30px; margin-bottom: 12px; border-bottom: 2px solid #cbd5e1; padding-bottom: 6px; text-transform: uppercase; }
          .info-table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
          .info-table td { padding: 10px 12px; border: 1px solid #cbd5e1; font-size: 13px; }
          .info-table td.label { background-color: #f8fafc; font-weight: bold; width: 20%; color: #475569; }
          .info-table td.value { width: 30%; color: #0f172a; }
          .items-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
          .items-table th { background-color: #1e3a8a; color: white; padding: 10px 12px; border: 1px solid #cbd5e1; text-align: left; font-weight: bold; font-size: 13px; }
          .items-table td { padding: 9px 12px; border: 1px solid #cbd5e1; font-size: 13px; }
          .item-row { background-color: #f8fafc; color: #334155; }
          .status-badge { color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; display: inline-block; }
          .text-right { text-align: right; }
          .no-print-btn { background-color: #1e3a8a; color: white; padding: 10px 20px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; margin-bottom: 20px; font-size: 13px; display: inline-flex; align-items: center; gap: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
          .no-print-btn:hover { background-color: #1d4ed8; }
          @media print {
            .no-print-btn { display: none; }
            body { padding: 10px; }
          }
        </style>
      </head>
      <body>
        <button class="no-print-btn" onclick="window.print()">Print / Save as PDF</button>
        <div class="page-title">${title}</div>
        ${headerHTML}
        ${remarksHTML}
        <div class="section-title">ISSUED ITEMS LIST</div>
        <table class="items-table">
          <thead>
            <tr>
              <th style="width: 5%">#</th>
              <th style="width: 15%">Item Code</th>
              <th style="width: 30%">Item Name</th>
              <th style="width: 10%" class="text-right">Issued Qty</th>
              <th style="width: 10%">UOM</th>
              <th style="width: 10%">Batch</th>
              <th style="width: 20%">Serial / Asset Codes</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHTML}
          </tbody>
        </table>
      </body>
    </html>
  `);
  printWindow.document.close();
  setTimeout(() => {
    printWindow.focus();
  }, 300);
};


