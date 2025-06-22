use once_cell::sync::Lazy;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::sync::Mutex;

use ctor::dtor;
use tiktoken_rs::{ChatCompletionRequestMessage, get_bpe_from_model, num_tokens_from_messages};

/// Environment variable that enables token logging when set to a file path.
pub const TOKEN_LOG_ENV_VAR: &str = "CODEX_TOKEN_LOG";

static TOKEN_LOGGER: Lazy<Option<Mutex<BufWriter<File>>>> = Lazy::new(|| {
    let path = std::env::var(TOKEN_LOG_ENV_VAR).ok()?;
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

/// Append a token usage record to the CSV log if enabled.
pub fn record_usage(model: &str, prompt_tokens: u64, completion_tokens: u64) {
    if let Some(ref mutex) = *TOKEN_LOGGER {
        if let Ok(mut writer) = mutex.lock() {
            let _ = writeln!(writer, "{model},{prompt_tokens},{completion_tokens}");
        }
    }
}

/// Flush the log to disk if logging is enabled.
pub fn flush_log() {
    if let Some(ref mutex) = *TOKEN_LOGGER {
        if let Ok(mut writer) = mutex.lock() {
            let _ = writer.flush();
        }
    }
}

/// Count the number of tokens in chat messages using tiktoken.
pub fn count_prompt_tokens(
    model: &str,
    messages: &[ChatCompletionRequestMessage],
) -> Option<usize> {
    num_tokens_from_messages(model, messages).ok()
}

/// Count tokens for plain text using tiktoken.
pub fn count_text_tokens(model: &str, text: &str) -> Option<usize> {
    let bpe = get_bpe_from_model(model).ok()?;
    Some(bpe.encode_with_special_tokens(text).len())
}
