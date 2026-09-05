use std::{fs, process::Command};

fn escape_powershell_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

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
