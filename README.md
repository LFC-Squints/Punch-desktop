# Punch

A self-hosted desktop time tracker that stays out of your way.

Frameless always-on-top widget. Global hotkey. Projects with subcategories. Tasks. Flexible Accounts field. Idle detection. Active-window autodetect rules. AI-ready markdown summary export. n8n webhook integration. GitHub-based auto-updates.

All data is stored locally in a single JSON file. Nothing leaves your machine unless you send it to your own webhook.

## Install

Grab the latest `Punch Setup X.Y.Z.exe` from the [Releases page](https://github.com/YOUR_USERNAME/punch-desktop/releases) and run it. Windows SmartScreen will warn you (unsigned installer); click "More info → Run anyway."

Punch runs in the system tray. Click the tray icon to show/hide, or press your global hotkey (default `Ctrl+Alt+P`) to toggle the timer from anywhere.

## Develop locally

```bash
git clone https://github.com/YOUR_USERNAME/punch-desktop.git
cd punch-desktop
npm install
npm start
```

Before `npm start`, **quit any installed copy of Punch from the system tray** — Punch uses single-instance locking, so a running installed copy will intercept the dev launch.

## Build installers

```bash
npm run dist
```

Outputs to `dist/`:
- `Punch Setup X.Y.Z.exe` — NSIS installer
- `Punch-Portable-X.Y.Z.exe` — portable single-file build

If `electron-builder` fails with a symlink error, run PowerShell as administrator.

## Publish a release with auto-update

```bash
npm run dist:publish
```

Requires a `GH_TOKEN` environment variable set to a GitHub Personal Access Token. Full walkthrough in [GITHUB-SETUP.md](./GITHUB-SETUP.md).

## Features

**Timer widget** — Frameless, always-on-top, 360×380. Big START/STOP button, project + subcategory + account dropdowns, inline notes field.

**Global hotkey** — Toggle the timer from anywhere and focus the notes field in one press. Configurable in Settings.

**Projects & subcategories** — Create projects with custom colors and per-project subcategory lists. Subcategories can be quick-added from the widget with the `+` button.

**Accounts** — A flexible flat-list field with a customizable label. Call it "Account," "Shop," "Client," "Franchise," "Matter" — whatever fits. Flows through entries, tasks, CSV export, and AI summaries.

**Tasks** — Obsidian-style task list grouped by project. Each task tracks time logged against it, can be started directly from the task list, and shows completion dates when checked off.

**Idle detection** — If you walk away with a timer running, Punch notices and offers three choices when you come back: keep the time, discard the idle minutes, or stop the timer at the idle start.

**Autodetect rules** — Watch the active window title and suggest (or auto-start) a specific project/subcategory when a pattern matches. Handy for tools you use in bursts.

**AI summary export** — Generate a columnist-style markdown digest for any date range, with account breakdowns, project breakdowns, completed tasks, and a full entries table. Copy to clipboard or POST to your n8n webhook.

**Search** — Fast full-text filter across the entries list.

**Auto-updates** — Silent background check on launch plus a manual "Check for updates" button. New versions download in the background and install on restart.

## Data location

Windows: `%APPDATA%\Punch\punch-data.json`

The **Open data folder** button in Settings opens the directory. Back it up whenever you want; copy to another machine to migrate.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+P` (global, configurable) | Toggle timer, focus notes |
| `Space` (window focused, not in a field) | Toggle timer |
| `Esc` | Close any open modal |
| `Enter` (in subcat/account input) | Add the item |
| `Ctrl+R` | Reload app (dev) |

## Code signing (optional polish for external distribution)

Unsigned installers trigger Windows SmartScreen on first install. For ~$80-150/year, a code-signing certificate from Sectigo (via a reseller like cheapsslsecurity.com) removes the warning.

Alternative: publish to the Microsoft Store (~$19 one-time dev fee). Zero-friction install for users, but requires repackaging as MSIX.

Neither is required for personal/small-team use.

## License

MIT
