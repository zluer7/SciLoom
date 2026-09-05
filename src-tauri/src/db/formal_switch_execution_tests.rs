use super::formal_switch_execution::*;
use super::formal_switch_foundation::encoding::{
    sha256, CandidateIdentityV1, FormalSwitchEntryKind, FormalSwitchImmutableEnvelopeV1,
    FormalSwitchManuscriptChannel, FormalSwitchOwnerType, ReplacementItemV1, SettlementPlanV1,
};
use super::formal_switch_foundation::read_unresolved_operation_summaries;
use super::schema;
use crate::markdown_file::{
    manuscript_physical_revision, read_explicit_physical_facts_with_limit, MAX_MARKDOWN_FILE_BYTES,
};
use crate::provisioning::path_for_result;
use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

fn unique_root(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "labpod-f2-1-{label}-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&root).expect("create fixture root");
    root
}

fn normalized_path_identity(path: &Path) -> String {
    let canonical = fs::canonicalize(path).expect("canonical fixture path");
    let mut value = path_for_result(&canonical).replace('\\', "/");
    while value.contains("//") && !value.starts_with("//") {
        value = value.replace("//", "/");
    }
    if cfg!(windows) || value.starts_with("//") {
        value = value.to_lowercase();
    }
    value
}

#[derive(Clone)]
struct FileSnapshot {
    bytes: Vec<u8>,
    revision: String,
    sha256: [u8; 32],
}

fn file_snapshot(path: &Path) -> FileSnapshot {
    let canonical = fs::canonicalize(path).expect("canonical file");
    let (bytes, metadata, physical_identity) =
        read_explicit_physical_facts_with_limit(&canonical, MAX_MARKDOWN_FILE_BYTES)
            .expect("read physical facts");
    let path_identity = normalized_path_identity(&canonical);
    let revision =
        manuscript_physical_revision(&path_identity, &physical_identity, &metadata, &bytes)
            .expect("physical revision");
    FileSnapshot {
        sha256: sha256(&bytes),
        bytes,
        revision,
    }
}

#[derive(Clone)]
struct SealedOwnerApplierV1;

impl FormalSwitchOwnerApplierV1 for SealedOwnerApplierV1 {
    fn read_owner_state(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<OwnerProtectedStateV1, String> {
        connection
            .query_row(
                "SELECT project_id,summary,details,context_input,untouched FROM sealed_formal_switch_owner WHERE id=?1",
                [&envelope.owner_id],
                |row| {
                    let context: String = row.get(3)?;
                    let untouched: String = row.get(4)?;
                    Ok(OwnerProtectedStateV1 {
                        project_id: row.get(0)?,
                        parent_identity: None,
                        review_type: None,
                        context_summary_input_digest: sha256(context.as_bytes()),
                        protected_fields: vec![
                            ProtectedFieldV1 {
                                stable_key: "summary".into(),
                                value: row.get(1)?,
                            },
                            ProtectedFieldV1 {
                                stable_key: "details".into(),
                                value: row.get(2)?,
                            },
                        ],
                        unowned_state_digest: sha256(untouched.as_bytes()),
                    })
                },
            )
            .map_err(|error| error.to_string())
    }

    fn read_owner_lifecycle(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<OwnerLifecycleV1, String> {
        connection
            .query_row(
                "SELECT deleted_at FROM sealed_formal_switch_owner WHERE id=?1",
                [&envelope.owner_id],
                |row| {
                    Ok(OwnerLifecycleV1 {
                        owner_deleted_at: row.get(0)?,
                        parent_chain: Vec::new(),
                    })
                },
            )
            .map_err(|error| error.to_string())
    }

    fn apply_owned_fields(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<(), String> {
        let summary = envelope
            .replacement_dto
            .iter()
            .find(|item| item.stable_key == "summary")
            .ok_or("SEALED_SUMMARY_MISSING")?
            .value
            .clone();
        let details = envelope
            .replacement_dto
            .iter()
            .find(|item| item.stable_key == "details")
            .ok_or("SEALED_DETAILS_MISSING")?
            .value
            .clone();
        let changed = connection
            .execute(
                "UPDATE sealed_formal_switch_owner SET summary=?1,details=?2 WHERE id=?3 AND deleted_at IS NULL",
                params![summary, details, envelope.owner_id],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err("SEALED_OWNER_CAS_TARGET_MISSING".into());
        }
        Ok(())
    }
}

struct Fixture {
    root: PathBuf,
    db_path: PathBuf,
    old_path: PathBuf,
    target_path: PathBuf,
    default_path: PathBuf,
    envelope: FormalSwitchImmutableEnvelopeV1,
    confirmation: FormalSwitchFinalConfirmationEvidenceV1,
    snapshot: FinalRevalidationSnapshotV1,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn open_current(path: &Path) -> Connection {
    let connection = Connection::open(path).expect("open fixture database");
    connection
        .busy_timeout(std::time::Duration::from_secs(10))
        .expect("busy timeout");
    connection
        .execute_batch("PRAGMA foreign_keys=ON;")
        .expect("foreign keys");
    connection
}

fn fixture(label: &str) -> Fixture {
    let root = unique_root(label);
    let db_path = root.join("state.sqlite3");
    let old_path = root.join("old.md");
    let target_path = root.join("target.md");
    let default_path = root.join("default.md");
    fs::write(&old_path, b"# Old\ncontrolled body\n").expect("old manuscript");
    fs::write(&target_path, b"# Candidate\nnew body\n").expect("target manuscript");
    fs::write(&default_path, b"# Default\n").expect("default manuscript");

    let connection = open_current(&db_path);
    schema::run_migrations(&connection).expect("current schema");
    connection
        .execute_batch(
            "CREATE TABLE sealed_formal_switch_owner(
               id TEXT PRIMARY KEY,
               project_id TEXT,
               summary TEXT,
               details TEXT,
               context_input TEXT NOT NULL,
               untouched TEXT NOT NULL,
               deleted_at TEXT
             );
             INSERT INTO sealed_formal_switch_owner
               (id,project_id,summary,details,context_input,untouched)
             VALUES('sealed-owner','project-1','old summary','old details','context-v1','preserve-me');",
        )
        .expect("sealed owner table");
    for (id, path) in [
        ("file-old", &old_path),
        ("file-target", &target_path),
        ("file-default", &default_path),
    ] {
        connection
            .execute(
                "INSERT INTO file_refs(id,owner_type,owner_id,resource_kind,file_role,location_mode,file_type,path,path_identity_key,title,created_at,updated_at) VALUES(?1,'experiment','sealed-owner','file','manuscript','external','markdown',?2,?3,?1,'2026-08-10','2026-08-10')",
                params![id, path.to_string_lossy(), normalized_path_identity(path)],
            )
            .expect("file ref");
    }
    connection
        .execute(
            "INSERT INTO manuscript_bindings(id,owner_type,owner_id,manuscript_channel,default_manuscript_file_ref_id,current_file_ref_id,schema_version,created_at,updated_at) VALUES('binding-1','experiment','sealed-owner','primary','file-default','file-old',2,'2026-08-10','2026-08-10')",
            [],
        )
        .expect("binding");

    let old = file_snapshot(&old_path);
    let target = file_snapshot(&target_path);
    let byte_start = 2usize;
    let byte_end = 5usize;
    let replacement = b"Retired".to_vec();
    let mut post = old.bytes.clone();
    post.splice(byte_start..byte_end, replacement.iter().copied());
    let operation_id = format!("f2-1-{label}");
    let mut envelope = FormalSwitchImmutableEnvelopeV1 {
        operation_id: operation_id.clone(),
        payload_version: 1,
        canonical_encoding_version: "CanonicalEnvelopeEncodingV1".into(),
        engine_contract_version: 1,
        descriptor_identity: "sealed-test/primary/v1".into(),
        descriptor_version: 1,
        descriptor_hash: sha256(b"sealed-test/primary/v1"),
        candidate_contract_version: 1,
        settlement_plan_version: 1,
        transaction_payload_version: 1,
        recovery_payload_version: 1,
        owner_type: FormalSwitchOwnerType::Experiment,
        owner_id: "sealed-owner".into(),
        manuscript_channel: FormalSwitchManuscriptChannel::Primary,
        entry_kind: FormalSwitchEntryKind::UserConfirmedSwitch,
        owner_subtype: None,
        old_current_file_ref_identity: "file-old".into(),
        default_file_ref_identity: "file-default".into(),
        target_file_ref_identity: "file-target".into(),
        old_current_logical_session_identity: "sealed-owner:old".into(),
        target_logical_session_identity: "sealed-owner:target".into(),
        candidate: CandidateIdentityV1 {
            file_ref_identity: "file-target".into(),
            physical_revision: target.revision.clone(),
            sha256: target.sha256,
            byte_length: target.bytes.len() as u64,
            encoding: "UTF-8".into(),
        },
        replacement_dto: vec![
            ReplacementItemV1 {
                stable_key: "summary".into(),
                value: Some("new summary".into()),
            },
            ReplacementItemV1 {
                stable_key: "details".into(),
                value: Some("new details".into()),
            },
        ],
        owner_protected_row_digest: [0; 32],
        binding_digest: [0; 32],
        lifecycle_coverage_digest: [0; 32],
        old_current_expected_physical_revision: old.revision.clone(),
        settlement_plan: SettlementPlanV1 {
            byte_start: byte_start as u64,
            byte_end: byte_end as u64,
            expected_whole_file_hash: old.sha256,
            expected_controlled_region_preimage_hash: sha256(&old.bytes[byte_start..byte_end]),
            replacement_bytes: replacement,
            expected_whole_file_post_hash: sha256(&post),
            bom_state: "ABSENT".into(),
            line_ending_policy: "PRESERVE_SNAPSHOT_EXACT".into(),
            boundary_newline_ownership: "NONE".into(),
            write_once_operation_id: operation_id.clone(),
        },
        transaction_payload: Vec::new(),
        success_operation_log_id: format!("formal-switch-success-{label}"),
        formal_switch_operation_id: operation_id.clone(),
        activation_logical_identity: "sealed-owner:primary:current".into(),
        finalization_identity: String::new(),
        operation_custody_identity: String::new(),
        created_at_epoch_ms: 1,
    };
    let binding = BindingStateV1 {
        binding_id: "binding-1".into(),
        owner_type: "experiment".into(),
        owner_id: "sealed-owner".into(),
        manuscript_channel: "primary".into(),
        current_file_ref_id: Some("file-old".into()),
        default_manuscript_file_ref_id: Some("file-default".into()),
        default_folder_file_ref_id: None,
        schema_version: 2,
        created_at: "2026-08-10".into(),
        updated_at: "2026-08-10".into(),
        deleted_at: None,
    };
    let applier = SealedOwnerApplierV1;
    let lifecycle = applier
        .read_owner_lifecycle(&connection, &envelope)
        .expect("lifecycle");
    let owner = applier
        .read_owner_state(&connection, &envelope)
        .expect("owner state");
    envelope.lifecycle_coverage_digest =
        lifecycle_coverage_digest(&envelope, &lifecycle, &binding).expect("lifecycle digest");
    envelope.binding_digest = binding_digest(&binding).expect("binding digest");
    envelope.owner_protected_row_digest =
        owner_protected_row_digest(&envelope, &owner, envelope.lifecycle_coverage_digest)
            .expect("owner digest");
    envelope.transaction_payload =
        canonical_transaction_payload_bytes(&envelope).expect("transaction payload");
    envelope.finalization_identity =
        derive_finalization_identity(&envelope).expect("finalization identity");
    let confirmation = freeze_confirmation_identity(FormalSwitchFinalConfirmationEvidenceV1 {
        evidence_identity: String::new(),
        operation_id: operation_id.clone(),
        owner_type: "experiment".into(),
        owner_id: "sealed-owner".into(),
        manuscript_channel: "primary".into(),
        entry_kind: "USER_CONFIRMED_SWITCH".into(),
        old_current_file_ref_identity: "file-old".into(),
        target_file_ref_identity: "file-target".into(),
        candidate_file_ref_identity: "file-target".into(),
        candidate_physical_revision: target.revision.clone(),
        candidate_sha256: target.sha256,
        candidate_byte_length: target.bytes.len() as u64,
        replacement_dto_sha256: replacement_dto_sha256(&envelope.replacement_dto)
            .expect("replacement hash"),
        descriptor_identity: envelope.descriptor_identity.clone(),
        descriptor_version: envelope.descriptor_version,
        descriptor_sha256: envelope.descriptor_hash,
        preview_snapshot_identity: format!("preview-{label}"),
    })
    .expect("confirmation identity");
    envelope.operation_custody_identity = confirmation.evidence_identity.clone();
    let envelope_hash = sha256(
        &super::formal_switch_foundation::encoding::encode_envelope(&envelope)
            .expect("envelope encoding"),
    );
    let snapshot = FinalRevalidationSnapshotV1 {
        envelope_sha256: envelope_hash,
        confirmation_evidence_identity: confirmation.evidence_identity.clone(),
        target_file_ref_identity: "file-target".into(),
        target_physical_revision: target.revision,
        target_sha256: target.sha256,
        target_byte_length: target.bytes.len() as u64,
        old_current_file_ref_identity: "file-old".into(),
        old_current_physical_revision: old.revision,
        old_current_sha256: old.sha256,
        owner_digest: envelope.owner_protected_row_digest,
        binding_digest: envelope.binding_digest,
        lifecycle_digest: envelope.lifecycle_coverage_digest,
        descriptor_identity: envelope.descriptor_identity.clone(),
        descriptor_version: envelope.descriptor_version,
        descriptor_sha256: envelope.descriptor_hash,
        current_mounted_runtime: None,
        target_mounted_runtime: None,
        target_zero_write_verified: true,
    };
    drop(connection);
    Fixture {
        root,
        db_path,
        old_path,
        target_path,
        default_path,
        envelope,
        confirmation,
        snapshot,
    }
}

#[derive(Clone)]
struct StaticRevalidationPort(FinalRevalidationSnapshotV1);

impl FinalRevalidationPortV1 for StaticRevalidationPort {
    fn fresh_revalidate(
        &self,
        _envelope: &FormalSwitchImmutableEnvelopeV1,
        _envelope_sha256: [u8; 32],
    ) -> Result<FinalRevalidationSnapshotV1, String> {
        Ok(self.0.clone())
    }
}

fn resolved_old_file(fixture: &Fixture) -> ResolvedOldCurrentFileV1 {
    ResolvedOldCurrentFileV1 {
        file_ref_identity: "file-old".into(),
        file_path: fixture.old_path.to_string_lossy().into_owned(),
        path_identity: normalized_path_identity(&fixture.old_path),
        file_name: "old.md".into(),
        location_mode: "external".into(),
        configured_root: None,
    }
}

fn prepare_exact(connection: &Connection, fixture: &Fixture) -> PreparedExactOperationV1 {
    revalidate_and_prepare_exact(
        connection,
        &fixture.envelope,
        &fixture.confirmation,
        None,
        None,
        &StaticRevalidationPort(fixture.snapshot.clone()),
    )
    .expect("same-envelope revalidation and prepare")
}

fn prepare_db_pending(
    connection: &Connection,
    fixture: &Fixture,
) -> super::formal_switch_foundation::ExecutableFormalSwitchOperationV1 {
    let prepared = prepare_exact(connection, fixture);
    let recovery = CanonicalFormalSwitchRecoveryCoordinatorV1;
    let settlement_complete = recovery
        .complete_without_settlement(connection, &prepared.executable, 2)
        .expect("not-required settlement");
    recovery
        .begin_db(connection, &settlement_complete, 3)
        .expect("db pending")
}

struct FakeRuntime {
    active: Mutex<bool>,
    apply_count: AtomicUsize,
    fail_read: AtomicBool,
    fail_after_apply: AtomicBool,
    generation: u64,
}

impl FakeRuntime {
    fn new(active: bool, generation: u64) -> Self {
        Self {
            active: Mutex::new(active),
            apply_count: AtomicUsize::new(0),
            fail_read: AtomicBool::new(false),
            fail_after_apply: AtomicBool::new(false),
            generation,
        }
    }

    fn snapshot(
        &self,
        finalization: &CanonicalFormalSwitchFinalizationResultV1,
    ) -> RuntimeActivationSnapshotV1 {
        RuntimeActivationSnapshotV1 {
            actual_runtime_handle: format!("runtime-{}", self.generation),
            runtime_generation: self.generation,
            runtime_consumer_id: "sealed-runtime".into(),
            logical_identity: finalization.activation_logical_identity.clone(),
            file_ref_identity: finalization.target_file_ref_identity.clone(),
            exact_active: *self.active.lock().expect("runtime state"),
        }
    }
}

impl CanonicalRuntimeReacquisitionPortV1 for FakeRuntime {
    fn fresh_reacquire(
        &self,
        finalization: &CanonicalFormalSwitchFinalizationResultV1,
    ) -> Result<RuntimeActivationSnapshotV1, String> {
        Ok(self.snapshot(finalization))
    }

    fn read_actual_state(
        &self,
        snapshot: &RuntimeActivationSnapshotV1,
    ) -> Result<RuntimeActivationSnapshotV1, String> {
        if self.fail_read.load(Ordering::SeqCst) {
            return Err("SEALED_RUNTIME_READ_UNKNOWN".into());
        }
        let mut current = snapshot.clone();
        current.exact_active = *self.active.lock().expect("runtime state");
        Ok(current)
    }

    fn activate_idempotently(
        &self,
        _snapshot: &RuntimeActivationSnapshotV1,
        _finalization: &CanonicalFormalSwitchFinalizationResultV1,
    ) -> Result<(), String> {
        let mut active = self.active.lock().expect("runtime state");
        if !*active {
            self.apply_count.fetch_add(1, Ordering::SeqCst);
            *active = true;
        }
        if self.fail_after_apply.load(Ordering::SeqCst) {
            Err("SEALED_RUNTIME_TRANSPORT_UNKNOWN".into())
        } else {
            Ok(())
        }
    }
}

#[test]
fn f2_1_confirmation_revalidation_and_target_zero_write_are_exact() {
    let fixture = fixture("confirmation");
    let target_before = fs::read(&fixture.target_path).expect("target before");
    let connection = open_current(&fixture.db_path);
    let prepared = prepare_exact(&connection, &fixture);
    assert_eq!(prepared.executable.envelope, fixture.envelope);
    assert_eq!(fs::read(&fixture.target_path).unwrap(), target_before);

    let mut mismatched = fixture.confirmation.clone();
    mismatched.preview_snapshot_identity.push_str("-changed");
    assert_eq!(
        validate_confirmation_binding(&fixture.envelope, &mismatched).unwrap_err(),
        "FORMAL_SWITCH_CONFIRMATION_BINDING_MISMATCH"
    );
    let mut stale = fixture.snapshot.clone();
    stale.target_zero_write_verified = false;
    assert_eq!(
        revalidate_and_prepare_exact(
            &connection,
            &fixture.envelope,
            &fixture.confirmation,
            None,
            None,
            &StaticRevalidationPort(stale),
        )
        .unwrap_err(),
        "FORMAL_SWITCH_FINAL_REVALIDATION_CONFLICT"
    );
}

#[test]
fn f2_1_settlement_atomic_cas_has_one_writer_post_retry_and_external_drift_conflict() {
    let fixture = fixture("settlement-concurrency");
    let target_before = fs::read(&fixture.target_path).expect("target before");
    let barrier = Arc::new(Barrier::new(2));
    let mut handles = Vec::new();
    for _ in 0..2 {
        let barrier = Arc::clone(&barrier);
        let envelope = fixture.envelope.clone();
        let resolved = resolved_old_file(&fixture);
        handles.push(thread::spawn(move || {
            barrier.wait();
            execute_settlement_atomic(&envelope, &resolved).expect("settlement")
        }));
    }
    let outcomes = handles
        .into_iter()
        .map(|handle| handle.join().expect("writer"))
        .collect::<Vec<_>>();
    assert_eq!(
        outcomes
            .iter()
            .filter(|value| **value == SettlementExecutionOutcomeV1::Applied)
            .count(),
        1,
        "outcomes={outcomes:?}"
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|value| **value == SettlementExecutionOutcomeV1::AlreadyApplied)
            .count(),
        1,
        "outcomes={outcomes:?}"
    );
    assert_eq!(
        classify_settlement_image(
            &fixture.envelope.settlement_plan,
            &fs::read(&fixture.old_path).unwrap()
        ),
        SettlementDurableImageV1::PostImage
    );
    assert_eq!(fs::read(&fixture.target_path).unwrap(), target_before);

    let drift = self::fixture("settlement-drift");
    fs::write(&drift.old_path, b"# externally changed\n").expect("external drift");
    let drift_bytes = fs::read(&drift.old_path).unwrap();
    assert_eq!(
        execute_settlement_atomic(&drift.envelope, &resolved_old_file(&drift)).unwrap(),
        SettlementExecutionOutcomeV1::Conflict
    );
    assert_eq!(fs::read(&drift.old_path).unwrap(), drift_bytes);
    assert_eq!(
        classify_settlement_image(&drift.envelope.settlement_plan, &drift_bytes),
        SettlementDurableImageV1::Neither
    );
}

#[test]
fn f2_1_db_transaction_is_idempotent_cas_guarded_and_transport_independently_classified() {
    let fixture = fixture("db-idempotency");
    let connection = open_current(&fixture.db_path);
    let executable = prepare_db_pending(&connection, &fixture);
    drop(connection);
    let barrier = Arc::new(Barrier::new(2));
    let mut handles = Vec::new();
    for _ in 0..2 {
        let barrier = Arc::clone(&barrier);
        let executable = executable.clone();
        let path = fixture.db_path.clone();
        handles.push(thread::spawn(move || {
            let mut connection = open_current(&path);
            barrier.wait();
            CanonicalFormalSwitchRecoveryCoordinatorV1
                .continue_db_only(
                    &mut connection,
                    &executable,
                    &CanonicalFormalSwitchTransactionCoordinatorV1,
                    &SealedOwnerApplierV1,
                    "2026-08-10T00:00:00Z",
                )
                .expect("db-only continuation")
        }));
    }
    let outcomes = handles
        .into_iter()
        .map(|handle| handle.join().expect("db caller"))
        .collect::<Vec<_>>();
    assert_eq!(
        outcomes
            .iter()
            .filter(|value| **value == CanonicalTransactionResultV1::Committed)
            .count(),
        1,
        "outcomes={outcomes:?}"
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|value| **value == CanonicalTransactionResultV1::AlreadyCommitted)
            .count(),
        1,
        "outcomes={outcomes:?}"
    );
    let connection = open_current(&fixture.db_path);
    assert_eq!(
        classify_durable_db_state(&connection, &executable, &SealedOwnerApplierV1),
        DurableDbClassificationV1::ExactCommitted
    );
    let (summary, details, untouched, current): (String, String, String, String) = connection
        .query_row(
            "SELECT o.summary,o.details,o.untouched,b.current_file_ref_id FROM sealed_formal_switch_owner o JOIN manuscript_bindings b ON b.owner_id=o.id WHERE o.id='sealed-owner'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        (summary.as_str(), details.as_str()),
        ("new summary", "new details")
    );
    assert_eq!(untouched, "preserve-me");
    assert_eq!(current, "file-target");
    let log_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM operation_logs WHERE formal_switch_operation_id=?1 AND status='success'",
            [&fixture.envelope.operation_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(log_count, 1);
}

#[test]
fn f2_1_db_cas_conflict_rolls_back_without_log_or_binding_mutation() {
    let fixture = fixture("db-cas-conflict");
    let mut connection = open_current(&fixture.db_path);
    let executable = prepare_db_pending(&connection, &fixture);
    connection
        .execute(
            "UPDATE sealed_formal_switch_owner SET summary='external drift' WHERE id='sealed-owner'",
            [],
        )
        .unwrap();
    let outcome = CanonicalFormalSwitchTransactionCoordinatorV1
        .execute(
            &mut connection,
            &executable,
            &SealedOwnerApplierV1,
            "2026-08-10T00:00:00Z",
        )
        .expect("typed CAS result");
    assert_eq!(outcome, CanonicalTransactionResultV1::CasConflict);
    let (summary, current, logs): (String, String, i64) = connection
        .query_row(
            "SELECT o.summary,b.current_file_ref_id,(SELECT COUNT(*) FROM operation_logs WHERE formal_switch_operation_id=?1) FROM sealed_formal_switch_owner o JOIN manuscript_bindings b ON b.owner_id=o.id WHERE o.id='sealed-owner'",
            [&fixture.envelope.operation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(summary, "external drift");
    assert_eq!(current, "file-old");
    assert_eq!(logs, 0);
}

#[test]
fn f2_1_local_activation_serializes_full_critical_section_and_allows_fresh_restart_convergence() {
    let fixture = fixture("activation");
    let mut connection = open_current(&fixture.db_path);
    let executable = prepare_db_pending(&connection, &fixture);
    let db_result = CanonicalFormalSwitchRecoveryCoordinatorV1
        .continue_db_only(
            &mut connection,
            &executable,
            &CanonicalFormalSwitchTransactionCoordinatorV1,
            &SealedOwnerApplierV1,
            "2026-08-10T00:00:00Z",
        )
        .unwrap();
    let finalization = derive_pre_activation_finalization(
        &executable,
        classify_durable_db_state(&connection, &executable, &SealedOwnerApplierV1),
    )
    .expect("pre-activation finalization");
    assert!(matches!(db_result, CanonicalTransactionResultV1::Committed));
    let coordinator = Arc::new(CanonicalLocalActivationCoordinatorV1::default());
    let runtime = Arc::new(FakeRuntime::new(false, 1));
    let barrier = Arc::new(Barrier::new(2));
    let mut handles = Vec::new();
    for _ in 0..2 {
        let coordinator = Arc::clone(&coordinator);
        let runtime = Arc::clone(&runtime);
        let barrier = Arc::clone(&barrier);
        let finalization = finalization.clone();
        handles.push(thread::spawn(move || {
            barrier.wait();
            coordinator.converge(&finalization, runtime.as_ref())
        }));
    }
    let outcomes = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(runtime.apply_count.load(Ordering::SeqCst), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter(|value| **value == ActivationConvergenceOutcomeV1::Applied)
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|value| **value == ActivationConvergenceOutcomeV1::AlreadyActive)
            .count(),
        1
    );
    assert_eq!(
        coordinator.converge(&finalization, runtime.as_ref()),
        ActivationConvergenceOutcomeV1::AlreadyActive
    );
    assert_eq!(runtime.apply_count.load(Ordering::SeqCst), 1);

    let fresh_process_runtime = FakeRuntime::new(false, 2);
    assert_eq!(
        CanonicalLocalActivationCoordinatorV1::default()
            .converge(&finalization, &fresh_process_runtime),
        ActivationConvergenceOutcomeV1::Applied
    );
    assert_eq!(fresh_process_runtime.apply_count.load(Ordering::SeqCst), 1);
}

#[test]
fn f2_1_sealed_end_to_end_resolves_once_and_restart_does_not_reopen_recovery() {
    let fixture = fixture("sealed-e2e");
    let target_before = fs::read(&fixture.target_path).unwrap();
    let default_before = fs::read(&fixture.default_path).unwrap();
    let mut connection = open_current(&fixture.db_path);
    let prepared = prepare_exact(&connection, &fixture);
    let engine = CanonicalFormalSwitchEngineV1::default();
    let settlement_started = engine
        .recovery
        .begin_settlement(&connection, &prepared.executable, 2)
        .unwrap();
    let settlement_outcome =
        execute_settlement_atomic(&fixture.envelope, &resolved_old_file(&fixture)).unwrap();
    assert_eq!(settlement_outcome, SettlementExecutionOutcomeV1::Applied);
    let settlement_complete = engine
        .recovery
        .complete_settlement(&connection, &settlement_started, settlement_outcome, 3)
        .unwrap();
    let db_pending = engine
        .recovery
        .begin_db(&connection, &settlement_complete, 4)
        .unwrap();
    let db_result = engine
        .recovery
        .continue_db_only(
            &mut connection,
            &db_pending,
            &engine.transaction,
            &SealedOwnerApplierV1,
            "2026-08-10T00:00:00Z",
        )
        .unwrap();
    let db_complete = engine
        .recovery
        .complete_db(&connection, &db_pending, db_result, 5)
        .unwrap();
    let classification =
        classify_durable_db_state(&connection, &db_complete, &SealedOwnerApplierV1);
    assert_eq!(classification, DurableDbClassificationV1::ExactCommitted);
    let finalization = derive_pre_activation_finalization(&db_complete, classification).unwrap();
    let activation_pending = engine
        .recovery
        .begin_activation(&connection, &db_complete, 6)
        .unwrap();
    let runtime = FakeRuntime::new(false, 1);
    let activation = engine.activation.converge(&finalization, &runtime);
    assert_eq!(activation, ActivationConvergenceOutcomeV1::Applied);
    let resolved = engine
        .recovery
        .resolve(&connection, &activation_pending, activation, 7)
        .unwrap();
    assert_eq!(resolved.record.state.phase, "resolved");
    assert_eq!(
        resolved.record.state.terminal_code.as_deref(),
        Some("RESOLVED")
    );
    let resolved_revision = resolved.record.phase_revision;
    assert!(engine
        .recovery
        .resolve(
            &connection,
            &activation_pending,
            ActivationConvergenceOutcomeV1::AlreadyActive,
            8,
        )
        .is_err());
    assert_eq!(
        engine
            .recovery
            .read_verified(&connection, &fixture.envelope.operation_id)
            .unwrap()
            .record
            .phase_revision,
        resolved_revision
    );
    assert!(read_unresolved_operation_summaries(&connection)
        .unwrap()
        .is_empty());
    assert_eq!(fs::read(&fixture.target_path).unwrap(), target_before);
    assert_eq!(fs::read(&fixture.default_path).unwrap(), default_before);
    drop(connection);

    let restarted = open_current(&fixture.db_path);
    assert!(read_unresolved_operation_summaries(&restarted)
        .unwrap()
        .is_empty());
    let verified_resolved = engine
        .recovery
        .read_verified(&restarted, &fixture.envelope.operation_id)
        .unwrap();
    assert_eq!(verified_resolved.record.state.phase, "resolved");
    assert!(engine
        .recovery
        .begin_activation(&restarted, &verified_resolved, 9)
        .is_err());

    let startup_runtime = FakeRuntime::new(false, 2);
    assert_eq!(
        CanonicalLocalActivationCoordinatorV1::default().converge(&finalization, &startup_runtime),
        ActivationConvergenceOutcomeV1::Applied
    );
}

#[test]
fn f2_1_activation_unknown_is_contained_without_new_effect_or_payload() {
    let fixture = fixture("activation-unknown");
    let mut connection = open_current(&fixture.db_path);
    let db_pending = prepare_db_pending(&connection, &fixture);
    let recovery = CanonicalFormalSwitchRecoveryCoordinatorV1;
    let db_result = recovery
        .continue_db_only(
            &mut connection,
            &db_pending,
            &CanonicalFormalSwitchTransactionCoordinatorV1,
            &SealedOwnerApplierV1,
            "2026-08-10T00:00:00Z",
        )
        .unwrap();
    let db_complete = recovery
        .complete_db(&connection, &db_pending, db_result, 4)
        .unwrap();
    let finalization = derive_pre_activation_finalization(
        &db_complete,
        classify_durable_db_state(&connection, &db_complete, &SealedOwnerApplierV1),
    )
    .unwrap();
    let activation_pending = recovery
        .begin_activation(&connection, &db_complete, 5)
        .unwrap();
    let runtime = FakeRuntime::new(false, 1);
    runtime.fail_read.store(true, Ordering::SeqCst);
    let outcome =
        CanonicalLocalActivationCoordinatorV1::default().converge(&finalization, &runtime);
    assert_eq!(outcome, ActivationConvergenceOutcomeV1::Unknown);
    assert_eq!(runtime.apply_count.load(Ordering::SeqCst), 0);
    let contained = recovery
        .resolve(&connection, &activation_pending, outcome, 6)
        .unwrap();
    assert_eq!(contained.record.state.phase, "contained");
    assert_eq!(contained.record.state.activation_outcome, "UNKNOWN");
    assert_eq!(
        contained.record.immutable_payload,
        activation_pending.record.immutable_payload
    );
}
