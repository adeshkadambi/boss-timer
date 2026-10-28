# Boss Timer

A minimal pixel-art focus timer for macOS and Linux. It shows today's Google Calendar events and Todoist tasks. Pick a task, set a duration, and a small floating timer drains like a health bar. When time's up it rings and/or shakes, asks how much of the session was on task, and logs the answer to a Reports heatmap.

`design/screens/` holds the original design canvas files, kept as the visual reference.

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

Linux bundles: `.deb`, `.AppImage`, `.rpm`. macOS: `.app`, `.dmg`. A `.dmg` has to be built on a Mac; the GitHub Actions workflow in `.github/workflows/release.yml` builds both platforms when you push a `v*` tag.

## Connect your accounts

Open Settings (gear icon) → Accounts.

### Todoist

Paste your personal API token from Todoist: Settings → Integrations → Developer → API token. It's stored in the OS keychain.

### Google Calendar (read-only)

You create one Google OAuth client and build it into the app. After that, each machine just has a **Connect Google Calendar** button.

**Once, in [Google Cloud Console](https://console.cloud.google.com/):**

1. Create a project.
2. APIs & Services → Library → enable **Google Calendar API**.
3. APIs & Services → OAuth consent screen: User type **External**. Add the scope `.../auth/calendar.readonly` and add your Google account as a test user.
4. Still on the consent screen, click **Publish app**. Otherwise Google signs you out every 7 days. Because calendar access is a sensitive scope, Google shows an "unverified app" warning when you sign in; click **Advanced → Go to Boss Timer** to continue. That's fine for personal use.
5. APIs & Services → Credentials → Create credentials → OAuth client ID → Application type **Desktop app**. Download its JSON file.

**On each machine you build on (MacBook, Ubuntu desktop):**

1. Save the downloaded file as `src-tauri/google-client.json`. It's gitignored.
2. Build or run the app (`npm run tauri dev` or `npm run tauri build`). If the file is missing, Accounts asks for a client instead; if it's broken, the build prints a warning.
3. Open Settings → Accounts → **Connect Google Calendar** and sign in in your browser.

Each machine signs in separately and keeps its own sign-in in its keychain.

For the GitHub Actions release build, add the client as repo secrets named `BOSS_TIMER_GOOGLE_CLIENT_ID` and `BOSS_TIMER_GOOGLE_CLIENT_SECRET` instead of the file.

A desktop client secret isn't really confidential (Google says so for installed apps), but it stays out of git anyway. To use a different client without rebuilding, Accounts still has a form for pasting one; it overrides the built-in client until you click **Use built-in client**.

**If you see "Reconnect Google":** Google ended the sign-in. That happens every 7 days while the consent screen is in "Testing"; publishing the app (step 4) stops it.

## Alarm sounds

The alarm sounds (chime, 8-bit bell, soft beep) are generated in code, so nothing needs downloading. Pick one and set its volume in Settings → Timer & alarm.

## Keyboard

In the timer window: **Space** pauses or resumes, **1–5** picks how much was on task, **Enter** logs it, **Esc** skips the question (the time counts as timed, not focused).

## Linux notes

- **Wayland (Ubuntu's default):** apps can't place their own windows, so the timer's position isn't restored, and GNOME ignores "keep above other windows". Press **Alt+Space** on the timer and pick **Always on Top**.
- **Tray:** needs AppIndicator support. Ubuntu ships it; other GNOME distros may need the AppIndicator extension. Everything in the tray menu is also reachable in the app, so it works without one.
- **Blank window:** on some GPU/driver setups WebKitGTK renders a blank window. Launch with `WEBKIT_DISABLE_DMABUF_RENDERER=1 boss-timer`.

## macOS notes

- **Keychain prompts:** macOS ties keychain permission to the exact app binary, so every rebuild would ask again. To avoid that, dev builds (`npm run tauri dev`) keep secrets in `dev-secrets.json` in the app config dir, readable only by you, copying each one over from the keychain once. Release builds use the keychain and ask at most once per secret after you install a new build; click **Always Allow**.
- Closing the Today window while a timer runs only hides it. Bring it back from the tray (**Show Today**) or the Dock. Quit from the tray.

## Where things are stored

| What | Where |
|---|---|
| Settings | `settings.json` in the app config dir (`~/Library/Application Support/dev.bosstimer.app/` on macOS, `~/.config/dev.bosstimer.app/` on Linux) |
| Sessions | `sessions.sqlite3` in the app data dir (same folder on macOS, `~/.local/share/dev.bosstimer.app/` on Linux) |
| Tokens and secrets | OS keychain, service `dev.bosstimer.app` (dev builds: `dev-secrets.json` in the config dir) |

Everything is per machine: your MacBook and Ubuntu desktop each have their own settings, sign-ins and session history. Reports on one don't include sessions from the other (syncing sessions is out of scope for v1).

The bundle identifier `dev.bosstimer.app` is a placeholder. Change it in `src-tauri/tauri.conf.json` to a domain you own before distributing.

## Security notes

- **Todoist token, Google sign-in, Google client secret:** release builds keep them in the OS keychain. Dev builds keep them in `dev-secrets.json` in the app config dir, readable only by your user. None of them are ever sent to the web page except as "connected / not connected".
- **Google OAuth:** authorization code + PKCE, a random `state` checked on return, and a one-shot listener bound to `127.0.0.1` only. The app asks for read-only calendar access.
- **Built-in Google client:** `src-tauri/google-client.json` is gitignored and its values are compiled into the app. Anyone with a copy of the built app could extract the client ID and secret. Google says desktop-app secrets can't be kept confidential and doesn't treat them as secret, and nobody can read your calendar without signing in as you. Still, keep builds private: the release workflow makes **draft** releases; don't publish them from a public repo. If a secret ever leaks, reset it in Google Cloud Console → Credentials.
- **Web page lockdown:** a strict Content Security Policy (no remote scripts, no network access from the page), and all text from Todoist and Google is HTML-escaped before display.

## Code layout

| Path | What's there |
|---|---|
| `index.html`, `src/main/` | Main window: Today, Settings, Reports |
| `timer.html`, `src/timer/` | Floating timer window |
| `src/lib/` | Shared front end: API wrappers, themes, mascot renderer, icons, settings |
| `src/styles/` | Fonts and the pixel chrome (`.pxbox`, `.btn`, …) |
| `src-tauri/src/engine.rs` | Timer state machine (pure, unit-tested) |
| `src-tauri/src/timer.rs` | Timer runtime: ticks, commands, timer window, crash recovery |
| `src-tauri/src/db.rs` | Session log and reports (SQLite) |
| `src-tauri/src/todoist.rs`, `google.rs`, `sync.rs` | Todoist v1, Google Calendar OAuth + events, sync and account commands |
| `src-tauri/src/audio.rs` | Alarm synthesis and playback (rodio) |
| `src-tauri/src/tray.rs` | Tray icon and menu |
| `scripts/gen-icons.mjs` | Draws the app and tray icons from the mascot (`npm run icons`) |
| `licenses/fonts/` | OFL licenses for the bundled fonts (shipped with the app) |

## Tests

```sh
cd src-tauri && cargo test     # engine, sleep handling, reports, Todoist/Google parsing, alarms
npx tsc --noEmit               # front-end types
```
