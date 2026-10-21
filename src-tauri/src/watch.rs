use std::{
    fmt::Debug,
    future::Future,
    hash::Hash,
    pin::pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use futures::StreamExt;
use kube::{
    Api, Resource, ResourceExt,
    api::ListParams,
    runtime::{
        WatchStreamExt, reflector,
        reflector::{Lookup, store::Writer},
        watcher,
    },
};
use serde::{Serialize, de::DeserializeOwned};
use tauri::{
    State,
    async_runtime::{self, JoinHandle},
    ipc::Channel,
};
use tokio::time::{MissedTickBehavior, interval, timeout};

/// Changes are coalesced and pushed to the UI at most this often, so a burst
/// of events costs one render instead of hundreds.
const FLUSH_INTERVAL: Duration = Duration::from_millis(150);

/// While the API is unreachable, check it this often to report recovery.
const HEALTH_INTERVAL: Duration = Duration::from_secs(5);

/// A reachability probe that takes longer than this counts as a failure.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WatchEvent<R> {
    Snapshot {
        items: Vec<R>,
    },
    Error {
        message: String,
    },
    /// The API answers again after an `Error`.
    Recovered,
}

/// Only one list watch runs at a time: the one for the view on screen.
#[derive(Default)]
pub struct ViewWatch {
    generation: AtomicU64,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl ViewWatch {
    /// Claims the next watch. Call before awaiting anything, so that a newer
    /// request started meanwhile can win in [`ViewWatch::start`].
    pub fn begin(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Runs `watch` in place of the current one, unless a newer request
    /// already claimed the slot.
    pub fn start(&self, generation: u64, watch: impl Future<Output = ()> + Send + 'static) {
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let task = async_runtime::spawn(watch);
        if let Some(previous) = self.task.lock().unwrap().replace(task) {
            previous.abort();
        }
    }

    fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
    }
}

#[tauri::command]
pub fn stop_watch(watch: State<'_, ViewWatch>) {
    watch.stop();
}

/// Mirrors a list of objects into the UI: a reflector keeps the cache, and
/// sorted rows go out in batches.
pub async fn run_watch<K, R>(
    api: Api<K>,
    dyntype: <K as Resource>::DynamicType,
    channel: Channel<WatchEvent<R>>,
    to_row: impl Fn(&K) -> R + Send + 'static,
) where
    K: Resource + Lookup<DynamicType = <K as Resource>::DynamicType>,
    K: Clone + Debug + DeserializeOwned + Send + Sync + 'static,
    <K as Resource>::DynamicType: Clone + Eq + Hash + Send + Sync,
    R: Serialize + Clone + Send + 'static,
{
    let writer = Writer::new(dyntype);
    let store = writer.as_reader();
    let mut events =
        pin!(reflector(writer, watcher(api.clone(), watcher::Config::default())).default_backoff());
    let mut ticker = interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut health = interval(HEALTH_INTERVAL);
    health.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut ready = false;
    let mut dirty = false;
    let mut disconnected = false;

    loop {
        tokio::select! {
            event = events.next() => match event {
                Some(Ok(watcher::Event::InitDone)) => {
                    ready = true;
                    dirty = true;
                }
                Some(Ok(_)) => dirty = true,
                // Load balancers cut idle watch connections, and the watcher then
                // resumes from its last version without emitting anything. So a
                // stream error is only reported when the API itself stops answering.
                Some(Err(err)) => {
                    if !disconnected && !reachable(&api).await {
                        disconnected = true;
                        let message = err.to_string();
                        if channel.send(WatchEvent::Error { message }).is_err() {
                            return;
                        }
                    }
                }
                None => return,
            },
            _ = health.tick(), if disconnected => {
                if reachable(&api).await {
                    disconnected = false;
                    dirty = true;
                    if channel.send(WatchEvent::Recovered).is_err() {
                        return;
                    }
                }
            }
            _ = ticker.tick(), if ready && dirty => {
                dirty = false;
                let mut objects: Vec<Arc<K>> = store.state();
                objects.sort_by_cached_key(|o| (ResourceExt::namespace(o.as_ref()), o.name_any()));
                let items = objects.iter().map(|o| to_row(o)).collect();
                if channel.send(WatchEvent::Snapshot { items }).is_err() {
                    return;
                }
            }
        }
    }
}

/// Cheapest request that proves the API answers for this scope.
async fn reachable<K>(api: &Api<K>) -> bool
where
    K: Resource + Clone + DeserializeOwned + Debug,
{
    let params = ListParams::default().limit(1);
    let probe = api.list_metadata(&params);
    matches!(timeout(PROBE_TIMEOUT, probe).await, Ok(Ok(_)))
}

#[cfg(test)]
mod tests {
    use k8s_openapi::api::core::v1::Pod;

    use super::*;

    #[tokio::test]
    async fn unreachable_api_is_detected() {
        // Nothing listens on port 1, so the probe fails fast.
        let config = kube::Config::new("https://127.0.0.1:1".parse().unwrap());
        let client = kube::Client::try_from(config).unwrap();
        assert!(!reachable(&Api::<Pod>::all(client)).await);
    }
}
