# CLAUDE.md — Punch Desktop

## Project Overview

Punch is an Electron-based desktop productivity system for freelancers and
small teams. Started as a time tracker; v2.0 positioned it as an
ADHD-friendly focus system. Core surfaces: accurate session tracking, the
billable-hours layer, the always-on widget, a productivity layer (tasks,
nudges, daily closeout, carry-forward), and the Focus tab (window/app
activity, app-site labels, idle, unlogged-work detection, attention drift).
**Current shipped version: v2.0.0.** Possible future rebrand: "Get Traction".

---

## Tech Stack

- **Framework:** Electron (main + renderer process)
- **Frontend:** Vanilla HTML/CSS/JS in the renderer — no React, no framework
- **IPC:** Electron `ipcMain` / `ipcRenderer`
- **Storage:** Single local JSON file (`punch-data.json`) in the user-data dir
- **Auto-update:** `electron-updater` against GitHub Releases (autoDownload off)
- **Build:** `electron-builder` (Windows target)

---

## Project Structure

```
punch-desktop/
├── main.js              # Electron main process: windows, tray, IPC, updater
├── preload.js           # contextBridge surface exposed to the renderer
├── package.json
├── renderer/
│   ├── index.html
│   ├── app.js           # All renderer logic (single file, banner-separated)
│   ├── styles.css
│   └── app.backup.js    # Stale v1.3-era backup; deferred cleanup
├── assets/              # Icons, images
├── README.md
├── GITHUB-SETUP.md
└── CLAUDE.md
```

> If the layout drifts, update this tree.

---

## Core Features (as of v2.0.0)

### Time tracking
- Start/stop punch sessions tied to projects/accounts
- Editable session history; per-entry notes

### Billable hours
- Per-entry billable flag (green accent in UI)
- Per-account default billable setting (pre-fills new entries; does not override)
- Billable totals surfaced separately

### Tasks + Today tab
- Multi-project tasks, task-first selection flow with "any project" filter
- Today tab redesigned around a Daily Snapshot (KPIs + nudge pill + End Day),
  Suggested Focus card, Today's Priorities, and Today's Log
- Auto carry-forward bumps overdue active tasks to today on app init

### Nudges
- Configurable in-app prompts (interval, active days/hours, snooze)
- Global pause + presentation mode + per-nudge bring-to-front
- Hidden-window events queue and surface on `visibilitychange`

### End Day closeout
- KPI strip, project totals, completed list, per-task actions, missing-notes
- Appends a structured record to `state.dailyCloseouts`

### Focus tab (v2.0)
- Window/app activity detection via `get-windows`
- User-defined activity rules label apps/sites (matchType: appName /
  windowTitle / both; categories Work / Communication / Distraction /
  Utility / Break / Custom)
- App & site usage rollup, top distractions, idle summary, attention drift
- Unlogged-work detection: prompts when you've been active in a
  Work/Communication-labeled app for ≥ threshold with no timer running
- `focusEvents[]` data foundation (window changes, idle, distractions,
  nudge responses, suggested focus, end-day, unlogged-work flow)

### Settings — Workspace / Focus Tools / Data & Backup / App Preferences
- 4-pane subnav restructure (v2.0). Projects management folded into
  Workspace Setup (the standalone Projects tab was removed).
- New: Subcategories admin, Activity Rules manager.

### Mini-mode widget
- Compact 180×80 window; resize driven from main via IPC

---

## IPC Conventions

Main registers handlers via `ipcMain.handle()`; renderer invokes via
`ipcRenderer.invoke()` (or the contextBridge surface in `preload.js`). Window
resizing for mini mode goes through IPC — never resize from the renderer
directly.

```js
// main.js
ipcMain.handle('resize-window', (event, { width, height }) => {
  mainWindow.setSize(width, height);
});

// renderer/app.js
await window.punch.resizeWindow({ width: 180, height: 80 });
```

---

## Architecture notes (renderer/app.js)

Productivity-related code is grouped under banner comments so a future Focus
tab can lift it as a unit. Search for:

```
// PRODUCTIVITY — Selectors, Services, Coach Card
// PRODUCTIVITY — Nudge Service
// PRODUCTIVITY — End-of-block divider
// PRODUCTIVITY — UI: Nudges (popup + settings manager)
// PRODUCTIVITY — UI: End Day
```

Selectors are pure (no mutation) and reusable. Services own mutation and are
called from init (`autoCarryForwardOverdueTasks`, `maybeSeedMentalBreakNudge`,
`startNudgeScheduler`).

---

## Schema

`schemaVersion: 4`. Migration runs on first load via `mergeWithDefaults` +
`migrateData` in `renderer/app.js`. v2 added nudges/closeouts/productivity
settings. v3 added `focusEvents[]` + `settings.focus` (window tracking
opt-in). v4 added `activityRules[]` + focus settings for activity rules
and unlogged-work detection. All migrations are strictly additive — old
data loads cleanly.

Do not break the on-disk shape without writing a migration step.

---

## Development Guidelines

- **One process, one responsibility.** Main owns window/system; renderer owns
  UI. Cross the boundary only through IPC.
- **Mini mode stays lean.** No heavy DOM work while in mini mode.
- **Entry-level billable is the source of truth.** Account defaults pre-fill
  only.
- **No new UI frameworks** unless explicitly introduced.
- **Comments explain *why* non-obvious decisions exist**, not what the code does.

---

## Roadmap

| Version | Focus |
|---------|-------|
| v1.4    | Business tier — billable hours, accounts, mini mode (shipped) |
| v1.5    | Productivity — Nudges, End Day, auto carry-forward, schema v2 (shipped) |
| v2.0    | Focus system — Focus tab, window/app detection, activity rules, unlogged-work detection, attention drift, schema v3+v4 (shipped) |
| Next    | App/site drill-down on Focus, regex matching for rules, multi-week ranges |
| Later   | Reporting / export (CSV, PDF), invoice generation |
| Future  | Mobile passive tracking, call-tracking integration, possible Get Traction rebrand |

Do not scaffold future-tier features while working on the current one unless
asked.

---

## Running the App

```bash
npm install
npm start          # production-mode local run
npm run dev        # adds --dev flag (DevTools etc.)
npm run dist       # build Windows installer (no publish)
npm run dist:publish   # build + publish a draft GitHub release
```

---

## Notes for Claude Code

- Sole developer working AI-assisted. Prefer readable, explicit code over
  clever abstractions; favor clarity over brevity in naming.
- When fixing bugs, identify and comment the root cause rather than patching
  symptoms.
- Flag duplication / dead code when you see it; don't silently refactor outside
  the task scope.
