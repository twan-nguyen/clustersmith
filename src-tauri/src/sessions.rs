use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use tauri::{State, async_runtime::JoinHandle};
use tokio::sync::mpsc::UnboundedSender;

/// What the UI can send to a running shell.
pub enum ShellInput {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
}

struct Session {
    task: JoinHandle<()>,
    input: Option<UnboundedSender<ShellInput>>,
}

/// Log streams and shells open in the dock, keyed by an id the UI holds.
/// Dropping a session's task closes its connection to the cluster.
#[derive(Default)]
pub struct Sessions {
    next_id: AtomicU64,
    open: Mutex<HashMap<u64, Session>>,
}

impl Sessions {
    pub fn insert(&self, task: JoinHandle<()>, input: Option<UnboundedSender<ShellInput>>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        self.open
            .lock()
            .unwrap()
            .insert(id, Session { task, input });
        id
    }

    pub fn send(&self, id: u64, input: ShellInput) {
        if let Some(tx) = self
            .open
            .lock()
            .unwrap()
            .get(&id)
            .and_then(|s| s.input.as_ref())
        {
            // A closed receiver means the shell already exited; nothing to deliver.
            let _ = tx.send(input);
        }
    }

    fn close(&self, id: u64) {
        if let Some(session) = self.open.lock().unwrap().remove(&id) {
            session.task.abort();
        }
    }
}

#[tauri::command]
pub fn close_session(id: u64, sessions: State<'_, Sessions>) {
    sessions.close(id);
}
