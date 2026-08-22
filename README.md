# Tally Connector

Desktop agent that syncs Tally Prime data into an AJEMS workspace.

## For users

Download the latest **Tally Connector Setup .exe** from the
[Releases page](../../releases/latest), run it, and follow the prompts.
Nothing else needs to be installed.

### First run

1. Open Tally Prime with your company loaded.
   Enable the port: `F1 > Settings > Connectivity > Client/Server configuration > acts as "Both"`
2. Open Tally Connector.
3. Enter your **AJEMS organisation name** and **secret key**, then click **AJEMS Connect**.
   The Tally Connector app is created in your AJEMS workspace automatically if it is not there yet.
4. Click **Run Sync**.

Windows may show a SmartScreen warning on first launch because the app is not
code-signed. Click **More info** then **Run anyway**.

### What gets synced

Companies, ledger groups, ledgers, vouchers, voucher entries, voucher items and
sync logs. New records are added, changed records are updated, unchanged records
are skipped - so re-running a sync never creates duplicates.

### Automatic sync

In **Settings > Automatic sync** you can have it sync every N minutes while Tally
is open, or once a day at a set time. The connector then starts with Windows and
stays in the system tray. Right-click the tray icon to quit.

---

## For developers

```bash
npm install
npm start          # run it locally
npm run dist       # build dist/Tally Connector Setup <version>.exe
```

Node and npm are only needed if you want to run or build locally. To publish a
release you need Git alone - GitHub Actions installs Node on its own runner.

**Releasing without npm installed:** edit `"version"` in `package.json`, then

```bash
git add package.json
git commit -m "v2.0.1"
git tag v2.0.1
git push && git push --tags
```

**With npm installed,** `npm version patch` does the same in one command.

The tag must match the version in `package.json` - the installer filename and
the update feed both come from it.

### Layout

| Path | What it is |
|---|---|
| `src/main.js` | Electron main process - window, tray, schedulers, notifications |
| `src/preload.js` | IPC bridge |
| `src/index.html` | UI (Sync and Settings) |
| `src/sync.js` | Sync engine - Tally XML in, AJEMS JSON Builder API out |
| `src/assets/ajems-ui.css` | Shared AJEMS design system stylesheet |
| `AJEMS-Design-System.md` | Design rules every connector follows |
| `.github/workflows/build-installer.yml` | Builds and publishes the installer |

### Where user data lives

`%APPDATA%\tally-connector\`

- `config.json` - organisation, linked form URLs, preferences.
  The secret key is encrypted with the Windows keystore before it is written.
- `sync-state-<workspace>.json` - per-workspace sync state.

Nothing user-specific is ever committed or shipped in the build.
