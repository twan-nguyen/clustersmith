use std::{pin::Pin, time::Duration};

use futures::{AsyncBufRead, AsyncBufReadExt, StreamExt, future::join_all};
use jiff::Timestamp;
use k8s_openapi::api::core::v1::Pod;
use kube::{Api, ResourceExt, api::LogParams};
use serde::Serialize;
use tauri::{State, async_runtime, ipc::Channel};
use tokio::time::{MissedTickBehavior, interval, sleep};

use crate::{
    clients::Clients, details::pods_of, kubeconfig::KubeconfigSources, resources::resolve,
    sessions::Sessions,
};

/// Lines are sent in batches at most this often, so a chatty container costs
/// a few renders per second instead of one per line.
const FLUSH_INTERVAL: Duration = Duration::from_millis(100);

/// History loaded when a log tab opens, like `kubectl logs --tail`. With
/// several pods it is shared out, but each still gets some.
const TAIL_LINES: i64 = 1000;
const MIN_TAIL_PER_POD: i64 = 100;

/// More pods than this in one tab is noise, not a log.
const MAX_PODS: usize = 20;

/// Wait before reconnecting a dropped stream, doubling up to the maximum.
const RETRY_MIN: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(15);

type LogStream = Pin<Box<dyn AsyncBufRead + Send>>;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogEvent {
    Lines {
        lines: Vec<String>,
        /// The pod the lines came from, when a tab follows several.
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<String>,
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
    previous: Option<bool>,
    on_event: Channel<LogEvent>,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
    sessions: State<'_, Sessions>,
) -> Result<u64, String> {
    let client = clients.get(&sources, &context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);

    // The crashed container's last run: a finished log, nothing to follow.
    if previous == Some(true) {
        let params = LogParams {
            container,
            previous: true,
            // Stripped again by the cursor, like in a live tab.
            timestamps: true,
            tail_lines: Some(TAIL_LINES),
            ..Default::default()
        };
        let stream = api
            .log_stream(&pod, &params)
            .await
            .map_err(|e| e.to_string())?;
        let task = async_runtime::spawn(async move {
            let mut cursor = Cursor::default();
            if pump(Box::pin(stream), &mut cursor, &on_event, None).await {
                let _ = on_event.send(LogEvent::Ended);
            }
        });
        return Ok(sessions.insert(task, None));
    }

    // The first connection reports its error to the caller; later ones retry.
    let stream = api
        .log_stream(&pod, &log_params(container.clone(), None, TAIL_LINES))
        .await
        .map_err(|e| e.to_string())?;
    let source = Source {
        pod,
        container,
        label: None,
    };
    let task = async_runtime::spawn(follow(api, source, Box::pin(stream), on_event, true));
    Ok(sessions.insert(task, None))
}

/// Follows every pod of a workload or service in one tab, each line tagged
/// with its pod. The pods are the ones running when the tab opens.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn open_workload_logs(
    context: String,
    kind: String,
    namespace: String,
    name: String,
    on_event: Channel<LogEvent>,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
    sessions: State<'_, Sessions>,
) -> Result<u64, String> {
    let client = clients.get(&sources, &context).await?;
    let kind = resolve(&client, &kind).await?;
    let object = kind
        .api(client.clone(), Some(&namespace))
        .get(&name)
        .await
        .map_err(|e| e.to_string())?;
    let mut pods = pods_of(&client, &kind.id, &object)
        .await?
        .ok_or("only workloads and services have pods to follow")?;
    pods.retain(|p| p.metadata.deletion_timestamp.is_none());
    pods.truncate(MAX_PODS);
    if pods.is_empty() {
        return Err("no pods are running for it".into());
    }

    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let tail = (TAIL_LINES / pods.len() as i64).max(MIN_TAIL_PER_POD);
    let mut followers = Vec::new();
    let mut last_error = None;
    for pod in &pods {
        let source = Source {
            pod: pod.name_any(),
            container: default_container(pod),
            label: Some(pod.name_any()),
        };
        let params = log_params(source.container.clone(), None, tail);
        match api.log_stream(&source.pod, &params).await {
            Ok(stream) => followers.push(follow(
                api.clone(),
                source,
                Box::pin(stream),
                on_event.clone(),
                false,
            )),
            // A pod still starting has no log yet; the others are still worth showing.
            Err(err) => last_error = Some(err.to_string()),
        }
    }
    if followers.is_empty() {
        return Err(last_error.unwrap_or_default());
    }
    let task = async_runtime::spawn(async move {
        join_all(followers).await;
        let _ = on_event.send(LogEvent::Ended);
    });
    Ok(sessions.insert(task, None))
}

/// Writes a log tab's lines to a file the user picked in a save dialog.
#[tauri::command]
pub async fn save_log(path: std::path::PathBuf, text: String) -> Result<(), String> {
    tokio::fs::write(&path, text)
        .await
        .map_err(|e| e.to_string())
}

/// The container `kubectl logs` picks: the annotated default, else the first.
fn default_container(pod: &Pod) -> Option<String> {
    pod.annotations()
        .get("kubectl.kubernetes.io/default-container")
        .cloned()
        .or_else(|| {
            pod.spec
                .as_ref()?
                .containers
                .first()
                .map(|c| c.name.clone())
        })
}

fn log_params(container: Option<String>, since: Option<Timestamp>, tail: i64) -> LogParams {
    LogParams {
        container,
        follow: true,
        // Timestamps let a reconnect resume exactly where the last line was.
        timestamps: true,
        tail_lines: since.is_none().then_some(tail),
        since_time: since,
        ..Default::default()
    }
}

/// One container's log stream.
struct Source {
    pod: String,
    container: Option<String>,
    /// Tags each line when a tab follows several pods.
    label: Option<String>,
}

/// Streams until the container stops. Load balancers cut idle connections, so
/// a dropped stream is reopened from the last line while the container runs.
/// With `report` off, as for one pod among several, only lines are sent.
async fn follow(
    api: Api<Pod>,
    source: Source,
    first: LogStream,
    channel: Channel<LogEvent>,
    report: bool,
) {
    let mut cursor = Cursor::default();
    let mut stream = Some(first);
    let mut retry = RETRY_MIN;
    let status = |event: LogEvent| !report || channel.send(event).is_ok();

    loop {
        if let Some(open) = stream.take()
            && !pump(open, &mut cursor, &channel, source.label.as_deref()).await
        {
            return;
        }
        if container_finished(&api, &source.pod, source.container.as_deref()).await {
            status(LogEvent::Ended);
            return;
        }
        if !status(LogEvent::Reconnecting) {
            return;
        }
        sleep(retry).await;
        retry = (retry * 2).min(RETRY_MAX);

        let params = log_params(source.container.clone(), cursor.last, TAIL_LINES);
        if let Ok(reopened) = api.log_stream(&source.pod, &params).await {
            retry = RETRY_MIN;
            cursor.resume_after = cursor.last;
            if !status(LogEvent::Live) {
                return;
            }
            stream = Some(Box::pin(reopened));
        }
    }
}

/// Reads one stream to its end. Returns `false` once the UI stopped listening.
async fn pump(
    stream: LogStream,
    cursor: &mut Cursor,
    channel: &Channel<LogEvent>,
    label: Option<&str>,
) -> bool {
    let send = |lines| {
        let source = label.map(str::to_owned);
        channel.send(LogEvent::Lines { lines, source }).is_ok()
    };
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
                if !send(std::mem::take(&mut batch)) {
                    return false;
                }
            }
        }
    }
    batch.is_empty() || send(batch)
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
