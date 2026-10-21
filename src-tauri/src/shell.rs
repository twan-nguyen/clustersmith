use futures::SinkExt;
use k8s_openapi::api::core::v1::Pod;
use kube::{
    Api,
    api::{AttachParams, TerminalSize},
};
use serde::Serialize;
use tauri::{State, async_runtime, ipc::Channel};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
};

use crate::{
    clients::Clients,
    kubeconfig::KubeconfigSources,
    sessions::{Sessions, ShellInput},
};

/// Prefer bash, fall back to sh: minimal images often ship only the latter.
const SHELL: &str =
    "export TERM=xterm-256color; command -v bash >/dev/null 2>&1 && exec bash || exec sh";

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ShellEvent {
    Output { data: String },
    Exited,
    Error { message: String },
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn open_shell(
    context: String,
    namespace: String,
    pod: String,
    container: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<ShellEvent>,
    sources: State<'_, KubeconfigSources>,
    clients: State<'_, Clients>,
    sessions: State<'_, Sessions>,
) -> Result<u64, String> {
    let client = clients.get(&sources, &context).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let mut params = AttachParams::interactive_tty();
    params.container = container;
    let mut process = api
        .exec(&pod, ["sh", "-c", SHELL], &params)
        .await
        .map_err(|e| e.to_string())?;

    let (Some(mut stdin), Some(mut stdout), Some(mut resize)) =
        (process.stdin(), process.stdout(), process.terminal_size())
    else {
        return Err("The container did not open an interactive terminal".into());
    };
    let size = TerminalSize {
        width: cols,
        height: rows,
    };
    resize.send(size).await.map_err(|e| e.to_string())?;

    let (input_tx, mut input_rx) = mpsc::unbounded_channel();
    let task = async_runtime::spawn(async move {
        // Owning the process keeps the connection open for the task's lifetime.
        let _process = process;
        let mut buffer = [0u8; 8192];
        let mut pending = Vec::new();

        let last = loop {
            tokio::select! {
                read = stdout.read(&mut buffer) => match read {
                    Ok(0) => break ShellEvent::Exited,
                    Ok(n) => {
                        let data = decode_utf8(&mut pending, &buffer[..n]);
                        if !data.is_empty() && on_event.send(ShellEvent::Output { data }).is_err() {
                            return;
                        }
                    }
                    Err(err) => break ShellEvent::Error { message: err.to_string() },
                },
                input = input_rx.recv() => match input {
                    Some(ShellInput::Data(bytes)) => {
                        if let Err(err) = stdin.write_all(&bytes).await {
                            break ShellEvent::Error { message: err.to_string() };
                        }
                    }
                    Some(ShellInput::Resize { cols, rows }) => {
                        let size = TerminalSize { width: cols, height: rows };
                        let _ = resize.send(size).await;
                    }
                    None => return,
                },
            }
        };
        let _ = on_event.send(last);
    });
    Ok(sessions.insert(task, Some(input_tx)))
}

#[tauri::command]
pub fn shell_input(id: u64, data: String, sessions: State<'_, Sessions>) {
    sessions.send(id, ShellInput::Data(data.into_bytes()));
}

#[tauri::command]
pub fn shell_resize(id: u64, cols: u16, rows: u16, sessions: State<'_, Sessions>) {
    sessions.send(id, ShellInput::Resize { cols, rows });
}

/// Decodes a chunk of terminal output, holding back a multi-byte character
/// that was split across reads until the rest of it arrives.
fn decode_utf8(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
    pending.extend_from_slice(chunk);
    let cut = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        // Truly invalid bytes are shown as replacement characters right away.
        Err(err) if err.error_len().is_some() => pending.len(),
        Err(err) => err.valid_up_to(),
    };
    let text = String::from_utf8_lossy(&pending[..cut]).into_owned();
    pending.drain(..cut);
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_character_is_held_until_complete() {
        let mut pending = Vec::new();
        let bytes = "xin chào".as_bytes();
        // "à" is two bytes followed by the one-byte "o"; split between its two bytes.
        let split = bytes.len() - 2;
        assert_eq!(decode_utf8(&mut pending, &bytes[..split]), "xin ch");
        assert_eq!(decode_utf8(&mut pending, &bytes[split..]), "ào");
        assert!(pending.is_empty());
    }

    #[test]
    fn invalid_bytes_do_not_stall_output() {
        let mut pending = Vec::new();
        assert_eq!(decode_utf8(&mut pending, b"ok\xffok"), "ok\u{fffd}ok");
        assert!(pending.is_empty());
    }
}
