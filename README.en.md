# DeepSeek Desktop

[中文](README.md) · [English](README.en.md) · [日本語](README.ja.md)

An all-in-one desktop app combining **DeepSeek Chat** and **Harness**. After installation, **no browser and no terminal commands are needed**: the app automatically starts the Harness service on launch and provides two tabs for one-click access:

| Tab | Content | URL |
| --- | --- | --- |
| 💬 DeepSeek Chat | Official DeepSeek web chat | https://chat.deepseek.com |
| 🛠 Harness | DeepSeek Harness workspace (local service) | http://127.0.0.1:3080 |

## Features

- **Auto-start Harness**: probes whether a Harness is already running locally (via the `__DSH_BOOT__` marker); if not, it launches one with `dsh web` automatically (bundled dsh runtime — no dependency on your npm cache). If one is already running, it is reused, and quitting the app never kills an externally started Harness
- **Dual tabs**: `Cmd+1` Chat / `Cmd+2` Harness, `Cmd+R` reloads the current page
- **Session persistence**: each tab uses its own partition (`persist:deepseek` / `persist:harness`), so login state and Harness sessions survive restarts
- **Self-healing**: if Harness is not ready or exits unexpectedly, an error panel appears with one-click restart and log viewing
- **Single instance**: launching the app again only focuses the existing window
- **External links**: `target=_blank` links open in your system browser

## Installation

1. Download the installer for your platform from [Releases](https://github.com/zhenghy-gh/DeepSeek-Desktop/releases) (macOS: `-arm64.dmg`, Windows: `.exe`, Linux: `.AppImage` or `.deb`)
2. macOS: open the dmg and drag **DeepSeek Desktop** into Applications; Windows: run the installer; Linux: `chmod +x` then run the AppImage, or install the deb with `sudo dpkg -i`
3. First launch: unsigned apps are blocked by Gatekeeper / SmartScreen — on macOS right-click the app icon and choose "Open" (locally built apps are unaffected)

> The installer bundles the dsh runtime (~300 MB uncompressed). The first Harness start takes a few seconds; the status dot in the toolbar shows progress.

## Development

```bash
npm install          # install electron / electron-builder
npm run icon         # generate app icons (requires macOS sips/iconutil)
npm run prepare:runtime  # copy the local dsh runtime into dsh-runtime/
npm start            # run in development mode
npm run dist:mac     # build macOS dmg + zip (output to dist/)
npm run dist:win     # build Windows NSIS installer (prefer Windows or CI)
npm run dist:linux   # build Linux AppImage + deb
```

> If downloading the Electron binaries is slow from your network, set mirrors before building:
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`

## Multi-platform installers (GitHub Actions)

Pushing a `v*` tag automatically triggers [.github/workflows/build.yml](.github/workflows/build.yml),
which builds dmg, zip, NSIS exe, AppImage and deb on native macOS / Windows / Ubuntu runners
and publishes them to the corresponding Release page. It can also be triggered manually from the Actions tab (workflow_dispatch).

## How it works

- `main.js`: Electron main process. Locates node and dsh (priority: bundled `resources/dsh-runtime` → PATH → `~/.npm/_npx/*`), probes/starts the Harness, and tells the renderer which URL to load once ready; on quit it only terminates the process it started itself
- `renderer/`: the local UI with two `<webview>` elements hosting the Chat and Harness pages
- `scripts/prepare-runtime.mjs`: prepares the dsh runtime into `dsh-runtime/` (installs from npm automatically when no local dsh exists; prunes sourcemaps, docs and prebuilt binaries for other platforms), packaged into the app by the `afterPack` hook
- Port strategy: prefers reusing 3080; falls back to 3081–3083 when occupied or on startup failure

## Known limitations

- Not code-signed: on other machines the first launch requires right-click → Open
- The Windows NSIS installer must be built on Windows or in CI (cross-building on macOS requires wine)
- The in-app UI text is currently Chinese only

## FAQ

### macOS says "app is damaged and can't be opened"

This is the normal Gatekeeper block for unsigned apps (downloads carry a quarantine flag, and macOS 15 reports "damaged"). To fix:

1. Right-click `DeepSeek Desktop.app` → choose "Open" → click "Open" again;
2. If it still fails, run this in Terminal and open the app again:

```bash
xattr -cr "/Applications/DeepSeek Desktop.app"
```

> Signing and notarizing with an Apple Developer account would remove this warning entirely.

## License

MIT
