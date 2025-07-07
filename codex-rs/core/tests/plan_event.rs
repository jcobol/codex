use std::time::Duration;

use codex_core::Codex;
use codex_core::ModelProviderInfo;
use codex_core::WireApi;
use codex_core::exec::CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR;
use codex_core::protocol::{EventMsg, InputItem, Op};

mod test_support;
use tempfile::TempDir;
use test_support::load_default_config_for_test;
use tokio::time::timeout;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn sse_completed(id: &str) -> String {
    format!(
        "event: response.completed\ndata: {{\"type\":\"response.completed\",\"response\":{{\"id\":\"{}\",\"output\":[]}}}}\n\n\n",
        id
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn emits_plan_event_first() {
    if std::env::var(CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR).is_ok() {
        println!("Skipping test because network is disabled");
        return;
    }

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/responses"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(sse_completed("resp"), "text/event-stream"),
        )
        .mount(&server)
        .await;

    unsafe {
        std::env::set_var("OPENAI_REQUEST_MAX_RETRIES", "0");
        std::env::set_var("OPENAI_STREAM_MAX_RETRIES", "0");
    }

    let tmp = TempDir::new().unwrap();
    let mut config = load_default_config_for_test(&tmp);
    config.model_provider = ModelProviderInfo {
        name: "openai".into(),
        base_url: format!("{}/v1", server.uri()),
        env_key: Some("PATH".into()),
        env_key_instructions: None,
        wire_api: WireApi::Responses,
    };

    let ctrl_c = std::sync::Arc::new(tokio::sync::Notify::new());
    let (codex, _init_id) = Codex::spawn(config, ctrl_c.clone()).await.unwrap();

    codex
        .submit(Op::UserInput {
            items: vec![InputItem::Text { text: "hi".into() }],
        })
        .await
        .unwrap();

    // Wait for TaskStarted
    loop {
        let ev = timeout(Duration::from_secs(1), codex.next_event())
            .await
            .unwrap()
            .unwrap();
        if matches!(ev.msg, EventMsg::TaskStarted) {
            break;
        }
    }

    // Next event should be AgentPlan
    let ev = timeout(Duration::from_secs(1), codex.next_event())
        .await
        .unwrap()
        .unwrap();
    match ev.msg {
        EventMsg::AgentPlan(_) => {}
        other => panic!("unexpected event: {:?}", other),
    }
}
