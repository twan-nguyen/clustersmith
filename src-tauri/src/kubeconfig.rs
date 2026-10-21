use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use kube::config::Kubeconfig;
use serde::{Deserialize, Serialize};

/// How the user wants a context shown. The kubeconfig itself is never edited.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterPrefs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Avatar hue in OKLCH degrees; `None` derives one from the name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hue: Option<u16>,
}

#[derive(Default, Serialize, Deserialize)]
struct Settings {
    #[serde(default)]
    kubeconfigs: Vec<PathBuf>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    clusters: BTreeMap<String, ClusterPrefs>,
    /// How much of the macOS blur shows through the window background, in
    /// percent; 0 turns the blur off.
    #[serde(default)]
    transparency: u8,
}

/// Where contexts come from: the files `kubectl` would read, plus files the
/// user imported. Imported files are referenced by path, not copied, so tools
/// that rewrite them (for example `aws eks update-kubeconfig`) stay in sync.
/// The same settings file also keeps how each context is shown and the
/// app's appearance.
pub struct KubeconfigSources {
    settings_file: PathBuf,
    defaults: Vec<PathBuf>,
    settings: Mutex<Settings>,
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
        let settings = fs::read(&settings_file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
            .unwrap_or_default();
        let defaults = match std::env::var_os("KUBECONFIG") {
            Some(value) if !value.is_empty() => std::env::split_paths(&value)
                .filter(|p| !p.as_os_str().is_empty())
                .collect(),
            _ => vec![home_dir.join(".kube").join("config")],
        };

        Self {
            settings_file,
            defaults,
            settings: Mutex::new(settings),
        }
    }

    /// Every source in order, each flagged with whether the user imported it.
    /// A missing default file is skipped silently.
    fn paths(&self) -> Vec<(PathBuf, bool)> {
        let imported = self.settings.lock().unwrap().kubeconfigs.clone();
        let defaults = self.defaults.iter().filter(|p| p.exists()).cloned();
        defaults
            .map(|p| (p, false))
            .chain(imported.into_iter().map(|p| (p, true)))
            .collect()
    }

    /// Merges every source in order, like `kubectl`: the first file to define a
    /// name wins. A file that cannot be read is skipped and reported in its
    /// status. The merge lists contexts; to connect, use [`Self::config_for`].
    pub fn read(&self) -> (Kubeconfig, Vec<SourceStatus>) {
        let mut merged = Kubeconfig::default();
        let mut statuses = Vec::new();
        for (path, imported) in self.paths() {
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

    /// The file that defines `context`, the first one if several do.
    ///
    /// Files exported from different clusters often share names: kubeadm calls
    /// every cluster `kubernetes` and its user `kubernetes-admin`. Merged, a
    /// context would resolve those names in whichever file came first and
    /// connect to the wrong cluster, so each context is resolved in its own file.
    pub fn config_for(&self, context: &str) -> Option<Kubeconfig> {
        self.paths()
            .into_iter()
            .filter_map(|(path, _)| Kubeconfig::read_from(path).ok())
            .find(|config| config.contexts.iter().any(|c| c.name == context))
    }

    pub fn add(&self, path: PathBuf) -> Result<(), String> {
        Kubeconfig::read_from(&path).map_err(|e| e.to_string())?;
        let mut settings = self.settings.lock().unwrap();
        if self.defaults.contains(&path) || settings.kubeconfigs.contains(&path) {
            return Ok(());
        }
        settings.kubeconfigs.push(path);
        self.save(&settings)
    }

    pub fn remove(&self, path: &Path) -> Result<(), String> {
        let mut settings = self.settings.lock().unwrap();
        settings.kubeconfigs.retain(|p| p != path);
        self.save(&settings)
    }

    pub fn cluster_prefs(&self) -> BTreeMap<String, ClusterPrefs> {
        self.settings.lock().unwrap().clusters.clone()
    }

    /// Stores how `context` is shown. A blank name, or the context's own name,
    /// means "no custom name"; prefs with nothing set are dropped.
    pub fn set_cluster_prefs(&self, context: &str, prefs: ClusterPrefs) -> Result<(), String> {
        let display_name = prefs
            .display_name
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty() && n != context);
        let prefs = ClusterPrefs {
            display_name,
            hue: prefs.hue.map(|h| h % 360),
        };

        let mut settings = self.settings.lock().unwrap();
        if prefs.display_name.is_none() && prefs.hue.is_none() {
            settings.clusters.remove(context);
        } else {
            settings.clusters.insert(context.to_owned(), prefs);
        }
        self.save(&settings)
    }

    pub fn transparency(&self) -> u8 {
        self.settings.lock().unwrap().transparency
    }

    pub fn set_transparency(&self, percent: u8) -> Result<(), String> {
        let mut settings = self.settings.lock().unwrap();
        settings.transparency = percent.min(100);
        self.save(&settings)
    }

    fn save(&self, settings: &Settings) -> Result<(), String> {
        if let Some(dir) = self.settings_file.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
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
    fn context_resolves_names_in_its_own_file() {
        // Two kubeadm clusters: same cluster and user names, different servers.
        let kubeadm = |context: &str, server: &str| {
            format!(
                "clusters:
- name: kubernetes
  cluster: {{server: '{server}'}}
contexts:
- name: {context}
  context: {{cluster: kubernetes, user: kubernetes-admin}}
users:
- name: kubernetes-admin
  user: {{token: test}}
"
            )
        };
        let dir = temp_dir("same-names");
        let (first, second) = (dir.join("first.yaml"), dir.join("second.yaml"));
        fs::write(&first, kubeadm("staging", "https://staging:6443")).unwrap();
        fs::write(&second, kubeadm("prod", "https://prod:6443")).unwrap();

        let sources = KubeconfigSources::load(dir.join("app"), dir.clone());
        sources.add(first).unwrap();
        sources.add(second).unwrap();

        let config = sources.config_for("prod").unwrap();
        let server = config.clusters[0].cluster.as_ref().unwrap().server.as_deref();
        assert_eq!(server, Some("https://prod:6443"));
        assert!(sources.config_for("missing").is_none());
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

    #[test]
    fn cluster_prefs_are_normalized_and_remembered() {
        let dir = temp_dir("prefs");
        let sources = KubeconfigSources::load(dir.join("app"), dir.clone());
        let prefs = |name: &str, hue| ClusterPrefs {
            display_name: Some(name.to_owned()),
            hue,
        };

        sources
            .set_cluster_prefs("admin@prod", prefs("  Production  ", Some(400)))
            .unwrap();
        let reopened = KubeconfigSources::load(dir.join("app"), dir.clone());
        let saved = &reopened.cluster_prefs()["admin@prod"];
        assert_eq!(saved.display_name.as_deref(), Some("Production"));
        assert_eq!(saved.hue, Some(40));

        // Renaming back to the context's own name with no color clears it.
        reopened
            .set_cluster_prefs("admin@prod", prefs("admin@prod", None))
            .unwrap();
        let reopened = KubeconfigSources::load(dir.join("app"), dir.clone());
        assert!(reopened.cluster_prefs().is_empty());
    }
}
