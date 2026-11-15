# DoraHacks Submission Draft — Best SolidCash Application (BCH BLAZE 2026)

> DRAFT — do not submit yet. Repo to be created as `solidcash-pledge`
> (intended: https://github.com/slowwwkiss/solidcash-pledge). Submit via the
> BCH BLAZE 2026 DoraHacks page before **22 Nov 2026 21:00 WIB**.

## Project name
**SolidPledge**

## One-liner
Flipstarter-style assurance pledges on Bitcoin Cash: fund it together — or nobody pays at all.

## Problem
Crowdfunding on BCH today means trusting a person or a multisig with the
money. If the campaign fails, refunds depend on someone's goodwill; if it
succeeds, the payout depends on someone pressing the right button. There is
no trust-minimized way to say "this money moves only if the goal is met,
otherwise it comes back to me."

## Solution
SolidPledge is a covenant contract with exactly two exits, enforced on-chain:

- **Payout** — anyone can release the funds to the creator, but only as a single output paying the creator at least the target. An unfunded campaign can never pay out.
- **Refund** — after the deadline, each pledger reclaims their own UTXO to their own address. Before the deadline, no refund is possible, so a funded campaign cannot be drained early.

A campaign needs no deployment transaction: its P2SH address is derived
from (creator, target, deadline), pledges are plain P2SH payments, and the
share link carries the parameters (`#/campaign?...`) so anyone can open a
campaign and watch it fill live.

## How it uses SolidCash
- Contract written in SolidCash (`contracts/SolidPledge.scash`), compiled with `solidc` (`@solidcash/solidc`), artifact `artifacts/SolidPledge.json` (~106 bytes of bytecode).
- App builds/signs with the SolidCash SDK (`@solidcash/solidcash`: `Contract`, `TransactionBuilder`, `SignatureTemplate`) over a custom `RestNetworkProvider` that speaks HTTPS instead of Electrum.
- 11 mock-network tests (`@solidcash/testing`, vitest): payout at/below target, wrong recipient, extra outputs, refund before/after deadline, wrong signer, independent refunds — **11/11 pass**.

## How it uses Cashonize Smart Wallet
- The in-browser wallet is `@cashonize/bch-wallet-lib` — the engine that powers the Cashonize Smart Wallet app. The demo wallet is an HD wallet (`m/44'/145'/0'/0/0`); its 12-word backup phrase imports directly into the Cashonize app.
- Key derivation is cross-checked: the address the app derives with libauth matches the address the Cashonize wallet reports (verified in the E2E run).

## Pledge / Pay proof (real chipnet transactions, 15 Nov 2026)
Both paths proven on-chain, not mocked (full log: `tools/chipnet-e2e-results.json`):

- **Payout** — campaign `bchtest:pv5rzjzqfq9sp94mdlmkf72f6enevv4ptqqx6kwzmddacmd69vamu9arntyll` (target 5,000 sat): two 3,500-sat pledges, payout tx [`e2b182d309a54fa10654bf13873672c35eb9e9d3f55f1b7e38da223510c611ed`](https://blockchair.com/bitcoin-cash/testnet/transaction/e2b182d309a54fa10654bf13873672c35eb9e9d3f55f1b7e38da223510c611ed) paid the creator 6,000 sat.
- **Refund** — campaign `bchtest:pvn3djmclj8rnxqm8jlq9stnjtxgzy43ckj9wej73lpwfuhyhn8x72rnmnydd` (target 50,000 sat, deadline passed): pledge 3,500 sat, refund tx [`ea92cd20f2da90edbe8dbb83a671a9a2a43f45f93e18f4b46b49c327a3d1628b`](https://blockchair.com/bitcoin-cash/testnet/transaction/ea92cd20f2da90edbe8dbb83a671a9a2a43f45f93e18f4b46b49c327a3d1628b) returned 2,500 sat to the pledger; 0 UTXOs left in the contract.

## Demo
- Live demo (GitHub Pages, `docs/` build): `<repo-pages-url>` (after the repo is created + Pages enabled from `docs/`).
- Walkthrough video: `artifacts/demo-walkthrough.webm` (+ screenshots `artifacts/01-home.png` … `04-faucet-attempt.png`).
- Try it: open the demo → **Create demo wallet** → **Get free testnet BCH** (faucet) → **Create campaign** → share the link → **Pledge**.

## Tech stack
Vite static SPA · SolidCash 0.50.x · `@cashonize/bch-wallet-lib` 0.3.2 · libauth · mainnet-js REST (HTTPS chain access) · chipnet only, no mainnet.

## Honest limits (stated in README too)
- In the build sandbox, the headless browser cannot reach any external HTTPS (egress proxy refuses its tunnels), so in-browser faucet/pledge were verified via the Node E2E using the identical `src/` modules; on a normal network they run in the browser.
- Electrum WSS is blocked in the sandbox; the wallet's background discovery fails there (expected), while creation/derivation/signing work. Live Electrum sync works on a normal network.
- Chipnet blocks are ~10 minutes apart; the app shows unconfirmed pledges immediately.

## Links
- Repo: https://github.com/slowwwkiss/solidcash-pledge (to be created)
- Contract: `contracts/SolidPledge.scash` in the repo
- SolidCash: https://github.com/solidcash/solidcash
- Cashonize: https://cashonize.com
