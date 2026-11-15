// Chain access for SolidPledge on chipnet (BCH testnet) over plain HTTPS.
// Everything goes through the mainnet-js REST server (rest-unstable.mainnet.cash),
// because this sandbox blocks Electrum WebSockets and raw TCP. The same calls
// work unchanged in a browser (the app) and in Node (the tools).
// No mainnet, no real BCH — chipnet only.
import { decodeCashAddress, encodeCashAddress } from '@bitauth/libauth';

export const REST = 'https://rest-unstable.mainnet.cash';
export const NETWORK = 'testnet'; // mainnet-js calls chipnet "testnet"

export function explorerTxUrl(txid) {
  return `https://blockchair.com/bitcoin-cash/testnet/transaction/${txid}`;
}
export function explorerAddrUrl(addr) {
  return `https://blockchair.com/bitcoin-cash/testnet/address/${addr}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function restPost(path, body, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(REST + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
      if (!res.ok) {
        throw new Error(`REST ${path} -> HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
      }
      return json;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(2000 * (i + 1));
    }
  }
  throw lastErr;
}

// The REST server addresses wallets by "walletId". For read-only access to ANY
// address (including a P2SH contract address) the watch walletId works:
//   watch:testnet:<cashaddr>
// (Verified live: /wallet/utxo + /wallet/balance accept it.)
export function watchWalletId(address) {
  return `watch:${NETWORK}:${toChipnetAddr(address)}`;
}

// The SolidCash SDK may hand us mainnet-prefixed (bitcoincash:) addresses;
// on chipnet the same script hash is addressed with the bchtest: prefix.
// Normalize so the REST server (testnet) accepts it.
export function toChipnetAddr(address) {
  if (address.startsWith('bchtest:')) return address;
  if (!address.startsWith('bitcoincash:')) return address;
  const decoded = decodeCashAddress(address);
  if (typeof decoded === 'string') return address;
  return encodeCashAddress({
    prefix: 'bchtest', type: decoded.type, payload: decoded.payload, throwErrors: true,
  }).address;
}

export async function getUtxos(address) {
  const list = await restPost('/wallet/utxo', { walletId: watchWalletId(address) });
  return (list || []).map((u) => ({
    txid: u.txid,
    vout: Number(u.vout),
    satoshis: BigInt(u.satoshis),
    height: Number(u.height || 0),
    address: u.address || address,
  }));
}

export async function getBalanceSats(address) {
  const r = await restPost('/wallet/balance', { walletId: watchWalletId(address) });
  return BigInt(r.sat ?? r.satoshis ?? r.balance ?? 0);
}

export async function getRawTransaction(txid) {
  const r = await restPost('/wallet/util/get_raw_transaction', {
    txHash: txid, network: NETWORK, verbose: true,
  });
  return r; // { hex, confirmations, blockhash, blocktime, vin, vout, ... }
}

export async function getRawTransactionHex(txid) {
  const r = await getRawTransaction(txid);
  if (!r.hex) throw new Error(`no hex for tx ${txid}`);
  return r.hex;
}

export async function submitTransaction(walletId, transactionHex, awaitPropagation = true) {
  const r = await restPost('/wallet/submit_transaction', {
    walletId, transactionHex, awaitPropagation,
  });
  const txid = r.txId || r.txid || r.hash;
  if (!txid) throw new Error(`broadcast failed: ${JSON.stringify(r).slice(0, 300)}`);
  return txid;
}

export async function requestFaucet(cashaddr) {
  return restPost('/faucet/get_testnet_bch', { cashaddr });
}

// Poll until an address holds at least minSats, or throw after timeoutMs.
export async function waitForBalance(address, minSats, timeoutMs = 180_000, stepMs = 10_000) {
  const started = Date.now();
  for (;;) {
    const bal = await getBalanceSats(address);
    if (bal >= minSats) return bal;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timeout waiting for ${minSats} sat at ${address} (have ${bal})`);
    }
    await sleep(stepMs);
  }
}

// Poll until a tx is visible (and optionally confirmed) on chain.
export async function waitForTx(txid, { minConfirmations = 0, timeoutMs = 300_000, stepMs = 15_000 } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      const r = await getRawTransaction(txid);
      if ((r.confirmations ?? 0) >= minConfirmations) return r;
    } catch { /* not visible yet */ }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timeout waiting for tx ${txid} (minConf=${minConfirmations})`);
    }
    await sleep(stepMs);
  }
}
