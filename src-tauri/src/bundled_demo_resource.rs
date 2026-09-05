use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const RESOURCE_RELATIVE_PATH: &str = "demo/west-lake-vinegar-fish/project-import.json";
const EXPECTED_SHA256: &str =
    "C9E5D5E5465E87DD9907BD081E1C6BCCFCD6283BA8AAC2E1D4019CD59AC7AE69";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledDemoResourcePayload {
    content: String,
    byte_length: usize,
    sha256: String,
    relative_path: &'static str,
    read_mode: &'static str,
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect()
}

fn read_verified(path: &Path, read_mode: &'static str) -> Result<BundledDemoResourcePayload, String> {
    let bytes = fs::read(path).map_err(|error| {
        format!("LP15_B2_DEMO_RESOURCE_READ_FAILED:{read_mode}:{error}")
    })?;
    let sha256 = sha256_hex(&bytes);
    if sha256 != EXPECTED_SHA256 {
        return Err(format!(
            "LP15_B2_DEMO_RESOURCE_HASH_MISMATCH:{read_mode}:{sha256}"
        ));
    }
    let content = String::from_utf8(bytes.clone())
        .map_err(|_| format!("LP15_B2_DEMO_RESOURCE_UTF8_INVALID:{read_mode}"))?;
    Ok(BundledDemoResourcePayload {
        content,
        byte_length: bytes.len(),
        sha256,
        relative_path: RESOURCE_RELATIVE_PATH,
        read_mode,
    })
}

fn resource_path(resource_dir: &Path) -> PathBuf {
    resource_dir.join(RESOURCE_RELATIVE_PATH)
}

#[tauri::command]
pub fn read_bundled_demo_project_import(
    app: AppHandle,
) -> Result<BundledDemoResourcePayload, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("LP15_B2_TAURI_RESOURCE_DIR_UNAVAILABLE:{error}"))?;
    let primary = resource_path(&resource_dir);
    if primary.exists() {
        return read_verified(&primary, "tauri-resource");
    }

    #[cfg(debug_assertions)]
    {
        let development_source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(RESOURCE_RELATIVE_PATH);
        if development_source.exists() {
            return read_verified(&development_source, "development-source-fallback");
        }
    }

    Err("LP15_B2_BUNDLED_DEMO_RESOURCE_NOT_FOUND".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_product_resource_matches_frozen_hash_and_size() {
        let bytes = include_bytes!("../../demo/west-lake-vinegar-fish/project-import.json");
        assert_eq!(bytes.len(), 58_274);
        assert_eq!(sha256_hex(bytes), EXPECTED_SHA256);
    }

    #[test]
    fn resource_mapping_is_relative_to_tauri_resource_directory() {
        let root = Path::new("resource-root");
        assert_eq!(
            resource_path(root),
            root.join("demo").join("west-lake-vinegar-fish").join("project-import.json")
        );
    }
}
