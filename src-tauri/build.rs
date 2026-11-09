//! Builds the Tauri app, and bakes in a Google OAuth client if one is provided, so
//! Settings → Accounts only needs a "Connect" click.
//!
//! The client comes from (first match wins):
//!   1. env vars BOSS_TIMER_GOOGLE_CLIENT_ID and BOSS_TIMER_GOOGLE_CLIENT_SECRET (e.g. CI secrets)
//!   2. src-tauri/google-client.json, the file Google Cloud Console downloads for a
//!      "Desktop app" OAuth client (gitignored)
//!
//! It also bakes in the Supabase project used for cloud sync, from (first match wins):
//!   1. env vars BOSS_TIMER_SUPABASE_URL and BOSS_TIMER_SUPABASE_KEY (e.g. CI variables)
//!   2. src-tauri/supabase.json: {"url": "https://xxxx.supabase.co", "key": "sb_publishable_..."} (gitignored)
//!
//! The publishable key (sb_publishable_…, or a legacy anon key) is public by design: row-level security decides what it can reach. Never use a secret
//! (sb_secret_…) or service_role key here.
//!
//! Google doesn't treat a desktop client secret as confidential, but it stays out of git anyway.

use std::{env, fs};

const ID_VAR: &str = "BOSS_TIMER_GOOGLE_CLIENT_ID";
const SECRET_VAR: &str = "BOSS_TIMER_GOOGLE_CLIENT_SECRET";
const FILE: &str = "google-client.json";
const SUPABASE_FILE: &str = "supabase.json";
const SUPABASE_URL_VAR: &str = "BOSS_TIMER_SUPABASE_URL";
const SUPABASE_KEY_VAR: &str = "BOSS_TIMER_SUPABASE_KEY";

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

fn supabase_from_file() -> Option<(String, String)> {
    let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(SUPABASE_FILE).ok()?).ok()?;
    Some((json.get("url")?.as_str()?.to_string(), json.get("key")?.as_str()?.to_string()))
}

fn main() {
    println!("cargo:rerun-if-changed={SUPABASE_FILE}");
    println!("cargo:rerun-if-env-changed={SUPABASE_URL_VAR}");
    println!("cargo:rerun-if-env-changed={SUPABASE_KEY_VAR}");
    let supabase = match (env::var(SUPABASE_URL_VAR), env::var(SUPABASE_KEY_VAR)) {
        (Ok(url), Ok(key)) if !url.trim().is_empty() && !key.trim().is_empty() => Some((url, key)),
        _ => supabase_from_file(),
    };
    if let Some((url, key)) = supabase {
        println!("cargo:rustc-env=BT_SUPABASE_URL={}", url.trim());
        println!("cargo:rustc-env=BT_SUPABASE_KEY={}", key.trim());
    }

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
