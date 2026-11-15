// SolidPledge campaign logic — shared by the app and the chipnet tools.
// A campaign is just constructor parameters for the SolidPledge contract:
//   (creator pubkey hash, target in satoshis, deadline as Unix timestamp).
// The contract address is derived locally from the compiled artifact —
// no on-chain transaction is needed to "create" a campaign. Pledges are
// plain P2SH payments to that address; payout/refund spend them through
// the contract's covenant functions (SolidCash SDK TransactionBuilder).
import artifact from '../artifacts/SolidPledge.json' with { type: 'json' };
import { Contract, SignatureTemplate, TransactionBuilder } from '@solidcash/solidcash';
import { encodeCashAddress, hash160 } from '@bitauth/libauth';
import { bytesToHex, hexToBytes } from './hex.js';

export const PLEDGE_FEE_SATS = 1000n;
export const DUST_SATS = 546n;

export function pkhToCashaddr(pkh) {
  return encodeCashAddress({
    prefix: 'bchtest', type: 'p2pkh', payload: pkh, throwErrors: true,
  }).address;
}

export function pkhToHex(pkh) {
  return bytesToHex(pkh);
}

export function hexToPkh(hex) {
  const b = hexToBytes(hex);
  if (b.length !== 20) throw new Error('creator pkh must be 20 bytes');
  return b;
}

// Campaign parameters, exactly as the contract constructor takes them.
export function campaignArgs(creatorPkh, targetSats, deadlineUnix) {
  return [creatorPkh, BigInt(targetSats), BigInt(deadlineUnix)];
}

export function getCampaignContract(args, provider) {
  return new Contract(artifact, args, { provider });
}

export function campaignAddress(args, provider) {
  return getCampaignContract(args, provider).address;
}

// ---------------------------------------------------------------- share link
// Campaigns travel as a URL hash — the chain holds the money, the link holds
// the parameters. Anyone opening the link can read the live status.
export function encodeCampaignLink({ title, creatorPkh, targetSats, deadlineUnix }) {
  const q = new URLSearchParams({
    title: title || '',
    creator: pkhToHex(creatorPkh),
    target: String(targetSats),
    deadline: String(deadlineUnix),
  });
  return `#/campaign?${q.toString()}`;
}

export function decodeCampaignLink(hash) {
  if (!hash.startsWith('#/campaign?')) return null;
  const q = new URLSearchParams(hash.slice(11));
  const creator = q.get('creator') || '';
  const target = q.get('target') || '';
  const deadline = q.get('deadline') || '';
  if (!/^[0-9a-fA-F]{40}$/.test(creator) || !target || !deadline) return null;
  return {
    title: q.get('title') || 'Untitled campaign',
    creatorPkh: hexToPkh(creator),
    targetSats: BigInt(target),
    deadlineUnix: Number(deadline),
  };
}

export function campaignStatus(raisedSats, targetSats, deadlineUnix, nowUnix = Math.floor(Date.now() / 1000)) {
  const reached = raisedSats >= targetSats;
  const expired = nowUnix >= deadlineUnix;
  return {
    reached, expired,
    state: reached ? (expired ? 'funded-expired' : 'funded') : (expired ? 'failed' : 'live'),
  };
}

// ---------------------------------------------------------------- tx builders
// All builders return a raw signed hex (via TransactionBuilder.build()).
// The caller broadcasts it with chain.submitTransaction().

function p2pkhLockingBytecode(pkh) {
  // OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG
  return Uint8Array.from([
    0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac,
  ]);
}

// Pick smallest-first UTXOs until amount+fee is covered.
function selectUtxos(utxos, needed) {
  const sorted = [...utxos].sort((a, b) => Number(a.satoshis - b.satoshis));
  const picked = [];
  let total = 0n;
  for (const u of sorted) {
    picked.push(u);
    total += u.satoshis;
    if (total >= needed) break;
  }
  if (total < needed) throw new Error(`insufficient funds: have ${total}, need ${needed}`);
  return { picked, total };
}

// Pledge: spend the wallet's P2PKH UTXOs, pay the contract address.
export function buildPledgeTx({ provider, walletUtxos, privKey, walletPkh, contractAddress, amountSats, feeSats = PLEDGE_FEE_SATS }) {
  const needed = BigInt(amountSats) + feeSats;
  const { picked, total } = selectUtxos(walletUtxos, needed);
  const change = total - BigInt(amountSats) - feeSats;
  const changeAddress = pkhToCashaddr(walletPkh);
  const template = new SignatureTemplate(privKey);
  // Plain payment, no contract inputs — skip the library co-spend machinery.
  const builder = new TransactionBuilder({ provider, skipAutomaticCoSpends: true });
  const lock = p2pkhLockingBytecode(walletPkh);
  for (const utxo of picked) {
    builder.addInput(
      { txid: utxo.txid, vout: utxo.vout, satoshis: utxo.satoshis, lockingBytecode: lock },
      template.unlockP2PKH(),
    );
  }
  builder.addOutput({ to: contractAddress, amount: BigInt(amountSats) });
  if (change >= DUST_SATS) builder.addOutput({ to: changeAddress, amount: change });
  builder.setLocktime(0);
  return builder.build();
}

// Payout: spend ALL contract UTXOs to the creator. Only valid if the
// single output pays at least the target (the covenant enforces this);
// once funded, the payout stays possible after the deadline.
export function buildPayoutTx({ provider, contract, contractUtxos, creatorAddress, feeSats = PLEDGE_FEE_SATS }) {
  const total = contractUtxos.reduce((s, u) => s + u.satoshis, 0n);
  const payout = total - feeSats;
  if (payout <= 0n) throw new Error('nothing to pay out after fee');
  const builder = new TransactionBuilder({ provider });
  for (const utxo of contractUtxos) {
    builder.addInput(utxo, contract.unlock.payout());
  }
  builder.addOutput({ to: creatorAddress, amount: payout });
  builder.setLocktime(0);
  return builder.build();
}

// Refund: spend ONE pledge UTXO back to its pledger. Only valid after the
// deadline; the signature proves ownership, the covenant proves the output.
export function buildRefundTx({ provider, contract, pledgeUtxo, pledgerPub, pledgerPriv, pledgerAddress, deadlineUnix, feeSats = PLEDGE_FEE_SATS }) {
  const amount = pledgeUtxo.satoshis - feeSats;
  if (amount <= 0n) throw new Error('pledge too small to refund after fee');
  const builder = new TransactionBuilder({ provider });
  builder.addInput(pledgeUtxo, contract.unlock.refund(pledgerPub, new SignatureTemplate(pledgerPriv)));
  builder.addOutput({ to: pledgerAddress, amount });
  builder.setLocktime(deadlineUnix);
  return builder.build();
}

export { hash160 };
