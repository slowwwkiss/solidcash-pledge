import { hash160 } from '@solidcash/utils';
import {
  deriveHdPrivateNodeFromSeed,
  deriveHdPath,
  secp256k1,
  encodeCashAddress,
  deriveSeedFromBip39Mnemonic,
} from '@bitauth/libauth';

// Fixed test keys (test mnemonic only — never real funds).
const seed = deriveSeedFromBip39Mnemonic('SolidPledge test keys');
const rootNode = deriveHdPrivateNodeFromSeed(seed, { assumeValidity: true, throwErrors: true });
const base = "m/44'/145'/0'/0";

function keyAt(index) {
  const node = deriveHdPath(rootNode, `${base}/${index}`);
  if (typeof node === 'string') throw new Error('key derivation failed');
  const pub = secp256k1.derivePublicKeyCompressed(node.privateKey);
  const pkh = hash160(pub);
  const address = encodeCashAddress({
    prefix: 'bchtest', type: 'p2pkhWithTokens', payload: pkh, throwErrors: true,
  }).address;
  return { priv: node.privateKey, pub, pkh, address };
}

export const alice = keyAt(0); // campaign creator
export const bob = keyAt(1);   // pledger 1
export const carol = keyAt(2); // pledger 2
