// ── Config — edit these three ───────────────────────────────────────────────
const PROJECT_URL    = 'https://claude.ai/project/YOUR_PROJECT_ID'; // your Claude project
const DOWNLOAD_DIR   = '/Users/YOU/Desktop/Resumes';               // where resumes are saved
const RESUME_PREFIX  = 'firstname_lastname';                       // resumes saved as <prefix>_<company>.pdf
const PROFILE_NAME   = 'First Last';                               // your full name (used in email subject)
const PROFILE_INTRO  = 'I am [First], [one-line intro about yourself].'; // email opening line
// ─────────────────────────────────────────────────────────────────────────────

const pending = {};
let resumeTabId = null;
let currentCompany = 'company';
let downloadHandled = false;
const composingFor = new Set(); // dedup in-flight email composes
const cdpTargets = new Map(); // tabId → debugger target

function slog(...args) {
  const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log('[swifthire]', line);
  fetch('http://127.0.0.1:9875/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ line }),
  }).catch(() => {});
}

function detachCdp(tabId) {
  const t = tabId ? { tabId } : null;
  if (tabId) {
    cdpTargets.delete(tabId);
  } else {
    for (const [id, target] of cdpTargets) {
      try { chrome.debugger.detach(target); } catch {}
    }
    cdpTargets.clear();
    return;
  }
  if (t) try { chrome.debugger.detach(t); } catch {}
}

// ── CDP download event listener ──────────────────────────────────────────────
// If Browser.setDownloadBehavior routes the file straight to disk, the
// chrome.downloads.onCreated path may never fire. Catch it here instead.
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!cdpTargets.has(source.tabId)) return;
  if (method === 'Browser.downloadWillBegin') {
    slog('CDP download will begin:', params.suggestedFilename);
    cdpSuggestedFilename = params.suggestedFilename || '';
  }
  if (method === 'Browser.downloadProgress' && params.state === 'completed') {
    if (downloadHandled) return;
    downloadHandled = true;
    slog('CDP download completed via Browser.downloadProgress');
    const safeCompany = currentCompany.trim().toLowerCase().replace(/\s+/g, '_');
    const filename = cdpSuggestedFilename || `${RESUME_PREFIX}_${safeCompany}.pdf`;
    detachCdp(source.tabId);
    notify(filename, safeCompany);
  }
});
let cdpSuggestedFilename = '';

// ── Download handling ────────────────────────────────────────────────────────
// We do NOT cancel the download (that breaks manual downloads — Claude revokes
// the blob URL immediately). Instead we let it complete natively, then ask the
// local server to move it into Desktop/Resumes with Claude's filename.
const trackedDownloads = new Map(); // downloadId → filename

chrome.downloads.onCreated.addListener((item) => {
  if (item.byExtensionId === chrome.runtime.id) return;

  const isPdf = item.mime === 'application/pdf'
    || /\.pdf($|\?)/i.test(item.filename || '')
    || /\.pdf($|\?)/i.test(item.url || '');
  if (!isPdf) return;

  const isClaude = item.url?.startsWith('blob:https://claude.ai')
    || /claude\.ai/.test(item.referrer || '');
  if (!isClaude) return;

  const suggestedName = item.filename?.split('/')?.pop() || '';
  const safeCompany   = (currentCompany || 'resume').trim().toLowerCase().replace(/\s+/g, '_');
  const filename      = suggestedName || `${RESUME_PREFIX}_${safeCompany}.pdf`;
  trackedDownloads.set(item.id, filename);
  slog('tracking claude PDF download', item.id, filename);
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || delta.state.current !== 'complete') return;
  if (!trackedDownloads.has(delta.id)) return;

  const filename = trackedDownloads.get(delta.id);
  trackedDownloads.delete(delta.id);

  chrome.downloads.search({ id: delta.id }, ([dl]) => {
    const src = dl?.filename || '';
    const rawName = src.split('/').pop() || filename || 'resume.pdf';
    // Normalize to <prefix>_<company>.pdf — the company is the first
    // meaningful token in Claude's suggested filename.
    const company = companyFromResumeName(rawName);
    const cleanName = `${RESUME_PREFIX}_${company}.pdf`;
    const dst = DOWNLOAD_DIR + '/' + cleanName;
    slog('download complete, moving', src, '->', dst);
    if (src && src !== dst) {
      fetch('http://127.0.0.1:9875/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ src, dst }),
      }).catch(e => slog('ERROR move failed:', e.message));
    }
    notify(cleanName, company);
  });
});


// Safe notification — never throws if the icon can't render (which was killing
// the service worker mid-compose). Uses no iconUrl; falls back gracefully.
function notifyUser(title, message) {
  try {
    chrome.notifications.create('', { type: 'basic', iconUrl: ICON_DATA_URL, title, message }, () => {
      if (chrome.runtime.lastError) {
        // Retry without a custom icon path issue — log and move on.
        slog('notification icon failed (ignored):', chrome.runtime.lastError.message);
      }
    });
  } catch (e) { slog('notification failed (ignored):', e.message); }
}

const ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR42mNkYPhfz0AEYBxVSF+Fo4qhSjEANZYH/W2Q0vQAAAAASUVORK5CYII=';

// Extract the company token from Claude's suggested resume filename.
// "FirstLast_Adobe_BusinessProcessAnalyst.pdf" -> "adobe"
// "FirstLast_Resume_Cursor_PM.pdf" -> "cursor"
function companyFromResumeName(name) {
  const ROLE_WORDS = new Set(['pm','spm','apm','bizops','strategyops','ops','analyst','manager',
    'product','business','process','senior','associate','methodology','resume','cv','final','v1','v2',
    'data','ai','growth','operations','strategy','program','project']);
  const tokens = name
    .replace(/\.pdf$/i, '')
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .filter(t => !/^resume$/i.test(t));
  // First token that isn't a generic role word is the company.
  const company = tokens.find(t => !ROLE_WORDS.has(t.toLowerCase())) || tokens[0] || 'company';
  return company.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function notify(filename, companyKey) {
  const fullPath = DOWNLOAD_DIR + '/' + filename;
  const key = companyKey || filename.replace(/\.pdf$/i, '').replace(new RegExp('^' + RESUME_PREFIX + '_'), '');
  // Link this resume to the JD from the Send-to-Claude session that produced it.
  // The resume filename is the reliable company anchor; the last-sent JD belongs to it.
  chrome.storage.local.get({ resumeMap: {}, jdByResume: {}, jobText: '', jobUrl: '' },
    ({ resumeMap, jdByResume, jobText, jobUrl }) => {
      resumeMap[key] = fullPath;
      if (jobText) jdByResume[filename] = { text: jobText, url: jobUrl };
      chrome.storage.local.set({ latestResume: fullPath, resumeMap, jdByResume });
    });
  notifyUser('Resume ready', filename);
}

// ── Messaging ────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'SEND_TO_CLAUDE') {
    chrome.tabs.create({ url: PROJECT_URL }, (tab) => {
      resumeTabId = tab.id;
      pending[tab.id] = msg.prompt;
      startResumePoller(tab.id, msg.company || 'unknown');
    });
  }

  if (msg.type === 'OPEN_CLAUDE_FOR_ANSWERS') {
    if (resumeTabId) {
      chrome.scripting.executeScript({
        target: { tabId: resumeTabId },
        func: injectPrompt,
        args: [msg.prompt],
      });
      sendResponse({ tabId: resumeTabId });
    } else {
      chrome.tabs.create({ url: PROJECT_URL }, (tab) => {
        pending[tab.id] = msg.prompt;
        sendResponse({ tabId: tab.id });
      });
    }
    return true;
  }

  if (msg.type === 'GET_RESUME_TAB') {
    sendResponse({ tabId: resumeTabId });
    return true;
  }


  if (msg.type === 'COMPOSE_MAIL') {
    fetch('http://127.0.0.1:9875', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.data),
    }).catch(e => console.error('compose fetch failed:', e.message));
  }

  if (msg.type === 'RUN_EMAIL_COMPOSE') {
    const pd = msg.profileData || {};
    const dedupeKey = `${pd.firstName || ''}|${pd.lastName || ''}|${pd.companyLinkedInUrl || ''}`;
    if (composingFor.has(dedupeKey)) {
      slog('SKIP duplicate compose for', dedupeKey);
      sendResponse({ ok: true });
      return true;
    }
    composingFor.add(dedupeKey);
    runEmailCompose(msg)
      .catch(e => slog('ERROR email compose:', e.message))
      .finally(() => composingFor.delete(dedupeKey));
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'GET_COMPANY_WEBSITE') {
    const aboutUrl = msg.url.replace(/(\/company\/[^/?#]+).*$/, '$1') + '/about/';
    chrome.tabs.create({ url: aboutUrl, active: false }, (tab) => {
      const companyTabId = tab.id;

      chrome.tabs.onUpdated.addListener(function listener(tabId, changeInfo) {
        if (tabId !== companyTabId || changeInfo.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(listener);

        chrome.scripting.executeScript({
          target: { tabId: companyTabId },
          func: extractCompanyWebsite,
        }, (results) => {
          const result = results?.[0]?.result;
          chrome.tabs.remove(companyTabId);
          sendResponse({ website: result?.domain || null });
        });
      });
    });
    return true;
  }
});

// ── Resume poller: wait for Claude to finish, then click the download button ──
// Strategy: try to detect streaming via DOM; after MIN_WAIT_MS regardless,
// start attempting the click every 5 s until success or timeout.
function startResumePoller(tabId, company) {
  currentCompany = company;
  downloadHandled = false;
  cdpSuggestedFilename = '';
  let attempts = 0;
  let seenStreaming = false;
  let clickingStarted = false;
  const MIN_WAIT_MS = 45000; // always wait at least 45 s before clicking
  const MAX = 96;            // 8 minutes at 5 s intervals
  const startedAt = Date.now();
  slog('poller started for', company, 'tab', tabId);

  const timer = setInterval(async () => {
    attempts++;
    if (attempts > MAX || downloadHandled) { clearInterval(timer); return; }

    // Detect streaming state to know Claude has started responding.
    if (!seenStreaming) {
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            // Look for any button that stops generation — aria-label, data attr, or class.
            const stop =
              document.querySelector('button[aria-label*="Stop"]') ||
              document.querySelector('button[aria-label*="stop"]') ||
              document.querySelector('[data-is-streaming="true"]') ||
              document.querySelector('.text-streaming') ||
              // claude.ai renders a square "stop" icon button during streaming
              document.querySelector('[data-testid="stop-button"]');
            if (stop) return 'streaming';
            // Also treat a disabled send button as streaming
            const send = document.querySelector('button[aria-label="Send message"]');
            if (send && send.disabled) return 'streaming';
            if (send && !send.disabled) return 'idle';
            return 'unknown';
          },
        });
        const state = res?.result || 'unknown';
        slog('tick', attempts, state, 'elapsed', Math.round((Date.now() - startedAt) / 1000) + 's');
        if (state === 'streaming') seenStreaming = true;
        // If we haven't seen streaming yet AND haven't waited long enough, keep waiting.
        if (!seenStreaming && Date.now() - startedAt < MIN_WAIT_MS) return;
        // If we've seen streaming and Claude is still going, keep waiting.
        if (seenStreaming && state === 'streaming') return;
      } catch (e) {
        slog('WARN state check failed:', e.message);
        if (Date.now() - startedAt < MIN_WAIT_MS) return;
      }
    }

    if (!clickingStarted) {
      slog('starting download click attempts, seenStreaming=' + seenStreaming);
      clickingStarted = true;
      await ensureDownloadBehavior(tabId);
    }

    const scriptOk = await tryClickDownloadScript(tabId);
    if (scriptOk) {
      clearInterval(timer);
      slog('download button clicked via script');
      setTimeout(() => detachCdp(tabId), 60000);
      return;
    }

    const cdpOk = await clickDownloadViaCDP(tabId);
    if (cdpOk) { clearInterval(timer); return; }

    slog('download button not found yet, will retry');
  }, 5000);
}

// Inject into all frames and click any download button found.
async function tryClickDownloadScript(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        function findBtn(root) {
          for (const el of root.querySelectorAll('button, a')) {
            const al = (el.getAttribute('aria-label') || '').toLowerCase();
            const ti = (el.getAttribute('title') || '').toLowerCase();
            const dt = (el.getAttribute('data-testid') || '').toLowerCase();
            const txt = (el.textContent || '').trim().toLowerCase();
            if (
              al.includes('download') || ti.includes('download') ||
              dt.includes('download') || txt === 'download' ||
              (el.tagName === 'A' && el.hasAttribute('download'))
            ) return el;
          }
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) {
              const f = findBtn(el.shadowRoot);
              if (f) return f;
            }
          }
          return null;
        }
        const btn = findBtn(document);
        if (btn) { btn.click(); return true; }
        return false;
      },
    });
    const found = results?.some(r => r.result === true);
    if (found) slog('download button clicked via script injection');
    return found;
  } catch (e) {
    slog('WARN script injection click failed:', e.message);
    return false;
  }
}

// ── CDP: suppress the save dialog, then click the download button ─────────────
// Stays attached (cdpTarget) until the download completes so the dialog-free
// download behavior remains in effect; detached by the onChanged handler.
async function ensureDownloadBehavior(tabId) {
  const target = { tabId };
  if (!cdpTargets.has(tabId)) {
    try {
      await chrome.debugger.attach(target, '1.3');
    } catch (e) {
      if (!/already attached/i.test(e.message || '')) {
        slog('WARN debugger attach failed for tab', tabId, e.message);
        return;
      }
    }
    cdpTargets.set(tabId, target);
  }
  await setDownloadBehavior(tabId);
}

async function setDownloadBehavior(tabId) {
  const target = cdpTargets.get(tabId);
  if (!target) return;
  try {
    await chrome.debugger.sendCommand(target, 'Browser.setDownloadBehavior', {
      behavior: 'allow', downloadPath: DOWNLOAD_DIR, eventsEnabled: true,
    });
    slog('Browser.setDownloadBehavior set for tab', tabId);
    return;
  } catch (e) {
    slog('WARN Browser.setDownloadBehavior failed:', e.message);
  }
  try {
    await chrome.debugger.sendCommand(target, 'Page.setDownloadBehavior', {
      behavior: 'allow', downloadPath: DOWNLOAD_DIR,
    });
    slog('Page.setDownloadBehavior set for tab', tabId);
  } catch (e) {
    slog('WARN Page.setDownloadBehavior failed:', e.message);
  }
}

async function clickDownloadViaCDP(tabId) {
  await ensureDownloadBehavior(tabId);
  const target = cdpTargets.get(tabId);
  if (!target) return false;

  try {
    await chrome.debugger.sendCommand(target, 'DOM.enable');
    const { root } = await chrome.debugger.sendCommand(
      target, 'DOM.getDocument', { depth: -1, pierce: true }
    );

    const node = cdpFindDownload(root);
    if (!node) { slog('no download button found yet'); return false; }

    const { object } = await chrome.debugger.sendCommand(
      target, 'DOM.resolveNode', { backendNodeId: node.backendNodeId }
    );
    if (!object?.objectId) return false;

    await chrome.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function(){ this.click(); }',
    });
    slog('download button clicked via CDP');
    setTimeout(() => detachCdp(tabId), 60000);
    return true;
  } catch (e) {
    slog('ERROR CDP click failed:', e.message);
    return false;
  }
}

function cdpAttr(node, name) {
  const a = node.attributes || [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return null;
}

function cdpText(node) {
  let t = node.nodeName === '#text' ? (node.nodeValue || '') : '';
  for (const c of node.children || []) t += cdpText(c);
  return t;
}

function cdpIsDownload(node) {
  if (node.nodeName !== 'BUTTON' && node.nodeName !== 'A') return false;
  const al = (cdpAttr(node, 'aria-label') || '').toLowerCase();
  const ti = (cdpAttr(node, 'title') || '').toLowerCase();
  if (al.includes('download') || ti.includes('download')) return true;
  if (node.nodeName === 'A' && cdpAttr(node, 'download') !== null) return true;
  if (cdpText(node).toLowerCase().includes('download')) return true;
  return false;
}

function cdpFindDownload(node) {
  if (cdpIsDownload(node)) return node;
  for (const c of node.children || []) {
    const r = cdpFindDownload(c); if (r) return r;
  }
  for (const s of node.shadowRoots || []) {
    const r = cdpFindDownload(s); if (r) return r;
  }
  if (node.contentDocument) {
    const r = cdpFindDownload(node.contentDocument); if (r) return r;
  }
  return null;
}

// ── Background email compose (runs after popup closes) ───────────────────────
// ── Company → job/resume matching helpers ────────────────────────────────────
function normSlug(s) { return (s || '').toLowerCase().replace(/[-_\s.]/g, ''); }
function normTok(s)  { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

const GARBAGE_KEYS = new Set([
  'app','apply','ats','boards','career','careers','careers-home','company',
  'details','en','frontcareers','global','job','jobs','openings','positions',
  'postings','recruiting','us','www',
]);

// One-time cleanup: remove garbage keys written by the old extractCompanyFromUrl bug.
chrome.storage.local.get(['jobTextMap','jobUrlMap'], ({ jobTextMap = {}, jobUrlMap = {} }) => {
  const isGarbage = k => GARBAGE_KEYS.has(k) || /^\d+$/.test(k) || k.length <= 1;
  const badKeys = Object.keys(jobTextMap).filter(isGarbage);
  if (!badKeys.length) return;
  for (const k of badKeys) { delete jobTextMap[k]; delete jobUrlMap[k]; }
  chrome.storage.local.set({ jobTextMap, jobUrlMap });
  slog('cleaned up garbage job keys:', badKeys.join(', '));
});

function matchJob(targets, keys) {
  const norms = targets.map(normSlug).filter(Boolean);
  if (!norms.length) return { key: null, confident: false };
  for (const t of norms) {
    const exact = keys.find(k => normSlug(k) === t);
    if (exact) return { key: exact, confident: true };
  }
  const matches = keys.filter(k => {
    const n = normSlug(k);
    return n.length > 3 && norms.some(t => t.length > 3 && (t.includes(n) || n.includes(t)));
  });
  if (matches.length === 1) return { key: matches[0], confident: true };
  if (matches.length > 1)  return { key: matches[0], confident: false };
  return { key: null, confident: false };
}

function matchResume(resumeFiles, targets) {
  const toks = targets.map(normTok).filter(t => t.length > 3);
  function score(f) {
    const n = normTok(f.name).replace(/resume|cv|pdf/g, '');
    if (n.length < 4) return 0;
    return Math.max(0, ...toks.map(t => n.includes(t) ? t.length : (t.includes(n) ? n.length : 0)));
  }
  const hits = resumeFiles.filter(f => score(f) > 0);
  if (hits.length === 0) return null;
  hits.sort((a, b) => score(b) - score(a));
  // Only return confident if top score is unambiguous (best > second-best)
  if (hits.length === 1 || score(hits[0]) > score(hits[1])) return hits[0];
  return null;
}

async function matchWithClaude(claudeKey, company, jobKeys, resumeNames) {
  if (!claudeKey || !company) return null;
  const prompt = `A person works at the company "${company}". I have saved job applications and resume files, each named after the company I applied to.

Job keys: ${JSON.stringify(jobKeys)}
Resume files: ${JSON.stringify(resumeNames)}

Pick the ONE job key and the ONE resume file that correspond to "${company}". Match on company identity (e.g. "jerry.ai" = "jerry", "Diligent Corporation" = "diligent"). If nothing clearly corresponds, use null.

Return ONLY JSON: {"jobKey": "<key or null>", "resumeFile": "<filename or null>"}`;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    const m = (data?.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]);
    return {
      jobKey:     p.jobKey && p.jobKey !== 'null' ? p.jobKey : null,
      resumeFile: p.resumeFile && p.resumeFile !== 'null' ? p.resumeFile : null,
    };
  } catch { return null; }
}

async function runEmailCompose({ profileData, apolloKey, companyLinkedInUrl, companyKey, resumePath, jobTextOverride }) {
  companyLinkedInUrl = companyLinkedInUrl || profileData.companyLinkedInUrl;
  slog('email compose started for', profileData.firstName, profileData.lastName, '— job key:', companyKey || '(auto)');

  // 1. Get company domain — reuse the one the popup already resolved.
  let domain = profileData.domain || '';
  if (!domain) {
    const companyRes = await new Promise(resolve => {
      const aboutUrl = companyLinkedInUrl.replace(/(\/company\/[^/?#]+).*$/, '$1') + '/about/';
      chrome.tabs.create({ url: aboutUrl, active: false }, (tab) => {
        chrome.tabs.onUpdated.addListener(function listener(tabId, changeInfo) {
          if (tabId !== tab.id || changeInfo.status !== 'complete') return;
          chrome.tabs.onUpdated.removeListener(listener);
          chrome.scripting.executeScript(
            { target: { tabId: tab.id }, func: extractCompanyWebsite },
            (results) => {
              chrome.tabs.remove(tab.id);
              resolve(results?.[0]?.result || {});
            }
          );
        });
      });
    });
    domain = companyRes?.domain || '';
  }
  if (!domain) {
    notifyUser('SwiftHire', `No company website found for ${profileData.companyName || ''}`);
    return;
  }

  // 2. Hunter email lookup.
  const finderParams = new URLSearchParams({
    first_name: profileData.firstName,
    last_name:  profileData.lastName,
    domain,
    api_key:    apolloKey,
  });
  const finderRes  = await fetch(`https://api.hunter.io/v2/email-finder?${finderParams}`);
  const finderData = await finderRes.json();
  const email = finderData?.data?.email || '';
  const name  = [profileData.firstName, profileData.lastName].filter(Boolean).join(' ');
  slog('hunter result', email || 'no email');

  // 3. Resolve JD + resume for this company.
  const { claudeKey, jobText, jobUrl, latestResume, resumeMap = {}, jobTextMap = {}, jobUrlMap = {}, jdByResume = {} } =
    await chrome.storage.local.get(['claudeKey', 'jobText', 'jobUrl', 'latestResume', 'resumeMap', 'jobTextMap', 'jobUrlMap', 'jdByResume']);

  const domainToken = (domain.split('.')[0] || '');
  let linkedinSlug = '';
  try { linkedinSlug = new URL(companyLinkedInUrl).pathname.split('/').filter(Boolean)[1] || ''; } catch {}

  let linkedJd = null; // JD linked to the matched resume (the reliable path)

  // Auto-match job + resume when the popup didn't provide an explicit pick.
  if (!companyKey && !jobTextOverride) {
    const keys = Object.keys(jobTextMap)
      .filter(k => !GARBAGE_KEYS.has(k) && !/^\d+$/.test(k) && k.length > 1 && (jobTextMap[k] || '').length > 50)
      .sort();
    let resumeFiles = [];
    try { resumeFiles = await (await fetch('http://127.0.0.1:9875/resumes')).json(); } catch {}

    // The resume is the reliable anchor: Claude names it by company.
    let mResume = matchResume(resumeFiles, [domainToken, linkedinSlug, profileData.companyName]);
    let mJobKey = null;

    // Best path: the JD captured at the time this resume was generated.
    if (mResume && jdByResume[mResume.name]?.text) {
      linkedJd = jdByResume[mResume.name];
      slog('using JD linked to resume:', mResume.name);
    }

    // Otherwise try to find a stored job key for the company.
    if (mResume && !linkedJd) {
      const rt = normTok(mResume.name).replace(/resume|cv|pdf/g, '');
      const m2 = matchJob([rt, domainToken, linkedinSlug, profileData.companyName], keys);
      if (m2.confident) mJobKey = m2.key;
      if (!mJobKey) {
        const toks = [domainToken, profileData.companyName, rt].map(normTok).filter(t => t.length > 3);
        const hits = keys.filter(k => { const jd = normTok(jobTextMap[k] || '').slice(0, 400); return toks.some(t => jd.includes(t)); });
        if (hits.length === 1) { mJobKey = hits[0]; slog('matched JD by content scan:', mJobKey); }
      }
    }

    if (!mResume) {
      const ai = await matchWithClaude(claudeKey, domain || profileData.companyName || linkedinSlug, keys, resumeFiles.map(f => f.name));
      if (ai?.resumeFile) { const f = resumeFiles.find(x => x.name === ai.resumeFile); if (f) mResume = f; }
      if (mResume && jdByResume[mResume.name]?.text) linkedJd = jdByResume[mResume.name];
      else if (ai?.jobKey && keys.includes(ai.jobKey)) mJobKey = ai.jobKey;
    }

    if (mResume && (linkedJd || mJobKey)) {
      companyKey = mJobKey;
      resumePath = mResume.path;
      slog('auto-matched resume:', mResume.name, '| job:', mJobKey || '(linked JD)');
    } else {
      slog('auto-match failed — jobKey:', mJobKey || 'none', '| resume:', mResume?.name || 'none',
           '| stored job keys:', keys.join(', ') || '(none)',
           '| resume files:', resumeFiles.map(f => f.name).join(', ') || '(none)');
      profileData.domain = domain;
      const item = {
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        profileData, apolloKey, domain, keys, resumeFiles,
        jobKey: mJobKey || null, resumeName: mResume?.name || null,
      };
      const { pendingComposes = [] } = await chrome.storage.local.get('pendingComposes');
      const dupe = pendingComposes.some(p =>
        p.profileData?.firstName === profileData.firstName &&
        p.profileData?.lastName === profileData.lastName && p.domain === domain);
      if (!dupe) pendingComposes.push(item);
      await chrome.storage.local.set({ pendingComposes });
      slog('auto-match failed — queued pending; total', pendingComposes.length);
      notifyUser('SwiftHire — needs a pick', `${pendingComposes.length} email(s) need a job/resume pick. Open SwiftHire.`);
      return;
    }
  }


  // Picker path: if a resume was chosen but no job key, use the resume's linked JD.
  if (!linkedJd && !jobTextOverride && !companyKey && resumePath) {
    const rn = resumePath.split('/').pop();
    if (jdByResume[rn]?.text) { linkedJd = jdByResume[rn]; slog('picker: using JD linked to', rn); }
  }

  // JD priority: pasted > the JD linked to this resume > the company's stored JD.
  // Never fall back to the last-used JD — that produces mismatched emails.
  const resolvedJobText  = jobTextOverride || linkedJd?.text || jobTextMap[companyKey] || '';
  const resolvedJobUrl   = jobTextOverride ? '' : (linkedJd?.url || jobUrlMap[companyKey] || '');
  const attachmentPath = resumePath || '';
  slog('resume:', attachmentPath, '| JD source:', jobTextOverride ? 'pasted' : linkedJd ? 'linked' : 'key:' + companyKey);

  if (!resolvedJobText) {
    notifyUser('SwiftHire', 'No job description found. Click Send to Claude on a job page first.');
    return;
  }

  if (!claudeKey) {
    notifyUser('SwiftHire', 'Add Claude API key in extension settings.');
    return;
  }

  // 4. Read the actual resume PDF text so bullets are drawn from the real,
  // tailored resume rather than a hardcoded blurb.
  let resumeText = '';
  if (attachmentPath) {
    try {
      const r = await fetch('http://127.0.0.1:9875/pdftext', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: attachmentPath }),
      });
      resumeText = (await r.json())?.text || '';
      slog('resume text length:', resumeText.length);
    } catch (e) { slog('WARN pdftext failed:', e.message); }
  }

  const FALLBACK_BG = `${PROFILE_NAME} background:
- [Role] at [Company]: [impact with metric]
- [Role] at [Company]: [impact with metric]
- [Degree], [School]
- Skills: [comma-separated skills]`;

  const candidateBackground = resumeText.length > 200
    ? `${PROFILE_NAME}'s resume for THIS application (draw all bullets and the alignment sentence ONLY from this — these are the real, tailored experiences):\n${resumeText.slice(0, 5000)}`
    : FALLBACK_BG;

  // 4. Generate email with Claude.
  const recipientFirst = profileData.firstName || 'there';

  const emailPrompt = `You are writing a cold outreach email for ${PROFILE_NAME} applying to a job.

Your task: read the JOB DESCRIPTION to understand what this role most needs, then read THE RESUME and pick the three experiences that best prove the candidate can do THIS job. Map resume evidence to the role's top priorities.

Output the email body as a single HTML string — no markdown, no actual newlines, use <br><br> between paragraphs and between bullets. Use EXACTLY this structure:

Hi ${recipientFirst},<br><br>I hope you're doing well. ${PROFILE_INTRO}<br><br>I came across and applied to <a href="${resolvedJobUrl}">[role title] at [company name]</a> and was really impressed by what you're building. [1 short sentence: specific genuine reason tied to the candidate's background — no dashes, no "exactly", no filler]<br><br>Your time is valuable, so keeping the information brief and point wise.<br><br><div style="padding-left:20px;text-indent:-12px">•&nbsp;&nbsp;&nbsp;[bullet 1]</div><br><div style="padding-left:20px;text-indent:-12px">•&nbsp;&nbsp;&nbsp;[bullet 2]</div><br><div style="padding-left:20px;text-indent:-12px">•&nbsp;&nbsp;&nbsp;[bullet 3]</div><br>I've attached my resume for your reference.

Rules:
- Extract role title and company name from the job description
- The THREE bullets must be ordered strongest-first: bullet 1 is the single most relevant and impressive proof point for THIS role, then descending. Do not bury the strongest point.
- Each bullet maps a concrete resume experience (with its metric/impact) to a need expressed in the job description
- Each bullet is 1 punchy line drawn from the actual resume — do not invent anything not in the resume
- The alignment sentence after the job link must be one clean sentence — no em dashes, no "exactly", no "seamlessly", no filler adjectives
- Each bullet uses the exact div format shown above — never plain • dash or any other format
- Subject: Application — [Role] at [Company] | ${PROFILE_NAME}

THE RESUME:
${candidateBackground}

Output ONLY in this exact format:
EMAIL SUBJECT: <subject line>
EMAIL BODY:
<full email body>
END EMAIL

JOB DESCRIPTION:
${resolvedJobText.slice(0, 6000)}`;

  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         claudeKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5',
      max_tokens: 1024,
      messages:   [{ role: 'user', content: emailPrompt }],
    }),
  });
  const apiData = await apiRes.json();
  const raw     = apiData?.content?.[0]?.text || '';
  slog('Claude raw (first 300):', raw.slice(0, 300).replace(/\n/g, '\\n'));
  const subjectMatch = raw.match(/EMAIL SUBJECT:\s*(.+)/i);
  const bodyMatch    = raw.match(/EMAIL BODY:\s*([\s\S]+?)(?:END EMAIL|$)/i);
  const subject = subjectMatch?.[1]?.trim() || '';
  const body    = bodyMatch?.[1]?.trim().replace(/END EMAIL\s*$/i, '').trim() || '';

  if (!subject || !body) {
    if (apiData?.error) {
      slog('ERROR Claude API error:', JSON.stringify(apiData.error));
    } else {
      slog('ERROR Claude did not follow email format — likely bad job text stored under key:', companyKey,
           '— re-run Send to Claude on the actual job posting page');
    }
    notifyUser('SwiftHire', 'Bad job text — open the job posting and click Send to Claude again.');
    return;
  }

  // 5. Open Mail.
  fetch('http://127.0.0.1:9875', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: email, subject, html_body: body, attachment: attachmentPath }),
  }).catch(e => slog('ERROR mail server:', e.message));

  notifyUser('SwiftHire — Mail ready', email ? `Composed for ${name} <${email}>` : `Composed for ${name} (no email found)`);
}

// ── Prompt injection + early download behavior on claude.ai tabs ──────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url?.startsWith('https://claude.ai')) return;

  // Set CDP download behavior as soon as ANY claude.ai tab finishes loading so
  // downloads go straight to DOWNLOAD_DIR with no save dialog.
  await ensureDownloadBehavior(tabId);

  if (!pending[tabId]) return;
  const prompt = pending[tabId];
  delete pending[tabId];

  chrome.scripting.executeScript({
    target: { tabId },
    func: injectPrompt,
    args: [prompt],
  });
});

// Runs in LinkedIn company page context — must be self-contained.
async function extractCompanyWebsite() {
  const IGNORE = [
    'linkedin.com', 'google.com', 'apple.com', 'twitter.com', 'x.com',
    'facebook.com', 'instagram.com', 'youtube.com', 'lnkd.in',
    // link shorteners & tracking redirectors
    'hubs.la', 'hubs.li', 'hubs.hs', 'hubspot.com',
    'bit.ly', 'tinyurl.com', 'ow.ly', 'buff.ly', 't.co',
    'short.io', 'rb.gy', 'cutt.ly', 'smarturl.it', 'tiny.cc',
  ];

  function getDomain() {
    const domainTextRe = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,6})\/?$/i;
    const SOCIAL = ['linkedin.com', 'twitter.com', 'x.com', 'facebook.com',
                    'instagram.com', 'youtube.com', 'google.com'];
    for (const a of document.querySelectorAll('a[href]')) {
      const txt = (a.innerText || a.textContent || '').trim();
      const m   = txt.match(domainTextRe);
      if (m) {
        const dom = m[1].toLowerCase();
        if (!SOCIAL.some(d => dom.includes(d))) return dom;
      }
    }

    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href;
      if (!href.startsWith('http')) continue;

      if (href.includes('linkedin.com/redir/redirect')) {
        const match = href.match(/[?&]url=([^&]+)/);
        if (match) {
          try {
            const hostname = new URL(decodeURIComponent(match[1])).hostname.replace(/^www\./, '');
            if (hostname && !IGNORE.some(d => hostname.includes(d))) return hostname;
          } catch {}
        }
        continue;
      }

      try {
        const hostname = new URL(href).hostname.replace(/^www\./, '');
        if (hostname && !IGNORE.some(d => hostname.includes(d))) return hostname;
      } catch {}
    }
    return null;
  }

  return await new Promise((resolve) => {
    const start = Date.now();
    function check() {
      const domain = getDomain();
      if (domain) return resolve({ domain });
      if (Date.now() - start > 15000) return resolve({ domain: null });
      setTimeout(check, 600);
    }
    // Give LinkedIn's SPA 2s to render the About section content.
    setTimeout(check, 2000);
  });
}

// Runs in claude.ai tab context — must be self-contained.
function injectPrompt(text) {
  function attempt(tries) {
    const editor =
      document.querySelector('.ProseMirror[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"][data-placeholder]') ||
      document.querySelector('div[contenteditable="true"]');

    if (editor) {
      editor.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);

      setTimeout(() => {
        const sendBtn =
          document.querySelector('button[aria-label="Send message"]') ||
          document.querySelector('button[type="submit"]') ||
          document.querySelector('button[data-testid="send-button"]') ||
          [...document.querySelectorAll('button')].find(b =>
            b.getAttribute('aria-label')?.toLowerCase().includes('send') ||
            b.title?.toLowerCase().includes('send')
          );
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
        } else {
          editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
          }));
        }
      }, 300);
      return;
    }
    if (tries > 0) setTimeout(() => attempt(tries - 1), 600);
  }
  attempt(15);
}
