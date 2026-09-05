use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;

pub(crate) const RECOVERY_SNAPSHOT_SCHEMA_VERSION: u8 = 1;
pub(crate) const RFC_8785_PROFILE: &str = "RFC-8785-JCS-restricted-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RecoveryReadinessState {
    Ready,
    NotReady,
    NotVerified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryInspectionSnapshot {
    pub snapshot_schema_version: u8,
    pub inspected_at: String,
    pub inspector_version: String,
    pub owner_type: String,
    pub owner_id: String,
    pub manuscript_channel: String,
    pub scope_kind: String,
    pub binding_identity: String,
    pub file_ref_identity: String,
    pub path_identity_key: String,
    pub resource_type: String,
    pub controlled_metadata_identity: String,
    pub containment_safety: RecoveryReadinessState,
    pub read_ready: RecoveryReadinessState,
    pub write_ready: RecoveryReadinessState,
    pub default_resource_ready: RecoveryReadinessState,
    pub current_resource_ready: RecoveryReadinessState,
    pub lifecycle_eligibility: String,
    pub blocker_codes: Vec<String>,
    pub provenance: Vec<String>,
    pub markdown_bytes_read: u64,
    pub observed_operation_id: String,
    pub observed_operation_revision: i64,
    pub observed_claim_id: Option<String>,
    pub observed_claim_revision: Option<i64>,
    pub observed_claim_holder: String,
    pub literature_child_state_identity: Option<String>,
    pub snapshot_hash: String,
}

impl RecoveryInspectionSnapshot {
    #[allow(clippy::too_many_arguments)]
    #[cfg(test)]
    pub(crate) fn new_for_test(
        snapshot_schema_version: u8,
        inspected_at: &str,
        inspector_version: &str,
        owner_type: &str,
        owner_id: &str,
        manuscript_channel: &str,
        scope_kind: &str,
        binding_identity: &str,
        file_ref_identity: &str,
        path_identity_key: &str,
        resource_type: &str,
        controlled_metadata_identity: &str,
        containment_safety: RecoveryReadinessState,
        read_ready: RecoveryReadinessState,
        write_ready: RecoveryReadinessState,
        default_resource_ready: RecoveryReadinessState,
        current_resource_ready: RecoveryReadinessState,
        lifecycle_eligibility: &str,
        blocker_codes: Vec<String>,
        provenance: Vec<String>,
        observed_operation_id: &str,
        observed_operation_revision: i64,
        observed_claim_id: Option<&str>,
        observed_claim_revision: Option<i64>,
        observed_claim_holder: &str,
        literature_child_state_identity: Option<&str>,
    ) -> Result<Self, ()> {
        let mut snapshot = Self {
            snapshot_schema_version,
            inspected_at: inspected_at.to_string(),
            inspector_version: inspector_version.to_string(),
            owner_type: owner_type.to_string(),
            owner_id: owner_id.to_string(),
            manuscript_channel: manuscript_channel.to_string(),
            scope_kind: scope_kind.to_string(),
            binding_identity: binding_identity.to_string(),
            file_ref_identity: file_ref_identity.to_string(),
            path_identity_key: path_identity_key.to_string(),
            resource_type: resource_type.to_string(),
            controlled_metadata_identity: controlled_metadata_identity.to_string(),
            containment_safety,
            read_ready,
            write_ready,
            default_resource_ready,
            current_resource_ready,
            lifecycle_eligibility: lifecycle_eligibility.to_string(),
            blocker_codes,
            provenance,
            markdown_bytes_read: 0,
            observed_operation_id: observed_operation_id.to_string(),
            observed_operation_revision,
            observed_claim_id: observed_claim_id.map(str::to_string),
            observed_claim_revision,
            observed_claim_holder: observed_claim_holder.to_string(),
            literature_child_state_identity: literature_child_state_identity.map(str::to_string),
            snapshot_hash: String::new(),
        };
        snapshot.reseal()?;
        Ok(snapshot)
    }

    pub(crate) fn reseal(&mut self) -> Result<(), ()> {
        self.blocker_codes.sort();
        self.blocker_codes.dedup();
        self.provenance.sort();
        self.provenance.dedup();
        self.validate_without_hash()?;
        let canonical = self.canonical_identity();
        self.snapshot_hash = format!("{:x}", Sha256::digest(canonical.as_bytes()));
        Ok(())
    }

    pub(crate) fn validate(&self) -> Result<(), ()> {
        self.validate_without_hash()?;
        let expected = format!("{:x}", Sha256::digest(self.canonical_identity().as_bytes()));
        if expected != self.snapshot_hash {
            return Err(());
        }
        Ok(())
    }

    fn validate_without_hash(&self) -> Result<(), ()> {
        if self.snapshot_schema_version != RECOVERY_SNAPSHOT_SCHEMA_VERSION
            || self.markdown_bytes_read != 0
            || !is_fixed_utc_timestamp(&self.inspected_at)
            || self.observed_operation_revision < 0
            || self
                .observed_claim_revision
                .is_some_and(|revision| revision < 0)
            || self.observed_claim_id.is_some() != self.observed_claim_revision.is_some()
            || !matches!(
                self.lifecycle_eligibility.as_str(),
                "eligible" | "not-eligible" | "not-verified"
            )
            || !matches!(
                self.observed_claim_holder.as_str(),
                "current-instance" | "other-instance" | "none"
            )
            || !matches!(self.resource_type.as_str(), "file" | "directory")
        {
            return Err(());
        }
        for value in [
            &self.inspector_version,
            &self.owner_type,
            &self.owner_id,
            &self.manuscript_channel,
            &self.scope_kind,
            &self.binding_identity,
            &self.file_ref_identity,
            &self.path_identity_key,
            &self.controlled_metadata_identity,
            &self.observed_operation_id,
        ] {
            if !is_safe_identity(value) {
                return Err(());
            }
        }
        if self
            .observed_claim_id
            .as_deref()
            .is_some_and(|value| !is_safe_identity(value))
            || self
                .literature_child_state_identity
                .as_deref()
                .is_some_and(|value| !is_safe_identity(value))
            || self
                .blocker_codes
                .iter()
                .chain(self.provenance.iter())
                .any(|value| !is_safe_identity(value))
        {
            return Err(());
        }
        Ok(())
    }

    pub(crate) fn canonical_identity(&self) -> String {
        canonicalize(&json!({
            "bindingIdentity": self.binding_identity,
            "blockerCodes": self.blocker_codes,
            "containmentSafety": self.containment_safety,
            "controlledMetadataIdentity": self.controlled_metadata_identity,
            "currentResourceReady": self.current_resource_ready,
            "defaultResourceReady": self.default_resource_ready,
            "fileRefIdentity": self.file_ref_identity,
            "inspectorVersion": self.inspector_version,
            "lifecycleEligibility": self.lifecycle_eligibility,
            "literatureChildStateIdentity": self.literature_child_state_identity,
            "manuscriptChannel": self.manuscript_channel,
            "markdownBytesRead": self.markdown_bytes_read,
            "observedClaimHolder": self.observed_claim_holder,
            "observedClaimId": self.observed_claim_id,
            "observedClaimRevision": self.observed_claim_revision,
            "observedOperationId": self.observed_operation_id,
            "observedOperationRevision": self.observed_operation_revision,
            "ownerId": self.owner_id,
            "ownerType": self.owner_type,
            "pathIdentityKey": self.path_identity_key,
            "provenance": self.provenance,
            "readReady": self.read_ready,
            "resourceType": self.resource_type,
            "scopeKind": self.scope_kind,
            "snapshotSchemaVersion": self.snapshot_schema_version,
            "writeReady": self.write_ready
        }))
    }

    pub(crate) fn all_resources_ready(&self) -> bool {
        [
            self.containment_safety,
            self.read_ready,
            self.write_ready,
            self.default_resource_ready,
            self.current_resource_ready,
        ]
        .into_iter()
        .all(|state| state == RecoveryReadinessState::Ready)
            && self.lifecycle_eligibility == "eligible"
            && self.blocker_codes.is_empty()
    }
}

fn is_fixed_utc_timestamp(value: &str) -> bool {
    value.len() == 24
        && value.ends_with('Z')
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value.as_bytes()[10] == b'T'
        && value.as_bytes()[13] == b':'
        && value.as_bytes()[16] == b':'
        && value.as_bytes()[19] == b'.'
        && value.bytes().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) || byte.is_ascii_digit()
        })
}

fn is_safe_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn canonicalize(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).expect("serialize canonical string"),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonicalize)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_by(|left, right| compare_utf16(left, right));
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("serialize canonical key"),
                        canonicalize(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}
