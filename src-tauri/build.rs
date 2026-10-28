//! Builds the Tauri app, and bakes in a Google OAuth client if one is provided, so
//! Settings → Accounts only needs a "Connect" click.
//!
//! The client comes from (first match wins):
//!   1. env vars BOSS_TIMER_GOOGLE_CLIENT_ID and BOSS_TIMER_GOOGLE_CLIENT_SECRET (e.g. CI secrets)
//!   2. src-tauri/google-client.json, the file Google Cloud Console downloads for a
//!      "Desktop app" OAuth client (gitignored)
//!
//! Google doesn't treat a desktop client secret as confidential, but it stays out of git anyway.

use std::{env, fs};

const ID_VAR: &str = "BOSS_TIMER_GOOGLE_CLIENT_ID";
const SECRET_VAR: &str = "BOSS_TIMER_GOOGLE_CLIENT_SECRET";
const FILE: &str = "google-client.json";

fn from_file() -> Option<(String, String)> {
    let text = fs::read_to_string(FILE).ok()?;
    let json: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            println!("cargo:warning={FILE} isn't valid JSON ({e}); building without a Google client");
            return None;
        }
    };
    // Google's download nests the fields under "installed".
    let c = json.get("installed").unwrap_or(&json);
    let id = c.get("client_id")?.as_str()?.to_string();
    let secret = c.get("client_secret")?.as_str()?.to_string();
    Some((id, secret))
}

fn main() {
    println!("cargo:rerun-if-changed={FILE}");
    println!("cargo:rerun-if-env-changed={ID_VAR}");
    println!("cargo:rerun-if-env-changed={SECRET_VAR}");

    let client = match (env::var(ID_VAR), env::var(SECRET_VAR)) {
        (Ok(id), Ok(secret)) if !id.trim().is_empty() && !secret.trim().is_empty() => Some((id, secret)),
        _ => from_file(),
    };
    if let Some((id, secret)) = client {
        println!("cargo:rustc-env=BT_GOOGLE_CLIENT_ID={}", id.trim());
        println!("cargo:rustc-env=BT_GOOGLE_CLIENT_SECRET={}", secret.trim());
    }

    tauri_build::build()
}
