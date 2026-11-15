// SolidPledge app — chipnet only, no real BCH.
//
// Wallet: Cashonize Smart Wallet engine (@cashonize/bch-wallet-lib).
// Chain reads + broadcasts: HTTPS REST (mainnet-js server), because this
// sandbox blocks Electrum WebSockets. Signing is local (SolidCash SDK +
// libauth), so the wallet never has to trust the REST server with keys.
import QRCode from 'qrcode';
import {
  getUtxos, getBalanceSats, getRawTransaction, submitTransaction,
  requestFaucet, waitForBalance, explorerTxUrl,
} from './chain.js';
import { RestNetworkProvider } from './rest-provider.js';
import {
  campaignArgs, campaignAddress, getCampaignContract, campaignStatus,
  encodeCampaignLink, decodeCampaignLink, buildPledgeTx, buildPayoutTx,
  buildRefundTx, pkhToCashaddr,
} from './campaign.js';
import {
  createRandomWallet, walletFromMnemonic, deriveDepositKey, restSeedWalletId,
} from './wallet.js';

const $ = (id) => document.getElementById(id);
const MNEMONIC_KEY = 'solidpledge.mnemonic.v1';
const MY_PLEDGES_KEY = 'solidpledge.mypledges.v1';

let mnemonic = null;      // demo wallet mnemonic (chipnet play money only)
let myAddress = null;
let provider = null;      // RestNetworkProvider, walletId set per broadcast
let currentCampaign = null; // { title, creatorPkh, targetSats, deadlineUnix, address }
let refreshTimer = null;

function setStatus(msg, isError = false) {
  const el = $('status-line');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function loadMyPledges() {
  try { return JSON.parse(localStorage.getItem(MY_PLEDGES_KEY) || '{}'); } catch { return {}; }
}
function saveMyPledges(map) {
  localStorage.setItem(MY_PLEDGES_KEY, JSON.stringify(map));
}
function recordMyPledge(contractAddr, utxo) {
  const map = loadMyPledges();
  (map[contractAddr] ||= []).push(utxo);
  saveMyPledges(map);
}

function showReceipt(txid) {
  $('receipt-card').hidden = false;
  $('receipt-txid').textContent = txid;
  const link = $('receipt-link');
  link.href = explorerTxUrl(txid);
  link.textContent = 'View on explorer';
}

function broadcastWalletId() {
  return restSeedWalletId(mnemonic, 0);
}

// ------------------------------------------------------------- wallet UI
async function applyWallet() {
  const key = deriveDepositKey(mnemonic, 0);
  myAddress = key.address;
  provider = new RestNetworkProvider({ walletId: broadcastWalletId() });
  $('wallet-empty').hidden = true;
  $('wallet-ready').hidden = false;
  $('wallet-status').textContent = 'Connected (chipnet)';
  $('wallet-addr').textContent = myAddress;
  $('wallet-note').textContent = 'Demo wallet stored in this browser only. Back it up — it is the same phrase the Cashonize app accepts.';
  await refreshBalance();
}

async function refreshBalance() {
  if (!myAddress) return;
  try {
    const bal = await getBalanceSats(myAddress);
    $('wallet-balance').textContent = `${bal} sat`;
  } catch (e) {
    $('wallet-balance').textContent = 'unavailable';
    setStatus(`Balance read failed: ${e.message}`, true);
  }
}

$('btn-create-wallet').addEventListener('click', async () => {
  try {
    setStatus('Creating demo wallet (Cashonize engine)…');
    const wallet = await createRandomWallet();
    mnemonic = wallet.mnemonic;
    localStorage.setItem(MNEMONIC_KEY, mnemonic);
    await applyWallet();
    setStatus('Wallet created. Fund it from the faucet, then create or join a campaign.');
  } catch (e) {
    setStatus(`Wallet creation failed: ${e.message}`, true);
  }
});

$('btn-import-wallet').addEventListener('click', async () => {
  const phrase = prompt('Paste your 12-word backup phrase:');
  if (!phrase) return;
  try {
    const wallet = await walletFromMnemonic(phrase.trim());
    mnemonic = wallet.mnemonic;
    localStorage.setItem(MNEMONIC_KEY, mnemonic);
    await applyWallet();
    setStatus('Wallet imported.');
  } catch (e) {
    setStatus(`Import failed: ${e.message}`, true);
  }
});

$('btn-show-mnemonic').addEventListener('click', () => {
  const box = $('mnemonic-box');
  box.hidden = !box.hidden;
  if (!box.hidden) {
    box.textContent = mnemonic;
    setStatus('Backup phrase shown. Anyone with these words controls the wallet — never share it.');
  }
});

$('btn-copy-addr').addEventListener('click', async () => {
  await navigator.clipboard.writeText(myAddress);
  setStatus('Address copied.');
});

$('btn-faucet').addEventListener('click', async () => {
  try {
    setStatus('Requesting faucet coins…');
    const r = await requestFaucet(myAddress);
    setStatus(`Faucet sent ${r.amount ?? 10000} sat (tx ${r.txId ?? r.txid ?? '—'}). Waiting for it to show up…`);
    await waitForBalance(myAddress, 1n, 240_000, 10_000);
    await refreshBalance();
    setStatus('Faucet coins arrived.');
  } catch (e) {
    setStatus(`Faucet failed: ${e.message}`, true);
  }
});

$('btn-refresh-balance').addEventListener('click', refreshBalance);

$('btn-disconnect').addEventListener('click', async () => {
  mnemonic = null;
  myAddress = null;
  provider = null;
  localStorage.removeItem(MNEMONIC_KEY);
  $('wallet-empty').hidden = false;
  $('wallet-ready').hidden = true;
  $('wallet-status').textContent = 'No wallet';
  $('wallet-balance').textContent = '—';
  setStatus('Wallet disconnected (browser copy removed).');
});

// ------------------------------------------------------------- create campaign
function defaultDeadlineInput() {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  $('in-deadline').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

$('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!mnemonic) { setStatus('Create a demo wallet first — the campaign creator is your wallet address.', true); return; }
  const title = $('in-title').value.trim();
  const targetSats = BigInt($('in-target').value);
  const deadlineUnix = Math.floor(new Date($('in-deadline').value).getTime() / 1000);
  if (!(deadlineUnix > Math.floor(Date.now() / 1000))) { setStatus('Deadline must be in the future.', true); return; }
  try {
    setStatus('Computing contract address…');
    const key = deriveDepositKey(mnemonic, 0);
    const args = campaignArgs(key.pkh, targetSats, deadlineUnix);
    const address = campaignAddress(args, provider);
    const link = encodeCampaignLink({ title, creatorPkh: key.pkh, targetSats, deadlineUnix });
    $('create-result').hidden = false;
    $('new-contract-addr').textContent = address;
    $('out-link').value = link;
    $('qr-img').src = await QRCode.toDataURL(link, { width: 320, margin: 1 });
    const open = $('link-open-campaign');
    open.href = link;
    open.textContent = 'Open campaign';
    setStatus('Campaign created. Share the link — pledges lock into this contract address.');
    await openCampaign({ title, creatorPkh: key.pkh, targetSats, deadlineUnix, address });
  } catch (err) {
    setStatus(`Campaign creation failed: ${err.message}`, true);
  }
});

$('btn-copy-contract').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('new-contract-addr').textContent);
  setStatus('Contract address copied.');
});

// ------------------------------------------------------------- campaign view
async function openCampaign(campaign) {
  currentCampaign = campaign;
  $('campaign-card').hidden = false;
  $('campaign-title').textContent = campaign.title || 'Campaign';
  await refreshCampaign();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshCampaign, 30_000);
  document.getElementById('campaign-card').scrollIntoView({ behavior: 'smooth' });
}

async function refreshCampaign() {
  if (!currentCampaign) return;
  const { title, creatorPkh, targetSats, deadlineUnix } = currentCampaign;
  const args = campaignArgs(creatorPkh, targetSats, deadlineUnix);
  const address = currentCampaign.address || campaignAddress(args, provider);
  currentCampaign.address = address;
  $('campaign-addr').textContent = address;
  $('target-label').textContent = targetSats.toString();
  const dl = new Date(deadlineUnix * 1000);
  $('deadline-label').textContent = `deadline ${dl.toLocaleString()} (${deadlineUnix < Date.now() / 1000 ? 'passed' : 'open'})`;
  try {
    const utxos = await getUtxos(address);
    const raised = utxos.reduce((s, u) => s + u.satoshis, 0n);
    $('raised-label').textContent = raised.toString();
    $('progress-bar').style.width = `${Math.min(100, Number((raised * 100n) / targetSats))}%`;
    const { state: status } = campaignStatus(raised, targetSats, deadlineUnix);
    const pill = $('campaign-status');
    pill.textContent = { live: 'LIVE', funded: 'FUNDED', 'funded-expired': 'FUNDED — payout open', failed: 'FAILED — refunds open' }[status];
    pill.className = `pill ${status === 'funded' || status === 'funded-expired' ? 'funded' : status === 'failed' ? 'failed' : 'live'}`;
    const list = $('pledge-list');
    list.innerHTML = utxos.length ? '' : '<li class="muted">No pledges yet.</li>';
    for (const u of utxos) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = explorerTxUrl(u.txid);
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `${u.satoshis} sat — ${u.txid.slice(0, 16)}… (vout ${u.vout})`;
      li.append(a);
      list.append(li);
    }
    const myPledges = (loadMyPledges()[address] || [])
      .filter((p) => utxos.some((u) => u.txid === p.txid && u.vout === p.vout));
    $('btn-payout').disabled = !(status === 'funded' || status === 'funded-expired');
    $('btn-refund').disabled = !(status === 'failed' && myPledges.length > 0);
    $('btn-pledge').disabled = false;
    $('campaign-note').textContent = status === 'funded' || status === 'funded-expired'
      ? 'Target reached — anyone can release the payout to the creator.'
      : status === 'failed'
        ? myPledges.length
          ? `Deadline passed unfunded. You have ${myPledges.length} pledge(s) to refund.`
          : 'Deadline passed unfunded. Pledgers can refund their own UTXOs.'
        : 'Pledges lock in the contract until the target is reached or the deadline passes.';
  } catch (err) {
    setStatus(`Campaign read failed: ${err.message}`, true);
  }
}

$('btn-refresh-campaign').addEventListener('click', refreshCampaign);
$('btn-copy-campaign').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('campaign-addr').textContent);
  setStatus('Contract address copied.');
});

$('btn-pledge').addEventListener('click', async () => {
  if (!mnemonic) { setStatus('Create a demo wallet first.', true); return; }
  const amount = BigInt($('in-pledge-amount').value);
  try {
    setStatus('Building pledge transaction…');
    const key = deriveDepositKey(mnemonic, 0);
    const walletUtxos = await getUtxos(myAddress);
    const contractAddr = $('campaign-addr').textContent;
    const hex = buildPledgeTx({
      provider, walletUtxos, privKey: key.privKey, walletPkh: key.pkh,
      contractAddress: contractAddr, amountSats: amount,
    });
    const txid = await submitTransaction(broadcastWalletId(), hex);
    const raw = await getRawTransaction(txid);
    const vout = raw.vout.findIndex((o) => (o.scriptPubKey?.addresses || []).includes(contractAddr));
    recordMyPledge(contractAddr, { txid, vout: Math.max(vout, 0), satoshis: amount.toString() });
    showReceipt(txid);
    setStatus(`Pledged ${amount} sat. Tx ${txid.slice(0, 16)}…`);
    await refreshCampaign();
    await refreshBalance();
  } catch (e) {
    setStatus(`Pledge failed: ${e.message}`, true);
  }
});

$('btn-payout').addEventListener('click', async () => {
  if (!mnemonic) { setStatus('Create a demo wallet first.', true); return; }
  try {
    setStatus('Building payout transaction…');
    const { creatorPkh, targetSats, deadlineUnix, address } = currentCampaign;
    const contract = getCampaignContract(campaignArgs(creatorPkh, targetSats, deadlineUnix), provider);
    const contractUtxos = await getUtxos(address);
    const creatorAddress = pkhToCashaddr(creatorPkh);
    const hex = buildPayoutTx({ provider, contract, contractUtxos, creatorAddress });
    const txid = await submitTransaction(broadcastWalletId(), hex);
    showReceipt(txid);
    setStatus(`Payout released. Tx ${txid.slice(0, 16)}…`);
    await refreshCampaign();
  } catch (e) {
    setStatus(`Payout failed: ${e.message}`, true);
  }
});

$('btn-refund').addEventListener('click', async () => {
  if (!mnemonic) { setStatus('Create a demo wallet first.', true); return; }
  try {
    const { creatorPkh, targetSats, deadlineUnix, address } = currentCampaign;
    const contract = getCampaignContract(campaignArgs(creatorPkh, targetSats, deadlineUnix), provider);
    const contractUtxos = await getUtxos(address);
    const key = deriveDepositKey(mnemonic, 0);
    const mine = (loadMyPledges()[address] || [])
      .map((p) => contractUtxos.find((u) => u.txid === p.txid && u.vout === p.vout))
      .filter(Boolean);
    if (!mine.length) { setStatus('No unspent pledges of yours in this campaign.', true); return; }
    setStatus(`Refunding ${mine.length} pledge(s)…`);
    for (const u of mine) {
      const hex = buildRefundTx({
        provider, contract, pledgeUtxo: u,
        pledgerPub: key.pub, pledgerPriv: key.privKey,
        pledgerAddress: myAddress, deadlineUnix,
      });
      const txid = await submitTransaction(broadcastWalletId(), hex);
      showReceipt(txid);
      setStatus(`Refunded ${u.satoshis} sat. Tx ${txid.slice(0, 16)}…`);
    }
    await refreshCampaign();
    await refreshBalance();
  } catch (e) {
    setStatus(`Refund failed: ${e.message}`, true);
  }
});

// ------------------------------------------------------------- boot
async function boot() {
  defaultDeadlineInput();
  const saved = localStorage.getItem(MNEMONIC_KEY);
  if (saved) {
    try {
      mnemonic = saved;
      await applyWallet();
      setStatus('Demo wallet restored from this browser.');
    } catch (e) {
      setStatus(`Stored wallet could not be restored: ${e.message}`, true);
    }
  }
  if (location.hash.startsWith('#/campaign')) {
    try {
      const campaign = decodeCampaignLink(location.hash);
      if (campaign) {
        const args = campaignArgs(campaign.creatorPkh, campaign.targetSats, campaign.deadlineUnix);
        const address = campaignAddress(args, new RestNetworkProvider());
        await openCampaign({ ...campaign, address });
      }
    } catch (e) {
      setStatus(`Bad campaign link: ${e.message}`, true);
    }
  }
}

boot();
