//! One startup selection shared by SQLite, WebView and managed-root isolation.
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub(crate) const DEV_RUNTIME_ROOT_ENV: &str = "SCILOOM_DEV_RUNTIME_ROOT";

#[derive(Clone, Debug)]
pub(crate) struct RuntimePaths {
    pub app_data: PathBuf,
    pub database_directory: PathBuf,
    pub webview_profile: PathBuf,
    pub webview_data_directory: Option<PathBuf>,
}

fn select(
    development: bool,
    override_root: Option<&Path>,
    default_app_data: PathBuf,
    default_local_data: PathBuf,
) -> Result<RuntimePaths, String> {
    if development {
        if let Some(root) = override_root {
            if !root.is_absolute() {
                return Err(format!("{DEV_RUNTIME_ROOT_ENV} must be an absolute directory"));
            }
            return Ok(RuntimePaths {
                app_data: root.to_path_buf(),
                database_directory: root.join("Database"),
                webview_profile: root.join("WebView"),
                webview_data_directory: Some(root.join("WebView")),
            });
        }
    }
    Ok(RuntimePaths {
        database_directory: default_app_data.clone(),
        app_data: default_app_data,
        webview_profile: default_local_data.join("EBWebView"),
        webview_data_directory: None,
    })
}

impl RuntimePaths {
    pub fn resolve<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let root = std::env::var_os(DEV_RUNTIME_ROOT_ENV).map(PathBuf::from);
        select(
            cfg!(debug_assertions),
            root.as_deref(),
            app.path().app_data_dir().map_err(|error| error.to_string())?,
            app.path().app_local_data_dir().map_err(|error| error.to_string())?,
        )
    }

    pub fn prepare(&self) -> Result<(), String> {
        for directory in [&self.database_directory, &self.webview_profile] {
            std::fs::create_dir_all(directory).map_err(|error| {
                format!("runtime directory unavailable: {}: {error}", directory.display())
            })?;
        }
        Ok(())
    }
}

pub(crate) fn selected<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<RuntimePaths, String> {
    app.try_state::<RuntimePaths>()
        .map(|paths| paths.inner().clone())
        .ok_or_else(|| "SciLoom runtime paths were not selected before use".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join("sciloom-default-paths");
        (base.join("roaming"), base.join("local"))
    }

    #[test]
    fn development_pairs_database_profile_and_isolation_root() {
        let (roaming, local) = defaults();
        let root = std::env::temp_dir().join("sciloom-dev-runtime");
        let paths = select(true, Some(&root), roaming, local).unwrap();
        assert_eq!(paths.app_data, root);
        assert_eq!(paths.database_directory, root.join("Database"));
        assert_eq!(paths.webview_profile, root.join("WebView"));
        assert_eq!(paths.webview_data_directory, Some(root.join("WebView")));
    }

    #[test]
    fn missing_override_and_release_keep_standard_paths() {
        let (roaming, local) = defaults();
        for (development, root) in [(true, None), (false, Some(Path::new("invalid-relative")))] {
            let paths = select(development, root, roaming.clone(), local.clone()).unwrap();
            assert_eq!(paths.app_data, roaming);
            assert_eq!(paths.database_directory, roaming);
            assert_eq!(paths.webview_profile, local.join("EBWebView"));
            assert!(paths.webview_data_directory.is_none());
        }
    }

    #[test]
    fn invalid_development_override_fails_without_default_fallback() {
        let (roaming, local) = defaults();
        for root in [Path::new(""), Path::new("relative-runtime")] {
            assert!(select(true, Some(root), roaming.clone(), local.clone()).is_err());
        }
    }

    #[test]
    fn unavailable_selected_directory_fails_without_default_fallback() {
        let root = std::env::temp_dir().join(format!("sciloom-runtime-paths-{}", uuid::Uuid::new_v4()));
        std::fs::write(&root, b"owned test fixture").unwrap();
        let (roaming, local) = defaults();
        let paths = select(true, Some(&root), roaming, local).unwrap();
        assert!(paths.prepare().is_err());
        std::fs::remove_file(root).unwrap();
    }
}
