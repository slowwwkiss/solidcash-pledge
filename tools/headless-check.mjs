// Headless verification of the built SolidPledge app (docs/) in Chromium.
// What this CAN verify here: page load, wallet creation (local), campaign
// creation + share link + QR (local), and that no unexpected JS errors occur.
// What it CANNOT verify here: any HTTPS call from the browser — this VM's
// egress proxy refuses the headless shell's tunnels entirely (even
// example.com fails), so faucet/balance/pledge/status reads are
// UNVERIFIED in-browser. Those exact code paths are proven by the Node
// chipnet E2E (tools/chipnet-e2e.mjs) against the same modules.
// Screenshots + video land in artifacts/. Run while `vite preview` serves
// docs/ on http://127.0.0.1:4175.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.env.SOLIDPLEDGE_URL || 'http://127.0.0.1:4175/';
const SHELL = '/home/hatch/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const ART = new URL('../artifacts/', import.meta.url).pathname;
fs.mkdirSync(ART, { recursive: true });

// Sandbox noise: the Cashonize wallet lib tries Electrum WSS in the
// background (blocked in this VM) and every external HTTPS tunnel is
// refused for the headless shell. Both are environment limits, not app bugs.
const isSandboxNoise = (t) =>
  t.includes('wss://') || t.includes('WebSocket connection') ||
  t.includes('ERR_TUNNEL_CONNECTION_FAILED') || t.includes('rest-unstable.mainnet.cash');

const browser = await chromium.launch({ executablePath: SHELL, args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  recordVideo: { dir: ART, size: { width: 390, height: 844 } },
});
const page = await context.newPage();
const errors = [];
const noise = [];
const failedReqs = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  (isSandboxNoise(m.text()) ? noise : errors).push('[console.error] ' + m.text().slice(0, 200));
});
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
page.on('requestfailed', (r) => failedReqs.push(r.url() + ' :: ' + (r.failure()?.errorText || '')));
page.on('response', (r) => { if (r.status() >= 400) failedReqs.push(r.url() + ' :: HTTP ' + r.status()); });

const shot = (name) => page.screenshot({ path: ART + name, fullPage: true });
let failed = false;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed = true;
};

try {
  console.log('== load home ==');
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  check('title is SolidPledge', (await page.title()).startsWith('SolidPledge'));
  check('hero h1', (await page.textContent('.hero h1')) === 'SolidPledge');
  check('wallet starts disconnected', (await page.textContent('#wallet-status')) === 'No wallet');
  await shot('01-home.png');

  console.log('== create demo wallet (local) ==');
  await page.click('#btn-create-wallet');
  await page.waitForFunction(() => document.getElementById('wallet-status').textContent.includes('Connected'), { timeout: 60000 });
  const addr = await page.textContent('#wallet-addr');
  check('wallet address is a bchtest address', /^bchtest:[a-z0-9]+$/.test(addr || ''));
  console.log('wallet addr:', addr);
  await shot('02-wallet.png');

  console.log('== create campaign (local) ==');
  await page.fill('#in-title', 'Headless demo campaign');
  await page.fill('#in-target', '5000');
  await page.click('#create-form button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('create-result').hidden, { timeout: 30000 });
  await page.waitForTimeout(1000);
  const contract = await page.textContent('#new-contract-addr');
  check('contract address is a bchtest P2SH address', /^bchtest:p[a-z0-9]+$/.test(contract || ''));
  console.log('contract:', contract);
  const link = await page.inputValue('#out-link');
  check('share link is a #/campaign link', link.startsWith('#/campaign?') && link.includes('creator='));
  console.log('link:', link);
  check('QR is a data URL', (await page.getAttribute('#qr-img', 'src') || '').startsWith('data:image/png'));
  check('campaign card opened', await page.evaluate(() => !document.getElementById('campaign-card').hidden));
  await shot('03-campaign.png');

  console.log('== faucet / balance / pledge (needs browser egress) ==');
  await page.click('#btn-faucet');
  await page.waitForTimeout(8000);
  const status = await page.textContent('#status-line');
  console.log('status after faucet attempt:', status);
  console.log('NOTE: browser HTTPS is blocked in this sandbox — faucet/balance/pledge are UNVERIFIED in-browser; proven by tools/chipnet-e2e.mjs (Node) instead.');
  await shot('04-faucet-attempt.png');

  console.log('== errors ==');
  console.log('unexpected JS errors:', errors.length ? errors : 'none');
  console.log('sandbox noise (expected):', noise.length, 'entries');
  console.log('failed requests:', failedReqs.length ? failedReqs.slice(0, 5) : 'none');
  check('zero unexpected JS errors', errors.length === 0);
} catch (e) {
  console.log('CHECK FAILED:', e.message);
  await shot('99-error.png');
  console.log('unexpected errors:', errors);
  failed = true;
} finally {
  await context.close();
  await browser.close();
  console.log('artifacts dir:', ART);
  console.log(failed ? 'HEADLESS CHECK: FAILED' : 'HEADLESS CHECK: PASSED (local flow; network steps unverified in-browser by sandbox design)');
  process.exitCode = failed ? 1 : 0;
}
