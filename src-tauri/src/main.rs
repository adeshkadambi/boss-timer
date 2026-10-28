// Prevents an extra console window on Windows in release. Harmless on macOS and Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    boss_timer_lib::run()
}
