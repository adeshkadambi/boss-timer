# Boss Timer

A minimal pixel-art focus timer for macOS and Linux. It shows today's Google Calendar events and Todoist tasks. Pick a task, set a duration, and a timer drains like a health bar, in a small floating window or right under the task (**Settings → Timer & alarm → Where the timer shows**). When time's up it rings and/or shakes, asks how much of the session was on task, and logs the answer to a Reports heatmap.

`design/screens/` holds the original design canvas files, kept as the visual reference.

## Install

Download the latest build from this repo's **Releases** page.

**macOS** (the `universal.dmg`): open the `.dmg` and drag Boss Timer to Applications. The app isn't signed with an Apple Developer ID, so the first launch is blocked: open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to Boss Timer. You only do this once per version.

**Ubuntu**: use the `.AppImage` if you want in-app updates (the `.deb` can't update itself).

```sh
chmod +x ./<downloaded file>.AppImage && ./<downloaded file>.AppImage
# if it says "No suitable fusermount binary found": sudo apt install fuse3
# or the .deb, updated by downloading each new version:
sudo apt install ./<downloaded file>.deb
```

**First run:** Settings (gear) → Accounts → paste your Todoist API token, paste your Google client ID and secret (see [Google Calendar](#google-calendar-read-only)), then click **Connect Google Calendar** and sign in. You do this once per machine; updates keep it.

The first time the app reads each saved token, macOS may ask for keychain access; click **Always Allow**. After installing a newer version it asks once more, since macOS ties that permission to the exact build.

### Updating

**Settings → Check for updates** (under the section list). If there's a newer release it shows **Update to vX**, which downloads it, checks it was signed by this repo's release key, installs it and restarts. It won't update while a timer is running. macOS updates installed this way don't need **Open Anyway** again, but macOS may ask for keychain access once more (click **Always Allow**).

### Making a release

1. One time: add the repo secret `TAURI_SIGNING_PRIVATE_KEY` (repo → Settings → Secrets and variables → Actions), the update signing key: `gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/boss-timer.key`. Its public half is in `tauri.conf.json` (`plugins.updater.pubkey`). Back up `~/.tauri/boss-timer.key`: without it, installed copies can't be updated (you'd have to reinstall by hand).
2. Bump `version` in `src-tauri/tauri.conf.json` and `package.json`, commit, then tag and push:
   ```sh
   git tag v0.1.0 && git push origin v0.1.0
   ```
3. GitHub Actions builds the universal `.dmg` on macOS and the `.deb` + `.AppImage` on Ubuntu, plus the signed update files and `latest.json`, and attaches them to the release (about 15 minutes). Installed apps find it through `releases/latest/download/latest.json`.

## Run it

Needs Node 22.18+ and Rust (via [rustup](https://rustup.rs)).

```sh
npm install
npm run tauri dev       # the app
npm run tauri build     # release bundles for this OS
npm run dev             # front end only, in a browser at http://localhost:1420 (mock data, no timer)
```

In the browser preview, `timer.html?state=running|paused|last|up|stopped|logged` shows each timer state. The mock data and previews are dev-only and are left out of production builds.

### Ubuntu prerequisites

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libasound2-dev libdbus-1-dev
```

`libasound2-dev` is for the alarm sound and `libdbus-1-dev` is for the Secret Service keychain. macOS needs the Xcode Command Line Tools.

Linux bundles: `.deb`, `.AppImage`, `.rpm`. macOS: `.app`, `.dmg`. A `.dmg` has to be built on a Mac; for releases, use the GitHub Actions workflow (see Making a release).

## Connect your accounts

Open Settings (gear icon) → Accounts.

### Todoist

Paste your personal API token from Todoist: Settings → Integrations → Developer → API token. It's stored in the OS keychain.

### Google Calendar (read-only)

You create one Google OAuth client, paste it into the app once per machine, then sign in. Release builds are public, so they don't include a client.

**Once, in [Google Cloud Console](https://console.cloud.google.com/):**

1. Create a project.
2. APIs & Services → Library → enable **Google Calendar API**.
3. APIs & Services → OAuth consent screen: User type **External**. Add the scope `.../auth/calendar.readonly` and add your Google account as a test user.
4. Still on the consent screen, click **Publish app**. Otherwise Google signs you out every 7 days. Because calendar access is a sensitive scope, Google shows an "unverified app" warning when you sign in; click **Advanced → Go to Boss Timer** to continue. That's fine for personal use.
5. APIs & Services → Credentials → Create credentials → OAuth client ID → Application type **Desktop app**. Note its client ID and secret (or download the JSON).

**On each machine (MacBook, Ubuntu desktop):** Settings → Accounts → Google: paste the client ID and secret, save, then **Connect Google Calendar** and sign in in your browser. The secret goes in the keychain; each machine keeps its own sign-in.

**Local builds only:** if you build the app yourself, you can save the client JSON as `src-tauri/google-client.json` (gitignored) and it's compiled in, so Accounts skips the paste step. Never do that for builds you publish: anything compiled in can be extracted.

**If you see "Reconnect Google":** Google ended the sign-in. That happens every 7 days while the consent screen is in "Testing"; publishing the app (step 4) stops it.

## Alarm sounds

The alarm sounds (chime, 8-bit bell, soft beep) are generated in code, so nothing needs downloading. Pick one and set its volume in Settings → Timer & alarm.

## Keyboard

In the timer (the floating window, or Today when the timer shows there): **Space** pauses or resumes, **1–5** picks how much was on task, **Enter** logs it, **Esc** skips the question (the time counts as timed, not focused).

In Today, drag the bar between Tasks and Calendar to resize them (or focus it and use **← →**). Double-click it to reset.

## Linux notes

- **Wayland (Ubuntu's default):** apps can't place their own windows, so the timer's position isn't restored, and GNOME ignores "keep above other windows". Press **Alt+Space** on the timer and pick **Always on Top**.
- **Tray:** needs AppIndicator support. Ubuntu ships it; other GNOME distros may need the AppIndicator extension. Everything in the tray menu is also reachable in the app, so it works without one.
- **No title bar:** the main window draws its own minimize, maximize and close buttons at the top right. Drag the top row to move the window, double-click it to maximize, and resize from the edges.
- **Blank window:** on some GPU/driver setups WebKitGTK renders a blank window. Launch with `WEBKIT_DISABLE_DMABUF_RENDERER=1 boss-timer`.

## macOS notes

- **Keychain prompts:** macOS ties keychain permission to the exact app binary, so every rebuild would ask again. To avoid that, dev builds (`npm run tauri dev`) keep secrets in `dev-secrets.json` in the app config dir, readable only by you, copying each one over from the keychain once. Release builds use the keychain and ask at most once per secret after you install a new build; click **Always Allow**.
- **No title bar:** the main window draws its own close, minimize and maximize squares at the top left. Drag the top row to move the window and double-click it to maximize.
- Closing the Today window while a timer runs only hides it. Bring it back from the tray (**Show Today**) or the Dock. Quit from the tray.

## Where things are stored

| What | Where |
|---|---|
| Settings | `settings.json` in the app config dir (`~/Library/Application Support/io.github.adeshkadambi.bosstimer/` on macOS, `~/.config/io.github.adeshkadambi.bosstimer/` on Linux) |
| Sessions | `sessions.sqlite3` in the app data dir (same folder on macOS, `~/.local/share/io.github.adeshkadambi.bosstimer/` on Linux) |
| Tokens and secrets | OS keychain, service `io.github.adeshkadambi.bosstimer` (dev builds: `dev-secrets.json` in the config dir) |

Everything is per machine: your MacBook and Ubuntu desktop each have their own settings, sign-ins and session history. Reports on one don't include sessions from the other (syncing sessions is out of scope for v1).


## Security notes

- **Todoist token, Google sign-in, Google client secret:** release builds keep them in the OS keychain. Dev builds keep them in `dev-secrets.json` in the app config dir, readable only by your user. None of them are ever sent to the web page except as "connected / not connected".
- **Google OAuth:** authorization code + PKCE, a random `state` checked on return, and a one-shot listener bound to `127.0.0.1` only. The app asks for read-only calendar access.
- **Google client:** public release builds contain no Google client; you paste yours into Accounts and it's stored in the keychain. `src-tauri/google-client.json` (gitignored) compiles a client into *local* builds only, so don't publish those. Nobody can read your calendar without your own sign-in, which never leaves your machine. If a client secret ever leaks, add a new secret and delete the old one in Google Cloud Console → Credentials.
- **Web page lockdown:** a strict Content Security Policy (no remote scripts, no network access from the page), and all text from Todoist and Google is HTML-escaped before display.

## Code layout

| Path | What's there |
|---|---|
| `index.html`, `src/main/` | Main window: Today, Settings, Reports |
| `timer.html`, `src/timer/` | Timer widget (`widget.ts`, also used inline in Today) and the floating window |
| `src/lib/` | Shared front end: API wrappers, themes, mascot renderer, icons, settings |
| `src/styles/` | Fonts and the pixel chrome (`.pxbox`, `.btn`, …) |
| `src-tauri/src/engine.rs` | Timer state machine (pure, unit-tested) |
| `src-tauri/src/timer.rs` | Timer runtime: ticks, commands, timer window, crash recovery |
| `src-tauri/src/db.rs` | Session log and reports (SQLite) |
| `src-tauri/src/todoist.rs`, `google.rs`, `sync.rs` | Todoist v1, Google Calendar OAuth + events, sync and account commands |
| `src-tauri/src/audio.rs` | Alarm synthesis and playback (rodio) |
| `src-tauri/src/tray.rs` | Tray icon and menu |
| `src-tauri/src/updates.rs` | In-app updates from GitHub Releases (release builds only) |
| `scripts/gen-icons.mjs` | Draws the app and tray icons from the mascot (`npm run icons`) |
| `licenses/fonts/` | OFL licenses for the bundled fonts (shipped with the app) |

## Tests

```sh
cd src-tauri && cargo test     # engine, sleep handling, reports, Todoist/Google parsing, alarms
npx tsc --noEmit               # front-end types
```

To drive the desktop app from a script without touching your real data or accounts, run a debug build under its own app ID with mock tasks and the QC bridge on:

```sh
BOSS_TIMER_QC_PORT=47811 VITE_QC=1 npm run tauri dev -- --config '{"identifier":"io.github.adeshkadambi.bosstimer.qc"}'
```

Each connection to `127.0.0.1:47811` sends a window label (`main` or `timer`) on the first line and JavaScript after it, which runs in that window; `!close main` closes a window as its close button would, and `!show main` brings it back. See `src-tauri/src/qc.rs`; helpers in `scripts/qc/`, and the full routine in `.claude/skills/qc/SKILL.md`. The bridge exists only in debug builds.
