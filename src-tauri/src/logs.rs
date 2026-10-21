use std::{pin::pin, time::Duration};

use futures::{AsyncBufReadExt, StreamExt};
use k8s_openapi::api::core::v1::Pod;
use kube::{Api, api::LogParams};
use serde::Serialize;
use tauri::{State, async_runtime, ipc::Channel};
use tokio::time::{MissedTickBehavior, interval};

use crate::{clients::Clients, kubeconfig::KubeconfigSources, sessions::Sessions};

/// Lines are sent in batches at most this often, so a chatty container costs
/// a few renders per second instead of one per line.
const FLUSH_INTERVAL: Duration = Duration::from_millis(100);

/// History loaded when a log tab opens, like `kubectl logs --tail`.
const TAIL_LINES: i64 = 1000;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogEvent {
    Lines {
        lines: Vec<String>,
    },
    /// The container stopped writing, for example because it exited.
    Ended,
    Error {
        message: String,
    },
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn open_logs(
    context: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    on_event: Channel<LogEvent>,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
    sessions: State<'_, Sessions>,
) -> Result<u64, String> {
    let client = clients.get(&sources, &context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let params = LogParams {
        container,
        follow: true,
        tail_lines: Some(TAIL_LINES),
        ..Default::default()
    };
    let stream = api
        .log_stream(&pod, &params)
        .await
        .map_err(|e| e.to_string())?;

    let task = async_runtime::spawn(async move {
        let mut lines = pin!(stream.lines());
        let mut batch = Vec::new();
        let mut ticker = interval(FLUSH_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

        let last = loop {
            tokio::select! {
                line = lines.next() => match line {
                    Some(Ok(line)) => batch.push(line),
                    Some(Err(err)) => break LogEvent::Error { message: err.to_string() },
                    None => break LogEvent::Ended,
                },
                _ = ticker.tick(), if !batch.is_empty() => {
                    let lines = std::mem::take(&mut batch);
                    if on_event.send(LogEvent::Lines { lines }).is_err() {
                        return;
                    }
                }
            }
        };
        if !batch.is_empty() {
            let _ = on_event.send(LogEvent::Lines { lines: batch });
        }
        let _ = on_event.send(last);
    });
    Ok(sessions.insert(task, None))
}
