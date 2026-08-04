<div align="center">
  <img src="src/assets/wisland-icon.png" width="112" alt="Wisland icon">

# Wisland

A lightweight Windows desktop island for Codex, music, and focused workflows.

[![Release](https://img.shields.io/github/v/release/Lev1z/Wisland?style=flat-square)](https://github.com/Lev1z/Wisland/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Lev1z/Wisland/total?style=flat-square)](https://github.com/Lev1z/Wisland/releases)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4?style=flat-square&logo=windows11&logoColor=white)
[![License](https://img.shields.io/github/license/Lev1z/Wisland?style=flat-square)](LICENSE)

[简体中文](README.md) · **English**
</div>

Wisland stays at the top of your screen and presents Codex status and quota, media information, Obsidian notes, and temporary files in one restrained capsule, keeping frequent actions close without interrupting your work.

<p align="center">
  <img src="docs/assets/wisland-capsule.png" width="236" alt="Wisland capsule interface">
</p>

## Highlights

- **Codex status and quota** — view your remaining quota and distinguish idle, running, and offline states at a glance.
- **Music, lyrics, and controls** — read track metadata, artwork, progress, and playback state from Windows SMTC, with playback controls, volume, album-colored waveforms, and per-player lyric timing.
- **Obsidian quick notes** — append notes, tasks, and journal entries to a selected Vault and manage today's entries from the capsule.
- **Temporary file tray** — keep references to dropped files and drag them out or open them later without copying or modifying the originals.
- **Flexible navigation and appearance** — choose between a classic icon bar and an option wheel, reorder pages, and customize scale, opacity, borders, images, and GIFs.
- **Desktop behavior** — pin the expanded capsule with the middle mouse button, collapse it into a top bar, configure process/full-screen exclusions, start with Windows, and use the system tray.
- **Environment check** — verify WebView2, Codex Desktop, Codex CLI, Hooks, media services, and Obsidian on first launch, with contextual repair actions.

## Download and install

Download the latest `Wisland_<version>_x64-setup.exe` from [GitHub Releases](https://github.com/Lev1z/Wisland/releases/latest) and run it.

The installer is recommended over copying the standalone `Wisland.exe` from a build directory because it correctly configures upgrades, uninstall support, and Start menu shortcuts.

### Requirements

- 64-bit Windows 10 or Windows 11
- Microsoft Edge WebView2 Runtime (normally included with Windows 11)
- Optional: Codex Desktop and Codex CLI for status and quota features
- Optional: a media player that exposes Windows SMTC sessions
- Optional: Obsidian for quick notes

## Quick start

1. The first launch opens an environment check. Expand the capsule to inspect all results and resolve missing components.
2. Move the pointer over the capsule at the top center of the screen to expand it. It collapses roughly 0.5 seconds after the pointer leaves.
3. Scroll over the capsule to switch between the clock, music, journal, and file tray views.
4. Middle-click to pin or unpin the expanded state; right-click to open the shortcut menu.
5. Drag the capsule toward the top edge to collapse it into a small bar, then click the bar to restore it.
6. Install Hooks from the Codex settings page in Wisland and approve them when Codex requests trust.
7. Select an Obsidian Vault and daily-notes directory in Wisland settings to enable quick notes.

## Codex integration

Wisland uses Codex lifecycle Hooks to synchronize task start and completion states, and an authenticated Codex CLI session to retrieve quota information. Fully restart Codex after installing Hooks so that the new configuration is loaded.

The Hooks page in Codex App only queries hooks after it knows a project root. Before a project has been opened, the page may say that no hooks were found even though the runtime has loaded and executed them. Open a project and revisit the settings page; hook details shown below a Codex response also confirm that the configuration is active.

If PowerShell execution policy blocks `codex.ps1`, launch the command shim instead:

```powershell
& "$env:APPDATA\npm\codex.cmd"
```

## Views

### Clock / Codex

The center of the compact state shows the clock. The left ring displays remaining Codex quota, while the right indicator uses:

- Green: Codex is online and idle, or the latest task has completed
- Orange: Codex is executing a task
- Gray: Codex is not running, has exited, or its state is unavailable

Quota retrieval requires a separately installed and authenticated Codex CLI. Wisland reads account limits through `codex app-server`; temporary connection failures keep the latest successful value and mark it as pending refresh.

### Music

Wisland reads Windows SMTC media sessions, so the player must expose media information to Windows. If NetEase Cloud Music is not detected, enable system media controls (SMTC) in its system settings, then rerun the environment check from Wisland's Behavior settings.

### Obsidian

Wisland reads and writes only the local Vault you select. After configuring the daily-notes directory, you can add quick notes and tasks from the capsule. Confirm that the directory matches your existing Obsidian structure before writing.

### Temporary file tray

Dropped files are stored as paths in memory for the current session. The list is cleared when Wisland exits; original files are never modified, deleted, or uploaded.

## Development

Development requires Node.js LTS, Rust stable, WebView2, and the Windows C++ build tools required by Tauri 2.

### Project structure

```text
Wisland/
├─ src/                     # TypeScript frontend
│  ├─ modules/             # Capsule, media, Codex, and Obsidian features
│  └─ assets/              # App icons and frontend assets
├─ public/
│  ├─ themes/              # Built-in capsule themes
│  └─ assets/visuals/      # Built-in image and animation assets
├─ src-tauri/               # Tauri / Rust desktop application
│  ├─ src/                 # Window, media, settings, logging, and OS integration
│  ├─ icons/               # Windows and installer icons
│  └─ windows/             # NSIS installer extensions
├─ scripts/                 # Codex status Hooks and asset-generation utilities
├─ docs/assets/             # Images used by the README files
├─ index.html               # Main capsule window entry
├─ settings.html            # Settings window entry
└─ package.json             # Frontend dependencies and development commands
```

```powershell
npm install
npm run tauri dev
```

Build the frontend:

```powershell
npm run build
```

Build the Windows application and NSIS installer:

```powershell
npm run tauri build
```

Default outputs:

- `src-tauri/target/release/wisland.exe`
- `src-tauri/target/release/bundle/nsis/Wisland_<version>_x64-setup.exe`

## Data and privacy

Wisland stores settings, Codex state, and logs in `%APPDATA%\wisland`. Obsidian content is written only to the selected local Vault, and the temporary file tray does not upload or copy files. Network requests for lyrics and Codex quota are made only when their corresponding features are used.

## Technology

- [Tauri 2](https://tauri.app/)
- Rust and Windows APIs
- Vanilla TypeScript and Vite
- Windows System Media Transport Controls (SMTC)
- [Lyrix](https://crates.io/crates/lyrix)

## Acknowledgements

Wisland draws visual inspiration from PyIsland and evolved from the public `tauri-island` codebase. The current mainline has been streamlined and reworked around Codex and personal desktop workflows.

## License

This project is available under the [MIT License](LICENSE).
