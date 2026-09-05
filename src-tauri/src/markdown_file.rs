use crate::provisioning::{descendant_relative, path_for_result, validate_existing_managed_path};
#[cfg(test)]
use crate::provisioning::create_managed_descendant_directory;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind, Read, Write};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt as UnixMetadataExt;
#[cfg(windows)]
use std::os::windows::fs::MetadataExt as WindowsMetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri_plugin_dialog::DialogExt;

pub(crate) const MAX_MARKDOWN_FILE_BYTES: u64 = 1_048_576;
const MAX_MARKDOWN_SAVE_BYTES: usize = MAX_MARKDOWN_FILE_BYTES as usize;

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadMarkdownFileResult {
    content: String,
    file_name: String,
    path: String,
    size_bytes: u64,
    encoding: &'static str,
}

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMarkdownFileResult {
    file_name: String,
    size_bytes: u64,
    overwritten: bool,
}

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AtomicMarkdownWriteResult {
    path: String,
    bytes_written: u64,
    encoding: &'static str,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplicitManuscriptFileResult {
    status: String,
    content: Option<String>,
    file_name: Option<String>,
    path_identity: Option<String>,
    physical_identity: Option<String>,
    revision: Option<String>,
    byte_length: Option<u64>,
    line_ending: Option<String>,
    encoding: Option<&'static str>,
    write_applied: Option<bool>,
    recovery_required: Option<bool>,
    error_code: Option<String>,
    error_message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AtomicByteRangeCasStatus {
    Applied,
    AlreadyPost,
    RevisionConflict,
    PreconditionConflict,
    VerificationUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AtomicByteRangeCasResult {
    pub(crate) status: AtomicByteRangeCasStatus,
    pub(crate) revision: Option<String>,
    pub(crate) whole_file_sha256: [u8; 32],
    pub(crate) write_applied: bool,
}

pub(crate) struct AtomicByteRangeCasInput<'a> {
    pub(crate) file_path: &'a str,
    pub(crate) expected_path_identity: &'a str,
    pub(crate) expected_file_name: &'a str,
    pub(crate) expected_revision: &'a str,
    pub(crate) expected_whole_file_sha256: &'a [u8; 32],
    pub(crate) byte_start: u64,
    pub(crate) byte_end: u64,
    pub(crate) expected_region_sha256: &'a [u8; 32],
    pub(crate) replacement_bytes: &'a [u8],
    pub(crate) expected_post_sha256: &'a [u8; 32],
    pub(crate) location_mode: &'a str,
    pub(crate) configured_root: Option<&'a str>,
}

fn sha256_bytes(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn explicit_error(
    code: &str,
    message: &str,
    write_applied: Option<bool>,
    recovery_required: Option<bool>,
) -> ExplicitManuscriptFileResult {
    ExplicitManuscriptFileResult {
        status: "error".to_string(),
        content: None,
        file_name: None,
        path_identity: None,
        physical_identity: None,
        revision: None,
        byte_length: None,
        line_ending: None,
        encoding: None,
        write_applied,
        recovery_required,
        error_code: Some(code.to_string()),
        error_message: Some(message.to_string()),
    }
}

fn map_explicit_path_error(code: &str) -> &str {
    match code {
        "MANUSCRIPT_PATH_IS_DIRECTORY" => "MANUSCRIPT_TARGET_IS_DIRECTORY",
        "MANUSCRIPT_SYMLINK_NOT_ALLOWED" => "MANUSCRIPT_SYMLINK_ESCAPE",
        "MANUSCRIPT_PATH_INVALID" | "MANUSCRIPT_EXTENSION_UNSUPPORTED" => {
            "MANUSCRIPT_FILE_PATH_MISMATCH"
        }
        other => other,
    }
}

fn normalize_explicit_path_identity(value: &str) -> String {
    let mut normalized = value.trim().replace('\\', "/");
    while normalized.contains("//") && !normalized.starts_with("//") {
        normalized = normalized.replace("//", "/");
    }
    if normalized.len() > 1 && !normalized.ends_with(":/") {
        normalized = normalized.trim_end_matches('/').to_string();
    }
    if cfg!(windows) || normalized.starts_with("//") {
        normalized = normalized.to_lowercase();
    }
    normalized
}

fn explicit_path_identity(path: &Path) -> String {
    normalize_explicit_path_identity(&path_for_result(path))
}

fn manuscript_revision(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}")
}

#[cfg(windows)]
fn explicit_physical_identity(
    file: &File,
    _metadata: &fs::Metadata,
) -> Result<String, &'static str> {
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[repr(C)]
    struct ByHandleFileInformation {
        file_attributes: u32,
        creation_time: FileTime,
        last_access_time: FileTime,
        last_write_time: FileTime,
        volume_serial_number: u32,
        file_size_high: u32,
        file_size_low: u32,
        number_of_links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }

    #[link(name = "Kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(
            file: *mut core::ffi::c_void,
            information: *mut ByHandleFileInformation,
        ) -> i32;
    }

    let mut information = std::mem::MaybeUninit::<ByHandleFileInformation>::uninit();
    let succeeded = unsafe {
        GetFileInformationByHandle(
            file.as_raw_handle().cast(),
            information.as_mut_ptr(),
        )
    };
    if succeeded == 0 {
        return Err("MANUSCRIPT_PHYSICAL_IDENTITY_AMBIGUOUS");
    }
    let information = unsafe { information.assume_init() };
    if information.number_of_links != 1 {
        return Err("MANUSCRIPT_PHYSICAL_IDENTITY_AMBIGUOUS");
    }
    let file_index =
        (u64::from(information.file_index_high) << 32) | u64::from(information.file_index_low);
    Ok(format!(
        "win:{:08x}:{file_index:016x}",
        information.volume_serial_number
    ))
}

#[cfg(unix)]
fn explicit_physical_identity(
    _file: &File,
    metadata: &fs::Metadata,
) -> Result<String, &'static str> {
    if metadata.nlink() != 1 {
        return Err("MANUSCRIPT_PHYSICAL_IDENTITY_AMBIGUOUS");
    }
    Ok(format!("unix:{:016x}:{:016x}", metadata.dev(), metadata.ino()))
}

#[cfg(not(any(unix, windows)))]
fn explicit_physical_identity(
    _file: &File,
    metadata: &fs::Metadata,
) -> Result<String, &'static str> {
    let modified = metadata
        .modified()
        .map_err(|_| "MANUSCRIPT_PHYSICAL_IDENTITY_AMBIGUOUS")?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "MANUSCRIPT_PHYSICAL_IDENTITY_AMBIGUOUS")?
        .as_nanos();
    Ok(format!("portable:{}:{modified}", metadata.len()))
}

#[cfg(windows)]
fn explicit_last_write_tick(metadata: &fs::Metadata) -> String {
    format!("{:016x}", metadata.last_write_time())
}

#[cfg(unix)]
fn explicit_last_write_tick(metadata: &fs::Metadata) -> String {
    format!("{:016x}:{:08x}", metadata.mtime(), metadata.mtime_nsec())
}

#[cfg(not(any(unix, windows)))]
fn explicit_last_write_tick(metadata: &fs::Metadata) -> String {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| format!("{:032x}", value.as_nanos()))
        .unwrap_or_else(|| "unknown".to_string())
}

pub(crate) fn manuscript_physical_revision(
    path_identity: &str,
    physical_identity: &str,
    metadata: &fs::Metadata,
    bytes: &[u8],
) -> Result<String, &'static str> {
    Ok(format!(
        "manuscript-physical-v2:{}:{physical_identity}:{:016x}:{}:{}",
        manuscript_revision(path_identity.as_bytes()),
        bytes.len(),
        explicit_last_write_tick(metadata),
        manuscript_revision(bytes)
    ))
}

fn manuscript_line_ending(content: &str) -> &'static str {
    let bytes = content.as_bytes();
    let mut crlf = 0usize;
    let mut lf = 0usize;
    for index in 0..bytes.len() {
        if bytes[index] == b'\n' {
            if index > 0 && bytes[index - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
    }
    match (crlf > 0, lf > 0) {
        (true, true) => "mixed",
        (true, false) => "crlf",
        (false, true) => "lf",
        (false, false) => "none",
    }
}

#[cfg(windows)]
fn explicit_metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn explicit_metadata_is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn ensure_explicit_target_has_no_alias_components(path: &Path) -> Result<(), &'static str> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata)
                if metadata.file_type().is_symlink()
                    || explicit_metadata_is_reparse_point(&metadata) =>
            {
                return Err("MANUSCRIPT_PHYSICAL_IDENTITY_AMBIGUOUS")
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) if error.kind() == ErrorKind::PermissionDenied => {
                return Err("MANUSCRIPT_PERMISSION_DENIED")
            }
            Err(_) => return Err("MANUSCRIPT_PHYSICAL_REREAD_FAILED"),
        }
    }
    Ok(())
}

pub(crate) fn read_explicit_physical_facts_with_limit(
    canonical_path: &Path,
    maximum_bytes: u64,
) -> Result<(Vec<u8>, fs::Metadata, String), &'static str> {
    let mut file = OpenOptions::new()
        .read(true)
        .open(canonical_path)
        .map_err(|error| {
            if error.kind() == ErrorKind::PermissionDenied {
                "MANUSCRIPT_PERMISSION_DENIED"
            } else {
                "MANUSCRIPT_PHYSICAL_REREAD_FAILED"
            }
        })?;
    let before = file.metadata().map_err(|error| {
        if error.kind() == ErrorKind::PermissionDenied {
            "MANUSCRIPT_PERMISSION_DENIED"
        } else {
            "MANUSCRIPT_PHYSICAL_REREAD_FAILED"
        }
    })?;
    if before.len() > maximum_bytes {
        return Err("MANUSCRIPT_FILE_TOO_LARGE");
    }
    let before_identity = explicit_physical_identity(&file, &before)?;
    let before_write_tick = explicit_last_write_tick(&before);
    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.read_to_end(&mut bytes).map_err(|error| {
        if error.kind() == ErrorKind::PermissionDenied {
            "MANUSCRIPT_PERMISSION_DENIED"
        } else {
            "MANUSCRIPT_PHYSICAL_REREAD_FAILED"
        }
    })?;
    let after = file.metadata().map_err(|_| "MANUSCRIPT_PHYSICAL_REREAD_FAILED")?;
    let path_file = OpenOptions::new()
        .read(true)
        .open(canonical_path)
        .map_err(|error| {
            if error.kind() == ErrorKind::PermissionDenied {
                "MANUSCRIPT_PERMISSION_DENIED"
            } else {
                "MANUSCRIPT_PHYSICAL_REREAD_FAILED"
            }
        })?;
    let path_metadata = path_file
        .metadata()
        .map_err(|_| "MANUSCRIPT_PHYSICAL_REREAD_FAILED")?;
    if before_identity != explicit_physical_identity(&file, &after)?
        || before_identity != explicit_physical_identity(&path_file, &path_metadata)?
        || before.len() != after.len()
        || after.len() != path_metadata.len()
        || bytes.len() as u64 != after.len()
        || before_write_tick != explicit_last_write_tick(&after)
        || explicit_last_write_tick(&after) != explicit_last_write_tick(&path_metadata)
    {
        return Err("MANUSCRIPT_PHYSICAL_REREAD_FAILED");
    }
    Ok((bytes, after, before_identity))
}

/// Crate-local, read-only snapshot used by the canonical Formal Switch bridge.
/// It deliberately exposes physical facts without exposing a second writer.
pub(crate) struct ExplicitPhysicalSnapshot {
    pub(crate) bytes: Vec<u8>,
    pub(crate) revision: String,
    pub(crate) sha256: [u8; 32],
    pub(crate) encoding: String,
}

pub(crate) fn read_explicit_physical_snapshot(
    file_path: &str,
    expected_path_identity: &str,
    expected_file_name: &str,
    location_mode: &str,
    configured_root: Option<&str>,
) -> Result<ExplicitPhysicalSnapshot, &'static str> {
    if expected_path_identity.trim().is_empty() || expected_file_name.trim().is_empty() {
        return Err("MANUSCRIPT_FILE_PATH_MISMATCH");
    }
    let source = Path::new(file_path.trim());
    ensure_explicit_target_has_no_alias_components(source)?;
    let canonical_path = validate_existing_markdown_path(
        source,
        Some(location_mode),
        configured_root,
    )
    .map_err(map_explicit_path_error)?;
    let path_identity = explicit_path_identity(&canonical_path);
    let file_name = canonical_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if file_name != expected_file_name
        || path_identity != normalize_explicit_path_identity(expected_path_identity)
    {
        return Err("MANUSCRIPT_FILE_PATH_MISMATCH");
    }
    let (bytes, metadata, physical_identity) = read_explicit_physical_facts(&canonical_path)?;
    let content_bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    std::str::from_utf8(content_bytes).map_err(|_| "MANUSCRIPT_ENCODING_INVALID")?;
    let revision = manuscript_physical_revision(
        &path_identity,
        &physical_identity,
        &metadata,
        &bytes,
    )?;
    Ok(ExplicitPhysicalSnapshot {
        sha256: sha256_bytes(&bytes),
        encoding: if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
            "utf-8-bom"
        } else {
            "utf-8"
        }
        .into(),
        bytes,
        revision,
    })
}

fn read_explicit_physical_facts(
    canonical_path: &Path,
) -> Result<(Vec<u8>, fs::Metadata, String), &'static str> {
    read_explicit_physical_facts_with_limit(canonical_path, MAX_MARKDOWN_FILE_BYTES)
}

pub(crate) struct ExplicitAdmissionTargetFacts {
    pub(crate) canonical_path_identity: String,
    pub(crate) physical_identity: String,
}

pub(crate) fn inspect_explicit_admission_target(
    file_path: &str,
    expected_path_identity: &str,
    expected_file_name: &str,
    location_mode: Option<&str>,
    configured_root: Option<&str>,
) -> Result<ExplicitAdmissionTargetFacts, &'static str> {
    if expected_path_identity.trim().is_empty() || expected_file_name.trim().is_empty() {
        return Err("MANUSCRIPT_FILE_PATH_MISMATCH");
    }
    ensure_explicit_target_has_no_alias_components(Path::new(file_path.trim()))?;
    let canonical_path = validate_existing_markdown_path(
        Path::new(file_path.trim()),
        location_mode,
        configured_root,
    )
    .map_err(map_explicit_path_error)?;
    let canonical_path_identity = explicit_path_identity(&canonical_path);
    let file_name = canonical_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if file_name != expected_file_name
        || canonical_path_identity != normalize_explicit_path_identity(expected_path_identity)
    {
        return Err("MANUSCRIPT_FILE_PATH_MISMATCH");
    }
    let file = OpenOptions::new()
        .read(true)
        .open(&canonical_path)
        .map_err(|error| {
            if error.kind() == ErrorKind::PermissionDenied {
                "MANUSCRIPT_PERMISSION_DENIED"
            } else {
                "MANUSCRIPT_PHYSICAL_REREAD_FAILED"
            }
        })?;
    let metadata = file
        .metadata()
        .map_err(|_| "MANUSCRIPT_PHYSICAL_REREAD_FAILED")?;
    let physical_identity = explicit_physical_identity(&file, &metadata)?;
    let path_file = OpenOptions::new()
        .read(true)
        .open(&canonical_path)
        .map_err(|_| "MANUSCRIPT_PHYSICAL_REREAD_FAILED")?;
    let path_metadata = path_file
        .metadata()
        .map_err(|_| "MANUSCRIPT_PHYSICAL_REREAD_FAILED")?;
    if physical_identity != explicit_physical_identity(&path_file, &path_metadata)? {
        return Err("MANUSCRIPT_PHYSICAL_REREAD_FAILED");
    }
    Ok(ExplicitAdmissionTargetFacts {
        canonical_path_identity,
        physical_identity,
    })
}

fn read_explicit_manuscript_file_impl(
    file_path: &str,
    expected_path_identity: &str,
    expected_file_name: &str,
    location_mode: Option<&str>,
    configured_root: Option<&str>,
) -> ExplicitManuscriptFileResult {
    if expected_path_identity.trim().is_empty() || expected_file_name.trim().is_empty() {
        return explicit_error(
            "MANUSCRIPT_FILE_PATH_MISMATCH",
            "Explicit manuscript path identity and filename are required.",
            None,
            None,
        );
    }
    if let Err(code) = ensure_explicit_target_has_no_alias_components(Path::new(file_path.trim())) {
        return explicit_error(
            code,
            "Explicit manuscript physical identity is ambiguous or unavailable.",
            None,
            None,
        );
    }
    let canonical_path = match validate_existing_markdown_path(
        Path::new(file_path.trim()),
        location_mode,
        configured_root,
    ) {
        Ok(path) => path,
        Err(code) => {
            return explicit_error(
                map_explicit_path_error(code),
                "Explicit manuscript path validation failed.",
                None,
                None,
            )
        }
    };
    let file_name = canonical_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let path_identity = explicit_path_identity(&canonical_path);
    if file_name != expected_file_name
        || path_identity != normalize_explicit_path_identity(expected_path_identity)
    {
        return explicit_error(
            "MANUSCRIPT_FILE_PATH_MISMATCH",
            "Explicit manuscript path identity does not match the target.",
            None,
            None,
        );
    }
    let (bytes, metadata, physical_identity) =
        match read_explicit_physical_facts(&canonical_path) {
        Ok(facts) => facts,
        Err(code) => {
            return explicit_error(
                code,
                "Manuscript bytes could not be read.",
                None,
                None,
            )
        }
    };
    if let Err(code) = validate_size(bytes.len() as u64) {
        return explicit_error(code, "Manuscript exceeds the safe size limit.", None, None);
    }
    let revision =
        match manuscript_physical_revision(&path_identity, &physical_identity, &metadata, &bytes) {
        Ok(revision) => revision,
        Err(code) => {
            return explicit_error(
                code,
                "Manuscript physical revision could not be established.",
                None,
                None,
            )
        }
    };
    let byte_length = bytes.len() as u64;
    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(_) => {
            return explicit_error(
                "MANUSCRIPT_ENCODING_INVALID",
                "Manuscript is not valid UTF-8.",
                None,
                None,
            )
        }
    };
    ExplicitManuscriptFileResult {
        status: "success".to_string(),
        file_name: Some(file_name.to_string()),
        path_identity: Some(path_identity),
        physical_identity: Some(physical_identity),
        revision: Some(revision),
        byte_length: Some(byte_length),
        line_ending: Some(manuscript_line_ending(&content).to_string()),
        encoding: Some("utf-8"),
        content: Some(content),
        write_applied: None,
        recovery_required: None,
        error_code: None,
        error_message: None,
    }
}

struct ExplicitSaveLock {
    path: PathBuf,
}

impl Drop for ExplicitSaveLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

struct ExplicitProcessSaveLock {
    key: String,
}

fn explicit_process_save_locks() -> &'static (Mutex<HashSet<String>>, Condvar) {
    static LOCKS: OnceLock<(Mutex<HashSet<String>>, Condvar)> = OnceLock::new();
    LOCKS.get_or_init(|| (Mutex::new(HashSet::new()), Condvar::new()))
}

fn acquire_explicit_process_save_lock(target: &Path) -> Result<ExplicitProcessSaveLock, &'static str> {
    let key = explicit_path_identity(target);
    let (locks, available) = explicit_process_save_locks();
    let mut active = locks.lock().map_err(|_| "MANUSCRIPT_ATOMIC_WRITE_FAILED")?;
    while active.contains(&key) {
        active = available.wait(active).map_err(|_| "MANUSCRIPT_ATOMIC_WRITE_FAILED")?;
    }
    active.insert(key.clone());
    Ok(ExplicitProcessSaveLock { key })
}

impl Drop for ExplicitProcessSaveLock {
    fn drop(&mut self) {
        let (locks, available) = explicit_process_save_locks();
        if let Ok(mut active) = locks.lock() {
            active.remove(&self.key);
            available.notify_all();
        }
    }
}

#[cfg(test)]
fn explicit_process_save_lock_is_active(key: &str) -> bool {
    explicit_process_save_locks().0.lock()
        .map(|active| active.contains(key))
        .unwrap_or(true)
}

fn acquire_explicit_save_lock(target: &Path) -> Result<ExplicitSaveLock, &'static str> {
    let parent = target.parent().ok_or("MANUSCRIPT_ATOMIC_WRITE_FAILED")?;
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("MANUSCRIPT_ATOMIC_WRITE_FAILED")?;
    let lock_path = parent.join(format!(".{file_name}.labpod-manuscript-save.lock"));
    for _ in 0..400 {
        match OpenOptions::new().write(true).create_new(true).open(&lock_path) {
            Ok(mut file) => {
                let marker = format!("{}\n", std::process::id());
                if file
                    .write_all(marker.as_bytes())
                    .and_then(|_| file.flush())
                    .and_then(|_| file.sync_all())
                    .is_err()
                {
                    let _ = fs::remove_file(&lock_path);
                    return Err("MANUSCRIPT_ATOMIC_WRITE_FAILED");
                }
                return Ok(ExplicitSaveLock { path: lock_path });
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => return Err("MANUSCRIPT_ATOMIC_WRITE_FAILED"),
        }
    }
    Err("MANUSCRIPT_ATOMIC_WRITE_FAILED")
}

fn save_explicit_manuscript_file_atomic_with_post_read<F>(
    file_path: &str,
    expected_path_identity: &str,
    expected_file_name: &str,
    expected_revision: &str,
    content: &str,
    location_mode: Option<&str>,
    configured_root: Option<&str>,
    post_read: F,
) -> ExplicitManuscriptFileResult
where
    F: FnOnce() -> ExplicitManuscriptFileResult,
{
    if expected_revision.trim().is_empty() {
        return explicit_error(
            "MANUSCRIPT_REVISION_CONFLICT",
            "Expected manuscript revision is required.",
            Some(false),
            Some(false),
        );
    }
    if let Err(code) = validate_save_size(content.len()) {
        return explicit_error(code, "Manuscript exceeds the safe size limit.", Some(false), Some(false));
    }
    let target = Path::new(file_path.trim());
    let canonical_path = match validate_existing_markdown_path(target, location_mode, configured_root) {
        Ok(path) => path,
        Err(code) => {
            return explicit_error(
                map_explicit_path_error(code),
                "Manuscript target changed before save coordination.",
                Some(false),
                Some(false),
            )
        }
    };
    let canonical_file_name = canonical_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if canonical_file_name != expected_file_name
        || explicit_path_identity(&canonical_path) != normalize_explicit_path_identity(expected_path_identity)
    {
        return explicit_error(
            "MANUSCRIPT_FILE_PATH_MISMATCH",
            "Explicit manuscript path identity does not match the target.",
            Some(false),
            Some(false),
        );
    }
    let _process_lock = match acquire_explicit_process_save_lock(&canonical_path) {
        Ok(lock) => lock,
        Err(code) => {
            return explicit_error(
                code,
                "In-process manuscript save coordination failed.",
                Some(false),
                Some(false),
            )
        }
    };
    let _lock = match acquire_explicit_save_lock(&canonical_path) {
        Ok(lock) => lock,
        Err(code) => {
            return explicit_error(
                code,
                "Exclusive manuscript save coordination failed.",
                Some(false),
                Some(false),
            )
        }
    };
    let current = read_explicit_manuscript_file_impl(
        file_path,
        expected_path_identity,
        expected_file_name,
        location_mode,
        configured_root,
    );
    if current.status != "success" {
        return ExplicitManuscriptFileResult {
            write_applied: Some(false),
            recovery_required: Some(false),
            ..current
        };
    }
    if current.revision.as_deref() != Some(expected_revision) {
        return explicit_error(
            "MANUSCRIPT_REVISION_CONFLICT",
            "Manuscript revision changed after it was read.",
            Some(false),
            Some(false),
        );
    }
    if current.content.as_deref() == Some(content) {
        return ExplicitManuscriptFileResult {
            write_applied: Some(false),
            recovery_required: Some(false),
            ..current
        };
    }
    let canonical_path = match validate_existing_markdown_path(target, location_mode, configured_root) {
        Ok(path) => path,
        Err(code) => {
            return explicit_error(
                map_explicit_path_error(code),
                "Manuscript target changed before atomic replacement.",
                Some(false),
                Some(false),
            )
        }
    };
    if let Err(code) = atomic_write_markdown(&canonical_path, content.as_bytes(), false) {
        let explicit_code = match code {
            "MANUSCRIPT_WRITE_FAILED" => "MANUSCRIPT_TEMPORARY_WRITE_FAILED",
            "MANUSCRIPT_ATOMIC_REPLACE_FAILED" => "MANUSCRIPT_ATOMIC_REPLACE_FAILED",
            "MANUSCRIPT_PERMISSION_DENIED" => "MANUSCRIPT_PERMISSION_DENIED",
            _ => "MANUSCRIPT_ATOMIC_WRITE_FAILED",
        };
        return explicit_error(
            explicit_code,
            "Atomic manuscript replacement failed.",
            Some(false),
            Some(false),
        );
    }
    let reread = post_read();
    if reread.status != "success" {
        return explicit_error(
            "MANUSCRIPT_PHYSICAL_REREAD_FAILED",
            "Manuscript was replaced but physical reread failed.",
            Some(true),
            Some(true),
        );
    }
    let expected_bytes = content.as_bytes();
    if reread.content.as_deref() != Some(content)
        || reread.byte_length != Some(expected_bytes.len() as u64)
        || !reread
            .revision
            .as_deref()
            .is_some_and(|revision| {
                revision.ends_with(
                    format!(":{}", manuscript_revision(expected_bytes)).as_str(),
                )
            })
        || reread.path_identity.as_deref()
            != Some(normalize_explicit_path_identity(expected_path_identity).as_str())
    {
        return explicit_error(
            "MANUSCRIPT_PHYSICAL_VERIFY_FAILED",
            "Manuscript was replaced but physical verification failed.",
            Some(true),
            Some(true),
        );
    }
    ExplicitManuscriptFileResult {
        write_applied: Some(true),
        recovery_required: Some(false),
        ..reread
    }
}

/// F2-1 controlled old-current mutation primitive. The expected revision/hash
/// comparison and the atomic replacement occur under the same canonical Raw
/// Manuscript I/O locks. FileRef resolution remains outside this authority.
pub(crate) fn apply_explicit_manuscript_byte_range_atomic(
    input: &AtomicByteRangeCasInput<'_>,
) -> Result<AtomicByteRangeCasResult, &'static str> {
    if input.expected_revision.trim().is_empty() {
        return Err("MANUSCRIPT_REVISION_CONFLICT");
    }
    let target = Path::new(input.file_path.trim());
    let canonical_path = validate_existing_markdown_path(
        target,
        Some(input.location_mode),
        input.configured_root,
    )
    .map_err(map_explicit_path_error)?;
    let canonical_file_name = canonical_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("MANUSCRIPT_FILE_PATH_MISMATCH")?;
    if canonical_file_name != input.expected_file_name
        || explicit_path_identity(&canonical_path)
            != normalize_explicit_path_identity(input.expected_path_identity)
    {
        return Err("MANUSCRIPT_FILE_PATH_MISMATCH");
    }

    let _process_lock = acquire_explicit_process_save_lock(&canonical_path)?;
    let _file_lock = acquire_explicit_save_lock(&canonical_path)?;
    let (current_bytes, current_metadata, physical_identity) =
        read_explicit_physical_facts_with_limit(&canonical_path, MAX_MARKDOWN_FILE_BYTES)?;
    let path_identity = explicit_path_identity(&canonical_path);
    let current_revision = manuscript_physical_revision(
        &path_identity,
        &physical_identity,
        &current_metadata,
        &current_bytes,
    )?;
    let current_hash = sha256_bytes(&current_bytes);
    if &current_hash == input.expected_post_sha256 {
        return Ok(AtomicByteRangeCasResult {
            status: AtomicByteRangeCasStatus::AlreadyPost,
            revision: Some(current_revision),
            whole_file_sha256: current_hash,
            write_applied: false,
        });
    }
    if current_revision != input.expected_revision
        || &current_hash != input.expected_whole_file_sha256
    {
        return Ok(AtomicByteRangeCasResult {
            status: AtomicByteRangeCasStatus::RevisionConflict,
            revision: Some(current_revision),
            whole_file_sha256: current_hash,
            write_applied: false,
        });
    }
    let byte_start = usize::try_from(input.byte_start)
        .map_err(|_| "MANUSCRIPT_BYTE_RANGE_INVALID")?;
    let byte_end = usize::try_from(input.byte_end)
        .map_err(|_| "MANUSCRIPT_BYTE_RANGE_INVALID")?;
    if byte_start > byte_end || byte_end > current_bytes.len() {
        return Ok(AtomicByteRangeCasResult {
            status: AtomicByteRangeCasStatus::PreconditionConflict,
            revision: Some(current_revision),
            whole_file_sha256: current_hash,
            write_applied: false,
        });
    }
    if &sha256_bytes(&current_bytes[byte_start..byte_end])
        != input.expected_region_sha256
    {
        return Ok(AtomicByteRangeCasResult {
            status: AtomicByteRangeCasStatus::PreconditionConflict,
            revision: Some(current_revision),
            whole_file_sha256: current_hash,
            write_applied: false,
        });
    }
    let mut expected_post = Vec::with_capacity(
        current_bytes.len() - (byte_end - byte_start) + input.replacement_bytes.len(),
    );
    expected_post.extend_from_slice(&current_bytes[..byte_start]);
    expected_post.extend_from_slice(input.replacement_bytes);
    expected_post.extend_from_slice(&current_bytes[byte_end..]);
    if &sha256_bytes(&expected_post) != input.expected_post_sha256
        || std::str::from_utf8(&expected_post).is_err()
    {
        return Ok(AtomicByteRangeCasResult {
            status: AtomicByteRangeCasStatus::PreconditionConflict,
            revision: Some(current_revision),
            whole_file_sha256: current_hash,
            write_applied: false,
        });
    }
    let canonical_path = validate_existing_markdown_path(
        target,
        Some(input.location_mode),
        input.configured_root,
    )
    .map_err(map_explicit_path_error)?;
    atomic_write_markdown(&canonical_path, &expected_post, false)?;
    let (post_bytes, post_metadata, post_physical_identity) =
        read_explicit_physical_facts_with_limit(&canonical_path, MAX_MARKDOWN_FILE_BYTES)?;
    let post_hash = sha256_bytes(&post_bytes);
    let post_revision = manuscript_physical_revision(
        &path_identity,
        &post_physical_identity,
        &post_metadata,
        &post_bytes,
    )?;
    Ok(AtomicByteRangeCasResult {
        status: if &post_hash == input.expected_post_sha256 {
            AtomicByteRangeCasStatus::Applied
        } else {
            AtomicByteRangeCasStatus::VerificationUnknown
        },
        revision: Some(post_revision),
        whole_file_sha256: post_hash,
        write_applied: true,
    })
}

fn save_explicit_manuscript_file_atomic_impl(
    file_path: &str,
    expected_path_identity: &str,
    expected_file_name: &str,
    expected_revision: &str,
    content: &str,
    location_mode: Option<&str>,
    configured_root: Option<&str>,
) -> ExplicitManuscriptFileResult {
    save_explicit_manuscript_file_atomic_with_post_read(
        file_path,
        expected_path_identity,
        expected_file_name,
        expected_revision,
        content,
        location_mode,
        configured_root,
        || {
            read_explicit_manuscript_file_impl(
                file_path,
                expected_path_identity,
                expected_file_name,
                location_mode,
                configured_root,
            )
        },
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn read_explicit_manuscript_file(
    file_path: String,
    expected_path_identity: String,
    expected_file_name: String,
    location_mode: String,
    configured_root: Option<String>,
) -> ExplicitManuscriptFileResult {
    read_explicit_manuscript_file_impl(
        &file_path,
        &expected_path_identity,
        &expected_file_name,
        Some(&location_mode),
        configured_root.as_deref(),
    )
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_explicit_manuscript_file_atomic(
    file_path: String,
    expected_path_identity: String,
    expected_file_name: String,
    expected_revision: String,
    content: String,
    location_mode: String,
    configured_root: Option<String>,
) -> ExplicitManuscriptFileResult {
    save_explicit_manuscript_file_atomic_impl(
        &file_path,
        &expected_path_identity,
        &expected_file_name,
        &expected_revision,
        &content,
        Some(&location_mode),
        configured_root.as_deref(),
    )
}

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNewMarkdownResult {
    status: String,
    file_name: String,
    path: String,
    created_directories: bool,
    created_file: bool,
    reused_file: bool,
    bytes_written: u64,
    encoding: &'static str,
    retryable: bool,
    error_code: Option<String>,
    error_message: Option<String>,
}

#[derive(Debug, PartialEq)]
enum CreateNewMarkdownOutcome {
    Created,
    Reused,
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
        .unwrap_or(false)
}

fn validate_size(size_bytes: u64) -> Result<(), &'static str> {
    if size_bytes > MAX_MARKDOWN_FILE_BYTES {
        return Err("MANUSCRIPT_FILE_TOO_LARGE");
    }
    Ok(())
}

fn validate_save_size(size_bytes: usize) -> Result<(), &'static str> {
    if size_bytes > MAX_MARKDOWN_SAVE_BYTES {
        return Err("MANUSCRIPT_FILE_TOO_LARGE");
    }
    Ok(())
}

fn validate_overwrite(
    target_exists: bool,
    target_is_file: bool,
    overwrite_confirmed: bool,
) -> Result<bool, &'static str> {
    if target_exists && !target_is_file {
        return Err("not_file_target");
    }
    if target_exists && !overwrite_confirmed {
        return Err("path_exists_requires_confirm");
    }
    Ok(target_exists)
}

fn ensure_no_symlink_components(path: &Path) -> Result<(), &'static str> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("MANUSCRIPT_SYMLINK_NOT_ALLOWED")
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => return Err("MANUSCRIPT_READ_FAILED"),
        }
    }
    Ok(())
}

fn validate_location_mode(location_mode: Option<&str>) -> Result<&str, &'static str> {
    match location_mode.unwrap_or("external") {
        "managed" => Ok("managed"),
        "external" => Ok("external"),
        _ => Err("MANUSCRIPT_PATH_INVALID"),
    }
}

fn validate_existing_markdown_path(
    path: &Path,
    location_mode: Option<&str>,
    configured_root: Option<&str>,
) -> Result<PathBuf, &'static str> {
    if !path.is_absolute() {
        return Err("MANUSCRIPT_PATH_INVALID");
    }
    if !is_markdown_path(path) {
        return Err("MANUSCRIPT_EXTENSION_UNSUPPORTED");
    }
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            "MANUSCRIPT_FILE_NOT_FOUND"
        } else if error.kind() == ErrorKind::PermissionDenied {
            "MANUSCRIPT_PERMISSION_DENIED"
        } else {
            "MANUSCRIPT_READ_FAILED"
        }
    })?;
    if metadata.file_type().is_symlink() {
        return Err("MANUSCRIPT_SYMLINK_NOT_ALLOWED");
    }
    if metadata.is_dir() {
        return Err("MANUSCRIPT_PATH_IS_DIRECTORY");
    }
    if !metadata.is_file() {
        return Err("MANUSCRIPT_PATH_INVALID");
    }
    validate_size(metadata.len())?;

    match validate_location_mode(location_mode)? {
        "managed" => {
            let root = configured_root
                .filter(|value| !value.trim().is_empty())
                .ok_or("MANUSCRIPT_PATH_OUTSIDE_ROOT")?;
            validate_existing_managed_path(Path::new(root.trim()), path)
        }
        _ => {
            ensure_no_symlink_components(path)?;
            fs::canonicalize(path).map_err(|_| "MANUSCRIPT_READ_FAILED")
        }
    }
}

fn read_markdown_file_impl(
    file_path: &str,
    location_mode: Option<&str>,
    configured_root: Option<&str>,
) -> Result<ReadMarkdownFileResult, String> {
    let trimmed_path = file_path.trim();
    if trimmed_path.is_empty() {
        return Err("MANUSCRIPT_PATH_INVALID".to_string());
    }
    let canonical_path =
        validate_existing_markdown_path(Path::new(trimmed_path), location_mode, configured_root)
            .map_err(str::to_string)?;
    let bytes = fs::read(&canonical_path).map_err(|_| "MANUSCRIPT_READ_FAILED".to_string())?;
    validate_size(bytes.len() as u64).map_err(str::to_string)?;
    let content =
        String::from_utf8(bytes).map_err(|_| "MANUSCRIPT_ENCODING_INVALID".to_string())?;
    let file_name = canonical_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("markdown")
        .to_string();

    Ok(ReadMarkdownFileResult {
        size_bytes: content.len() as u64,
        content,
        file_name,
        path: path_for_result(&canonical_path),
        encoding: "utf-8",
    })
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "status", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MarkdownSavePathSelectionResult {
    Selected { path: String, request_token: String },
    Cancelled { request_token: String },
    Busy { request_token: String },
    PathInvalid { request_token: String },
}

static MARKDOWN_SAVE_DIALOG_ACTIVE: OnceLock<Mutex<Option<String>>> = OnceLock::new();

struct MarkdownSaveDialogRequestGuard {
    request_token: String,
}

impl Drop for MarkdownSaveDialogRequestGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = MARKDOWN_SAVE_DIALOG_ACTIVE
            .get_or_init(|| Mutex::new(None))
            .lock()
        {
            if active.as_deref() == Some(self.request_token.as_str()) {
                *active = None;
            }
        }
    }
}

fn acquire_markdown_save_dialog_request(
    request_token: &str,
) -> Result<MarkdownSaveDialogRequestGuard, ()> {
    let mut active = MARKDOWN_SAVE_DIALOG_ACTIVE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| ())?;
    if active.is_some() {
        return Err(());
    }
    *active = Some(request_token.to_string());
    Ok(MarkdownSaveDialogRequestGuard {
        request_token: request_token.to_string(),
    })
}

fn prepare_markdown_save_dialog_directory(value: &str) -> Result<PathBuf, ()> {
    let path = PathBuf::from(value.trim());
    if value.trim().is_empty() || !path.is_absolute() || !path.is_dir() {
        return Err(());
    }
    let canonical = fs::canonicalize(path).map_err(|_| ())?;
    if !canonical.is_dir() {
        return Err(());
    }
    Ok(canonical)
}

fn valid_markdown_save_dialog_filename(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed != value
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.ends_with('.')
        || trimmed.ends_with(' ')
    {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.ends_with(".md") || lower.ends_with(".markdown")) {
        return false;
    }
    let stem = lower.split('.').next().unwrap_or_default();
    !matches!(
        stem,
        "con" | "prn" | "aux" | "nul" | "com1" | "com2" | "com3" | "com4"
            | "com5" | "com6" | "com7" | "com8" | "com9" | "lpt1" | "lpt2"
            | "lpt3" | "lpt4" | "lpt5" | "lpt6" | "lpt7" | "lpt8" | "lpt9"
    )
}

#[tauri::command(rename_all = "camelCase")]
pub async fn select_markdown_save_path(
    app: tauri::AppHandle,
    default_file_name: String,
    default_directory: String,
    title: String,
    request_token: String,
) -> Result<MarkdownSavePathSelectionResult, String> {
    if request_token.trim().is_empty() || !valid_markdown_save_dialog_filename(&default_file_name) {
        return Ok(MarkdownSavePathSelectionResult::PathInvalid { request_token });
    }
    let directory = match prepare_markdown_save_dialog_directory(&default_directory) {
        Ok(directory) => directory,
        Err(()) => {
            return Ok(MarkdownSavePathSelectionResult::PathInvalid { request_token });
        }
    };
    let _request_guard = match acquire_markdown_save_dialog_request(&request_token) {
        Ok(guard) => guard,
        Err(()) => {
            return Ok(MarkdownSavePathSelectionResult::Busy { request_token });
        }
    };
    let dialog = app
        .dialog()
        .file()
        .set_title(title)
        .set_file_name(default_file_name)
        .set_directory(directory)
        .add_filter("Markdown", &["md", "markdown"]);
    let selected = dialog.blocking_save_file();

    Ok(match selected {
        None => MarkdownSavePathSelectionResult::Cancelled { request_token },
        Some(file_path) => match file_path.into_path() {
            Ok(path) => MarkdownSavePathSelectionResult::Selected {
                path: path.to_string_lossy().into_owned(),
                request_token,
            },
            Err(_) => MarkdownSavePathSelectionResult::PathInvalid { request_token },
        },
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn read_markdown_file(
    file_path: String,
    location_mode: Option<String>,
    configured_root: Option<String>,
) -> Result<ReadMarkdownFileResult, String> {
    read_markdown_file_impl(
        &file_path,
        location_mode.as_deref(),
        configured_root.as_deref(),
    )
}

fn temporary_file(parent: &Path, target: &Path) -> Result<(PathBuf, File), &'static str> {
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("manuscript");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "MANUSCRIPT_WRITE_FAILED")?
        .as_nanos();
    for attempt in 0..32u8 {
        let path = parent.join(format!(
            ".{file_name}.labpod-atomic-{}-{nonce}-{attempt}.tmp",
            std::process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) if error.kind() == ErrorKind::PermissionDenied => {
                return Err("MANUSCRIPT_PERMISSION_DENIED")
            }
            Err(_) => return Err("MANUSCRIPT_WRITE_FAILED"),
        }
    }
    Err("MANUSCRIPT_WRITE_FAILED")
}

#[cfg(windows)]
fn replace_existing_file(replacement: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    #[link(name = "Kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced_file_name: *const u16,
            replacement_file_name: *const u16,
            backup_file_name: *const u16,
            replace_flags: u32,
            exclude: *mut core::ffi::c_void,
            reserved: *mut core::ffi::c_void,
        ) -> i32;
    }

    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let replacement_wide: Vec<u16> = replacement
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let replaced = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            replacement_wide.as_ptr(),
            ptr::null(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_existing_file(replacement: &Path, target: &Path) -> io::Result<()> {
    fs::rename(replacement, target)
}

fn atomic_write_markdown_with<F>(
    target: &Path,
    content: &[u8],
    allow_create: bool,
    replace_existing: F,
) -> Result<(), &'static str>
where
    F: Fn(&Path, &Path) -> io::Result<()>,
{
    validate_save_size(content.len())?;
    if !target.is_absolute() || !is_markdown_path(target) {
        return Err(if target.is_absolute() {
            "MANUSCRIPT_EXTENSION_UNSUPPORTED"
        } else {
            "MANUSCRIPT_PATH_INVALID"
        });
    }
    let parent = target.parent().ok_or("MANUSCRIPT_PATH_INVALID")?;
    let parent_metadata = fs::symlink_metadata(parent).map_err(|error| {
        if error.kind() == ErrorKind::PermissionDenied {
            "MANUSCRIPT_PERMISSION_DENIED"
        } else {
            "MANUSCRIPT_PATH_INVALID"
        }
    })?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err("MANUSCRIPT_SYMLINK_NOT_ALLOWED");
    }
    ensure_no_symlink_components(parent)?;

    let target_exists = target.exists();
    if !target_exists && !allow_create {
        return Err("MANUSCRIPT_FILE_NOT_FOUND");
    }
    if target_exists {
        let metadata = fs::symlink_metadata(target).map_err(|error| {
            if error.kind() == ErrorKind::PermissionDenied {
                "MANUSCRIPT_PERMISSION_DENIED"
            } else {
                "MANUSCRIPT_WRITE_FAILED"
            }
        })?;
        if metadata.file_type().is_symlink() {
            return Err("MANUSCRIPT_SYMLINK_NOT_ALLOWED");
        }
        if metadata.is_dir() {
            return Err("MANUSCRIPT_PATH_IS_DIRECTORY");
        }
        if !metadata.is_file() {
            return Err("MANUSCRIPT_PATH_INVALID");
        }
    }

    let (temporary_path, mut temporary) = temporary_file(parent, target)?;
    let write_result = temporary
        .write_all(content)
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.sync_all());
    drop(temporary);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(if error.kind() == ErrorKind::PermissionDenied {
            "MANUSCRIPT_PERMISSION_DENIED"
        } else {
            "MANUSCRIPT_WRITE_FAILED"
        });
    }
    let replace_result = if target_exists {
        replace_existing(&temporary_path, target)
    } else {
        fs::rename(&temporary_path, target)
    };
    if let Err(error) = replace_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(if error.kind() == ErrorKind::PermissionDenied {
            "MANUSCRIPT_PERMISSION_DENIED"
        } else {
            "MANUSCRIPT_ATOMIC_REPLACE_FAILED"
        });
    }
    Ok(())
}

fn atomic_write_markdown(
    target: &Path,
    content: &[u8],
    allow_create: bool,
) -> Result<(), &'static str> {
    atomic_write_markdown_with(target, content, allow_create, replace_existing_file)
}

fn existing_candidate_matches(target: &Path, content: &[u8]) -> Result<bool, &'static str> {
    let metadata = fs::symlink_metadata(target).map_err(|_| "CANDIDATE_FILE_CREATE_FAILED")?;
    if metadata.file_type().is_symlink() {
        return Err("CANDIDATE_PATH_OUTSIDE_ROOT");
    }
    if metadata.is_dir() || !metadata.is_file() {
        return Err("CANDIDATE_FILE_CONFLICT");
    }
    validate_size(metadata.len()).map_err(|_| "CANDIDATE_FILE_CONFLICT")?;
    let existing = fs::read(target).map_err(|_| "CANDIDATE_FILE_CREATE_FAILED")?;
    String::from_utf8(existing.clone()).map_err(|_| "CANDIDATE_FILE_CONFLICT")?;
    Ok(existing == content)
}

fn atomic_create_new_markdown_with<F>(
    target: &Path,
    content: &[u8],
    publish: F,
) -> Result<CreateNewMarkdownOutcome, &'static str>
where
    F: Fn(&Path, &Path) -> io::Result<()>,
{
    validate_save_size(content.len()).map_err(|_| "CANDIDATE_FILE_CREATE_FAILED")?;
    if !target.is_absolute() || !is_markdown_path(target) {
        return Err("CANDIDATE_PATH_INVALID");
    }
    let parent = target.parent().ok_or("CANDIDATE_PATH_INVALID")?;
    let parent_metadata = fs::symlink_metadata(parent).map_err(|_| "CANDIDATE_PATH_INVALID")?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err("CANDIDATE_PATH_OUTSIDE_ROOT");
    }
    ensure_no_symlink_components(parent).map_err(|_| "CANDIDATE_PATH_OUTSIDE_ROOT")?;
    if target.exists() {
        return if existing_candidate_matches(target, content)? {
            Ok(CreateNewMarkdownOutcome::Reused)
        } else {
            Err("CANDIDATE_IDEMPOTENCY_CONFLICT")
        };
    }

    let (temporary_path, mut temporary) =
        temporary_file(parent, target).map_err(|_| "CANDIDATE_FILE_CREATE_FAILED")?;
    let write_result = temporary
        .write_all(content)
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.sync_all());
    drop(temporary);
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary_path);
        return Err("CANDIDATE_FILE_CREATE_FAILED");
    }
    match publish(&temporary_path, target) {
        Ok(()) => {
            if fs::remove_file(&temporary_path).is_err() {
                return Err("CANDIDATE_FILE_CREATE_FAILED");
            }
            Ok(CreateNewMarkdownOutcome::Created)
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            let _ = fs::remove_file(&temporary_path);
            if existing_candidate_matches(target, content)? {
                Ok(CreateNewMarkdownOutcome::Reused)
            } else {
                Err("CANDIDATE_IDEMPOTENCY_CONFLICT")
            }
        }
        Err(_) => {
            let _ = fs::remove_file(&temporary_path);
            Err("CANDIDATE_FILE_CREATE_FAILED")
        }
    }
}

fn atomic_create_new_markdown(
    target: &Path,
    content: &[u8],
) -> Result<CreateNewMarkdownOutcome, &'static str> {
    atomic_create_new_markdown_with(target, content, |temporary, destination| {
        fs::hard_link(temporary, destination)
    })
}

fn valid_year_month(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && std::str::from_utf8(&bytes[5..7])
            .ok()
            .and_then(|month| month.parse::<u8>().ok())
            .is_some_and(|month| (1..=12).contains(&month))
}

fn valid_day(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 2
        && bytes.iter().all(u8::is_ascii_digit)
        && value.parse::<u8>().is_ok_and(|day| (1..=31).contains(&day))
}

fn valid_candidate_calendar_date(year_month: &str, day: &str) -> bool {
    if !valid_year_month(year_month) || !valid_day(day) {
        return false;
    }
    let year = year_month[0..4].parse::<u16>().unwrap_or(0);
    let month = year_month[5..7].parse::<u8>().unwrap_or(0);
    let day = day.parse::<u8>().unwrap_or(0);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let maximum = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => return false,
    };
    day <= maximum
}

fn fnv1a(value: &str, seed: u32) -> String {
    let mut hash = seed;
    for byte in value.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("{hash:08x}")
}

fn stable_request_short_id(request_id: &str, length: usize) -> Result<String, &'static str> {
    if request_id.is_empty()
        || request_id.len() > 256
        || !request_id.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
        })
    {
        return Err("CANDIDATE_REQUEST_ID_INVALID");
    }
    let value = format!(
        "{}{}",
        fnv1a(request_id, 0x811c9dc5),
        fnv1a(request_id, 0x9e3779b1)
    );
    Ok(value[..length].to_string())
}

struct CandidateTimestamp<'a> {
    calendar_date: &'a str,
    clock_time: String,
}

fn parse_candidate_occurred_at(value: &str) -> Result<CandidateTimestamp<'_>, &'static str> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
        || ![&bytes[0..4], &bytes[5..7], &bytes[8..10], &bytes[11..13], &bytes[14..16], &bytes[17..19]]
            .into_iter()
            .all(|part| part.iter().all(u8::is_ascii_digit))
    {
        return Err("CANDIDATE_OCCURRED_AT_INVALID");
    }
    let date = &value[..10];
    let year_month = &value[..7];
    let day = &value[8..10];
    if !valid_candidate_calendar_date(year_month, day) {
        return Err("CANDIDATE_OCCURRED_AT_INVALID");
    }
    let hour = value[11..13].parse::<u8>().map_err(|_| "CANDIDATE_OCCURRED_AT_INVALID")?;
    let minute = value[14..16].parse::<u8>().map_err(|_| "CANDIDATE_OCCURRED_AT_INVALID")?;
    let second = value[17..19].parse::<u8>().map_err(|_| "CANDIDATE_OCCURRED_AT_INVALID")?;
    if hour > 23 || minute > 59 || second > 59 {
        return Err("CANDIDATE_OCCURRED_AT_INVALID");
    }
    let suffix = &value[19..];
    let zone = if suffix == "Z" {
        "Z"
    } else {
        let without_fraction = if let Some(fraction) = suffix.strip_prefix('.') {
            let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 || digits > 9 {
                return Err("CANDIDATE_OCCURRED_AT_INVALID");
            }
            &fraction[digits..]
        } else {
            suffix
        };
        without_fraction
    };
    if zone != "Z" {
        let zone_bytes = zone.as_bytes();
        if zone_bytes.len() != 6
            || !matches!(zone_bytes[0], b'+' | b'-')
            || zone_bytes[3] != b':'
            || !zone_bytes[1..3].iter().all(u8::is_ascii_digit)
            || !zone_bytes[4..6].iter().all(u8::is_ascii_digit)
        {
            return Err("CANDIDATE_OCCURRED_AT_INVALID");
        }
        let offset_hour = zone[1..3].parse::<u8>().map_err(|_| "CANDIDATE_OCCURRED_AT_INVALID")?;
        let offset_minute = zone[4..6].parse::<u8>().map_err(|_| "CANDIDATE_OCCURRED_AT_INVALID")?;
        if offset_hour > 23 || offset_minute > 59 {
            return Err("CANDIDATE_OCCURRED_AT_INVALID");
        }
    }
    Ok(CandidateTimestamp {
        calendar_date: date,
        clock_time: format!("{}{}{}", &value[11..13], &value[14..16], &value[17..19]),
    })
}

fn validate_direct_markdown_filename(file_name: &str) -> Result<(), &'static str> {
    if file_name.is_empty()
        || file_name.len() > 160
        || file_name.contains('/')
        || file_name.contains('\\')
        || !file_name.ends_with(".md")
        || file_name.chars().any(|character| character.is_control())
    {
        return Err("CANDIDATE_FILENAME_INVALID");
    }
    Ok(())
}

fn expected_literature_candidate_filename(
    manuscript_channel: &str,
    source: &str,
    timestamp: &CandidateTimestamp<'_>,
    request_id: &str,
) -> Result<String, &'static str> {
    let prefix = match manuscript_channel {
        "literature_outline" => "literature-outline",
        "dedicated_notes" => "dedicated-notes",
        _ => return Err("CANDIDATE_CHANNEL_UNSUPPORTED"),
    };
    if !matches!(source, "ai" | "user") {
        return Err("CANDIDATE_SOURCE_INVALID");
    }
    let short_id = stable_request_short_id(request_id, 8)?;
    Ok(format!(
        "{prefix}_{source}_{}_{}_{}.md",
        timestamp.calendar_date, timestamp.clock_time, short_id
    ))
}

fn expected_review_candidate_filename(
    manuscript_channel: &str,
    source: &str,
    timestamp: &CandidateTimestamp<'_>,
    request_id: &str,
) -> Result<String, &'static str> {
    if manuscript_channel != "primary" {
        return Err("CANDIDATE_CHANNEL_UNSUPPORTED");
    }
    if !matches!(source, "ai" | "user") {
        return Err("CANDIDATE_SOURCE_INVALID");
    }
    let short_id = stable_request_short_id(request_id, 8)?;
    Ok(format!(
        "review_{source}_{}_{}_{}.md",
        timestamp.calendar_date, timestamp.clock_time, short_id
    ))
}

fn expected_experiment_candidate_filename(
    manuscript_channel: &str,
    source: &str,
    timestamp: &CandidateTimestamp<'_>,
    request_id: &str,
) -> Result<String, &'static str> {
    if manuscript_channel != "primary" {
        return Err("CANDIDATE_CHANNEL_UNSUPPORTED");
    }
    if !matches!(source, "ai" | "user") {
        return Err("CANDIDATE_SOURCE_INVALID");
    }
    let short_id = stable_request_short_id(request_id, 8)?;
    Ok(format!(
        "experiment_{source}_{}_{}_{}.md",
        timestamp.calendar_date, timestamp.clock_time, short_id
    ))
}

fn expected_quick_analysis_primary_candidate_filename(
    owner_type: &str,
    manuscript_channel: &str,
    source: &str,
    timestamp: &CandidateTimestamp<'_>,
    request_id: &str,
) -> Result<String, &'static str> {
    if manuscript_channel != "primary" {
        return Err("CANDIDATE_CHANNEL_UNSUPPORTED");
    }
    if source != "ai" {
        return Err("CANDIDATE_SOURCE_INVALID");
    }
    let prefix = match owner_type {
        "experimentRun" => "experiment-run",
        "resultItem" => "result-item",
        "finding" => "finding",
        "outputCandidate" => "output-candidate",
        "outputGap" => "output-gap",
        "researchOutput" => "research-output",
        _ => return Err("CANDIDATE_OWNER_UNSUPPORTED"),
    };
    let short_id = stable_request_short_id(request_id, 8)?;
    Ok(format!(
        "{prefix}_{source}_{}_{}_{}.md",
        timestamp.calendar_date, timestamp.clock_time, short_id
    ))
}

#[allow(clippy::too_many_arguments)]
fn create_managed_candidate_markdown_structured_impl(
    configured_root: &Path,
    workspace_directory: &Path,
    layout: &str,
    owner_type: &str,
    manuscript_channel: &str,
    source: &str,
    occurred_at: &str,
    request_id: &str,
    expected_file_name: &str,
    content: &str,
) -> CreateNewMarkdownResult {
    let planned_path = workspace_directory.join(expected_file_name);
    let failure = |code: &str, message: &str, created_directories: bool, retryable: bool| {
        CreateNewMarkdownResult {
            status: if created_directories {
                "partial"
            } else {
                "error"
            }
            .to_string(),
            file_name: expected_file_name.to_string(),
            path: path_for_result(&planned_path),
            created_directories,
            created_file: false,
            reused_file: false,
            bytes_written: 0,
            encoding: "utf-8",
            retryable,
            error_code: Some(code.to_string()),
            error_message: Some(message.to_string()),
        }
    };
    if !configured_root.is_absolute() || !workspace_directory.is_absolute() {
        return failure(
            "CANDIDATE_PATH_INVALID",
            "Candidate root and workspace must be absolute.",
            false,
            false,
        );
    }
    if descendant_relative(configured_root, workspace_directory)
        .map(|relative| relative.as_os_str().is_empty())
        .unwrap_or(true)
    {
        return failure(
            "CANDIDATE_PATH_OUTSIDE_ROOT",
            "Candidate workspace must be a managed descendant of the configured root.",
            false,
            false,
        );
    }
    let timestamp = match parse_candidate_occurred_at(occurred_at) {
        Ok(value) => value,
        Err(code) => return failure(code, "Candidate occurredAt is invalid.", false, false),
    };
    let file_validation = match layout {
        "workspaceRoot" if owner_type == "literature" => expected_literature_candidate_filename(
            manuscript_channel,
            source,
            &timestamp,
            request_id,
        )
        .and_then(|expected| {
            validate_direct_markdown_filename(expected_file_name)?;
            if expected == expected_file_name { Ok(()) } else { Err("CANDIDATE_FILENAME_INVALID") }
        }),
        "workspaceRoot" if owner_type == "review" => expected_review_candidate_filename(
            manuscript_channel,
            source,
            &timestamp,
            request_id,
        )
        .and_then(|expected| {
            validate_direct_markdown_filename(expected_file_name)?;
            if expected == expected_file_name { Ok(()) } else { Err("CANDIDATE_FILENAME_INVALID") }
        }),
        "workspaceRoot" if owner_type == "experiment" => expected_experiment_candidate_filename(
            manuscript_channel,
            source,
            &timestamp,
            request_id,
        )
        .and_then(|expected| {
            validate_direct_markdown_filename(expected_file_name)?;
            if expected == expected_file_name { Ok(()) } else { Err("CANDIDATE_FILENAME_INVALID") }
        }),
        "workspaceRoot" if matches!(
            owner_type,
            "experimentRun" | "resultItem" | "finding" | "outputCandidate" | "outputGap" | "researchOutput"
        ) => expected_quick_analysis_primary_candidate_filename(
            owner_type,
            manuscript_channel,
            source,
            &timestamp,
            request_id,
        )
        .and_then(|expected| {
            validate_direct_markdown_filename(expected_file_name)?;
            if expected == expected_file_name { Ok(()) } else { Err("CANDIDATE_FILENAME_INVALID") }
        }),
        _ => Err("CANDIDATE_LAYOUT_INVALID"),
    };
    if let Err(code) = file_validation {
        return failure(code, "Candidate filename or layout contract is invalid.", false, false);
    }

    let canonical_workspace = match validate_existing_managed_path(configured_root, workspace_directory) {
        Ok(value) if value.is_dir() => value,
        _ => return failure("CANDIDATE_PATH_OUTSIDE_ROOT", "Candidate workspace is not a safe managed directory.", false, false),
    };
    let (canonical_directory, created_directories) = (canonical_workspace, false);
    if !canonical_directory.is_dir() {
        return failure(
            "CANDIDATE_FILE_CONFLICT",
            "Candidate directory conflicts with a file.",
            created_directories,
            false,
        );
    }
    let actual_file = canonical_directory.join(expected_file_name);
    if actual_file.parent() != Some(canonical_directory.as_path()) {
        return failure("CANDIDATE_PATH_OUTSIDE_ROOT", "Candidate file parent does not equal the rebuilt directory.", created_directories, false);
    }
    match atomic_create_new_markdown(&actual_file, content.as_bytes()) {
        Ok(outcome) => CreateNewMarkdownResult {
            status: if outcome == CreateNewMarkdownOutcome::Created {
                "success"
            } else {
                "skipped"
            }
            .to_string(),
            file_name: expected_file_name.to_string(),
            path: path_for_result(&actual_file),
            created_directories,
            created_file: outcome == CreateNewMarkdownOutcome::Created,
            reused_file: outcome == CreateNewMarkdownOutcome::Reused,
            bytes_written: content.len() as u64,
            encoding: "utf-8",
            retryable: false,
            error_code: None,
            error_message: None,
        },
        Err(code) => failure(
            code,
            "Candidate Markdown could not be created without overwrite.",
            created_directories,
            code != "CANDIDATE_IDEMPOTENCY_CONFLICT" && code != "CANDIDATE_FILE_CONFLICT",
        ),
    }
}

#[cfg(test)]
fn create_managed_candidate_markdown_impl(
    configured_root: &Path,
    default_folder: &Path,
    target_directory: &Path,
    file_path: &Path,
    content: &str,
) -> CreateNewMarkdownResult {
    let failure = |code: &str, created_directories: bool| CreateNewMarkdownResult {
        status: if created_directories { "partial" } else { "error" }.to_string(),
        file_name: file_path.file_name().and_then(|value| value.to_str()).unwrap_or("").to_string(),
        path: path_for_result(file_path),
        created_directories,
        created_file: false,
        reused_file: false,
        bytes_written: 0,
        encoding: "utf-8",
        retryable: false,
        error_code: Some(code.to_string()),
        error_message: Some("Legacy Candidate test contract rejected the path.".to_string()),
    };
    let relative = match descendant_relative(default_folder, target_directory) {
        Ok(value) => value,
        Err(_) => return failure("CANDIDATE_PATH_OUTSIDE_ROOT", false),
    };
    let segments = relative
        .iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    if segments.len() != 3
        || segments[0] != "drafts"
        || !valid_candidate_calendar_date(&segments[1], &segments[2])
    {
        return failure("CANDIDATE_PATH_INVALID", false);
    }
    if descendant_relative(target_directory, file_path)
        .map(|value| value.components().count() != 1)
        .unwrap_or(true)
    {
        return failure("CANDIDATE_PATH_OUTSIDE_ROOT", false);
    }
    let file_name = file_path.file_name().and_then(|value| value.to_str()).unwrap_or("");
    let expected_prefix = format!("{}-{}_candidate_", segments[1], segments[2]);
    if !file_name.starts_with(&expected_prefix) || !file_name.ends_with(".md") {
        return failure("CANDIDATE_PATH_INVALID", false);
    }
    let (directory, created_directories) = match create_managed_descendant_directory(
        configured_root,
        default_folder,
        target_directory,
    ) {
        Ok(value) => value,
        Err(code) => return failure(code, false),
    };
    let target = directory.join(file_name);
    match atomic_create_new_markdown(&target, content.as_bytes()) {
        Ok(outcome) => CreateNewMarkdownResult {
            status: if outcome == CreateNewMarkdownOutcome::Created { "success" } else { "skipped" }.to_string(),
            file_name: file_name.to_string(),
            path: path_for_result(&target),
            created_directories,
            created_file: outcome == CreateNewMarkdownOutcome::Created,
            reused_file: outcome == CreateNewMarkdownOutcome::Reused,
            bytes_written: content.len() as u64,
            encoding: "utf-8",
            retryable: false,
            error_code: None,
            error_message: None,
        },
        Err(code) => failure(code, created_directories),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_managed_candidate_markdown(
    configured_root: String,
    workspace_directory: String,
    layout: String,
    owner_type: String,
    manuscript_channel: String,
    source: String,
    occurred_at: String,
    request_id: String,
    expected_file_name: String,
    content: String,
) -> Result<CreateNewMarkdownResult, String> {
    Ok(create_managed_candidate_markdown_structured_impl(
        Path::new(configured_root.trim()),
        Path::new(workspace_directory.trim()),
        layout.trim(),
        owner_type.trim(),
        manuscript_channel.trim(),
        source.trim(),
        occurred_at.trim(),
        request_id.trim(),
        expected_file_name.trim(),
        &content,
    ))
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_managed_workspace_markdown_copy(
    configured_root: String,
    workspace_directory: String,
    manuscript_channel: String,
    source_file_ref_id: String,
    expected_file_name: String,
    content: String,
) -> Result<CreateNewMarkdownResult, String> {
    let root = Path::new(configured_root.trim());
    let workspace = Path::new(workspace_directory.trim());
    let planned_path = workspace.join(expected_file_name.trim());
    let failure = |code: &str, message: &str| CreateNewMarkdownResult {
        status: "error".to_string(),
        file_name: expected_file_name.trim().to_string(),
        path: path_for_result(&planned_path),
        created_directories: false,
        created_file: false,
        reused_file: false,
        bytes_written: 0,
        encoding: "utf-8",
        retryable: false,
        error_code: Some(code.to_string()),
        error_message: Some(message.to_string()),
    };
    if !root.is_absolute()
        || !workspace.is_absolute()
        || descendant_relative(root, workspace)
            .map(|relative| relative.as_os_str().is_empty())
            .unwrap_or(true)
    {
        return Ok(failure("MANAGED_COPY_PATH_OUTSIDE_ROOT", "Managed-copy workspace is outside the configured root."));
    }
    let prefix = match manuscript_channel.trim() {
        "literature_outline" => "literature-outline",
        "dedicated_notes" => "dedicated-notes",
        _ => return Ok(failure("MANAGED_COPY_CHANNEL_INVALID", "Managed-copy channel is invalid.")),
    };
    let short_id = match stable_request_short_id(source_file_ref_id.trim(), 12) {
        Ok(value) => value,
        Err(_) => return Ok(failure("MANAGED_COPY_SOURCE_INVALID", "Managed-copy source FileRef ID is invalid.")),
    };
    let expected = format!("{prefix}_imported_{short_id}.md");
    if validate_direct_markdown_filename(expected_file_name.trim()).is_err()
        || expected != expected_file_name.trim()
    {
        return Ok(failure("MANAGED_COPY_FILENAME_INVALID", "Managed-copy filename does not match its source identity."));
    }
    let canonical_workspace = match validate_existing_managed_path(root, workspace) {
        Ok(value) if value.is_dir() => value,
        _ => return Ok(failure("MANAGED_COPY_PATH_OUTSIDE_ROOT", "Managed-copy workspace is not a safe managed directory.")),
    };
    let actual_file = canonical_workspace.join(&expected);
    if actual_file.parent() != Some(canonical_workspace.as_path()) {
        return Ok(failure("MANAGED_COPY_PATH_OUTSIDE_ROOT", "Managed-copy parent is invalid."));
    }
    Ok(match atomic_create_new_markdown(&actual_file, content.as_bytes()) {
        Ok(outcome) => CreateNewMarkdownResult {
            status: if outcome == CreateNewMarkdownOutcome::Created { "success" } else { "skipped" }.to_string(),
            file_name: expected.clone(),
            path: path_for_result(&actual_file),
            created_directories: false,
            created_file: outcome == CreateNewMarkdownOutcome::Created,
            reused_file: outcome == CreateNewMarkdownOutcome::Reused,
            bytes_written: content.len() as u64,
            encoding: "utf-8",
            retryable: false,
            error_code: None,
            error_message: None,
        },
        Err(code) => failure(code, "Managed-copy Markdown could not be created without overwrite."),
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn write_current_markdown_file_atomic(
    file_path: String,
    content: String,
    location_mode: String,
    configured_root: Option<String>,
) -> Result<AtomicMarkdownWriteResult, String> {
    let trimmed_path = file_path.trim();
    if trimmed_path.is_empty() {
        return Err("MANUSCRIPT_PATH_INVALID".to_string());
    }
    let path = Path::new(trimmed_path);
    let canonical_path = validate_existing_markdown_path(
        path,
        Some(location_mode.as_str()),
        configured_root.as_deref(),
    )
    .map_err(str::to_string)?;
    atomic_write_markdown(&canonical_path, content.as_bytes(), false).map_err(str::to_string)?;
    Ok(AtomicMarkdownWriteResult {
        path: path_for_result(&canonical_path),
        bytes_written: content.len() as u64,
        encoding: "utf-8",
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_markdown_file(
    file_path: String,
    content: String,
    overwrite_confirmed: bool,
) -> Result<SaveMarkdownFileResult, String> {
    let trimmed_path = file_path.trim();
    if trimmed_path.is_empty() {
        return Err("empty_path".to_string());
    }
    let path = Path::new(trimmed_path);
    if !path.is_absolute() {
        return Err("empty_path".to_string());
    }
    if !is_markdown_path(path) {
        return Err("invalid_extension".to_string());
    }
    validate_save_size(content.len()).map_err(|_| "content_too_large".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "parent_not_found".to_string())?;
    if !parent.exists() || !parent.is_dir() {
        return Err("parent_not_found".to_string());
    }
    let target_exists = path.exists();
    let overwritten = validate_overwrite(
        target_exists,
        !target_exists || path.is_file(),
        overwrite_confirmed,
    )
    .map_err(str::to_string)?;
    atomic_write_markdown(path, content.as_bytes(), true).map_err(|error| match error {
        "MANUSCRIPT_PATH_IS_DIRECTORY" => "not_file_target".to_string(),
        "MANUSCRIPT_FILE_TOO_LARGE" => "content_too_large".to_string(),
        _ => "write_failed".to_string(),
    })?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("markdown")
        .to_string();
    Ok(SaveMarkdownFileResult {
        file_name,
        size_bytes: content.len() as u64,
        overwritten,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};
    use std::thread;

    static TEST_ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn test_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "labpod-manuscript-io-{name}-{}-{nonce}-{}",
            std::process::id(),
            TEST_ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[derive(Debug)]
    struct ConcurrentSaveWriterDiagnostic {
        writer_id: String,
        input_expected_revision: String,
        input_body_hash: String,
        input_body_marker: String,
        target_path_identity: String,
        start_barrier_arrival: usize,
        start_sequence: usize,
        completion_sequence: usize,
        result: ExplicitManuscriptFileResult,
    }

    #[derive(Debug)]
    struct ConcurrentSaveRoundDiagnostic {
        initial_revision: String,
        initial_physical_identity: String,
        writers: Vec<ConcurrentSaveWriterDiagnostic>,
        final_body_hash: String,
        final_body_marker: String,
        final_revision: String,
        final_physical_identity: String,
        directory_entries: Vec<String>,
        process_lock_residual: bool,
    }

    fn run_concurrent_explicit_save_round(
        root: &Path,
        file_name: &str,
        initial_body: &str,
        writer_bodies: [&str; 2],
    ) -> ConcurrentSaveRoundDiagnostic {
        fs::create_dir_all(root).expect("create concurrent root");
        let file = root.join(file_name);
        fs::write(&file, initial_body).expect("write concurrent manuscript");
        let identity = explicit_path_identity(&fs::canonicalize(&file).expect("canonical file"));
        let initial = read_explicit_manuscript_file_impl(
            file.to_str().expect("file path"), &identity, file_name, Some("managed"), root.to_str(),
        );
        assert_eq!(initial.status, "success", "initial read: {initial:#?}");
        let revision = initial.revision.clone().expect("initial revision");
        let initial_physical_identity = initial.physical_identity.clone().expect("initial physical identity");
        let barrier = Arc::new(Barrier::new(3));
        let sequence = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::new();
        for (index, body) in writer_bodies.into_iter().enumerate() {
            let barrier = Arc::clone(&barrier);
            let sequence = Arc::clone(&sequence);
            let root = root.to_path_buf();
            let file = file.clone();
            let file_name = file_name.to_string();
            let identity = identity.clone();
            let revision = revision.clone();
            let body = body.to_string();
            workers.push(thread::spawn(move || {
                let start_barrier_arrival = sequence.fetch_add(1, Ordering::SeqCst);
                barrier.wait();
                let start_sequence = sequence.fetch_add(1, Ordering::SeqCst);
                let result = save_explicit_manuscript_file_atomic_impl(
                    file.to_str().expect("file path"), &identity, &file_name, &revision, &body,
                    Some("managed"), root.to_str(),
                );
                let completion_sequence = sequence.fetch_add(1, Ordering::SeqCst);
                ConcurrentSaveWriterDiagnostic {
                    writer_id: format!("writer-{index}"),
                    input_expected_revision: revision,
                    input_body_hash: manuscript_revision(body.as_bytes()),
                    input_body_marker: body,
                    target_path_identity: identity,
                    start_barrier_arrival,
                    start_sequence,
                    completion_sequence,
                    result,
                }
            }));
        }
        barrier.wait();
        let writers: Vec<_> = workers.into_iter()
            .map(|worker| worker.join().expect("concurrent writer"))
            .collect();
        let final_read = read_explicit_manuscript_file_impl(
            file.to_str().expect("file path"), &identity, file_name, Some("managed"), root.to_str(),
        );
        assert_eq!(final_read.status, "success", "final read: {final_read:#?}");
        let final_body_marker = final_read.content.clone().expect("final content");
        let mut directory_entries: Vec<_> = fs::read_dir(root).expect("read concurrent root")
            .map(|entry| entry.expect("directory entry").file_name().to_string_lossy().into_owned())
            .collect();
        directory_entries.sort();
        ConcurrentSaveRoundDiagnostic {
            initial_revision: revision,
            initial_physical_identity,
            writers,
            final_body_hash: manuscript_revision(final_body_marker.as_bytes()),
            final_body_marker,
            final_revision: final_read.revision.expect("final revision"),
            final_physical_identity: final_read.physical_identity.expect("final physical identity"),
            directory_entries,
            process_lock_residual: explicit_process_save_lock_is_active(&identity),
        }
    }

    fn assert_concurrent_explicit_save_round(diagnostic: &ConcurrentSaveRoundDiagnostic) {
        let applied: Vec<_> = diagnostic.writers.iter()
            .filter(|writer| writer.result.write_applied == Some(true)).collect();
        let conflicts: Vec<_> = diagnostic.writers.iter()
            .filter(|writer| writer.result.error_code.as_deref() == Some("MANUSCRIPT_REVISION_CONFLICT"))
            .collect();
        assert_eq!(applied.len(), 1, "exactly one applied writer: {diagnostic:#?}");
        assert_eq!(conflicts.len(), 1, "actual loser code: {diagnostic:#?}");
        assert_eq!(conflicts[0].result.write_applied, Some(false), "loser must be zero-write: {diagnostic:#?}");
        assert_eq!(diagnostic.final_body_marker, applied[0].input_body_marker,
            "final bytes must belong to the winner: {diagnostic:#?}");
        assert_eq!(diagnostic.final_body_hash, applied[0].input_body_hash,
            "final hash must belong to the winner: {diagnostic:#?}");
        assert_eq!(diagnostic.final_revision, applied[0].result.revision.as_deref().expect("winner revision"),
            "final revision must be the winner readback: {diagnostic:#?}");
        assert_ne!(diagnostic.final_revision, diagnostic.initial_revision,
            "one physical commit must advance revision: {diagnostic:#?}");
        assert_eq!(diagnostic.directory_entries.len(), 1,
            "no temp or file-lock residual: {diagnostic:#?}");
        assert!(!diagnostic.process_lock_residual,
            "no exact process-lock residual: {diagnostic:#?}");
        assert!(!diagnostic.initial_physical_identity.is_empty() && !diagnostic.final_physical_identity.is_empty(),
            "physical identity must be observed before and after: {diagnostic:#?}");
        for writer in &diagnostic.writers {
            assert_eq!(writer.input_expected_revision, diagnostic.initial_revision,
                "both writers must use one canonical revision: {diagnostic:#?}");
            assert!(!writer.writer_id.is_empty() && !writer.target_path_identity.is_empty()
                && writer.start_barrier_arrival < 2 && writer.start_sequence >= 2
                && writer.completion_sequence > writer.start_sequence,
                "writer sequencing diagnostics must be complete: {diagnostic:#?}");
        }
    }

    #[test]
    fn markdown_file_extension_and_size_contracts_are_shared() {
        assert!(is_markdown_path(Path::new("notes.md")));
        assert!(is_markdown_path(Path::new("notes.MARKDOWN")));
        assert!(!is_markdown_path(Path::new("notes.txt")));
        assert!(validate_size(MAX_MARKDOWN_FILE_BYTES).is_ok());
        assert_eq!(
            validate_size(MAX_MARKDOWN_FILE_BYTES + 1),
            Err("MANUSCRIPT_FILE_TOO_LARGE")
        );
    }

    #[test]
    fn markdown_overwrite_requires_explicit_confirmation_for_save_as() {
        assert_eq!(
            validate_overwrite(true, true, false),
            Err("path_exists_requires_confirm")
        );
        assert_eq!(validate_overwrite(true, true, true), Ok(true));
        assert_eq!(validate_overwrite(false, true, false), Ok(false));
    }

    #[test]
    fn reader_supports_managed_and_external_strict_utf8() {
        let root = test_root("reader");
        let folder = root.join("projects/item");
        fs::create_dir_all(&folder).expect("create folder");
        let file = folder.join("body.md");
        fs::write(&file, "研究记录\n").expect("write markdown");
        let managed = read_markdown_file_impl(
            file.to_str().expect("file path"),
            Some("managed"),
            root.to_str(),
        )
        .expect("read managed");
        assert_eq!(managed.content, "研究记录\n");
        assert_eq!(managed.encoding, "utf-8");
        let external =
            read_markdown_file_impl(file.to_str().expect("file path"), Some("external"), None)
                .expect("read external");
        assert_eq!(external.size_bytes, "研究记录\n".len() as u64);

        fs::write(&file, [0xff, 0xfe]).expect("write invalid utf8");
        assert_eq!(
            read_markdown_file_impl(file.to_str().expect("file path"), Some("external"), None),
            Err("MANUSCRIPT_ENCODING_INVALID".to_string())
        );
        fs::remove_dir_all(&root).expect("cleanup test root");
    }

    #[cfg(windows)]
    #[test]
    fn windows_picker_like_chinese_paths_cross_the_explicit_read_boundary() {
        let root = test_root("windows-chinese-picker");
        let managed_folder = root.join("实验 空格").join("数据");
        let external_root = test_root("windows-chinese-external");
        fs::create_dir_all(&managed_folder).expect("create managed Chinese folder");
        fs::create_dir_all(&external_root).expect("create external Chinese folder");
        let managed_file = managed_folder.join("第二份 文稿.md");
        let external_file = external_root.join("外部 文稿.md");
        fs::write(&managed_file, "中文 managed 原文\r\n").expect("write managed");
        fs::write(&external_file, "中文 external 原文\n").expect("write external");

        let canonical_managed =
            fs::canonicalize(&managed_file).expect("canonical managed picker target");
        let managed_identity = explicit_path_identity(&canonical_managed);
        let managed = read_explicit_manuscript_file_impl(
            managed_file.to_str().expect("managed picker path"),
            &managed_identity,
            "第二份 文稿.md",
            Some("managed"),
            root.to_str(),
        );
        assert_eq!(managed.status, "success");
        assert_eq!(managed.content.as_deref(), Some("中文 managed 原文\r\n"));
        assert_eq!(managed.line_ending.as_deref(), Some("crlf"));
        assert_eq!(managed.path_identity.as_deref(), Some(managed_identity.as_str()));

        let canonical_external =
            fs::canonicalize(&external_file).expect("canonical external picker target");
        let external_identity = explicit_path_identity(&canonical_external);
        let external = read_explicit_manuscript_file_impl(
            external_file.to_str().expect("external picker path"),
            &external_identity,
            "外部 文稿.md",
            Some("external"),
            None,
        );
        assert_eq!(external.status, "success");
        assert_eq!(external.content.as_deref(), Some("中文 external 原文\n"));

        let blocked = read_explicit_manuscript_file_impl(
            external_file.to_str().expect("external picker path"),
            &external_identity,
            "外部 文稿.md",
            Some("managed"),
            root.to_str(),
        );
        assert_eq!(
            blocked.error_code.as_deref(),
            Some("MANUSCRIPT_PATH_OUTSIDE_ROOT")
        );

        fs::remove_dir_all(&root).expect("cleanup managed root");
        fs::remove_dir_all(&external_root).expect("cleanup external root");
    }

    #[test]
    fn reader_rejects_missing_directory_large_and_outside_managed_root() {
        let root = test_root("reader-errors");
        let outside = test_root("reader-outside");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir_all(&outside).expect("create outside");
        let missing = root.join("missing.md");
        assert_eq!(
            read_markdown_file_impl(missing.to_str().expect("path"), Some("external"), None),
            Err("MANUSCRIPT_FILE_NOT_FOUND".to_string())
        );
        let directory = root.join("directory.md");
        fs::create_dir_all(&directory).expect("create directory");
        assert_eq!(
            read_markdown_file_impl(directory.to_str().expect("path"), Some("external"), None),
            Err("MANUSCRIPT_PATH_IS_DIRECTORY".to_string())
        );
        let large = root.join("large.md");
        fs::write(&large, vec![b'a'; MAX_MARKDOWN_FILE_BYTES as usize + 1])
            .expect("write large file");
        assert_eq!(
            read_markdown_file_impl(large.to_str().expect("path"), Some("external"), None),
            Err("MANUSCRIPT_FILE_TOO_LARGE".to_string())
        );
        let outside_file = outside.join("outside.md");
        fs::write(&outside_file, "outside").expect("write outside");
        assert_eq!(
            read_markdown_file_impl(
                outside_file.to_str().expect("path"),
                Some("managed"),
                root.to_str(),
            ),
            Err("MANUSCRIPT_PATH_OUTSIDE_ROOT".to_string())
        );
        fs::remove_dir_all(&root).expect("cleanup root");
        fs::remove_dir_all(&outside).expect("cleanup outside");
    }

    #[test]
    fn atomic_writer_replaces_content_and_reports_bytes() {
        let root = test_root("atomic");
        fs::create_dir_all(&root).expect("create root");
        let file = root.join("body.md");
        fs::write(&file, "old content").expect("write old");
        let result = write_current_markdown_file_atomic(
            file.to_string_lossy().into_owned(),
            "完整新正文".to_string(),
            "external".to_string(),
            None,
        )
        .expect("atomic write");
        assert_eq!(result.bytes_written, "完整新正文".len() as u64);
        assert_eq!(
            fs::read_to_string(&file).expect("read result"),
            "完整新正文"
        );
        assert_eq!(
            fs::read_dir(&root).expect("read root").count(),
            1,
            "temporary file must be removed after replacement"
        );
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn atomic_replace_failure_preserves_original_and_cleans_own_temp() {
        let root = test_root("atomic-failure");
        fs::create_dir_all(&root).expect("create root");
        let file = root.join("body.md");
        fs::write(&file, "original").expect("write original");
        let result = atomic_write_markdown_with(&file, b"replacement", false, |_temp, _target| {
            Err(io::Error::new(
                ErrorKind::Other,
                "injected failure",
            ))
        });
        assert_eq!(result, Err("MANUSCRIPT_ATOMIC_REPLACE_FAILED"));
        assert_eq!(
            fs::read_to_string(&file).expect("read original"),
            "original"
        );
        assert_eq!(fs::read_dir(&root).expect("read root").count(), 1);
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn explicit_reader_returns_path_identity_revision_and_line_ending() {
        let root = test_root("d2-explicit-reader");
        fs::create_dir_all(&root).expect("create root");
        let file = root.join("experiment.md");
        fs::write(&file, "研究\r\n正文\r\n").expect("write manuscript");
        let identity = explicit_path_identity(&fs::canonicalize(&file).expect("canonical file"));
        let result = read_explicit_manuscript_file_impl(
            file.to_str().expect("file path"),
            &identity,
            "experiment.md",
            Some("managed"),
            root.to_str(),
        );
        assert_eq!(result.status, "success");
        assert_eq!(result.content.as_deref(), Some("研究\r\n正文\r\n"));
        assert_eq!(result.path_identity.as_deref(), Some(identity.as_str()));
        assert!(result
            .physical_identity
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()));
        assert_eq!(result.line_ending.as_deref(), Some("crlf"));
        assert_eq!(result.byte_length, Some("研究\r\n正文\r\n".len() as u64));
        assert!(result
            .revision
            .as_deref()
            .is_some_and(|value| value.starts_with("manuscript-physical-v2:")));
        assert!(result.error_code.is_none());
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn explicit_reader_and_save_reject_unsafe_targets_without_side_effects() {
        let root = test_root("d2-explicit-errors");
        let outside = test_root("d2-explicit-errors-outside");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir_all(&outside).expect("create outside");

        let missing = root.join("missing.md");
        let missing_result = read_explicit_manuscript_file_impl(
            missing.to_str().expect("missing path"),
            &explicit_path_identity(&missing),
            "missing.md",
            Some("managed"),
            root.to_str(),
        );
        assert_eq!(missing_result.error_code.as_deref(), Some("MANUSCRIPT_FILE_NOT_FOUND"));

        let directory = root.join("directory.md");
        fs::create_dir_all(&directory).expect("create directory target");
        let directory_result = read_explicit_manuscript_file_impl(
            directory.to_str().expect("directory path"),
            &explicit_path_identity(&fs::canonicalize(&directory).expect("canonical directory")),
            "directory.md",
            Some("managed"),
            root.to_str(),
        );
        assert_eq!(directory_result.error_code.as_deref(), Some("MANUSCRIPT_TARGET_IS_DIRECTORY"));

        let invalid_utf8 = root.join("invalid.md");
        fs::write(&invalid_utf8, [0xff, 0xfe, 0xfd]).expect("write invalid utf8");
        let invalid_result = read_explicit_manuscript_file_impl(
            invalid_utf8.to_str().expect("invalid path"),
            &explicit_path_identity(&fs::canonicalize(&invalid_utf8).expect("canonical invalid")),
            "invalid.md",
            Some("managed"),
            root.to_str(),
        );
        assert_eq!(invalid_result.error_code.as_deref(), Some("MANUSCRIPT_ENCODING_INVALID"));

        let too_large = root.join("large.md");
        fs::write(&too_large, vec![b'x'; MAX_MARKDOWN_FILE_BYTES as usize + 1])
            .expect("write oversized file");
        let large_result = read_explicit_manuscript_file_impl(
            too_large.to_str().expect("large path"),
            &explicit_path_identity(&fs::canonicalize(&too_large).expect("canonical large")),
            "large.md",
            Some("managed"),
            root.to_str(),
        );
        assert_eq!(large_result.error_code.as_deref(), Some("MANUSCRIPT_FILE_TOO_LARGE"));

        let outside_file = outside.join("experiment.md");
        fs::write(&outside_file, "outside").expect("write outside manuscript");
        let outside_identity = explicit_path_identity(
            &fs::canonicalize(&outside_file).expect("canonical outside manuscript"),
        );
        let outside_result = save_explicit_manuscript_file_atomic_impl(
            outside_file.to_str().expect("outside path"),
            &outside_identity,
            "experiment.md",
            &manuscript_revision(b"outside"),
            "must not write",
            Some("managed"),
            root.to_str(),
        );
        assert_eq!(outside_result.error_code.as_deref(), Some("MANUSCRIPT_PATH_OUTSIDE_ROOT"));
        assert_eq!(outside_result.write_applied, Some(false));
        assert_eq!(fs::read_to_string(&outside_file).expect("outside unchanged"), "outside");
        assert_eq!(fs::read_dir(&outside).expect("outside entries").count(), 1, "no lock or temp outside root");

        fs::remove_dir_all(&root).expect("cleanup root");
        fs::remove_dir_all(&outside).expect("cleanup outside");
    }

    #[test]
    fn explicit_save_requires_revision_and_physically_rereads() {
        let root = test_root("d2-explicit-save");
        fs::create_dir_all(&root).expect("create root");
        let file = root.join("experiment.md");
        fs::write(&file, "old").expect("write manuscript");
        let identity = explicit_path_identity(&fs::canonicalize(&file).expect("canonical file"));
        let read = read_explicit_manuscript_file_impl(
            file.to_str().expect("file path"),
            &identity,
            "experiment.md",
            Some("managed"),
            root.to_str(),
        );
        let saved = save_explicit_manuscript_file_atomic_impl(
            file.to_str().expect("file path"),
            &identity,
            "experiment.md",
            read.revision.as_deref().expect("revision"),
            "完整新文稿\n",
            Some("managed"),
            root.to_str(),
        );
        assert_eq!(saved.status, "success");
        assert_eq!(saved.write_applied, Some(true));
        assert_eq!(saved.recovery_required, Some(false));
        assert_eq!(saved.content.as_deref(), Some("完整新文稿\n"));
        assert_eq!(fs::read_to_string(&file).expect("physical reread"), "完整新文稿\n");

        let conflict = save_explicit_manuscript_file_atomic_impl(
            file.to_str().expect("file path"),
            &identity,
            "experiment.md",
            read.revision.as_deref().expect("stale revision"),
            "must not overwrite",
            Some("managed"),
            root.to_str(),
        );
        assert_eq!(conflict.status, "error");
        assert_eq!(conflict.error_code.as_deref(), Some("MANUSCRIPT_REVISION_CONFLICT"));
        assert_eq!(conflict.write_applied, Some(false));
        assert_eq!(fs::read_to_string(&file).expect("conflict preserves winner"), "完整新文稿\n");
        assert_eq!(fs::read_dir(&root).expect("read root").count(), 1, "no temp or lock residue");
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn explicit_same_content_save_is_a_post_cas_physical_no_op() {
        let root = test_root("t1-explicit-no-op");
        fs::create_dir_all(&root).expect("create root");
        let file = root.join("exact.md");
        fs::write(&file, "\u{feff}中文\r\nemoji 🧪\n").expect("write manuscript");
        let identity = explicit_path_identity(&fs::canonicalize(&file).expect("canonical file"));
        let initial = read_explicit_manuscript_file_impl(
            file.to_str().expect("path"),
            &identity,
            "exact.md",
            Some("managed"),
            root.to_str(),
        );
        let before = fs::metadata(&file).expect("metadata before");
        let result = save_explicit_manuscript_file_atomic_impl(
            file.to_str().expect("path"),
            &identity,
            "exact.md",
            initial.revision.as_deref().expect("revision"),
            initial.content.as_deref().expect("content"),
            Some("managed"),
            root.to_str(),
        );
        let after = fs::metadata(&file).expect("metadata after");
        assert_eq!(result.status, "success");
        assert_eq!(result.write_applied, Some(false));
        assert_eq!(result.revision, initial.revision);
        assert_eq!(before.modified().expect("before mtime"), after.modified().expect("after mtime"));
        assert_eq!(
            fs::read(&file).expect("bytes after"),
            "\u{feff}中文\r\nemoji 🧪\n".as_bytes()
        );
        assert_eq!(fs::read_dir(&root).expect("read root").count(), 1);
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn explicit_same_content_cannot_bypass_stale_revision_cas() {
        let root = test_root("t1-no-op-cas-order");
        fs::create_dir_all(&root).expect("create root");
        let file = root.join("cas.md");
        fs::write(&file, "baseline").expect("write baseline");
        let identity = explicit_path_identity(&fs::canonicalize(&file).expect("canonical file"));
        let initial = read_explicit_manuscript_file_impl(
            file.to_str().expect("path"),
            &identity,
            "cas.md",
            Some("managed"),
            root.to_str(),
        );
        fs::write(&file, "proposed").expect("external winner");
        let result = save_explicit_manuscript_file_atomic_impl(
            file.to_str().expect("path"),
            &identity,
            "cas.md",
            initial.revision.as_deref().expect("stale revision"),
            "proposed",
            Some("managed"),
            root.to_str(),
        );
        assert_eq!(result.status, "error");
        assert_eq!(
            result.error_code.as_deref(),
            Some("MANUSCRIPT_REVISION_CONFLICT")
        );
        assert_eq!(result.write_applied, Some(false));
        assert_eq!(fs::read_to_string(&file).expect("winner preserved"), "proposed");
        assert_eq!(fs::read_dir(&root).expect("read root").count(), 1);
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn explicit_revision_rejects_delete_replace_even_when_bytes_match() {
        let root = test_root("t1-delete-replace");
        fs::create_dir_all(&root).expect("create root");
        let file = root.join("replace.md");
        let displaced = root.join("displaced.md");
        fs::write(&file, "same bytes").expect("write original");
        let identity = explicit_path_identity(&fs::canonicalize(&file).expect("canonical file"));
        let initial = read_explicit_manuscript_file_impl(
            file.to_str().expect("path"),
            &identity,
            "replace.md",
            Some("managed"),
            root.to_str(),
        );
        fs::rename(&file, &displaced).expect("displace original");
        fs::write(&file, "same bytes").expect("replace target");
        let result = save_explicit_manuscript_file_atomic_impl(
            file.to_str().expect("path"),
            &identity,
            "replace.md",
            initial.revision.as_deref().expect("stale revision"),
            "same bytes",
            Some("managed"),
            root.to_str(),
        );
        assert_eq!(
            result.error_code.as_deref(),
            Some("MANUSCRIPT_REVISION_CONFLICT")
        );
        assert_eq!(result.write_applied, Some(false));
        assert_eq!(fs::read_to_string(&file).expect("replacement preserved"), "same bytes");
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn explicit_target_rejects_hard_links_and_reparse_aliases() {
        let root = test_root("t1-aliases");
        fs::create_dir_all(&root).expect("create root");
        let file = root.join("original.md");
        let hard_link = root.join("hard-link.md");
        fs::write(&file, "content").expect("write original");
        fs::hard_link(&file, &hard_link).expect("create hard link");
        let identity = explicit_path_identity(&fs::canonicalize(&file).expect("canonical file"));
        let hard_link_result = read_explicit_manuscript_file_impl(
            file.to_str().expect("path"),
            &identity,
            "original.md",
            Some("managed"),
            root.to_str(),
        );
        assert_eq!(
            hard_link_result.error_code.as_deref(),
            Some("MANUSCRIPT_PHYSICAL_IDENTITY_AMBIGUOUS")
        );

        #[cfg(windows)]
        {
            let actual_directory = root.join("actual");
            let alias_directory = root.join("junction");
            fs::create_dir_all(&actual_directory).expect("create actual directory");
            let actual_file = actual_directory.join("alias.md");
            fs::write(&actual_file, "alias").expect("write alias target");
            if std::os::windows::fs::symlink_dir(&actual_directory, &alias_directory).is_ok() {
                let alias_file = alias_directory.join("alias.md");
                let alias_identity = explicit_path_identity(
                    &fs::canonicalize(&alias_file).expect("canonical alias file"),
                );
                let alias_result = read_explicit_manuscript_file_impl(
                    alias_file.to_str().expect("alias path"),
                    &alias_identity,
                    "alias.md",
                    Some("external"),
                    None,
                );
                assert_eq!(
                    alias_result.error_code.as_deref(),
                    Some("MANUSCRIPT_PHYSICAL_IDENTITY_AMBIGUOUS")
                );
            }
        }
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn concurrent_explicit_saves_with_one_revision_have_one_winner() {
        let root = test_root("d2-explicit-concurrent");
        let diagnostic = run_concurrent_explicit_save_round(
            &root, "experiment-run.md", "initial", ["winner-a", "winner-b"],
        );
        eprintln!("D2F_CONCURRENT_SAVE_DIAGNOSTIC {diagnostic:#?}");
        assert_concurrent_explicit_save_round(&diagnostic);
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn concurrent_explicit_saves_same_process_stress_is_deterministic() {
        for round in 0..80 {
            let root = test_root(&format!("d2f-stress-{round}"));
            let first = format!("round-{round}-body-a");
            let second = format!("round-{round}-body-b");
            let diagnostic = run_concurrent_explicit_save_round(
                &root, "stress.md", "initial", [&first, &second],
            );
            assert_concurrent_explicit_save_round(&diagnostic);
            fs::remove_dir_all(&root).expect("cleanup stress root");
        }
    }

    #[test]
    fn concurrent_explicit_saves_same_body_still_have_one_cas_winner() {
        let root = test_root("d2f-same-body").join("中文 空格");
        let diagnostic = run_concurrent_explicit_save_round(
            &root, "same body.md", "initial", ["identical proposal", "identical proposal"],
        );
        assert_concurrent_explicit_save_round(&diagnostic);
        fs::remove_dir_all(root.parent().expect("parent root")).expect("cleanup same-body root");
    }

    #[test]
    fn concurrent_explicit_saves_large_bodies_and_different_targets_do_not_interfere() {
        let parent = test_root("d2f-cross-target");
        let first_root = parent.join("target a");
        let second_root = parent.join("目标 b");
        let large_a = format!("a:{}", "a".repeat(512 * 1024));
        let large_b = format!("b:{}", "b".repeat(512 * 1024));
        let first = thread::spawn(move || {
            let diagnostic = run_concurrent_explicit_save_round(
                &first_root, "large a.md", "initial-a", [&large_a, "small-a"],
            );
            (first_root, diagnostic)
        });
        let second = thread::spawn(move || {
            let diagnostic = run_concurrent_explicit_save_round(
                &second_root, "large b.md", "initial-b", [&large_b, "small-b"],
            );
            (second_root, diagnostic)
        });
        let (first_root, first_diagnostic) = first.join().expect("first target worker");
        let (second_root, second_diagnostic) = second.join().expect("second target worker");
        assert_concurrent_explicit_save_round(&first_diagnostic);
        assert_concurrent_explicit_save_round(&second_diagnostic);
        assert_ne!(first_diagnostic.writers[0].target_path_identity,
            second_diagnostic.writers[0].target_path_identity,
            "different targets must keep independent lock keys");
        assert!(first_root.exists() && second_root.exists());
        fs::remove_dir_all(&parent).expect("cleanup cross-target root");
    }

    #[test]
    fn explicit_save_reports_applied_when_post_write_reread_fails() {
        let root = test_root("d2-explicit-reread-failure");
        fs::create_dir_all(&root).expect("create root");
        let file = root.join("experiment.md");
        fs::write(&file, "old").expect("write manuscript");
        let identity = explicit_path_identity(&fs::canonicalize(&file).expect("canonical file"));
        let initial = read_explicit_manuscript_file_impl(
            file.to_str().expect("path"), &identity, "experiment.md", Some("managed"), root.to_str(),
        );
        let result = save_explicit_manuscript_file_atomic_with_post_read(
            file.to_str().expect("path"),
            &identity,
            "experiment.md",
            initial.revision.as_deref().expect("revision"),
            "new",
            Some("managed"),
            root.to_str(),
            || explicit_error(
                "MANUSCRIPT_PHYSICAL_REREAD_FAILED",
                "injected reread failure",
                None,
                None,
            ),
        );
        assert_eq!(result.status, "error");
        assert_eq!(result.error_code.as_deref(), Some("MANUSCRIPT_PHYSICAL_REREAD_FAILED"));
        assert_eq!(result.write_applied, Some(true));
        assert_eq!(result.recovery_required, Some(true));
        assert_eq!(fs::read_to_string(&file).expect("replacement happened"), "new");
        assert_eq!(fs::read_dir(&root).expect("read root").count(), 1);
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn explicit_save_reports_applied_when_post_write_verify_mismatches() {
        let root = test_root("d2-explicit-verify-failure");
        fs::create_dir_all(&root).expect("create root");
        let file = root.join("experiment-run.md");
        fs::write(&file, "old").expect("write manuscript");
        let identity = explicit_path_identity(&fs::canonicalize(&file).expect("canonical file"));
        let initial = read_explicit_manuscript_file_impl(
            file.to_str().expect("path"), &identity, "experiment-run.md", Some("managed"), root.to_str(),
        );
        let result = save_explicit_manuscript_file_atomic_with_post_read(
            file.to_str().expect("path"),
            &identity,
            "experiment-run.md",
            initial.revision.as_deref().expect("revision"),
            "new",
            Some("managed"),
            root.to_str(),
            || {
                let mut reread = read_explicit_manuscript_file_impl(
                    file.to_str().expect("path"), &identity, "experiment-run.md", Some("managed"), root.to_str(),
                );
                reread.content = Some("injected mismatch".to_string());
                reread
            },
        );
        assert_eq!(result.status, "error");
        assert_eq!(result.error_code.as_deref(), Some("MANUSCRIPT_PHYSICAL_VERIFY_FAILED"));
        assert_eq!(result.write_applied, Some(true));
        assert_eq!(result.recovery_required, Some(true));
        assert_eq!(fs::read_to_string(&file).expect("replacement happened"), "new");
        assert_eq!(fs::read_dir(&root).expect("read root").count(), 1);
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn current_writer_rejects_missing_target_and_managed_escape() {
        let root = test_root("writer-errors");
        let outside = test_root("writer-outside");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir_all(&outside).expect("create outside");
        let missing = root.join("missing.md");
        assert_eq!(
            write_current_markdown_file_atomic(
                missing.to_string_lossy().into_owned(),
                "content".to_string(),
                "external".to_string(),
                None,
            ),
            Err("MANUSCRIPT_FILE_NOT_FOUND".to_string())
        );
        assert!(!missing.exists());
        let outside_file = outside.join("outside.md");
        fs::write(&outside_file, "original").expect("write outside");
        assert_eq!(
            write_current_markdown_file_atomic(
                outside_file.to_string_lossy().into_owned(),
                "changed".to_string(),
                "managed".to_string(),
                root.to_str().map(str::to_string),
            ),
            Err("MANUSCRIPT_PATH_OUTSIDE_ROOT".to_string())
        );
        assert_eq!(
            fs::read_to_string(&outside_file).expect("read outside"),
            "original"
        );
        fs::remove_dir_all(&root).expect("cleanup root");
        fs::remove_dir_all(&outside).expect("cleanup outside");
    }

    #[test]
    fn reader_and_writer_reject_symlinks_when_supported() {
        let root = test_root("symlink");
        fs::create_dir_all(&root).expect("create root");
        let actual = root.join("actual.md");
        let link = root.join("linked.md");
        fs::write(&actual, "actual").expect("write actual");
        #[cfg(unix)]
        let link_result = std::os::unix::fs::symlink(&actual, &link);
        #[cfg(windows)]
        let link_result = std::os::windows::fs::symlink_file(&actual, &link);
        if link_result.is_ok() {
            assert_eq!(
                read_markdown_file_impl(link.to_str().expect("path"), Some("external"), None),
                Err("MANUSCRIPT_SYMLINK_NOT_ALLOWED".to_string())
            );
            assert_eq!(
                write_current_markdown_file_atomic(
                    link.to_string_lossy().into_owned(),
                    "changed".to_string(),
                    "external".to_string(),
                    None,
                ),
                Err("MANUSCRIPT_SYMLINK_NOT_ALLOWED".to_string())
            );
            assert_eq!(fs::read_to_string(&actual).expect("read actual"), "actual");
        }
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn literature_candidate_is_flat_structured_and_exact_content_idempotent() {
        let root = test_root("literature-candidate-flat");
        let workspace = root.join("projects/中文 项目/literature/共享 工作区");
        fs::create_dir_all(&workspace).expect("create Literature workspace");
        let request_id = "request-stable-001";
        let occurred_at = "2026-07-14T00:59:59+08:00";
        let file_name = "literature-outline_ai_2026-07-14_005959_8f275850.md";

        let first = create_managed_candidate_markdown_structured_impl(
            &root,
            &workspace,
            "workspaceRoot",
            "literature",
            "literature_outline",
            "ai",
            occurred_at,
            request_id,
            file_name,
            "# 候选文稿\n",
        );
        assert_eq!(first.status, "success");
        assert_eq!(first.file_name, file_name);
        assert!(first.created_file);
        assert!(!first.created_directories);
        let file = workspace.join(file_name);
        assert_eq!(Path::new(&first.path).parent(), file.parent());
        assert_eq!(fs::read_to_string(&file).expect("read Candidate"), "# 候选文稿\n");
        assert!(!workspace.join("drafts").exists());

        let retry = create_managed_candidate_markdown_structured_impl(
            &root, &workspace, "workspaceRoot", "literature", "literature_outline", "ai",
            occurred_at, request_id, file_name, "# 候选文稿\n",
        );
        assert_eq!(retry.status, "skipped");
        assert!(retry.reused_file);

        let conflict = create_managed_candidate_markdown_structured_impl(
            &root, &workspace, "workspaceRoot", "literature", "literature_outline", "ai",
            occurred_at, request_id, file_name, "different",
        );
        assert_eq!(conflict.status, "error");
        assert_eq!(conflict.error_code.as_deref(), Some("CANDIDATE_IDEMPOTENCY_CONFLICT"));
        assert_eq!(fs::read_to_string(&file).expect("original preserved"), "# 候选文稿\n");
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn literature_candidate_rebuilds_filename_and_rejects_metadata_or_layout_drift() {
        let root = test_root("literature-candidate-contract");
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).expect("create workspace");
        let valid = "dedicated-notes_user_2026-07-14_005959_8f275850.md";
        let wrong_name = create_managed_candidate_markdown_structured_impl(
            &root, &workspace, "workspaceRoot", "literature", "dedicated_notes", "user",
            "2026-07-14T00:59:59+08:00", "request-stable-001", "wrong.md", "body",
        );
        assert_eq!(wrong_name.error_code.as_deref(), Some("CANDIDATE_FILENAME_INVALID"));
        let wrong_channel = create_managed_candidate_markdown_structured_impl(
            &root, &workspace, "workspaceRoot", "literature", "primary", "user",
            "2026-07-14T00:59:59+08:00", "request-stable-001", valid, "body",
        );
        assert_eq!(wrong_channel.error_code.as_deref(), Some("CANDIDATE_CHANNEL_UNSUPPORTED"));
        let wrong_time = create_managed_candidate_markdown_structured_impl(
            &root, &workspace, "workspaceRoot", "literature", "dedicated_notes", "user",
            "2026-02-31T00:59:59Z", "request-stable-001", valid, "body",
        );
        assert_eq!(wrong_time.error_code.as_deref(), Some("CANDIDATE_OCCURRED_AT_INVALID"));
        let outside = test_root("literature-candidate-outside");
        fs::create_dir_all(&outside).expect("create outside");
        let escaped = create_managed_candidate_markdown_structured_impl(
            &root, &outside, "workspaceRoot", "literature", "dedicated_notes", "user",
            "2026-07-14T00:59:59+08:00", "request-stable-001", valid, "body",
        );
        assert_eq!(escaped.error_code.as_deref(), Some("CANDIDATE_PATH_OUTSIDE_ROOT"));
        assert!(!outside.join(valid).exists());
        fs::remove_dir_all(&root).expect("cleanup root");
        fs::remove_dir_all(&outside).expect("cleanup outside");
    }

    #[test]
    fn review_candidate_is_root_flat_idempotent_and_never_overwrites() {
        let root = test_root("review-candidate-flat");
        let workspace = root.join("projects/project/review/workspace");
        fs::create_dir_all(&workspace).expect("create Review workspace");
        let file_name = "review_ai_2026-07-14_005959_8f275850.md";
        let first = create_managed_candidate_markdown_structured_impl(
            &root, &workspace, "workspaceRoot", "review", "primary", "ai",
            "2026-07-14T00:59:59+08:00", "request-stable-001", file_name, "# Candidate\n",
        );
        assert_eq!(first.status, "success");
        assert!(first.created_file);
        assert!(!first.created_directories);
        assert!(!workspace.join("drafts").exists());
        let file = workspace.join(file_name);
        assert_eq!(fs::read_to_string(&file).expect("read Review Candidate"), "# Candidate\n");

        let retry = create_managed_candidate_markdown_structured_impl(
            &root, &workspace, "workspaceRoot", "review", "primary", "ai",
            "2026-07-14T00:59:59+08:00", "request-stable-001", file_name, "# Candidate\n",
        );
        assert_eq!(retry.status, "skipped");
        assert!(retry.reused_file);

        let conflict = create_managed_candidate_markdown_structured_impl(
            &root, &workspace, "workspaceRoot", "review", "primary", "ai",
            "2026-07-14T00:59:59+08:00", "request-stable-001", file_name, "different",
        );
        assert_eq!(conflict.error_code.as_deref(), Some("CANDIDATE_IDEMPOTENCY_CONFLICT"));
        assert_eq!(fs::read_to_string(&file).expect("original preserved"), "# Candidate\n");
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn review_candidate_recomputes_identity_and_rejects_wrong_metadata() {
        let root = test_root("review-candidate-contract");
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).expect("create workspace");
        let valid = "review_user_2026-07-14_005959_8f275850.md";
        for result in [
            create_managed_candidate_markdown_structured_impl(
                &root, &workspace, "workspaceRoot", "review", "primary", "user",
                "2026-07-14T00:59:59+08:00", "request-stable-001", "wrong.md", "body",
            ),
            create_managed_candidate_markdown_structured_impl(
                &root, &workspace, "workspaceRoot", "review", "literature_outline", "user",
                "2026-07-14T00:59:59+08:00", "request-stable-001", valid, "body",
            ),
            create_managed_candidate_markdown_structured_impl(
                &root, &workspace, "workspaceRoot", "review", "primary", "system",
                "2026-07-14T00:59:59+08:00", "request-stable-001", valid, "body",
            ),
        ] {
            assert_eq!(result.status, "error");
        }
        assert!(fs::read_dir(&workspace).expect("read workspace").next().is_none());
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn lp13_d1_a6_experiment_candidate_is_flat_create_only_and_exactly_named() {
        let root = test_root("d1-a6-experiment-candidate");
        let workspace = root.join("projects/project/experiment/workspace");
        fs::create_dir_all(&workspace).expect("create Experiment workspace");
        let file_name = "experiment_ai_2026-07-14_005959_8f275850.md";
        let first = create_managed_candidate_markdown_structured_impl(
            &root,
            &workspace,
            "workspaceRoot",
            "experiment",
            "primary",
            "ai",
            "2026-07-14T00:59:59+08:00",
            "request-stable-001",
            file_name,
            "# Experiment Candidate\n",
        );
        assert_eq!(first.status, "success");
        assert!(first.created_file);
        assert!(!first.created_directories);
        let file = workspace.join(file_name);
        assert_eq!(
            fs::read_to_string(&file).expect("read Experiment Candidate"),
            "# Experiment Candidate\n"
        );

        let replay = create_managed_candidate_markdown_structured_impl(
            &root,
            &workspace,
            "workspaceRoot",
            "experiment",
            "primary",
            "ai",
            "2026-07-14T00:59:59+08:00",
            "request-stable-001",
            file_name,
            "# Experiment Candidate\n",
        );
        assert_eq!(replay.status, "skipped");
        assert!(replay.reused_file);

        let conflict = create_managed_candidate_markdown_structured_impl(
            &root,
            &workspace,
            "workspaceRoot",
            "experiment",
            "primary",
            "ai",
            "2026-07-14T00:59:59+08:00",
            "request-stable-001",
            file_name,
            "different",
        );
        assert_eq!(
            conflict.error_code.as_deref(),
            Some("CANDIDATE_IDEMPOTENCY_CONFLICT")
        );
        assert_eq!(
            fs::read_to_string(&file).expect("original preserved"),
            "# Experiment Candidate\n"
        );

        for invalid in [
            create_managed_candidate_markdown_structured_impl(
                &root,
                &workspace,
                "workspaceRoot",
                "experiment",
                "primary",
                "ai",
                "2026-07-14T00:59:59+08:00",
                "request-stable-001",
                "wrong.md",
                "body",
            ),
            create_managed_candidate_markdown_structured_impl(
                &root,
                &workspace,
                "workspaceRoot",
                "experiment",
                "literature_outline",
                "ai",
                "2026-07-14T00:59:59+08:00",
                "request-stable-001",
                file_name,
                "body",
            ),
        ] {
            assert_eq!(invalid.status, "error");
        }
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn lp13_d1_a19_run_and_outputs_candidates_use_exact_owner_names_and_create_only_files() {
        let root = test_root("d1-a19-run-outputs-candidates");
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).expect("create A19 workspace");
        let rows = [
            ("experimentRun", "experiment-run"),
            ("resultItem", "result-item"),
            ("finding", "finding"),
            ("outputCandidate", "output-candidate"),
            ("outputGap", "output-gap"),
            ("researchOutput", "research-output"),
        ];
        for (owner_type, prefix) in rows {
            let file_name = format!(
                "{prefix}_ai_2026-07-14_005959_8f275850.md"
            );
            let body = format!("# {owner_type} A19 Candidate\n");
            let first = create_managed_candidate_markdown_structured_impl(
                &root,
                &workspace,
                "workspaceRoot",
                owner_type,
                "primary",
                "ai",
                "2026-07-14T00:59:59+08:00",
                "request-stable-001",
                &file_name,
                &body,
            );
            assert_eq!(first.status, "success", "{owner_type}");
            assert!(first.created_file, "{owner_type}");
            assert_eq!(
                fs::read_to_string(workspace.join(&file_name)).expect("read A19 candidate"),
                body,
                "{owner_type}"
            );
            let replay = create_managed_candidate_markdown_structured_impl(
                &root,
                &workspace,
                "workspaceRoot",
                owner_type,
                "primary",
                "ai",
                "2026-07-14T00:59:59+08:00",
                "request-stable-001",
                &file_name,
                &body,
            );
            assert_eq!(replay.status, "skipped", "{owner_type}");
            assert!(replay.reused_file, "{owner_type}");
            let conflict = create_managed_candidate_markdown_structured_impl(
                &root,
                &workspace,
                "workspaceRoot",
                owner_type,
                "primary",
                "ai",
                "2026-07-14T00:59:59+08:00",
                "request-stable-001",
                &file_name,
                "different body",
            );
            assert_eq!(
                conflict.error_code.as_deref(),
                Some("CANDIDATE_IDEMPOTENCY_CONFLICT"),
                "{owner_type}"
            );
            let wrong_channel = create_managed_candidate_markdown_structured_impl(
                &root,
                &workspace,
                "workspaceRoot",
                owner_type,
                "dedicated_notes",
                "ai",
                "2026-07-14T00:59:59+08:00",
                "request-stable-001",
                &file_name,
                &body,
            );
            assert_eq!(
                wrong_channel.error_code.as_deref(),
                Some("CANDIDATE_CHANNEL_UNSUPPORTED"),
                "{owner_type}"
            );
            let wrong_source = create_managed_candidate_markdown_structured_impl(
                &root,
                &workspace,
                "workspaceRoot",
                owner_type,
                "primary",
                "user",
                "2026-07-14T00:59:59+08:00",
                "request-stable-001",
                &file_name,
                &body,
            );
            assert_eq!(
                wrong_source.error_code.as_deref(),
                Some("CANDIDATE_SOURCE_INVALID"),
                "{owner_type}"
            );
        }
        assert_eq!(
            fs::read_dir(&workspace).expect("read A19 workspace").count(),
            6
        );
        fs::remove_dir_all(&root).expect("cleanup A19 root");
    }

    #[test]
    fn save_as_create_new_is_real_atomic_and_non_overwriting() {
        let root = test_root("save-as-create-new");
        fs::create_dir_all(&root).expect("create root");
        let file = root.join("independent.md");
        let original = "\u{7814}\u{7a76} Save As\n";
        let created = save_markdown_file(
            file.to_string_lossy().into_owned(),
            original.to_string(),
            false,
        )
        .expect("create Save As target");
        assert!(!created.overwritten);
        assert_eq!(fs::read_to_string(&file).expect("read Save As target"), original);
        assert_eq!(
            save_markdown_file(
                file.to_string_lossy().into_owned(),
                "must not overwrite".to_string(),
                false,
            ),
            Err("path_exists_requires_confirm".to_string())
        );
        assert_eq!(fs::read_to_string(&file).expect("original preserved"), original);
        assert_eq!(fs::read_dir(&root).expect("read root").count(), 1);
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn candidate_create_new_is_atomic_idempotent_and_never_overwrites() {
        let root = test_root("candidate-create-new");
        let default_folder = root.join("projects/item");
        let directory = default_folder.join("drafts/2026-07/13");
        let file = directory.join("2026-07-13_candidate_abcd_draft.md");
        fs::create_dir_all(&default_folder).expect("create default folder");

        let first = create_managed_candidate_markdown_impl(
            &root,
            &default_folder,
            &directory,
            &file,
            "研究候选 🧪\n",
        );
        assert_eq!(first.status, "success");
        assert!(first.created_directories);
        assert!(first.created_file);
        assert!(!first.reused_file);
        assert_eq!(
            fs::read_to_string(&file).expect("read candidate"),
            "研究候选 🧪\n"
        );

        let retry = create_managed_candidate_markdown_impl(
            &root,
            &default_folder,
            &directory,
            &file,
            "研究候选 🧪\n",
        );
        assert_eq!(retry.status, "skipped");
        assert!(retry.reused_file);
        assert!(!retry.created_file);

        let conflict = create_managed_candidate_markdown_impl(
            &root,
            &default_folder,
            &directory,
            &file,
            "different",
        );
        assert_eq!(conflict.status, "error");
        assert_eq!(
            conflict.error_code.as_deref(),
            Some("CANDIDATE_IDEMPOTENCY_CONFLICT")
        );
        assert_eq!(
            fs::read_to_string(&file).expect("original preserved"),
            "研究候选 🧪\n"
        );
        assert_eq!(
            fs::read_dir(&directory)
                .expect("read candidate directory")
                .count(),
            1,
            "create-new temp must be removed"
        );
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn candidate_rejects_root_default_folder_and_directory_escapes() {
        let root = test_root("candidate-containment");
        let outside = test_root("candidate-outside");
        let default_folder = root.join("projects/item");
        fs::create_dir_all(&default_folder).expect("create default folder");
        fs::create_dir_all(&outside).expect("create outside");

        let outside_directory = outside.join("drafts/2026-07/13");
        let outside_file = outside_directory.join("candidate.md");
        let outside_result = create_managed_candidate_markdown_impl(
            &root,
            &default_folder,
            &outside_directory,
            &outside_file,
            "outside",
        );
        assert_eq!(
            outside_result.error_code.as_deref(),
            Some("CANDIDATE_PATH_OUTSIDE_ROOT")
        );
        assert!(!outside_file.exists());

        let sibling = root.join("projects/other/drafts/2026-07/13");
        let sibling_file = sibling.join("candidate.md");
        let sibling_result = create_managed_candidate_markdown_impl(
            &root,
            &default_folder,
            &sibling,
            &sibling_file,
            "sibling",
        );
        assert_eq!(
            sibling_result.error_code.as_deref(),
            Some("CANDIDATE_PATH_OUTSIDE_ROOT")
        );
        assert!(!sibling_file.exists());

        let invalid_directory = default_folder.join("other/2026-07/13");
        let invalid_file = invalid_directory.join("candidate.md");
        let invalid_result = create_managed_candidate_markdown_impl(
            &root,
            &default_folder,
            &invalid_directory,
            &invalid_file,
            "invalid",
        );
        assert_eq!(
            invalid_result.error_code.as_deref(),
            Some("CANDIDATE_PATH_INVALID")
        );
        assert!(!invalid_file.exists());

        let invalid_date_directory = default_folder.join("drafts/2026-02/31");
        let invalid_date_file =
            invalid_date_directory.join("2026-02-31_candidate_abcd_invalid-date.md");
        let invalid_date_result = create_managed_candidate_markdown_impl(
            &root,
            &default_folder,
            &invalid_date_directory,
            &invalid_date_file,
            "invalid date",
        );
        assert_eq!(
            invalid_date_result.error_code.as_deref(),
            Some("CANDIDATE_PATH_INVALID")
        );
        assert!(!invalid_date_file.exists());

        let valid_directory = default_folder.join("drafts/2026-07/13");
        let invalid_name_file = valid_directory.join("wrong-name.md");
        let invalid_name_result = create_managed_candidate_markdown_impl(
            &root,
            &default_folder,
            &valid_directory,
            &invalid_name_file,
            "invalid name",
        );
        assert_eq!(
            invalid_name_result.error_code.as_deref(),
            Some("CANDIDATE_PATH_INVALID")
        );
        assert!(!invalid_name_file.exists());

        fs::remove_dir_all(&root).expect("cleanup root");
        fs::remove_dir_all(&outside).expect("cleanup outside");
    }

    #[test]
    fn candidate_directory_and_publish_failures_leave_no_partial_final_file() {
        let root = test_root("candidate-failures");
        let default_folder = root.join("projects/item");
        fs::create_dir_all(&default_folder).expect("create default folder");
        fs::write(default_folder.join("drafts"), "conflict").expect("write directory conflict");
        let blocked_directory = default_folder.join("drafts/2026-07/13");
        let blocked_file = blocked_directory.join("2026-07-13_candidate_abcd_blocked.md");
        let blocked = create_managed_candidate_markdown_impl(
            &root,
            &default_folder,
            &blocked_directory,
            &blocked_file,
            "blocked",
        );
        assert!(matches!(
            blocked.error_code.as_deref(),
            Some("CANDIDATE_FILE_CONFLICT") | Some("CANDIDATE_DIRECTORY_CREATE_FAILED")
        ));
        assert!(!blocked_file.exists());

        fs::remove_file(default_folder.join("drafts")).expect("remove test conflict");
        let directory = default_folder.join("drafts/2026-07/13");
        fs::create_dir_all(&directory).expect("create candidate directory");
        let file = directory.join("candidate.md");
        let failed = atomic_create_new_markdown_with(&file, b"complete", |_temp, _target| {
            Err(io::Error::new(
                ErrorKind::PermissionDenied,
                "injected publish failure",
            ))
        });
        assert_eq!(failed, Err("CANDIDATE_FILE_CREATE_FAILED"));
        assert!(!file.exists());
        assert_eq!(fs::read_dir(&directory).expect("read directory").count(), 0);

        let raced_same = directory.join("raced-same.md");
        let same = atomic_create_new_markdown_with(&raced_same, b"complete", |_temp, target| {
            fs::write(target, b"complete")?;
            Err(io::Error::new(ErrorKind::AlreadyExists, "injected race"))
        });
        assert_eq!(same, Ok(CreateNewMarkdownOutcome::Reused));
        assert_eq!(
            fs::read_to_string(&raced_same).expect("read raced file"),
            "complete"
        );

        let raced_different = directory.join("raced-different.md");
        let different =
            atomic_create_new_markdown_with(&raced_different, b"complete", |_temp, target| {
                fs::write(target, b"different")?;
                Err(io::Error::new(ErrorKind::AlreadyExists, "injected race"))
            });
        assert_eq!(different, Err("CANDIDATE_IDEMPOTENCY_CONFLICT"));
        assert_eq!(
            fs::read_to_string(&raced_different).expect("read raced conflict"),
            "different"
        );

        let too_large =
            atomic_create_new_markdown(&file, &vec![b'x'; MAX_MARKDOWN_FILE_BYTES as usize + 1]);
        assert_eq!(too_large, Err("CANDIDATE_FILE_CREATE_FAILED"));
        assert!(!file.exists());
        fs::remove_dir_all(&root).expect("cleanup root");
    }

    #[test]
    fn candidate_rejects_symlink_escape_when_supported() {
        let root = test_root("candidate-symlink");
        let outside = test_root("candidate-symlink-outside");
        let default_folder = root.join("projects/item");
        fs::create_dir_all(&default_folder).expect("create default folder");
        fs::create_dir_all(&outside).expect("create outside");
        let drafts = default_folder.join("drafts");
        #[cfg(unix)]
        let link_result = std::os::unix::fs::symlink(&outside, &drafts);
        #[cfg(windows)]
        let link_result = std::os::windows::fs::symlink_dir(&outside, &drafts);
        if link_result.is_ok() {
            let directory = drafts.join("2026-07/13");
            let file = directory.join("2026-07-13_candidate_abcd_symlink.md");
            let result = create_managed_candidate_markdown_impl(
                &root,
                &default_folder,
                &directory,
                &file,
                "no escape",
            );
            assert_eq!(
                result.error_code.as_deref(),
                Some("CANDIDATE_PATH_OUTSIDE_ROOT")
            );
            assert!(!outside
                .join("2026-07/13/2026-07-13_candidate_abcd_symlink.md")
                .exists());
        }
        fs::remove_dir_all(&root).expect("cleanup root");
        fs::remove_dir_all(&outside).expect("cleanup outside");
    }

    #[test]
    fn markdown_save_dialog_canonicalizes_existing_directory_and_rejects_invalid_input() {
        let root = test_root("markdown-save-dialog-directory");
        let nested = root.join("Unicode 空格");
        fs::create_dir_all(&nested).expect("create dialog directory");
        fs::write(root.join("file.md"), "not a directory").expect("write file path");
        let prepared = prepare_markdown_save_dialog_directory(
            nested.to_string_lossy().as_ref(),
        )
        .expect("prepare existing absolute directory");
        assert_eq!(
            prepared,
            fs::canonicalize(&nested).expect("canonical dialog directory")
        );
        assert!(prepare_markdown_save_dialog_directory("relative/path").is_err());
        assert!(prepare_markdown_save_dialog_directory(
            root.join("missing").to_string_lossy().as_ref()
        )
        .is_err());
        assert!(prepare_markdown_save_dialog_directory(
            root.join("file.md").to_string_lossy().as_ref()
        )
        .is_err());
        fs::remove_dir_all(&root).expect("cleanup dialog directory");
    }

    #[test]
    fn markdown_save_dialog_filename_and_single_flight_are_strict() {
        assert!(valid_markdown_save_dialog_filename("Unicode 副本.md"));
        assert!(valid_markdown_save_dialog_filename("notes.markdown"));
        for invalid in [
            "",
            "relative/path.md",
            r"relative\path.md",
            "notes.txt",
            "CON.md",
            "LPT9.markdown",
            "trailing .md ",
        ] {
            assert!(
                !valid_markdown_save_dialog_filename(invalid),
                "invalid filename accepted: {invalid}"
            );
        }

        let first = acquire_markdown_save_dialog_request("request-1")
            .expect("acquire first dialog request");
        assert!(acquire_markdown_save_dialog_request("request-1").is_err());
        assert!(acquire_markdown_save_dialog_request("request-2").is_err());
        drop(first);
        let second = acquire_markdown_save_dialog_request("request-2")
            .expect("request gate released after terminal result");
        drop(second);
    }
}
