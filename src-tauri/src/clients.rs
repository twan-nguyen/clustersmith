use std::{collections::HashMap, sync::Mutex};

use kube::{
    Client, Config,
    config::{KubeConfigOptions, Kubeconfig},
};

/// Caches one API client per kubeconfig context. Building a client can run
/// slow auth plugins (for example `aws eks get-token`), so it happens once.
#[derive(Default)]
pub struct Clients(Mutex<HashMap<String, Client>>);

impl Clients {
    pub async fn get(&self, context: &str) -> Result<Client, String> {
        if let Some(client) = self.0.lock().unwrap().get(context) {
            return Ok(client.clone());
        }

        let kubeconfig = Kubeconfig::read().map_err(|e| e.to_string())?;
        let options = KubeConfigOptions {
            context: Some(context.to_owned()),
            ..Default::default()
        };
        let config = Config::from_custom_kubeconfig(kubeconfig, &options)
            .await
            .map_err(|e| e.to_string())?;
        let client = Client::try_from(config).map_err(|e| e.to_string())?;

        self.0
            .lock()
            .unwrap()
            .insert(context.to_owned(), client.clone());
        Ok(client)
    }
}
