// SolidPledge chipnet end-to-end test (Node, HTTPS REST only).
// Proves, with real chipnet transactions:
//   Campaign A: two pledges -> target reached -> payout to the creator.
//   Campaign B: one pledge, unreachable target, deadline already passed
//               -> refund back to the pledger.
// No mainnet, no real BCH. Faucet tBCH only.
// Wallets are saved to tools/.chipnet-wallets.json (mode 600, gitignored)
// so a re-run can reuse them; never commit that file.
//
// Usage: node tools/chipnet-e2e.mjs [--reuse-wallets]
import fs from 'node:fs';
import {
  getUtxos, getBalanceSats, getRawTransaction, submitTransaction,
  requestFaucet, waitForBalance, waitForTx, explorerTxUrl,
} from '../src/chain.js';
import { RestNetworkProvider } from '../src/rest-provider.js';
import {
  campaignArgs, campaignAddress, getCampaignContract, pkhToCashaddr,
  buildPledgeTx, buildPayoutTx, buildRefundTx, PLEDGE_FEE_SATS,
} from '../src/campaign.js';
import {
  createRandomWallet, deriveDepositKey, restSeedWalletId,
} from '../src/wallet.js';

const WALLETS_FILE = new URL('.chipnet-wallets.json', import.meta.url);
const RESULTS_FILE = new URL('chipnet-e2e-results.json', import.meta.url);
const PLEDGE = 3500n;
const TARGET = 5000n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowUnix = () => Math.floor(Date.now() / 1000);

async function makeWallet(role) {
  const w = await createRandomWallet();
  const mnemonic = w.mnemonic;
  const addr = w.getDepositAddress();
  const key = deriveDepositKey(mnemonic, 0);
  if (key.address !== addr) {
    throw new Error(`${role}: derived address ${key.address} != wallet address ${addr}`);
  }
  console.log(`${role}: ${addr} (derivation verified)`);
  return { role, mnemonic, address: addr };
}

async function fund(wallet, minSats = 9000n) {
  const bal = await getBalanceSats(wallet.address);
  if (bal >= minSats) {
    console.log(`  ${wallet.role} already funded: ${bal} sat`);
    return bal;
  }
  console.log(`  faucet -> ${wallet.role} ${wallet.address} ...`);
  const r = await requestFaucet(wallet.address);
  console.log(`  faucet tx: ${r.txId || r.txid || JSON.stringify(r).slice(0, 160)}`);
  const funded = await waitForBalance(wallet.address, minSats, 240_000, 10_000);
  console.log(`  ${wallet.role} balance: ${funded} sat`);
  return funded;
}

async function pledge(provider, wallet, contractAddress, amount) {
  const key = deriveDepositKey(wallet.mnemonic, 0);
  const utxos = await getUtxos(wallet.address);
  const hex = buildPledgeTx({
    provider, walletUtxos: utxos, privKey: key.privKey, walletPkh: key.pkh,
    contractAddress, amountSats: amount,
  });
  const txid = await submitTransaction(restSeedWalletId(wallet.mnemonic, 0), hex);
  console.log(`  pledge ${amount} sat: ${txid}`);
  console.log(`    ${explorerTxUrl(txid)}`);
  return txid;
}

async function waitContractUtxos(address, minTotal, timeoutMs = 300_000) {
  const started = Date.now();
  for (;;) {
    const utxos = await getUtxos(address);
    const total = utxos.reduce((s, u) => s + u.satoshis, 0n);
    if (total >= minTotal) return { utxos, total };
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${minTotal} sat at ${address} (have ${total})`);
    await sleep(10_000);
  }
}

async function main() {
  const reuse = process.argv.includes('--reuse-wallets');
  let wallets;
  if (reuse && fs.existsSync(WALLETS_FILE)) {
    wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'));
    console.log('reusing wallets from', WALLETS_FILE.pathname);
  } else {
    console.log('== wallets ==');
    wallets = {
      creator: await makeWallet('creator'),
      pledger1: await makeWallet('pledger1'),
      pledger2: await makeWallet('pledger2'),
    };
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2), { mode: 0o600 });
    console.log('wallets saved (mode 600, gitignored)');
  }
  const { creator, pledger1, pledger2 } = wallets;
  const results = { wallets: {
    creator: creator.address, pledger1: pledger1.address, pledger2: pledger2.address,
  }, campaigns: {} };

  console.log('== fund pledgers ==');
  await fund(pledger1);
  await fund(pledger2);

  // Broadcast identity: any valid walletId works; prefer the spender's own.
  const provider = new RestNetworkProvider({ walletId: restSeedWalletId(pledger1.mnemonic, 0) });

  // ---------------------------------------------------------- Campaign A: payout
  console.log('== campaign A (payout) ==');
  const creatorKey = deriveDepositKey(creator.mnemonic, 0);
  const deadlineA = nowUnix() + 3600;
  const argsA = campaignArgs(creatorKey.pkh, TARGET, deadlineA);
  const contractA = getCampaignContract(argsA, provider);
  const addressA = contractA.address;
  console.log(`  contract: ${addressA} (target ${TARGET}, deadline ${new Date(deadlineA * 1000).toISOString()})`);
  results.campaigns.payout = { contract: addressA, target: TARGET.toString(), deadline: deadlineA };

  const pledgeA1 = await pledge(provider, pledger1, addressA, PLEDGE);
  const pledgeA2 = await pledge(provider, pledger2, addressA, PLEDGE);
  results.campaigns.payout.pledges = [pledgeA1, pledgeA2];
  const { utxos: utxosA, total: totalA } = await waitContractUtxos(addressA, TARGET);
  console.log(`  raised: ${totalA} sat in ${utxosA.length} UTXO(s) — target reached`);

  const payoutHex = buildPayoutTx({
    provider, contract: contractA, contractUtxos: utxosA,
    creatorAddress: creator.address,
  });
  console.log(`  payout tx bytes: ${payoutHex.length / 2}`);
  const payoutTxid = await submitTransaction(restSeedWalletId(creator.mnemonic, 0), payoutHex);
  console.log(`  payout txid: ${payoutTxid}`);
  console.log(`    ${explorerTxUrl(payoutTxid)}`);
  results.campaigns.payout.payoutTxid = payoutTxid;
  const payoutRaw = await waitForTx(payoutTxid, { minConfirmations: 0 });
  const payoutOut = payoutRaw.vout?.[0];
  console.log(`  payout on-chain: vout0 value=${payoutOut?.value} addrs=${payoutOut?.scriptPubKey?.addresses}`);
  const creatorBal = await getBalanceSats(creator.address);
  console.log(`  creator balance now: ${creatorBal} sat (faucet 0 + payout ${totalA - PLEDGE_FEE_SATS})`);
  results.campaigns.payout.creatorBalance = creatorBal.toString();

  // ---------------------------------------------------------- Campaign B: refund
  console.log('== campaign B (refund) ==');
  // Unreachable target + deadline already passed, so the refund path is
  // exercisable immediately. (The time logic itself is covered by the
  // mock-network tests; this run proves the real on-chain execution.)
  // Deadline is 1 hour in the past, not 5 minutes: a timestamp-locked tx
  // is only "final" once the chain's median-time-past passes the locktime,
  // and chipnet blocks are ~10 min apart, so the chain clock lags the
  // wall clock by minutes. (Run 2 used now-300s and the node rejected the
  // refund as non-final.)
  const deadlineB = nowUnix() - 3600;
  const argsB = campaignArgs(creatorKey.pkh, 50_000n, deadlineB);
  const contractB = getCampaignContract(argsB, provider);
  const addressB = contractB.address;
  console.log(`  contract: ${addressB} (target 50000, deadline already passed)`);
  results.campaigns.refund = { contract: addressB, target: '50000', deadline: deadlineB };

  const pledgeB = await pledge(provider, pledger2, addressB, PLEDGE);
  results.campaigns.refund.pledges = [pledgeB];
  const { utxos: utxosB, total: totalB } = await waitContractUtxos(addressB, PLEDGE);
  console.log(`  raised: ${totalB} sat (target 50000 — not reached, refund path open)`);

  const p2key = deriveDepositKey(pledger2.mnemonic, 0);
  const refundHex = buildRefundTx({
    provider, contract: contractB, pledgeUtxo: utxosB[0],
    pledgerPub: p2key.pub, pledgerPriv: p2key.privKey,
    pledgerAddress: pledger2.address, deadlineUnix: deadlineB,
  });
  console.log(`  refund tx bytes: ${refundHex.length / 2}`);
  const refundTxid = await submitTransaction(restSeedWalletId(pledger2.mnemonic, 0), refundHex);
  console.log(`  refund txid: ${refundTxid}`);
  console.log(`    ${explorerTxUrl(refundTxid)}`);
  results.campaigns.refund.refundTxid = refundTxid;
  const refundRaw = await waitForTx(refundTxid, { minConfirmations: 0 });
  const refundOut = refundRaw.vout?.[0];
  console.log(`  refund on-chain: vout0 value=${refundOut?.value} addrs=${refundOut?.scriptPubKey?.addresses}`);
  const p2bal = await getBalanceSats(pledger2.address);
  console.log(`  pledger2 balance now: ${p2bal} sat`);
  results.campaigns.refund.pledger2Balance = p2bal.toString();
  const leftB = await getUtxos(addressB);
  console.log(`  contract B UTXOs left: ${leftB.length} (expect 0)`);

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  console.log('results saved to', RESULTS_FILE.pathname);
  console.log('E2E OK');
}

main().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });
