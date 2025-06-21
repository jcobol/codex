use std::sync::Arc;
use std::time::Duration;

use codex_core::Codex;
use codex_core::ModelProviderInfo;
use codex_core::WireApi;
use codex_core::exec::CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR;
use codex_core::protocol::{EventMsg, InputItem, Op};
use tempfile::TempDir;
use tokio::time::timeout;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};
mod test_support;
use codex_core::token_metering::TOKEN_LOG_ENV_VAR;
use codex_core::token_metering::flush_log;
use test_support::load_default_config_for_test;
use serial_test::serial;

fn sse_with_usage() -> String {
    "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"index\":0}]}\n\n".to_string()
        + "data: {\"choices\":[{\"delta\":{},\"index\":0,\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n"
        + "data: [DONE]\n\n"
}

fn sse_without_usage() -> String {
    "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"index\":0}]}\n\n".to_string()
        + "data: {\"choices\":[{\"delta\":{},\"index\":0,\"finish_reason\":\"stop\"}]}\n\n"
        + "data: [DONE]\n\n"
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[serial]
async fn logs_token_usage() {
    if std::env::var(CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR).is_ok() {
        println!("Skipping test because network is disabled");
        return;
    }

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(sse_with_usage(), "text/event-stream"),
        )
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let log_path = std::path::Path::new("/tmp/codex_token_test.csv");

    unsafe {
        std::env::set_var(TOKEN_LOG_ENV_VAR, &log_path);
        std::env::set_var("OPENAI_REQUEST_MAX_RETRIES", "0");
        std::env::set_var("OPENAI_STREAM_MAX_RETRIES", "0");
        std::env::set_var("OPENAI_STREAM_IDLE_TIMEOUT_MS", "2000");
    }

    let mut config = load_default_config_for_test(&tmp);
    config.model_provider = ModelProviderInfo {
        name: "mock".into(),
        base_url: format!("{}/v1", server.uri()),
        env_key: Some("PATH".into()),
        env_key_instructions: None,
        wire_api: WireApi::Chat,
    };
    config.model = "gpt-test".into();

    let ctrl_c = Arc::new(tokio::sync::Notify::new());
    let (codex, _init_id) = Codex::spawn(config, ctrl_c).await.unwrap();

    codex
        .submit(Op::UserInput {
            items: vec![InputItem::Text { text: "hi".into() }],
        })
        .await
        .unwrap();

    loop {
        let ev = timeout(Duration::from_secs(2), codex.next_event())
            .await
            .unwrap()
            .unwrap();
        if matches!(ev.msg, EventMsg::TaskComplete(_)) {
            break;
        }
    }

    tokio::time::sleep(Duration::from_millis(100)).await;
    flush_log();
    let contents = std::fs::read_to_string(log_path).unwrap();
    let last_line = contents.lines().last().unwrap();
    assert_eq!(last_line, "gpt-test,10,5");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[serial]
async fn estimates_token_usage_when_missing() {
    if std::env::var(CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR).is_ok() {
        println!("Skipping test because network is disabled");
        return;
    }

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(sse_without_usage(), "text/event-stream"),
        )
        .mount(&server)
        .await;

    let tmp = TempDir::new().unwrap();
    let log_path = std::path::Path::new("/tmp/codex_token_test.csv");

    unsafe {
        std::env::set_var(TOKEN_LOG_ENV_VAR, &log_path);
        std::env::set_var("OPENAI_REQUEST_MAX_RETRIES", "0");
        std::env::set_var("OPENAI_STREAM_MAX_RETRIES", "0");
        std::env::set_var("OPENAI_STREAM_IDLE_TIMEOUT_MS", "2000");
    }

    let mut config = load_default_config_for_test(&tmp);
    config.model_provider = ModelProviderInfo {
        name: "mock".into(),
        base_url: format!("{}/v1", server.uri()),
        env_key: Some("PATH".into()),
        env_key_instructions: None,
        wire_api: WireApi::Chat,
    };
    config.model = "gpt-3.5-turbo".into();

    let ctrl_c = Arc::new(tokio::sync::Notify::new());
    let (codex, _init_id) = Codex::spawn(config, ctrl_c).await.unwrap();

    codex
        .submit(Op::UserInput { items: vec![InputItem::Text { text: "hi".into() }] })
        .await
        .unwrap();

    loop {
        let ev = timeout(Duration::from_secs(1), codex.next_event())
            .await
            .unwrap()
            .unwrap();
        if matches!(ev.msg, EventMsg::TaskComplete(_)) {
            break;
        }
    }

    tokio::time::sleep(Duration::from_millis(100)).await;
    flush_log();
    let contents = std::fs::read_to_string(&log_path).unwrap();
    let last_line = contents.lines().last().unwrap();
    let parts: Vec<&str> = last_line.split(',').collect();
    assert_eq!(parts[0], "gpt-3.5-turbo");
    let prompt_tokens: usize = parts[1].parse().unwrap();
    let completion_tokens: usize = parts[2].parse().unwrap();

    assert!(prompt_tokens > 0);
    assert!(completion_tokens > 0);
}
