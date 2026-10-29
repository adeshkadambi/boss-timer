//! QC bridge for driving a debug build from a script. Debug builds only, and only when
//! BOSS_TIMER_QC_PORT is set. Listens on 127.0.0.1; each connection sends a window label on
//! the first line and JavaScript after it, which is evaluated in that window. Scripts report
//! back through `log_frontend`, so results show up in the app's log. Instead of a label, the
//! first line can be `!close <label>` (close it, as its close button would) or `!show <label>`
//! (unminimize, show and focus it, as the tray's Show Today does).

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    thread,
};
use tauri::{AppHandle, Manager};

pub fn start(app: AppHandle) {
    let Some(port) = std::env::var("BOSS_TIMER_QC_PORT").ok().and_then(|p| p.parse::<u16>().ok()) else {
        return;
    };
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => return log::error!("qc bridge: {e}"),
    };
    log::warn!("qc bridge listening on 127.0.0.1:{port}");
    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(&stream);
            let mut label = String::new();
            let mut js = String::new();
            if reader.read_line(&mut label).is_err() || reader.read_to_string(&mut js).is_err() {
                continue;
            }
            let label = label.trim();
            let (cmd, label) = match label.split_once(' ') {
                Some((c @ ("!close" | "!show"), l)) => (c, l),
                _ => ("", label),
            };
            let reply = match app.get_webview_window(label) {
                Some(w) if cmd == "!close" => match w.close() {
                    Ok(()) => "ok\n".to_string(),
                    Err(e) => format!("close failed: {e}\n"),
                },
                Some(w) if cmd == "!show" => {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                    "ok\n".to_string()
                }
                Some(w) => match w.eval(&js) {
                    Ok(()) => "ok\n".to_string(),
                    Err(e) => format!("eval failed: {e}\n"),
                },
                None => format!("no window {label:?}\n"),
            };
            let _ = stream.write_all(reply.as_bytes());
        }
    });
}
