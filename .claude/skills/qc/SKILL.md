---
name: qc
description: QC Boss Timer changes by driving the real desktop app (a debug build with mock data and its own app ID) and screenshotting its windows. Use after implementing requested changes, before cutting a release, or when the user asks you to test, verify, or QC something yourself.
---

# QC the real app

Test what the user asked for in the **running desktop app**, not only in a browser preview. Browser previews miss native behavior: windows showing and hiding, focus, always-on-top, close handling, crash recovery, Rust-side settings and the session log.

## Ground rules

- **Never touch the user's data or accounts.** Always run the QC build under the identifier `io.github.adeshkadambi.bosstimer.qc` with `VITE_QC=1`, so it has its own settings and sessions and uses mock tasks and events. Never copy tokens or `dev-secrets.json` into it, and never read `src-tauri/google-client.json` or any `dev-secrets.json` (see memory).
- **Screenshot only the app's windows** with `scripts/qc/shot.sh`. Never capture the full screen, which shows the user's other apps.
- **Don't close the main window by accident.** With no timer active, closing it quits the app. If the app quits unexpectedly, the user may have closed it. Ask them to leave it open, then relaunch.
- Tell the user before starting: a test window will appear on their screen, it may jump to the front, and alarms ring at a low volume.

## 1. Write the test plan first

Use `git log`/`git diff` since the last release tag to list the changes, then write a short plan before touching the app.

- **Each requested change:** cover the happy path, every state it can be in, and every way to reach it (mouse, keyboard, tray-equivalent command).
- **Edge cases:**
  - focus in an input
  - another view open (Settings) when something fires
  - the window hidden or closed
  - the app restarted mid-way
  - empty or missing data
  - narrow and wide windows
- **Regressions:** neighbouring features that share code with the change. For example, after touching the timer widget, re-test the floating window too.

## 2. Static checks

```sh
npm run build                                   # tsc + vite
cd src-tauri && cargo clippy --all-targets && cargo test
```

## 3. Launch the QC build

Run it with `run_in_background: true`. A plain `&` in a foreground command gets killed when that command ends. Write the output to a log in the scratchpad: `q.mjs` reads results from it.

```sh
source ~/.cargo/env && BOSS_TIMER_QC_PORT=47811 VITE_QC=1 npm run tauri dev -- \
  --config '{"identifier":"io.github.adeshkadambi.bosstimer.qc"}' > "$SCRATCH/qc/app.log" 2>&1
```

Wait until the log shows `qc bridge listening`. Then confirm the setup before testing anything:
- 6 mock tasks are showing.
- `~/Library/Application Support/io.github.adeshkadambi.bosstimer.qc/` exists.

Lower the alarm volume first:
`invoke('update_settings',{patch:{volume:10}})`.

## 4. Drive it and check it

Set `QC_LOG=$SCRATCH/qc/app.log` for every command.

| Do | How |
|---|---|
| Run JS in a window and get a result | `node scripts/qc/q.mjs main '<async body; return {...}>'` (or `timer` for the floating window) |
| Call a Rust command | inside the body: `await window.__TAURI_INTERNALS__.invoke('get_timer_state')`; see `invoke_handler!` in `src-tauri/src/lib.rs` |
| Click / type | `el.click()`; for inputs set `value`, then dispatch `input` and `change` |
| Keys | `el.dispatchEvent(new KeyboardEvent('keydown',{key:'4',bubbles:true,cancelable:true}))` |
| Close a window like its close button | `node scripts/qc/close.mjs main` |
| Which windows are on screen | `osascript -l JavaScript scripts/qc/wins.js $(pgrep -f target/debug/boss-timer \| head -1)` (layer > 0 = always on top) |
| Which app is in front | `osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'` |
| Put another app in front (to test "comes to front") | `osascript -e 'tell application "Ghostty" to activate'` |
| Screenshot | `scripts/qc/shot.sh "$SCRATCH/qc/01-name.png" main\|timer`, then Read the PNG |
| Session log | `sqlite3 ~/Library/Application\ Support/io.github.adeshkadambi.bosstimer.qc/sessions.sqlite3 "select * from sessions"` |
| Resize the window | `invoke('plugin:window\|set_size',{label:'main',value:{Logical:{width:1400,height:640}}})` |

For each check, return the facts that prove it from the page. Don't assume an action worked; read back the phase, classes, text and focus. Look at a screenshot for anything visual. Number screenshots in order so the report can refer to them.

**Timers:** the minimum is 1 minute. Start with `dur = '1'`, then poll `get_timer_state` until `phase === 'report'` (a loop with `sleep 2`, inside a Bash call with a long timeout). Do other checks while you wait.

**Restart and recovery:** editing Rust rebuilds and restarts the app, and any running timer comes back as "Stopped". Use that on purpose to test recovery. Wait for a *second* `qc bridge listening` line before continuing. Editing front-end code hot-reloads the page; wait about 3 s.

## 5. Things this setup can't check (so reason about them, or ask)

- **Synthetic key events don't run the browser's default action.** Enter or Space on a focused button won't "click" it. Think through what the real key would do. This hid a real bug once: Enter on the auto-focused rating cell re-picked it.
- **Setting the window size from code ignores min/max size.** Window limits can only be checked by a person dragging.
- **No Accessibility permission** means no real mouse clicks or menu-bar or tray clicks. Use the command that the tray item calls (`stop`, `pause`, …) instead.
- **Sound:** the log shows the alarm was triggered, but you can't hear it. Mention this.
- **Linux/Ubuntu behavior** (Wayland, WebKitGTK) can't be tested here. Say so when the change touches it.

For quick layout checks across many states, the browser previews are still faster: `npx vite --port 1421`, then headless Chrome screenshots of `/?timer=running|paused|last|up|stopped|logged[&solo]` and `/timer.html?state=…`.

## 6. Fix, re-test, clean up

- **Bugs found:** fix them, re-run the failing check plus anything near it, and commit each fix with a message that explains the bug.
- **Cleanup:** stop the app, delete the QC data, and delete your screenshots:

```sh
pkill -f target/debug/boss-timer; pkill -f 'vite$'
rm -rf ~/Library/Application\ Support/io.github.adeshkadambi.bosstimer.qc \
       ~/Library/WebKit/io.github.adeshkadambi.bosstimer.qc ~/Library/Caches/io.github.adeshkadambi.bosstimer.qc
```

- **Never** delete `io.github.adeshkadambi.bosstimer` (the user's real data) or `dev.bosstimer.app`.

## 7. Report

Lead with the result: everything passed, or what broke and whether it's fixed. Then:
- one line per area tested, stating what was checked
- bugs found and fixed, in plain words, with the user-visible symptom
- what couldn't be tested and why (section 5), with a one-line suggestion for the user to check it by hand
- that the test used its own data and touched nothing of theirs
