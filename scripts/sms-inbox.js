#!/usr/bin/env node
// scripts/sms-inbox.js — a local "phone inbox" that shows login codes the way an SMS would
// arrive (OTP_DELIVERY=operator). Open http://127.0.0.1:5055 on THIS computer, then tap
// "Send OTP" on the site: the message pops in within ~1.5 s with a Copy button.
//
//   node scripts/sms-inbox.js            (port 5055, or --port 5056)
//
// Safety: binds to 127.0.0.1 only and reads the same relay log the server writes, so the
// public ngrok link can never expose a code. Never share this page's codes except with
// the person who owns that phone number.
'use strict';

const http = require('http');
const fs = require('fs');
const { RELAY_LOG } = require('../services/otpDelivery');

const portArg = process.argv.indexOf('--port');
const PORT = portArg !== -1 ? Number(process.argv[portArg + 1]) : 5055;

function readEntries() {
  if (!fs.existsSync(RELAY_LOG)) return [];
  return fs.readFileSync(RELAY_LOG, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean)
    .slice(-30)
    .reverse()
    .map((e) => ({ ...e, expired: new Date(e.expiresAt) <= new Date() }));
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Phone inbox (simulated SMS)</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font:16px/1.5 system-ui,'Noto Sans Bengali',sans-serif;background:#0f172a;color:#0f172a;display:flex;justify-content:center}
.phone{width:100%;max-width:380px;min-height:100vh;background:#f1f5f9;display:flex;flex-direction:column}
header{background:#1d4ed8;color:#fff;padding:14px 16px}
header b{display:block;font-size:18px}header span{font-size:13px;opacity:.9}
main{padding:12px;flex:1}
.empty{color:#475569;text-align:center;margin-top:48px}
.msg{background:#fff;border-radius:16px 16px 16px 4px;padding:12px 14px;margin:0 0 12px;box-shadow:0 1px 2px #0003;max-width:92%}
.msg.new{outline:3px solid #047857}
.msg.old{opacity:.55}
.meta{font-size:12px;color:#475569;margin-bottom:4px}
.code{font-size:30px;letter-spacing:6px;font-weight:700;color:#0f172a;margin:6px 0}
.row{display:flex;gap:8px;align-items:center;justify-content:space-between;font-size:13px;color:#334155}
button{min-height:44px;min-width:44px;padding:0 14px;border:0;border-radius:10px;background:#047857;color:#fff;font-weight:700;font-size:15px;cursor:pointer}
</style></head><body><div class="phone">
<header><b>Messages</b><span>BUILDBD · simulated SMS inbox (this PC only)</span></header>
<main id="list"><p class="empty">Waiting for a code… tap “Send OTP” on the login page.</p></main>
</div>
<script>
const list=document.getElementById('list');const seen=new Set();let first=true;
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function left(e){const s=Math.max(0,Math.round((new Date(e.expiresAt)-Date.now())/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
function render(items){
  list.replaceChildren();
  if(!items.length){list.append(el('p','empty','Waiting for a code… tap “Send OTP” on the login page.'));return}
  for(const e of items){
    const key=e.phone+'|'+e.requestedAt;const isNew=!first&&!seen.has(key);seen.add(key);
    const m=el('div','msg'+(e.expired?' old':'')+(isNew?' new':''));
    m.append(el('div','meta','To '+e.phone+' · '+new Date(e.requestedAt).toLocaleTimeString()));
    m.append(el('div','',e.expired?'Your Build-BD login code has expired.':'Your Build-BD login code is:'));
    m.append(el('div','code',e.code));
    const row=el('div','row');row.append(el('span','',e.expired?'Expired':'Valid for '+left(e)+' · do not share'));
    if(!e.expired){const b=el('button','','Copy');b.type='button';b.addEventListener('click',()=>{navigator.clipboard.writeText(e.code).then(()=>{b.textContent='Copied'})});row.append(b)}
    m.append(row);list.append(m);
  }
  first=false;
}
async function tick(){try{const r=await fetch('/messages',{cache:'no-store'});render(await r.json())}catch(_){}}
tick();setInterval(tick,1500);
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/messages') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(readEntries()));
  }
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(PAGE);
  }
  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`📱 Simulated SMS inbox: http://127.0.0.1:${PORT}  (reading ${RELAY_LOG})`);
});
