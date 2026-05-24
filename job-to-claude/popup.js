const btnSend    = document.getElementById('btn-send');
const btnEmail   = document.getElementById('btn-email');
const btnFill    = document.getElementById('btn-fill');
const btnApply   = document.getElementById('btn-apply');
const statusEl   = document.getElementById('status');
const emailResult  = document.getElementById('email-result');
const resultName   = document.getElementById('result-name');
const resultEmail  = document.getElementById('result-email');
const copyBtn      = document.getElementById('copy-btn');
const composeBtn   = document.getElementById('compose-btn');
const apolloKeyInput  = document.getElementById('apollo-key');
const saveKeyBtn      = document.getElementById('save-key');
const claudeKeyInput  = document.getElementById('claude-key');
const saveClaudeKeyBtn = document.getElementById('save-claude-key');

// ── Profile (hardcoded) ─────────────────────────────────────────
const PROFILE = {
  firstName:   'Rohan',
  lastName:    'Jauhari',
  fullName:    'Rohan Jauhari',
  email:       'jauhari.r@northeastern.edu',
  phone:       '8575657995',
  city:        'Boston',
  state:       'MA',
  country:     'United States',
  linkedin:    'https://linkedin.com/in/rohanjauhari',
  website:     'rohanjauhari.com',
  veteran:     'not a veteran',
  disability:  'no disability',
  ethnicity:   'Asian',
  workAuth:    'yes',
  sponsorship: 'yes',
};

const PROJECT_URL = 'https://claude.ai/project/019d7296-55a4-77b4-9b35-84c57e2c41d7';

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

  chrome.storage.local.set({ jobText, jobUrl: tab.url });
  const prompt = `Job URL: ${tab.url}\n\nJob Description:\n${jobText}`;
  chrome.runtime.sendMessage({ type: 'SEND_TO_CLAUDE', prompt });
  setStatus('Opening Claude...');
  setTimeout(() => window.close(), 800);
});

// ── Get Email ───────────────────────────────────────────────────
btnEmail.addEventListener('click', async () => {
  setBusy(true);
  emailResult.style.display = 'none';
  setStatus('');

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

  setStatus('Reading LinkedIn profile...');

  let profileData;
  try {
    const [scrapeResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeLinkedInProfile,
    });
    profileData = scrapeResult?.result;
  } catch {
    setStatus('Could not read LinkedIn profile.', 'error');
    setBusy(false);
    return;
  }

  console.log('Profile data:', JSON.stringify(profileData));

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

  setStatus('Opening company page to get domain...');

  const companyRes = await new Promise(resolve =>
    chrome.runtime.sendMessage({ type: 'GET_COMPANY_WEBSITE', url: profileData.companyLinkedInUrl }, resolve)
  );

  console.log('Company website response:', JSON.stringify(companyRes));
  const domain = companyRes?.website;
  if (!domain) {
    setStatus('Could not find company website. Check if the company has a website listed on LinkedIn.', 'error');
    setBusy(false);
    return;
  }

  setStatus(`Found ${domain}. Looking up email...`);

  try {
    const name = [profileData.firstName, profileData.lastName].filter(Boolean).join(' ');

    const finderParams = new URLSearchParams({
      first_name: profileData.firstName,
      last_name:  profileData.lastName,
      domain,
      api_key:    apolloKey,
    });
    const finderRes  = await fetch(`https://api.hunter.io/v2/email-finder?${finderParams}`);
    const finderData = await finderRes.json();
    console.log('Hunter email-finder response:', JSON.stringify(finderData?.data));
    const email = finderData?.data?.email || null;

    if (!email) {
      setStatus('No email found for this person.', 'error');
      setBusy(false);
      return;
    }

    resultName.textContent  = name;
    resultEmail.textContent = email;
    emailResult.style.display = 'block';
    setStatus('');
  } catch {
    setStatus('Hunter request failed. Check your API key.', 'error');
  }

  setBusy(false);
});

// ── Fill Form ───────────────────────────────────────────────────
btnFill.addEventListener('click', async () => {
  setBusy(true);
  setStatus('Filling form fields...');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let result;
  try {
    [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillStandardFields,
      args: [PROFILE],
    });
  } catch (e) {
    setStatus('Cannot access this page.', 'error');
    setBusy(false);
    return;
  }

  const aiQuestions = result?.result || [];

  if (aiQuestions.length === 0) {
    setStatus('Form filled. No AI questions detected.', 'success');
    setBusy(false);
    return;
  }

  // Send AI questions to Claude project
  const prompt = buildAIPrompt(aiQuestions);
  chrome.runtime.sendMessage({ type: 'OPEN_CLAUDE_FOR_ANSWERS', prompt }, (res) => {
    claudeTabId = res?.tabId || null;
  });

  setStatus(`Filled standard fields. ${aiQuestions.length} AI question(s) sent to Claude.`, 'success');
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
composeBtn.addEventListener('click', async () => {
  composeBtn.textContent = 'Generating email...';
  composeBtn.disabled = true;

  const { claudeKey, jobText, jobUrl } = await chrome.storage.local.get(['claudeKey', 'jobText', 'jobUrl']);

  if (!claudeKey) {
    composeBtn.textContent = 'Add Claude API key in settings';
    composeBtn.disabled = false;
    return;
  }

  if (!jobText) {
    composeBtn.textContent = 'Click Send to Claude on a job page first';
    composeBtn.disabled = false;
    return;
  }

  const recipientName  = resultName.textContent.trim();
  const recipientFirst = recipientName.split(' ')[0];

  const rohanBackground = `
Rohan Jauhari — background for context when writing bullets:
- Product Analyst Co-op at McKinsey (Healthcare, Analytics, AI Tools): defined 50+ KPIs, built end-to-end data pipeline, cut manual analysis 60% with an NL-to-SQL AI tool, analyzed 100+ metrics via Heap Analytics
- Research Assistant at Northeastern University (Healthcare AI, Wearables): built agentic home monitoring system achieving 85% accuracy predicting patient falls using 5+ wearable sensors
- Senior Product Engineer at Avo Automation (No-code SaaS, growth stage): led AI enablement cutting manual effort 90%, grew client base 33%, reduced churn 50%, led 6 engineers + 2 designers
- M.S. Information Systems, Northeastern University (Boston, Aug 2026)
- B.Tech Computer Science, LNM Institute of Information Technology
- Skills: Product Strategy, Roadmapping, AI Agents, Multi-Agent Systems, Data Analysis, Python, SQL, Heap Analytics, Power BI, Supabase
- Projects: Nourish Agent (chat-first AI nutritionist with live Fitbit biometrics), SwiftHire (AI-powered job application automation)
`;

  const emailPrompt = `You are writing a cold outreach email for Rohan Jauhari applying to a job.

Use EXACTLY this structure and tone — do not deviate:

Hi ${recipientFirst},

I hope you're doing well. I am Rohan, Ex-Product @McKinsey and a Master's student at Northeastern University, Boston with 4 years of experience in Product.

I came across and applied to [role title] (${jobUrl}) at [company name] and was really impressed by what you're building. [1-2 sentences: what this specific company builds and a specific, genuine alignment with Rohan's background — not generic filler]

Your time is valuable, so keeping the information brief and point wise.

• [bullet 1]

• [bullet 2]

• [bullet 3]

I've attached my resume for your reference.

Rules:
- Extract role title and company name from the job description
- The 3 bullets must explain why Rohan is a strong fit for THIS specific role — draw from his background below, pick the 3 most relevant points, keep each to 1 punchy line
- Blank line between each bullet (already shown above)
- Company alignment sentence must be specific to what they actually build — no generic phrases like "innovative work" or "mission-driven"
- Subject: Application — [Role] at [Company] | Rohan Jauhari

${rohanBackground}

Output ONLY in this exact format with no extra text:
EMAIL SUBJECT: <subject line>
EMAIL BODY:
<full email body>
END EMAIL

Job Description:
${jobText.slice(0, 6000)}`;

  let subject = '';
  let body    = '';

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         claudeKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5',
        max_tokens: 1024,
        messages:   [{ role: 'user', content: emailPrompt }],
      }),
    });
    const data = await res.json();
    const raw  = data?.content?.[0]?.text || '';
    const subjectMatch = raw.match(/EMAIL SUBJECT:\s*(.+)/i);
    const bodyMatch    = raw.match(/EMAIL BODY:\s*([\s\S]+?)END EMAIL/i);
    subject = subjectMatch?.[1]?.trim() || '';
    body    = bodyMatch?.[1]?.trim()    || '';
  } catch (e) {
    composeBtn.textContent = 'Claude API error';
    composeBtn.disabled = false;
    return;
  }

  composeBtn.textContent = 'Opening Mail...';

  try {
    const res = await fetch('http://127.0.0.1:27182/compose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: resultEmail.textContent, subject, body }),
    });
    const data = await res.json();
    if (data.ok) {
      composeBtn.textContent = 'Mail opened';
    } else {
      composeBtn.textContent = data.error || 'Failed';
      composeBtn.disabled = false;
    }
  } catch {
    composeBtn.textContent = 'Server not running';
    composeBtn.disabled = false;
  }
});

// ── Helpers ─────────────────────────────────────────────────────
function setBusy(busy) {
  btnSend.disabled  = busy;
  btnEmail.disabled = busy;
  btnFill.disabled  = busy;
  btnApply.disabled = busy;
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

function fillStandardFields(profile) {
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
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeInputValueSetter) nativeInputValueSetter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillSelect(el, value) {
    const lower = value.toLowerCase();
    for (const opt of el.options) {
      if (opt.text.toLowerCase().includes(lower) || opt.value.toLowerCase().includes(lower)) {
        el.value = opt.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  function fillRadio(name, value) {
    const radios = document.querySelectorAll(`input[type="radio"][name="${name}"]`);
    const lower = value.toLowerCase();
    for (const r of radios) {
      const lbl = findLabel(r);
      if (lbl.includes(lower) || r.value.toLowerCase().includes(lower)) {
        r.checked = true;
        r.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  const fieldMap = [
    { keys: ['first name', 'given name', 'firstname'],    value: profile.firstName },
    { keys: ['last name', 'surname', 'family name', 'lastname'], value: profile.lastName },
    { keys: ['full name', 'your name'],                   value: profile.fullName },
    { keys: ['email'],                                    value: profile.email },
    { keys: ['phone', 'mobile', 'telephone'],             value: profile.phone },
    { keys: ['city'],                                     value: profile.city },
    { keys: ['state', 'province', 'region'],              value: profile.state },
    { keys: ['country'],                                  value: profile.country },
    { keys: ['linkedin'],                                 value: profile.linkedin },
    { keys: ['website', 'portfolio', 'personal url'],     value: profile.website },
  ];

  const eeoMap = [
    { keys: ['veteran'],                                  value: profile.veteran },
    { keys: ['disability', 'disabled'],                   value: profile.disability },
    { keys: ['ethnicity', 'race'],                        value: profile.ethnicity },
    { keys: ['authorized', 'work in the us', 'work authorization', 'eligible to work'], value: profile.workAuth },
    { keys: ['sponsorship', 'require sponsorship', 'visa'], value: profile.sponsorship },
  ];

  const aiQuestions = [];

  // Fill text inputs and textareas
  const inputs = document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type]), textarea');
  for (const el of inputs) {
    if (el.offsetParent === null) continue; // skip hidden
    const label = findLabel(el);

    // Check AI question
    if ((el.tagName === 'TEXTAREA' || el.rows > 2) && AI_KEYWORDS.test(label)) {
      if (label.length > 10) aiQuestions.push(label);
      continue;
    }

    for (const { keys, value } of fieldMap) {
      if (keys.some(k => label.includes(k))) {
        setNativeValue(el, value);
        break;
      }
    }
  }

  // Fill selects
  const selects = document.querySelectorAll('select');
  for (const el of selects) {
    if (el.offsetParent === null) continue;
    const label = findLabel(el);
    for (const { keys, value } of [...fieldMap, ...eeoMap]) {
      if (keys.some(k => label.includes(k))) {
        fillSelect(el, value);
        break;
      }
    }
  }

  // Fill radio groups
  const radioNames = new Set([...document.querySelectorAll('input[type="radio"]')].map(r => r.name));
  for (const name of radioNames) {
    const firstRadio = document.querySelector(`input[type="radio"][name="${name}"]`);
    if (!firstRadio || firstRadio.offsetParent === null) continue;
    const label = findLabel(firstRadio);
    for (const { keys, value } of [...fieldMap, ...eeoMap]) {
      if (keys.some(k => label.includes(k))) {
        fillRadio(name, value);
        break;
      }
    }
  }

  return aiQuestions;
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
  // Title format: "Daniele Farnedi | LinkedIn"
  const titleName = document.title.split('|')[0].split('-')[0].trim();
  const parts     = titleName.split(' ');
  const firstName = parts[0] || '';
  const lastName  = parts.slice(1).join(' ') || '';

  // Company LinkedIn URL and name
  const companyLinks = document.querySelectorAll('a[href*="linkedin.com/company/"]');
  const companyLinkedInUrl = companyLinks[0]?.href.split('?')[0] || null;

  // Try link text first, fall back to searching nearby text for company name
  let companyName = companyLinks[0]?.innerText?.trim().split('\n')[0] || '';
  if (!companyName && companyLinks[0]) {
    // Walk up to find a parent with meaningful text
    let el = companyLinks[0].parentElement;
    for (let i = 0; i < 4 && el; i++) {
      const t = el.innerText?.trim().split('\n')[0];
      if (t && t.length > 1 && t.length < 60) { companyName = t; break; }
      el = el.parentElement;
    }
  }

  return { firstName, lastName, companyLinkedInUrl, companyName };
}
