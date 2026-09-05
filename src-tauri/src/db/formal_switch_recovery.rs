pub(crate) const CANONICAL_FORMAL_SWITCH_PHASES: &[&str] = &[
    "prepared",
    "writeback_unknown",
    "writeback_applied",
    "db_commit_unknown",
    "db_committed",
    "activation_pending",
    "resolved",
    "blocked",
    "cancelled_safe",
];

pub(crate) fn is_canonical_formal_switch_phase(phase: &str) -> bool {
    CANONICAL_FORMAL_SWITCH_PHASES.contains(&phase)
}

pub(crate) fn is_valid_formal_switch_transition(before: &str, after: &str) -> bool {
    before == after
        || matches!(
            (before, after),
            ("prepared", "writeback_unknown")
                | ("prepared", "writeback_applied")
                | ("prepared", "cancelled_safe")
                | ("prepared", "blocked")
                | ("writeback_unknown", "writeback_applied")
                | ("writeback_unknown", "blocked")
                | ("writeback_applied", "db_commit_unknown")
                | ("writeback_applied", "blocked")
                | ("db_commit_unknown", "writeback_applied")
                | ("db_commit_unknown", "db_committed")
                | ("db_commit_unknown", "blocked")
                | ("db_committed", "activation_pending")
                | ("db_committed", "resolved")
                | ("db_committed", "blocked")
                | ("activation_pending", "resolved")
                | ("activation_pending", "blocked")
        )
}

pub(crate) fn safe_formal_switch_value(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 500 && !value.contains('\0')
}

pub(crate) fn safe_formal_switch_file_name(value: &str) -> bool {
    safe_formal_switch_value(value) && !value.contains(['/', '\\', ':'])
}
