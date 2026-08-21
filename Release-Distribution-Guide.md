# Release and distribution setup

How the Tally Connector reaches users, and what you have to do to run it.

---

## The pipeline

```
  You: git push --tags
        |
        v
  GitHub Actions (Windows runner)
    builds  Tally Connector Setup <version>.exe
            latest.yml           <- the update feed
        |
        v
  YOUR APPROVAL  <- GitHub waits here until you click Approve
        |
        v
  Upload to storage (Cloudflare R2 or AWS S3)
        |
        v
  downloads.ajems.in/tally-connector/
        |
        +--> Download page on your site -> new users install
        |
        +--> Installed apps check latest.yml -> "Version 2.0.1 is available"
```

Users never see GitHub. They see your download page, and after that the app
tells them about updates itself.

---

## Part 1 - GitHub (one time)

1. Install Git: https://git-scm.com/download/win
2. Create a **private** repository at https://github.com/new named `tally-connector`
3. Extract the source zip, open PowerShell in `tally-connector-source`, then:

```powershell
git init
git add .
git commit -m "Tally Connector v2.0"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/tally-connector.git
git push -u origin main
```

### Add the approval gate

Repository → **Settings** → **Environments** → **New environment** → name it
`production` → tick **Required reviewers** → add yourself → Save.

Now nothing reaches the download server until you approve it.

---

## Part 2 - Storage (one time)

Both options are S3-compatible, so the pipeline works with either. **Cloudflare R2
is the better fit** - downloads cost nothing, whereas S3 charges for every GB sent
out, and installers are around 80 MB each.

### Cloudflare R2

1. Cloudflare dashboard → **R2** → **Create bucket** → name it `ajems-downloads`
2. Bucket → **Settings** → **Public access** → connect a custom domain:
   `downloads.ajems.in`
3. **Manage R2 API Tokens** → Create token, Object Read & Write → note the
   Access Key ID and Secret Access Key
4. Your endpoint is `https://<account-id>.r2.cloudflarestorage.com`

### AWS S3 (alternative)

Create a bucket, allow public read on the `tally-connector/` prefix, put
CloudFront in front of it, and create an IAM user with `s3:PutObject` on that
bucket. Leave `STORAGE_ENDPOINT` empty.

### Add the secrets to GitHub

Repository → Settings → **Secrets and variables** → **Actions** → New secret:

| Secret | Value |
|---|---|
| `STORAGE_ACCESS_KEY` | access key id |
| `STORAGE_SECRET_KEY` | secret access key |
| `STORAGE_BUCKET` | `ajems-downloads` |
| `STORAGE_ENDPOINT` | R2 endpoint URL, or leave unset for AWS S3 |

---

## Part 3 - Point the app at your domain

If your download domain is not `downloads.ajems.in`, change it in two places:

- `package.json` → `build.publish[0].url`
- the download page → the `BASE` constant in the script at the bottom

Then commit.

---

## Part 4 - The download page

Upload `ajems-connectors-download-page.html` to your site as
`ajems.in/connectors`. It already matches the AJEMS design system, and it reads
`latest.yml` at load time, so the version number and download link update
themselves with every release. Excel and WooCommerce cards are there as
"Coming soon" placeholders.

---

## Releasing a version

```powershell
npm version patch          # 2.0.0 -> 2.0.1, commits and tags
git push && git push --tags
```

Then:

1. **Actions** tab → the build runs (3-5 minutes)
2. The `publish` job says **Waiting for review** → click **Review deployments** →
   **Approve and deploy**
3. Files land on the download server

Existing users see the update within six hours, or the next time they open the
app. They click **Download update**, then **Restart now**. Their settings and
connection are kept.

Use `npm version minor` for a feature release (2.0.0 → 2.1.0).

### Testing without releasing

Actions → "Build and publish installer" → **Run workflow**. It builds but does not
publish; the installer is under **Artifacts** on the run page.

---

## What the user experiences

**Installing**
Download → run → a short setup wizard → installed under their own user account
(no admin password) → desktop and Start Menu shortcuts.

**Updating**
A blue bar appears at the top of the app: *"Version 2.0.1 is available. Your
settings are kept."* → **Download update** → **Restart now**. Nothing downloads
or installs without them choosing it, which is what you asked for.

**Uninstalling**
Settings → Apps → Tally Connector → Uninstall. Removes the app and its stored
settings.

---

## Still open

**Code signing.** Without it Windows shows "Windows protected your PC" on first
run, and the update download shows the same warning. A certificate is about
Rs 25,000-30,000 a year (Sectigo, DigiCert, or similar - an OV certificate is
enough). Once you have one, add it as GitHub secrets `CSC_LINK` (the .pfx as
base64) and `CSC_KEY_PASSWORD`, and electron-builder signs every build with no
other change. Worth doing before you push this to clients at scale - the warning
costs trust with accountants more than it costs you in rupees.

**Silent updates.** Currently the app asks. If you later want Chrome-style
invisible updates, set `autoUpdater.autoDownload = true` and install on quit.

**macOS.** The pipeline is Windows-only. Tally itself is Windows-only, so this is
unlikely to matter.
