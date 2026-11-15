// Cashonize Smart Wallet integration for SolidPledge.
//
// The wallet engine is @cashonize/bch-wallet-lib — the library that powers
// the Cashonize Smart Wallet app (continued from mainnet-js). The app keeps
// one HD wallet (chipnet) in the browser: its mnemonic is shown once for
// backup and can be imported into the Cashonize app itself, since it is the
// same engine and the same derivation (m/44'/145'/0'/0/i).
//
// Chain reads and broadcasts do NOT go through the lib's Electrum provider
// here: this sandbox blocks Electrum WebSockets. Instead the app reads the
// chain over HTTPS (src/chain.js) and builds/signs transactions locally
// with the SolidCash SDK + libauth. On a normal network the same wallet
// object can also use Electrum directly (wallet.getBalance() / wallet.send()).
import { BaseWallet, HDWallet } from '@cashonize/bch-wallet-lib';
import { IndexedDBProvider } from '@cashonize/bch-wallet-lib/indexeddb';
import {
  deriveSeedFromBip39Mnemonic,
  deriveHdPrivateNodeFromSeed,
  deriveHdPath,
  secp256k1,
  hash160,
  encodeCashAddress,
} from '@bitauth/libauth';

export const DEMO_WALLET_NAME = 'solidpledge-demo';
export const DERIVATION_BASE = "m/44'/145'/0'";

let storageReady = false;

export function useBrowserStorage() {
  if (!storageReady) {
    BaseWallet.StorageProvider = IndexedDBProvider;
    storageReady = true;
  }
}

// Get (or create) the stored demo wallet on chipnet.
export async function getOrCreateDemoWallet() {
  useBrowserStorage();
  return HDWallet.named(DEMO_WALLET_NAME, { network: 'testnet' });
}

// Fresh random chipnet wallet (in-memory; caller stores the mnemonic).
export async function createRandomWallet() {
  return HDWallet.newRandom(undefined, { network: 'testnet' });
}

// Restore a wallet from a mnemonic (chipnet).
export async function walletFromMnemonic(mnemonic) {
  return HDWallet.fromId(`hd:testnet:${mnemonic}`, { network: 'testnet' });
}

// Derive the private key / pubkey / pkh / address for a deposit index of a
// mnemonic — the same key the Cashonize HD wallet uses for that address.
// Lets the app sign pledge/refund transactions locally with libauth.
export function deriveDepositKey(mnemonic, index = 0) {
  const seed = deriveSeedFromBip39Mnemonic(mnemonic);
  const root = deriveHdPrivateNodeFromSeed(seed, { assumeValidity: true, throwErrors: true });
  const node = deriveHdPath(root, `${DERIVATION_BASE}/0/${index}`);
  if (typeof node === 'string') throw new Error(`key derivation failed: ${node}`);
  const privKey = node.privateKey;
  const pub = secp256k1.derivePublicKeyCompressed(privKey);
  const pkh = hash160(pub);
  const address = encodeCashAddress({
    prefix: 'bchtest', type: 'p2pkh', payload: pkh, throwErrors: true,
  }).address;
  return { privKey, pub, pkh, address };
}

// The walletId the mainnet-js REST server expects for a seed wallet, so the
// app can broadcast a locally-built transaction through it.
export function restSeedWalletId(mnemonic, index = 0) {
  return `seed:testnet:${mnemonic}:${DERIVATION_BASE}/0/${index}`;
}
