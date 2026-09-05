use serde::Serialize;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};

#[cfg(test)]
const BODY_FILE_NAME: &str = "body.md";

pub(crate) fn path_for_result(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    value.into_owned()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionManagedEntryResult {
    status: String,
    directory_path: String,
    body_path: String,
    created_directory: bool,
    created_body: bool,
    reused_directory: bool,
    reused_body: bool,
    retryable: bool,
    error_code: Option<String>,
    error_message: Option<String>,
}

impl ProvisionManagedEntryResult {
    fn failure(
        status: &str,
        directory_path: &Path,
        body_path: &Path,
        created_directory: bool,
        code: &str,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            status: status.to_string(),
            directory_path: path_for_result(directory_path),
            body_path: path_for_result(body_path),
            created_directory,
            created_body: false,
            reused_directory: !created_directory && directory_path.is_dir(),
            reused_body: false,
            retryable,
            error_code: Some(code.to_string()),
            error_message: Some(message.into()),
        }
    }

    fn failure_after_body_create(
        directory_path: &Path,
        body_path: &Path,
        created_directory: bool,
        code: &str,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            status: "partial".to_string(),
            directory_path: path_for_result(directory_path),
            body_path: path_for_result(body_path),
            created_directory,
            created_body: true,
            reused_directory: !created_directory,
            reused_body: false,
            retryable,
            error_code: Some(code.to_string()),
            error_message: Some(message.into()),
        }
    }
}

#[derive(Debug)]
struct SafeComponent {
    comparison_key: String,
    normal_value: Option<OsString>,
}

fn comparison_key(value: &std::ffi::OsStr) -> String {
    let text = value.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        text.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        text
    }
}

fn safe_components(path: &Path) -> Result<Vec<SafeComponent>, &'static str> {
    if !path.is_absolute() {
        return Err("PROVISIONING_PATH_INVALID");
    }
    let mut result = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => result.push(SafeComponent {
                comparison_key: format!("prefix:{}", comparison_key(prefix.as_os_str())),
                normal_value: None,
            }),
            Component::RootDir => result.push(SafeComponent {
                comparison_key: "root".to_string(),
                normal_value: None,
            }),
            Component::CurDir => {}
            Component::ParentDir => return Err("PROVISIONING_PATH_OUTSIDE_ROOT"),
            Component::Normal(value) => result.push(SafeComponent {
                comparison_key: format!("normal:{}", comparison_key(value)),
                normal_value: Some(value.to_os_string()),
            }),
        }
    }
    Ok(result)
}

pub(crate) fn descendant_relative(root: &Path, target: &Path) -> Result<PathBuf, &'static str> {
    let root_components = safe_components(root)?;
    let target_components = safe_components(target)?;
    if root_components.len() > target_components.len()
        || !root_components
            .iter()
            .zip(target_components.iter())
            .all(|(root_component, target_component)| {
                root_component.comparison_key == target_component.comparison_key
            })
    {
        return Err("PROVISIONING_PATH_OUTSIDE_ROOT");
    }
    let mut relative = PathBuf::new();
    for component in target_components.into_iter().skip(root_components.len()) {
        if let Some(value) = component.normal_value {
            relative.push(value);
        }
    }
    Ok(relative)
}

#[cfg(test)]
pub(crate) fn create_managed_descendant_directory(
    configured_root: &Path,
    default_folder: &Path,
    target_directory: &Path,
) -> Result<(PathBuf, bool), &'static str> {
    let canonical_default = validate_existing_managed_path(configured_root, default_folder)
        .map_err(|_| "CANDIDATE_PATH_OUTSIDE_ROOT")?;
    if !canonical_default.is_dir() {
        return Err("CANDIDATE_DEFAULT_FOLDER_INVALID");
    }
    let relative = descendant_relative(default_folder, target_directory)
        .map_err(|_| "CANDIDATE_PATH_OUTSIDE_ROOT")?;
    if relative.as_os_str().is_empty() {
        return Err("CANDIDATE_PATH_INVALID");
    }
    ensure_existing_ancestors_are_directories_without_symlinks(&canonical_default, &relative)
        .map_err(|error| match error {
            "PROVISIONING_DIRECTORY_CONFLICT" => "CANDIDATE_FILE_CONFLICT",
            "PROVISIONING_PATH_OUTSIDE_ROOT" => "CANDIDATE_PATH_OUTSIDE_ROOT",
            _ => "CANDIDATE_DIRECTORY_CREATE_FAILED",
        })?;
    let actual = canonical_default.join(&relative);
    let existed = actual.exists();
    if !existed {
        fs::create_dir_all(&actual).map_err(|_| "CANDIDATE_DIRECTORY_CREATE_FAILED")?;
    }
    let canonical_target = fs::canonicalize(&actual)
        .map_err(|_| "CANDIDATE_DIRECTORY_CREATE_FAILED")?;
    if !canonical_target.is_dir() {
        return Err("CANDIDATE_FILE_CONFLICT");
    }
    descendant_relative(&canonical_default, &canonical_target)
        .map_err(|_| "CANDIDATE_PATH_OUTSIDE_ROOT")?;
    Ok((canonical_target, !existed))
}

fn ensure_existing_ancestors_are_directories_without_symlinks(
    canonical_root: &Path,
    relative_target: &Path,
) -> Result<(), &'static str> {
    let mut current = canonical_root.to_path_buf();
    for component in relative_target.components() {
        let Component::Normal(value) = component else {
            return Err("PROVISIONING_PATH_INVALID");
        };
        current.push(value);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err("PROVISIONING_PATH_OUTSIDE_ROOT");
                }
                if !metadata.is_dir() && current != canonical_root.join(relative_target) {
                    return Err("PROVISIONING_DIRECTORY_CONFLICT");
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => return Err("PROVISIONING_DIRECTORY_CREATE_FAILED"),
        }
    }
    Ok(())
}

pub(crate) fn validate_existing_managed_path(
    configured_root: &Path,
    target: &Path,
) -> Result<PathBuf, &'static str> {
    if !configured_root.is_absolute() || !target.is_absolute() {
        return Err("MANUSCRIPT_PATH_INVALID");
    }
    let root_metadata =
        fs::metadata(configured_root).map_err(|_| "MANUSCRIPT_PATH_OUTSIDE_ROOT")?;
    if !root_metadata.is_dir() {
        return Err("MANUSCRIPT_PATH_OUTSIDE_ROOT");
    }
    let canonical_root =
        fs::canonicalize(configured_root).map_err(|_| "MANUSCRIPT_PATH_OUTSIDE_ROOT")?;
    let relative_target =
        descendant_relative(configured_root, target).map_err(|_| "MANUSCRIPT_PATH_OUTSIDE_ROOT")?;
    if relative_target.as_os_str().is_empty() {
        return Err("MANUSCRIPT_PATH_OUTSIDE_ROOT");
    }
    ensure_existing_ancestors_are_directories_without_symlinks(&canonical_root, &relative_target)
        .map_err(|_| "MANUSCRIPT_PATH_OUTSIDE_ROOT")?;
    let canonical_target = fs::canonicalize(canonical_root.join(relative_target))
        .map_err(|_| "MANUSCRIPT_PATH_OUTSIDE_ROOT")?;
    descendant_relative(&canonical_root, &canonical_target)
        .map_err(|_| "MANUSCRIPT_PATH_OUTSIDE_ROOT")?;
    Ok(canonical_target)
}

fn validate_body_target(target_directory: &Path, body_path: &Path) -> Result<(), &'static str> {
    let body_relative = descendant_relative(target_directory, body_path)?;
    let components: Vec<_> = body_relative.components().collect();
    let file_name = body_relative.file_name().and_then(|value| value.to_str()).unwrap_or("");
    let extension = body_relative.extension().and_then(|value| value.to_str()).unwrap_or("");
    if components.len() != 1 || file_name.is_empty() || !matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown") {
        return Err("PROVISIONING_PATH_INVALID");
    }
    Ok(())
}

fn validate_manuscript_identity_contract(
    owner_type: &str,
    manuscript_channel: &str,
    body_path: &Path,
) -> Result<(), &'static str> {
    let file_name = body_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    match owner_type {
        "review" => {
            if manuscript_channel != "primary" {
                return Err("PROVISIONING_MANUSCRIPT_CHANNEL_INVALID");
            }
            if file_name != "review.md" {
                return Err("PROVISIONING_PATH_INVALID");
            }
        }
        "literature" => {
            let expected = match manuscript_channel {
                "literature_outline" => "literature-outline.md",
                "dedicated_notes" => "dedicated-notes.md",
                _ => return Err("PROVISIONING_MANUSCRIPT_CHANNEL_INVALID"),
            };
            if file_name != expected {
                return Err("PROVISIONING_PATH_INVALID");
            }
        }
        "experiment" | "experimentRun" => {
            if manuscript_channel != "primary" {
                return Err("PROVISIONING_MANUSCRIPT_CHANNEL_INVALID");
            }
            if file_name != experiment_workspace_default_file_name(owner_type)? {
                return Err("PROVISIONING_PATH_INVALID");
            }
        }
        "resultItem" | "finding" | "outputCandidate" | "outputGap" | "researchOutput" => {
            if manuscript_channel != "primary" {
                return Err("PROVISIONING_MANUSCRIPT_CHANNEL_INVALID");
            }
        }
        _ => return Err("PROVISIONING_OWNER_NOT_FOUND"),
    }
    Ok(())
}

fn experiment_workspace_default_file_name(owner_type: &str) -> Result<&'static str, &'static str> {
    match owner_type {
        "experiment" => Ok("experiment.md"),
        "experimentRun" => Ok("experiment-run.md"),
        _ => Err("PROVISIONING_OWNER_NOT_FOUND"),
    }
}

// C1 establishes this safety descriptor without wiring it to real provisioning;
// C2/C3 will call the complete validation chain when those workflows are introduced.
#[allow(dead_code)]
fn normal_component_strings(path: &Path) -> Result<Vec<String>, &'static str> {
    let mut result = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => result.push(value.to_string_lossy().into_owned()),
            Component::CurDir => {}
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => {
                return Err("PROVISIONING_PATH_INVALID")
            }
        }
    }
    Ok(result)
}

#[allow(dead_code)]
fn is_ascii_digits(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_digit())
}

#[allow(dead_code)]
fn is_year_month(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7
        && bytes[4] == b'-'
        && is_ascii_digits(&value[..4], 4)
        && is_ascii_digits(&value[5..], 2)
        && matches!(value[5..].parse::<u8>(), Ok(1..=12))
}

#[allow(dead_code)]
fn is_day(value: &str) -> bool {
    is_ascii_digits(value, 2) && matches!(value.parse::<u8>(), Ok(1..=31))
}

#[allow(dead_code)]
fn is_stable_code(value: &str) -> bool {
    value.len() == 12
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[allow(dead_code)]
fn is_project_workspace_folder(value: &str) -> bool {
    let Some((safe_name, stable_code)) = value.rsplit_once('_') else {
        return false;
    };
    !safe_name.is_empty() && is_stable_code(stable_code)
}

#[allow(dead_code)]
fn windows_path_budget_cost(path: &Path) -> usize {
    let value = path.to_string_lossy();
    value.encode_utf16().count()
}

#[allow(dead_code)]
fn ensure_existing_directory_if_present(path: &Path) -> Result<(), &'static str> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err("PROVISIONING_DIRECTORY_CONFLICT")
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(_) => Err("PROVISIONING_PATH_INVALID"),
    }
}

#[allow(dead_code)]
fn is_workspace_folder(
    value: &str,
    year_month: &str,
    day: &str,
    owner_token: &str,
) -> bool {
    let date = format!("{year_month}-{day}");
    let Some(remainder) = value.strip_prefix(&format!("{date}_")) else {
        return false;
    };
    let Some((time, remainder)) = remainder.split_once('_') else {
        return false;
    };
    if !is_ascii_digits(time, 4) {
        return false;
    }
    let hour = time[..2].parse::<u8>();
    let minute = time[2..].parse::<u8>();
    if !matches!(hour, Ok(0..=23)) || !matches!(minute, Ok(0..=59)) {
        return false;
    }
    let Some(remainder) = remainder.strip_prefix(&format!("{owner_token}_")) else {
        return false;
    };
    let Some((stable_code, safe_title)) = remainder.split_once('_') else {
        return false;
    };
    is_stable_code(stable_code) && !safe_title.is_empty()
}

#[allow(dead_code)]
fn validate_experiment_shape(relative: &Path) -> Result<(), &'static str> {
    let components = normal_component_strings(relative)?;
    if components.len() != 4
        || !is_year_month(&components[0])
        || !is_day(&components[1])
        || components[2] != "experiment"
        || !is_workspace_folder(&components[3], &components[0], &components[1], "exp")
    {
        return Err("PROVISIONING_PATH_INVALID");
    }
    Ok(())
}

#[allow(dead_code)]
fn validate_run_shape(relative: &Path) -> Result<(), &'static str> {
    let components = normal_component_strings(relative)?;
    if components.len() != 4
        || components[0] != "runs"
        || !is_year_month(&components[1])
        || !is_day(&components[2])
        || !is_workspace_folder(&components[3], &components[1], &components[2], "run")
    {
        return Err("PROVISIONING_PATH_INVALID");
    }
    Ok(())
}

#[allow(dead_code)]
fn validate_experiment_workspace_foundation_path(
    owner_type: &str,
    configured_root: &Path,
    project_workspace: &Path,
    parent_experiment_workspace: Option<&Path>,
    target_workspace: &Path,
    default_file_name: &str,
) -> Result<(), &'static str> {
    if experiment_workspace_default_file_name(owner_type)? != default_file_name {
        return Err("PROVISIONING_PATH_INVALID");
    }
    if !configured_root.is_absolute()
        || !project_workspace.is_absolute()
        || !target_workspace.is_absolute()
    {
        return Err("PROVISIONING_PATH_INVALID");
    }
    let root_metadata = fs::symlink_metadata(configured_root)
        .map_err(|_| "PROVISIONING_ROOT_INVALID")?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("PROVISIONING_ROOT_INVALID");
    }
    let canonical_root =
        fs::canonicalize(configured_root).map_err(|_| "PROVISIONING_ROOT_INVALID")?;

    let project_relative = descendant_relative(configured_root, project_workspace)?;
    let project_components = normal_component_strings(&project_relative)?;
    if project_components.len() != 2
        || project_components[0] != "projects"
        || !is_project_workspace_folder(&project_components[1])
    {
        return Err("PROVISIONING_PATH_INVALID");
    }
    ensure_existing_ancestors_are_directories_without_symlinks(
        &canonical_root,
        &project_relative,
    )?;
    ensure_existing_directory_if_present(project_workspace)?;

    let target_relative = descendant_relative(configured_root, target_workspace)?;
    ensure_existing_ancestors_are_directories_without_symlinks(&canonical_root, &target_relative)?;
    ensure_existing_directory_if_present(target_workspace)?;
    if windows_path_budget_cost(&target_workspace.join(default_file_name)) > 240 {
        return Err("PROVISIONING_PATH_INVALID");
    }

    match owner_type {
        "experiment" => {
            if parent_experiment_workspace.is_some() {
                return Err("PROVISIONING_PATH_INVALID");
            }
            let relative = descendant_relative(project_workspace, target_workspace)?;
            validate_experiment_shape(&relative)?;
        }
        "experimentRun" => {
            let parent = parent_experiment_workspace.ok_or("PROVISIONING_PATH_INVALID")?;
            if !parent.is_absolute() {
                return Err("PROVISIONING_PATH_INVALID");
            }
            ensure_existing_directory_if_present(parent)?;
            let parent_relative_root = descendant_relative(configured_root, parent)?;
            ensure_existing_ancestors_are_directories_without_symlinks(
                &canonical_root,
                &parent_relative_root,
            )?;
            let parent_relative_project = descendant_relative(project_workspace, parent)?;
            validate_experiment_shape(&parent_relative_project)?;
            let relative = descendant_relative(parent, target_workspace)?;
            validate_run_shape(&relative)?;
        }
        _ => return Err("PROVISIONING_OWNER_NOT_FOUND"),
    }
    Ok(())
}

fn provision_managed_entry_core(
    configured_root: &Path,
    target_directory: &Path,
    body_path: &Path,
    initial_content: &str,
    allow_create_body: bool,
    allow_non_empty_initial_content: bool,
) -> ProvisionManagedEntryResult {
    if !allow_non_empty_initial_content && !initial_content.is_empty() {
        return ProvisionManagedEntryResult::failure(
            "error",
            target_directory,
            body_path,
            false,
            "PROVISIONING_BODY_CREATE_FAILED",
            "Managed manuscript provisioning only permits empty initial UTF-8 content.",
            false,
        );
    }
    if !configured_root.is_absolute() || !target_directory.is_absolute() || !body_path.is_absolute() {
        return ProvisionManagedEntryResult::failure(
            "error",
            target_directory,
            body_path,
            false,
            "PROVISIONING_PATH_INVALID",
            "Configured root, target directory, and body path must be absolute.",
            false,
        );
    }
    if safe_components(configured_root).is_err()
        || safe_components(target_directory).is_err()
        || safe_components(body_path).is_err()
    {
        return ProvisionManagedEntryResult::failure(
            "error",
            target_directory,
            body_path,
            false,
            "PROVISIONING_PATH_OUTSIDE_ROOT",
            "Path contains an unsafe parent segment.",
            false,
        );
    }

    let root_metadata = match fs::metadata(configured_root) {
        Ok(metadata) if metadata.is_dir() => metadata,
        Ok(_) => {
            return ProvisionManagedEntryResult::failure(
                "error",
                target_directory,
                body_path,
                false,
                "PROVISIONING_ROOT_INVALID",
                "Configured root is not a directory.",
                false,
            )
        }
        Err(_) => {
            return ProvisionManagedEntryResult::failure(
                "error",
                target_directory,
                body_path,
                false,
                "PROVISIONING_ROOT_INVALID",
                "Configured root does not exist or cannot be accessed.",
                true,
            )
        }
    };
    let _ = root_metadata;
    let canonical_root = match fs::canonicalize(configured_root) {
        Ok(path) => path,
        Err(_) => {
            return ProvisionManagedEntryResult::failure(
                "error",
                target_directory,
                body_path,
                false,
                "PROVISIONING_ROOT_INVALID",
                "Configured root cannot be canonicalized.",
                true,
            )
        }
    };
    let relative_target = match descendant_relative(configured_root, target_directory) {
        Ok(path) if !path.as_os_str().is_empty() => path,
        _ => {
            return ProvisionManagedEntryResult::failure(
                "error",
                target_directory,
                body_path,
                false,
                "PROVISIONING_PATH_OUTSIDE_ROOT",
                "Target directory must be a descendant of configured root.",
                false,
            )
        }
    };
    if validate_body_target(target_directory, body_path).is_err() {
        return ProvisionManagedEntryResult::failure(
            "error",
            target_directory,
            body_path,
            false,
            "PROVISIONING_PATH_INVALID",
            "The Markdown manuscript must be a direct child of the target directory.",
            false,
        );
    }
    if let Err(code) = ensure_existing_ancestors_are_directories_without_symlinks(
        &canonical_root,
        &relative_target,
    ) {
        return ProvisionManagedEntryResult::failure(
            "error",
            target_directory,
            body_path,
            false,
            code,
            "Target path contains a conflict or symlink.",
            false,
        );
    }

    if !allow_create_body && !body_path.exists() {
        return ProvisionManagedEntryResult::failure(
            "error",
            target_directory,
            body_path,
            false,
            "PROVISIONING_BODY_MISSING_REPAIR_REQUIRED",
            "The provisioned manuscript identity exists but the physical file is missing; explicit repair is required.",
            false,
        );
    }

    let actual_directory = canonical_root.join(&relative_target);
    let directory_existed = actual_directory.exists();
    if directory_existed && !actual_directory.is_dir() {
        return ProvisionManagedEntryResult::failure(
            "error",
            &actual_directory,
            body_path,
            false,
            "PROVISIONING_DIRECTORY_CONFLICT",
            "Target directory path is occupied by a file.",
            false,
        );
    }
    let created_directory = if directory_existed {
        false
    } else {
        let Some(parent_directory) = actual_directory.parent() else {
            return ProvisionManagedEntryResult::failure(
                "error",
                &actual_directory,
                body_path,
                false,
                "PROVISIONING_PATH_INVALID",
                "Target directory has no managed parent.",
                false,
            );
        };
        if fs::create_dir_all(parent_directory).is_err() {
            return ProvisionManagedEntryResult::failure(
                "partial",
                &actual_directory,
                body_path,
                false,
                "PROVISIONING_DIRECTORY_CREATE_FAILED",
                "Target parent directories could not be created; intermediate directories may remain.",
                true,
            );
        }
        match fs::create_dir(&actual_directory) {
            Ok(()) => true,
            Err(error) if error.kind() == ErrorKind::AlreadyExists && actual_directory.is_dir() => false,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                return ProvisionManagedEntryResult::failure(
                    "partial",
                    &actual_directory,
                    body_path,
                    false,
                    "PROVISIONING_DIRECTORY_CONFLICT",
                    "Target directory path became occupied by a non-directory entry.",
                    false,
                );
            }
            Err(_) => {
                return ProvisionManagedEntryResult::failure(
                    "partial",
                    &actual_directory,
                    body_path,
                    false,
                    "PROVISIONING_DIRECTORY_CREATE_FAILED",
                    "Target directory could not be created; intermediate directories may remain.",
                    true,
                );
            }
        }
    };

    let canonical_directory = match fs::canonicalize(&actual_directory) {
        Ok(path) => path,
        Err(_) => {
            return ProvisionManagedEntryResult::failure(
                "partial",
                &actual_directory,
                body_path,
                created_directory,
                "PROVISIONING_DIRECTORY_CREATE_FAILED",
                "Created directory could not be canonicalized.",
                true,
            )
        }
    };
    if descendant_relative(&canonical_root, &canonical_directory).is_err() {
        return ProvisionManagedEntryResult::failure(
            "partial",
            &canonical_directory,
            body_path,
            created_directory,
            "PROVISIONING_PATH_OUTSIDE_ROOT",
            "Created directory resolved outside configured root.",
            false,
        );
    }

    let actual_body = canonical_directory.join(body_path.file_name().expect("validated manuscript filename"));
    match fs::symlink_metadata(&actual_body) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return ProvisionManagedEntryResult::failure(
                if created_directory { "partial" } else { "error" },
                &canonical_directory,
                &actual_body,
                created_directory,
                "PROVISIONING_BODY_CONFLICT",
                "The manuscript path exists but is not a regular file.",
                false,
            )
        }
        Ok(_) => {
            let existing_bytes = match fs::read(&actual_body) {
                Ok(bytes) => bytes,
                Err(_) => {
                    return ProvisionManagedEntryResult::failure(
                        if created_directory { "partial" } else { "error" },
                        &canonical_directory,
                        &actual_body,
                        created_directory,
                        "PROVISIONING_BODY_READBACK_FAILED",
                        "The existing manuscript could not be physically read back.",
                        true,
                    )
                }
            };
            if std::str::from_utf8(&existing_bytes).is_err() {
                return ProvisionManagedEntryResult::failure(
                    if created_directory { "partial" } else { "error" },
                    &canonical_directory,
                    &actual_body,
                    created_directory,
                    "PROVISIONING_BODY_ENCODING_UNSUPPORTED",
                    "The existing manuscript is not valid UTF-8 and was left unchanged.",
                    false,
                );
            }
            return ProvisionManagedEntryResult {
                status: if created_directory { "success" } else { "skipped" }.to_string(),
                directory_path: path_for_result(&canonical_directory),
                body_path: path_for_result(&actual_body),
                created_directory,
                created_body: false,
                reused_directory: !created_directory,
                reused_body: true,
                retryable: false,
                error_code: None,
                error_message: None,
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(_) => {
            return ProvisionManagedEntryResult::failure(
                if created_directory { "partial" } else { "error" },
                &canonical_directory,
                &actual_body,
                created_directory,
                "PROVISIONING_BODY_CREATE_FAILED",
                "Manuscript metadata could not be inspected.",
                true,
            )
        }
    }

    let mut body_file = match OpenOptions::new().write(true).create_new(true).open(&actual_body) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::AlreadyExists && actual_body.is_file() => {
            return ProvisionManagedEntryResult {
                status: if created_directory { "success" } else { "skipped" }.to_string(),
                directory_path: path_for_result(&canonical_directory),
                body_path: path_for_result(&actual_body),
                created_directory,
                created_body: false,
                reused_directory: !created_directory,
                reused_body: true,
                retryable: false,
                error_code: None,
                error_message: None,
            }
        }
        Err(_) => {
            return ProvisionManagedEntryResult::failure(
                "partial",
                &canonical_directory,
                &actual_body,
                created_directory,
                "PROVISIONING_BODY_CREATE_FAILED",
                "The manuscript could not be created with create-new semantics.",
                true,
            )
        }
    };
    if body_file.write_all(initial_content.as_bytes()).is_err() {
        return ProvisionManagedEntryResult::failure_after_body_create(
            &canonical_directory,
            &actual_body,
            created_directory,
            "PROVISIONING_BODY_CREATE_FAILED",
            "The manuscript was created but initial UTF-8 content could not be written.",
            true,
        );
    }
    if body_file.sync_all().is_err() {
        return ProvisionManagedEntryResult::failure_after_body_create(
            &canonical_directory,
            &actual_body,
            created_directory,
            "PROVISIONING_BODY_READBACK_FAILED",
            "The manuscript was created but could not be synchronized before readback.",
            true,
        );
    }
    drop(body_file);
    let readback = match fs::read(&actual_body) {
        Ok(bytes) => bytes,
        Err(_) => {
            return ProvisionManagedEntryResult::failure_after_body_create(
                &canonical_directory,
                &actual_body,
                created_directory,
                "PROVISIONING_BODY_READBACK_FAILED",
                "The manuscript was created but physical readback failed.",
                true,
            )
        }
    };
    if readback != initial_content.as_bytes() {
        return ProvisionManagedEntryResult::failure_after_body_create(
            &canonical_directory,
            &actual_body,
            created_directory,
            "PROVISIONING_BODY_READBACK_FAILED",
            "The manuscript physical readback did not match the requested UTF-8 content.",
            true,
        );
    }

    ProvisionManagedEntryResult {
        status: "success".to_string(),
        directory_path: path_for_result(&canonical_directory),
        body_path: path_for_result(&actual_body),
        created_directory,
        created_body: true,
        reused_directory: !created_directory,
        reused_body: false,
        retryable: false,
        error_code: None,
        error_message: None,
    }
}

#[cfg(test)]
fn provision_managed_entry_impl(
    configured_root: &Path,
    target_directory: &Path,
    body_path: &Path,
    initial_content: &str,
) -> ProvisionManagedEntryResult {
    provision_managed_entry_core(
        configured_root,
        target_directory,
        body_path,
        initial_content,
        true,
        false,
    )
}

fn provision_managed_entry_for_owner(
    owner_type: &str,
    manuscript_channel: &str,
    configured_root: &Path,
    target_directory: &Path,
    body_path: &Path,
    initial_content: &str,
    allow_create_body: bool,
) -> ProvisionManagedEntryResult {
    if let Err(code) = validate_manuscript_identity_contract(
        owner_type,
        manuscript_channel,
        body_path,
    ) {
        return ProvisionManagedEntryResult::failure(
            "error",
            target_directory,
            body_path,
            false,
            code,
            "Owner, manuscript channel, and default filename do not match the provisioning contract.",
            false,
        );
    }
    provision_managed_entry_core(
        configured_root,
        target_directory,
        body_path,
        initial_content,
        allow_create_body,
        owner_type == "review" && manuscript_channel == "primary",
    )
}

fn provision_experiment_manuscript_core(
    configured_root: &Path,
    project_workspace: &Path,
    target_workspace: &Path,
    default_file_path: &Path,
    initial_content: &str,
) -> ProvisionManagedEntryResult {
    const DEFAULT_FILE_NAME: &str = "experiment.md";
    if default_file_path.file_name().and_then(|value| value.to_str())
        != Some(DEFAULT_FILE_NAME)
        || default_file_path.parent() != Some(target_workspace)
    {
        return ProvisionManagedEntryResult::failure(
            "error",
            target_workspace,
            default_file_path,
            false,
            "PROVISIONING_PATH_INVALID",
            "Experiment provisioning requires the direct C-1 experiment.md identity.",
            false,
        );
    }
    if let Err(code) = validate_experiment_workspace_foundation_path(
        "experiment",
        configured_root,
        project_workspace,
        None,
        target_workspace,
        DEFAULT_FILE_NAME,
    ) {
        return ProvisionManagedEntryResult::failure(
            "error",
            target_workspace,
            default_file_path,
            false,
            code,
            "Experiment workspace does not match the C-1 descriptor safety contract.",
            false,
        );
    }
    provision_managed_entry_core(
        configured_root,
        target_workspace,
        default_file_path,
        initial_content,
        true,
        true,
    )
}

fn provision_experiment_run_manuscript_core(
    configured_root: &Path,
    project_workspace: &Path,
    parent_experiment_workspace: &Path,
    target_workspace: &Path,
    default_file_path: &Path,
    initial_content: &str,
) -> ProvisionManagedEntryResult {
    const DEFAULT_FILE_NAME: &str = "experiment-run.md";
    if default_file_path.file_name().and_then(|value| value.to_str())
        != Some(DEFAULT_FILE_NAME)
        || default_file_path.parent() != Some(target_workspace)
    {
        return ProvisionManagedEntryResult::failure(
            "error",
            target_workspace,
            default_file_path,
            false,
            "PROVISIONING_PATH_INVALID",
            "ExperimentRun provisioning requires the direct C-1 experiment-run.md identity.",
            false,
        );
    }
    if let Err(code) = validate_experiment_workspace_foundation_path(
        "experimentRun",
        configured_root,
        project_workspace,
        Some(parent_experiment_workspace),
        target_workspace,
        DEFAULT_FILE_NAME,
    ) {
        return ProvisionManagedEntryResult::failure(
            "error",
            target_workspace,
            default_file_path,
            false,
            code,
            "ExperimentRun workspace does not match the parent-bound C-1 safety contract.",
            false,
        );
    }
    if !parent_experiment_workspace.is_dir() {
        return ProvisionManagedEntryResult::failure(
            "error",
            target_workspace,
            default_file_path,
            false,
            "PROVISIONING_DIRECTORY_CONFLICT",
            "ExperimentRun provisioning requires an existing parent Experiment workspace.",
            false,
        );
    }
    provision_managed_entry_core(
        configured_root,
        target_workspace,
        default_file_path,
        initial_content,
        true,
        true,
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn provision_experiment_manuscript(
    configured_root: String,
    project_workspace: String,
    target_workspace: String,
    default_file_path: String,
    initial_content: String,
) -> ProvisionManagedEntryResult {
    provision_experiment_manuscript_core(
        Path::new(configured_root.trim()),
        Path::new(project_workspace.trim()),
        Path::new(target_workspace.trim()),
        Path::new(default_file_path.trim()),
        &initial_content,
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn provision_experiment_run_manuscript(
    configured_root: String,
    project_workspace: String,
    parent_experiment_workspace: String,
    target_workspace: String,
    default_file_path: String,
    initial_content: String,
) -> ProvisionManagedEntryResult {
    provision_experiment_run_manuscript_core(
        Path::new(configured_root.trim()),
        Path::new(project_workspace.trim()),
        Path::new(parent_experiment_workspace.trim()),
        Path::new(target_workspace.trim()),
        Path::new(default_file_path.trim()),
        &initial_content,
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn provision_managed_entry(
    owner_type: String,
    manuscript_channel: String,
    configured_root: String,
    target_directory: String,
    body_path: String,
    initial_content: String,
    allow_create_body: bool,
) -> ProvisionManagedEntryResult {
    provision_managed_entry_for_owner(
        owner_type.trim(),
        manuscript_channel.trim(),
        Path::new(configured_root.trim()),
        Path::new(target_directory.trim()),
        Path::new(body_path.trim()),
        &initial_content,
        allow_create_body,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn windows_path_budget_uses_utf16_code_units() {
        let fixtures = include_str!("../../tests/fixtures/windows_path_budget_utf16.tsv");
        for line in fixtures.lines().filter(|line| !line.starts_with('#') && !line.is_empty()) {
            let (expected, value) = line.split_once('\t').expect("tab-separated fixture");
            let expected = expected.parse::<usize>().expect("numeric UTF-16 fixture cost");
            assert_eq!(
                windows_path_budget_cost(Path::new(value)),
                expected,
                "Windows path budget must match JavaScript string.length for {value:?}"
            );
            assert_eq!(expected, value.encode_utf16().count());
        }

        for units in [239usize, 240, 241] {
            let value = "a".repeat(units);
            assert_eq!(windows_path_budget_cost(Path::new(&value)), units);
        }
    }

    fn test_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("labpod-provisioning-{name}-{}-{nonce}", std::process::id()))
    }

    fn experiment_workspace_test_root() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("lpc1-{}-{nonce}", std::process::id()))
    }

    #[test]
    fn component_containment_rejects_escape_and_prefix_collision() {
        let root = test_root("containment");
        assert!(descendant_relative(&root, &root).is_ok());
        assert!(descendant_relative(&root, &root.join("projects/item")).is_ok());
        assert!(descendant_relative(&root, &root.with_file_name("containment2")).is_err());
        assert!(descendant_relative(&root, &root.join("../outside")).is_err());
        assert!(descendant_relative(&root, Path::new("relative/path")).is_err());
        #[cfg(windows)]
        {
            assert!(descendant_relative(Path::new("C:/LabPodFiles"), Path::new("D:/LabPodFiles/item")).is_err());
            assert!(descendant_relative(Path::new("//server/share/LabPodFiles"), Path::new("//server/other/LabPodFiles/item")).is_err());
            assert!(descendant_relative(Path::new("C:/LabPodFiles"), Path::new("c:/LABPODFILES/item")).is_ok());
        }
    }

    #[cfg(windows)]
    #[test]
    fn result_paths_do_not_leak_windows_verbatim_prefixes() {
        assert_eq!(path_for_result(Path::new(r"\\?\C:\LabPodFiles\item")), r"C:\LabPodFiles\item");
        assert_eq!(
            path_for_result(Path::new(r"\\?\UNC\server\share\LabPodFiles\item")),
            r"\\server\share\LabPodFiles\item"
        );
    }

    #[test]
    fn provisioning_is_idempotent_and_never_overwrites_body() {
        let root = test_root("idempotent");
        fs::create_dir_all(&root).expect("create root");
        let directory = root.join("projects/p/2026-07/13/review/item");
        let body = directory.join(BODY_FILE_NAME);
        let first = provision_managed_entry_impl(&root, &directory, &body, "");
        assert_eq!(first.status, "success");
        assert!(first.created_directory);
        assert!(first.created_body);
        assert!(body.is_file());
        assert!(!directory.join("drafts").exists());
        fs::write(&body, "existing user text\n").expect("write existing body");
        let second = provision_managed_entry_impl(&root, &directory, &body, "");
        assert_eq!(second.status, "skipped");
        assert!(second.reused_directory);
        assert!(second.reused_body);
        assert_eq!(fs::read_to_string(&body).expect("read body"), "existing user text\n");
        fs::remove_dir_all(&root).expect("cleanup test root");
    }

    #[test]
    fn provisioning_accepts_distinct_direct_markdown_manuscripts_without_subfolders() {
        let root = test_root("dual-literature-manuscripts");
        fs::create_dir_all(&root).expect("create root");
        let directory = root.join("projects/p/literature/item");
        let outline = directory.join("literature-outline.md");
        let notes = directory.join("dedicated-notes.md");
        let outline_result = provision_managed_entry_impl(&root, &directory, &outline, "");
        let notes_result = provision_managed_entry_impl(&root, &directory, &notes, "");
        assert_eq!(outline_result.status, "success");
        assert_eq!(notes_result.status, "success");
        assert!(outline.is_file());
        assert!(notes.is_file());
        assert_eq!(outline.parent(), notes.parent());
        assert!(!directory.join("drafts").exists());
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn provisioning_creates_an_empty_utf8_body_only() {
        let root = test_root("empty-utf8");
        fs::create_dir_all(&root).expect("create root");
        let directory = root.join("projects/p/item");
        let body = directory.join(BODY_FILE_NAME);
        let outcome = provision_managed_entry_impl(&root, &directory, &body, "");
        assert_eq!(outcome.status, "success");
        assert_eq!(fs::read(&body).expect("read empty utf8 body"), Vec::<u8>::new());
        let rejected = provision_managed_entry_impl(&root, &directory, &body, "# 研究\n");
        assert_eq!(rejected.error_code.as_deref(), Some("PROVISIONING_BODY_CREATE_FAILED"));
        fs::remove_dir_all(&root).expect("cleanup test root");
    }

    #[test]
    fn provisioning_reports_root_directory_and_body_conflicts() {
        let missing_root = test_root("missing");
        let missing_outcome = provision_managed_entry_impl(
            &missing_root,
            &missing_root.join("item"),
            &missing_root.join("item/body.md"),
            "",
        );
        assert_eq!(missing_outcome.error_code.as_deref(), Some("PROVISIONING_ROOT_INVALID"));

        let file_root = test_root("file-root");
        fs::write(&file_root, "file").expect("create root file");
        let file_root_outcome = provision_managed_entry_impl(
            &file_root,
            &file_root.join("item"),
            &file_root.join("item/body.md"),
            "",
        );
        assert_eq!(file_root_outcome.error_code.as_deref(), Some("PROVISIONING_ROOT_INVALID"));
        fs::remove_file(&file_root).expect("cleanup root file");

        let root = test_root("conflicts");
        fs::create_dir_all(&root).expect("create root");
        let target_file = root.join("target-file");
        fs::write(&target_file, "conflict").expect("create target file");
        let directory_conflict = provision_managed_entry_impl(
            &root,
            &target_file,
            &target_file.join("body.md"),
            "",
        );
        assert_eq!(directory_conflict.error_code.as_deref(), Some("PROVISIONING_DIRECTORY_CONFLICT"));

        let directory = root.join("body-conflict");
        fs::create_dir_all(directory.join("body.md")).expect("create body directory conflict");
        let body_conflict = provision_managed_entry_impl(
            &root,
            &directory,
            &directory.join("body.md"),
            "",
        );
        assert_eq!(body_conflict.error_code.as_deref(), Some("PROVISIONING_BODY_CONFLICT"));

        let blocked_parent = root.join("blocked-parent");
        fs::write(&blocked_parent, "file").expect("create blocked parent");
        let blocked = provision_managed_entry_impl(
            &root,
            &blocked_parent.join("child"),
            &blocked_parent.join("child/body.md"),
            "",
        );
        assert_eq!(blocked.error_code.as_deref(), Some("PROVISIONING_DIRECTORY_CONFLICT"));
        fs::remove_dir_all(&root).expect("cleanup test root");
    }

    #[test]
    fn provisioning_rejects_outside_absolute_and_non_body_targets() {
        let root = test_root("outside");
        let outside = test_root("outside-target");
        fs::create_dir_all(&root).expect("create root");
        let outcome = provision_managed_entry_impl(&root, &outside, &outside.join("body.md"), "");
        assert_eq!(outcome.error_code.as_deref(), Some("PROVISIONING_PATH_OUTSIDE_ROOT"));
        let directory = root.join("item");
        let injected = provision_managed_entry_impl(&root, &directory, &root.join("other/body.md"), "");
        assert_eq!(injected.error_code.as_deref(), Some("PROVISIONING_PATH_INVALID"));
        assert!(!outside.exists());
        fs::remove_dir_all(&root).expect("cleanup test root");
    }

    #[test]
    fn provisioning_rejects_existing_symlink_escape_when_supported() {
        let root = test_root("symlink-root");
        let outside = test_root("symlink-outside");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir_all(&outside).expect("create outside");
        let link = root.join("linked");
        #[cfg(unix)]
        let link_result = std::os::unix::fs::symlink(&outside, &link);
        #[cfg(windows)]
        let link_result = std::os::windows::fs::symlink_dir(&outside, &link);
        if link_result.is_ok() {
            let directory = link.join("item");
            let outcome = provision_managed_entry_impl(&root, &directory, &directory.join("body.md"), "");
            assert_eq!(outcome.error_code.as_deref(), Some("PROVISIONING_PATH_OUTSIDE_ROOT"));
            assert!(!outside.join("item").exists());
        }
        fs::remove_dir_all(&root).expect("cleanup root");
        fs::remove_dir_all(&outside).expect("cleanup outside");
    }

    #[test]
    fn review_provisioning_requires_primary_review_md_and_preserves_non_empty_content() {
        let root = test_root("review-contract");
        fs::create_dir_all(&root).expect("create root");
        let directory = root.join("projects/p/2026-07/14/review/item");
        let review = directory.join("review.md");
        let initial_template = "# Review\n\n## Summary\n";
        let created = provision_managed_entry_for_owner(
            "review",
            "primary",
            &root,
            &directory,
            &review,
            initial_template,
            true,
        );
        assert_eq!(created.status, "success");
        assert!(created.created_body);
        assert_eq!(
            fs::read_to_string(&review).expect("read templated review"),
            initial_template
        );

        fs::write(&review, "existing review text\n").expect("write existing review");
        let reused = provision_managed_entry_for_owner(
            "review",
            "primary",
            &root,
            &directory,
            &review,
            "# Replacement template that must not be written\n",
            false,
        );
        assert_eq!(reused.status, "skipped");
        assert!(reused.reused_body);
        assert_eq!(
            fs::read_to_string(&review).expect("read preserved review"),
            "existing review text\n"
        );

        for (channel, file_name) in [
            ("literature_outline", "review.md"),
            ("dedicated_notes", "review.md"),
            ("primary", "body.md"),
            ("primary", "review-notes.md"),
        ] {
            let rejected = provision_managed_entry_for_owner(
                "review",
                channel,
                &root,
                &directory,
                &directory.join(file_name),
                "",
                true,
            );
            assert_eq!(rejected.status, "error");
        }
        fs::remove_dir_all(&root).expect("cleanup review root");
    }

    #[test]
    fn provisioned_identity_missing_file_requires_explicit_repair() {
        let root = test_root("review-missing-repair");
        fs::create_dir_all(&root).expect("create root");
        let directory = root.join("projects/p/2026-07/14/review/item");
        let review = directory.join("review.md");
        let missing = provision_managed_entry_for_owner(
            "review",
            "primary",
            &root,
            &directory,
            &review,
            "",
            false,
        );
        assert_eq!(
            missing.error_code.as_deref(),
            Some("PROVISIONING_BODY_MISSING_REPAIR_REQUIRED")
        );
        assert!(!directory.exists());
        assert!(!review.exists());
        fs::remove_dir_all(&root).expect("cleanup missing repair root");
    }

    #[test]
    fn experiment_workspace_owner_allowlist_and_default_filenames_are_exact() {
        assert_eq!(
            experiment_workspace_default_file_name("experiment"),
            Ok("experiment.md")
        );
        assert_eq!(
            experiment_workspace_default_file_name("experimentRun"),
            Ok("experiment-run.md")
        );
        for owner in ["run", "experiment_run", "review", "unknown"] {
            assert_eq!(
                experiment_workspace_default_file_name(owner),
                Err("PROVISIONING_OWNER_NOT_FOUND")
            );
        }
        assert!(validate_manuscript_identity_contract(
            "experimentRun",
            "primary",
            Path::new("C:/root/experiment-run.md")
        )
        .is_ok());
        assert!(validate_manuscript_identity_contract(
            "experimentRun",
            "primary",
            Path::new("C:/root/body.md")
        )
        .is_err());
    }

    #[test]
    fn experiment_workspace_foundation_validates_nonexistent_nested_leaf_without_creating_it() {
        let root = experiment_workspace_test_root();
        fs::create_dir_all(&root).expect("create isolated root");
        let project = root.join("projects/project-a_0123456789ab");
        let experiment = project.join(
            "2026-07/17/experiment/2026-07-17_0905_exp_0123456789ab_experiment",
        );
        let run = experiment.join(
            "runs/2027-01/02/2027-01-02_2359_run_abcdef012345_run",
        );

        validate_experiment_workspace_foundation_path(
            "experiment",
            &root,
            &project,
            None,
            &experiment,
            "experiment.md",
        )
        .expect("validate Experiment descriptor path");
        validate_experiment_workspace_foundation_path(
            "experimentRun",
            &root,
            &project,
            Some(&experiment),
            &run,
            "experiment-run.md",
        )
        .expect("validate nested Run descriptor path");

        assert!(!project.exists());
        assert!(!experiment.exists());
        assert!(!run.exists());
        fs::remove_dir_all(&root).expect("cleanup isolated root");
    }

    #[test]
    fn experiment_manuscript_provisioning_is_descriptor_bound_idempotent_and_non_overwriting() {
        let root = experiment_workspace_test_root();
        fs::create_dir_all(&root).expect("create isolated root");
        let project = root.join("projects/project-a_0123456789ab");
        let experiment = project.join(
            "2026-07/17/experiment/2026-07-17_0905_exp_0123456789ab_experiment",
        );
        let manuscript = experiment.join("experiment.md");

        let fresh = provision_experiment_manuscript_core(
            &root,
            &project,
            &experiment,
            &manuscript,
            "canonical manuscript bytes",
        );
        assert_eq!(fresh.status, "success");
        assert!(fresh.created_directory);
        assert!(fresh.created_body);
        assert_eq!(
            fs::read(&manuscript).expect("read initial manuscript"),
            b"canonical manuscript bytes"
        );
        fs::write(&manuscript, "user-authored bytes\r\nkeep exactly")
            .expect("write test manuscript bytes");

        let repeat = provision_experiment_manuscript_core(
            &root,
            &project,
            &experiment,
            &manuscript,
            "must not overwrite",
        );
        assert_eq!(repeat.status, "skipped");
        assert!(repeat.reused_directory);
        assert!(repeat.reused_body);
        assert_eq!(
            fs::read(&manuscript).expect("read preserved manuscript"),
            b"user-authored bytes\r\nkeep exactly"
        );

        let wrong_filename = provision_experiment_manuscript_core(
            &root,
            &project,
            &experiment,
            &experiment.join("body.md"),
            "",
        );
        assert_eq!(wrong_filename.status, "error");
        assert_eq!(wrong_filename.error_code.as_deref(), Some("PROVISIONING_PATH_INVALID"));

        fs::remove_dir_all(&root).expect("cleanup isolated root");
    }

    #[test]
    fn experiment_run_manuscript_provisioning_is_parent_bound_idempotent_and_non_overwriting() {
        const NATURAL_RUN_MARKDOWN: &str = "# 运行记录：冻结运行\n\n## 结构化纲要\n\n### 条件摘要\n\n室温\n\n### 变量与参数摘要\n\n### 方法摘要\n\n### 结果摘要\n\n### 结论与下一步\n\n### 其他\n\n## 运行正文\n\n请在此记录本次运行过程、观察、结果与分析。\n";
        let root = experiment_workspace_test_root();
        fs::create_dir_all(&root).expect("create isolated root");
        let project = root.join("projects/project-a_0123456789ab");
        let experiment = project.join(
            "2026-07/17/experiment/2026-07-17_0905_exp_0123456789ab_experiment",
        );
        let run = experiment.join(
            "runs/2026-07/18/2026-07-18_1015_run_abcdef012345_frozen-run",
        );
        let manuscript = run.join("experiment-run.md");

        let missing_parent = provision_experiment_run_manuscript_core(
            &root,
            &project,
            &experiment,
            &run,
            &manuscript,
            NATURAL_RUN_MARKDOWN,
        );
        assert_eq!(missing_parent.status, "error");
        assert_eq!(missing_parent.error_code.as_deref(), Some("PROVISIONING_DIRECTORY_CONFLICT"));
        assert!(!experiment.exists());
        assert!(!run.exists());

        fs::create_dir_all(&experiment).expect("create provisioned parent Experiment workspace");

        let fresh = provision_experiment_run_manuscript_core(
            &root,
            &project,
            &experiment,
            &run,
            &manuscript,
            NATURAL_RUN_MARKDOWN,
        );
        assert_eq!(fresh.status, "success");
        assert!(fresh.created_directory);
        assert!(fresh.created_body);
        assert_eq!(
            fs::read_to_string(&manuscript).expect("read natural Run manuscript"),
            NATURAL_RUN_MARKDOWN
        );
        assert!(!NATURAL_RUN_MARKDOWN.contains("LABPOD_"));
        let preserved_bytes = b"\xef\xbb\xbfuser-authored bytes\r\nkeep exactly";
        fs::write(&manuscript, preserved_bytes)
            .expect("write test Run manuscript bytes");
        let preserved_modified = fs::metadata(&manuscript)
            .expect("read preserved metadata")
            .modified()
            .expect("read preserved mtime");
        std::thread::sleep(std::time::Duration::from_millis(25));

        let repeat = provision_experiment_run_manuscript_core(
            &root,
            &project,
            &experiment,
            &run,
            &manuscript,
            "replacement content must never be written",
        );
        assert_eq!(repeat.status, "skipped");
        assert!(repeat.reused_directory);
        assert!(repeat.reused_body);
        assert_eq!(
            fs::read(&manuscript).expect("read preserved Run manuscript"),
            preserved_bytes
        );
        assert_eq!(
            fs::metadata(&manuscript)
                .expect("read repeated metadata")
                .modified()
                .expect("read repeated mtime"),
            preserved_modified,
            "repeat provisioning must not modify mtime"
        );

        let wrong_filename = provision_experiment_run_manuscript_core(
            &root,
            &project,
            &experiment,
            &run,
            &run.join("experiment.md"),
            NATURAL_RUN_MARKDOWN,
        );
        assert_eq!(wrong_filename.status, "error");
        assert_eq!(wrong_filename.error_code.as_deref(), Some("PROVISIONING_PATH_INVALID"));

        let sibling_parent = project.join(
            "2026-07/17/experiment/2026-07-17_0905_exp_999999999999_sibling",
        );
        let wrong_parent = provision_experiment_run_manuscript_core(
            &root,
            &project,
            &sibling_parent,
            &run,
            &manuscript,
            NATURAL_RUN_MARKDOWN,
        );
        assert_eq!(wrong_parent.status, "error");
        assert_eq!(wrong_parent.error_code.as_deref(), Some("PROVISIONING_PATH_OUTSIDE_ROOT"));

        fs::remove_dir_all(&root).expect("cleanup isolated root");
    }

    #[test]
    fn experiment_run_fresh_default_is_exactly_zero_bytes_without_bom() {
        let root = experiment_workspace_test_root();
        fs::create_dir_all(&root).expect("create isolated root");
        let project = root.join("projects/project-zero_0123456789ab");
        let experiment =
            project.join("2026-08/11/experiment/2026-08-11_0900_exp_0123456789ab_parent");
        let run = experiment.join("runs/2026-08/11/2026-08-11_0915_run_abcdef012345_zero-byte");
        let manuscript = run.join("experiment-run.md");
        fs::create_dir_all(&experiment).expect("create provisioned parent Experiment workspace");

        let fresh = provision_experiment_run_manuscript_core(
            &root,
            &project,
            &experiment,
            &run,
            &manuscript,
            "",
        );
        assert_eq!(fresh.status, "success");
        assert!(fresh.created_directory);
        assert!(fresh.created_body);
        let bytes = fs::read(&manuscript).expect("read fresh Run manuscript bytes");
        assert_eq!(
            bytes.len(),
            0,
            "fresh Run default must contain exactly zero bytes"
        );
        assert!(
            !bytes.starts_with(&[0xef, 0xbb, 0xbf]),
            "fresh Run default must not contain a UTF-8 BOM"
        );

        let repeat = provision_experiment_run_manuscript_core(
            &root,
            &project,
            &experiment,
            &run,
            &manuscript,
            "",
        );
        assert_eq!(repeat.status, "skipped");
        assert!(repeat.reused_directory);
        assert!(repeat.reused_body);
        assert_eq!(
            fs::read(&manuscript).expect("read repeated Run manuscript"),
            bytes
        );

        fs::remove_dir_all(&root).expect("cleanup isolated root");
    }

    #[test]
    fn experiment_run_unicode_path_budget_accepts_240_and_rejects_241_utf16_units() {
        const NATURAL_RUN_MARKDOWN: &str = "# 运行记录：88888\n\n## 结构化摘要\n\n## 运行正文\n";
        let root = experiment_workspace_test_root();
        fs::create_dir_all(&root).expect("create isolated root");
        let project = root.join("projects/中文路径验收课题_28624d3728e0");
        let experiment = project.join(
            "2026-07/18/experiment/2026-07-18_1933_exp_c0007c936ca1_中文自动建档实验",
        );
        let run_parent = experiment.join("runs/2026-07/20");
        fs::create_dir_all(&experiment).expect("create Chinese parent Experiment workspace");

        let actual_run = run_parent.join("2026-07-20_0938_run_1a8b110464f3_88888");
        let actual_manuscript = actual_run.join("experiment-run.md");
        assert_eq!(
            windows_path_budget_cost(&actual_manuscript),
            actual_manuscript.to_string_lossy().encode_utf16().count()
        );
        assert!(windows_path_budget_cost(&actual_manuscript) <= 240);
        let actual = provision_experiment_run_manuscript_core(
            &root,
            &project,
            &experiment,
            &actual_run,
            &actual_manuscript,
            NATURAL_RUN_MARKDOWN,
        );
        assert_eq!(actual.status, "success");
        assert_eq!(
            fs::read_to_string(&actual_manuscript).expect("read Chinese Run manuscript"),
            NATURAL_RUN_MARKDOWN
        );

        for (minute, expected_units) in [("0939", 239usize), ("0940", 240usize)] {
            let folder_prefix = format!("2026-07-20_{minute}_run_1a8b110464f3_");
            let prefix_cost = windows_path_budget_cost(
                &run_parent.join(&folder_prefix).join("experiment-run.md"),
            );
            let title_units = expected_units
                .checked_sub(prefix_cost)
                .expect("temporary root leaves room for the boundary title");
            assert!(title_units > 0);
            let run = run_parent.join(format!("{folder_prefix}{}", "x".repeat(title_units)));
            let manuscript = run.join("experiment-run.md");
            assert_eq!(windows_path_budget_cost(&manuscript), expected_units);
            let accepted = provision_experiment_run_manuscript_core(
                &root,
                &project,
                &experiment,
                &run,
                &manuscript,
                NATURAL_RUN_MARKDOWN,
            );
            assert_eq!(accepted.status, "success", "{expected_units} units must be accepted");
            assert!(manuscript.is_file());
        }

        let folder_prefix = "2026-07-20_0941_run_1a8b110464f3_";
        let prefix_cost = windows_path_budget_cost(
            &run_parent.join(folder_prefix).join("experiment-run.md"),
        );
        let title_units = 241usize
            .checked_sub(prefix_cost)
            .expect("temporary root leaves room for the over-budget title");
        assert!(title_units > 0);
        let rejected_run =
            run_parent.join(format!("{folder_prefix}{}", "x".repeat(title_units)));
        let rejected_manuscript = rejected_run.join("experiment-run.md");
        assert_eq!(windows_path_budget_cost(&rejected_manuscript), 241);
        let rejected = provision_experiment_run_manuscript_core(
            &root,
            &project,
            &experiment,
            &rejected_run,
            &rejected_manuscript,
            NATURAL_RUN_MARKDOWN,
        );
        assert_eq!(rejected.status, "error");
        assert_eq!(rejected.error_code.as_deref(), Some("PROVISIONING_PATH_INVALID"));
        assert!(!rejected_run.exists());

        fs::remove_dir_all(&root).expect("cleanup isolated root");
    }

    #[test]
    fn concurrent_experiment_run_manuscript_provisioning_converges_to_one_file() {
        use std::sync::{Arc, Barrier};

        let root = experiment_workspace_test_root();
        fs::create_dir_all(&root).expect("create isolated root");
        let project = root.join("projects/project-a_0123456789ab");
        let experiment = project.join(
            "2026-07/17/experiment/2026-07-17_0905_exp_0123456789ab_experiment",
        );
        let run = experiment.join(
            "runs/2026-07/18/2026-07-18_1015_run_abcdef012345_frozen-run",
        );
        let manuscript = run.join("experiment-run.md");
        fs::create_dir_all(&experiment).expect("create provisioned parent Experiment workspace");
        let barrier = Arc::new(Barrier::new(6));
        let handles: Vec<_> = (0..6)
            .map(|_| {
                let root = root.clone();
                let project = project.clone();
                let experiment = experiment.clone();
                let run = run.clone();
                let manuscript = manuscript.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    provision_experiment_run_manuscript_core(
                        &root,
                        &project,
                        &experiment,
                        &run,
                        &manuscript,
                        "# 运行记录：并发\n",
                    )
                })
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().expect("join Run provisioning thread"))
            .collect();
        assert!(results.iter().all(|result| matches!(result.status.as_str(), "success" | "skipped")));
        assert_eq!(results.iter().filter(|result| result.created_directory).count(), 1);
        assert_eq!(results.iter().filter(|result| result.reused_directory).count(), 5);
        assert_eq!(results.iter().filter(|result| result.created_body).count(), 1);
        assert_eq!(results.iter().filter(|result| result.reused_body).count(), 5);
        assert!(manuscript.is_file());

        fs::remove_dir_all(&root).expect("cleanup isolated root");
    }

    #[test]
    fn existing_non_utf8_run_manuscript_is_diagnosed_without_overwrite() {
        let root = experiment_workspace_test_root();
        fs::create_dir_all(&root).expect("create isolated root");
        let project = root.join("projects/project-a_0123456789ab");
        let experiment = project.join(
            "2026-07/17/experiment/2026-07-17_0905_exp_0123456789ab_experiment",
        );
        let run = experiment.join(
            "runs/2026-07/18/2026-07-18_1015_run_abcdef012345_frozen-run",
        );
        let manuscript = run.join("experiment-run.md");
        fs::create_dir_all(&run).expect("create existing Run workspace");
        let bytes = [0xff, 0xfe, 0x00, 0x61];
        fs::write(&manuscript, bytes).expect("write unsupported existing bytes");
        let before = fs::metadata(&manuscript)
            .expect("read before metadata")
            .modified()
            .expect("read before mtime");

        let result = provision_experiment_run_manuscript_core(
            &root,
            &project,
            &experiment,
            &run,
            &manuscript,
            "# 运行记录：不得覆盖\n",
        );
        assert_eq!(result.status, "error");
        assert_eq!(
            result.error_code.as_deref(),
            Some("PROVISIONING_BODY_ENCODING_UNSUPPORTED")
        );
        assert_eq!(fs::read(&manuscript).expect("read unchanged bytes"), bytes);
        assert_eq!(
            fs::metadata(&manuscript)
                .expect("read after metadata")
                .modified()
                .expect("read after mtime"),
            before
        );

        fs::remove_dir_all(&root).expect("cleanup isolated root");
    }

    #[test]
    fn existing_run_manuscript_variants_are_never_rewritten() {
        let root = experiment_workspace_test_root();
        fs::create_dir_all(&root).expect("create isolated root");
        let project = root.join("projects/project-a_0123456789ab");
        let experiment = project.join(
            "2026-07/17/experiment/2026-07-17_0905_exp_0123456789ab_experiment",
        );
        fs::create_dir_all(&experiment).expect("create parent Experiment workspace");
        let variants: [(&str, &str, &[u8]); 4] = [
            ("1015", "abcdef012345", b""),
            ("1016", "abcdef012346", b"# ordinary Markdown\nuser text\n"),
            (
                "1017",
                "abcdef012347",
                b"<!-- LABPOD_META_START -->\nlegacy marker body\n<!-- LABPOD_BODY_END -->\n",
            ),
            ("1018", "abcdef012348", b"\xef\xbb\xbf# BOM\r\nCRLF\r\n"),
        ];

        for (time, stable_code, bytes) in variants {
            let run = experiment.join(format!(
                "runs/2026-07/18/2026-07-18_{time}_run_{stable_code}_existing"
            ));
            let manuscript = run.join("experiment-run.md");
            fs::create_dir_all(&run).expect("create existing Run workspace");
            fs::write(&manuscript, bytes).expect("write existing manuscript variant");
            let before_modified = fs::metadata(&manuscript)
                .expect("read before metadata")
                .modified()
                .expect("read before mtime");
            std::thread::sleep(std::time::Duration::from_millis(20));

            let result = provision_experiment_run_manuscript_core(
                &root,
                &project,
                &experiment,
                &run,
                &manuscript,
                "# replacement must not be written\n",
            );
            assert_eq!(result.status, "skipped");
            assert!(result.reused_directory);
            assert!(result.reused_body);
            assert_eq!(fs::read(&manuscript).expect("read unchanged variant"), bytes);
            assert_eq!(
                fs::metadata(&manuscript)
                    .expect("read after metadata")
                    .modified()
                    .expect("read after mtime"),
                before_modified
            );
        }

        fs::remove_dir_all(&root).expect("cleanup isolated root");
    }

    #[test]
    fn concurrent_experiment_manuscript_provisioning_converges_to_one_file() {
        use std::sync::{Arc, Barrier};

        let root = experiment_workspace_test_root();
        fs::create_dir_all(&root).expect("create isolated root");
        let project = root.join("projects/project-a_0123456789ab");
        let experiment = project.join(
            "2026-07/17/experiment/2026-07-17_0905_exp_0123456789ab_experiment",
        );
        let manuscript = experiment.join("experiment.md");
        let barrier = Arc::new(Barrier::new(6));
        let handles: Vec<_> = (0..6)
            .map(|_| {
                let root = root.clone();
                let project = project.clone();
                let experiment = experiment.clone();
                let manuscript = manuscript.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    provision_experiment_manuscript_core(
                        &root,
                        &project,
                        &experiment,
                        &manuscript,
                        "canonical concurrent manuscript",
                    )
                })
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().expect("join provisioning thread"))
            .collect();
        assert!(results.iter().all(|result| matches!(result.status.as_str(), "success" | "skipped")));
        assert_eq!(results.iter().filter(|result| result.created_directory).count(), 1);
        assert_eq!(results.iter().filter(|result| result.reused_directory).count(), 5);
        assert_eq!(results.iter().filter(|result| result.created_body).count(), 1);
        assert_eq!(results.iter().filter(|result| result.reused_body).count(), 5);
        assert!(manuscript.is_file());

        fs::remove_dir_all(&root).expect("cleanup isolated root");
    }

    #[test]
    fn experiment_workspace_foundation_rejects_wrong_parent_prefix_collision_and_symlink_escape() {
        let root = test_root("experiment-path-containment");
        let outside = test_root("experiment-path-outside");
        fs::create_dir_all(&root).expect("create isolated root");
        fs::create_dir_all(&outside).expect("create outside root");
        let project = root.join("projects/project-a_0123456789ab");
        let sibling = root.join("projects/project-b_abcdef012345");
        let experiment = project.join(
            "2026-07/17/experiment/2026-07-17_0905_exp_0123456789ab_experiment",
        );
        let run = experiment.join(
            "runs/2026-07/18/2026-07-18_0905_run_abcdef012345_run",
        );

        assert!(validate_experiment_workspace_foundation_path(
            "experimentRun",
            &root,
            &project,
            Some(&sibling),
            &run,
            "experiment-run.md",
        )
        .is_err());
        assert!(validate_experiment_workspace_foundation_path(
            "experiment",
            &root,
            &root.join("..-collision/projects/project-a_0123456789ab"),
            None,
            &experiment,
            "experiment.md",
        )
        .is_err());

        fs::create_dir_all(root.join("projects")).expect("create projects parent");
        let link = root.join("projects/project-a_0123456789ab");
        #[cfg(unix)]
        let link_result = std::os::unix::fs::symlink(&outside, &link);
        #[cfg(windows)]
        let link_result = std::os::windows::fs::symlink_dir(&outside, &link);
        if link_result.is_ok() {
            assert!(validate_experiment_workspace_foundation_path(
                "experiment",
                &root,
                &link,
                None,
                &experiment,
                "experiment.md",
            )
            .is_err());
        }
        fs::remove_dir_all(&root).expect("cleanup root");
        fs::remove_dir_all(&outside).expect("cleanup outside");
    }
}
