# Operator Runbook: Devnet RWT Faucet

## Summary

The RWT Faucet (`POST /faucet/rwt`) drips test-RWT to wallets on Areal Devnet. It enforces a 24-hour per-wallet rate limit and automatically airdrops 0.05 SOL to zero-balance wallets to cover transaction fees. The endpoint is **hard-gated to devnet/localnet only** — it returns 404 on mainnet.

Unlike the USDC faucet, this faucet does **NOT** mint new tokens. The RWT mint authority lives on-chain in the RWT engine PDA. Instead, the faucet performs an SPL **Transfer** from a pre-funded treasury ATA owned by the devnet deployer (`8ddRxwGnC1MD5ZCf22eLAne77Rput8itQbTjMr93xYvq`). The treasury must be manually topped up periodically.

---

## Endpoint

```
POST https://api.areal.finance/faucet/rwt
Content-Type: application/json

{ "wallet": "<base58 pubkey>", "amount": 100 }
```

- **Default amount:** 100 RWT
- **Hard ceiling per request:** 1,000 RWT
- **Per-wallet rate limit:** 1 claim per 24 hours
- **SOL airdrop to zero-balance wallets:** 0.05 SOL
- **RWT decimals:** 6 (amounts in whole RWT, not micro-RWT)

---

## Prerequisites Checklist

- [ ] Devnet RPC reachable (Helius or `api.devnet.solana.com`)
- [ ] `solana` CLI installed and in PATH
- [ ] Deployer keypair file available at `keys/devnet/deployer.json` (or equivalent)
- [ ] SOL funder keypair file available (may be the deployer keypair on devnet)
- [ ] Deployer's RWT ATA pre-funded (see Step 4 below)

---

## Step 1: Generate `FAUCET_RWT_TREASURY_KEYPAIR_B64`

The treasury keypair must be the **owner** of the pre-funded RWT ATA (`78xAMq2cGKMumgDoAHiHJZxC3MD55Q1qEEiyQPvoLoMc`). On devnet today this is the deployer (`8ddRxwGnC1MD5ZCf22eLAne77Rput8itQbTjMr93xYvq`).

**Command:**
```bash
node -e "process.stdout.write(Buffer.from(JSON.parse(require('fs').readFileSync(process.argv[1]))).toString('base64'))" keys/devnet/deployer.json
```

**Verify length (must be exactly 64 bytes):**
```bash
echo "<output from above>" | base64 -d | wc -c
# Must print: 64
```

**Copy the output** — this is the value for `FAUCET_RWT_TREASURY_KEYPAIR_B64`.

---

## Step 2: Generate `FAUCET_SOL_FUNDER_KEYPAIR_B64`

The funder keypair pays SOL transaction fees and airdrops SOL to wallets with zero balance. You can reuse the deployer keypair for the funder on devnet (single-signer bootstrap), but a dedicated keypair is preferred long-term to limit blast radius if either leaks.

```bash
node -e "process.stdout.write(Buffer.from(JSON.parse(require('fs').readFileSync(process.argv[1]))).toString('base64'))" keys/devnet/deployer.json
```

**Verify length (must be exactly 64 bytes):**
```bash
echo "<output from above>" | base64 -d | wc -c
# Must print: 64
```

---

## Step 3: Inject Env Vars on the VPS

SSH into the Beget VPS and append the keypair env vars to the backend `.env` file:

```
/opt/areal-devnet/areal.newera/backend/.env
```

Append:
```
FAUCET_RWT_TREASURY_KEYPAIR_B64=<output of Step 1>
FAUCET_RWT_TREASURY=8ddRxwGnC1MD5ZCf22eLAne77Rput8itQbTjMr93xYvq
FAUCET_SOL_FUNDER_KEYPAIR_B64=<output of Step 2>
```

**Do NOT commit these values to git.** The `.env.devnet` template in the repo carries placeholders only.

Restart the backend container:
```bash
cd /opt/areal-devnet/areal.newera
docker compose -f docker-compose.devnet.yml up -d areal-backend-devnet
```

---

## Step 4: Top Up the RWT Treasury ATA

The treasury ATA at `78xAMq2cGKMumgDoAHiHJZxC3MD55Q1qEEiyQPvoLoMc` must hold enough RWT to serve drips. Each claim transfers 100 RWT (default), so 100 claims = 10,000 RWT consumed.

**Check current balance:**
```bash
solana --url https://api.devnet.solana.com balance \
  --token AFfBWsDEk4iMWcMbLwqXj4yNrgEPNRCdJn5XG1Fw6F77 \
  8ddRxwGnC1MD5ZCf22eLAne77Rput8itQbTjMr93xYvq
```

Or via raw ATA:
```bash
spl-token account-info \
  --url https://api.devnet.solana.com \
  78xAMq2cGKMumgDoAHiHJZxC3MD55Q1qEEiyQPvoLoMc
```

**Top up via the existing helper script** (run from a workstation that holds the deployer keypair):
```bash
tsx scripts/lib/devnet-mint-rwt-faucet-treasury.ts
```

This script mints additional RWT into the deployer's treasury ATA using the on-chain RWT engine PDA's mint authority (it is allowed to call the engine's mint instruction because the deployer is the engine admin).

**Threshold:** consider alerting when treasury balance drops below 5,000 RWT (~50 claims of headroom).

---

## Step 5: Verify Boot Logs

After redeploy, tail the backend logs:
```bash
ssh vps-vpn 'docker logs -f areal-backend-devnet'
```

Look for:
```
[FaucetModule] Faucet RWT treasury loaded: 8ddRxwGnC1MD5ZCf22eLAne77Rput8itQbTjMr93xYvq
[FaucetModule] Faucet SOL funder loaded: <FUNDER_PUBKEY>
```

**Treasury pubkey MUST be exactly `8ddRxwGnC1MD5ZCf22eLAne77Rput8itQbTjMr93xYvq`** (or whatever `FAUCET_RWT_TREASURY` env var is set to). If it differs, the wrong keypair was pasted — **STOP**, redo Step 1, and redeploy.

If either env var is missing or malformed, the container will crash-loop with:
```
Invalid FAUCET_RWT_TREASURY keypair env var (length=...)
```
or
```
FAUCET_RWT_TREASURY pubkey mismatch: expected ..., got ... — refusing to boot
```

---

## Step 6: Smoke Test

**Claim test-RWT for a wallet you control:**
```bash
curl -X POST https://api.areal.finance/faucet/rwt \
  -H "content-type: application/json" \
  -d '{"wallet":"<TEST_WALLET_BASE58>"}'
```

**Expected response (200 OK):**
```json
{
  "success": true,
  "signature": "<base58 tx sig>",
  "ata": "<recipient RWT ATA>",
  "amount": 100
}
```

**Rate-limit test — claim again immediately (should get 429):**
```bash
curl -X POST https://api.areal.finance/faucet/rwt \
  -H "content-type: application/json" \
  -d '{"wallet":"<TEST_WALLET_BASE58>"}'
```

**Expected response (429 Too Many Requests):**
```json
{
  "retryAfterSec": 86400
}
```

**Verify on-chain (treasury balance dropped by 100 RWT, recipient received 100 RWT):**
```bash
spl-token account-info --url https://api.devnet.solana.com 78xAMq2cGKMumgDoAHiHJZxC3MD55Q1qEEiyQPvoLoMc
spl-token account-info --url https://api.devnet.solana.com <RECIPIENT_RWT_ATA>
```

---

## Operational Notes

### Daily Monitoring
- Check treasury balance weekly. Top up via `scripts/lib/devnet-mint-rwt-faucet-treasury.ts` when below 5,000 RWT.
- Check SOL funder balance weekly. Top up via devnet faucet when below 1 SOL.

### Manual Rate-Limit Bypass (Rare)
If a wallet's 24-hour cooldown must be cleared for test recovery, connect to the backend Redis and delete the rate-limit key:
```bash
redis-cli -h <REDIS_HOST> -p <REDIS_PORT> DEL faucet:rwt:claimed:<WALLET_BASE58>
```

### Endpoint Behavior on Other Clusters
- **Devnet/Localnet:** Fully operational (assuming env vars + treasury are configured).
- **Mainnet:** `POST /faucet/rwt` returns **404 Not Found**. No special action needed when deploying to mainnet — the guard is automatic.

### Treasury Owner Rotation (Advanced)
If the treasury owner is rotated (e.g., new deployer keypair after a reset), update:
1. `FAUCET_RWT_TREASURY_KEYPAIR_B64` with the new keypair's base64
2. `FAUCET_RWT_TREASURY` with the new pubkey
3. Re-create the treasury ATA under the new owner and top it up
4. Redeploy backend

There is no way to bypass the keypair pubkey check — if `FAUCET_RWT_TREASURY_KEYPAIR_B64` does not decode to `FAUCET_RWT_TREASURY`, the container will fail to boot.

---

## Security Do-NOTs

- **Do NOT commit the env values to git.** They are secrets and belong in `.env` only.
- **Do NOT paste or echo the base64 keypairs in shared chat, tickets, or logs.** Treat them as private keys.
- **Do NOT reuse the devnet treasury keypair on mainnet.** Mainnet has no RWT faucet — the guard 404s the route — but reused secrets across clusters are a known footgun.
- **Do NOT skip the `wc -c` length check in Steps 1–2.** A wrong-format input will silently decode to garbage and crash boot with an unhelpful length mismatch.

---

## See Also

- `OPERATOR-RUNBOOK-FAUCET.md` — sibling USDC faucet (localnet only)
- Faucet source: `src/modules/faucet/`
- RWT mint (devnet): `AFfBWsDEk4iMWcMbLwqXj4yNrgEPNRCdJn5XG1Fw6F77`
- Treasury ATA (devnet): `78xAMq2cGKMumgDoAHiHJZxC3MD55Q1qEEiyQPvoLoMc`
- Treasury owner / deployer (devnet): `8ddRxwGnC1MD5ZCf22eLAne77Rput8itQbTjMr93xYvq`
- Devnet RPC: `https://api.devnet.solana.com` (or Helius devnet)
