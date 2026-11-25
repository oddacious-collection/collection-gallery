# Backup setup (owner tasks O-05 and O-06, M1 step 7)

Backups go to **Backblaze B2** (a second provider, INV-2) and are locked so
that stolen routine credentials can't destroy them (BAK-04). Failure alerts
are emailed through **Cloudflare Email Sending** (D-47 as amended by D-58).

Do **Part A** whenever convenient. **Part B** runs a script once the backup
Worker has been deployed to staging.

---

## Part A: accounts and buckets (in the browser)

### A1. Backblaze account and sign-in security

1. Go to <https://www.backblaze.com/sign-up/cloud-storage> and create an
   account with an email address you control. Choose the default data region
   (it can't be changed later; any region works).
2. Sign in, open **My Settings** (top right, your account menu).
3. Under **Sign In Settings** (or **Security**), turn on
   **Two-Factor Verification** with an **authenticator app** (TOTP).
4. If there is an option to use **SMS as a fallback**, turn it **off**.
5. Save the **backup codes** offline (printed, or written down and kept
   somewhere safe, not in this repo or in email).

Backblaze doesn't offer passkeys; TOTP with no SMS fallback is the accepted
setting (D-47).

### A2. Two buckets (staging)

In **B2 Cloud Storage → Buckets → Create a Bucket**, create both of these.
For each one:

| Setting             | Value                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Bucket name         | `oddacioustreasures-com-staging-db-backups` (first), `oddacioustreasures-com-staging-media-backups` (second) |
| Files in bucket are | **Private**                                                                                                  |
| Default encryption  | **Enable**                                                                                                   |
| Object Lock         | **Enable**                                                                                                   |

Leave any "default retention" for Object Lock **off**: the backup Worker sets
the lock on each file itself (30 days for daily database copies, 365 days for
monthly copies and photos).

If the name is taken (bucket names are global), add `-2` to the end and tell
Claude the names you used.

### A3. Lifecycle rules (optional: the Part B script sets these)

The key script in Part B sets these rules itself, so this step can be
skipped. To set them by hand instead, open each bucket's **Lifecycle
Settings**.

**`…-staging-db-backups`** → choose **Use custom lifecycle rules** and add two
rules:

| File name prefix | Days from uploading to hiding | Days from hiding to deleting |
| ---------------- | ----------------------------- | ---------------------------- |
| `daily/`         | 31                            | 1                            |
| `monthly/`       | 366                           | 1                            |

**`…-staging-media-backups`** → choose **Keep prior versions for this number
of days** and enter **365**. (Current photo backups are kept for as long as
the photo exists; a deleted or replaced photo stays recoverable for a year.)

### A4. Email sending (Cloudflare)

1. In the Cloudflare dashboard, open **Compute → Email Service → Email
   Sending** (it may be listed as **Email → Email Sending**).
2. Choose **Onboard Domain** and select `oddacioustreasures.com`.
3. Review the records it adds: they live on the **`cf-bounce`** subdomain
   (MX, SPF and a DKIM key). Accept them. Your main domain's SPF
   (`v=spf1 -all`) and DMARC (`p=reject`) stay as they are.
4. Do **not** enable Email Routing (inbound mail); it isn't needed.

When A1 to A4 are done, tell Claude: "Backblaze and email are set up", with
the two bucket names if you had to change them.

---

## Part B: keys and secrets (one script, after the backup Worker is deployed)

Backblaze's web console can only make keys that are allowed to delete files.
The backup Worker must **not** be able to delete anything (BAK-05), so its
keys are made through Backblaze's API by `scripts/b2-setup-keys.ps1`.

You will need, just for the duration of the script, a **master application
key**: in Backblaze, **Application Keys → Generate New Master Application
Key**. Keep the window open; the script asks for its **keyID** and the
**applicationKey** (typed into hidden prompts, never shown or saved).

The script first checks both buckets and sets their lifecycle rules (A3).
Then it:

1. creates the **backup job key** (both buckets; list, read, write and set
   locks; **no delete**, **no bypass of locks**) and stores it straight into
   the backup Worker as secrets;
2. creates the **verify key** (both buckets; read-only) and stores it as
   GitHub `staging` environment secrets for the weekly `backup:verify` check;
3. asks for the **alert email address** and stores it as a Worker secret
   (never committed);
4. creates the **break-glass key** (can delete and override locks) and shows
   it **once**. Write it down and keep it offline with your backup codes. It
   is only for the emergency purge runbook.

Afterwards, in Backblaze, click **Generate New Master Application Key** once
more and **don't save** the result: that cancels the master key you just used.

Claude gives you the exact command to run when Part B is due.
