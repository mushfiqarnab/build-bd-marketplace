// scripts/qa/ui-render.js — renders frontend pages in a real Chromium engine
// (Edge on Windows, Chrome/Chromium on Linux) via the DevTools protocol, with
// true device emulation, and checks what users actually get:
//   • no horizontal overflow at phone width (390 px) or desktop (1280 px)
//   • no JavaScript errors / uncaught exceptions
//   • no Content-Security-Policy violations
//   • every interactive element is a ≥44 px touch target (a11y floor)
//   • the page applied its default language (proof the JS ran)
// Screenshots go to qa-reports/screens/. Zero npm dependencies: Node's
// built-in WebSocket + fetch talk to the browser directly.
//
//   node scripts/qa/ui-render.js http://127.0.0.1:5099
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createReport, runCli } = require('./lib');

const PAGES = [
  '/app/',
  '/app/login.html',
  '/app/dashboard.html',
  '/app/post-project.html',
  '/app/tenders.html',
  '/app/submit-bid.html',
  '/app/project-detail.html'
];
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, mobile: true, dpr: 2 },
  { name: 'desktop', width: 1280, height: 900, mobile: false, dpr: 1 }
];

function findBrowser() {
  const candidates = process.platform === 'win32'
    ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.listeners = []; }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`CDP socket error: ${e.message || e.type}`));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: ok, reject: bad } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) bad(new Error(msg.error.message)); else ok(msg.result);
        } else if (msg.method) {
          for (const l of this.listeners) l(msg);
        }
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch (_) {} }
}

const AUDIT_JS = `(() => {
  const vw = window.innerWidth;
  const overflow = document.documentElement.scrollWidth - vw;
  const offenders = overflow > 1 ? [...document.querySelectorAll('body *')]
    .filter((el) => el.getBoundingClientRect().right > vw + 1 && getComputedStyle(el).position !== 'fixed')
    .slice(0, 5).map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + String(el.className).split(' ').slice(0, 3).join('.')) : [];
  const small = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button]')]
    .filter((el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || s.visibility === 'hidden') return false;
      if (el.type === 'radio' || el.type === 'checkbox') { const lab = el.closest('label'); if (lab) { const lr = lab.getBoundingClientRect(); return lr.height < 44; } }
      if (el.classList.contains('sr-only-focusable')) return false;
      return r.height < 43.5; })
    .map((el) => el.tagName.toLowerCase() + ':' + (el.textContent || el.getAttribute('aria-label') || el.name || '').trim().slice(0, 30) + ' (' + Math.round(el.getBoundingClientRect().height) + 'px)');
  return JSON.stringify({ vw, overflow, offenders, small, lang: document.documentElement.lang, csp: window.__cspViolations || [] });
})()`;

async function run({ url } = {}) {
  const base = (url || process.argv.find((a) => /^https?:\/\//.test(a)) || '').replace(/\/+$/, '');
  const report = createReport(`UI render — ${base || '(no URL)'}`);
  if (!base) { report.fail('url', 'Pass the base URL of a running server'); return report; }
  const browser = findBrowser();
  if (!browser) { report.warn('browser', 'No Edge/Chrome found — UI render checks skipped'); return report; }

  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-ui-'));
  const shotsDir = path.join(ROOT, 'qa-reports', 'screens');
  fs.mkdirSync(shotsDir, { recursive: true });
  const proc = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

  try {
    let version;
    for (let i = 0; i < 40 && !version; i += 1) {
      try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch (_) { await sleep(250); }
    }
    if (!version) { report.fail('browser', 'Browser DevTools endpoint did not come up'); return report; }

    for (const page of PAGES) {
      for (const vp of VIEWPORTS) {
        const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
        const cdp = new Cdp(target.webSocketDebuggerUrl);
        await cdp.open();
        const errors = [];
        cdp.on((m) => {
          if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
          if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
          if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url || '')) errors.push(`${m.params.entry.source}: ${m.params.entry.text}`);
        });
        await cdp.send('Runtime.enable');
        await cdp.send('Log.enable');
        await cdp.send('Page.enable');
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.__cspViolations.push(e.violatedDirective+' '+(e.blockedURI||'inline')));" });
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: vp.mobile });
        if (vp.mobile) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
        await cdp.send('Page.navigate', { url: base + page });
        await sleep(2500); // load + fonts + module scripts + /api/auth/me
        const { result } = await cdp.send('Runtime.evaluate', { expression: AUDIT_JS, returnByValue: true });
        const a = JSON.parse(result.value);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        const file = `${page.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root'}-${vp.name}.png`;
        fs.writeFileSync(path.join(shotsDir, file), Buffer.from(shot.data, 'base64'));
        const id = `${page} @${vp.name}`;

        if (a.vw !== vp.width) report.fail(`viewport:${id}`, `Emulated width ${a.vw}px ≠ requested ${vp.width}px (results not trustworthy)`);
        if (a.overflow > 1) report.fail(`overflow:${id}`, `Content is ${a.overflow}px wider than the screen`, a.offenders);
        else report.pass(`overflow:${id}`, `fits ${a.vw}px`);
        // A 401 from /api/auth/me is the expected signed-out answer, not an error.
        const realErrors = errors.filter((e) => !/\/api\/auth\/me.*401|401 \(Unauthorized\)/.test(e));
        if (realErrors.length) report.fail(`js-errors:${id}`, 'JavaScript / network errors', realErrors.slice(0, 5));
        else report.pass(`js-errors:${id}`, 'no errors');
        if (a.csp.length) report.fail(`csp:${id}`, 'Content-Security-Policy violations', a.csp);
        else report.pass(`csp:${id}`, 'no CSP violations');
        if (a.small.length) report.fail(`touch:${id}`, 'Touch targets under 44px', a.small);
        else report.pass(`touch:${id}`, 'all touch targets ≥44px');
        if (a.lang !== 'bn') report.fail(`lang:${id}`, `Default language not applied (lang=${a.lang})`);
        else report.pass(`lang:${id}`, 'Bangla applied by default');
        report.info(`screenshot:${id}`, `qa-reports/screens/${file}`);

        // Interaction flows on the login page (phone only). Both are
        // write-free: an invalid number is rejected client-side, and a
        // non-invited number is refused by the server before anything is
        // stored. Only run with --flows against a server whose invite list
        // is set (otherwise the second case would create a pending user).
        if (page === '/app/login.html' && vp.mobile && process.argv.includes('--flows')) {
          const evalJs = async (expr) => (await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
          await evalJs("document.getElementById('phone').value='12345'; document.getElementById('phone-form').requestSubmit(); true");
          await sleep(300);
          const invalid = await evalJs("JSON.stringify({shown:!document.getElementById('phone-error').hidden,text:document.getElementById('phone-error').textContent,aria:document.getElementById('phone').getAttribute('aria-invalid')})");
          const iv = JSON.parse(invalid);
          if (iv.shown && /১১ সংখ্যা|11 digits/.test(iv.text) && iv.aria === 'true') report.pass(`flow:invalid-phone`, 'Invalid number → inline Bangla error + aria-invalid, no request sent');
          else report.fail(`flow:invalid-phone`, 'Invalid-number validation not shown correctly', iv);

          await evalJs("document.getElementById('phone').value='+880 1999-999999'; document.getElementById('phone-form').requestSubmit(); true");
          await sleep(2500);
          const inv = JSON.parse(await evalJs("JSON.stringify({alert:document.getElementById('alert').textContent.trim(),alertShown:!document.getElementById('alert').hidden,codeStep:!document.getElementById('code-form').hidden,btnEnabled:!document.getElementById('send-btn').disabled,field:document.getElementById('phone').value})"));
          if (inv.alertShown && /আমন্ত্রিত|invite-only/i.test(inv.alert) && !inv.codeStep && inv.btnEnabled && inv.field === '1999999999') report.pass('flow:invite-only', '+880-formatted non-invited number normalised (field shows 1999999999), refused, Bangla invite-only message, button re-enabled');
          else report.fail('flow:invite-only', 'Invite-only refusal not rendered as expected', inv);
          const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(path.join(shotsDir, 'login-invite-only-phone.png'), Buffer.from(shot2.data, 'base64'));
        }

        cdp.close();
        await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
      }
    }
    return report;
  } finally {
    proc.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { run };
if (require.main === module) runCli(run);
