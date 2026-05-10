# Operator Runbook: Testnet USDC Faucet

## Summary

The USDC Faucet (`POST /faucet/usdc`) drips test-USDC to wallets on Areal Testnet (localnet). It enforces a 24-hour per-wallet rate limit and automatically airdrops 0.05 SOL to zero-balance wallets to cover transaction fees. The endpoint is **hard-gated to localnet only** — it returns 404 on devnet and mainnet.

---

## Prerequisites Checklist

- [ ] Areal Testnet validator reachable at `https://rpc.areal.finance`
- [ ] `solana` CLI installed and in PATH
- [ ] Authority keypair file available (local maintainer laptop, e.g., `data/init-deployer.json`)
- [ ] Fresh SOL funder keypair file OR existing funder keypair with pubkey on hand

---

## Step 1: Generate `FAUCET_USDC_AUTHORITY_KEYPAIR_B64`

The authority keypair must be the signer of the localnet test-USDC mint (`F9NVj8dFsqxbCfytfmrEWDjdDhmpV1YrjRuxiusGr9Ys`).

**Command:**
```bash
node -e "const fs=require('fs'); const a=JSON.parse(fs.readFileSync(process.argv[1])); process.stdout.write(Buffer.from(a).toString('base64'))" /path/to/init-deployer.json
```

Replace `/path/to/init-deployer.json` with the actual path to your authority keypair (Solana CLI JSON array format).

**Verify length (must be exactly 64 bytes):**
```bash
echo "<output from above>" | base64 -d | wc -c
# Must print: 64
```

**Copy the output** — this is the value for `FAUCET_USDC_AUTHORITY_KEYPAIR_B64`.

---

## Step 2: Generate `FAUCET_SOL_FUNDER_KEYPAIR_B64`

The funder keypair pays transaction fees and airdrops SOL to wallets with zero balance. Use a **separate keypair** from the authority to limit blast radius if either leaks.

**Option A: Use existing funder keypair**
```bash
node -e "const fs=require('fs'); const a=JSON.parse(fs.readFileSync(process.argv[1])); process.stdout.write(Buffer.from(a).toString('base64'))" /path/to/faucet-funder.json
```

**Option B: Generate a fresh funder keypair**
```bash
solana-keygen new -o /tmp/faucet-funder.json --no-bip39-passphrase
```

Then run the same conversion:
```bash
node -e "const fs=require('fs'); const a=JSON.parse(fs.readFileSync(process.argv[1])); process.stdout.write(Buffer.from(a).toString('base64'))" /tmp/faucet-funder.json
```

**Verify length (must be exactly 64 bytes):**
```bash
echo "<output from above>" | base64 -d | wc -c
# Must print: 64
```

**Copy the output** — this is the value for `FAUCET_SOL_FUNDER_KEYPAIR_B64`.

---

## Step 3: Pre-Fund the SOL Funder

Extract the funder's public key and airdrop at least 5 SOL (to cover ~100 zero-balance wallets at 0.05 SOL + fees each).

**Extract the funder pubkey from your keypair file:**
```bash
solana-keygen pubkey /path/to/faucet-funder.json
# Output: <FUNDER_PUBKEY>
```

**Airdrop 5 SOL on testnet:**
```bash
solana --url https://rpc.areal.finance airdrop 5 <FUNDER_PUBKEY>
```

**Verify balance:**
```bash
solana --url https://rpc.areal.finance balance <FUNDER_PUBKEY>
# Should show: 5 SOL
```

**Note:** Each successful claim costs ~0.05 SOL + ~0.000005 SOL tx fee. Monitor this balance periodically via cron or manual checks. Refund when it drops below 1 SOL.

---

## Step 4: Deploy — Inject Env Vars on VPS

SSH into the Fornex VPS and append the keypair env vars to the backend `.env` file.

**Do NOT commit these values to git.**

**On the VPS:**
```bash
# Edit the .env file used by docker-compose
vim /path/to/.env
```

**Append the two new variables:**
```
FAUCET_USDC_AUTHORITY_KEYPAIR_B64=<output of Step 1>
FAUCET_SOL_FUNDER_KEYPAIR_B64=<output of Step 2>
```

**Restart the backend container:**
```bash
cd /path/to/docker-compose
docker compose -f docker-compose.prod.yml up -d backend
```

---

## Step 5: Verify Boot Logs

Check that the keypairs loaded successfully and the public keys match expectations.

**Tail the backend logs:**
```bash
docker compose logs -f backend
```

**Look for these lines (one per keypair):**
```
[FaucetModule] Faucet USDC authority loaded: VHixjUhygakXkJkpnMQDa2E71QhhSgF2Zz2rPdzaH9T
[FaucetModule] Faucet SOL funder loaded: <FUNDER_PUBKEY>
```

**Authority pubkey MUST be exactly `VHixjUhygakXkJkpnMQDa2E71QhhSgF2Zz2rPdzaH9T`.** If it differs, the wrong keypair was pasted — **STOP**, check Step 1, and redeploy with the correct value.

**If either env var is missing or malformed**, the container will crash-loop with an error like:
```
Invalid FAUCET_USDC_AUTHORITY_KEYPAIR_B64 keypair env var (length=...)
```

Fix the `.env` file and restart.

---

## Step 6: Smoke Test

Once boot logs confirm both keypairs are loaded, test the endpoint.

**Claim test-USDC for a test wallet:**
```bash
curl -X POST https://api.areal.finance/faucet/usdc \
  -H "content-type: application/json" \
  -d '{"wallet":"<TEST_WALLET_BASE58>","amount":1}'
```

**Expected response (200 OK):**
```json
{
  "success": true,
  "signature": "...",
  "ata": "<token account>",
  "amount": 1000
}
```

**Rate-limit test — claim again immediately (should get 429):**
```bash
curl -X POST https://api.areal.finance/faucet/usdc \
  -H "content-type: application/json" \
  -d '{"wallet":"<TEST_WALLET_BASE58>","amount":1}'
```

**Expected response (429 Too Many Requests):**
```json
{
  "message": "Rate limit exceeded",
  "retryAfterSec": 86400
}
```

---

## Operational Notes

### Daily Monitoring
- Check SOL funder balance weekly: `solana --url https://rpc.areal.finance balance <FUNDER_PUBKEY>`
- Set a reminder to top up when it falls below 1 SOL.

### Manual Rate-Limit Bypass (Rare)
If a wallet's 24-hour cooldown must be cleared (e.g., test failure recovery), connect to the backend Redis and delete the rate-limit key:
```bash
redis-cli -h <REDIS_HOST> -p <REDIS_PORT> DEL faucet:usdc:claimed:<WALLET_BASE58>
```

### Endpoint Behavior on Other Clusters
- **Devnet/Mainnet:** `POST /faucet/usdc` returns **404 Not Found**. No special action needed when deploying to non-localnet environments — the guard is automatic.
- **Localnet:** Fully operational.

### Hard Caps & Defaults
- **Default claim amount:** 1,000 USDC
- **Hard ceiling per request:** 10,000 USDC
- **Per-wallet rate limit:** 1 claim per 24 hours
- **SOL airdrop to zero-balance wallets:** 0.05 SOL
- **USDC decimals:** 6 (amounts are in whole USDC, not microUSdc)

### Authority Rotation (Advanced)
If the mint authority is rotated on-chain, the operator must update `FAUCET_USDC_AUTHORITY_KEYPAIR_B64` in the `.env` file **immediately** and redeploy. There is no way to bypass the authority keypair check — if it does not match the expected pubkey (`VHixjUhygakXkJkpnMQDa2E71QhhSgF2Zz2rPdzaH9T`), the container will fail to boot.

---

## Security Do-NOTs

- **Do NOT commit the env values to git.** They are secrets and belong in `.env` only, which is `.gitignore`d.
- **Do NOT paste or echo the base64 keypairs in shared chat, tickets, or logs.** Treat them as private keys.
- **Do NOT reuse the same authority keypair on devnet or mainnet.** Each cluster must have separate, isolated keypairs to prevent accidental mint operations against a real USDC mint.
- **Do NOT skip the `wc -c` length check in Steps 1–2.** A wrong-format input (e.g., pasting the Solana JSON array as text instead of base64-encoding raw bytes) will silently decode to garbage and crash boot with an unhelpful length mismatch.

---

## See Also

- `OPERATOR-RUNBOOK-PHASE-12.3.md` — general backend deployment procedures
- Faucet source: `src/modules/faucet/`
- RPC endpoint: `https://rpc.areal.finance`
