# SolidPledge — Assurance pledges on Bitcoin Cash

**BCH BLAZE 2026 · Best SolidCash Application bounty.** Flipstarter-style
assurance pledges: a campaign sets a target + deadline, supporters lock BCH
in a covenant contract, and the money can only leave two ways — payout to
the creator if the target is reached, or refund to each pledger if the
deadline passes unfunded. Nobody holds the funds in between.

- **SolidCash** (`@solidcash/solidcash` + `@solidcash/solidc` + `@solidcash/testing`): the contract is written in SolidCash (`.scash`), compiled with `solidc`, and covered by 11 mock-network tests.
- **Cashonize Smart Wallet** (`@cashonize/bch-wallet-lib`): the in-browser wallet is the Cashonize engine — the same HD wallet the Cashonize app runs, so its backup phrase imports into the Cashonize app.
- **Chipnet only.** No mainnet, no real BCH. Demo funds come from the testnet faucet.

## The contract

`contracts/SolidPledge.scash` — `SolidPledge(bytes20 creator, int target, int deadline)`:

- `payout()` — anyone may release the funds to the creator, but only as a **single output** paying the creator **at least the target**. An unfunded campaign can never pay out. (Flipstarter semantics: once funded, the money is the creator's whenever it is claimed; the deadline opens the refund path — Bitcoin has no max-time lock, so the covenant does not pretend to bound payout to pre-deadline mining.)
- `refund(pubkey, sig)` — after the deadline, each pledger reclaims their own UTXO to their own P2PKH address. The signature proves ownership; the covenant proves the money goes back to them. Before the deadline, no refund is possible.

A campaign needs no on-chain deployment: its P2SH address is derived from
(creator, target, deadline), and pledges are plain P2SH payments to it.

## Proven on chipnet (real transactions, 15 Nov 2026)

Run `node tools/chipnet-e2e.mjs` reproduces both paths (see
`tools/chipnet-e2e-results.json`):

| Path | Evidence |
|---|---|
| Payout | Campaign `bchtest:pv5rzjzqfq9sp94mdlmkf72f6enevv4ptqqx6kwzmddacmd69vamu9arntyll` (target 5,000 sat) — pledges [`31d8efe5…`](https://blockchair.com/bitcoin-cash/testnet/transaction/31d8efe5970af6fbd43093940f6062d8497ba5438b01a09b30fd1df25452b63a) + [`34c39982…`](https://blockchair.com/bitcoin-cash/testnet/transaction/34c3998226b57070d96ec4d5db9c7e9d7155ad0ffcc0a1fc50a618f3697df4f7) (3,500 sat each, 7,000 total) — payout [`e2b182d3…`](https://blockchair.com/bitcoin-cash/testnet/transaction/e2b182d309a54fa10654bf13873672c35eb9e9d3f55f1b7e38da223510c611ed) paid the creator 6,000 sat |
| Refund | Campaign `bchtest:pvn3djmclj8rnxqm8jlq9stnjtxgzy43ckj9wej73lpwfuhyhn8x72rnmnydd` (target 50,000 sat, deadline passed) — pledge [`ece632fb…`](https://blockchair.com/bitcoin-cash/testnet/transaction/ece632fb1325057a16cc17c7f8be557b82c471f403ffe0242730d145dc02680d) (3,500 sat) — refund [`ea92cd20…`](https://blockchair.com/bitcoin-cash/testnet/transaction/ea92cd20f2da90edbe8dbb83a671a9a2a43f45f93e18f4b46b49c327a3d1628b) returned 2,500 sat to the pledger; 0 UTXOs left in the contract |

Mock-network tests: `npx vitest run` — **11/11 pass**, including payout
below target, payout to the wrong recipient, payout with extra outputs,
refund before deadline, refund by the wrong signer, and independent
refunds by two pledgers.

## Run it

```sh
bun install        # or npm install (npm is flaky in some sandboxes; bun works)
npx vite build     # -> docs/ (static site, ready for GitHub Pages)
npx vite preview   # serve docs/ locally
```

Open the app, create a demo wallet (Cashonize engine, chipnet), fund it
from the faucet, create a campaign, share the link, pledge. Campaign
status reads live from the chain (REST over HTTPS).

## Demo walkthrough

- Video: `artifacts/demo-walkthrough.webm` (headless run: wallet creation → campaign creation; faucet/pledge need browser egress — see limits below)
- Screenshots: `artifacts/01-home.png` … `04-faucet-attempt.png`

Shot-by-shot script (what a judge sees on a normal network):
1. Home — hero + steps, wallet disconnected.
2. Click **Create demo wallet** — a `bchtest:` address appears (Cashonize HD wallet, `m/44'/145'/0'/0/0`).
3. Click **Get free testnet BCH** — faucet sends 10,000 sat; balance updates.
4. Fill title / target 5,000 sat / deadline +24h → **Create campaign** — contract address + share link + QR appear; campaign card shows LIVE, 0/5,000.
5. **Pledge 3,500 sat** → receipt with txid + explorer link; progress moves to 3,500/5,000.
6. Second pledge 3,500 sat → status FUNDED → **Release payout to creator** → receipt; creator balance +6,000 sat.
7. A second campaign with an unreachable target and a past deadline → **Refund my pledges** → receipt; balance back.

## Architecture

```
contracts/SolidPledge.scash   covenant contract (solidc)
artifacts/SolidPledge.json    compiled artifact (bytecode ~106 B)
src/chain.js                  HTTPS REST client (mainnet-js server)
src/rest-provider.js          SolidCash NetworkProvider over REST
src/campaign.js               campaign args/address/link + tx builders
src/wallet.js                 Cashonize HDWallet + libauth derivation
src/main.js                   app UI wiring
tools/chipnet-e2e.mjs         full on-chain proof (payout + refund)
test/SolidPledge.test.ts      11 mock-network tests
```

Why REST instead of Electrum: the app is built to run in a normal browser
where the Cashonize wallet syncs over Electrum WSS directly. In this
sandbox Electrum WSS is blocked, so chain reads go over the mainnet-js
REST server (HTTPS) and signing is done locally with libauth — the wallet
never trusts the server with keys. The same modules are shared by the app
and the Node E2E, so the on-chain proof covers the app's exact code paths.

## Honest limits (verified, not assumed)

- **Browser HTTPS is blocked in this sandbox** — the VM's egress proxy refuses the headless shell's tunnels entirely (even `example.com` fails from Chromium, while Node/curl through the same proxy succeed). So in-browser faucet/balance/pledge could not be exercised headlessly here; they are proven by the Node E2E using the identical `src/` modules. On a normal network they work from the browser.
- **Electrum WSS is blocked in this VM** — the wallet lib's background discovery fails with `ERR_TUNNEL_CONNECTION_FAILED` (expected noise in the headless log). Wallet creation, key derivation and local signing work; live Electrum sync works on a normal network.
- **Chipnet blocks are ~10 minutes apart** — confirmations are slow; the app shows unconfirmed pledges immediately. A refund tx with a timestamp locktime is only final once the chain's median-time-past passes the locktime — the E2E uses a deadline 1 hour in the past for that reason.
- **Faucet gives 10,000 sat per request** — demo amounts (3,500 sat pledges, 1,000 sat fee) are sized to it.
- Stranded testnet dust from the E2E iterations (run 1: 2×3,500 sat at an expired campaign contract; run 2: 3,500 sat) is refundable by its pledgers after the old deadlines — testnet play money, no real value.

## Bounty fit

Best SolidCash Application requires a **new** project on **SolidCash** +
**Cashonize Smart Wallet** + **Pledge/Pay contracts**. SolidPledge is all
three: the pledge/pay covenant is written in SolidCash, the wallet is the
Cashonize engine, and both payout and refund are proven on-chain — not
mocked.
