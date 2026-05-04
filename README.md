# Punch — Simple Time Tracker

**Local-first, no-BS time tracking for freelancers and contractors.**

Punch is a lightweight desktop time tracker built for people who bill by the hour. Track time, mark billable hours, and (soon) generate invoices — all without sending your data to the cloud.

![Punch Screenshot](assets/screenshot.png)

---

## Features

### ⏱️ **Core Time Tracking**
- Start/stop timer with global hotkey (Ctrl+Alt+P)
- Manual time entry creation and editing
- Project and subcategory organization
- Account/Client management with custom labels
- Task tracking with active task indicators
- Notes field for context on every entry

### 💰 **Billable Hours**
- Mark accounts as billable by default
- Toggle billable status on individual entries
- Green indicators show billable time at a glance
- Sets foundation for invoice generation in v1.4

### 🪟 **Multiple View Modes**
- **Widget Mode** (360×380) — Compact timer controls, always on top
- **Full View** (920×720) — Complete project management and history
- **Mini Mode** (180×80) — Minimal timer display, draggable, click to expand

### 📊 **Live Taskbar Timer**
- Your taskbar icon becomes a live countdown clock
- Vertical stacked display: minutes over seconds
- Bright amber branding for easy visibility
- Automatically restores when timer stops
- Windows only (uses `setIcon` API)

### 📢 **What's New Notifications** (v1.3.1+)
- Auto-popup on first launch after each update
- Clean summary of new features
- Only shows once per version

### 🔧 **Automation & Integrations**
- Idle detection with configurable threshold
- Autodetect rules (switch project based on active window)
- n8n webhook integration for custom workflows
- CSV export for all time entries

### 🎯 **Smart Defaults**
- Always-on-top option for widget
- Global hotkey to toggle timer from anywhere
- Local JSON storage — your data stays on your machine
- Auto-updates via GitHub releases (in-place, no duplicate installs)

---

## Download

**Latest Release:** [v1.3.1](https://github.com/LFC-Squints/punch-desktop/releases/latest)

**System Requirements:**
- Windows 10/11 (64-bit)
- macOS 10.15+ (coming soon)
- Linux (coming soon)

---

## Installation

### Windows
1. Download `Punch-Setup-1.3.1.exe` from [releases](https://github.com/LFC-Squints/punch-desktop/releases)
2. Run the installer (no admin required)
3. Launch Punch from Start Menu or Desktop shortcut

**Already have Punch installed?** Just open the app — it'll auto-update in the background and notify you when ready to install.

### macOS & Linux
Coming soon! Follow development in [Issues](https://github.com/LFC-Squints/punch-desktop/issues).

---

## Updating

Punch handles updates automatically:

1. App checks GitHub for updates on launch
2. Downloads new version in background
3. Notifies you when ready to install
4. Click "Restart to install" — app overwrites itself in place
5. Same shortcuts, same data, new version

**No need to manually download installers after the first install!**

---

## Usage

### Quick Start
1. **Create a project:** Click "Projects" → "+ New project"
2. **Start tracking:** Select project, add notes (optional), click START
3. **Stop when done:** Click STOP or press Space (when window is focused)

### Keyboard Shortcuts
- `Ctrl+Alt+P` — Toggle timer (global hotkey, works anywhere)
- `Space` — Toggle timer (when Punch is focused)
- `Esc` — Close any open modal

### Mini Mode
- Click the **⊟** button in the header to shrink to mini mode
- Mini mode shows: live timer, project name, stop button
- Click the timer to expand back to widget mode
- Perfect for keeping timer visible while working

### Billable Hours
1. **Set account as billable:** Settings → Accounts → Edit account → Check "Billable by default"
2. **Override on entries:** When creating/editing entries, toggle "Billable" checkbox
3. **Visual indicators:** Billable entries show green checkbox + "BILLABLE" label

### Live Taskbar Timer
- When a timer is running, your Punch taskbar icon becomes a live clock
- Shows elapsed time in MM:SS format (vertical stack)
- Updates every second
- Automatically restores original icon when timer stops

---

## Development

### Tech Stack
- **Electron** — Desktop framework
- **Vanilla JS** — No framework bloat
- **Canvas API** — Dynamic taskbar icon generation
- **Local JSON** — All data stored in `%APPDATA%\Punch\punch-data.json`

### Running Locally
```bash
git clone https://github.com/LFC-Squints/punch-desktop.git
cd punch-desktop
npm install
npm start
```

### Building Installers
```bash
npm run dist          # Build locally to dist/ folder
npm run dist:publish  # Build and publish to GitHub as draft release
```

---

## Roadmap

**Current Version:** v1.3.1  
**Next Milestone:** v1.4 Business Tier (invoice generation)

See [ROADMAP.md](ROADMAP.md) for full development timeline.

### Upcoming Features
- **v1.4 Business Tier** (6-8 weeks)
  - Hourly rates per client
  - Invoice generator (text, HTML, PDF)
  - Branded invoices with logo upload
  - Auto-billable logic

- **v2.0 Focus Tab** (12-16 weeks)
  - Desktop passive tracking (app usage monitoring)
  - Output score calculation
  - Productivity insights

- **v3.0 Mobile Companion** (6-9 months)
  - iOS/Android apps (read-only)
  - Real-time sync via Supabase
  - Phone call tracking for billable hours

---

## FAQ

### Is my data sent to the cloud?
**No.** Everything is stored locally in a JSON file on your machine. The only network calls are:
- GitHub auto-update checks
- Optional n8n webhook (if you configure one)

### Can I sync across devices?
Not yet. Cloud sync is planned for v3.0 (Mobile Companion). For now, you can manually export/import the JSON file.

### How do I back up my data?
Your data file is at: `%APPDATA%\Punch\punch-data.json` (Windows)  
Copy this file to back up. Use "Export JSON backup" in Settings for one-click export.

### Why does the installer download a new launcher every update?
**It shouldn't anymore!** v1.3.1 fixed this issue. If you're on v1.3.0 or earlier, please uninstall and reinstall v1.3.1 — all future updates will install in-place.

### Does this work on Mac or Linux?
Not yet. Windows-only for now. Mac/Linux support is on the roadmap but not started.

### Will this always be free?
The core time tracking will always be free. Planned paid tiers:
- **Pro Tier** ($4.99/mo) — Gamification, unlimited history, advanced insights
- **Business Tier** ($12.99/mo) — Invoicing, client management, call tracking

---

## Contributing

Punch is built by one person ([Justin](https://github.com/LFC-Squints)) using Claude Pro. Contributions welcome!

### How to Help
- Report bugs in [Issues](https://github.com/LFC-Squints/punch-desktop/issues)
- Request features in [Discussions](https://github.com/LFC-Squints/punch-desktop/discussions)
- Submit PRs for bug fixes or new features
- Share Punch with freelancer friends who need better time tracking

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Credits

Built with:
- [Electron](https://electronjs.org)
- [canvas](https://github.com/Automattic/node-canvas) for dynamic icon generation
- [active-win](https://github.com/sindresorhus/active-win) for window detection
- [electron-updater](https://github.com/electron-userland/electron-builder) for auto-updates

Designed and developed by [Justin](https://github.com/LFC-Squints) with AI pair programming via Claude Pro.

---

**Questions?** Open an issue or start a discussion!  
**Updates?** Watch this repo for release notifications.
