//! LP12-4-B2-F2-1 shared canonical execution foundation.
//!
//! This module is deliberately crate-private and has no Tauri command or
//! production-owner registration. Successor tasks bind production owners.

use super::formal_switch_foundation::encoding::{
    encode_canonical_value, encode_envelope, sha256, CanonicalValue,
    FormalSwitchImmutableEnvelopeV1, ReplacementItemV1, SettlementPlanV1,
};
use super::formal_switch_foundation::state::FormalSwitchOperationState;
use super::formal_switch_foundation::{
    advance_phase_cas, mark_contained_or_blocked_cas, prepare_immutable_operation,
    read_verified_operation_for_continuation, verify_payload_integrity,
    ExecutableFormalSwitchOperationV1, PrepareImmutableOperationResult,
};
use crate::markdown_file::{
    apply_explicit_manuscript_byte_range_atomic, AtomicByteRangeCasInput, AtomicByteRangeCasStatus,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

const ENCODING_VERSION: &str = "CanonicalEnvelopeEncodingV1";

fn object(fields: impl IntoIterator<Item = (&'static str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        fields
            .into_iter()
            .map(|(name, value)| (name.to_string(), value))
            .collect(),
    )
}

fn canonical_bytes(value: &CanonicalValue) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    encode_canonical_value(&mut bytes, &CanonicalValue::String(ENCODING_VERSION.into()))?;
    encode_canonical_value(&mut bytes, value)?;
    Ok(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|value| format!("{value:02x}")).collect()
}

fn replacement_value(items: &[ReplacementItemV1]) -> CanonicalValue {
    CanonicalValue::Array(
        items
            .iter()
            .map(|item| {
                object([
                    ("stableKey", CanonicalValue::String(item.stable_key.clone())),
                    (
                        "value",
                        item.value
                            .clone()
                            .map(CanonicalValue::String)
                            .unwrap_or(CanonicalValue::Null),
                    ),
                ])
            })
            .collect(),
    )
}

pub(crate) fn replacement_dto_sha256(items: &[ReplacementItemV1]) -> Result<[u8; 32], String> {
    Ok(sha256(&canonical_bytes(&replacement_value(items))?))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FormalSwitchFinalConfirmationEvidenceV1 {
    pub(crate) evidence_identity: String,
    pub(crate) operation_id: String,
    pub(crate) owner_type: String,
    pub(crate) owner_id: String,
    pub(crate) manuscript_channel: String,
    pub(crate) entry_kind: String,
    pub(crate) old_current_file_ref_identity: String,
    pub(crate) target_file_ref_identity: String,
    pub(crate) candidate_file_ref_identity: String,
    pub(crate) candidate_physical_revision: String,
    pub(crate) candidate_sha256: [u8; 32],
    pub(crate) candidate_byte_length: u64,
    pub(crate) replacement_dto_sha256: [u8; 32],
    pub(crate) descriptor_identity: String,
    pub(crate) descriptor_version: u64,
    pub(crate) descriptor_sha256: [u8; 32],
    pub(crate) preview_snapshot_identity: String,
}

fn confirmation_identity_value(
    evidence: &FormalSwitchFinalConfirmationEvidenceV1,
) -> CanonicalValue {
    object([
        (
            "contractVersion",
            CanonicalValue::String("FormalSwitchFinalConfirmationEvidenceV1".into()),
        ),
        (
            "operationId",
            CanonicalValue::String(evidence.operation_id.clone()),
        ),
        (
            "ownerType",
            CanonicalValue::String(evidence.owner_type.clone()),
        ),
        ("ownerId", CanonicalValue::String(evidence.owner_id.clone())),
        (
            "manuscriptChannel",
            CanonicalValue::String(evidence.manuscript_channel.clone()),
        ),
        (
            "entryKind",
            CanonicalValue::String(evidence.entry_kind.clone()),
        ),
        (
            "oldCurrentFileRefIdentity",
            CanonicalValue::String(evidence.old_current_file_ref_identity.clone()),
        ),
        (
            "targetFileRefIdentity",
            CanonicalValue::String(evidence.target_file_ref_identity.clone()),
        ),
        (
            "candidateFileRefIdentity",
            CanonicalValue::String(evidence.candidate_file_ref_identity.clone()),
        ),
        (
            "candidatePhysicalRevision",
            CanonicalValue::String(evidence.candidate_physical_revision.clone()),
        ),
        (
            "candidateSha256",
            CanonicalValue::Bytes(evidence.candidate_sha256.to_vec()),
        ),
        (
            "candidateByteLength",
            CanonicalValue::U64(evidence.candidate_byte_length),
        ),
        (
            "replacementDtoSha256",
            CanonicalValue::Bytes(evidence.replacement_dto_sha256.to_vec()),
        ),
        (
            "descriptorIdentity",
            CanonicalValue::String(evidence.descriptor_identity.clone()),
        ),
        (
            "descriptorVersion",
            CanonicalValue::U64(evidence.descriptor_version),
        ),
        (
            "descriptorSha256",
            CanonicalValue::Bytes(evidence.descriptor_sha256.to_vec()),
        ),
        (
            "previewSnapshotIdentity",
            CanonicalValue::String(evidence.preview_snapshot_identity.clone()),
        ),
    ])
}

pub(crate) fn freeze_confirmation_identity(
    mut evidence: FormalSwitchFinalConfirmationEvidenceV1,
) -> Result<FormalSwitchFinalConfirmationEvidenceV1, String> {
    evidence.evidence_identity = hex(&sha256(&canonical_bytes(&confirmation_identity_value(
        &evidence,
    ))?));
    Ok(evidence)
}

pub(crate) fn validate_confirmation_binding(
    envelope: &FormalSwitchImmutableEnvelopeV1,
    evidence: &FormalSwitchFinalConfirmationEvidenceV1,
) -> Result<(), String> {
    let recomputed = hex(&sha256(&canonical_bytes(&confirmation_identity_value(
        evidence,
    ))?));
    if evidence.evidence_identity != recomputed
        || envelope.operation_custody_identity != evidence.evidence_identity
        || envelope.operation_id != evidence.operation_id
        || envelope.owner_type.as_str() != evidence.owner_type
        || envelope.owner_id != evidence.owner_id
        || envelope.manuscript_channel.as_str() != evidence.manuscript_channel
        || envelope.entry_kind.as_str() != evidence.entry_kind
        || envelope.old_current_file_ref_identity != evidence.old_current_file_ref_identity
        || envelope.target_file_ref_identity != evidence.target_file_ref_identity
        || envelope.candidate.file_ref_identity != evidence.candidate_file_ref_identity
        || envelope.candidate.physical_revision != evidence.candidate_physical_revision
        || envelope.candidate.sha256 != evidence.candidate_sha256
        || envelope.candidate.byte_length != evidence.candidate_byte_length
        || replacement_dto_sha256(&envelope.replacement_dto)? != evidence.replacement_dto_sha256
        || envelope.descriptor_identity != evidence.descriptor_identity
        || envelope.descriptor_version != evidence.descriptor_version
        || envelope.descriptor_hash != evidence.descriptor_sha256
    {
        return Err("FORMAL_SWITCH_CONFIRMATION_BINDING_MISMATCH".into());
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MountedRuntimeEvidenceV1 {
    pub(crate) actual_runtime_handle: String,
    pub(crate) runtime_generation: u64,
    pub(crate) runtime_consumer_id: String,
    pub(crate) logical_identity: String,
    pub(crate) file_ref_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FinalRevalidationSnapshotV1 {
    pub(crate) envelope_sha256: [u8; 32],
    pub(crate) confirmation_evidence_identity: String,
    pub(crate) target_file_ref_identity: String,
    pub(crate) target_physical_revision: String,
    pub(crate) target_sha256: [u8; 32],
    pub(crate) target_byte_length: u64,
    pub(crate) old_current_file_ref_identity: String,
    pub(crate) old_current_physical_revision: String,
    pub(crate) old_current_sha256: [u8; 32],
    pub(crate) owner_digest: [u8; 32],
    pub(crate) binding_digest: [u8; 32],
    pub(crate) lifecycle_digest: [u8; 32],
    pub(crate) descriptor_identity: String,
    pub(crate) descriptor_version: u64,
    pub(crate) descriptor_sha256: [u8; 32],
    pub(crate) current_mounted_runtime: Option<MountedRuntimeEvidenceV1>,
    pub(crate) target_mounted_runtime: Option<MountedRuntimeEvidenceV1>,
    pub(crate) target_zero_write_verified: bool,
}

pub(crate) trait FinalRevalidationPortV1 {
    fn fresh_revalidate(
        &self,
        envelope: &FormalSwitchImmutableEnvelopeV1,
        envelope_sha256: [u8; 32],
    ) -> Result<FinalRevalidationSnapshotV1, String>;
}

fn validate_mounted_runtime(
    evidence: &MountedRuntimeEvidenceV1,
    logical_identity: &str,
    file_ref_identity: &str,
) -> bool {
    !evidence.actual_runtime_handle.trim().is_empty()
        && !evidence.runtime_consumer_id.trim().is_empty()
        && evidence.logical_identity == logical_identity
        && evidence.file_ref_identity == file_ref_identity
}

pub(crate) fn validate_final_revalidation(
    envelope: &FormalSwitchImmutableEnvelopeV1,
    confirmation: &FormalSwitchFinalConfirmationEvidenceV1,
    expected_current_runtime: Option<&MountedRuntimeEvidenceV1>,
    expected_target_runtime: Option<&MountedRuntimeEvidenceV1>,
    snapshot: &FinalRevalidationSnapshotV1,
    envelope_sha256: [u8; 32],
) -> Result<(), String> {
    validate_confirmation_binding(envelope, confirmation)?;
    if snapshot.envelope_sha256 != envelope_sha256
        || snapshot.confirmation_evidence_identity != confirmation.evidence_identity
        || snapshot.target_file_ref_identity != envelope.target_file_ref_identity
        || snapshot.target_physical_revision != envelope.candidate.physical_revision
        || snapshot.target_sha256 != envelope.candidate.sha256
        || snapshot.target_byte_length != envelope.candidate.byte_length
        || snapshot.old_current_file_ref_identity != envelope.old_current_file_ref_identity
        || snapshot.old_current_physical_revision != envelope.old_current_expected_physical_revision
        || snapshot.old_current_sha256 != envelope.settlement_plan.expected_whole_file_hash
        || snapshot.owner_digest != envelope.owner_protected_row_digest
        || snapshot.binding_digest != envelope.binding_digest
        || snapshot.lifecycle_digest != envelope.lifecycle_coverage_digest
        || snapshot.descriptor_identity != envelope.descriptor_identity
        || snapshot.descriptor_version != envelope.descriptor_version
        || snapshot.descriptor_sha256 != envelope.descriptor_hash
        || !snapshot.target_zero_write_verified
        || snapshot.current_mounted_runtime.as_ref() != expected_current_runtime
        || snapshot.target_mounted_runtime.as_ref() != expected_target_runtime
        || snapshot
            .current_mounted_runtime
            .as_ref()
            .is_some_and(|value| {
                !validate_mounted_runtime(
                    value,
                    &envelope.old_current_logical_session_identity,
                    &envelope.old_current_file_ref_identity,
                )
            })
        || snapshot
            .target_mounted_runtime
            .as_ref()
            .is_some_and(|value| {
                !validate_mounted_runtime(
                    value,
                    &envelope.target_logical_session_identity,
                    &envelope.target_file_ref_identity,
                )
            })
    {
        return Err("FORMAL_SWITCH_FINAL_REVALIDATION_CONFLICT".into());
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreparedExactOperationV1 {
    pub(crate) executable: ExecutableFormalSwitchOperationV1,
    pub(crate) canonical_bytes: Vec<u8>,
    pub(crate) canonical_sha256: [u8; 32],
}

pub(crate) fn revalidate_and_prepare_exact(
    connection: &Connection,
    envelope: &FormalSwitchImmutableEnvelopeV1,
    confirmation: &FormalSwitchFinalConfirmationEvidenceV1,
    expected_current_runtime: Option<&MountedRuntimeEvidenceV1>,
    expected_target_runtime: Option<&MountedRuntimeEvidenceV1>,
    revalidation_port: &dyn FinalRevalidationPortV1,
) -> Result<PreparedExactOperationV1, String> {
    validate_confirmation_binding(envelope, confirmation)?;
    let canonical = encode_envelope(envelope)?;
    let hash = sha256(&canonical);
    let snapshot = revalidation_port.fresh_revalidate(envelope, hash)?;
    validate_final_revalidation(
        envelope,
        confirmation,
        expected_current_runtime,
        expected_target_runtime,
        &snapshot,
        hash,
    )?;
    match prepare_immutable_operation(connection, envelope)? {
        PrepareImmutableOperationResult::Prepared(_)
        | PrepareImmutableOperationResult::AlreadyPrepared(_) => {}
        _ => return Err("FORMAL_SWITCH_DURABLE_PREPARE_CONFLICT".into()),
    }
    let executable = read_verified_operation_for_continuation(connection, &envelope.operation_id)?;
    if executable.record.immutable_payload != canonical
        || executable.record.payload_sha256.as_slice() != hash
    {
        return Err("FORMAL_SWITCH_REVALIDATION_PREPARE_HASH_MISMATCH".into());
    }
    Ok(PreparedExactOperationV1 {
        executable,
        canonical_bytes: canonical,
        canonical_sha256: hash,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SettlementDurableImageV1 {
    PreImage,
    PostImage,
    Neither,
}

pub(crate) fn classify_settlement_image(
    plan: &SettlementPlanV1,
    bytes: &[u8],
) -> SettlementDurableImageV1 {
    let digest = sha256(bytes);
    if digest == plan.expected_whole_file_hash {
        SettlementDurableImageV1::PreImage
    } else if digest == plan.expected_whole_file_post_hash {
        SettlementDurableImageV1::PostImage
    } else {
        SettlementDurableImageV1::Neither
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedOldCurrentFileV1 {
    pub(crate) file_ref_identity: String,
    pub(crate) file_path: String,
    pub(crate) path_identity: String,
    pub(crate) file_name: String,
    pub(crate) location_mode: String,
    pub(crate) configured_root: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SettlementExecutionOutcomeV1 {
    Applied,
    AlreadyApplied,
    Conflict,
    Unknown,
}

pub(crate) fn execute_settlement_atomic(
    envelope: &FormalSwitchImmutableEnvelopeV1,
    resolved: &ResolvedOldCurrentFileV1,
) -> Result<SettlementExecutionOutcomeV1, String> {
    if resolved.file_ref_identity != envelope.old_current_file_ref_identity
        || resolved.file_ref_identity == envelope.target_file_ref_identity
        || envelope.old_current_file_ref_identity == envelope.target_file_ref_identity
    {
        return Err("FORMAL_SWITCH_SETTLEMENT_MUTATION_IDENTITY_REJECTED".into());
    }
    let result = apply_explicit_manuscript_byte_range_atomic(&AtomicByteRangeCasInput {
        file_path: &resolved.file_path,
        expected_path_identity: &resolved.path_identity,
        expected_file_name: &resolved.file_name,
        expected_revision: &envelope.old_current_expected_physical_revision,
        expected_whole_file_sha256: &envelope.settlement_plan.expected_whole_file_hash,
        byte_start: envelope.settlement_plan.byte_start,
        byte_end: envelope.settlement_plan.byte_end,
        expected_region_sha256: &envelope
            .settlement_plan
            .expected_controlled_region_preimage_hash,
        replacement_bytes: &envelope.settlement_plan.replacement_bytes,
        expected_post_sha256: &envelope.settlement_plan.expected_whole_file_post_hash,
        location_mode: &resolved.location_mode,
        configured_root: resolved.configured_root.as_deref(),
    })
    .map_err(str::to_string)?;
    Ok(match result.status {
        AtomicByteRangeCasStatus::Applied => SettlementExecutionOutcomeV1::Applied,
        AtomicByteRangeCasStatus::AlreadyPost => SettlementExecutionOutcomeV1::AlreadyApplied,
        AtomicByteRangeCasStatus::RevisionConflict
        | AtomicByteRangeCasStatus::PreconditionConflict => SettlementExecutionOutcomeV1::Conflict,
        AtomicByteRangeCasStatus::VerificationUnknown => SettlementExecutionOutcomeV1::Unknown,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParentLifecycleV1 {
    pub(crate) owner_type: String,
    pub(crate) owner_id: String,
    pub(crate) deleted_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OwnerLifecycleV1 {
    pub(crate) owner_deleted_at: Option<String>,
    pub(crate) parent_chain: Vec<ParentLifecycleV1>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProtectedFieldV1 {
    pub(crate) stable_key: String,
    pub(crate) value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OwnerProtectedStateV1 {
    pub(crate) project_id: Option<String>,
    pub(crate) parent_identity: Option<(String, String)>,
    pub(crate) review_type: Option<String>,
    pub(crate) context_summary_input_digest: [u8; 32],
    pub(crate) protected_fields: Vec<ProtectedFieldV1>,
    pub(crate) unowned_state_digest: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BindingStateV1 {
    pub(crate) binding_id: String,
    pub(crate) owner_type: String,
    pub(crate) owner_id: String,
    pub(crate) manuscript_channel: String,
    pub(crate) current_file_ref_id: Option<String>,
    pub(crate) default_manuscript_file_ref_id: Option<String>,
    pub(crate) default_folder_file_ref_id: Option<String>,
    pub(crate) schema_version: i64,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) deleted_at: Option<String>,
}

fn nullable_string(value: &Option<String>) -> CanonicalValue {
    value
        .clone()
        .map(CanonicalValue::String)
        .unwrap_or(CanonicalValue::Null)
}

pub(crate) fn lifecycle_coverage_digest(
    envelope: &FormalSwitchImmutableEnvelopeV1,
    owner: &OwnerLifecycleV1,
    binding: &BindingStateV1,
) -> Result<[u8; 32], String> {
    let value = object([
        (
            "ownerType",
            CanonicalValue::String(envelope.owner_type.as_str().into()),
        ),
        ("ownerId", CanonicalValue::String(envelope.owner_id.clone())),
        ("ownerDeletedAt", nullable_string(&owner.owner_deleted_at)),
        (
            "parentChain",
            CanonicalValue::Array(
                owner
                    .parent_chain
                    .iter()
                    .map(|parent| {
                        object([
                            (
                                "ownerType",
                                CanonicalValue::String(parent.owner_type.clone()),
                            ),
                            ("ownerId", CanonicalValue::String(parent.owner_id.clone())),
                            ("deletedAt", nullable_string(&parent.deleted_at)),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "bindingId",
            CanonicalValue::String(binding.binding_id.clone()),
        ),
        ("bindingDeletedAt", nullable_string(&binding.deleted_at)),
    ]);
    Ok(sha256(&canonical_bytes(&value)?))
}

pub(crate) fn binding_digest(binding: &BindingStateV1) -> Result<[u8; 32], String> {
    let value = object([
        (
            "digestVersion",
            CanonicalValue::String("BindingDigestV1".into()),
        ),
        (
            "canonicalEncodingVersion",
            CanonicalValue::String(ENCODING_VERSION.into()),
        ),
        (
            "bindingId",
            CanonicalValue::String(binding.binding_id.clone()),
        ),
        (
            "ownerType",
            CanonicalValue::String(binding.owner_type.clone()),
        ),
        ("ownerId", CanonicalValue::String(binding.owner_id.clone())),
        (
            "manuscriptChannel",
            CanonicalValue::String(binding.manuscript_channel.clone()),
        ),
        (
            "currentFileRefId",
            nullable_string(&binding.current_file_ref_id),
        ),
        (
            "defaultManuscriptFileRefId",
            nullable_string(&binding.default_manuscript_file_ref_id),
        ),
        (
            "defaultFolderFileRefId",
            nullable_string(&binding.default_folder_file_ref_id),
        ),
        ("schemaVersion", CanonicalValue::I64(binding.schema_version)),
        ("createdAt", CanonicalValue::String(binding.created_at.clone())),
        ("updatedAt", CanonicalValue::String(binding.updated_at.clone())),
        ("deletedAt", nullable_string(&binding.deleted_at)),
    ]);
    Ok(sha256(&canonical_bytes(&value)?))
}

pub(crate) fn owner_protected_row_digest(
    envelope: &FormalSwitchImmutableEnvelopeV1,
    state: &OwnerProtectedStateV1,
    lifecycle_digest: [u8; 32],
) -> Result<[u8; 32], String> {
    let parent = state
        .parent_identity
        .as_ref()
        .map(|(owner_type, owner_id)| {
            object([
                ("ownerType", CanonicalValue::String(owner_type.clone())),
                ("ownerId", CanonicalValue::String(owner_id.clone())),
            ])
        })
        .unwrap_or(CanonicalValue::Absent);
    let value = object([
        (
            "digestVersion",
            CanonicalValue::String("FormalSwitchProtectedRowDigestV1".into()),
        ),
        (
            "canonicalEncodingVersion",
            CanonicalValue::String(ENCODING_VERSION.into()),
        ),
        (
            "ownerType",
            CanonicalValue::String(envelope.owner_type.as_str().into()),
        ),
        ("ownerId", CanonicalValue::String(envelope.owner_id.clone())),
        (
            "manuscriptChannel",
            CanonicalValue::String(envelope.manuscript_channel.as_str().into()),
        ),
        (
            "descriptorIdentity",
            CanonicalValue::String(envelope.descriptor_identity.clone()),
        ),
        (
            "descriptorVersion",
            CanonicalValue::U64(envelope.descriptor_version),
        ),
        (
            "descriptorHash",
            CanonicalValue::Bytes(envelope.descriptor_hash.to_vec()),
        ),
        (
            "projectId",
            state
                .project_id
                .clone()
                .map(CanonicalValue::String)
                .unwrap_or(CanonicalValue::Absent),
        ),
        ("parentIdentity", parent),
        (
            "reviewType",
            state
                .review_type
                .clone()
                .map(CanonicalValue::String)
                .unwrap_or(CanonicalValue::Absent),
        ),
        (
            "lifecycleCoverageDigest",
            CanonicalValue::Bytes(lifecycle_digest.to_vec()),
        ),
        (
            "contextSummaryInputDigest",
            CanonicalValue::Bytes(state.context_summary_input_digest.to_vec()),
        ),
        (
            "protectedFields",
            CanonicalValue::Array(
                state
                    .protected_fields
                    .iter()
                    .map(|field| {
                        object([
                            (
                                "stableKey",
                                CanonicalValue::String(field.stable_key.clone()),
                            ),
                            ("value", nullable_string(&field.value)),
                        ])
                    })
                .collect(),
            ),
        ),
        (
            "unownedStateDigest",
            CanonicalValue::Bytes(state.unowned_state_digest.to_vec()),
        ),
    ]);
    Ok(sha256(&canonical_bytes(&value)?))
}

pub(crate) trait FormalSwitchOwnerApplierV1: Send + Sync {
    fn read_owner_state(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<OwnerProtectedStateV1, String>;
    fn read_owner_lifecycle(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<OwnerLifecycleV1, String>;
    fn apply_owned_fields(
        &self,
        connection: &Connection,
        envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<(), String>;
    fn read_exact_post_evidence(
        &self,
        _connection: &Connection,
        _envelope: &FormalSwitchImmutableEnvelopeV1,
    ) -> Result<Option<serde_json::Value>, String> {
        Ok(None)
    }
    fn exact_post_evidence_matches(
        &self,
        _connection: &Connection,
        _envelope: &FormalSwitchImmutableEnvelopeV1,
        evidence: Option<&serde_json::Value>,
    ) -> Result<bool, String> {
        Ok(evidence.is_none())
    }
}

pub(crate) fn read_binding(
    connection: &Connection,
    envelope: &FormalSwitchImmutableEnvelopeV1,
) -> Result<BindingStateV1, String> {
    connection
        .query_row(
            "SELECT id,owner_type,owner_id,manuscript_channel,current_file_ref_id,default_manuscript_file_ref_id,default_folder_file_ref_id,schema_version,created_at,updated_at,deleted_at FROM manuscript_bindings WHERE owner_type=?1 AND owner_id=?2 AND manuscript_channel=?3",
            params![envelope.owner_type.as_str(), envelope.owner_id, envelope.manuscript_channel.as_str()],
            |row| {
                Ok(BindingStateV1 {
                    binding_id: row.get(0)?, owner_type: row.get(1)?, owner_id: row.get(2)?,
                    manuscript_channel: row.get(3)?, current_file_ref_id: row.get(4)?,
                    default_manuscript_file_ref_id: row.get(5)?, default_folder_file_ref_id: row.get(6)?,
                    schema_version: row.get(7)?, created_at: row.get(8)?, updated_at: row.get(9)?, deleted_at: row.get(10)?,
                })
            },
        )
        .map_err(|error| format!("FORMAL_SWITCH_BINDING_READ_FAILED:{error}"))
}

pub(crate) fn canonical_transaction_payload_bytes(
    envelope: &FormalSwitchImmutableEnvelopeV1,
) -> Result<Vec<u8>, String> {
    canonical_bytes(&object([
        (
            "transactionPayloadVersion",
            CanonicalValue::U64(envelope.transaction_payload_version),
        ),
        (
            "operationId",
            CanonicalValue::String(envelope.operation_id.clone()),
        ),
        (
            "ownerType",
            CanonicalValue::String(envelope.owner_type.as_str().into()),
        ),
        ("ownerId", CanonicalValue::String(envelope.owner_id.clone())),
        (
            "manuscriptChannel",
            CanonicalValue::String(envelope.manuscript_channel.as_str().into()),
        ),
        (
            "targetFileRefIdentity",
            CanonicalValue::String(envelope.target_file_ref_identity.clone()),
        ),
        (
            "defaultFileRefIdentity",
            CanonicalValue::String(envelope.default_file_ref_identity.clone()),
        ),
        (
            "replacementDtoSha256",
            CanonicalValue::Bytes(replacement_dto_sha256(&envelope.replacement_dto)?.to_vec()),
        ),
        (
            "ownerProtectedRowDigest",
            CanonicalValue::Bytes(envelope.owner_protected_row_digest.to_vec()),
        ),
        (
            "bindingDigest",
            CanonicalValue::Bytes(envelope.binding_digest.to_vec()),
        ),
        (
            "lifecycleCoverageDigest",
            CanonicalValue::Bytes(envelope.lifecycle_coverage_digest.to_vec()),
        ),
        (
            "successOperationLogId",
            CanonicalValue::String(envelope.success_operation_log_id.clone()),
        ),
    ]))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DurableDbClassificationV1 {
    ExactCommitted,
    NotCommitted,
    PartialOrInconsistent,
    Unverifiable,
}

fn exact_replacement_matches(
    state: &OwnerProtectedStateV1,
    replacements: &[ReplacementItemV1],
) -> bool {
    let expected = replacements
        .iter()
        .map(|item| (item.stable_key.as_str(), item.value.as_ref()))
        .collect::<BTreeMap<_, _>>();
    state.protected_fields.len() == expected.len()
        && state.protected_fields.iter().all(|field| {
            expected
                .get(field.stable_key.as_str())
                .is_some_and(|value| *value == field.value.as_ref())
        })
}

pub(crate) fn classify_durable_db_state(
    connection: &Connection,
    executable: &ExecutableFormalSwitchOperationV1,
    applier: &dyn FormalSwitchOwnerApplierV1,
) -> DurableDbClassificationV1 {
    // A classifier call must observe one SQLite snapshot. Without this guard,
    // separate autocommit reads could straddle another writer's commit and
    // manufacture a false partial image. Calls made inside the canonical write
    // transaction already own a stable transaction snapshot.
    if connection.is_autocommit() {
        let Ok(transaction) = connection.unchecked_transaction() else {
            return DurableDbClassificationV1::Unverifiable;
        };
        let classification = classify_durable_db_state(&transaction, executable, applier);
        return if transaction.commit().is_ok() {
            classification
        } else {
            DurableDbClassificationV1::Unverifiable
        };
    }
    let envelope = &executable.envelope;
    let result = (|| -> Result<DurableDbClassificationV1, String> {
        let log = connection
            .query_row(
                "SELECT id,confirmation FROM operation_logs WHERE operation_type='formal_switch' AND status='success' AND formal_switch_operation_id=?1",
                [&envelope.operation_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let binding = read_binding(connection, envelope)?;
        let lifecycle = applier.read_owner_lifecycle(connection, envelope)?;
        let lifecycle_digest = lifecycle_coverage_digest(envelope, &lifecycle, &binding)?;
        let owner = applier.read_owner_state(connection, envelope)?;
        let owner_digest = owner_protected_row_digest(envelope, &owner, lifecycle_digest)?;
        let binding_digest_value = binding_digest(&binding)?;
        let post_evidence = log.as_ref().and_then(|(_, encoded)| {
            let value: serde_json::Value = serde_json::from_str(encoded.as_deref()?).ok()?;
            value.get("exactPostEvidence").cloned()
        });
        let exact_post = log.as_ref().map(|(id, _)| id.as_str())
                == Some(envelope.success_operation_log_id.as_str())
            && exact_replacement_matches(&owner, &envelope.replacement_dto)
            && binding.current_file_ref_id.as_deref()
                == Some(envelope.target_file_ref_identity.as_str())
            && binding.default_manuscript_file_ref_id.as_deref()
                == Some(envelope.default_file_ref_identity.as_str())
            && post_evidence.as_ref().is_some_and(|evidence| {
                evidence.get("ownerUnownedPostDigest").and_then(serde_json::Value::as_str)
                    == Some(hex(&owner.unowned_state_digest).as_str())
                    && evidence.get("bindingPostDigest").and_then(serde_json::Value::as_str)
                        == binding_digest(&binding).ok().map(|value| hex(&value)).as_deref()
                    && evidence.get("lifecyclePostDigest").and_then(serde_json::Value::as_str)
                        == Some(hex(&lifecycle_digest).as_str())
                    && applier.exact_post_evidence_matches(
                        connection,
                        envelope,
                        evidence.get("ownerSpecificPostEvidence"),
                    ).unwrap_or(false)
            });
        if exact_post {
            return Ok(DurableDbClassificationV1::ExactCommitted);
        }
        let exact_pre = log.is_none()
            && owner_digest == envelope.owner_protected_row_digest
            && binding_digest_value == envelope.binding_digest
            && lifecycle_digest == envelope.lifecycle_coverage_digest;
        if exact_pre {
            Ok(DurableDbClassificationV1::NotCommitted)
        } else if log.is_some()
            || binding.current_file_ref_id.as_deref()
                == Some(envelope.target_file_ref_identity.as_str())
            || exact_replacement_matches(&owner, &envelope.replacement_dto)
        {
            Ok(DurableDbClassificationV1::PartialOrInconsistent)
        } else {
            Ok(DurableDbClassificationV1::Unverifiable)
        }
    })();
    result.unwrap_or(DurableDbClassificationV1::Unverifiable)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CanonicalTransactionResultV1 {
    Committed,
    AlreadyCommitted,
    CasConflict,
    Inconsistent,
}

pub(crate) struct CanonicalFormalSwitchTransactionCoordinatorV1;

impl CanonicalFormalSwitchTransactionCoordinatorV1 {
    pub(crate) fn execute(
        &self,
        connection: &mut Connection,
        executable: &ExecutableFormalSwitchOperationV1,
        applier: &dyn FormalSwitchOwnerApplierV1,
        occurred_at: &str,
    ) -> Result<CanonicalTransactionResultV1, String> {
        verify_payload_integrity(&executable.record)?;
        let envelope = &executable.envelope;
        if envelope.transaction_payload_version != 1
            || envelope.transaction_payload != canonical_transaction_payload_bytes(envelope)?
        {
            return Err("FORMAL_SWITCH_TRANSACTION_PAYLOAD_INVALID".into());
        }
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("FORMAL_SWITCH_TRANSACTION_BEGIN_FAILED:{error}"))?;
        let already_log = transaction
            .query_row(
                "SELECT id FROM operation_logs WHERE operation_type='formal_switch' AND status='success' AND formal_switch_operation_id=?1",
                [&envelope.operation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if already_log.is_some() {
            let classification = classify_durable_db_state(&transaction, executable, applier);
            return Ok(
                if classification == DurableDbClassificationV1::ExactCommitted {
                    CanonicalTransactionResultV1::AlreadyCommitted
                } else {
                    CanonicalTransactionResultV1::Inconsistent
                },
            );
        }

        let binding_before = read_binding(&transaction, envelope)?;
        let lifecycle_before = applier.read_owner_lifecycle(&transaction, envelope)?;
        let lifecycle_before_digest =
            lifecycle_coverage_digest(envelope, &lifecycle_before, &binding_before)?;
        let owner_before = applier.read_owner_state(&transaction, envelope)?;
        let owner_before_digest =
            owner_protected_row_digest(envelope, &owner_before, lifecycle_before_digest)?;
        if owner_before_digest != envelope.owner_protected_row_digest
            || binding_digest(&binding_before)? != envelope.binding_digest
            || lifecycle_before_digest != envelope.lifecycle_coverage_digest
        {
            return Ok(CanonicalTransactionResultV1::CasConflict);
        }
        let default_before = binding_before.default_manuscript_file_ref_id.clone();
        let default_folder_before = binding_before.default_folder_file_ref_id.clone();
        let unowned_before = owner_before.unowned_state_digest;
        applier.apply_owned_fields(&transaction, envelope)?;
        let changed = transaction
            .execute(
                "UPDATE manuscript_bindings SET current_file_ref_id=?1,updated_at=?2 WHERE id=?3 AND deleted_at IS NULL",
                params![envelope.target_file_ref_identity, occurred_at, binding_before.binding_id],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Ok(CanonicalTransactionResultV1::CasConflict);
        }
        let binding_after = read_binding(&transaction, envelope)?;
        let lifecycle_after = applier.read_owner_lifecycle(&transaction, envelope)?;
        let owner_after = applier.read_owner_state(&transaction, envelope)?;
        if !exact_replacement_matches(&owner_after, &envelope.replacement_dto)
            || owner_after.unowned_state_digest != unowned_before
            || binding_after.current_file_ref_id.as_deref()
                != Some(envelope.target_file_ref_identity.as_str())
            || binding_after.default_manuscript_file_ref_id != default_before
            || binding_after.default_folder_file_ref_id != default_folder_before
            || lifecycle_after != lifecycle_before
        {
            return Err("FORMAL_SWITCH_TRANSACTION_POST_CONDITION_FAILED".into());
        }
        let owner_specific_post_evidence =
            applier.read_exact_post_evidence(&transaction, envelope)?;
        if !applier.exact_post_evidence_matches(
            &transaction,
            envelope,
            owner_specific_post_evidence.as_ref(),
        )? {
            return Err("FORMAL_SWITCH_OWNER_EXACT_POST_EVIDENCE_INVALID".into());
        }
        let lifecycle_after_digest = lifecycle_coverage_digest(envelope, &lifecycle_after, &binding_after)?;
        let mut exact_post_evidence = serde_json::json!({
            "contractVersion": "FormalSwitchExactPostEvidenceV1",
            "ownerUnownedPostDigest": hex(&owner_after.unowned_state_digest),
            "bindingPostDigest": hex(&binding_digest(&binding_after)?),
            "lifecyclePostDigest": hex(&lifecycle_after_digest)
        });
        if let Some(evidence) = owner_specific_post_evidence {
            exact_post_evidence["ownerSpecificPostEvidence"] = evidence;
        }
        let confirmation = serde_json::json!({
            "required": true,
            "confirmedByUser": true,
            "confirmedAt": occurred_at,
            "confirmationId": envelope.operation_custody_identity,
            "exactPostEvidence": exact_post_evidence
        }).to_string();
        transaction
            .execute(
                "INSERT INTO operation_logs(id,operation_type,source,module,status,risk_level,target,summary,related_entities,confirmation,warnings,errors,skipped,is_recoverable,actor_id,actor_label,refresh_keys,schema_version,created_at,updated_at,formal_switch_operation_id) VALUES(?1,'formal_switch','user','manuscript','success','high',?2,'Canonical Formal Switch','[]',?3,'[]','[]','[]',0,'local_user','Local user','[]',1,?4,?4,?5)",
                params![envelope.success_operation_log_id, envelope.owner_id, confirmation, occurred_at, envelope.operation_id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .commit()
            .map_err(|error| format!("FORMAL_SWITCH_TRANSACTION_COMMIT_FAILED:{error}"))?;
        Ok(
            if classify_durable_db_state(connection, executable, applier)
                == DurableDbClassificationV1::ExactCommitted
            {
                CanonicalTransactionResultV1::Committed
            } else {
                CanonicalTransactionResultV1::Inconsistent
            },
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CanonicalFormalSwitchFinalizationResultV1 {
    pub(crate) operation_id: String,
    pub(crate) payload_sha256: [u8; 32],
    pub(crate) owner_type: String,
    pub(crate) owner_id: String,
    pub(crate) manuscript_channel: String,
    pub(crate) target_file_ref_identity: String,
    pub(crate) activation_logical_identity: String,
    pub(crate) finalization_identity: String,
}

pub(crate) fn derive_finalization_identity(
    envelope: &FormalSwitchImmutableEnvelopeV1,
) -> Result<String, String> {
    Ok(hex(&sha256(&canonical_bytes(&object([
        (
            "contractVersion",
            CanonicalValue::String("CanonicalFormalSwitchFinalizationResultV1".into()),
        ),
        (
            "operationId",
            CanonicalValue::String(envelope.operation_id.clone()),
        ),
        (
            "ownerType",
            CanonicalValue::String(envelope.owner_type.as_str().into()),
        ),
        ("ownerId", CanonicalValue::String(envelope.owner_id.clone())),
        (
            "manuscriptChannel",
            CanonicalValue::String(envelope.manuscript_channel.as_str().into()),
        ),
        (
            "targetFileRefIdentity",
            CanonicalValue::String(envelope.target_file_ref_identity.clone()),
        ),
        (
            "activationLogicalIdentity",
            CanonicalValue::String(envelope.activation_logical_identity.clone()),
        ),
        (
            "successOperationLogId",
            CanonicalValue::String(envelope.success_operation_log_id.clone()),
        ),
        (
            "transactionPayloadSha256",
            CanonicalValue::Bytes(sha256(&envelope.transaction_payload).to_vec()),
        ),
    ]))?)))
}

pub(crate) fn derive_pre_activation_finalization(
    executable: &ExecutableFormalSwitchOperationV1,
    classification: DurableDbClassificationV1,
) -> Result<CanonicalFormalSwitchFinalizationResultV1, String> {
    if classification != DurableDbClassificationV1::ExactCommitted {
        return Err("FORMAL_SWITCH_FINALIZATION_DB_POST_NOT_EXACT".into());
    }
    let finalization_identity = derive_finalization_identity(&executable.envelope)?;
    if executable.envelope.finalization_identity != finalization_identity {
        return Err("FORMAL_SWITCH_FINALIZATION_IDENTITY_MISMATCH".into());
    }
    let payload_sha256: [u8; 32] = executable
        .record
        .payload_sha256
        .as_slice()
        .try_into()
        .map_err(|_| "FORMAL_SWITCH_PAYLOAD_HASH_INVALID")?;
    Ok(CanonicalFormalSwitchFinalizationResultV1 {
        operation_id: executable.envelope.operation_id.clone(),
        payload_sha256,
        owner_type: executable.envelope.owner_type.as_str().into(),
        owner_id: executable.envelope.owner_id.clone(),
        manuscript_channel: executable.envelope.manuscript_channel.as_str().into(),
        target_file_ref_identity: executable.envelope.target_file_ref_identity.clone(),
        activation_logical_identity: executable.envelope.activation_logical_identity.clone(),
        finalization_identity,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeActivationSnapshotV1 {
    pub(crate) actual_runtime_handle: String,
    pub(crate) runtime_generation: u64,
    pub(crate) runtime_consumer_id: String,
    pub(crate) logical_identity: String,
    pub(crate) file_ref_identity: String,
    pub(crate) exact_active: bool,
}

pub(crate) trait CanonicalRuntimeReacquisitionPortV1: Send + Sync {
    fn fresh_reacquire(
        &self,
        finalization: &CanonicalFormalSwitchFinalizationResultV1,
    ) -> Result<RuntimeActivationSnapshotV1, String>;
    fn read_actual_state(
        &self,
        snapshot: &RuntimeActivationSnapshotV1,
    ) -> Result<RuntimeActivationSnapshotV1, String>;
    fn activate_idempotently(
        &self,
        snapshot: &RuntimeActivationSnapshotV1,
        finalization: &CanonicalFormalSwitchFinalizationResultV1,
    ) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActivationConvergenceOutcomeV1 {
    Applied,
    AlreadyActive,
    Unknown,
}

#[derive(Default)]
pub(crate) struct CanonicalLocalActivationCoordinatorV1 {
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl CanonicalLocalActivationCoordinatorV1 {
    pub(crate) fn converge(
        &self,
        finalization: &CanonicalFormalSwitchFinalizationResultV1,
        port: &dyn CanonicalRuntimeReacquisitionPortV1,
    ) -> ActivationConvergenceOutcomeV1 {
        let lock = {
            let Ok(mut locks) = self.locks.lock() else {
                return ActivationConvergenceOutcomeV1::Unknown;
            };
            locks
                .entry(finalization.activation_logical_identity.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let Ok(_critical_section) = lock.lock() else {
            return ActivationConvergenceOutcomeV1::Unknown;
        };
        let Ok(reacquired) = port.fresh_reacquire(finalization) else {
            return ActivationConvergenceOutcomeV1::Unknown;
        };
        let Ok(before) = port.read_actual_state(&reacquired) else {
            return ActivationConvergenceOutcomeV1::Unknown;
        };
        if before.logical_identity != finalization.activation_logical_identity
            || before.file_ref_identity != finalization.target_file_ref_identity
            || before.actual_runtime_handle.trim().is_empty()
            || before.runtime_consumer_id.trim().is_empty()
        {
            return ActivationConvergenceOutcomeV1::Unknown;
        }
        if before.exact_active {
            return ActivationConvergenceOutcomeV1::AlreadyActive;
        }
        if port.activate_idempotently(&before, finalization).is_err() {
            return match port.read_actual_state(&before) {
                Ok(after) if after.exact_active => ActivationConvergenceOutcomeV1::AlreadyActive,
                _ => ActivationConvergenceOutcomeV1::Unknown,
            };
        }
        match port.read_actual_state(&before) {
            Ok(after)
                if after.exact_active
                    && after.logical_identity == finalization.activation_logical_identity
                    && after.file_ref_identity == finalization.target_file_ref_identity =>
            {
                ActivationConvergenceOutcomeV1::Applied
            }
            _ => ActivationConvergenceOutcomeV1::Unknown,
        }
    }
}

fn payload_hash(
    record: &super::formal_switch_foundation::FormalSwitchOperationRecord,
) -> Result<[u8; 32], String> {
    record
        .payload_sha256
        .as_slice()
        .try_into()
        .map_err(|_| "FORMAL_SWITCH_PAYLOAD_HASH_INVALID".into())
}

fn advance(
    connection: &Connection,
    executable: &ExecutableFormalSwitchOperationV1,
    expected_phase: &str,
    next_state: FormalSwitchOperationState,
    now_epoch_ms: i64,
) -> Result<ExecutableFormalSwitchOperationV1, String> {
    let record = advance_phase_cas(
        connection,
        &executable.envelope.operation_id,
        expected_phase,
        executable.record.phase_revision,
        &payload_hash(&executable.record)?,
        &next_state,
        None,
        None,
        None,
        now_epoch_ms,
    )
    .map_err(|error| format!("FORMAL_SWITCH_PHASE_CAS_FAILED:{error:?}"))?;
    let envelope = verify_payload_integrity(&record)?;
    Ok(ExecutableFormalSwitchOperationV1 { record, envelope })
}

pub(crate) fn resolve_after_activation(
    connection: &Connection,
    executable: &ExecutableFormalSwitchOperationV1,
    activation: ActivationConvergenceOutcomeV1,
    now_epoch_ms: i64,
) -> Result<ExecutableFormalSwitchOperationV1, String> {
    match activation {
        ActivationConvergenceOutcomeV1::Applied | ActivationConvergenceOutcomeV1::AlreadyActive => {
            advance(
                connection,
                executable,
                "activation_pending",
                FormalSwitchOperationState {
                    phase: "resolved".into(),
                    settlement_outcome: executable.record.state.settlement_outcome.clone(),
                    db_outcome: executable.record.state.db_outcome.clone(),
                    activation_outcome: if activation == ActivationConvergenceOutcomeV1::Applied {
                        "APPLIED"
                    } else {
                        "ALREADY_ACTIVE"
                    }
                    .into(),
                    terminal_code: Some("RESOLVED".into()),
                },
                now_epoch_ms,
            )
        }
        ActivationConvergenceOutcomeV1::Unknown => {
            let record = mark_contained_or_blocked_cas(
                connection,
                &executable.envelope.operation_id,
                "activation_pending",
                executable.record.phase_revision,
                &payload_hash(&executable.record)?,
                true,
                (
                    &executable.record.state.settlement_outcome,
                    &executable.record.state.db_outcome,
                    "UNKNOWN",
                ),
                now_epoch_ms,
            )
            .map_err(|error| format!("FORMAL_SWITCH_CONTAINMENT_CAS_FAILED:{error:?}"))?;
            let envelope = verify_payload_integrity(&record)?;
            Ok(ExecutableFormalSwitchOperationV1 { record, envelope })
        }
    }
}

/// The only F2-1 recovery coordinator. It consumes the F1 verified immutable
/// operation and advances the existing F1 matrix; it cannot create an
/// operation, reparse a manuscript, or regenerate either effect payload.
pub(crate) struct CanonicalFormalSwitchRecoveryCoordinatorV1;

impl CanonicalFormalSwitchRecoveryCoordinatorV1 {
    pub(crate) fn read_verified(
        &self,
        connection: &Connection,
        operation_id: &str,
    ) -> Result<ExecutableFormalSwitchOperationV1, String> {
        read_verified_operation_for_continuation(connection, operation_id)
    }

    pub(crate) fn begin_settlement(
        &self,
        connection: &Connection,
        executable: &ExecutableFormalSwitchOperationV1,
        now_epoch_ms: i64,
    ) -> Result<ExecutableFormalSwitchOperationV1, String> {
        advance(
            connection,
            executable,
            "prepared",
            FormalSwitchOperationState {
                phase: "settlement_started".into(),
                settlement_outcome: "UNKNOWN".into(),
                db_outcome: "NOT_APPLIED".into(),
                activation_outcome: "PENDING".into(),
                terminal_code: None,
            },
            now_epoch_ms,
        )
    }

    pub(crate) fn complete_settlement(
        &self,
        connection: &Connection,
        executable: &ExecutableFormalSwitchOperationV1,
        outcome: SettlementExecutionOutcomeV1,
        now_epoch_ms: i64,
    ) -> Result<ExecutableFormalSwitchOperationV1, String> {
        let settlement_outcome = match outcome {
            SettlementExecutionOutcomeV1::Applied => "APPLIED",
            SettlementExecutionOutcomeV1::AlreadyApplied => "ALREADY_APPLIED",
            SettlementExecutionOutcomeV1::Conflict => {
                return Err("FORMAL_SWITCH_SETTLEMENT_CONFLICT".into())
            }
            SettlementExecutionOutcomeV1::Unknown => {
                return Err("FORMAL_SWITCH_SETTLEMENT_UNKNOWN".into())
            }
        };
        advance(
            connection,
            executable,
            "settlement_started",
            FormalSwitchOperationState {
                phase: "settlement_complete".into(),
                settlement_outcome: settlement_outcome.into(),
                db_outcome: "NOT_APPLIED".into(),
                activation_outcome: "PENDING".into(),
                terminal_code: None,
            },
            now_epoch_ms,
        )
    }

    pub(crate) fn complete_without_settlement(
        &self,
        connection: &Connection,
        executable: &ExecutableFormalSwitchOperationV1,
        now_epoch_ms: i64,
    ) -> Result<ExecutableFormalSwitchOperationV1, String> {
        advance(
            connection,
            executable,
            "prepared",
            FormalSwitchOperationState {
                phase: "settlement_complete".into(),
                settlement_outcome: "NOT_REQUIRED".into(),
                db_outcome: "NOT_APPLIED".into(),
                activation_outcome: "PENDING".into(),
                terminal_code: None,
            },
            now_epoch_ms,
        )
    }

    pub(crate) fn begin_db(
        &self,
        connection: &Connection,
        executable: &ExecutableFormalSwitchOperationV1,
        now_epoch_ms: i64,
    ) -> Result<ExecutableFormalSwitchOperationV1, String> {
        advance(
            connection,
            executable,
            "settlement_complete",
            FormalSwitchOperationState {
                phase: "db_pending".into(),
                settlement_outcome: executable.record.state.settlement_outcome.clone(),
                db_outcome: "NOT_APPLIED".into(),
                activation_outcome: "PENDING".into(),
                terminal_code: None,
            },
            now_epoch_ms,
        )
    }

    /// DB-only continuation is admitted exclusively from the durable
    /// `db_pending` phase with a completed settlement outcome. The immutable
    /// transaction payload is consumed as-is by the one canonical coordinator.
    pub(crate) fn continue_db_only(
        &self,
        connection: &mut Connection,
        executable: &ExecutableFormalSwitchOperationV1,
        coordinator: &CanonicalFormalSwitchTransactionCoordinatorV1,
        applier: &dyn FormalSwitchOwnerApplierV1,
        occurred_at: &str,
    ) -> Result<CanonicalTransactionResultV1, String> {
        verify_payload_integrity(&executable.record)?;
        if executable.record.state.phase != "db_pending"
            || !matches!(
                executable.record.state.settlement_outcome.as_str(),
                "NOT_REQUIRED" | "APPLIED" | "ALREADY_APPLIED"
            )
            || executable.record.state.db_outcome != "NOT_APPLIED"
            || executable.record.state.activation_outcome != "PENDING"
        {
            return Err("FORMAL_SWITCH_DB_ONLY_CONTINUATION_NOT_ADMISSIBLE".into());
        }
        match classify_durable_db_state(connection, executable, applier) {
            DurableDbClassificationV1::ExactCommitted => {
                Ok(CanonicalTransactionResultV1::AlreadyCommitted)
            }
            DurableDbClassificationV1::NotCommitted => {
                coordinator.execute(connection, executable, applier, occurred_at)
            }
            DurableDbClassificationV1::PartialOrInconsistent => {
                Ok(CanonicalTransactionResultV1::Inconsistent)
            }
            DurableDbClassificationV1::Unverifiable => {
                Err("FORMAL_SWITCH_DB_DURABLE_STATE_UNVERIFIABLE".into())
            }
        }
    }

    pub(crate) fn complete_db(
        &self,
        connection: &Connection,
        executable: &ExecutableFormalSwitchOperationV1,
        outcome: CanonicalTransactionResultV1,
        now_epoch_ms: i64,
    ) -> Result<ExecutableFormalSwitchOperationV1, String> {
        let db_outcome = match outcome {
            CanonicalTransactionResultV1::Committed => "COMMITTED",
            CanonicalTransactionResultV1::AlreadyCommitted => "ALREADY_COMMITTED",
            CanonicalTransactionResultV1::CasConflict => {
                return Err("FORMAL_SWITCH_DB_CAS_CONFLICT".into())
            }
            CanonicalTransactionResultV1::Inconsistent => {
                return Err("FORMAL_SWITCH_DB_INCONSISTENT".into())
            }
        };
        advance(
            connection,
            executable,
            "db_pending",
            FormalSwitchOperationState {
                phase: "db_complete".into(),
                settlement_outcome: executable.record.state.settlement_outcome.clone(),
                db_outcome: db_outcome.into(),
                activation_outcome: "PENDING".into(),
                terminal_code: None,
            },
            now_epoch_ms,
        )
    }

    pub(crate) fn begin_activation(
        &self,
        connection: &Connection,
        executable: &ExecutableFormalSwitchOperationV1,
        now_epoch_ms: i64,
    ) -> Result<ExecutableFormalSwitchOperationV1, String> {
        advance(
            connection,
            executable,
            "db_complete",
            FormalSwitchOperationState {
                phase: "activation_pending".into(),
                settlement_outcome: executable.record.state.settlement_outcome.clone(),
                db_outcome: executable.record.state.db_outcome.clone(),
                activation_outcome: "PENDING".into(),
                terminal_code: None,
            },
            now_epoch_ms,
        )
    }

    pub(crate) fn resolve(
        &self,
        connection: &Connection,
        executable: &ExecutableFormalSwitchOperationV1,
        activation: ActivationConvergenceOutcomeV1,
        now_epoch_ms: i64,
    ) -> Result<ExecutableFormalSwitchOperationV1, String> {
        resolve_after_activation(connection, executable, activation, now_epoch_ms)
    }
}

/// The one shared engine foundation. It is intentionally not registered with
/// any production owner during F2-1.
pub(crate) struct CanonicalFormalSwitchEngineV1 {
    pub(crate) transaction: CanonicalFormalSwitchTransactionCoordinatorV1,
    pub(crate) activation: CanonicalLocalActivationCoordinatorV1,
    pub(crate) recovery: CanonicalFormalSwitchRecoveryCoordinatorV1,
}

impl Default for CanonicalFormalSwitchEngineV1 {
    fn default() -> Self {
        Self {
            transaction: CanonicalFormalSwitchTransactionCoordinatorV1,
            activation: CanonicalLocalActivationCoordinatorV1::default(),
            recovery: CanonicalFormalSwitchRecoveryCoordinatorV1,
        }
    }
}
