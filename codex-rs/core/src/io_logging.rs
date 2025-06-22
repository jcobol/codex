use once_cell::sync::Lazy;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::sync::Mutex;

use ctor::dtor;

/// Environment variable that enables I/O logging when set to a file path.
pub const IO_LOG_ENV_VAR: &str = "CODEX_IO_LOG";

static IO_LOGGER: Lazy<Option<Mutex<BufWriter<File>>>> = Lazy::new(|| {
    let path = std::env::var(IO_LOG_ENV_VAR).ok()?;
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()?;
    Some(Mutex::new(BufWriter::new(file)))
});

#[dtor]
fn flush_on_exit() {
    flush_log();
}

fn log(direction: &str, text: &str) {
    if let Some(ref mutex) = *IO_LOGGER {
        if let Ok(mut writer) = mutex.lock() {
            let _ = writeln!(writer, "{direction}: {text}");
        }
    }
}

/// Log input sent to the model.
pub fn log_input(text: &str) {
    log("input", text);
}

/// Log output received from the model.
pub fn log_output(text: &str) {
    log("output", text);
}

/// Flush the I/O log to disk if logging is enabled.
pub fn flush_log() {
    if let Some(ref mutex) = *IO_LOGGER {
        if let Ok(mut writer) = mutex.lock() {
            let _ = writer.flush();
        }
    }
}
