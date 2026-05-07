'use strict';

const DRIVE_API    = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_SCOPE  = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME  = 'Receipts';
const CSV_NAME     = 'receipts_log.csv';
const CSV_HEADER   = 'upload_date,store_name,receipt_date,total_amount,photo_link\n';

let accessToken  = null;
let tokenExpiry  = 0;
let tokenClient  = null;
let pendingFile  = null;
let folderCache  = {};   // { 'Receipts': id, '2026-05': id }

// ---- Init ----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  loadFolderCache();
  setupEventListeners();

  const clientId = getClientId();
  if (!clientId) {
    document.getElementById('origin-display').textContent = location.origin;
    showScreen('setup');
  } else {
    initGIS(clientId);
    showScreen('auth');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
});

// ---- Client ID -----------------------------------------------------------

function getClientId() {
  return localStorage.getItem('gClientId') || '';
}

// ---- Folder cache (sessionStorage so folder IDs survive page refreshes
//      within the same session but reset on browser restart) ---------------

function loadFolderCache() {
  try { folderCache = JSON.parse(sessionStorage.getItem('fCache') || '{}'); }
  catch { folderCache = {}; }
}

function saveFolderCache() {
  sessionStorage.setItem('fCache', JSON.stringify(folderCache));
}

// ---- Screen / state management ------------------------------------------

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById('screen-' + name).classList.remove('hidden');
}

function showState(name) {
  document.querySelectorAll('.state').forEach(s => s.classList.add('hidden'));
  document.getElementById('state-' + name).classList.remove('hidden');
}

// ---- Event listeners -----------------------------------------------------

function setupEventListeners() {
  // Setup screen
  document.getElementById('save-client-id-btn').addEventListener('click', handleSaveClientId);
  document.getElementById('client-id-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSaveClientId();
  });

  // Auth screen
  document.getElementById('sign-in-btn').addEventListener('click', signIn);
  document.getElementById('change-client-id-btn').addEventListener('click', () => showScreen('setup'));

  // Main screen
  document.getElementById('sign-out-btn').addEventListener('click', signOut);
  document.getElementById('scan-btn').addEventListener('click', triggerCamera);
  document.getElementById('camera-input').addEventListener('change', handleFileSelected);
  document.getElementById('cancel-btn').addEventListener('click', resetToIdle);
  document.getElementById('upload-btn').addEventListener('click', handleUpload);
  document.getElementById('scan-another-btn').addEventListener('click', resetToIdle);
  document.getElementById('retry-btn').addEventListener('click', retryFromError);
  document.getElementById('cancel-from-error-btn').addEventListener('click', resetToIdle);
}

// ---- Setup ---------------------------------------------------------------

function handleSaveClientId() {
  const input = document.getElementById('client-id-input');
  const val   = input.value.trim();
  if (!val) { input.classList.add('error'); input.focus(); return; }
  input.classList.remove('error');
  localStorage.setItem('gClientId', val);
  initGIS(val);
  showScreen('auth');
}

// ---- Google Identity Services --------------------------------------------

function initGIS(clientId) {
  let attempts = 0;
  const poll = setInterval(() => {
    attempts++;
    if (typeof google !== 'undefined' && google.accounts?.oauth2) {
      clearInterval(poll);
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
        callback: '' // set per-call below
      });
    } else if (attempts > 150) {
      clearInterval(poll);
      showAuthError('Google API failed to load. Check your network and try again.');
    }
  }, 100);
}

function signIn() {
  if (!tokenClient) { showAuthError('Google API not ready. Please wait a moment.'); return; }
  tokenClient.callback = (resp) => {
    if (resp.error) { showAuthError('Sign-in failed: ' + resp.error); return; }
    storeToken(resp);
    onSignedIn();
  };
  tokenClient.requestAccessToken({ prompt: 'consent' });
}

async function ensureToken() {
  if (accessToken && Date.now() < tokenExpiry) return;
  return new Promise((resolve, reject) => {
    const prev = tokenClient.callback;
    tokenClient.callback = (resp) => {
      tokenClient.callback = prev;
      if (resp.error) { reject(new Error('Session expired — please sign in again.')); return; }
      storeToken(resp);
      resolve();
    };
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

function storeToken(resp) {
  accessToken = resp.access_token;
  tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
}

function signOut() {
  if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = null;
  tokenExpiry = 0;
  folderCache  = {};
  sessionStorage.clear();
  document.getElementById('user-email').textContent = '';
  document.getElementById('auth-error').classList.add('hidden');
  showScreen('auth');
}

function onSignedIn() {
  fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + accessToken }
  })
    .then(r => r.json())
    .then(info => { document.getElementById('user-email').textContent = info.email || ''; })
    .catch(() => {});

  showScreen('main');
  showState('idle');
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ---- Camera --------------------------------------------------------------

function triggerCamera() {
  document.getElementById('camera-input').click();
}

function handleFileSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = '';

  pendingFile = file;

  const url = URL.createObjectURL(file);
  const img  = document.getElementById('preview-img');
  img.onload = () => URL.revokeObjectURL(url);
  img.src    = url;

  // Reset form fields + states
  ['field-store', 'field-date', 'field-total'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('fields-form').classList.add('hidden');
  document.getElementById('upload-status').classList.add('hidden');
  document.getElementById('action-buttons').classList.remove('hidden');
  document.getElementById('upload-btn').disabled = true;
  document.getElementById('ocr-status').classList.remove('hidden');
  document.getElementById('ocr-status-text').textContent = 'Analyzing receipt...';

  showState('preview');
  runOCR(file);
}

// ---- OCR -----------------------------------------------------------------

async function runOCR(file) {
  const statusEl = document.getElementById('ocr-status');
  const textEl   = document.getElementById('ocr-status-text');

  try {
    if (typeof Tesseract === 'undefined') throw new Error('Tesseract not loaded');

    const result = await Tesseract.recognize(file, 'eng', {
      logger: m => {
        if (m.status === 'recognizing text') {
          textEl.textContent = `Analyzing... ${Math.round(m.progress * 100)}%`;
        }
      }
    });

    const parsed = parseReceiptText(result.data.text);
    document.getElementById('field-store').value = parsed.storeName;
    document.getElementById('field-date').value  = parsed.receiptDate;
    document.getElementById('field-total').value = parsed.total;
  } catch {
    textEl.textContent = 'OCR unavailable — enter details manually';
  } finally {
    statusEl.classList.add('hidden');
    document.getElementById('fields-form').classList.remove('hidden');
    document.getElementById('upload-btn').disabled = false;
  }
}

function parseReceiptText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const storeName = lines[0] || '';

  let receiptDate = '';
  const datePatterns = [
    /\b\d{4}[\/\-]\d{2}[\/\-]\d{2}\b/,
    /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/,
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i
  ];
  for (const p of datePatterns) {
    const m = text.match(p);
    if (m) { receiptDate = m[0]; break; }
  }

  let total = '';
  const totalPatterns = [
    /(?:grand\s+)?total[^0-9\n]{0,10}([\d,]+\.\d{2})/i,
    /amount\s+due[^0-9\n]{0,10}([\d,]+\.\d{2})/i,
    /balance\s+due[^0-9\n]{0,10}([\d,]+\.\d{2})/i,
    /total\s+amount[^0-9\n]{0,10}([\d,]+\.\d{2})/i
  ];
  for (const p of totalPatterns) {
    const m = text.match(p);
    if (m) { total = m[1]; break; }
  }

  return { storeName, receiptDate, total };
}

// ---- Upload flow ---------------------------------------------------------

async function handleUpload() {
  if (!pendingFile) return;

  const store       = document.getElementById('field-store').value.trim();
  const receiptDate = document.getElementById('field-date').value.trim();
  const total       = document.getElementById('field-total').value.trim();

  const statusEl  = document.getElementById('upload-status');
  const statusTxt = document.getElementById('upload-status-text');
  const actionRow = document.getElementById('action-buttons');
  const fieldsEl  = document.getElementById('fields-form');

  statusEl.classList.remove('hidden');
  actionRow.classList.add('hidden');
  fieldsEl.classList.add('hidden');

  const setStatus = msg => { statusTxt.textContent = msg; };

  try {
    setStatus('Connecting to Google Drive...');
    await ensureToken();

    // Resolve folder hierarchy
    setStatus('Setting up folders...');
    const now      = new Date();
    const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

    let receiptsId = folderCache['Receipts'];
    if (!receiptsId) {
      receiptsId = await findOrCreateFolder(FOLDER_NAME, 'root');
      folderCache['Receipts'] = receiptsId;
      saveFolderCache();
    }

    let monthId = folderCache[monthKey];
    if (!monthId) {
      monthId = await findOrCreateFolder(monthKey, receiptsId);
      folderCache[monthKey] = monthId;
      saveFolderCache();
    }

    // Upload image
    const filename = 'receipt_' + formatTimestamp(now) + '.jpg';
    setStatus('Uploading photo...');
    const uploaded = await uploadImage(pendingFile, monthId, filename);

    // Read existing CSV, append row, write back
    setStatus('Updating log...');
    const { id: csvId, content: existingCsv } = await readCsv(receiptsId);
    const uploadDate = now.toISOString().slice(0, 16).replace('T', ' ');
    let newCsv = existingCsv || CSV_HEADER;
    if (!newCsv.endsWith('\n')) newCsv += '\n';
    newCsv += buildCsvRow([uploadDate, store, receiptDate, total, uploaded.webViewLink]) + '\n';
    await updateCsv(csvId, newCsv, receiptsId);

    // Show success
    statusEl.classList.add('hidden');
    document.getElementById('success-filename').textContent = filename;
    document.getElementById('success-folder').textContent   = FOLDER_NAME + '/' + monthKey + '/';
    document.getElementById('success-link').href            = uploaded.webViewLink;
    showState('success');

  } catch (err) {
    statusEl.classList.add('hidden');
    document.getElementById('error-message').textContent = err.message || 'Upload failed. Please try again.';
    showState('error');
  }
}

function resetToIdle() {
  pendingFile = null;
  document.getElementById('camera-input').value = '';
  showState('idle');
}

function retryFromError() {
  document.getElementById('upload-status').classList.add('hidden');
  document.getElementById('action-buttons').classList.remove('hidden');
  document.getElementById('fields-form').classList.remove('hidden');
  document.getElementById('upload-btn').disabled = false;
  showState('preview');
}

// ---- Drive API helpers ---------------------------------------------------

async function driveRequest(url, options = {}) {
  await ensureToken();
  const headers = { Authorization: 'Bearer ' + accessToken, ...(options.headers || {}) };
  const res = await fetchWithRetry(url, { ...options, headers });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error?.message || msg; } catch {}
    throw new Error('Drive error ' + res.status + ': ' + msg);
  }
  return res.json();
}

async function fetchWithRetry(url, options, maxRetries = 3) {
  const delays = [2000, 4000, 8000];
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || res.status < 500) return res;
      lastErr = new Error('HTTP ' + res.status);
    } catch (e) {
      lastErr = e;
    }
    if (i < maxRetries) await new Promise(r => setTimeout(r, delays[i]));
  }
  throw lastErr;
}

async function findOrCreateFolder(name, parentId) {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const res = await driveRequest(`${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id)`, { method: 'GET' });
  if (res.files?.length) return res.files[0].id;

  const created = await driveRequest(DRIVE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  return created.id;
}

async function uploadImage(file, folderId, filename) {
  await ensureToken();
  const metadata = { name: filename, parents: [folderId] };
  const { body, boundary } = await buildMultipart(metadata, file.type || 'image/jpeg', file);
  const res = await fetchWithRetry(
    `${DRIVE_UPLOAD}?uploadType=multipart&fields=id,webViewLink`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'multipart/related; boundary=' + boundary
      },
      body
    }
  );
  if (!res.ok) throw new Error('Image upload failed (' + res.status + ')');
  return res.json();
}

async function readCsv(folderId) {
  const q = `name='${CSV_NAME}' and '${folderId}' in parents and trashed=false`;
  const res = await driveRequest(`${DRIVE_API}?q=${encodeURIComponent(q)}&fields=files(id)`, { method: 'GET' });
  if (!res.files?.length) return { id: null, content: '' };

  const fileId = res.files[0].id;
  await ensureToken();
  const dl = await fetchWithRetry(`${DRIVE_API}/${fileId}?alt=media`, {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  return { id: fileId, content: await dl.text() };
}

async function updateCsv(fileId, content, folderId) {
  await ensureToken();
  const blob = new Blob([content], { type: 'text/csv' });

  if (fileId) {
    const res = await fetchWithRetry(`${DRIVE_UPLOAD}/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'text/csv' },
      body: blob
    });
    if (!res.ok) throw new Error('CSV update failed (' + res.status + ')');
    return res.json();
  }

  const metadata = { name: CSV_NAME, parents: [folderId], mimeType: 'text/csv' };
  const { body, boundary } = await buildMultipart(metadata, 'text/csv', content);
  const res = await fetchWithRetry(`${DRIVE_UPLOAD}?uploadType=multipart`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'multipart/related; boundary=' + boundary
    },
    body
  });
  if (!res.ok) throw new Error('CSV create failed (' + res.status + ')');
  return res.json();
}

// ---- Multipart body builder (multipart/related) -------------------------

async function buildMultipart(metadata, contentType, content) {
  const boundary = 'rscanner_' + Math.random().toString(36).slice(2);
  const enc = new TextEncoder();

  const header = enc.encode(
    '--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    '\r\n--' + boundary + '\r\n' +
    'Content-Type: ' + contentType + '\r\n\r\n'
  );
  const footer = enc.encode('\r\n--' + boundary + '--');

  let fileBytes;
  if (typeof content === 'string') {
    fileBytes = enc.encode(content);
  } else {
    fileBytes = new Uint8Array(await content.arrayBuffer());
  }

  const body = new Uint8Array(header.length + fileBytes.length + footer.length);
  body.set(header, 0);
  body.set(fileBytes, header.length);
  body.set(footer, header.length + fileBytes.length);

  return { body: body.buffer, boundary };
}

// ---- CSV helpers ---------------------------------------------------------

function escapeCsv(val) {
  const s = String(val ?? '').replace(/[\r\n]+/g, ' ');
  return (s.includes(',') || s.includes('"')) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildCsvRow(fields) {
  return fields.map(escapeCsv).join(',');
}

// ---- Utilities -----------------------------------------------------------

function formatTimestamp(d) {
  return (
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0') + '_' +
    String(d.getHours()).padStart(2, '0') + '-' +
    String(d.getMinutes()).padStart(2, '0')
  );
}
