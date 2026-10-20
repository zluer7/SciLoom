use std::fs;
#[cfg(not(target_os = "macos"))]
use std::process::Command;

#[cfg(not(target_os = "macos"))]
fn escape_powershell_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn save_text_file(default_file_name: String, contents: String) -> Result<Option<String>, String> {
    let script = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
         Add-Type -AssemblyName System.Windows.Forms; \
         $dialog = New-Object System.Windows.Forms.SaveFileDialog; \
         $dialog.FileName = '{}'; \
         $dialog.Filter = 'All files (*.*)|*.*'; \
         if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ \
           [Console]::Write($dialog.FileName) \
         }}",
        escape_powershell_single_quoted(&default_file_name)
    );

    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-STA", "-Command", &script])
        .output()
        .map_err(|error| format!("Failed to open save dialog: {error}"))?;

    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Save dialog failed: {error}"));
    }

    let selected_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if selected_path.is_empty() {
        return Ok(None);
    }

    fs::write(&selected_path, contents)
        .map_err(|error| format!("Failed to write export file: {error}"))?;
    Ok(Some(selected_path))
}

#[cfg(any(target_os = "macos", test))]
fn write_selected_export(
    selected: Option<std::path::PathBuf>,
    contents: &str,
) -> Result<Option<String>, String> {
    let Some(path) = selected else { return Ok(None) };
    let result_path = path.to_str().ok_or("Export path is not valid UTF-8")?.to_string();
    fs::write(&path, contents).map_err(|error| format!("Failed to write export file: {error}"))?;
    Ok(Some(result_path))
}

// Async command context follows the existing native Markdown save-dialog owner;
// no PowerShell, external shell, Keychain, or manuscript Session mutation.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn save_text_file(
    app: tauri::AppHandle,
    default_file_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let selected = app.dialog().file().set_file_name(default_file_name).blocking_save_file();
    let selected = selected.map(|file| file.into_path())
        .transpose().map_err(|error| format!("Invalid export file path: {error}"))?;
    write_selected_export(selected, &contents)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelled_export_has_no_write_and_selected_export_preserves_exact_utf8() {
        assert_eq!(write_selected_export(None, "cancelled"), Ok(None));
        let root = std::env::temp_dir().join(format!("sciloom-b1-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("研究 export.json");
        let body = "{\"title\":\"研究\"}\n";
        assert_eq!(write_selected_export(Some(path.clone()), body).unwrap(), Some(path.to_str().unwrap().to_string()));
        assert_eq!(std::fs::read(&path).unwrap(), body.as_bytes());
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&root).unwrap();
    }

    #[test]
    fn export_write_failure_is_not_reported_as_success() {
        let missing = std::env::temp_dir().join(format!("sciloom-b1-missing-{}", uuid::Uuid::new_v4())).join("export.json");
        assert!(write_selected_export(Some(missing.clone()), "test").is_err());
        assert!(!missing.exists());
    }
}
