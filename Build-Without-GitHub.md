# Building the installer without GitHub

Use this if you would rather not depend on GitHub at all. You install Node once,
then produce the installer with one command whenever you change something.

---

## One-time setup (about 5 minutes)

1. Download Node.js LTS from https://nodejs.org (the big green button).
2. Install it with the defaults. This gives you `node` and `npm`.
3. Open PowerShell in the project folder (`tally-connector-source`) and run:

```powershell
npm install
```

That downloads the libraries the app needs. You only do this once, and again
only if the dependencies in `package.json` change.

---

## Building an installer

```powershell
npm run dist
```

Three to five minutes later you get:

```
dist\Tally Connector Setup 2.0.0.exe     <- this is the file for your users
```

Upload that to your server, and point the download link at it.

To test the app without building, `npm start` opens it directly.

---

## Releasing a new version

1. Make your changes.
2. Open `package.json`, bump `"version"` (2.0.0 → 2.0.1).
3. `npm run dist`
4. Upload the new `.exe` to your server, replacing the old one.

Keep the filename on the server stable - for example always upload it as
`TallyConnectorSetup.exe` - so the download link you gave customers never
changes.

---

## Keeping a backup of the code

Without GitHub, the source lives only on your machine. At minimum, zip the
project folder after each change and keep it somewhere else (Google Drive,
another disk). A deleted folder with no copy is the one failure that cannot be
undone.

GitHub gives you that backup plus version history for free, even if you never
use its build pipeline - worth keeping the repository around for that alone.

---

## What you lose without GitHub

| | With GitHub | Local build only |
|---|---|---|
| Node.js on your PC | not needed | required |
| Building | automatic on a tag push | you run `npm run dist` |
| Code backup and history | included | you arrange it yourself |
| Someone else can build it | yes | only from your machine |
| Public download link | Releases page | your server only |

Both approaches produce exactly the same installer. Nothing about the app
changes.
