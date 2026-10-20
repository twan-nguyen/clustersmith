use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use kube::config::Kubeconfig;
use serde::{Deserialize, Serialize};

#[derive(Default, Serialize, Deserialize)]
struct Settings {
    #[serde(default)]
    kubeconfigs: Vec<PathBuf>,
}

/// Where contexts come from: the files `kubectl` would read, plus files the
/// user imported. Imported files are referenced by path, not copied, so tools
/// that rewrite them (for example `aws eks update-kubeconfig`) stay in sync.
pub struct KubeconfigSources {
    settings_file: PathBuf,
    defaults: Vec<PathBuf>,
    imported: Mutex<Vec<PathBuf>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    path: PathBuf,
    imported: bool,
    contexts: usize,
    error: Option<String>,
}

impl KubeconfigSources {
    pub fn load(config_dir: PathBuf, home_dir: PathBuf) -> Self {
        let settings_file = config_dir.join("settings.json");
        let imported = fs::read(&settings_file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
            .unwrap_or_default()
            .kubeconfigs;
        let defaults = match std::env::var_os("KUBECONFIG") {
            Some(value) if !value.is_empty() => std::env::split_paths(&value)
                .filter(|p| !p.as_os_str().is_empty())
                .collect(),
            _ => vec![home_dir.join(".kube").join("config")],
        };

        Self {
            settings_file,
            defaults,
            imported: Mutex::new(imported),
        }
    }

    /// Merges every source in order, like `kubectl`: the first file to define a
    /// name wins. A missing default file is skipped silently; any other file
    /// that cannot be read is skipped and reported in its status.
    pub fn read(&self) -> (Kubeconfig, Vec<SourceStatus>) {
        let imported = self.imported.lock().unwrap().clone();
        let defaults = self.defaults.iter().filter(|p| p.exists()).cloned();
        let sources = defaults
            .map(|p| (p, false))
            .chain(imported.into_iter().map(|p| (p, true)));

        let mut merged = Kubeconfig::default();
        let mut statuses = Vec::new();
        for (path, imported) in sources {
            let result = Kubeconfig::read_from(&path).and_then(|config| {
                let contexts = config.contexts.len();
                merged.clone().merge(config).map(|m| (m, contexts))
            });
            let (contexts, error) = match result {
                Ok((next, contexts)) => {
                    merged = next;
                    (contexts, None)
                }
                Err(err) => (0, Some(err.to_string())),
            };
            statuses.push(SourceStatus {
                path,
                imported,
                contexts,
                error,
            });
        }
        (merged, statuses)
    }

    pub fn add(&self, path: PathBuf) -> Result<(), String> {
        Kubeconfig::read_from(&path).map_err(|e| e.to_string())?;
        let mut imported = self.imported.lock().unwrap();
        if self.defaults.contains(&path) || imported.contains(&path) {
            return Ok(());
        }
        imported.push(path);
        self.save(&imported)
    }

    pub fn remove(&self, path: &Path) -> Result<(), String> {
        let mut imported = self.imported.lock().unwrap();
        imported.retain(|p| p != path);
        self.save(&imported)
    }

    fn save(&self, imported: &[PathBuf]) -> Result<(), String> {
        if let Some(dir) = self.settings_file.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let settings = Settings {
            kubeconfigs: imported.to_vec(),
        };
        let json = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
        fs::write(&self.settings_file, json).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = "apiVersion: v1
kind: Config
clusters:
- name: dev-cluster
  cluster: {server: 'https://127.0.0.1:6443'}
contexts:
- name: dev
  context: {cluster: dev-cluster, user: dev-user}
users:
- name: dev-user
  user: {token: test}
";

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("clustersmith-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn has_context(sources: &KubeconfigSources, name: &str) -> bool {
        sources.read().0.contexts.iter().any(|c| c.name == name)
    }

    #[test]
    fn imported_file_is_merged_and_remembered() {
        let dir = temp_dir("remembered");
        let file = dir.join("dev.yaml");
        fs::write(&file, CONFIG).unwrap();

        let sources = KubeconfigSources::load(dir.join("app"), dir.clone());
        sources.add(file.clone()).unwrap();
        let (_, statuses) = sources.read();
        let status = statuses.iter().find(|s| s.path == file).unwrap();
        assert!(status.imported && status.contexts == 1 && status.error.is_none());

        let reopened = KubeconfigSources::load(dir.join("app"), dir.clone());
        assert!(has_context(&reopened, "dev"));

        reopened.remove(&file).unwrap();
        let reopened = KubeconfigSources::load(dir.join("app"), dir.clone());
        assert!(!has_context(&reopened, "dev"));
    }

    #[test]
    fn invalid_file_is_rejected() {
        let dir = temp_dir("invalid");
        let file = dir.join("broken.yaml");
        fs::write(&file, "contexts: [not, a, kubeconfig").unwrap();

        let sources = KubeconfigSources::load(dir.join("app"), dir.clone());
        assert!(sources.add(file.clone()).is_err());
        assert!(sources.read().1.iter().all(|s| s.path != file));
    }

    #[test]
    fn missing_file_is_reported_not_fatal() {
        let dir = temp_dir("missing");
        let file = dir.join("dev.yaml");
        fs::write(&file, CONFIG).unwrap();

        let sources = KubeconfigSources::load(dir.join("app"), dir.clone());
        sources.add(file.clone()).unwrap();
        fs::remove_file(&file).unwrap();

        let (_, statuses) = sources.read();
        let status = statuses.iter().find(|s| s.path == file).unwrap();
        assert_eq!(status.contexts, 0);
        assert!(status.error.is_some());
    }
}
