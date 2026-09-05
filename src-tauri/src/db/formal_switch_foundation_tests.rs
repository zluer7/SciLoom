use super::formal_switch_foundation::encoding::{
    decode_attempt_metadata, decode_envelope, encode_attempt_metadata, encode_canonical_value,
    encode_envelope, sha256, verify_canonical_bytes, CandidateIdentityV1, CanonicalValue,
    FormalSwitchAttemptMetadataV1, FormalSwitchEntryKind, FormalSwitchImmutableEnvelopeV1,
    FormalSwitchManuscriptChannel, FormalSwitchOwnerType, FormalSwitchReviewType,
    ReplacementItemV1, SettlementPlanV1,
};
use super::formal_switch_foundation::state::{
    occupies_unresolved_slot, validate_transition, FormalSwitchOperationState,
};
use super::formal_switch_foundation::{
    advance_phase_cas, mark_contained_or_blocked_cas, prepare_immutable_operation,
    read_formal_switch_success_by_operation_id, read_migration_foundation_status, read_operation,
    read_unresolved_operation_summaries, read_verified_operation_for_continuation,
    remove_v53_foundation_for_legacy_fixture, schema_is_current, verify_operation_id_exactly_once,
    FormalSwitchFoundationAvailability, FormalSwitchMigrationAdmissionAuthority, PhaseCasFailure,
    PrepareImmutableOperationResult, SchemaMigrationAdmission, TargetOwnerCutoverAdmission,
};
use super::schema;
use rusqlite::{params, Connection};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Barrier};

fn envelope(operation_id: &str, owner_id: &str) -> FormalSwitchImmutableEnvelopeV1 {
    FormalSwitchImmutableEnvelopeV1 {
        operation_id: operation_id.into(),
        payload_version: 1,
        canonical_encoding_version: "CanonicalEnvelopeEncodingV1".into(),
        engine_contract_version: 1,
        descriptor_identity: "experiment/primary/v1".into(),
        descriptor_version: 1,
        descriptor_hash: [0; 32],
        candidate_contract_version: 1,
        settlement_plan_version: 1,
        transaction_payload_version: 1,
        recovery_payload_version: 1,
        owner_type: FormalSwitchOwnerType::Experiment,
        owner_id: owner_id.into(),
        manuscript_channel: FormalSwitchManuscriptChannel::Primary,
        entry_kind: FormalSwitchEntryKind::UserConfirmedSwitch,
        owner_subtype: None,
        old_current_file_ref_identity: "a".into(),
        default_file_ref_identity: "b".into(),
        target_file_ref_identity: "c".into(),
        old_current_logical_session_identity: "d".into(),
        target_logical_session_identity: "e".into(),
        candidate: CandidateIdentityV1 {
            file_ref_identity: "c".into(),
            physical_revision: "r".into(),
            sha256: [0; 32],
            byte_length: 0,
            encoding: "UTF-8".into(),
        },
        replacement_dto: Vec::new(),
        owner_protected_row_digest: [0; 32],
        binding_digest: [0; 32],
        lifecycle_coverage_digest: [0; 32],
        old_current_expected_physical_revision: "s".into(),
        settlement_plan: SettlementPlanV1 {
            byte_start: 0,
            byte_end: 0,
            expected_whole_file_hash: [0; 32],
            expected_controlled_region_preimage_hash: [0; 32],
            replacement_bytes: Vec::new(),
            expected_whole_file_post_hash: [0; 32],
            bom_state: "ABSENT".into(),
            line_ending_policy: "PRESERVE_SNAPSHOT_EXACT".into(),
            boundary_newline_ownership: "NONE".into(),
            write_once_operation_id: operation_id.into(),
        },
        transaction_payload: Vec::new(),
        success_operation_log_id: "l".into(),
        formal_switch_operation_id: operation_id.into(),
        activation_logical_identity: "f".into(),
        finalization_identity: "g".into(),
        operation_custody_identity: "h".into(),
        created_at_epoch_ms: 0,
    }
}

fn full_envelope() -> FormalSwitchImmutableEnvelopeV1 {
    let operation_id = "op-科研-e\u{0301}-Ω";
    FormalSwitchImmutableEnvelopeV1 {
        operation_id: operation_id.into(),
        payload_version: 1,
        canonical_encoding_version: "CanonicalEnvelopeEncodingV1".into(),
        engine_contract_version: 1,
        descriptor_identity: "review/primary/custom/v1".into(),
        descriptor_version: 7,
        descriptor_hash: [0x11; 32],
        candidate_contract_version: 1,
        settlement_plan_version: 1,
        transaction_payload_version: 1,
        recovery_payload_version: 1,
        owner_type: FormalSwitchOwnerType::Review,
        owner_id: "review-科研".into(),
        manuscript_channel: FormalSwitchManuscriptChannel::Primary,
        entry_kind: FormalSwitchEntryKind::RepairConfirmedSwitch,
        owner_subtype: Some(FormalSwitchReviewType::Custom),
        old_current_file_ref_identity: "file-old-Ω".into(),
        default_file_ref_identity: "file-default-Ω".into(),
        target_file_ref_identity: "file-target-Ω".into(),
        old_current_logical_session_identity: "review:old:current".into(),
        target_logical_session_identity: "review:target:current".into(),
        candidate: CandidateIdentityV1 {
            file_ref_identity: "file-target-Ω".into(),
            physical_revision: "sha256:revision".into(),
            sha256: [0x22; 32],
            byte_length: 4_294_967_296,
            encoding: "UTF-8".into(),
        },
        replacement_dto: vec![
            ReplacementItemV1 {
                stable_key: "custom_summary".into(),
                value: Some("科研 e\u{0301} Ω".into()),
            },
            ReplacementItemV1 {
                stable_key: "other".into(),
                value: None,
            },
        ],
        owner_protected_row_digest: [0x33; 32],
        binding_digest: [0x44; 32],
        lifecycle_coverage_digest: [0x55; 32],
        old_current_expected_physical_revision: "old-revision-精确".into(),
        settlement_plan: SettlementPlanV1 {
            byte_start: 3,
            byte_end: 9_223_372_036_854_775_808,
            expected_whole_file_hash: [0x66; 32],
            expected_controlled_region_preimage_hash: [0x77; 32],
            replacement_bytes: vec![0, 0xff, 0x0a, 0x0d],
            expected_whole_file_post_hash: [0x88; 32],
            bom_state: "UTF8_BOM".into(),
            line_ending_policy: "PRESERVE_SNAPSHOT_EXACT".into(),
            boundary_newline_ownership: "BOTH".into(),
            write_once_operation_id: operation_id.into(),
        },
        transaction_payload: vec![1, 2, 3, 0xfe, 0xff],
        success_operation_log_id: "log-科研".into(),
        formal_switch_operation_id: operation_id.into(),
        activation_logical_identity: "activation-Ω".into(),
        finalization_identity: "finalization-Ω".into(),
        operation_custody_identity: "custody-Ω".into(),
        created_at_epoch_ms: i64::MIN,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn from_hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("hex utf8"), 16).expect("hex byte")
        })
        .collect()
}

fn current_connection() -> Connection {
    let connection = Connection::open_in_memory().expect("open current database");
    schema::run_migrations(&connection).expect("initialize v53");
    connection
}

fn golden() -> Value {
    serde_json::from_str(include_str!(
        "../../../src/contracts/formalSwitchCanonicalEnvelopeEncodingV1.golden.json"
    ))
    .expect("literal golden vectors")
}

#[test]
fn formal_switch_foundation_cross_language_literal_golden_vectors_are_exact() {
    let golden = golden();
    for (index, fixture) in [envelope("o", "x"), full_envelope()].iter().enumerate() {
        let encoded = encode_envelope(fixture).expect("encode envelope");
        let vector = &golden["envelopes"][index];
        assert_eq!(hex(&encoded), vector["expectedHex"].as_str().unwrap());
        assert_eq!(
            hex(&sha256(&encoded)),
            vector["expectedSha256Hex"].as_str().unwrap()
        );
        assert_eq!(
            verify_canonical_bytes(&encoded).expect("strict re-encode"),
            *fixture
        );
    }

    let mut ordered = BTreeMap::new();
    ordered.insert("Ω".into(), CanonicalValue::U64(1));
    ordered.insert("a".into(), CanonicalValue::String("A".into()));
    ordered.insert("é".into(), CanonicalValue::String("E".into()));
    let values = vec![
        CanonicalValue::Absent,
        CanonicalValue::Null,
        CanonicalValue::Bool(false),
        CanonicalValue::Bool(true),
        CanonicalValue::String(String::new()),
        CanonicalValue::String("e\u{0301}科研Ω".into()),
        CanonicalValue::I64(i64::MIN),
        CanonicalValue::I64(i64::MAX),
        CanonicalValue::U64(u64::MAX),
        CanonicalValue::Bytes(Vec::new()),
        CanonicalValue::Array(Vec::new()),
        CanonicalValue::Map(ordered.clone()),
        CanonicalValue::Map(ordered),
        CanonicalValue::Array(vec![
            CanonicalValue::Null,
            CanonicalValue::Bool(true),
            CanonicalValue::String("x".into()),
        ]),
        CanonicalValue::Object(vec![(
            "outer".into(),
            CanonicalValue::Object(vec![
                ("n".into(), CanonicalValue::U64(1)),
                ("z".into(), CanonicalValue::Null),
            ]),
        )]),
    ];
    for (index, value) in values.iter().enumerate() {
        let mut encoded = Vec::new();
        encode_canonical_value(&mut encoded, value).expect("encode value vector");
        assert_eq!(
            hex(&encoded),
            golden["values"][index]["expectedHex"].as_str().unwrap()
        );
        assert_eq!(
            hex(&sha256(&encoded)),
            golden["values"][index]["expectedSha256Hex"]
                .as_str()
                .unwrap()
        );
    }
    let duplicate = CanonicalValue::Object(vec![
        ("x".into(), CanonicalValue::Null),
        ("x".into(), CanonicalValue::Null),
    ]);
    assert_eq!(
        encode_canonical_value(&mut Vec::new(), &duplicate).unwrap_err(),
        "CANONICAL_DUPLICATE_FIELD"
    );
    for vector in golden["negative"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|value| value.get("inputHex").is_some())
    {
        let failure = decode_envelope(&from_hex(vector["inputHex"].as_str().unwrap())).unwrap_err();
        assert!(
            failure.contains(vector["expectedFailure"].as_str().unwrap()),
            "{failure}"
        );
    }
}

#[test]
fn formal_switch_foundation_rust_typed_identity_covers_all_owners_channels_and_review_types() {
    let identities = vec![
        (
            FormalSwitchOwnerType::Experiment,
            FormalSwitchManuscriptChannel::Primary,
            None,
        ),
        (
            FormalSwitchOwnerType::ExperimentRun,
            FormalSwitchManuscriptChannel::Primary,
            None,
        ),
        (
            FormalSwitchOwnerType::Literature,
            FormalSwitchManuscriptChannel::LiteratureOutline,
            None,
        ),
        (
            FormalSwitchOwnerType::Literature,
            FormalSwitchManuscriptChannel::DedicatedNotes,
            None,
        ),
        (
            FormalSwitchOwnerType::ResultItem,
            FormalSwitchManuscriptChannel::Primary,
            None,
        ),
        (
            FormalSwitchOwnerType::Finding,
            FormalSwitchManuscriptChannel::Primary,
            None,
        ),
        (
            FormalSwitchOwnerType::OutputCandidate,
            FormalSwitchManuscriptChannel::Primary,
            None,
        ),
        (
            FormalSwitchOwnerType::OutputGap,
            FormalSwitchManuscriptChannel::Primary,
            None,
        ),
        (
            FormalSwitchOwnerType::ResearchOutput,
            FormalSwitchManuscriptChannel::Primary,
            None,
        ),
        (
            FormalSwitchOwnerType::Review,
            FormalSwitchManuscriptChannel::Primary,
            Some(FormalSwitchReviewType::Stage),
        ),
        (
            FormalSwitchOwnerType::Review,
            FormalSwitchManuscriptChannel::Primary,
            Some(FormalSwitchReviewType::Periodic),
        ),
        (
            FormalSwitchOwnerType::Review,
            FormalSwitchManuscriptChannel::Primary,
            Some(FormalSwitchReviewType::ExperimentComparison),
        ),
        (
            FormalSwitchOwnerType::Review,
            FormalSwitchManuscriptChannel::Primary,
            Some(FormalSwitchReviewType::LiteratureComparison),
        ),
        (
            FormalSwitchOwnerType::Review,
            FormalSwitchManuscriptChannel::Primary,
            Some(FormalSwitchReviewType::Custom),
        ),
    ];
    for (owner_type, manuscript_channel, owner_subtype) in identities {
        let mut fixture = envelope("op-typed", "owner-typed");
        fixture.owner_type = owner_type;
        fixture.manuscript_channel = manuscript_channel;
        fixture.owner_subtype = owner_subtype;
        let encoded = encode_envelope(&fixture).expect("typed combination");
        assert_eq!(decode_envelope(&encoded).expect("typed readback"), fixture);
    }
    let mut invalid = envelope("op-invalid", "owner-invalid");
    invalid.owner_type = FormalSwitchOwnerType::Literature;
    assert_eq!(
        encode_envelope(&invalid).unwrap_err(),
        "CANONICAL_OWNER_CHANNEL_MISMATCH"
    );
    invalid.owner_type = FormalSwitchOwnerType::Review;
    assert_eq!(
        encode_envelope(&invalid).unwrap_err(),
        "CANONICAL_REVIEW_TYPE_REQUIRED"
    );
}

#[test]
fn formal_switch_foundation_v53_schema_is_complete_and_cutover_stays_closed() {
    let connection = current_connection();
    assert!(schema_is_current(&connection).expect("schema verification"));
    let status = FormalSwitchMigrationAdmissionAuthority::read(&connection);
    assert_eq!(
        status.schema_migration_admission,
        SchemaMigrationAdmission::OpenVerifiedV53
    );
    assert_eq!(
        status.target_owner_cutover_admission,
        TargetOwnerCutoverAdmission::ClosedNotReady
    );
    assert_eq!(
        status.availability,
        FormalSwitchFoundationAvailability::Available
    );
    assert_eq!(status.schema_version, schema::CURRENT_SCHEMA_VERSION);
    assert_eq!(status.old_recovery_family_count, 2);
    assert_eq!(status.production_owner_caller_count, 0);

    connection
        .execute_batch("DROP TRIGGER trg_formal_switch_operations_state_transition;")
        .expect("simulate incomplete v53");
    let incomplete = read_migration_foundation_status(&connection);
    assert_eq!(
        incomplete.schema_migration_admission,
        SchemaMigrationAdmission::Incomplete
    );
    assert_eq!(
        incomplete.availability,
        FormalSwitchFoundationAvailability::AuthorityIncomplete
    );
    let error = schema::run_migrations(&connection).expect_err("incomplete v53 must fail closed");
    assert!(
        error.to_string().contains("formal_switch_operations"),
        "{error}"
    );
}

#[test]
fn formal_switch_foundation_prepare_is_idempotent_immutable_and_summary_only() {
    let connection = current_connection();
    let first = envelope("op-prepare", "owner-1");
    assert!(matches!(
        prepare_immutable_operation(&connection, &first).unwrap(),
        PrepareImmutableOperationResult::Prepared(_)
    ));
    assert!(matches!(
        prepare_immutable_operation(&connection, &first).unwrap(),
        PrepareImmutableOperationResult::AlreadyPrepared(_)
    ));
    let mut conflict = first.clone();
    conflict.descriptor_identity = "experiment/primary/v2".into();
    assert_eq!(
        prepare_immutable_operation(&connection, &conflict).unwrap(),
        PrepareImmutableOperationResult::ConflictInconsistent
    );
    assert!(matches!(
        prepare_immutable_operation(&connection, &envelope("op-other", "owner-1")).unwrap(),
        PrepareImmutableOperationResult::UnresolvedIdentityConflict
    ));

    let durable = read_operation(&connection, "op-prepare").unwrap().unwrap();
    assert_eq!(durable.immutable_payload, encode_envelope(&first).unwrap());
    assert_eq!(durable.payload_sha256, sha256(&durable.immutable_payload));

    let update = connection.execute("UPDATE formal_switch_operations SET immutable_payload=X'00' WHERE operation_id='op-prepare'", []);
    assert!(update
        .unwrap_err()
        .to_string()
        .contains("FORMAL_SWITCH_IMMUTABLE_PAYLOAD"));
    for sql in [
        "UPDATE formal_switch_operations SET operation_id='op-mutated' WHERE operation_id='op-prepare'",
        "UPDATE formal_switch_operations SET payload_version=2 WHERE operation_id='op-prepare'",
    ] {
        assert!(connection.execute(sql, []).unwrap_err().to_string().contains("FORMAL_SWITCH_IMMUTABLE_PAYLOAD"));
    }
    for sql in [
        "INSERT OR REPLACE INTO formal_switch_operations SELECT * FROM formal_switch_operations WHERE operation_id='op-prepare'",
        "REPLACE INTO formal_switch_operations SELECT * FROM formal_switch_operations WHERE operation_id='op-prepare'",
        "INSERT INTO formal_switch_operations SELECT * FROM formal_switch_operations WHERE operation_id='op-prepare' AND 1=1 ON CONFLICT(operation_id) DO UPDATE SET immutable_payload=X'00'",
    ] {
        assert!(connection.execute(sql, []).unwrap_err().to_string().contains("FORMAL_SWITCH_OPERATION_REPLACEMENT_FORBIDDEN"));
    }
    let delete = connection.execute(
        "DELETE FROM formal_switch_operations WHERE operation_id='op-prepare'",
        [],
    );
    assert!(delete
        .unwrap_err()
        .to_string()
        .contains("FORMAL_SWITCH_OPERATION_DELETE_FORBIDDEN"));
    let invalid = connection.execute("UPDATE formal_switch_operations SET phase='resolved',phase_revision=1,terminal_code='RESOLVED' WHERE operation_id='op-prepare'", []);
    assert!(invalid
        .unwrap_err()
        .to_string()
        .contains("FORMAL_SWITCH_INVALID_TRANSITION"));
    let summaries = read_unresolved_operation_summaries(&connection).expect("summary discovery");
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].operation_id, "op-prepare");
    assert_eq!(summaries[0].owner_type, "experiment");
    assert_eq!(summaries[0].owner_id, "owner-1");
    assert_eq!(summaries[0].manuscript_channel, "primary");
    assert_eq!(summaries[0].entry_kind, "USER_CONFIRMED_SWITCH");
    assert_eq!(summaries[0].owner_subtype, "");
    assert_eq!(summaries[0].phase, "prepared");
    assert_eq!(summaries[0].phase_revision, 0);
    assert_eq!(summaries[0].terminal_code, None);
}

#[test]
fn formal_switch_foundation_attempt_metadata_is_canonical_bounded_and_non_authoritative() {
    let metadata = FormalSwitchAttemptMetadataV1 {
        attempt_count: 3,
        last_attempt_at_epoch_ms: -1,
        last_process_generation: "process-generation-7".into(),
        last_consumer_classification: "RECOVERY_TEST_HARNESS".into(),
        last_observed_phase_revision: 2,
        last_typed_failure: Some("PHASE_CONFLICT".into()),
    };
    let encoded = encode_attempt_metadata(&metadata).expect("canonical metadata");
    assert!(encoded.len() <= 512);
    assert_eq!(
        decode_attempt_metadata(&encoded).expect("strict metadata readback"),
        metadata
    );
    let mut trailing = encoded.clone();
    trailing.push(0);
    assert_eq!(
        decode_attempt_metadata(&trailing).unwrap_err(),
        "CANONICAL_TRAILING_BYTES"
    );
    let oversized = FormalSwitchAttemptMetadataV1 {
        last_process_generation: "x".repeat(129),
        ..metadata
    };
    assert_eq!(
        encode_attempt_metadata(&oversized).unwrap_err(),
        "FORMAL_SWITCH_ATTEMPT_METADATA_INVALID"
    );
}

#[test]
fn formal_switch_foundation_state_cas_and_unresolved_slot_policy_are_enforced() {
    let connection = current_connection();
    let first = envelope("op-release", "owner-release");
    prepare_immutable_operation(&connection, &first).expect("prepare");
    let hash = sha256(&encode_envelope(&first).unwrap());
    let cancelled = FormalSwitchOperationState {
        phase: "cancelled_safe".into(),
        settlement_outcome: "UNKNOWN".into(),
        db_outcome: "NOT_APPLIED".into(),
        activation_outcome: "PENDING".into(),
        terminal_code: Some("CANCELLED_SAFE".into()),
    };
    assert!(!occupies_unresolved_slot(&cancelled).unwrap());
    advance_phase_cas(
        &connection,
        "op-release",
        "prepared",
        0,
        &hash,
        &cancelled,
        None,
        None,
        None,
        1,
    )
    .expect("safe cancel");
    assert!(matches!(
        advance_phase_cas(
            &connection,
            "op-release",
            "prepared",
            0,
            &hash,
            &cancelled,
            None,
            None,
            None,
            2
        ),
        Err(PhaseCasFailure::TerminalConflict)
    ));
    assert!(matches!(
        prepare_immutable_operation(&connection, &envelope("op-after-release", "owner-release"))
            .unwrap(),
        PrepareImmutableOperationResult::Prepared(_)
    ));

    let contained_envelope = envelope("op-contained", "owner-contained");
    prepare_immutable_operation(&connection, &contained_envelope).expect("prepare contained");
    let contained_hash = sha256(&encode_envelope(&contained_envelope).unwrap());
    mark_contained_or_blocked_cas(
        &connection,
        "op-contained",
        "prepared",
        0,
        &contained_hash,
        true,
        ("UNKNOWN", "NOT_APPLIED", "PENDING"),
        1,
    )
    .expect("contain");
    assert!(occupies_unresolved_slot(&FormalSwitchOperationState {
        phase: "contained".into(),
        settlement_outcome: "UNKNOWN".into(),
        db_outcome: "NOT_APPLIED".into(),
        activation_outcome: "PENDING".into(),
        terminal_code: Some("CONTAINED_CONTINUATION_BLOCKED".into()),
    })
    .unwrap());
    assert!(matches!(
        prepare_immutable_operation(
            &connection,
            &envelope("op-contained-second", "owner-contained")
        )
        .unwrap(),
        PrepareImmutableOperationResult::UnresolvedIdentityConflict
    ));
}

#[test]
fn formal_switch_foundation_all_normative_transition_rows_validate_and_outcomes_are_typed() {
    let matrix: Value = serde_json::from_str(include_str!(
        "../../../src/contracts/formalSwitchRecoveryStateMatrixV1.json"
    ))
    .expect("state matrix");
    for transition in matrix["transitions"].as_array().unwrap() {
        let phase = transition["from"].as_str().unwrap();
        for settlement in transition["settlement"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
        {
            for db in transition["db"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap())
            {
                for activation in transition["activation"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|value| value.as_str().unwrap())
                {
                    let current = match phase {
                        "prepared" => FormalSwitchOperationState {
                            phase: phase.into(),
                            settlement_outcome: "UNKNOWN".into(),
                            db_outcome: "NOT_APPLIED".into(),
                            activation_outcome: "PENDING".into(),
                            terminal_code: None,
                        },
                        "settlement_started" => FormalSwitchOperationState {
                            phase: phase.into(),
                            settlement_outcome: "UNKNOWN".into(),
                            db_outcome: "NOT_APPLIED".into(),
                            activation_outcome: "PENDING".into(),
                            terminal_code: None,
                        },
                        "settlement_complete" => FormalSwitchOperationState {
                            phase: phase.into(),
                            settlement_outcome: settlement.into(),
                            db_outcome: "NOT_APPLIED".into(),
                            activation_outcome: "PENDING".into(),
                            terminal_code: None,
                        },
                        "db_pending" => FormalSwitchOperationState {
                            phase: phase.into(),
                            settlement_outcome: settlement.into(),
                            db_outcome: "NOT_APPLIED".into(),
                            activation_outcome: "PENDING".into(),
                            terminal_code: None,
                        },
                        "db_complete" => FormalSwitchOperationState {
                            phase: phase.into(),
                            settlement_outcome: settlement.into(),
                            db_outcome: db.into(),
                            activation_outcome: "PENDING".into(),
                            terminal_code: None,
                        },
                        "activation_pending" => FormalSwitchOperationState {
                            phase: phase.into(),
                            settlement_outcome: settlement.into(),
                            db_outcome: db.into(),
                            activation_outcome: "PENDING".into(),
                            terminal_code: None,
                        },
                        _ => panic!("unexpected transition source {phase}"),
                    };
                    let next = FormalSwitchOperationState {
                        phase: transition["to"].as_str().unwrap().into(),
                        settlement_outcome: settlement.into(),
                        db_outcome: db.into(),
                        activation_outcome: activation.into(),
                        terminal_code: transition["terminalCode"].as_str().map(str::to_owned),
                    };
                    validate_transition(&current, &next)
                        .unwrap_or_else(|error| panic!("{phase}->{:?}: {error}", next.phase));
                }
            }
        }
    }

    let connection = current_connection();
    let fixture = envelope("op-outcomes", "owner-outcomes");
    prepare_immutable_operation(&connection, &fixture).expect("prepare outcomes");
    let hash = sha256(&encode_envelope(&fixture).unwrap());
    let invalid_jump = FormalSwitchOperationState {
        phase: "resolved".into(),
        settlement_outcome: "NOT_REQUIRED".into(),
        db_outcome: "COMMITTED".into(),
        activation_outcome: "APPLIED".into(),
        terminal_code: Some("RESOLVED".into()),
    };
    assert_eq!(
        advance_phase_cas(
            &connection,
            "op-outcomes",
            "prepared",
            0,
            &hash,
            &invalid_jump,
            None,
            None,
            None,
            1
        ),
        Err(PhaseCasFailure::InvalidTransition)
    );
    let cancelled = FormalSwitchOperationState {
        phase: "cancelled_safe".into(),
        settlement_outcome: "UNKNOWN".into(),
        db_outcome: "NOT_APPLIED".into(),
        activation_outcome: "PENDING".into(),
        terminal_code: Some("CANCELLED_SAFE".into()),
    };
    assert_eq!(
        advance_phase_cas(
            &connection,
            "op-outcomes",
            "db_pending",
            0,
            &hash,
            &cancelled,
            None,
            None,
            None,
            1
        ),
        Err(PhaseCasFailure::PhaseConflict)
    );
    assert_eq!(
        advance_phase_cas(
            &connection,
            "op-outcomes",
            "prepared",
            9,
            &hash,
            &cancelled,
            None,
            None,
            None,
            1
        ),
        Err(PhaseCasFailure::RevisionConflict)
    );
    assert_eq!(
        advance_phase_cas(
            &connection,
            "op-outcomes",
            "prepared",
            0,
            &[0xff; 32],
            &cancelled,
            None,
            None,
            None,
            1
        ),
        Err(PhaseCasFailure::PayloadIntegrityConflict)
    );

    let no_op = envelope("op-no-op", "owner-no-op");
    prepare_immutable_operation(&connection, &no_op).expect("prepare no-op path");
    let no_op_hash = sha256(&encode_envelope(&no_op).unwrap());
    let path = [
        FormalSwitchOperationState {
            phase: "settlement_complete".into(),
            settlement_outcome: "NOT_REQUIRED".into(),
            db_outcome: "NOT_APPLIED".into(),
            activation_outcome: "PENDING".into(),
            terminal_code: None,
        },
        FormalSwitchOperationState {
            phase: "db_pending".into(),
            settlement_outcome: "NOT_REQUIRED".into(),
            db_outcome: "NOT_APPLIED".into(),
            activation_outcome: "PENDING".into(),
            terminal_code: None,
        },
        FormalSwitchOperationState {
            phase: "db_complete".into(),
            settlement_outcome: "NOT_REQUIRED".into(),
            db_outcome: "ALREADY_COMMITTED".into(),
            activation_outcome: "PENDING".into(),
            terminal_code: None,
        },
        FormalSwitchOperationState {
            phase: "activation_pending".into(),
            settlement_outcome: "NOT_REQUIRED".into(),
            db_outcome: "ALREADY_COMMITTED".into(),
            activation_outcome: "PENDING".into(),
            terminal_code: None,
        },
        FormalSwitchOperationState {
            phase: "resolved".into(),
            settlement_outcome: "NOT_REQUIRED".into(),
            db_outcome: "ALREADY_COMMITTED".into(),
            activation_outcome: "ALREADY_ACTIVE".into(),
            terminal_code: Some("RESOLVED".into()),
        },
    ];
    let mut expected_phase = "prepared".to_string();
    for (revision, next) in path.iter().enumerate() {
        let readback = advance_phase_cas(
            &connection,
            "op-no-op",
            &expected_phase,
            revision as i64,
            &no_op_hash,
            next,
            None,
            None,
            None,
            revision as i64 + 1,
        )
        .expect("typed no-op path");
        expected_phase = readback.state.phase;
    }
    assert_eq!(
        read_operation(&connection, "op-no-op")
            .unwrap()
            .unwrap()
            .phase_revision,
        5
    );
}

fn insert_log(
    connection: &Connection,
    id: &str,
    operation_type: &str,
    status: &str,
    formal_id: Option<&str>,
) -> rusqlite::Result<usize> {
    connection.execute(
        "INSERT INTO operation_logs(id,operation_type,source,module,status,risk_level,target,summary,related_entities,warnings,errors,skipped,is_recoverable,actor_id,actor_label,refresh_keys,schema_version,created_at,updated_at,formal_switch_operation_id)
         VALUES(?1,?2,'user','test',?3,'high','{}','test','[]','[]','[]','[]',0,'local','Local','[]',1,'2026-08-09','2026-08-09',?4)",
        params![id, operation_type, status, formal_id],
    )
}

#[test]
fn formal_switch_foundation_success_log_identity_is_exactly_once_and_legacy_logs_are_untouched() {
    let connection = current_connection();
    insert_log(&connection, "legacy-success", "custom", "success", None)
        .expect("legacy exact predicate unaffected");
    assert!(
        insert_log(&connection, "missing-id", "formal_switch", "success", None)
            .unwrap_err()
            .to_string()
            .contains("FORMAL_SWITCH_SUCCESS_OPERATION_ID_REQUIRED")
    );
    insert_log(
        &connection,
        "formal-success",
        "formal_switch",
        "success",
        Some("op-log"),
    )
    .expect("formal success");
    assert!(insert_log(
        &connection,
        "formal-duplicate",
        "formal_switch",
        "success",
        Some("op-log")
    )
    .is_err());
    insert_log(
        &connection,
        "formal-partial-a",
        "formal_switch",
        "partial",
        Some("op-log"),
    )
    .expect("non-success not indexed");
    insert_log(
        &connection,
        "formal-partial-b",
        "formal_switch",
        "partial",
        Some("op-log"),
    )
    .expect("duplicate non-success not indexed");
    insert_log(
        &connection,
        "formal-success-other",
        "formal_switch",
        "success",
        Some("op-log-other"),
    )
    .expect("different success identity");
    assert_eq!(
        read_formal_switch_success_by_operation_id(&connection, "op-log")
            .unwrap()
            .as_deref(),
        Some("formal-success")
    );
    assert!(connection
        .execute(
            "UPDATE operation_logs SET status='partial' WHERE id='formal-success'",
            []
        )
        .unwrap_err()
        .to_string()
        .contains("FORMAL_SWITCH_SUCCESS_IDENTITY_IMMUTABLE"));
    assert!(connection
        .execute("DELETE FROM operation_logs WHERE id='formal-success'", [])
        .unwrap_err()
        .to_string()
        .contains("FORMAL_SWITCH_SUCCESS_DELETE_FORBIDDEN"));
    verify_operation_id_exactly_once(&connection, "op-log").expect("exactly-once readback");
}

#[test]
fn formal_switch_foundation_payload_corruption_is_detected_before_continuation() {
    let connection = current_connection();
    let prepared = envelope("op-corrupt", "owner-corrupt");
    prepare_immutable_operation(&connection, &prepared).expect("prepare");
    connection
        .execute_batch("DROP TRIGGER trg_formal_switch_operations_immutable_update;")
        .expect("test-only corruption setup");
    connection.execute("UPDATE formal_switch_operations SET immutable_payload=X'00' WHERE operation_id='op-corrupt'", []).expect("inject corruption");
    assert_eq!(
        read_verified_operation_for_continuation(&connection, "op-corrupt").unwrap_err(),
        "PAYLOAD_INTEGRITY_CONFLICT"
    );
}

#[test]
fn formal_switch_foundation_unknown_payload_version_fails_closed_even_with_matching_hash() {
    let connection = current_connection();
    let prepared = envelope("op-version", "owner-version");
    prepare_immutable_operation(&connection, &prepared).expect("prepare");
    let mut bytes = encode_envelope(&prepared).unwrap();
    let field = b"payloadVersion";
    let offset = bytes
        .windows(field.len())
        .position(|window| window == field)
        .expect("payloadVersion field")
        + field.len();
    assert_eq!(bytes[offset], 0x12);
    bytes[offset + 8] = 2;
    let hash = sha256(&bytes);
    connection
        .execute_batch("DROP TRIGGER trg_formal_switch_operations_immutable_update;")
        .expect("test-only version corruption setup");
    connection.execute(
        "UPDATE formal_switch_operations SET immutable_payload=?1,payload_sha256=?2 WHERE operation_id='op-version'",
        params![bytes, hash.as_slice()],
    ).expect("inject self-consistent unknown version");
    assert_eq!(
        read_verified_operation_for_continuation(&connection, "op-version").unwrap_err(),
        "CANONICAL_CONTRACT_VERSION_UNKNOWN"
    );
}

fn unique_db_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "labpod-f1-{label}-{}-{}.sqlite",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[test]
fn formal_switch_foundation_concurrent_prepare_has_one_unresolved_winner_and_survives_restart() {
    let path = unique_db_path("concurrency");
    let setup = Connection::open(&path).expect("open setup");
    schema::run_migrations(&setup).expect("initialize");
    drop(setup);
    let barrier = Arc::new(Barrier::new(2));
    let handles = ["op-race-a", "op-race-b"]
        .into_iter()
        .map(|operation_id| {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let connection = Connection::open(path).expect("open contender");
                connection
                    .busy_timeout(std::time::Duration::from_secs(5))
                    .expect("busy timeout");
                barrier.wait();
                prepare_immutable_operation(&connection, &envelope(operation_id, "owner-race"))
                    .expect("race prepare")
            })
        })
        .collect::<Vec<_>>();
    let outcomes = handles
        .into_iter()
        .map(|handle| handle.join().expect("join contender"))
        .collect::<Vec<_>>();
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, PrepareImmutableOperationResult::Prepared(_)))
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(
                outcome,
                PrepareImmutableOperationResult::UnresolvedIdentityConflict
            ))
            .count(),
        1
    );
    let reopened = Connection::open(&path).expect("restart connection");
    schema::run_migrations(&reopened).expect("restart schema verification");
    let summaries = read_unresolved_operation_summaries(&reopened).unwrap();
    assert_eq!(summaries.len(), 1);
    let winner = summaries[0].operation_id.clone();
    drop(reopened);
    let winner_envelope = envelope(&winner, "owner-race");
    let winner_hash = sha256(&encode_envelope(&winner_envelope).unwrap());
    let barrier = Arc::new(Barrier::new(2));
    let handles = (0..2)
        .map(|_| {
            let path = path.clone();
            let winner = winner.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                let connection = Connection::open(path).expect("open CAS contender");
                connection
                    .busy_timeout(std::time::Duration::from_secs(5))
                    .expect("CAS busy timeout");
                let next = FormalSwitchOperationState {
                    phase: "cancelled_safe".into(),
                    settlement_outcome: "UNKNOWN".into(),
                    db_outcome: "NOT_APPLIED".into(),
                    activation_outcome: "PENDING".into(),
                    terminal_code: Some("CANCELLED_SAFE".into()),
                };
                barrier.wait();
                advance_phase_cas(
                    &connection,
                    &winner,
                    "prepared",
                    0,
                    &winner_hash,
                    &next,
                    None,
                    None,
                    None,
                    1,
                )
            })
        })
        .collect::<Vec<_>>();
    let cas = handles
        .into_iter()
        .map(|handle| handle.join().expect("join CAS contender"))
        .collect::<Vec<_>>();
    assert_eq!(cas.iter().filter(|outcome| outcome.is_ok()).count(), 1);
    assert_eq!(
        cas.iter()
            .filter(|outcome| matches!(outcome, Err(PhaseCasFailure::TerminalConflict)))
            .count(),
        1
    );
    let final_read = Connection::open(&path).expect("final restart");
    schema::run_migrations(&final_read).expect("final restart verification");
    assert_eq!(
        read_operation(&final_read, &winner)
            .unwrap()
            .unwrap()
            .phase_revision,
        1
    );
    assert_eq!(
        read_unresolved_operation_summaries(&final_read)
            .unwrap()
            .len(),
        0
    );
    drop(final_read);
    std::fs::remove_file(path).expect("cleanup database");
}

fn downgrade_empty_current_database_to_v52(connection: &Connection) {
    remove_v53_foundation_for_legacy_fixture(connection)
        .expect("remove v53 foundation from isolated v52 fixture");
    connection
        .pragma_update(None, "user_version", 52)
        .expect("construct exact empty v52 fixture from current chain");
}

#[test]
fn formal_switch_foundation_v52_migration_is_atomic_and_drain_failure_rolls_back() {
    let success = current_connection();
    downgrade_empty_current_database_to_v52(&success);
    let before = read_migration_foundation_status(&success);
    assert_eq!(
        before.schema_migration_admission,
        SchemaMigrationAdmission::Closed
    );
    assert_eq!(
        before.availability,
        FormalSwitchFoundationAvailability::MigrationClosed
    );
    assert_eq!(
        before.target_owner_cutover_admission,
        TargetOwnerCutoverAdmission::ClosedNotReady
    );
    schema::run_migrations(&success).expect("v52 to v53");
    assert!(schema_is_current(&success).unwrap());

    let blocked = current_connection();
    downgrade_empty_current_database_to_v52(&blocked);
    blocked
        .pragma_update(None, "foreign_keys", "OFF")
        .expect("test fixture foreign keys off");
    blocked.execute_batch(
        "INSERT INTO experiment_manuscript_switch_recoveries(
           operation_id,owner_type,experiment_id,project_id,manuscript_channel,phase,binding_id,
           expected_owner_updated_at,expected_binding_updated_at,old_current_file_ref_id,
           old_current_file_ref_updated_at,old_current_path_identity,old_current_location_mode,
           default_file_ref_id,default_file_ref_updated_at,default_path_identity,default_location_mode,
           target_file_ref_id,target_file_ref_updated_at,target_path_identity,target_location_mode,
           outline_replacements_json,experiment_title_snapshot,project_title_snapshot,tags_json,
           deterministic_writeback_version,recorded_at,writeback_digest,writeback_byte_length,
           old_current_pre_revision,old_current_pre_digest,old_current_expected_post_digest,
           target_physical_revision,target_digest,target_byte_length,old_current_file_name,
           target_file_name,default_file_name,correlation_id,created_at,updated_at)
         VALUES('old-unresolved','experiment','e','p','primary','prepared','b','1','1','old','1','old','managed',
           'default','1','default','managed','target','1','target','managed','[]','e','p','[]',1,'now','d',0,
           'r','d','d2','r2','d3',0,'old.md','target.md','default.md','c','now','now');"
    ).expect("seed unresolved old-family row");
    let error = schema::run_migrations(&blocked).expect_err("drain gate must block migration");
    assert!(
        error
            .to_string()
            .contains("FORMAL_SWITCH_MIGRATION_DRAIN_INCOMPLETE"),
        "{error}"
    );
    let user_version: i64 = blocked
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    let generic_table: i64 = blocked.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='formal_switch_operations'", [], |row| row.get(0)).unwrap();
    let migration_row: i64 = blocked
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version=53",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!((user_version, generic_table, migration_row), (52, 0, 0));
}
