use codex_core::io_logging::{IO_LOG_ENV_VAR, flush_log, log_input, log_output};
use tempfile::TempDir;

#[test]
fn io_logging_appends_lines() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("io.log");
    unsafe {
        std::env::set_var(IO_LOG_ENV_VAR, &path);
    }
    log_input("hello");
    log_output("world");
    flush_log();
    let contents = std::fs::read_to_string(&path).unwrap();
    let lines: Vec<_> = contents.lines().collect();
    assert_eq!(lines.len(), 2);
    assert!(lines[0].contains("input"));
    assert!(lines[1].contains("output"));
}
