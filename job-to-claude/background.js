const PROJECT_URL = 'https://claude.ai/project/019d7296-55a4-77b4-9b35-84c57e2c41d7';

const pending = {};
let resumeTabId = null; // tab opened when "Send to Claude" was clicked

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'SEND_TO_CLAUDE') {
    chrome.tabs.create({ url: PROJECT_URL }, (tab) => {
      resumeTabId = tab.id;
      pending[tab.id] = msg.prompt;
    });
  }

  if (msg.type === 'OPEN_CLAUDE_FOR_ANSWERS') {
    if (resumeTabId) {
      // Inject into the same tab that was used for the resume
      chrome.scripting.executeScript({
        target: { tabId: resumeTabId },
        func: injectPrompt,
        args: [msg.prompt],
      });
      sendResponse({ tabId: resumeTabId });
    } else {
      // Fallback: open a new tab if resume tab is gone
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

  if (msg.type === 'GET_COMPANY_WEBSITE') {
    // Navigate directly to the About tab
    const aboutUrl = msg.url.replace(/\/?$/, '/') + 'about/';
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
          console.log('Company page result:', JSON.stringify(result));
          chrome.tabs.remove(companyTabId);
          sendResponse({ website: result?.domain || null });
        });
      });
    });
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!pending[tabId]) return;
  if (!tab.url?.startsWith('https://claude.ai')) return;

  const prompt = pending[tabId];
  delete pending[tabId];

  chrome.scripting.executeScript({
    target: { tabId },
    func: injectPrompt,
    args: [prompt],
  });
});

// Runs in LinkedIn company About page context — must be self-contained
async function extractCompanyWebsite() {
  const IGNORE = ['linkedin.com', 'google.com', 'apple.com', 'twitter.com',
                  'facebook.com', 'instagram.com', 'youtube.com', 'lnkd.in'];

  function getDomain() {
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href;
      if (!href.startsWith('http')) continue;

      // LinkedIn redirect — decode the real URL
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

      // Direct external link — skip LinkedIn and social platforms
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
      if (Date.now() - start > 8000) return resolve({ domain: null, linksFound: document.querySelectorAll('a[href]').length });
      setTimeout(check, 500);
    }
    check();
  });
}

// Runs in claude.ai tab context — must be self-contained
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

      // Submit after a short delay to let React process the input
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
          // Fallback: press Enter
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
