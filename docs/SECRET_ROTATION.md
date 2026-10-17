# Secret rotation runbook

**Audience:** platform operator (you).
**When to run:** whenever a credential has been exposed in git history, in logs, in a shared chat, or on a lost device. Run **the full procedure** — rotating one secret while leaving sibling secrets in place still leaves the attacker a seat at the table.

> **Why rotation is non-optional.** The Build-BD git history contains historical commits where `.env` was tracked. Even though the file is untracked now (see commit `76038af`), the values are still present at the old revisions and can be recovered with `git show` by anyone who ever cloned, forked, or mirrored the repo. **Untracking does not rotate.** The only way to invalidate a leaked secret is to change it at the source.

---

## 1. MongoDB Atlas password

**Scope of blast radius:** full read/write on the production database. Rotate first.

1. Sign in to Atlas → **Database Access**.
2. Find the user used in production (`MONGODB_URI` username). Click **Edit**.
3. **Edit Password** → **Autogenerate Secure Password** → **Copy**. Do not paste it anywhere except the secret store (step 4) and the one terminal where you'll update the deployment.
4. In your deployment platform (ECR/EKS Secrets, Vercel, Fly, etc.):
   - Update the `MONGODB_URI` environment variable with the new password URL-encoded if it contains `@ : / ?`.
   - Redeploy. Watch the logs for `✅ Connected securely to MongoDB Atlas!`.
5. In Atlas → **Database Access** → **Update User**. The old password is now invalid immediately.
6. Audit the Atlas access logs (**Monitoring → Logs**) for the 24h window before rotation. Look for connections from IPs you do not recognize.

If you suspect compromise rather than just exposure: **also** rotate the Atlas API keys (**Organization Access Manager → API Keys**) and review the project-level **Network Access** allow-list.

## 2. JWT_SECRET

**Scope of blast radius:** anyone with the old secret can forge any user's session token (including `MODERATOR` and `ADMIN`). Rotate second.

1. Generate a new high-entropy secret:
   ```bash
   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
   ```
   128 hex chars = 512 bits. Store in your secret manager.
2. Update `JWT_SECRET` in your deployment platform.
3. **Redeploy.** From this moment, every previously issued token is invalid (verification fails) — users will be bounced to the login screen. This is the intended behaviour: an attacker holding a forged token is also bounced.
4. There is no server-side session table to clear; JWTs are stateless, so a secret change is the kill switch.

If you prefer a zero-downtime rotation (users do not get logged out), you can introduce `JWT_SECRET_PREVIOUS` and have the verifier accept either for ~24h. **Do not do this during an incident response** — it keeps the attacker's forged tokens alive for the overlap window. Only use the overlap pattern for routine quarterly rotations.

## 3. Storage credentials (S3 / Cloudflare R2)

**Scope of blast radius:** read/write on the uploads bucket (evidence photos, documents). Rotate third.

1. **R2:** Cloudflare dashboard → **R2 → Manage R2 API Tokens** → revoke the current token → create a new one scoped to the specific bucket (`buildbd-evidence`) with the minimum needed permissions (`Object Read & Write`).
   **AWS S3:** IAM → **Users → Security credentials** → make the current access key **Inactive**, create a new one, delete the inactive one after confirming the new one works.
2. Update `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (and `S3_ENDPOINT` if the token-generation step gave you a new account-id endpoint).
3. Redeploy and run the live check from the deployment host or any machine with the new `.env`:
   ```bash
   node scripts/storage-live-check.js
   ```
   Expect: `provider=r2 ... --- Results: storage is ready ---` and exit code 0.

## 4. SSLCommerz keys (payment)

**Scope of blast radius:** payment capture + IPN signature verification. Rotate if `SSL_STORE_ID` / `SSL_STORE_PASSWORD` were in a tracked `.env`.

1. SSLCommerz merchant panel → **Developer → API Credentials** → **Regenerate**.
2. Update `SSL_STORE_ID` and `SSL_STORE_PASSWORD`. Redeploy.
3. Make a test payment in sandbox mode first (`NODE_ENV=development`) to confirm the IPN signature verifies.

## 5. Other credentials to audit after a leak

- `CORS_ORIGIN` — if you accidentally set it to `*` in production, tighten to the known frontend origin(s).
- Any third-party SMS gateway key (Twilio, BD-SMS) once you wire up the real provider.
- Redis connection string if used.

## 6. Verify git history no longer surfaces secrets

After rotating, grep the git history for the **old** values and confirm nothing in your deployment pipeline (CI logs, build artifacts, container images that were pushed to a registry) still contains them:

```bash
git log --all -p -S "<old password fragment>" --oneline
```

If matches are found: those old values are permanently in history. The remediation is **rotation** (already done above), not history rewriting. History rewriting (`git filter-repo` + force-push) is only safe if you own all forks and mirrors, which you likely do not. Rotation is the correct and sufficient fix.

## 7. One-page checklist

- [ ] Atlas password rotated and deployment updated
- [ ] `JWT_SECRET` rotated and deployment updated (users forced to re-login)
- [ ] Storage credentials rotated and `scripts/storage-live-check.js` green
- [ ] SSLCommerz keys rotated if ever exposed
- [ ] Access logs for the 24h window reviewed for unknown IPs
- [ ] `.gitignore` still excludes `.env`, `.env.*` (except `.env.example`)
- [ ] `git ls-files | grep -E "^\.env$|\.env\." ` returns no matches
