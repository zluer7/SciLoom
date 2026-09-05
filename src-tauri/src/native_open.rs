use crate::provisioning::{path_for_result, validate_existing_managed_path};
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, PartialEq, Eq)]
struct NativeCommandSpec {
    program: &'static str,
    args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOpenFileDiagnostics {
    received: bool,
    path_validation_passed: bool,
    powershell_started: bool,
    powershell_success: bool,
    status_code: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFolderValidation {
    path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePathInspection {
    status: String,
    path: String,
    expected_resource_kind: String,
    actual_resource_kind: Option<String>,
    canonical_path: Option<String>,
    symlink_detected: bool,
    error_code: Option<String>,
}

fn inspect_path(
    path_value: &str,
    expected_resource_kind: &str,
    configured_root: Option<&str>,
) -> NativePathInspection {
    let trimmed = path_value.trim();
    let base = NativePathInspection {
        status: "unavailable".to_string(),
        path: path_value.to_string(),
        expected_resource_kind: expected_resource_kind.to_string(),
        actual_resource_kind: None,
        canonical_path: None,
        symlink_detected: false,
        error_code: None,
    };
    if trimmed.is_empty() || !Path::new(trimmed).is_absolute() {
        return NativePathInspection {
            error_code: Some("invalid_path".to_string()),
            ..base
        };
    }
    if expected_resource_kind != "file" && expected_resource_kind != "folder" {
        return NativePathInspection {
            error_code: Some("invalid_resource_kind".to_string()),
            ..base
        };
    }
    let path = Path::new(trimmed);
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return NativePathInspection {
                status: "missing".to_string(),
                error_code: Some("path_not_found".to_string()),
                ..base
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            return NativePathInspection {
                error_code: Some("permission_denied".to_string()),
                ..base
            }
        }
        Err(_) => {
            return NativePathInspection {
                error_code: Some("path_unavailable".to_string()),
                ..base
            }
        }
    };
    let symlink_detected = metadata.file_type().is_symlink();
    let target_metadata = if symlink_detected {
        match fs::metadata(path) {
            Ok(target_metadata) => target_metadata,
            Err(_) => {
                return NativePathInspection {
                    symlink_detected,
                    error_code: Some("symlink_target_unavailable".to_string()),
                    ..base
                }
            }
        }
    } else {
        metadata
    };
    let actual_resource_kind = if target_metadata.is_file() {
        Some("file".to_string())
    } else if target_metadata.is_dir() {
        Some("folder".to_string())
    } else {
        None
    };
    if actual_resource_kind.as_deref() != Some(expected_resource_kind) {
        return NativePathInspection {
            status: "wrong_type".to_string(),
            actual_resource_kind,
            symlink_detected,
            error_code: Some("wrong_resource_type".to_string()),
            ..base
        };
    }
    let canonical = match fs::canonicalize(path) {
        Ok(canonical) => canonical,
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            return NativePathInspection {
                actual_resource_kind,
                symlink_detected,
                error_code: Some("permission_denied".to_string()),
                ..base
            }
        }
        Err(_) => {
            return NativePathInspection {
                actual_resource_kind,
                symlink_detected,
                error_code: Some("canonicalization_failed".to_string()),
                ..base
            }
        }
    };
    if let Some(root_value) = configured_root
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let root = match fs::canonicalize(root_value) {
            Ok(root) => root,
            Err(_) => {
                return NativePathInspection {
                    status: "managed_placement_invalid".to_string(),
                    actual_resource_kind,
                    canonical_path: Some(path_for_result(&canonical)),
                    symlink_detected,
                    error_code: Some("managed_root_invalid".to_string()),
                    ..base
                }
            }
        };
        if symlink_detected || !canonical.starts_with(&root) {
            return NativePathInspection {
                status: "managed_placement_invalid".to_string(),
                actual_resource_kind,
                canonical_path: Some(path_for_result(&canonical)),
                symlink_detected,
                error_code: Some("managed_path_outside_root".to_string()),
                ..base
            };
        }
    }
    NativePathInspection {
        status: "available".to_string(),
        actual_resource_kind,
        canonical_path: Some(path_for_result(&canonical)),
        symlink_detected,
        ..base
    }
}

pub(crate) fn canonical_path_is_available(
    path: &str,
    expected_resource_kind: &str,
    configured_root: Option<&str>,
) -> bool {
    inspect_path(path, expected_resource_kind, configured_root).status == "available"
}

pub(crate) fn canonical_path_for_available_resource(
    path: &str,
    expected_resource_kind: &str,
    configured_root: Option<&str>,
) -> Option<PathBuf> {
    let inspection = inspect_path(path, expected_resource_kind, configured_root);
    if inspection.status != "available" {
        return None;
    }
    inspection.canonical_path.map(PathBuf::from)
}

#[tauri::command(rename_all = "camelCase")]
pub fn inspect_local_path(
    path: String,
    expected_resource_kind: String,
    configured_root: Option<String>,
) -> NativePathInspection {
    inspect_path(&path, &expected_resource_kind, configured_root.as_deref())
}

fn ensure_existing_file(file_path: &str) -> Result<(), String> {
    let path = Path::new(file_path);
    if !path.exists() {
        return Err("file does not exist".to_string());
    }
    if !path.is_file() {
        return Err("path is not a file".to_string());
    }
    Ok(())
}

fn ensure_existing_folder(folder_path: &str) -> Result<(), String> {
    let trimmed = folder_path.trim();
    let path = Path::new(trimmed);
    if trimmed.is_empty() || !path.is_absolute() {
        return Err("WORKSPACE_FOLDER_INVALID".to_string());
    }
    if !path.exists() {
        return Err("WORKSPACE_FOLDER_NOT_FOUND".to_string());
    }
    if !path.is_dir() {
        return Err("WORKSPACE_FOLDER_INVALID".to_string());
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn validate_existing_folder(folder_path: String) -> Result<NativeFolderValidation, String> {
    ensure_existing_folder(&folder_path)?;
    let metadata = fs::symlink_metadata(folder_path.trim())
        .map_err(|_| "WORKSPACE_FOLDER_INVALID".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("WORKSPACE_FOLDER_INVALID".to_string());
    }
    Ok(NativeFolderValidation { path: folder_path })
}

#[tauri::command(rename_all = "camelCase")]
pub fn validate_managed_folder(
    configured_root: String,
    folder_path: String,
) -> Result<NativeFolderValidation, String> {
    let root = Path::new(configured_root.trim());
    let folder = Path::new(folder_path.trim());
    if configured_root.trim().is_empty()
        || folder_path.trim().is_empty()
        || !root.is_absolute()
        || !folder.is_absolute()
    {
        return Err("WORKSPACE_FOLDER_INVALID".to_string());
    }
    let metadata = fs::symlink_metadata(folder).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "WORKSPACE_FOLDER_NOT_FOUND".to_string()
        } else {
            "WORKSPACE_FOLDER_INVALID".to_string()
        }
    })?;
    if metadata.file_type().is_symlink() {
        return Err("WORKSPACE_FOLDER_OUTSIDE_ROOT".to_string());
    }
    if !metadata.is_dir() {
        return Err("WORKSPACE_FOLDER_INVALID".to_string());
    }
    let canonical = validate_existing_managed_path(root, folder)
        .map_err(|_| "WORKSPACE_FOLDER_OUTSIDE_ROOT".to_string())?;
    if !canonical.is_dir() {
        return Err("WORKSPACE_FOLDER_INVALID".to_string());
    }
    Ok(NativeFolderValidation {
        path: path_for_result(&canonical),
    })
}

fn build_open_file_command(file_path: &str) -> NativeCommandSpec {
    NativeCommandSpec {
        program: "powershell.exe",
        args: vec![
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-Command".to_string(),
            "& { param([string]$targetPath) Invoke-Item -LiteralPath $targetPath }".to_string(),
            file_path.to_string(),
        ],
    }
}

fn windows_native_command_path(folder_path: &str) -> String {
    let mut native_path = folder_path.replace('/', "\\");
    if native_path.as_bytes().get(1) == Some(&b':') {
        let uppercase_drive = native_path[..1].to_ascii_uppercase();
        native_path.replace_range(..1, &uppercase_drive);
    }
    native_path
}

fn build_open_folder_command(folder_path: &str) -> NativeCommandSpec {
    NativeCommandSpec {
        program: "explorer.exe",
        args: vec![windows_native_command_path(folder_path)],
    }
}

fn command_from_spec(spec: NativeCommandSpec) -> Command {
    let mut command = Command::new(spec.program);
    command.args(spec.args);
    command
}

fn run_command(mut command: Command, action: &str) -> Result<(), String> {
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to {action}: {error}"))
}

fn run_command_and_wait(mut command: Command, action: &str) -> Result<Option<i32>, String> {
    let output = command
        .output()
        .map_err(|error| format!("native_powershell_spawn_failed: failed to {action}: {error}"))?;

    let status_code = output.status.code();
    if output.status.success() {
        return Ok(status_code);
    }

    let status = output
        .status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "terminated".to_string());
    Err(format!(
        "native_powershell_status_failed: native command failed during {action}; status {status}"
    ))
}

#[tauri::command(rename_all = "camelCase")]
pub fn open_file(file_path: String) -> Result<NativeOpenFileDiagnostics, String> {
    let mut diagnostics = NativeOpenFileDiagnostics {
        received: true,
        path_validation_passed: false,
        powershell_started: false,
        powershell_success: false,
        status_code: None,
    };

    ensure_existing_file(&file_path).map_err(|error| match error.as_str() {
        "file does not exist" => "native_file_not_found".to_string(),
        "path is not a file" => "native_invalid_file_path".to_string(),
        _ => "native_invalid_file_path".to_string(),
    })?;
    diagnostics.path_validation_passed = true;

    let status_code = run_command_and_wait(
        command_from_spec(build_open_file_command(&file_path)),
        "open file",
    )?;
    diagnostics.powershell_started = true;
    diagnostics.powershell_success = true;
    diagnostics.status_code = status_code;
    Ok(diagnostics)
}

#[tauri::command(rename_all = "camelCase")]
pub fn open_folder(folder_path: String) -> Result<(), String> {
    ensure_existing_folder(&folder_path)?;

    run_command(
        command_from_spec(build_open_folder_command(&folder_path)),
        "open folder",
    )
    .map_err(|error| format!("WORKSPACE_FOLDER_OPEN_FAILED: {error}"))
}

#[tauri::command(rename_all = "camelCase")]
pub fn reveal_in_folder(file_path: String) -> Result<(), String> {
    ensure_existing_file(&file_path)?;

    let mut command = Command::new("explorer");
    command.arg("/select,").arg(file_path);
    run_command(command, "reveal file in folder")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_file_command_uses_powershell_invoke_item_literal_path() {
        let command = build_open_file_command("C:\\Temp\\labpod test.txt");

        assert_eq!(command.program, "powershell.exe");
        assert_eq!(
            command.args,
            [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "& { param([string]$targetPath) Invoke-Item -LiteralPath $targetPath }",
                "C:\\Temp\\labpod test.txt"
            ]
        );
    }

    #[test]
    fn open_file_diagnostics_can_represent_powershell_success() {
        let diagnostics = NativeOpenFileDiagnostics {
            received: true,
            path_validation_passed: true,
            powershell_started: true,
            powershell_success: true,
            status_code: Some(0),
        };

        assert!(diagnostics.received);
        assert!(diagnostics.path_validation_passed);
        assert!(diagnostics.powershell_started);
        assert!(diagnostics.powershell_success);
        assert_eq!(diagnostics.status_code, Some(0));
    }

    #[test]
    fn open_folder_command_uses_one_native_windows_target_argument() {
        let folder = "c:/Temp/LabPod 工作目录/a very long folder name";
        let command = build_open_folder_command(folder);

        assert_eq!(command.program, "explorer.exe");
        assert_eq!(
            command.args,
            [r"C:\Temp\LabPod 工作目录\a very long folder name"]
        );
        assert!(!command.args[0].contains("/select,"));
        assert!(!command.args[0].contains('/'));
    }

    #[test]
    fn windows_folder_path_conversion_preserves_drive_unicode_spaces_and_length() {
        let cases = [
            ("c:/users/test/中文目录", r"C:\users\test\中文目录"),
            (
                "C:/Users/Test/Folder With Spaces",
                r"C:\Users\Test\Folder With Spaces",
            ),
            (r"C:\Users\Test\中文目录", r"C:\Users\Test\中文目录"),
        ];
        for (input, expected) in cases {
            let command = build_open_folder_command(input);
            assert_eq!(command.args, [expected]);
            assert_eq!(&command.args[0][..2], "C:");
        }

        let long_unicode = format!("c:/users/test/{}", "很长的目录".repeat(48));
        let command = build_open_folder_command(&long_unicode);
        assert_eq!(&command.args[0][..2], "C:");
        assert!(command.args[0].contains(r"\很长的目录"));
        assert!(!command.args[0].contains('/'));
        assert!(command.args[0].len() > 260);
    }

    #[test]
    fn folder_validation_rejects_empty_relative_missing_and_file_targets() {
        assert_eq!(
            ensure_existing_folder(""),
            Err("WORKSPACE_FOLDER_INVALID".to_string())
        );
        assert_eq!(
            ensure_existing_folder("."),
            Err("WORKSPACE_FOLDER_INVALID".to_string())
        );

        let missing = std::env::temp_dir().join(format!(
            "labpod-native-folder-missing-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&missing);
        assert_eq!(
            ensure_existing_folder(&missing.to_string_lossy()),
            Err("WORKSPACE_FOLDER_NOT_FOUND".to_string())
        );
    }

    #[test]
    fn folder_validation_rejects_a_file_target() {
        let root =
            std::env::temp_dir().join(format!("labpod-native-folder-file-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create root");
        let file = root.join("not-a-folder.md");
        fs::write(&file, "test").expect("write file");

        let result = validate_managed_folder(
            root.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
        );

        assert_eq!(result, Err("WORKSPACE_FOLDER_INVALID".to_string()));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn folder_validation_returns_the_exact_existing_descendant() {
        let root =
            std::env::temp_dir().join(format!("labpod native folder 中文 {}", std::process::id()));
        let folder = root.join("workspace folder");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&folder).expect("create folder");

        let result = validate_managed_folder(
            root.to_string_lossy().into_owned(),
            folder.to_string_lossy().into_owned(),
        )
        .expect("validate folder");

        assert_eq!(
            result.path,
            path_for_result(&fs::canonicalize(&folder).unwrap())
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn path_inspection_separates_missing_wrong_type_and_available() {
        let root =
            std::env::temp_dir().join(format!("labpod-file-ref-inspection-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create root");
        let file = root.join("sample.txt");
        fs::write(&file, "unchanged").expect("write fixture");
        let bytes_before = fs::read(&file).expect("read fixture before inspection");
        let modified_before = fs::metadata(&file)
            .expect("metadata before inspection")
            .modified()
            .expect("mtime before inspection");

        let missing = inspect_path(&root.join("missing.txt").to_string_lossy(), "file", None);
        assert_eq!(missing.status, "missing");

        let wrong_type = inspect_path(&file.to_string_lossy(), "folder", None);
        assert_eq!(wrong_type.status, "wrong_type");
        assert_eq!(wrong_type.actual_resource_kind.as_deref(), Some("file"));

        let available = inspect_path(
            &file.to_string_lossy(),
            "file",
            Some(&root.to_string_lossy()),
        );
        assert_eq!(available.status, "available");
        assert_eq!(available.actual_resource_kind.as_deref(), Some("file"));
        assert_eq!(
            fs::read(&file).expect("read fixture after inspection"),
            bytes_before
        );
        assert_eq!(
            fs::metadata(&file)
                .expect("metadata after inspection")
                .modified()
                .expect("mtime after inspection"),
            modified_before
        );

        let outside = std::env::temp_dir().join(format!(
            "labpod-file-ref-inspection-outside-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).expect("create outside root");
        let outside_file = outside.join("outside.txt");
        fs::write(&outside_file, "outside").expect("write outside fixture");
        let invalid_managed = inspect_path(
            &outside_file.to_string_lossy(),
            "file",
            Some(&root.to_string_lossy()),
        );
        assert_eq!(invalid_managed.status, "managed_placement_invalid");

        let _ = fs::remove_dir_all(&outside);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn path_inspection_follows_external_symlinks_but_rejects_managed_symlinks() {
        let root = std::env::temp_dir().join(format!(
            "labpod-file-ref-symlink-inspection-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create symlink inspection root");
        let target = root.join("target.txt");
        let link = root.join("link.txt");
        fs::write(&target, "unchanged symlink target").expect("write symlink target");

        #[cfg(windows)]
        let link_result = std::os::windows::fs::symlink_file(&target, &link);
        #[cfg(unix)]
        let link_result = std::os::unix::fs::symlink(&target, &link);

        if link_result.is_ok() {
            let external = inspect_path(&link.to_string_lossy(), "file", None);
            assert_eq!(external.status, "available");
            assert!(external.symlink_detected);
            assert_eq!(external.actual_resource_kind.as_deref(), Some("file"));

            let managed = inspect_path(
                &link.to_string_lossy(),
                "file",
                Some(&root.to_string_lossy()),
            );
            assert_eq!(managed.status, "managed_placement_invalid");
            assert!(managed.symlink_detected);
        }

        assert_eq!(
            fs::read(&target).expect("read symlink target"),
            b"unchanged symlink target"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn path_inspection_rejects_a_managed_directory_junction() {
        let root = std::env::temp_dir().join(format!(
            "labpod-file-ref-junction-root-{}",
            std::process::id()
        ));
        let outside = std::env::temp_dir().join(format!(
            "labpod-file-ref-junction-target-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&root).expect("create junction root");
        fs::create_dir_all(&outside).expect("create junction target");
        let target_file = outside.join("unchanged.txt");
        fs::write(&target_file, "unchanged junction target").expect("write junction target");
        let junction = root.join("junction");
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .status()
            .expect("run mklink junction command");
        assert!(status.success(), "create directory junction");

        let external = inspect_path(&junction.to_string_lossy(), "folder", None);
        assert_eq!(external.status, "available");
        let managed = inspect_path(
            &junction.to_string_lossy(),
            "folder",
            Some(&root.to_string_lossy()),
        );
        assert_eq!(managed.status, "managed_placement_invalid");
        assert_eq!(
            fs::read(&target_file).expect("read junction target"),
            b"unchanged junction target"
        );
        fs::remove_dir_all(&outside).expect("remove junction target to simulate unavailable path");
        let unavailable = inspect_path(&junction.to_string_lossy(), "folder", None);
        assert_eq!(unavailable.status, "unavailable");

        let _ = fs::remove_dir_all(&root);
    }
}
