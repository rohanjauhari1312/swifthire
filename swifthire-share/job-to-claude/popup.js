const btnSend  = document.getElementById('btn-send');
const btnEmail = document.getElementById('btn-email');
const btnFill  = document.getElementById('btn-fill');
const btnApply = document.getElementById('btn-apply');
const statusEl   = document.getElementById('status');
const emailResult  = document.getElementById('email-result');
const resultName   = document.getElementById('result-name');
const resultEmail  = document.getElementById('result-email');
const copyBtn      = document.getElementById('copy-btn');
const composeBtn   = document.getElementById('compose-btn');
const jobPicker     = document.getElementById('job-picker');
const pickerName    = document.getElementById('picker-name');
const pickerSelect  = document.getElementById('picker-select');
const pickerJd      = document.getElementById('picker-jd');
const pickerResume  = document.getElementById('picker-resume');
const pickerConfirm = document.getElementById('picker-confirm');
const pickerCancel  = document.getElementById('picker-cancel');
const apolloKeyInput  = document.getElementById('apollo-key');
const saveKeyBtn      = document.getElementById('save-key');
const claudeKeyInput  = document.getElementById('claude-key');
const saveClaudeKeyBtn = document.getElementById('save-claude-key');

// ── Profile (hardcoded) — fill in your own details ──────────────
const PROFILE = {
  firstName:   'First',
  lastName:    'Last',
  fullName:    'First Last',
  email:       'you@example.com',
  phone:       '0000000000',
  city:        'City',
  state:       'ST',
  country:     'United States',
  linkedin:    'https://linkedin.com/in/your-handle',
  website:     'yoursite.com',
  veteran:     'not a veteran',
  disability:  'no disability',
  ethnicity:   '',
  workAuth:    'yes',
  sponsorship: 'yes',
  school:      'Your University',
  degree:      'Master',
  major:       'Your Major',
  gradYear:    '2026',
};

// Your Claude.ai project URL (the project that generates your resumes).
const PROJECT_URL = 'https://claude.ai/project/YOUR_PROJECT_ID';

// tabId of the Claude tab opened for AI answers
let claudeTabId = null;

// Load saved keys
chrome.storage.local.get(['apolloKey', 'claudeKey'], ({ apolloKey, claudeKey }) => {
  if (apolloKey) apolloKeyInput.value = apolloKey;
  if (claudeKey) claudeKeyInput.value = claudeKey;
});

saveKeyBtn.addEventListener('click', () => {
  chrome.storage.local.set({ apolloKey: apolloKeyInput.value.trim() });
  setStatus('Hunter key saved.', 'success');
});

saveClaudeKeyBtn.addEventListener('click', () => {
  chrome.storage.local.set({ claudeKey: claudeKeyInput.value.trim() });
  setStatus('Claude key saved.', 'success');
});

// ── Send to Claude ──────────────────────────────────────────────
btnSend.addEventListener('click', async () => {
  setBusy(true);
  setStatus('Extracting job description...');
  emailResult.style.display = 'none';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractJobText,
    });
  } catch {
    setStatus('Cannot read this page. Navigate to a job posting first.', 'error');
    setBusy(false);
    return;
  }

  const jobText = result?.result;
  if (!jobText || jobText.length < 100) {
    setStatus('No job description found. Try selecting the text first.', 'error');
    setBusy(false);
    return;
  }

  const company = extractCompanyFromUrl(tab.url);
  chrome.storage.local.get({ jobTextMap: {}, jobUrlMap: {} }, ({ jobTextMap, jobUrlMap }) => {
    jobTextMap[company] = jobText;
    jobUrlMap[company]  = tab.url;
    chrome.storage.local.set({ jobText, jobUrl: tab.url, jobTextMap, jobUrlMap });
  });
  const prompt = `Job URL: ${tab.url}\n\nJob Description:\n${jobText}`;
  chrome.runtime.sendMessage({ type: 'SEND_TO_CLAUDE', prompt, company });
  setStatus('Opening Claude...');
  setTimeout(() => window.close(), 800);
});

// ── Get Email ───────────────────────────────────────────────────
btnEmail.addEventListener('click', async () => {
  setBusy(true);
  emailResult.style.display = 'none';

  const { apolloKey } = await chrome.storage.local.get('apolloKey');
  if (!apolloKey) {
    setStatus('Add your Hunter API key in settings below.', 'error');
    setBusy(false);
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab.url?.includes('linkedin.com/in/')) {
    setStatus('Navigate to a LinkedIn profile first.', 'error');
    setBusy(false);
    return;
  }

  let profileData;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeLinkedInProfile,
    });
    profileData = res?.result;
  } catch {
    setStatus('Could not read LinkedIn profile.', 'error');
    setBusy(false);
    return;
  }

  if (!profileData?.firstName) {
    setStatus('Could not extract name from this profile.', 'error');
    setBusy(false);
    return;
  }
  if (!profileData?.companyLinkedInUrl) {
    setStatus('Could not find company link on this profile.', 'error');
    setBusy(false);
    return;
  }

  // Hand off everything to the background worker. It resolves the company
  // domain, matches the job + resume, and composes — so this keeps running even
  // after the popup closes. If it can't match, it saves a pending request and
  // notifies; reopening the popup shows the picker.
  chrome.runtime.sendMessage({ type: 'RUN_EMAIL_COMPOSE', profileData, apolloKey });
  setStatus('Working in background — you can leave this page.', 'success');
  setTimeout(() => window.close(), 900);
});

// Render the job/resume picker (used when the background couldn't auto-match).
function showPicker(pending) {
  const { profileData, apolloKey, domain, keys, resumeFiles, jobKey, resumeName } = pending;
  const linkedinSlug = (() => {
    try { return new URL(profileData.companyLinkedInUrl).pathname.split('/').filter(Boolean)[1] || ''; } catch { return ''; }
  })();

  pickerName.textContent = `${profileData.firstName} ${profileData.lastName} — ${domain || profileData.companyName || linkedinSlug || ''}`;
  pickerSelect.innerHTML = '';
  if (!jobKey) {
    const ph = document.createElement('option');
    ph.value = ''; ph.textContent = '— Pick a job —'; ph.selected = true; ph.disabled = true;
    pickerSelect.appendChild(ph);
  }
  for (const k of keys) {
    const opt = document.createElement('option');
    opt.value = k; opt.textContent = k;
    if (k === jobKey) opt.selected = true;
    pickerSelect.appendChild(opt);
  }
  pickerResume.innerHTML = '';
  if (!resumeName) {
    const ph = document.createElement('option');
    ph.value = ''; ph.textContent = '— Pick a resume —'; ph.selected = true; ph.disabled = true;
    pickerResume.appendChild(ph);
  }
  for (const f of resumeFiles) {
    const opt = document.createElement('option');
    opt.value = f.path; opt.textContent = f.name;
    if (f.name === resumeName) opt.selected = true;
    pickerResume.appendChild(opt);
  }

  pickerJd.value = '';
  chrome.storage.local.get('pendingComposes', ({ pendingComposes = [] }) => {
    const n = pendingComposes.length;
    setStatus(`Confirm for ${profileData.firstName}${n > 1 ? ` (${n} queued)` : ''}.`, '');
  });
  setBusy(false);
  jobPicker.style.display = 'block';

  // Remove this item from the queue and advance to the next pending pick (if any).
  async function finishItem() {
    const { pendingComposes = [] } = await chrome.storage.local.get('pendingComposes');
    const rest = pendingComposes.filter(p => p.id !== pending.id);
    await chrome.storage.local.set({ pendingComposes: rest });
    if (rest.length) {
      showPicker(rest[0]);
    } else {
      jobPicker.style.display = 'none';
      setStatus('All queued emails handled — you can leave this page.', 'success');
      setTimeout(() => window.close(), 1000);
    }
  }

  pickerConfirm.onclick = async () => {
    const pastedJd = pickerJd.value.trim();
    if (!pickerSelect.value && !pastedJd) { setStatus('Pick a job or paste a JD first.', 'error'); return; }
    if (!pickerResume.value) { setStatus('Pick a resume to attach first.', 'error'); return; }
    chrome.runtime.sendMessage({
      type: 'RUN_EMAIL_COMPOSE',
      profileData,
      apolloKey,
      companyLinkedInUrl: profileData.companyLinkedInUrl,
      companyKey: pickerSelect.value,
      jobTextOverride: pastedJd || null,
      resumePath: pickerResume.value,
    });
    await finishItem();
  };
  pickerCancel.onclick = finishItem;
}

// On open, work through any pending picks the background queued, one at a time.
chrome.storage.local.get('pendingComposes', ({ pendingComposes = [] }) => {
  if (pendingComposes.length) showPicker(pendingComposes[0]);
});

// Ask Claude to map a person's company to the best stored job key + resume file.
async function matchWithClaude(company, jobKeys, resumeNames) {
  const { claudeKey } = await chrome.storage.local.get('claudeKey');
  if (!claudeKey || !company) return null;

  const prompt = `A person works at the company "${company}". I have saved job applications and resume files, each named after the company I applied to.

Job keys: ${JSON.stringify(jobKeys)}
Resume files: ${JSON.stringify(resumeNames)}

Pick the ONE job key and the ONE resume file that correspond to "${company}". Match on company identity (e.g. "Jerry.ai" = "jerry", "Diligent Corporation" = "diligent"). If nothing clearly corresponds to this company, use null.

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
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    const raw = data?.content?.[0]?.text || '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    return {
      jobKey:     parsed.jobKey && parsed.jobKey !== 'null' ? parsed.jobKey : null,
      resumeFile: parsed.resumeFile && parsed.resumeFile !== 'null' ? parsed.resumeFile : null,
    };
  } catch {
    return null;
  }
}

// ── Fill Form ───────────────────────────────────────────────────
btnFill.addEventListener('click', async () => {
  setBusy(true);
  setStatus('Scanning form fields...');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let fields = [];
  let frameFields = []; // track which frame each field came from
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: scrapeFormFields,
    });
    let globalIdx = 0;
    for (const res of results) {
      if (!res?.result?.length) continue;
      for (const field of res.result) {
        const f = { ...field, idx: globalIdx, frameId: res.frameId };
        fields.push(f);
        frameFields.push(f);
        globalIdx++;
      }
    }
  } catch (e) {
    setStatus('Cannot access this page.', 'error');
    setBusy(false);
    return;
  }

  if (fields.length === 0) {
    setStatus('No form fields found on this page.', 'error');
    setBusy(false);
    return;
  }

  setStatus(`Found ${fields.length} fields. Filling...`);

  const TEXT_MAP = [
    { keys: ['first name', 'given name', 'firstname'],                  value: PROFILE.firstName },
    { keys: ['last name', 'surname', 'family name', 'lastname'],        value: PROFILE.lastName },
    { keys: ['full name', 'your name', 'preferred name', 'legal name'], value: PROFILE.fullName },
    { keys: ['email'],                                                   value: PROFILE.email },
    { keys: ['phone', 'mobile', 'telephone'],                           value: PROFILE.phone },
    { keys: ['city'],                                                    value: PROFILE.city },
    { keys: ['state', 'province', 'region'],                            value: PROFILE.state },
    { keys: ['country'],                                                 value: PROFILE.country },
    { keys: ['linkedin'],                                                value: PROFILE.linkedin },
    { keys: ['website', 'portfolio', 'personal url'],                   value: PROFILE.website },
    { keys: ['university', 'school', 'institution', 'college'],         value: PROFILE.school },
    { keys: ['degree', 'qualification'],                                 value: PROFILE.degree },
    { keys: ['major', 'discipline', 'field of study'],                  value: PROFILE.major },
    { keys: ['graduation', 'end date', 'grad year'],                    value: PROFILE.gradYear },
  ];

  // For selects/radios: pick the option that best matches the known answer
  const SELECT_MAP = [
    { keys: ['work authorization', 'authorized', 'legal work', 'eligible to work'], answer: 'yes' },
    { keys: ['sponsorship', 'immigration sponsorship', 'visa'],                     answer: 'yes' },
    { keys: ['veteran'],                                                            answer: 'not' },
    { keys: ['disability', 'disabled'],                                             answer: 'no' },
    { keys: ['ethnicity', 'race'],                                                  answer: 'asian' },
    { keys: ['gender'],                                                             answer: 'male' },
    { keys: ['boston', 'relocate', 'based in', 'in-office', 'on-site'],           answer: 'yes' },
    { keys: ['country'],                                                            answer: 'united states' },
    { keys: ['state'],                                                              answer: 'massachusetts' },
    { keys: ['employment type', 'job type'],                                        answer: 'full' },
    { keys: ['degree', 'education level'],                                          answer: 'master' },
  ];

  function bestOption(options, answer) {
    const a = answer.toLowerCase();
    return options.find(o => o.toLowerCase() === a)
        || options.find(o => o.toLowerCase().includes(a))
        || options.find(o => a.includes(o.toLowerCase()) && o.length > 1)
        || null;
  }

  const directFills = [];
  const aiQuestions = [];

  for (const field of fields) {
    const lbl = (field.label || field.placeholder || '').toLowerCase();

    if (field.type === 'text' || field.type === 'textarea') {
      const matched = TEXT_MAP.find(m => m.keys.some(k => lbl.includes(k)));
      if (matched) {
        directFills.push({ idx: field.idx, elId: field.elId, elName: field.elName, type: field.type, value: matched.value });
      } else if (field.type === 'textarea' && lbl.length > 10) {
        aiQuestions.push(lbl);
      }
      continue;
    }

    if (field.type === 'select' || field.type === 'radio') {
      const rule = SELECT_MAP.find(m => m.keys.some(k => lbl.includes(k)));
      if (rule && field.options?.length) {
        const opt = bestOption(field.options, rule.answer);
        if (opt) directFills.push({ idx: field.idx, elId: field.elId, elName: field.elName, name: field.name, type: field.type, value: opt });
      }
    }
  }

  let fills = [...directFills];

  // Apply Claude fills (selects/radios)
  if (fills.length) {
    try {
      const byFrame = {};
      for (const fill of fills) {
        const field = frameFields.find(f => f.idx === fill.idx);
        const fid = field?.frameId ?? 0;
        if (!byFrame[fid]) byFrame[fid] = [];
        byFrame[fid].push(fill);
      }
      for (const [frameId, frameFills] of Object.entries(byFrame)) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [parseInt(frameId)] },
          func: applyFormFill,
          args: [frameFills],
        });
      }
    } catch (e) { /* non-fatal */ }
  }

  if (aiQuestions.length === 0) {
    setStatus(`Filled ${fills.length} fields.`, 'success');
    setBusy(false);
    return;
  }

  const prompt = buildAIPrompt(aiQuestions);
  chrome.runtime.sendMessage({ type: 'OPEN_CLAUDE_FOR_ANSWERS', prompt }, (res) => {
    claudeTabId = res?.tabId || null;
  });

  setStatus(`Filled ${fills.length} fields. ${aiQuestions.length} AI question(s) sent to Claude.`, 'success');
  btnApply.style.display = 'flex';
  setBusy(false);
});

// ── Apply AI Answers ────────────────────────────────────────────
btnApply.addEventListener('click', async () => {
  setBusy(true);
  setStatus('Reading Claude\'s response...');

  const [formTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Prefer the resume tab; fall back to claudeTabId
  if (!claudeTabId) {
    const res = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_RESUME_TAB' }, r));
    claudeTabId = res?.tabId || null;
  }

  let claudeResult;
  try {
    const targetTabId = claudeTabId;
    if (!targetTabId) throw new Error('No Claude tab tracked.');

    [claudeResult] = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      func: readClaudeResponse,
    });
  } catch {
    setStatus('Could not read Claude\'s tab. Make sure Claude has responded.', 'error');
    setBusy(false);
    return;
  }

  const raw = claudeResult?.result;
  if (!raw) {
    setStatus('No response found in Claude yet.', 'error');
    setBusy(false);
    return;
  }

  // Parse JSON block from Claude's response
  let answers;
  try {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
    answers = JSON.parse(match ? match[1] : raw);
  } catch {
    setStatus('Could not parse Claude\'s response. Make sure it returned JSON.', 'error');
    setBusy(false);
    return;
  }

  // Apply answers to form
  try {
    await chrome.scripting.executeScript({
      target: { tabId: formTab.id },
      func: applyAIAnswers,
      args: [answers],
    });
    setStatus('All fields filled.', 'success');
    btnApply.style.display = 'none';
  } catch {
    setStatus('Failed to apply answers to form.', 'error');
  }

  setBusy(false);
});

// ── Copy email ──────────────────────────────────────────────────
copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(resultEmail.textContent);
  copyBtn.textContent = 'Copied';
  setTimeout(() => (copyBtn.textContent = 'Copy email'), 1500);
});

// ── Compose Mail ────────────────────────────────────────────────
composeBtn.addEventListener('click', composeEmail);

async function composeEmail() {
  composeBtn.textContent = 'Generating email...';
  composeBtn.disabled = true;

  const { claudeKey, jobText, jobUrl, latestResume, targetCompany, resumeMap = {}, jobTextMap = {}, jobUrlMap = {} } =
    await chrome.storage.local.get(['claudeKey', 'jobText', 'jobUrl', 'latestResume', 'targetCompany', 'resumeMap', 'jobTextMap', 'jobUrlMap']);

  if (!claudeKey) {
    composeBtn.textContent = 'Add Claude API key in settings';
    composeBtn.disabled = false;
    return;
  }

  // Fuzzy-match targetCompany (LinkedIn slug) against stored job/resume slugs.
  function normSlug(s) { return (s || '').toLowerCase().replace(/[-_\s.]/g, ''); }
  function fuzzyMatch(target, keys) {
    const t = normSlug(target);
    if (!t) return null;
    return keys.find(k => normSlug(k) === t)
        || keys.find(k => { const n = normSlug(k); return t.includes(n) || n.includes(t); })
        || null;
  }

  const GARBAGE = new Set(['app','apply','ats','boards','career','careers','careers-home','company','details','en','frontcareers','global','job','jobs','openings','positions','postings','recruiting','us','www']);
  const matchedKey  = fuzzyMatch(targetCompany, Object.keys(resumeMap).filter(k => !GARBAGE.has(k)));
  const matchedJdKey = fuzzyMatch(targetCompany, Object.keys(jobTextMap).filter(k => !GARBAGE.has(k)));
  const resolvedJobText = (matchedJdKey && jobTextMap[matchedJdKey]) || jobText;
  const resolvedJobUrl  = (matchedJdKey && jobUrlMap[matchedJdKey])  || jobUrl;

  if (!resolvedJobText) {
    composeBtn.textContent = 'Click Send to Claude on a job page first';
    composeBtn.disabled = false;
    return;
  }

  const recipientName  = resultName.textContent.trim();
  const recipientFirst = recipientName.split(' ')[0];

  // Replace this with your own one-line-per-item background, or rely on the
  // resume PDF text (the background flow reads the attached resume).
  const candidateBackground = `
${PROFILE.fullName} — background for context when writing bullets:
- [Role] at [Company]: [impact with metric]
- [Role] at [Company]: [impact with metric]
- [Degree], [School]
- Skills: [comma-separated skills]
`;

  const emailPrompt = `You are writing a cold outreach email for ${PROFILE.fullName} applying to a job.

Output the email body as a single HTML string — no markdown, no actual newlines, use <br><br> between paragraphs and between bullets. Use EXACTLY this structure:

Hi ${recipientFirst || '[first name]'},<br><br>I hope you're doing well. I am ${PROFILE.firstName}, [one-line intro about yourself].<br><br>I came across and applied to <a href="${resolvedJobUrl}">[role title] at [company name]</a> and was really impressed by what you're building. [1 short sentence: specific genuine reason tied to your background — no dashes, no "exactly", no filler]<br><br>Your time is valuable, so keeping the information brief and point wise.<br><br><div style="padding-left:20px;text-indent:-12px">•&nbsp;&nbsp;&nbsp;[bullet 1]</div><br><div style="padding-left:20px;text-indent:-12px">•&nbsp;&nbsp;&nbsp;[bullet 2]</div><br><div style="padding-left:20px;text-indent:-12px">•&nbsp;&nbsp;&nbsp;[bullet 3]</div><br>I've attached my resume for your reference.

Rules:
- Extract role title and company name from the job description
- The alignment sentence must be one clean sentence — no em dashes, no "exactly", no filler adjectives
- Each bullet uses the exact div format shown above — never plain • dash or any other format
- Each bullet is 1 punchy line specific to THIS role drawn from your background
- Subject: Application — [Role] at [Company] | ${PROFILE.fullName}

${candidateBackground}

Output ONLY in this exact format with no extra text:
EMAIL SUBJECT: <subject line>
EMAIL BODY:
<full email body>
END EMAIL

Job Description:
${resolvedJobText.slice(0, 6000)}`;

  let subject = '';
  let body    = '';

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
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
    const data = await res.json();
    console.log('Claude API response:', JSON.stringify(data));
    if (!res.ok) {
      composeBtn.textContent = 'API error';
      composeBtn.disabled = false;
      setStatus(`Claude API: ${data?.error?.message || res.status}`, 'error');
      return;
    }
    const raw  = data?.content?.[0]?.text || '';
    console.log('Claude raw text:', raw);
    const subjectMatch = raw.match(/EMAIL SUBJECT:\s*(.+)/i);
    const bodyMatch    = raw.match(/EMAIL BODY:\s*([\s\S]+?)END EMAIL/i);
    subject = subjectMatch?.[1]?.trim() || '';
    body    = bodyMatch?.[1]?.trim()    || '';
    const fn = recipientFirst || 'there';
    subject = subject.replace(/\[first ?name\]/gi, fn);
    body    = body.replace(/\[first ?name\]/gi, fn);
    if (!subject || !body) {
      setStatus('Could not parse email from Claude response — check console.', 'error');
      composeBtn.textContent = 'Compose Mail';
      composeBtn.disabled = false;
      return;
    }
  } catch (e) {
    composeBtn.textContent = 'Claude API error';
    composeBtn.disabled = false;
    setStatus(`Error: ${e.message}`, 'error');
    return;
  }

  composeBtn.textContent = 'Opening Mail...';

  const attachmentPath = (matchedKey && resumeMap[matchedKey]) || latestResume || '';

  // Drop a trigger file for the mail_compose.py launchd watcher.
  // It creates a real Apple Mail draft with HTML body + PDF attached.
  const trigger = {
    to:        resultEmail.textContent.trim(),
    subject,
    html_body: body,
    attachment: attachmentPath,
  };
  chrome.runtime.sendMessage({ type: 'COMPOSE_MAIL', data: trigger });
  composeBtn.textContent = 'Mail opening...';
  setTimeout(() => {
    composeBtn.textContent = 'Compose Mail';
    composeBtn.disabled = false;
  }, 3000);
}

const GENERIC_SLUGS = new Set(['www','jobs','careers','apply','boards','recruiting','job','positions','openings','en','us']);

// ATS platforms where the company slug is the first path segment.
const ATS_BY_PATH = ['workable.com','greenhouse.io','lever.co','ashbyhq.com',
                     'smartrecruiters.com','jobvite.com','recruitee.com','pinpointhq.com',
                     'myworkdayjobs.com','myworkday.com','icims.com'];

function extractCompanyFromUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const parts = host.split('.');
    const sub   = parts[0];

    // ATS: company slug is first non-empty path segment
    if (ATS_BY_PATH.some(a => host.includes(a))) {
      const seg = u.pathname.split('/').find(p => p && !/^\d+$/.test(p) && !GENERIC_SLUGS.has(p));
      if (seg) return seg;
    }

    // Generic subdomain (www, jobs, careers…): use the second-level domain
    if (GENERIC_SLUGS.has(sub)) {
      // e.g. www.intuit.com → "intuit", jobs.intuit.com → "intuit"
      return parts.length >= 3 ? parts[parts.length - 2] : parts[0];
    }

    return sub; // e.g. intuit.wd1.myworkdayjobs.com → "intuit"
  } catch { return 'company'; }
}

function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

// ── Helpers ─────────────────────────────────────────────────────
function setBusy(busy) {
  btnSend.disabled  = busy;
  btnEmail.disabled = busy;
  btnFill.disabled  = busy;
}

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className   = type;
}

function buildAIPrompt(questions) {
  const list = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  return `I am filling out a job application and need your help answering these questions. Use my resume and background files you have. Keep answers brief, specific, and human — no bullet points, no dashes, no filler phrases.\n\nReturn ONLY a JSON object where each key is the question number and the value is the answer. Example: {"1": "answer here", "2": "answer here"}\n\nQuestions:\n${list}`;
}

// ── Content script functions (run in page context) ──────────────

function extractJobText() {
  const selectors = [
    // LinkedIn
    '.jobs-description__content',
    '#job-details',
    // Indeed
    '#jobDescriptionText',
    // Greenhouse
    '.job-post-description',
    '#content .posting',
    // Lever
    '.posting-description',
    '.posting-categories ~ .section',
    // Workday
    '[data-automation-id="job-posting-details"]',
    '[data-automation-id="jobPostingDescription"]',
    // iCIMS
    '[class*="iCIMS_JobContent"]',
    // SmartRecruiters
    '[class*="job-description"]',
    // Generic specific
    '[class*="jobDescription"]',
    '[class*="JobDescription"]',
    '[id*="job-description"]',
    '[id*="jobDescription"]',
    '[class*="job-detail"]',
    '[class*="JobDetail"]',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim().length > 200) {
      return el.innerText.trim().slice(0, 10000);
    }
  }

  // No known container found — fall back to full page text
  return document.body.innerText.trim().slice(0, 10000);
}

function scrapeFormFields() {
  function getLabel(el) {
    if (el.id) {
      const lbl = document.querySelector(`label[for="${el.id}"]`);
      if (lbl) return lbl.innerText.trim();
    }
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const lblId = el.getAttribute('aria-labelledby');
    if (lblId) {
      const lbl = document.getElementById(lblId);
      if (lbl) return lbl.innerText.trim();
    }
    let p = el.parentElement;
    for (let i = 0; i < 5 && p; i++) {
      const lbl = p.querySelector('label');
      if (lbl && !lbl.querySelector('input, select, textarea')) return lbl.innerText.trim();
      p = p.parentElement;
    }
    return el.placeholder || el.name || '';
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && !el.closest('[hidden]');
  }

  // Tag all matching elements with a position index using a stable attribute
  const INPUT_SEL = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea';
  const SELECT_SEL = 'select';

  const fields = [];
  let idx = 0;

  for (const el of document.querySelectorAll(INPUT_SEL)) {
    if (!isVisible(el)) continue;
    fields.push({
      idx,
      type:        el.tagName === 'TEXTAREA' ? 'textarea' : 'text',
      label:       getLabel(el),
      placeholder: el.placeholder || '',
      elId:        el.id   || null,
      elName:      el.name || null,
    });
    idx++;
  }

  for (const el of document.querySelectorAll(SELECT_SEL)) {
    if (!isVisible(el)) continue;
    const options = [...el.options].map(o => o.text.trim()).filter(t => t && !/^(select|choose|--)/i.test(t));
    fields.push({
      idx,
      type:    'select',
      label:   getLabel(el),
      options,
      elId:    el.id   || null,
      elName:  el.name || null,
    });
    idx++;
  }

  const seen = new Set();
  for (const el of document.querySelectorAll('input[type="radio"]')) {
    if (!isVisible(el) || seen.has(el.name)) continue;
    seen.add(el.name);
    const radios  = [...document.querySelectorAll(`input[type="radio"][name="${el.name}"]`)];
    const options = radios.map(r => {
      const lbl = document.querySelector(`label[for="${r.id}"]`) || r.closest('label');
      return lbl ? lbl.innerText.trim() : r.value;
    });
    fields.push({ idx, type: 'radio', name: el.name, label: getLabel(el), options });
    idx++;
  }

  return fields;
}

function applyFormFill(fills) {
  const INPUT_SEL  = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea';
  const inputEls   = [...document.querySelectorAll(INPUT_SEL)].filter(el => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const selectEls  = [...document.querySelectorAll('select')].filter(el => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });

  // Build an ordered list matching the scrape order
  let inputIdx  = 0;
  let selectIdx = 0;
  const ordered = [];

  // Re-derive the same order as scrapeFormFields
  for (const el of [...document.querySelectorAll(INPUT_SEL + ', select')]) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    ordered.push(el);
  }

  function setVal(el, value) {
    if (el.tagName === 'SELECT') {
      for (const opt of el.options) {
        if (opt.text.trim().toLowerCase() === value.toLowerCase()) {
          el.value = opt.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return;
        }
      }
    } else {
      const proto  = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value);
      el.dispatchEvent(new Event('focus',  { bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur',   { bubbles: true }));
    }
  }

  for (const { idx, value, elId, elName, type } of fills) {
    // 1. Try by id
    if (elId) {
      const el = document.getElementById(elId);
      if (el) { setVal(el, value); continue; }
    }
    // 2. Try by name
    if (elName && type !== 'radio') {
      const el = document.querySelector(`[name="${elName}"]`);
      if (el) { setVal(el, value); continue; }
    }
    // 3. Radio by name
    if (type === 'radio' && elName) {
      const radios = document.querySelectorAll(`input[type="radio"][name="${elName}"]`);
      for (const r of radios) {
        const lbl = document.querySelector(`label[for="${r.id}"]`) || r.closest('label');
        const txt = lbl ? lbl.innerText.trim() : r.value;
        if (txt.toLowerCase() === value.toLowerCase()) {
          r.checked = true;
          r.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
      }
      continue;
    }
    // 4. Fall back to position index
    if (ordered[idx]) setVal(ordered[idx], value);
  }
}

function readClaudeResponse() {
  // Get the last assistant message in Claude's chat
  const messages = document.querySelectorAll('[data-testid="assistant-message"], .font-claude-message, [class*="assistant"]');
  if (messages.length === 0) {
    // fallback: get last large text block
    const all = document.querySelectorAll('p, div');
    for (let i = all.length - 1; i >= 0; i--) {
      const t = all[i].innerText?.trim();
      if (t && t.length > 50) return t;
    }
    return null;
  }
  return messages[messages.length - 1].innerText.trim();
}

function applyAIAnswers(answers) {
  const AI_KEYWORDS = /why|describe|tell us|how did|what is|explain|experience|challenge|motivat|passion|strength|weakness|goal|yourself|contribute|interest|achiev|impact|situation|example|proud|role|fit|culture|team|value/i;

  function findLabel(el) {
    const id = el.id;
    if (id) {
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) return label.innerText.trim().toLowerCase();
    }
    const parent = el.closest('label, div, p, li, fieldset');
    return parent ? parent.innerText.trim().toLowerCase() : '';
  }

  function setNativeValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const textareas = document.querySelectorAll('textarea, input[type="text"]');
  let idx = 1;

  for (const el of textareas) {
    if (el.offsetParent === null) continue;
    const label = findLabel(el);
    if ((el.tagName === 'TEXTAREA' || el.rows > 2) && AI_KEYWORDS.test(label)) {
      const answer = answers[String(idx)];
      if (answer) setNativeValue(el, answer);
      idx++;
    }
  }
}

function scrapeLinkedInProfile() {
  const titleName = document.title.split('|')[0].split('-')[0].trim();
  const parts     = titleName.split(' ');
  const firstName = parts[0] || '';
  const lastName  = parts.slice(1).join(' ') || '';

  const allCompanyLinks = [...document.querySelectorAll('a[href*="linkedin.com/company/"]')];

  // Find the company whose experience entry contains "Present" — that's the current role.
  let currentLink = null;
  for (const link of allCompanyLinks) {
    // Walk up to a list item or section container and check for "Present"
    let el = link.parentElement;
    for (let i = 0; i < 8 && el; i++) {
      if (/\bPresent\b/.test(el.innerText || '')) {
        currentLink = link;
        break;
      }
      el = el.parentElement;
    }
    if (currentLink) break;
  }

  // Fall back to the first company link if no "Present" found
  const companyLink = currentLink || allCompanyLinks[0] || null;
  const companyLinkedInUrl = companyLink?.href.split('?')[0] || null;

  // Slug from the company URL (often a numeric id, sometimes a real handle).
  let slug = '';
  try { slug = new URL(companyLinkedInUrl).pathname.split('/').filter(Boolean)[1] || ''; } catch {}
  const slugName = /^\d+$/.test(slug) ? '' : slug
    .replace(/-/g, ' ')
    .replace(/\b\d{4,}\b/g, '')
    .replace(/\binc\b|\bllc\b/gi, '')
    .trim();

  const TITLE = /\b(head|vp|vice president|director|manager|lead|engineer|analyst|officer|founder|chief|president|associate|specialist|consultant|intern|coordinator|growth|product|marketing|operations|strategy|sales|design)\b/i;

  // 1. Parse the headline under the name, e.g. "Head of Product @Peak Health AI | ...".
  //    Scan every plausible headline element, not just one selector.
  function companyFromHeadline() {
    const cands = [
      ...document.querySelectorAll('.text-body-medium, [data-generated-suggestion-target], main section .break-words'),
    ];
    for (const el of cands) {
      const txt = (el.innerText || '').trim();
      if (!txt || txt.length > 220) continue;
      const m = txt.match(/@\s*([^|·•\n]+)/) || txt.match(/\bat\s+([A-Z][^|·•\n]+)/);
      if (m) {
        return m[1].trim()
          .replace(/\s*\|.*$/, '')
          .replace(/\b(AI|Inc|LLC|Corporation|Corp|Technologies|Labs)\.?$/i, '')
          .trim() || m[1].trim();
      }
    }
    return '';
  }

  // 2. The visible company name shown as a clean link in the top card.
  function companyFromLinks() {
    for (const link of allCompanyLinks) {
      const t = (link.innerText || '').trim().split('\n')[0];
      if (t && t.length > 1 && t.length < 50 && !TITLE.test(t) && !/^\d+$/.test(t)) return t;
    }
    return '';
  }

  const companyName = companyFromHeadline() || companyFromLinks() || slugName || '';

  return { firstName, lastName, companyLinkedInUrl, companyName };
}
