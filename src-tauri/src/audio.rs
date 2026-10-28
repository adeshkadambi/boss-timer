//! Alarm sounds, played with rodio on one audio thread.
//!
//! The sounds are synthesized, so no audio files ship with the app.

use rodio::{buffer::SamplesBuffer, OutputStreamBuilder, Sink, Source};
use std::{
    f32::consts::TAU,
    sync::mpsc::{self, Sender},
    thread,
};

const RATE: u32 = 44_100;

enum Cmd {
    Alarm(String),
    Volume(f32),
}

#[derive(Clone)]
pub struct Audio {
    tx: Sender<Cmd>,
}

impl Audio {
    pub fn start(volume: u8) -> Self {
        let (tx, rx) = mpsc::channel::<Cmd>();
        thread::Builder::new()
            .name("audio".into())
            .spawn(move || {
                // The output stream isn't Send, so it lives on this thread.
                let stream = match OutputStreamBuilder::open_default_stream() {
                    Ok(mut s) => {
                        s.log_on_drop(false);
                        Some(s)
                    }
                    Err(e) => {
                        log::warn!("no audio output: {e}");
                        None
                    }
                };
                let mut volume = volume.min(100) as f32 / 100.0;
                for cmd in rx {
                    match cmd {
                        Cmd::Volume(v) => volume = v,
                        Cmd::Alarm(kind) => {
                            let Some(stream) = &stream else { continue };
                            let sink = Sink::connect_new(stream.mixer());
                            sink.set_volume(volume);
                            sink.append(alarm(&kind));
                            sink.detach();
                        }
                    }
                }
            })
            .expect("spawn audio thread");
        Self { tx }
    }

    pub fn alarm(&self, kind: &str) {
        let _ = self.tx.send(Cmd::Alarm(kind.to_string()));
    }

    pub fn set_volume(&self, volume: u8) {
        let _ = self.tx.send(Cmd::Volume(volume.min(100) as f32 / 100.0));
    }
}

/// Plays an alarm sound once (Settings → Preview).
#[tauri::command]
pub fn preview_alarm(audio: tauri::State<'_, Audio>, sound: String) {
    audio.alarm(&sound);
}

// ---- synthesized alarms ------------------------------------------------------------------------

/// A note: frequency, start and length in seconds, waveform.
struct Note(f32, f32, f32, Wave);
#[derive(Clone, Copy)]
enum Wave {
    /// Sine with a bell-like exponential decay and a soft octave partial.
    Bell,
    /// 8-bit square with a short decay.
    Square,
    /// Plain sine with short fades.
    Sine,
}

fn render(notes: &[Note], amp: f32) -> Vec<f32> {
    let end = notes.iter().map(|n| n.1 + n.2).fold(0.0, f32::max) + 0.05;
    let mut buf = vec![0.0f32; (end * RATE as f32) as usize];
    for &Note(freq, start, len, wave) in notes {
        let s0 = (start * RATE as f32) as usize;
        let n = (len * RATE as f32) as usize;
        for i in 0..n {
            let t = i as f32 / RATE as f32;
            let fade_in = (t / 0.004).min(1.0);
            let fade_out = ((len - t) / 0.01).clamp(0.0, 1.0);
            let ph = TAU * freq * t;
            let v = match wave {
                Wave::Bell => (ph.sin() + 0.3 * (2.0 * ph).sin()) * (-t * 4.5).exp(),
                Wave::Square => (if ph.sin() >= 0.0 { 1.0 } else { -1.0 }) * 0.45 * (-t * 3.0).exp(),
                Wave::Sine => ph.sin(),
            };
            if let Some(slot) = buf.get_mut(s0 + i) {
                *slot += v * fade_in * fade_out * amp;
            }
        }
    }
    for s in &mut buf {
        *s = s.clamp(-1.0, 1.0);
    }
    buf
}

/// About 2.5 s of sound for each alarm choice.
pub fn alarm_samples(kind: &str) -> Vec<f32> {
    match kind {
        "bell8" => {
            let arp = [523.25, 659.25, 783.99, 1046.5];
            let mut notes = vec![];
            for rep in 0..3 {
                for (i, f) in arp.iter().enumerate() {
                    notes.push(Note(*f, rep as f32 * 0.75 + i as f32 * 0.1, 0.12, Wave::Square));
                }
            }
            render(&notes, 0.35)
        }
        "beep" => {
            let notes: Vec<Note> = (0..6).map(|i| Note(880.0, i as f32 * 0.4, 0.16, Wave::Sine)).collect();
            render(&notes, 0.3)
        }
        _ => {
            // chime: C6 E6 G6, twice
            let mut notes = vec![];
            for rep in 0..2 {
                for (i, f) in [1046.5, 1318.5, 1568.0].iter().enumerate() {
                    notes.push(Note(*f, rep as f32 * 1.2 + i as f32 * 0.22, 0.9, Wave::Bell));
                }
            }
            render(&notes, 0.28)
        }
    }
}

fn alarm(kind: &str) -> impl Source<Item = f32> + Send {
    SamplesBuffer::new(1, RATE, alarm_samples(kind))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alarms_are_short_and_in_range() {
        for k in ["chime", "bell8", "beep"] {
            let s = alarm_samples(k);
            let secs = s.len() as f32 / RATE as f32;
            assert!((1.5..3.5).contains(&secs), "{k}: {secs}s");
            assert!(s.iter().all(|v| (-1.0..=1.0).contains(v)));
            assert!(s.iter().any(|v| v.abs() > 0.1), "{k} is silent");
        }
    }
}
