use std::{pin::Pin, time::Duration};

use futures::{AsyncBufRead, AsyncBufReadExt, StreamExt};
use jiff::Timestamp;
use k8s_openapi::api::core::v1::Pod;
use kube::{Api, api::LogParams};
use serde::Serialize;
use tauri::{State, async_runtime, ipc::Channel};
use tokio::time::{MissedTickBehavior, interval, sleep};

use crate::{clients::Clients, kubeconfig::KubeconfigSources, sessions::Sessions};

/// Lines are sent in batches at most this often, so a chatty container costs
/// a few renders per second instead of one per line.
const FLUSH_INTERVAL: Duration = Duration::from_millis(100);

/// History loaded when a log tab opens, like `kubectl logs --tail`.
const TAIL_LINES: i64 = 1000;

/// Wait before reconnecting a dropped stream, doubling up to the maximum.
const RETRY_MIN: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(15);

type LogStream = Pin<Box<dyn AsyncBufRead + Send>>;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogEvent {
    Lines {
        lines: Vec<String>,
    },
    /// The stream dropped while the container still runs; retrying.
    Reconnecting,
    /// Streaming again after `Reconnecting`.
    Live,
    /// The container stopped or the pod is gone.
    Ended,
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
    // The first connection reports its error to the caller; later ones retry.
    let stream = api
        .log_stream(&pod, &log_params(container.clone(), None))
        .await
        .map_err(|e| e.to_string())?;

    let task = async_runtime::spawn(follow(api, pod, container, Box::pin(stream), on_event));
    Ok(sessions.insert(task, None))
}

fn log_params(container: Option<String>, since: Option<Timestamp>) -> LogParams {
    LogParams {
        container,
        follow: true,
        // Timestamps let a reconnect resume exactly where the last line was.
        timestamps: true,
        tail_lines: since.is_none().then_some(TAIL_LINES),
        since_time: since,
        ..Default::default()
    }
}

/// Streams until the container stops. Load balancers cut idle connections, so
/// a dropped stream is reopened from the last line while the container runs.
async fn follow(
    api: Api<Pod>,
    pod: String,
    container: Option<String>,
    first: LogStream,
    channel: Channel<LogEvent>,
) {
    let mut cursor = Cursor::default();
    let mut stream = Some(first);
    let mut retry = RETRY_MIN;

    loop {
        if let Some(open) = stream.take()
            && !pump(open, &mut cursor, &channel).await
        {
            return;
        }
        if container_finished(&api, &pod, container.as_deref()).await {
            let _ = channel.send(LogEvent::Ended);
            return;
        }
        if channel.send(LogEvent::Reconnecting).is_err() {
            return;
        }
        sleep(retry).await;
        retry = (retry * 2).min(RETRY_MAX);

        let params = log_params(container.clone(), cursor.last);
        if let Ok(reopened) = api.log_stream(&pod, &params).await {
            retry = RETRY_MIN;
            cursor.resume_after = cursor.last;
            if channel.send(LogEvent::Live).is_err() {
                return;
            }
            stream = Some(Box::pin(reopened));
        }
    }
}

/// Reads one stream to its end. Returns `false` once the UI stopped listening.
async fn pump(stream: LogStream, cursor: &mut Cursor, channel: &Channel<LogEvent>) -> bool {
    let mut lines = stream.lines();
    let mut batch = Vec::new();
    let mut ticker = interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            line = lines.next() => match line {
                Some(Ok(line)) => batch.extend(cursor.accept(&line)),
                Some(Err(_)) | None => break,
            },
            _ = ticker.tick(), if !batch.is_empty() => {
                let lines = std::mem::take(&mut batch);
                if channel.send(LogEvent::Lines { lines }).is_err() {
                    return false;
                }
            }
        }
    }
    batch.is_empty() || channel.send(LogEvent::Lines { lines: batch }).is_ok()
}

/// Tracks the newest line seen, to skip lines a reconnect sends again.
#[derive(Default)]
struct Cursor {
    last: Option<Timestamp>,
    /// After a reconnect, lines at or before this were already shown.
    resume_after: Option<Timestamp>,
}

impl Cursor {
    /// Strips the timestamp from a line, or drops a line already shown.
    fn accept(&mut self, line: &str) -> Option<String> {
        let (stamp, text) = line.split_once(' ').unwrap_or((line, ""));
        let Ok(stamp) = stamp.parse::<Timestamp>() else {
            return Some(line.to_owned());
        };
        if let Some(resume) = self.resume_after {
            if stamp <= resume {
                return None;
            }
            self.resume_after = None;
        }
        self.last = Some(stamp);
        Some(text.to_owned())
    }
}

/// True when there is nothing more to stream: the pod is gone or the
/// container has terminated. Unknown (for example offline) counts as running.
async fn container_finished(api: &Api<Pod>, pod: &str, container: Option<&str>) -> bool {
    match api.get_opt(pod).await {
        Ok(None) => true,
        Ok(Some(pod)) => {
            let statuses = pod
                .status
                .and_then(|s| s.container_statuses)
                .unwrap_or_default();
            let status = match container {
                Some(name) => statuses.iter().find(|s| s.name == name),
                None => statuses.first(),
            };
            status
                .and_then(|s| s.state.as_ref())
                .is_some_and(|state| state.terminated.is_some())
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_stripped() {
        let mut cursor = Cursor::default();
        let line = cursor.accept("2026-10-21T07:00:00.5Z GET /health 200");
        assert_eq!(line.as_deref(), Some("GET /health 200"));
        assert!(cursor.last.is_some());
    }

    #[test]
    fn reconnect_skips_lines_already_shown() {
        let mut cursor = Cursor::default();
        cursor.accept("2026-10-21T07:00:01Z one");
        cursor.accept("2026-10-21T07:00:02Z two");
        cursor.resume_after = cursor.last;

        // The server resends from the start of the second, then continues.
        assert_eq!(cursor.accept("2026-10-21T07:00:01Z one"), None);
        assert_eq!(cursor.accept("2026-10-21T07:00:02Z two"), None);
        assert_eq!(
            cursor.accept("2026-10-21T07:00:03Z three").as_deref(),
            Some("three")
        );
        // Lines sharing a timestamp after the resume point all show.
        assert_eq!(
            cursor.accept("2026-10-21T07:00:03Z four").as_deref(),
            Some("four")
        );
    }

    #[test]
    fn lines_without_a_timestamp_pass_through() {
        let mut cursor = Cursor::default();
        assert_eq!(cursor.accept("plain line").as_deref(), Some("plain line"));
    }
}
