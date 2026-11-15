// SolidPledge contract tests on the SolidCash mock network.
// Run: npm test   (vitest)
import artifact from '../artifacts/SolidPledge.json' with { type: 'json' };
import {
  Contract, SignatureTemplate, TransactionBuilder, randomUtxo,
} from '@solidcash/solidcash';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import '@solidcash/solidcash/vitest';
import { alice, bob, carol } from './keys.js';
import { buildPledgeTx } from '../src/campaign.js';
import { deriveDepositKey } from '../src/wallet.js';

const TARGET = 5000n;
const DEADLINE = 1_800_000_000; // Unix timestamp (2027) — far future on purpose
const FEE = 1000n;

function freshContract() {
  const provider = new MockNetworkProvider();
  const contract = new Contract(
    artifact,
    [alice.pkh, TARGET, BigInt(DEADLINE)],
    { provider },
  );
  return { provider, contract };
}

function pledgeUtxo(provider, contract, satoshis) {
  const utxo = randomUtxo({ satoshis });
  provider.addUtxo(contract.address, utxo);
  return utxo;
}

describe('SolidPledge — payout()', () => {
  it('pays the creator when pledges reach the target before the deadline', async () => {
    const { provider, contract } = freshContract();
    const u1 = pledgeUtxo(provider, contract, 3000n);
    const u2 = pledgeUtxo(provider, contract, 3000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(u1, contract.unlock.payout())
      .addInput(u2, contract.unlock.payout())
      .addOutput({ to: alice.address, amount: 6000n - FEE })
      .setLocktime(0);
    await expect(tx).not.toFailRequire();
  });

  it('fails when pledges are below the target', async () => {
    const { provider, contract } = freshContract();
    const u1 = pledgeUtxo(provider, contract, 3000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(u1, contract.unlock.payout())
      .addOutput({ to: alice.address, amount: 3000n - FEE })
      .setLocktime(0);
    await expect(tx).toFailRequire();
  });

  it('stays possible after the deadline (gated by amount, not time)', async () => {
    // Flipstarter semantics: once funded, the money is the creator's
    // whenever it is claimed; the deadline only opens the refund path.
    // (A locktime check cannot bound payout to pre-deadline mining —
    // Bitcoin has no max-time lock — so the covenant does not pretend to.)
    const { provider, contract } = freshContract();
    const u1 = pledgeUtxo(provider, contract, 3000n);
    const u2 = pledgeUtxo(provider, contract, 3000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(u1, contract.unlock.payout())
      .addInput(u2, contract.unlock.payout())
      .addOutput({ to: alice.address, amount: 6000n - FEE })
      .setLocktime(0);
    await expect(tx).not.toFailRequire();
  });

  it('fails when the payout goes to anyone but the creator', async () => {
    const { provider, contract } = freshContract();
    const u1 = pledgeUtxo(provider, contract, 3000n);
    const u2 = pledgeUtxo(provider, contract, 3000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(u1, contract.unlock.payout())
      .addInput(u2, contract.unlock.payout())
      .addOutput({ to: bob.address, amount: 6000n - FEE })
      .setLocktime(0);
    await expect(tx).toFailRequire();
  });

  it('fails when the payout tries to split the funds across extra outputs', async () => {
    const { provider, contract } = freshContract();
    const u1 = pledgeUtxo(provider, contract, 3000n);
    const u2 = pledgeUtxo(provider, contract, 3000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(u1, contract.unlock.payout())
      .addInput(u2, contract.unlock.payout())
      .addOutput({ to: alice.address, amount: TARGET })
      .addOutput({ to: bob.address, amount: 6000n - TARGET - FEE })
      .setLocktime(0);
    await expect(tx).toFailRequire();
  });
});

describe('SolidPledge — refund()', () => {
  it('refunds the pledger after the deadline', async () => {
    const { provider, contract } = freshContract();
    const u1 = pledgeUtxo(provider, contract, 3000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(u1, contract.unlock.refund(bob.pub, new SignatureTemplate(bob.priv)))
      .addOutput({ to: bob.address, amount: 3000n - FEE })
      .setLocktime(DEADLINE);
    await expect(tx).not.toFailRequire();
  });

  it('fails before the deadline', async () => {
    const { provider, contract } = freshContract();
    const u1 = pledgeUtxo(provider, contract, 3000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(u1, contract.unlock.refund(bob.pub, new SignatureTemplate(bob.priv)))
      .addOutput({ to: bob.address, amount: 3000n - FEE })
      .setLocktime(0);
    await expect(tx).toFailRequire();
  });

  it('fails when the refund goes to someone else', async () => {
    const { provider, contract } = freshContract();
    const u1 = pledgeUtxo(provider, contract, 3000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(u1, contract.unlock.refund(bob.pub, new SignatureTemplate(bob.priv)))
      .addOutput({ to: carol.address, amount: 3000n - FEE })
      .setLocktime(DEADLINE);
    await expect(tx).toFailRequire();
  });

  it('fails when the signature is not the pledger’s', async () => {
    const { provider, contract } = freshContract();
    const u1 = pledgeUtxo(provider, contract, 3000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(u1, contract.unlock.refund(bob.pub, new SignatureTemplate(carol.priv)))
      .addOutput({ to: bob.address, amount: 3000n - FEE })
      .setLocktime(DEADLINE);
    await expect(tx).toFailRequire();
  });

  it('lets a second pledger refund their own UTXO independently', async () => {
    const { provider, contract } = freshContract();
    const u1 = pledgeUtxo(provider, contract, 3000n);
    const u2 = pledgeUtxo(provider, contract, 4000n);
    const tx = new TransactionBuilder({ provider })
      .addInput(u2, contract.unlock.refund(carol.pub, new SignatureTemplate(carol.priv)))
      .addOutput({ to: carol.address, amount: 4000n - FEE })
      .setLocktime(DEADLINE);
    await expect(tx).not.toFailRequire();
    void u1;
  });
});

describe('SolidPledge — buildPledgeTx (P2PKH funding)', () => {
  it('builds a signed pledge transaction to the contract address', async () => {
    const provider = new MockNetworkProvider();
    const contract = new Contract(
      artifact,
      [alice.pkh, TARGET, BigInt(DEADLINE)],
      { provider },
    );
    // A fresh wallet key (same derivation the app uses) + a fake 10k UTXO.
    const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const key = deriveDepositKey(mnemonic, 0);
    const funding = randomUtxo({ satoshis: 10_000n });
    const hex = buildPledgeTx({
      provider,
      walletUtxos: [funding],
      privKey: key.privKey,
      walletPkh: key.pkh,
      contractAddress: contract.address,
      amountSats: 3000n,
    });
    expect(typeof hex).toBe('string');
    expect(hex.length).toBeGreaterThan(100);
    // The encoded tx must pay the contract and return change to the wallet.
    const { decodeTransaction } = await import('@bitauth/libauth');
    const decoded = decodeTransaction(Uint8Array.from(Buffer.from(hex, 'hex')));
    expect(decoded.outputs.length).toBe(2);
    const values = decoded.outputs.map((o) => o.valueSatoshis).sort((a, b) => Number(a - b));
    expect(values).toEqual([3000n, 6000n]); // pledge + change (10k - 3k - 1k fee)
  });
});
