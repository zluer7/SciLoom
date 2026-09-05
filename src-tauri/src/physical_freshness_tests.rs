use crate::manuscript_provisioning_contract::{
    AdapterOutcome, EffectCompletionKind, PartialEffectReadback, TypedReadback,
};
use crate::physical_freshness::{
    normalize_windows_identity_for_test, test_mutate, ExpectedTargetState, PhysicalFreshVerifier,
    PhysicalResourceKind, PhysicalVerificationRequest, TestMutationFault,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};
use std::thread;
use uuid::Uuid;

struct TempRoot {
    path: PathBuf,
}

impl TempRoot {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!("labpod-pr2-{label}-{}", Uuid::new_v4()));
        fs::create_dir(&path).expect("create isolated PR2 root");
        Self { path }
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        if self.path.exists() {
            fs::remove_dir_all(&self.path).expect("clean isolated PR2 root");
        }
    }
}

fn request(
    root: &Path,
    target: &Path,
    kind: PhysicalResourceKind,
    expected: ExpectedTargetState,
) -> PhysicalVerificationRequest {
    PhysicalVerificationRequest {
        resource_role: "primary".to_string(),
        owner_type: "Review".to_string(),
        owner_id: "review-pr2".to_string(),
        channel: "primary".to_string(),
        scope: "manuscript".to_string(),
        managed_root: root.to_path_buf(),
        requested_path: target.to_path_buf(),
        expected_kind: kind,
        expected_target_state: expected,
        allow_existing_reuse: true,
    }
}

#[test]
fn verifier_classifies_missing_existing_and_wrong_type_from_real_windows_metadata() {
    let root = TempRoot::new("verifier");
    let missing_directory = root.path.join("missing-directory");
    let directory_condition = PhysicalFreshVerifier::verify(request(
        &root.path,
        &missing_directory,
        PhysicalResourceKind::Directory,
        ExpectedTargetState::Missing,
    ))
    .expect("missing directory is a valid fresh condition");
    assert_eq!(directory_condition.observed_state_for_test(), "missing");

    let markdown = root.path.join("existing.md");
    fs::write(&markdown, b"existing user body").expect("write isolated markdown");
    let file_condition = PhysicalFreshVerifier::verify(request(
        &root.path,
        &markdown,
        PhysicalResourceKind::MarkdownFile,
        ExpectedTargetState::ExistingExact,
    ))
    .expect("existing markdown is exact");
    assert_eq!(file_condition.observed_state_for_test(), "existing-exact");

    let wrong_type = PhysicalFreshVerifier::verify(request(
        &root.path,
        &markdown,
        PhysicalResourceKind::Directory,
        ExpectedTargetState::Missing,
    ))
    .expect_err("file cannot satisfy a directory condition");
    assert_eq!(wrong_type.code.as_str(), "wrong-type");
}

#[test]
fn verifier_fails_closed_for_escape_and_reparse_and_records_windows_identity() {
    let root = TempRoot::new("identity");
    let outside = TempRoot::new("outside");
    let escaped = PhysicalFreshVerifier::verify(request(
        &root.path,
        &outside.path.join("escaped.md"),
        PhysicalResourceKind::MarkdownFile,
        ExpectedTargetState::Missing,
    ))
    .expect_err("outside target is blocked");
    assert_eq!(escaped.code.as_str(), "containment-blocked");

    let identity =
        PhysicalFreshVerifier::inspect_identity_for_test(&root.path).expect("opened root identity");
    #[cfg(target_os = "windows")]
    {
        assert!(identity.volume_serial != 0);
        assert!(identity.file_id != 0);
        assert!(!identity.final_path.is_empty());
        assert_eq!(identity.reparse_tag, 0);
    }
    assert_eq!(identity.stable_hash().len(), 64);
}

#[test]
fn directory_mutation_is_no_clobber_and_reports_complete_or_partial_effect() {
    let root = TempRoot::new("directory");
    let target = root.path.join("a").join("b");
    let condition = PhysicalFreshVerifier::verify(request(
        &root.path,
        &target,
        PhysicalResourceKind::Directory,
        ExpectedTargetState::Missing,
    ))
    .expect("fresh directory condition");
    let complete = test_mutate(
        condition,
        request(
            &root.path,
            &target,
            PhysicalResourceKind::Directory,
            ExpectedTargetState::Missing,
        ),
        b"",
        TestMutationFault::None,
    );
    assert!(matches!(
        complete,
        AdapterOutcome::Applied(ref receipt)
            if receipt.completion == EffectCompletionKind::CompleteEffect
    ));
    assert!(target.is_dir());

    let partial_target = root.path.join("partial").join("never");
    let partial_condition = PhysicalFreshVerifier::verify(request(
        &root.path,
        &partial_target,
        PhysicalResourceKind::Directory,
        ExpectedTargetState::Missing,
    ))
    .expect("fresh partial condition");
    let partial = test_mutate(
        partial_condition,
        request(
            &root.path,
            &partial_target,
            PhysicalResourceKind::Directory,
            ExpectedTargetState::Missing,
        ),
        b"",
        TestMutationFault::AfterFirstDirectoryComponent,
    );
    assert!(matches!(
        partial,
        AdapterOutcome::Applied(ref receipt)
            if receipt.completion == EffectCompletionKind::PartialEffect
    ));
    assert!(root.path.join("partial").is_dir());
    assert!(!partial_target.exists());
}

#[test]
fn markdown_create_new_never_overwrites_and_exactly_reads_back_initial_bytes() {
    let root = TempRoot::new("markdown");
    let target = root.path.join("primary.md");
    let initial = b"# Initial\r\n";
    let condition = PhysicalFreshVerifier::verify(request(
        &root.path,
        &target,
        PhysicalResourceKind::MarkdownFile,
        ExpectedTargetState::Missing,
    ))
    .expect("fresh markdown condition");
    let outcome = test_mutate(
        condition,
        request(
            &root.path,
            &target,
            PhysicalResourceKind::MarkdownFile,
            ExpectedTargetState::Missing,
        ),
        initial,
        TestMutationFault::None,
    );
    assert!(matches!(
        outcome,
        AdapterOutcome::Applied(ref receipt)
            if receipt.completion == EffectCompletionKind::CompleteEffect
                && receipt.byte_length == Some(initial.len() as u64)
    ));
    assert_eq!(fs::read(&target).expect("read own test file"), initial);

    let existing = b"user content must remain";
    fs::write(&target, existing).expect("replace isolated fixture");
    let stale = PhysicalFreshVerifier::verify(request(
        &root.path,
        &root.path.join("other.md"),
        PhysicalResourceKind::MarkdownFile,
        ExpectedTargetState::Missing,
    ))
    .expect("condition for another target");
    let mismatch = test_mutate(
        stale,
        request(
            &root.path,
            &target,
            PhysicalResourceKind::MarkdownFile,
            ExpectedTargetState::Missing,
        ),
        b"replacement",
        TestMutationFault::None,
    );
    assert!(matches!(mismatch, AdapterOutcome::Conflict(_)));
    assert_eq!(
        fs::read(&target).expect("read preserved user file"),
        existing
    );
}

#[test]
fn mutation_point_rechecks_target_and_parent_identity_before_effect() {
    let root = TempRoot::new("toctou");
    let target = root.path.join("target.md");
    let condition = PhysicalFreshVerifier::verify(request(
        &root.path,
        &target,
        PhysicalResourceKind::MarkdownFile,
        ExpectedTargetState::Missing,
    ))
    .expect("fresh missing condition");
    fs::create_dir(&target).expect("race creates wrong-type target");
    let outcome = test_mutate(
        condition,
        request(
            &root.path,
            &target,
            PhysicalResourceKind::MarkdownFile,
            ExpectedTargetState::Missing,
        ),
        b"must not write",
        TestMutationFault::None,
    );
    assert!(matches!(outcome, AdapterOutcome::Conflict(_)));
    assert!(target.is_dir());
}

#[test]
fn concurrent_create_new_has_one_effect_and_one_fresh_reuse_without_double_write() {
    let root = TempRoot::new("concurrent");
    let target = root.path.join("race.md");
    let first = PhysicalFreshVerifier::verify(request(
        &root.path,
        &target,
        PhysicalResourceKind::MarkdownFile,
        ExpectedTargetState::Missing,
    ))
    .expect("first condition");
    let second = PhysicalFreshVerifier::verify(request(
        &root.path,
        &target,
        PhysicalResourceKind::MarkdownFile,
        ExpectedTargetState::Missing,
    ))
    .expect("second condition");
    let barrier = Arc::new(Barrier::new(3));
    let spawn = |condition, bytes: &'static [u8]| {
        let root = root.path.clone();
        let target = target.clone();
        let barrier = Arc::clone(&barrier);
        thread::spawn(move || {
            barrier.wait();
            test_mutate(
                condition,
                request(
                    &root,
                    &target,
                    PhysicalResourceKind::MarkdownFile,
                    ExpectedTargetState::Missing,
                ),
                bytes,
                TestMutationFault::None,
            )
        })
    };
    let a = spawn(first, b"alpha");
    let b = spawn(second, b"beta");
    barrier.wait();
    let outcomes = [a.join().expect("thread a"), b.join().expect("thread b")];
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, AdapterOutcome::Applied(_)))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, AdapterOutcome::Reused(_)))
            .count(),
        1
    );
    assert!(matches!(
        fs::read(&target).expect("read race winner").as_slice(),
        b"alpha" | b"beta"
    ));
}

#[test]
fn confirmed_file_partial_effect_is_applied_partial_and_never_automatically_retried() {
    let root = TempRoot::new("partial-file");
    let target = root.path.join("partial.md");
    let condition = PhysicalFreshVerifier::verify(request(
        &root.path,
        &target,
        PhysicalResourceKind::MarkdownFile,
        ExpectedTargetState::Missing,
    ))
    .expect("fresh file condition");
    let outcome = test_mutate(
        condition,
        request(
            &root.path,
            &target,
            PhysicalResourceKind::MarkdownFile,
            ExpectedTargetState::Missing,
        ),
        b"partial bytes",
        TestMutationFault::AfterFileCreate,
    );
    assert!(matches!(
        outcome,
        AdapterOutcome::Applied(ref receipt)
            if receipt.completion == EffectCompletionKind::PartialEffect
    ));
    assert!(target.exists());
}

#[test]
fn typed_readback_has_a_distinct_partial_state() {
    let partial = TypedReadback::Partial(
        PartialEffectReadback::new_verified("a".repeat(64), 3).expect("valid partial readback"),
    );
    assert!(matches!(partial, TypedReadback::Partial(_)));
}

#[test]
fn parent_replacement_and_generation_stale_are_zero_effect() {
    let root = TempRoot::new("parent-replacement");
    let parent = root.path.join("parent");
    fs::create_dir(&parent).expect("create inspected parent");
    let target = parent.join("target.md");
    let condition = PhysicalFreshVerifier::verify(request(
        &root.path,
        &target,
        PhysicalResourceKind::MarkdownFile,
        ExpectedTargetState::Missing,
    ))
    .expect("fresh parent condition");
    fs::rename(&parent, root.path.join("old-parent")).expect("replace isolated parent");
    fs::create_dir(&parent).expect("create replacement parent");
    let outcome = test_mutate(
        condition,
        request(
            &root.path,
            &target,
            PhysicalResourceKind::MarkdownFile,
            ExpectedTargetState::Missing,
        ),
        b"must not write",
        TestMutationFault::None,
    );
    assert!(matches!(outcome, AdapterOutcome::Conflict(_)));
    assert!(!target.exists());

    let stale_target = root.path.join("stale.md");
    let stale = PhysicalFreshVerifier::verify(request(
        &root.path,
        &stale_target,
        PhysicalResourceKind::MarkdownFile,
        ExpectedTargetState::Missing,
    ))
    .expect("fresh condition")
    .with_stale_generation_for_test();
    let stale_outcome = test_mutate(
        stale,
        request(
            &root.path,
            &stale_target,
            PhysicalResourceKind::MarkdownFile,
            ExpectedTargetState::Missing,
        ),
        b"must not write",
        TestMutationFault::None,
    );
    assert!(matches!(stale_outcome, AdapterOutcome::Conflict(_)));
    assert!(!stale_target.exists());
}

#[test]
fn readback_is_bounded_and_post_effect_unavailability_is_indeterminate() {
    assert_eq!(
        PhysicalFreshVerifier::readback_bounds_for_test(),
        (3, 2_000)
    );
    let root = TempRoot::new("bounded-readback");
    let target = root.path.join("readback.md");
    let condition = PhysicalFreshVerifier::verify(request(
        &root.path,
        &target,
        PhysicalResourceKind::MarkdownFile,
        ExpectedTargetState::Missing,
    ))
    .expect("fresh file condition");
    let outcome = test_mutate(
        condition,
        request(
            &root.path,
            &target,
            PhysicalResourceKind::MarkdownFile,
            ExpectedTargetState::Missing,
        ),
        b"effect exists",
        TestMutationFault::ReadbackUnavailable,
    );
    assert!(matches!(outcome, AdapterOutcome::Indeterminate(_)));
    assert_eq!(
        fs::read(&target).expect("effect is not retried or removed"),
        b"effect exists"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn junction_inside_managed_root_is_rejected_even_when_its_target_exists() {
    use std::process::Command;

    let root = TempRoot::new("junction-root");
    let outside = TempRoot::new("junction-target");
    let junction = root.path.join("junction");
    let status = Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            &junction.to_string_lossy(),
            &outside.path.to_string_lossy(),
        ])
        .status()
        .expect("run isolated junction fixture command");
    assert!(status.success(), "create isolated directory junction");
    let junction_identity = PhysicalFreshVerifier::inspect_identity_for_test(&junction)
        .expect("open junction itself without following it");
    assert_ne!(junction_identity.reparse_tag, 0);
    let blocked = PhysicalFreshVerifier::verify(request(
        &root.path,
        &junction.join("target.md"),
        PhysicalResourceKind::MarkdownFile,
        ExpectedTargetState::Missing,
    ))
    .expect_err("junction ancestry must fail closed");
    assert_eq!(blocked.code.as_str(), "reparse-blocked");
    fs::remove_dir(&junction).expect("remove only the isolated junction");
}

#[cfg(target_os = "windows")]
#[test]
fn windows_case_insensitive_create_race_is_no_clobber() {
    let root = TempRoot::new("case-collision");
    let requested = root.path.join("Primary.md");
    let condition = PhysicalFreshVerifier::verify(request(
        &root.path,
        &requested,
        PhysicalResourceKind::MarkdownFile,
        ExpectedTargetState::Missing,
    ))
    .expect("fresh case condition");
    let colliding = root.path.join("primary.md");
    fs::write(&colliding, b"other creator").expect("create case-colliding fixture");
    let outcome = test_mutate(
        condition,
        request(
            &root.path,
            &requested,
            PhysicalResourceKind::MarkdownFile,
            ExpectedTargetState::Missing,
        ),
        b"must not overwrite",
        TestMutationFault::None,
    );
    assert!(matches!(outcome, AdapterOutcome::Reused(_)));
    assert_eq!(
        fs::read(&colliding).expect("read preserved collision"),
        b"other creator"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn windows_directory_symlink_is_fail_closed_when_the_platform_can_create_it() {
    use std::os::windows::fs::symlink_dir;

    let root = TempRoot::new("symlink-root");
    let outside = TempRoot::new("symlink-target");
    let link = root.path.join("link");
    if let Err(error) = symlink_dir(&outside.path, &link) {
        assert!(
            error.kind() == std::io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(1314),
            "only an unavailable Windows symlink privilege may gate this fixture: {error}"
        );
        return;
    }
    let identity = PhysicalFreshVerifier::inspect_identity_for_test(&link)
        .expect("open symlink itself without following it");
    assert_ne!(identity.reparse_tag, 0);
    let blocked = PhysicalFreshVerifier::verify(request(
        &root.path,
        &link.join("target.md"),
        PhysicalResourceKind::MarkdownFile,
        ExpectedTargetState::Missing,
    ))
    .expect_err("symlink ancestry must fail closed");
    assert_eq!(blocked.code.as_str(), "reparse-blocked");
    fs::remove_dir(&link).expect("remove only the isolated symlink");
}

#[cfg(target_os = "windows")]
#[test]
fn windows_separator_and_drive_boundaries_are_normalized_without_escape() {
    let root = TempRoot::new("windows-boundaries");
    let slash_target = PathBuf::from(
        root.path
            .join("folder")
            .to_string_lossy()
            .replace('\\', "/"),
    );
    let condition = PhysicalFreshVerifier::verify(request(
        &root.path,
        &slash_target,
        PhysicalResourceKind::Directory,
        ExpectedTargetState::Missing,
    ))
    .expect("forward separators preserve the same Windows placement");
    assert_eq!(condition.observed_state_for_test(), "missing");

    let different_drive = PathBuf::from(r"N:\labpod-pr2-no-access\target.md");
    if root.path.components().next() != different_drive.components().next() {
        let blocked = PhysicalFreshVerifier::verify(request(
            &root.path,
            &different_drive,
            PhysicalResourceKind::MarkdownFile,
            ExpectedTargetState::Missing,
        ))
        .expect_err("different drive is outside the opened managed root");
        assert_eq!(blocked.code.as_str(), "containment-blocked");
    }
}

#[cfg(target_os = "windows")]
#[test]
fn windows_unc_and_verbatim_device_prefixes_normalize_to_one_identity() {
    assert_eq!(
        normalize_windows_identity_for_test(r"\\?\UNC\Server\Share\Folder\File.md"),
        r"\\server\share\folder\file.md",
    );
    assert_eq!(
        normalize_windows_identity_for_test(r"\\Server\Share/Folder/File.md"),
        r"\\server\share\folder\file.md",
    );
    assert_eq!(
        normalize_windows_identity_for_test(r"\\?\C:\Managed\Folder"),
        r"c:\managed\folder",
    );
}

#[test]
fn parent_replacement_after_effect_is_detected_before_success_readback() {
    let root = TempRoot::new("post-effect-parent-race");
    let parent = root.path.join("parent");
    fs::create_dir(&parent).expect("create parent");
    let target = parent.join("target.md");
    let request_value = request(
        &root.path,
        &target,
        PhysicalResourceKind::MarkdownFile,
        ExpectedTargetState::Missing,
    );
    let condition = PhysicalFreshVerifier::verify(request_value.clone()).expect("fresh condition");
    let reached = Arc::new(Barrier::new(2));
    let resume = Arc::new(Barrier::new(2));
    let mutation_reached = Arc::clone(&reached);
    let mutation_resume = Arc::clone(&resume);
    let worker = thread::spawn(move || {
        test_mutate(
            condition,
            request_value,
            b"same bytes",
            TestMutationFault::PauseBeforeReadback {
                reached: mutation_reached,
                resume: mutation_resume,
            },
        )
    });
    reached.wait();
    let displaced = root.path.join("displaced-parent");
    fs::rename(&parent, &displaced).expect("replace parent after effect");
    fs::create_dir(&parent).expect("create replacement parent");
    fs::write(&target, b"same bytes").expect("create deceptive replacement target");
    resume.wait();
    let outcome = worker.join().expect("join mutation worker");
    assert!(matches!(outcome, AdapterOutcome::Indeterminate(_)));
    assert_eq!(
        fs::read(displaced.join("target.md")).expect("original effect remains"),
        b"same bytes"
    );
}
