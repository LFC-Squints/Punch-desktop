# Punch

A self-hosted desktop time tracker that stays out of your way.

## Install

**[📥 Download Punch Setup 1.2.0.exe](https://github.com/LFC-Squints/punch-desktop/releases/latest)**

Run the installer. Windows SmartScreen will warn you (unsigned app) — click **More info → Run anyway**.

Punch runs in your system tray. Click the tray icon or press `Ctrl+Alt+P` to open.

---

Frameless always-on-top widget. Global hotkey. Projects with subcategories. Tasks. Flexible Accounts field. Idle detection. Active-window autodetect rules. AI-ready markdown summary export. n8n webhook integration. GitHub-based auto-updates.

All data is stored locally in a single JSON file. Nothing leaves your machine unless you send it to your own webhook.

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
| `Esc` | Close any ope12e626f849faf31c6d02cad106b4ba3d25f71ed8
