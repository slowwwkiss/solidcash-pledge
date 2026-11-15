// SolidCash NetworkProvider backed by the HTTPS REST chain layer (src/chain.js).
// Lets the SolidCash SDK (Contract, TransactionBuilder) run against chipnet
// without an Electrum socket — the sandbox blocks Electrum WSS, but the REST
// server speaks plain HTTPS. Implements the provider surface the SDK uses:
// getUtxos / getUtxosForLockingBytecode / getBlockHeight / getRawTransaction /
// sendRawTransaction.
import {
  getUtxos, getBalanceSats, getRawTransactionHex, submitTransaction,
} from './chain.js';
import { decodeCashAddress, encodeCashAddress } from '@bitauth/libauth';
import { bytesToHex, hexToBytes } from './hex.js';

export function lockingBytecodeToCashaddr(lock) {
  const bytes = typeof lock === 'string' ? hexToBytes(lock) : lock;
  const hex = bytesToHex(bytes);
  // P2PKH: 76 a9 14 <20 bytes> 88 ac
  if (hex.startsWith('76a914') && hex.endsWith('88ac') && bytes.length === 25) {
    return encodeCashAddress({
      prefix: 'bchtest', type: 'p2pkh', payload: bytes.slice(3, 23), throwErrors: true,
    }).address;
  }
  // P2SH20: a9 14 <20 bytes> 87
  if (hex.startsWith('a914') && hex.endsWith('87') && bytes.length === 23) {
    return encodeCashAddress({
      prefix: 'bchtest', type: 'p2sh', payload: bytes.slice(2, 22), throwErrors: true,
    }).address;
  }
  // P2SH32: <32-byte hash> OP_HASH256 ... — not used by SolidPledge; fail loudly.
  throw new Error(`cannot map locking bytecode to an address: ${hex.slice(0, 60)}`);
}

export function cashaddrToLockingBytecode(address) {
  const decoded = decodeCashAddress(address);
  if (typeof decoded === 'string') throw new Error(`bad cashaddr: ${decoded}`);
  return decoded.payload; // raw hash bytes; type tells P2PKH vs P2SH
}

export class RestNetworkProvider {
  // The SolidCash SDK's Network enum calls chipnet "chipnet" (not "testnet"):
  // with any other value the SDK derives mainnet-prefixed addresses.
  network = 'chipnet';
  walletId = null; // any valid walletId; used only as the broadcast identity
  _height = 0;

  constructor(opts = {}) {
    if (opts.walletId) this.walletId = opts.walletId;
    if (opts.heightHint) this._height = opts.heightHint;
  }

  setWalletId(walletId) { this.walletId = walletId; }

  async getUtxos(address) {
    const list = await getUtxos(address);
    for (const u of list) if (u.height > this._height) this._height = u.height;
    return list.map((u) => ({
      txid: u.txid, vout: u.vout, satoshis: u.satoshis,
    }));
  }

  async getUtxosForLockingBytecode(lockingBytecode) {
    const address = lockingBytecodeToCashaddr(lockingBytecode);
    const list = await this.getUtxos(address);
    // Every UTXO returned sits at exactly this locking bytecode.
    const bytes = typeof lockingBytecode === 'string'
      ? hexToBytes(lockingBytecode)
      : lockingBytecode;
    return list.map((u) => ({ ...u, lockingBytecode: bytes }));
  }

  async getBalance(address) {
    return getBalanceSats(address);
  }

  async getBlockHeight() {
    return this._height;
  }

  async getRawTransaction(txid) {
    return getRawTransactionHex(txid);
  }

  async sendRawTransaction(txHex) {
    if (!this.walletId) {
      throw new Error('RestNetworkProvider.sendRawTransaction: set a walletId first (any valid walletId works — it is only the broadcast identity).');
    }
    return submitTransaction(this.walletId, txHex);
  }
}
