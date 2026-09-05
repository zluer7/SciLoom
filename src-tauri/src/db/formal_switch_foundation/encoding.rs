use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};

pub(crate) const CANONICAL_ENCODING_VERSION: &str = "CanonicalEnvelopeEncodingV1";
pub(crate) const PAYLOAD_VERSION: u64 = 1;
pub(crate) const ENGINE_CONTRACT_VERSION: u64 = 1;

const TAG_ABSENT: u8 = 0x00;
const TAG_NULL: u8 = 0x01;
const TAG_FALSE: u8 = 0x02;
const TAG_TRUE: u8 = 0x03;
const TAG_STRING: u8 = 0x10;
const TAG_I64: u8 = 0x11;
const TAG_U64: u8 = 0x12;
const TAG_BYTES: u8 = 0x20;
const TAG_ARRAY: u8 = 0x30;
const TAG_OBJECT: u8 = 0x31;
const TAG_MAP: u8 = 0x32;

const ROOT_FIELDS: &[&str] = &[
    "operationId",
    "payloadVersion",
    "canonicalEncodingVersion",
    "engineContractVersion",
    "descriptorIdentity",
    "descriptorVersion",
    "descriptorHash",
    "candidateContractVersion",
    "settlementPlanVersion",
    "transactionPayloadVersion",
    "recoveryPayloadVersion",
    "ownerType",
    "ownerId",
    "manuscriptChannel",
    "entryKind",
    "ownerSubtype",
    "oldCurrentFileRefIdentity",
    "defaultFileRefIdentity",
    "targetFileRefIdentity",
    "oldCurrentLogicalSessionIdentity",
    "targetLogicalSessionIdentity",
    "candidate",
    "replacementDto",
    "ownerProtectedRowDigest",
    "bindingDigest",
    "lifecycleCoverageDigest",
    "oldCurrentExpectedPhysicalRevision",
    "settlementPlan",
    "transactionPayload",
    "successOperationLogId",
    "formalSwitchOperationId",
    "activationLogicalIdentity",
    "finalizationIdentity",
    "operationCustodyIdentity",
    "createdAtEpochMs",
];

const CANDIDATE_FIELDS: &[&str] = &[
    "fileRefIdentity",
    "physicalRevision",
    "sha256",
    "byteLength",
    "encoding",
];

const REPLACEMENT_FIELDS: &[&str] = &["stableKey", "value"];

const SETTLEMENT_FIELDS: &[&str] = &[
    "byteStart",
    "byteEnd",
    "expectedWholeFileHash",
    "expectedControlledRegionPreimageHash",
    "replacementBytes",
    "expectedWholeFilePostHash",
    "bomState",
    "lineEndingPolicy",
    "boundaryNewlineOwnership",
    "writeOnceOperationId",
];

const OWNER_TYPES: &[&str] = &[
    "experiment",
    "experimentRun",
    "literature",
    "review",
    "resultItem",
    "finding",
    "outputCandidate",
    "outputGap",
    "researchOutput",
];
const REVIEW_TYPES: &[&str] = &[
    "stage",
    "periodic",
    "experiment_comparison",
    "literature_comparison",
    "custom",
];
const ENTRY_KINDS: &[&str] = &["USER_CONFIRMED_SWITCH", "REPAIR_CONFIRMED_SWITCH"];
const CHANNELS: &[&str] = &["primary", "literature_outline", "dedicated_notes"];

macro_rules! string_enum {
    ($name:ident { $($variant:ident => $value:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub(crate) enum $name { $($variant),+ }

        impl $name {
            pub(crate) const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $value),+ }
            }

            fn parse(value: &str, error: &'static str) -> Result<Self, String> {
                match value { $($value => Ok(Self::$variant),)+ _ => Err(error.into()) }
            }
        }
    };
}

string_enum!(FormalSwitchOwnerType {
    Experiment => "experiment",
    ExperimentRun => "experimentRun",
    Literature => "literature",
    Review => "review",
    ResultItem => "resultItem",
    Finding => "finding",
    OutputCandidate => "outputCandidate",
    OutputGap => "outputGap",
    ResearchOutput => "researchOutput",
});

string_enum!(FormalSwitchManuscriptChannel {
    Primary => "primary",
    LiteratureOutline => "literature_outline",
    DedicatedNotes => "dedicated_notes",
});

string_enum!(FormalSwitchEntryKind {
    UserConfirmedSwitch => "USER_CONFIRMED_SWITCH",
    RepairConfirmedSwitch => "REPAIR_CONFIRMED_SWITCH",
});

string_enum!(FormalSwitchReviewType {
    Stage => "stage",
    Periodic => "periodic",
    ExperimentComparison => "experiment_comparison",
    LiteratureComparison => "literature_comparison",
    Custom => "custom",
});

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CandidateIdentityV1 {
    pub(crate) file_ref_identity: String,
    pub(crate) physical_revision: String,
    pub(crate) sha256: [u8; 32],
    pub(crate) byte_length: u64,
    pub(crate) encoding: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReplacementItemV1 {
    pub(crate) stable_key: String,
    pub(crate) value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SettlementPlanV1 {
    pub(crate) byte_start: u64,
    pub(crate) byte_end: u64,
    pub(crate) expected_whole_file_hash: [u8; 32],
    pub(crate) expected_controlled_region_preimage_hash: [u8; 32],
    pub(crate) replacement_bytes: Vec<u8>,
    pub(crate) expected_whole_file_post_hash: [u8; 32],
    pub(crate) bom_state: String,
    pub(crate) line_ending_policy: String,
    pub(crate) boundary_newline_ownership: String,
    pub(crate) write_once_operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FormalSwitchImmutableEnvelopeV1 {
    pub(crate) operation_id: String,
    pub(crate) payload_version: u64,
    pub(crate) canonical_encoding_version: String,
    pub(crate) engine_contract_version: u64,
    pub(crate) descriptor_identity: String,
    pub(crate) descriptor_version: u64,
    pub(crate) descriptor_hash: [u8; 32],
    pub(crate) candidate_contract_version: u64,
    pub(crate) settlement_plan_version: u64,
    pub(crate) transaction_payload_version: u64,
    pub(crate) recovery_payload_version: u64,
    pub(crate) owner_type: FormalSwitchOwnerType,
    pub(crate) owner_id: String,
    pub(crate) manuscript_channel: FormalSwitchManuscriptChannel,
    pub(crate) entry_kind: FormalSwitchEntryKind,
    pub(crate) owner_subtype: Option<FormalSwitchReviewType>,
    pub(crate) old_current_file_ref_identity: String,
    pub(crate) default_file_ref_identity: String,
    pub(crate) target_file_ref_identity: String,
    pub(crate) old_current_logical_session_identity: String,
    pub(crate) target_logical_session_identity: String,
    pub(crate) candidate: CandidateIdentityV1,
    pub(crate) replacement_dto: Vec<ReplacementItemV1>,
    pub(crate) owner_protected_row_digest: [u8; 32],
    pub(crate) binding_digest: [u8; 32],
    pub(crate) lifecycle_coverage_digest: [u8; 32],
    pub(crate) old_current_expected_physical_revision: String,
    pub(crate) settlement_plan: SettlementPlanV1,
    pub(crate) transaction_payload: Vec<u8>,
    pub(crate) success_operation_log_id: String,
    pub(crate) formal_switch_operation_id: String,
    pub(crate) activation_logical_identity: String,
    pub(crate) finalization_identity: String,
    pub(crate) operation_custody_identity: String,
    pub(crate) created_at_epoch_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FormalSwitchEnvelopeProjection {
    pub(crate) operation_id: String,
    pub(crate) owner_type: String,
    pub(crate) owner_id: String,
    pub(crate) manuscript_channel: String,
    pub(crate) entry_kind: String,
    pub(crate) owner_subtype: String,
    pub(crate) payload_version: i64,
    pub(crate) canonical_encoding_version: String,
    pub(crate) engine_contract_version: i64,
    pub(crate) descriptor_identity: String,
    pub(crate) descriptor_version: i64,
    pub(crate) descriptor_hash: Vec<u8>,
    pub(crate) candidate_contract_version: i64,
    pub(crate) settlement_plan_version: i64,
    pub(crate) transaction_payload_version: i64,
    pub(crate) recovery_payload_version: i64,
    pub(crate) created_at_epoch_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FormalSwitchAttemptMetadataV1 {
    pub(crate) attempt_count: u64,
    pub(crate) last_attempt_at_epoch_ms: i64,
    pub(crate) last_process_generation: String,
    pub(crate) last_consumer_classification: String,
    pub(crate) last_observed_phase_revision: u64,
    pub(crate) last_typed_failure: Option<String>,
}

impl FormalSwitchImmutableEnvelopeV1 {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.operation_id.is_empty()
            || self.owner_id.is_empty()
            || self.formal_switch_operation_id != self.operation_id
            || self.settlement_plan.write_once_operation_id != self.operation_id
        {
            return Err("CANONICAL_OPERATION_IDENTITY_MISMATCH".into());
        }
        if self.payload_version != PAYLOAD_VERSION
            || self.engine_contract_version != ENGINE_CONTRACT_VERSION
            || self.candidate_contract_version != 1
            || self.settlement_plan_version != 1
            || self.transaction_payload_version != 1
            || self.recovery_payload_version != 1
            || self.canonical_encoding_version != CANONICAL_ENCODING_VERSION
        {
            return Err("CANONICAL_CONTRACT_VERSION_UNKNOWN".into());
        }
        match self.owner_type {
            FormalSwitchOwnerType::Literature => {
                if !matches!(
                    self.manuscript_channel,
                    FormalSwitchManuscriptChannel::LiteratureOutline
                        | FormalSwitchManuscriptChannel::DedicatedNotes
                ) {
                    return Err("CANONICAL_OWNER_CHANNEL_MISMATCH".into());
                }
            }
            _ if self.manuscript_channel != FormalSwitchManuscriptChannel::Primary => {
                return Err("CANONICAL_OWNER_CHANNEL_MISMATCH".into())
            }
            _ => {}
        }
        if self.owner_type == FormalSwitchOwnerType::Review {
            if self.owner_subtype.is_none() {
                return Err("CANONICAL_REVIEW_TYPE_REQUIRED".into());
            }
        } else if self.owner_subtype.is_some() {
            return Err("CANONICAL_REVIEW_TYPE_FORBIDDEN".into());
        }
        if self.descriptor_identity.is_empty()
            || self.descriptor_version == 0
            || self.old_current_file_ref_identity.is_empty()
            || self.default_file_ref_identity.is_empty()
            || self.target_file_ref_identity.is_empty()
            || self.old_current_logical_session_identity.is_empty()
            || self.target_logical_session_identity.is_empty()
            || self.candidate.file_ref_identity.is_empty()
            || self.candidate.physical_revision.is_empty()
            || self.candidate.encoding.is_empty()
            || self.old_current_expected_physical_revision.is_empty()
            || self.success_operation_log_id.is_empty()
            || self.activation_logical_identity.is_empty()
            || self.finalization_identity.is_empty()
            || self.operation_custody_identity.is_empty()
            || self
                .replacement_dto
                .iter()
                .any(|item| item.stable_key.is_empty())
        {
            return Err("CANONICAL_REQUIRED_IDENTITY_MISSING".into());
        }
        if self.settlement_plan.byte_start > self.settlement_plan.byte_end {
            return Err("CANONICAL_SETTLEMENT_RANGE_INVALID".into());
        }
        if !matches!(
            self.settlement_plan.bom_state.as_str(),
            "ABSENT" | "UTF8_BOM"
        ) || self.settlement_plan.line_ending_policy != "PRESERVE_SNAPSHOT_EXACT"
            || !matches!(
                self.settlement_plan.boundary_newline_ownership.as_str(),
                "NONE" | "LEADING" | "TRAILING" | "BOTH"
            )
        {
            return Err("CANONICAL_SETTLEMENT_CONTRACT_INVALID".into());
        }
        Ok(())
    }

    pub(crate) fn projection(&self) -> Result<FormalSwitchEnvelopeProjection, String> {
        self.validate()?;
        Ok(FormalSwitchEnvelopeProjection {
            operation_id: self.operation_id.clone(),
            owner_type: self.owner_type.as_str().into(),
            owner_id: self.owner_id.clone(),
            manuscript_channel: self.manuscript_channel.as_str().into(),
            entry_kind: self.entry_kind.as_str().into(),
            owner_subtype: self
                .owner_subtype
                .map(FormalSwitchReviewType::as_str)
                .unwrap_or_default()
                .into(),
            payload_version: i64::try_from(self.payload_version)
                .map_err(|_| "CANONICAL_VERSION_RANGE")?,
            canonical_encoding_version: self.canonical_encoding_version.clone(),
            engine_contract_version: i64::try_from(self.engine_contract_version)
                .map_err(|_| "CANONICAL_VERSION_RANGE")?,
            descriptor_identity: self.descriptor_identity.clone(),
            descriptor_version: i64::try_from(self.descriptor_version)
                .map_err(|_| "CANONICAL_VERSION_RANGE")?,
            descriptor_hash: self.descriptor_hash.to_vec(),
            candidate_contract_version: i64::try_from(self.candidate_contract_version)
                .map_err(|_| "CANONICAL_VERSION_RANGE")?,
            settlement_plan_version: i64::try_from(self.settlement_plan_version)
                .map_err(|_| "CANONICAL_VERSION_RANGE")?,
            transaction_payload_version: i64::try_from(self.transaction_payload_version)
                .map_err(|_| "CANONICAL_VERSION_RANGE")?,
            recovery_payload_version: i64::try_from(self.recovery_payload_version)
                .map_err(|_| "CANONICAL_VERSION_RANGE")?,
            created_at_epoch_ms: self.created_at_epoch_ms,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CanonicalValue {
    Absent,
    Null,
    Bool(bool),
    String(String),
    I64(i64),
    U64(u64),
    Bytes(Vec<u8>),
    Array(Vec<CanonicalValue>),
    Object(Vec<(String, CanonicalValue)>),
    Map(BTreeMap<String, CanonicalValue>),
}

fn push_u64(output: &mut Vec<u8>, value: u64) {
    output.extend_from_slice(&value.to_be_bytes());
}

fn push_string(output: &mut Vec<u8>, value: &str) {
    output.push(TAG_STRING);
    push_u64(output, value.as_bytes().len() as u64);
    output.extend_from_slice(value.as_bytes());
}

fn push_bytes(output: &mut Vec<u8>, value: &[u8]) {
    output.push(TAG_BYTES);
    push_u64(output, value.len() as u64);
    output.extend_from_slice(value);
}

pub(crate) fn encode_canonical_value(
    output: &mut Vec<u8>,
    value: &CanonicalValue,
) -> Result<(), String> {
    match value {
        CanonicalValue::Absent => output.push(TAG_ABSENT),
        CanonicalValue::Null => output.push(TAG_NULL),
        CanonicalValue::Bool(false) => output.push(TAG_FALSE),
        CanonicalValue::Bool(true) => output.push(TAG_TRUE),
        CanonicalValue::String(value) => push_string(output, value),
        CanonicalValue::I64(value) => {
            output.push(TAG_I64);
            output.extend_from_slice(&value.to_be_bytes());
        }
        CanonicalValue::U64(value) => {
            output.push(TAG_U64);
            output.extend_from_slice(&value.to_be_bytes());
        }
        CanonicalValue::Bytes(value) => push_bytes(output, value),
        CanonicalValue::Array(values) => {
            output.push(TAG_ARRAY);
            push_u64(output, values.len() as u64);
            for value in values {
                encode_canonical_value(output, value)?;
            }
        }
        CanonicalValue::Object(fields) => {
            let mut seen = HashSet::new();
            output.push(TAG_OBJECT);
            push_u64(output, fields.len() as u64);
            for (name, value) in fields {
                if !seen.insert(name.as_str()) {
                    return Err("CANONICAL_DUPLICATE_FIELD".into());
                }
                push_string(output, name);
                encode_canonical_value(output, value)?;
            }
        }
        CanonicalValue::Map(entries) => {
            output.push(TAG_MAP);
            push_u64(output, entries.len() as u64);
            let mut sorted = entries.iter().collect::<Vec<_>>();
            sorted.sort_by(|(left, _), (right, _)| {
                left.as_bytes().iter().cmp(right.as_bytes().iter())
            });
            for (name, value) in sorted {
                push_string(output, name);
                encode_canonical_value(output, value)?;
            }
        }
    }
    Ok(())
}

fn object(fields: impl IntoIterator<Item = (&'static str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        fields
            .into_iter()
            .map(|(name, value)| (name.to_string(), value))
            .collect(),
    )
}

fn bytes32(value: &[u8; 32]) -> CanonicalValue {
    CanonicalValue::Bytes(value.to_vec())
}

fn envelope_value(envelope: &FormalSwitchImmutableEnvelopeV1) -> CanonicalValue {
    object([
        (
            "operationId",
            CanonicalValue::String(envelope.operation_id.clone()),
        ),
        (
            "payloadVersion",
            CanonicalValue::U64(envelope.payload_version),
        ),
        (
            "canonicalEncodingVersion",
            CanonicalValue::String(envelope.canonical_encoding_version.clone()),
        ),
        (
            "engineContractVersion",
            CanonicalValue::U64(envelope.engine_contract_version),
        ),
        (
            "descriptorIdentity",
            CanonicalValue::String(envelope.descriptor_identity.clone()),
        ),
        (
            "descriptorVersion",
            CanonicalValue::U64(envelope.descriptor_version),
        ),
        ("descriptorHash", bytes32(&envelope.descriptor_hash)),
        (
            "candidateContractVersion",
            CanonicalValue::U64(envelope.candidate_contract_version),
        ),
        (
            "settlementPlanVersion",
            CanonicalValue::U64(envelope.settlement_plan_version),
        ),
        (
            "transactionPayloadVersion",
            CanonicalValue::U64(envelope.transaction_payload_version),
        ),
        (
            "recoveryPayloadVersion",
            CanonicalValue::U64(envelope.recovery_payload_version),
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
            "entryKind",
            CanonicalValue::String(envelope.entry_kind.as_str().into()),
        ),
        (
            "ownerSubtype",
            envelope
                .owner_subtype
                .map(|value| CanonicalValue::String(value.as_str().into()))
                .unwrap_or(CanonicalValue::Absent),
        ),
        (
            "oldCurrentFileRefIdentity",
            CanonicalValue::String(envelope.old_current_file_ref_identity.clone()),
        ),
        (
            "defaultFileRefIdentity",
            CanonicalValue::String(envelope.default_file_ref_identity.clone()),
        ),
        (
            "targetFileRefIdentity",
            CanonicalValue::String(envelope.target_file_ref_identity.clone()),
        ),
        (
            "oldCurrentLogicalSessionIdentity",
            CanonicalValue::String(envelope.old_current_logical_session_identity.clone()),
        ),
        (
            "targetLogicalSessionIdentity",
            CanonicalValue::String(envelope.target_logical_session_identity.clone()),
        ),
        (
            "candidate",
            object([
                (
                    "fileRefIdentity",
                    CanonicalValue::String(envelope.candidate.file_ref_identity.clone()),
                ),
                (
                    "physicalRevision",
                    CanonicalValue::String(envelope.candidate.physical_revision.clone()),
                ),
                ("sha256", bytes32(&envelope.candidate.sha256)),
                (
                    "byteLength",
                    CanonicalValue::U64(envelope.candidate.byte_length),
                ),
                (
                    "encoding",
                    CanonicalValue::String(envelope.candidate.encoding.clone()),
                ),
            ]),
        ),
        (
            "replacementDto",
            CanonicalValue::Array(
                envelope
                    .replacement_dto
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
            ),
        ),
        (
            "ownerProtectedRowDigest",
            bytes32(&envelope.owner_protected_row_digest),
        ),
        ("bindingDigest", bytes32(&envelope.binding_digest)),
        (
            "lifecycleCoverageDigest",
            bytes32(&envelope.lifecycle_coverage_digest),
        ),
        (
            "oldCurrentExpectedPhysicalRevision",
            CanonicalValue::String(envelope.old_current_expected_physical_revision.clone()),
        ),
        (
            "settlementPlan",
            object([
                (
                    "byteStart",
                    CanonicalValue::U64(envelope.settlement_plan.byte_start),
                ),
                (
                    "byteEnd",
                    CanonicalValue::U64(envelope.settlement_plan.byte_end),
                ),
                (
                    "expectedWholeFileHash",
                    bytes32(&envelope.settlement_plan.expected_whole_file_hash),
                ),
                (
                    "expectedControlledRegionPreimageHash",
                    bytes32(
                        &envelope
                            .settlement_plan
                            .expected_controlled_region_preimage_hash,
                    ),
                ),
                (
                    "replacementBytes",
                    CanonicalValue::Bytes(envelope.settlement_plan.replacement_bytes.clone()),
                ),
                (
                    "expectedWholeFilePostHash",
                    bytes32(&envelope.settlement_plan.expected_whole_file_post_hash),
                ),
                (
                    "bomState",
                    CanonicalValue::String(envelope.settlement_plan.bom_state.clone()),
                ),
                (
                    "lineEndingPolicy",
                    CanonicalValue::String(envelope.settlement_plan.line_ending_policy.clone()),
                ),
                (
                    "boundaryNewlineOwnership",
                    CanonicalValue::String(
                        envelope.settlement_plan.boundary_newline_ownership.clone(),
                    ),
                ),
                (
                    "writeOnceOperationId",
                    CanonicalValue::String(
                        envelope.settlement_plan.write_once_operation_id.clone(),
                    ),
                ),
            ]),
        ),
        (
            "transactionPayload",
            CanonicalValue::Bytes(envelope.transaction_payload.clone()),
        ),
        (
            "successOperationLogId",
            CanonicalValue::String(envelope.success_operation_log_id.clone()),
        ),
        (
            "formalSwitchOperationId",
            CanonicalValue::String(envelope.formal_switch_operation_id.clone()),
        ),
        (
            "activationLogicalIdentity",
            CanonicalValue::String(envelope.activation_logical_identity.clone()),
        ),
        (
            "finalizationIdentity",
            CanonicalValue::String(envelope.finalization_identity.clone()),
        ),
        (
            "operationCustodyIdentity",
            CanonicalValue::String(envelope.operation_custody_identity.clone()),
        ),
        (
            "createdAtEpochMs",
            CanonicalValue::I64(envelope.created_at_epoch_ms),
        ),
    ])
}

pub(crate) fn encode_envelope(
    envelope: &FormalSwitchImmutableEnvelopeV1,
) -> Result<Vec<u8>, String> {
    envelope.validate()?;
    let mut output = Vec::new();
    push_string(&mut output, CANONICAL_ENCODING_VERSION);
    encode_canonical_value(&mut output, &envelope_value(envelope))?;
    Ok(output)
}

struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }
    fn byte(&mut self) -> Result<u8, String> {
        let value = *self.bytes.get(self.offset).ok_or("CANONICAL_TRUNCATED")?;
        self.offset += 1;
        Ok(value)
    }
    fn take(&mut self, length: usize) -> Result<&'a [u8], String> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or("CANONICAL_LENGTH_RANGE")?;
        let value = self
            .bytes
            .get(self.offset..end)
            .ok_or("CANONICAL_TRUNCATED")?;
        self.offset = end;
        Ok(value)
    }
    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_be_bytes(
            self.take(8)?
                .try_into()
                .map_err(|_| "CANONICAL_TRUNCATED")?,
        ))
    }
    fn i64(&mut self) -> Result<i64, String> {
        Ok(i64::from_be_bytes(
            self.take(8)?
                .try_into()
                .map_err(|_| "CANONICAL_TRUNCATED")?,
        ))
    }
    fn done(&self) -> Result<(), String> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err("CANONICAL_TRAILING_BYTES".into())
        }
    }
}

fn expect_tag(cursor: &mut Cursor<'_>, tag: u8) -> Result<(), String> {
    let actual = cursor.byte()?;
    if actual == tag {
        Ok(())
    } else {
        Err(format!("CANONICAL_TAG_MISMATCH:{tag}:{actual}"))
    }
}

fn read_len(cursor: &mut Cursor<'_>) -> Result<usize, String> {
    usize::try_from(cursor.u64()?).map_err(|_| "CANONICAL_LENGTH_RANGE".into())
}

fn read_string(cursor: &mut Cursor<'_>) -> Result<String, String> {
    expect_tag(cursor, TAG_STRING)?;
    let length = read_len(cursor)?;
    String::from_utf8(cursor.take(length)?.to_vec()).map_err(|_| "CANONICAL_UTF8_INVALID".into())
}

fn read_bytes(cursor: &mut Cursor<'_>) -> Result<Vec<u8>, String> {
    expect_tag(cursor, TAG_BYTES)?;
    let length = read_len(cursor)?;
    Ok(cursor.take(length)?.to_vec())
}

fn read_bytes32(cursor: &mut Cursor<'_>) -> Result<[u8; 32], String> {
    read_bytes(cursor)?
        .try_into()
        .map_err(|_| "CANONICAL_BYTES32_REQUIRED".into())
}

fn begin_object(cursor: &mut Cursor<'_>, fields: &[&str]) -> Result<(), String> {
    expect_tag(cursor, TAG_OBJECT)?;
    if read_len(cursor)? != fields.len() {
        return Err("CANONICAL_OBJECT_FIELD_COUNT".into());
    }
    Ok(())
}

fn expect_field(cursor: &mut Cursor<'_>, expected: &str) -> Result<(), String> {
    let actual = read_string(cursor)?;
    if actual == expected {
        Ok(())
    } else {
        Err(format!("CANONICAL_OBJECT_FIELD_ORDER:{expected}:{actual}"))
    }
}

pub(crate) fn decode_envelope(bytes: &[u8]) -> Result<FormalSwitchImmutableEnvelopeV1, String> {
    let mut cursor = Cursor::new(bytes);
    if read_string(&mut cursor)? != CANONICAL_ENCODING_VERSION {
        return Err("CANONICAL_ENCODING_VERSION_UNKNOWN".into());
    }
    begin_object(&mut cursor, ROOT_FIELDS)?;
    macro_rules! next {
        ($expected:expr) => {
            expect_field(&mut cursor, $expected)
        };
    }
    next!("operationId")?;
    let operation_id = read_string(&mut cursor)?;
    next!("payloadVersion")?;
    expect_tag(&mut cursor, TAG_U64)?;
    let payload_version = cursor.u64()?;
    next!("canonicalEncodingVersion")?;
    let canonical_encoding_version = read_string(&mut cursor)?;
    next!("engineContractVersion")?;
    expect_tag(&mut cursor, TAG_U64)?;
    let engine_contract_version = cursor.u64()?;
    next!("descriptorIdentity")?;
    let descriptor_identity = read_string(&mut cursor)?;
    next!("descriptorVersion")?;
    expect_tag(&mut cursor, TAG_U64)?;
    let descriptor_version = cursor.u64()?;
    next!("descriptorHash")?;
    let descriptor_hash = read_bytes32(&mut cursor)?;
    next!("candidateContractVersion")?;
    expect_tag(&mut cursor, TAG_U64)?;
    let candidate_contract_version = cursor.u64()?;
    next!("settlementPlanVersion")?;
    expect_tag(&mut cursor, TAG_U64)?;
    let settlement_plan_version = cursor.u64()?;
    next!("transactionPayloadVersion")?;
    expect_tag(&mut cursor, TAG_U64)?;
    let transaction_payload_version = cursor.u64()?;
    next!("recoveryPayloadVersion")?;
    expect_tag(&mut cursor, TAG_U64)?;
    let recovery_payload_version = cursor.u64()?;
    next!("ownerType")?;
    let owner_type =
        FormalSwitchOwnerType::parse(&read_string(&mut cursor)?, "CANONICAL_OWNER_TYPE_UNKNOWN")?;
    next!("ownerId")?;
    let owner_id = read_string(&mut cursor)?;
    next!("manuscriptChannel")?;
    let manuscript_channel = FormalSwitchManuscriptChannel::parse(
        &read_string(&mut cursor)?,
        "CANONICAL_MANUSCRIPT_CHANNEL_UNKNOWN",
    )?;
    next!("entryKind")?;
    let entry_kind =
        FormalSwitchEntryKind::parse(&read_string(&mut cursor)?, "CANONICAL_ENTRY_KIND_UNKNOWN")?;
    next!("ownerSubtype")?;
    let owner_subtype = match cursor.byte()? {
        TAG_ABSENT => None,
        TAG_STRING => {
            let length = read_len(&mut cursor)?;
            let value = String::from_utf8(cursor.take(length)?.to_vec())
                .map_err(|_| "CANONICAL_UTF8_INVALID")?;
            Some(FormalSwitchReviewType::parse(
                &value,
                "CANONICAL_REVIEW_TYPE_UNKNOWN",
            )?)
        }
        _ => return Err("CANONICAL_OWNER_SUBTYPE_TAG".into()),
    };
    next!("oldCurrentFileRefIdentity")?;
    let old_current_file_ref_identity = read_string(&mut cursor)?;
    next!("defaultFileRefIdentity")?;
    let default_file_ref_identity = read_string(&mut cursor)?;
    next!("targetFileRefIdentity")?;
    let target_file_ref_identity = read_string(&mut cursor)?;
    next!("oldCurrentLogicalSessionIdentity")?;
    let old_current_logical_session_identity = read_string(&mut cursor)?;
    next!("targetLogicalSessionIdentity")?;
    let target_logical_session_identity = read_string(&mut cursor)?;
    next!("candidate")?;
    begin_object(&mut cursor, CANDIDATE_FIELDS)?;
    expect_field(&mut cursor, "fileRefIdentity")?;
    let candidate_file_ref_identity = read_string(&mut cursor)?;
    expect_field(&mut cursor, "physicalRevision")?;
    let physical_revision = read_string(&mut cursor)?;
    expect_field(&mut cursor, "sha256")?;
    let candidate_sha256 = read_bytes32(&mut cursor)?;
    expect_field(&mut cursor, "byteLength")?;
    expect_tag(&mut cursor, TAG_U64)?;
    let candidate_byte_length = cursor.u64()?;
    expect_field(&mut cursor, "encoding")?;
    let candidate_encoding = read_string(&mut cursor)?;
    next!("replacementDto")?;
    expect_tag(&mut cursor, TAG_ARRAY)?;
    let replacement_count = read_len(&mut cursor)?;
    let mut replacement_dto = Vec::with_capacity(replacement_count);
    for _ in 0..replacement_count {
        begin_object(&mut cursor, REPLACEMENT_FIELDS)?;
        expect_field(&mut cursor, "stableKey")?;
        let stable_key = read_string(&mut cursor)?;
        expect_field(&mut cursor, "value")?;
        let value = match cursor.byte()? {
            TAG_NULL => None,
            TAG_STRING => {
                let length = read_len(&mut cursor)?;
                Some(
                    String::from_utf8(cursor.take(length)?.to_vec())
                        .map_err(|_| "CANONICAL_UTF8_INVALID")?,
                )
            }
            _ => return Err("CANONICAL_REPLACEMENT_VALUE_TAG".into()),
        };
        replacement_dto.push(ReplacementItemV1 { stable_key, value });
    }
    next!("ownerProtectedRowDigest")?;
    let owner_protected_row_digest = read_bytes32(&mut cursor)?;
    next!("bindingDigest")?;
    let binding_digest = read_bytes32(&mut cursor)?;
    next!("lifecycleCoverageDigest")?;
    let lifecycle_coverage_digest = read_bytes32(&mut cursor)?;
    next!("oldCurrentExpectedPhysicalRevision")?;
    let old_current_expected_physical_revision = read_string(&mut cursor)?;
    next!("settlementPlan")?;
    begin_object(&mut cursor, SETTLEMENT_FIELDS)?;
    expect_field(&mut cursor, "byteStart")?;
    expect_tag(&mut cursor, TAG_U64)?;
    let byte_start = cursor.u64()?;
    expect_field(&mut cursor, "byteEnd")?;
    expect_tag(&mut cursor, TAG_U64)?;
    let byte_end = cursor.u64()?;
    expect_field(&mut cursor, "expectedWholeFileHash")?;
    let expected_whole_file_hash = read_bytes32(&mut cursor)?;
    expect_field(&mut cursor, "expectedControlledRegionPreimageHash")?;
    let expected_controlled_region_preimage_hash = read_bytes32(&mut cursor)?;
    expect_field(&mut cursor, "replacementBytes")?;
    let replacement_bytes = read_bytes(&mut cursor)?;
    expect_field(&mut cursor, "expectedWholeFilePostHash")?;
    let expected_whole_file_post_hash = read_bytes32(&mut cursor)?;
    expect_field(&mut cursor, "bomState")?;
    let bom_state = read_string(&mut cursor)?;
    expect_field(&mut cursor, "lineEndingPolicy")?;
    let line_ending_policy = read_string(&mut cursor)?;
    expect_field(&mut cursor, "boundaryNewlineOwnership")?;
    let boundary_newline_ownership = read_string(&mut cursor)?;
    expect_field(&mut cursor, "writeOnceOperationId")?;
    let write_once_operation_id = read_string(&mut cursor)?;
    next!("transactionPayload")?;
    let transaction_payload = read_bytes(&mut cursor)?;
    next!("successOperationLogId")?;
    let success_operation_log_id = read_string(&mut cursor)?;
    next!("formalSwitchOperationId")?;
    let formal_switch_operation_id = read_string(&mut cursor)?;
    next!("activationLogicalIdentity")?;
    let activation_logical_identity = read_string(&mut cursor)?;
    next!("finalizationIdentity")?;
    let finalization_identity = read_string(&mut cursor)?;
    next!("operationCustodyIdentity")?;
    let operation_custody_identity = read_string(&mut cursor)?;
    next!("createdAtEpochMs")?;
    expect_tag(&mut cursor, TAG_I64)?;
    let created_at_epoch_ms = cursor.i64()?;
    cursor.done()?;
    let envelope = FormalSwitchImmutableEnvelopeV1 {
        operation_id,
        payload_version,
        canonical_encoding_version,
        engine_contract_version,
        descriptor_identity,
        descriptor_version,
        descriptor_hash,
        candidate_contract_version,
        settlement_plan_version,
        transaction_payload_version,
        recovery_payload_version,
        owner_type,
        owner_id,
        manuscript_channel,
        entry_kind,
        owner_subtype,
        old_current_file_ref_identity,
        default_file_ref_identity,
        target_file_ref_identity,
        old_current_logical_session_identity,
        target_logical_session_identity,
        candidate: CandidateIdentityV1 {
            file_ref_identity: candidate_file_ref_identity,
            physical_revision,
            sha256: candidate_sha256,
            byte_length: candidate_byte_length,
            encoding: candidate_encoding,
        },
        replacement_dto,
        owner_protected_row_digest,
        binding_digest,
        lifecycle_coverage_digest,
        old_current_expected_physical_revision,
        settlement_plan: SettlementPlanV1 {
            byte_start,
            byte_end,
            expected_whole_file_hash,
            expected_controlled_region_preimage_hash,
            replacement_bytes,
            expected_whole_file_post_hash,
            bom_state,
            line_ending_policy,
            boundary_newline_ownership,
            write_once_operation_id,
        },
        transaction_payload,
        success_operation_log_id,
        formal_switch_operation_id,
        activation_logical_identity,
        finalization_identity,
        operation_custody_identity,
        created_at_epoch_ms,
    };
    envelope.validate()?;
    Ok(envelope)
}

pub(crate) fn verify_canonical_bytes(
    bytes: &[u8],
) -> Result<FormalSwitchImmutableEnvelopeV1, String> {
    let envelope = decode_envelope(bytes)?;
    if encode_envelope(&envelope)? != bytes {
        return Err("CANONICAL_REENCODE_MISMATCH".into());
    }
    Ok(envelope)
}

pub(crate) fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub(crate) fn encode_attempt_metadata(
    metadata: &FormalSwitchAttemptMetadataV1,
) -> Result<Vec<u8>, String> {
    if metadata.attempt_count > 1_000_000
        || metadata.last_process_generation.is_empty()
        || metadata.last_process_generation.len() > 128
        || metadata.last_consumer_classification.is_empty()
        || metadata.last_consumer_classification.len() > 64
        || metadata
            .last_typed_failure
            .as_ref()
            .is_some_and(|value| value.len() > 128)
    {
        return Err("FORMAL_SWITCH_ATTEMPT_METADATA_INVALID".into());
    }
    let value = object([
        ("attemptMetadataVersion", CanonicalValue::U64(1)),
        ("attemptCount", CanonicalValue::U64(metadata.attempt_count)),
        (
            "lastAttemptAtEpochMs",
            CanonicalValue::I64(metadata.last_attempt_at_epoch_ms),
        ),
        (
            "lastProcessGeneration",
            CanonicalValue::String(metadata.last_process_generation.clone()),
        ),
        (
            "lastConsumerClassification",
            CanonicalValue::String(metadata.last_consumer_classification.clone()),
        ),
        (
            "lastObservedPhaseRevision",
            CanonicalValue::U64(metadata.last_observed_phase_revision),
        ),
        (
            "lastTypedFailure",
            metadata
                .last_typed_failure
                .clone()
                .map(CanonicalValue::String)
                .unwrap_or(CanonicalValue::Absent),
        ),
    ]);
    let mut bytes = Vec::new();
    push_string(&mut bytes, CANONICAL_ENCODING_VERSION);
    encode_canonical_value(&mut bytes, &value)?;
    if bytes.len() > 512 {
        return Err("FORMAL_SWITCH_ATTEMPT_METADATA_OVERSIZE".into());
    }
    Ok(bytes)
}

pub(crate) fn decode_attempt_metadata(
    bytes: &[u8],
) -> Result<FormalSwitchAttemptMetadataV1, String> {
    if bytes.len() > 512 {
        return Err("FORMAL_SWITCH_ATTEMPT_METADATA_OVERSIZE".into());
    }
    let mut cursor = Cursor::new(bytes);
    if read_string(&mut cursor)? != CANONICAL_ENCODING_VERSION {
        return Err("CANONICAL_ENCODING_VERSION_UNKNOWN".into());
    }
    const FIELDS: &[&str] = &[
        "attemptMetadataVersion",
        "attemptCount",
        "lastAttemptAtEpochMs",
        "lastProcessGeneration",
        "lastConsumerClassification",
        "lastObservedPhaseRevision",
        "lastTypedFailure",
    ];
    begin_object(&mut cursor, FIELDS)?;
    expect_field(&mut cursor, FIELDS[0])?;
    expect_tag(&mut cursor, TAG_U64)?;
    if cursor.u64()? != 1 {
        return Err("FORMAL_SWITCH_ATTEMPT_METADATA_VERSION_UNKNOWN".into());
    }
    expect_field(&mut cursor, FIELDS[1])?;
    expect_tag(&mut cursor, TAG_U64)?;
    let attempt_count = cursor.u64()?;
    expect_field(&mut cursor, FIELDS[2])?;
    expect_tag(&mut cursor, TAG_I64)?;
    let last_attempt_at_epoch_ms = cursor.i64()?;
    expect_field(&mut cursor, FIELDS[3])?;
    let last_process_generation = read_string(&mut cursor)?;
    expect_field(&mut cursor, FIELDS[4])?;
    let last_consumer_classification = read_string(&mut cursor)?;
    expect_field(&mut cursor, FIELDS[5])?;
    expect_tag(&mut cursor, TAG_U64)?;
    let last_observed_phase_revision = cursor.u64()?;
    expect_field(&mut cursor, FIELDS[6])?;
    let last_typed_failure = match cursor.byte()? {
        TAG_ABSENT => None,
        TAG_STRING => {
            let length = read_len(&mut cursor)?;
            Some(
                String::from_utf8(cursor.take(length)?.to_vec())
                    .map_err(|_| "CANONICAL_UTF8_INVALID")?,
            )
        }
        _ => return Err("FORMAL_SWITCH_ATTEMPT_METADATA_FIELD_INVALID".into()),
    };
    cursor.done()?;
    let metadata = FormalSwitchAttemptMetadataV1 {
        attempt_count,
        last_attempt_at_epoch_ms,
        last_process_generation,
        last_consumer_classification,
        last_observed_phase_revision,
        last_typed_failure,
    };
    if encode_attempt_metadata(&metadata)? != bytes {
        return Err("CANONICAL_REENCODE_MISMATCH".into());
    }
    Ok(metadata)
}

pub(crate) fn validate_normative_registry() -> Result<(), String> {
    let registry: JsonValue = serde_json::from_str(include_str!(
        "../../../../src/contracts/formalSwitchCanonicalEnvelopeEncodingV1.json"
    ))
    .map_err(|_| "CANONICAL_REGISTRY_INVALID_JSON")?;
    if registry.pointer("/registryId").and_then(JsonValue::as_str)
        != Some(CANONICAL_ENCODING_VERSION)
        || registry
            .pointer("/root/versionPrefix")
            .and_then(JsonValue::as_str)
            != Some(CANONICAL_ENCODING_VERSION)
    {
        return Err("CANONICAL_REGISTRY_IDENTITY_MISMATCH".into());
    }
    let expected_tags = [
        ("absent", TAG_ABSENT),
        ("null", TAG_NULL),
        ("false", TAG_FALSE),
        ("true", TAG_TRUE),
        ("string", TAG_STRING),
        ("i64", TAG_I64),
        ("u64", TAG_U64),
        ("bytes", TAG_BYTES),
        ("array", TAG_ARRAY),
        ("object", TAG_OBJECT),
        ("map", TAG_MAP),
    ];
    let mut values = HashSet::new();
    for (name, expected) in expected_tags {
        let value = registry
            .pointer(&format!("/tags/{name}"))
            .and_then(JsonValue::as_u64);
        if value != Some(u64::from(expected)) || !values.insert(expected) {
            return Err(format!("CANONICAL_REGISTRY_TAG_MISMATCH:{name}"));
        }
    }
    let fields = registry
        .pointer("/root/fields")
        .and_then(JsonValue::as_array)
        .ok_or("CANONICAL_REGISTRY_ROOT_MISSING")?;
    let actual = fields
        .iter()
        .map(|field| {
            field
                .get("name")
                .and_then(JsonValue::as_str)
                .ok_or("CANONICAL_REGISTRY_FIELD_NAME_MISSING")
        })
        .collect::<Result<Vec<_>, _>>()?;
    if actual != ROOT_FIELDS {
        return Err("CANONICAL_REGISTRY_ROOT_FIELD_MISMATCH".into());
    }
    for (name, expected) in [
        ("ownerType", OWNER_TYPES),
        ("manuscriptChannel", CHANNELS),
        ("entryKind", ENTRY_KINDS),
        ("reviewType", REVIEW_TYPES),
    ] {
        let actual = registry
            .pointer(&format!("/enums/{name}"))
            .and_then(JsonValue::as_array)
            .ok_or_else(|| format!("CANONICAL_REGISTRY_ENUM_MISSING:{name}"))?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| format!("CANONICAL_REGISTRY_ENUM_INVALID:{name}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if actual != expected {
            return Err(format!("CANONICAL_REGISTRY_ENUM_MISMATCH:{name}"));
        }
    }
    Ok(())
}
