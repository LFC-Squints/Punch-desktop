# CLAUDE.md — Punch Desktop

## Project Overview

Punch is an Electron-based desktop time-tracking app for freelancers and small
teams. Core focus: accurate session tracking, billable-hours management,
lightweight always-on widget, and a productivity layer (tasks, nudges, daily
closeout). **Current shipped version: v1.5.0.** Next planned surface: a Focus
tab built on the existing selectors/services layer.

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

## Core Features (as of v1.5.0)

### Time tracking
- Start/stop punch sessions tied to projects/accounts
- Editable session history; per-entry notes

### Billable hours
- Per-entry billable flag (green accent in UI)
- Per-account default billable setting (pre-fills new entries; does not override)
- Billable totals surfaced separately

### Tasks + Today's Plan
- Multi-project tasks, task-first selection flow with "any project" filter
- Today's Plan card promotes the day's working set
- Auto carry-forward bumps overdue active tasks to today on app init
  (idempotent same-day; bumps priority to `high` unless already higher)

### Nudges
- Configurable in-app prompts (interval, active days/hours, snooze, optional
  timed-break, working-hours respect)
- Global pause + presentation mode
- Hidden-window events queue and surface on `visibilitychange`
- Mental-break preset auto-seeded disabled, once

### End Day closeout
- Modal with KPI strip, project totals, completed list, per-task actions
  (carry / keep active / complete / archive), missing-notes list
- Appends a structured record to `state.dailyCloseouts`
- Optional under auto carry-forward; required only for explicit decisions

### Insights
- "Daily closeouts" card with the latest summary + recent closeouts

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

`schemaVersion: 2`. Migration runs on first load via `mergeWithDefaults` +
`migrateData` in `renderer/app.js`. v2 added: `nudges`, `nudgeEvents`,
`dailyCloseouts`, `settings.productivity`, plus per-task
`carryForwardCount` / `lastCarriedForwardAt` / `dailyPriorityRank`.

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
| Next    | Focus tab (reuses existing selectors/services) |
| Later   | Reporting / export (CSV, PDF), invoice generation |
| Future  | Mobile passive tracking, call-tracking integration |

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
