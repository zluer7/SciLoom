#[cfg(test)]
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

#[cfg(test)]
pub(crate) fn is_canonical_formal_switch_phase(phase: &str) -> bool {
    CANONICAL_FORMAL_SWITCH_PHASES.contains(&phase)
}

#[cfg(test)]
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

#[cfg(test)]
pub(crate) fn safe_formal_switch_value(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 500 && !value.contains('\0')
}

#[cfg(test)]
pub(crate) fn safe_formal_switch_file_name(value: &str) -> bool {
    safe_formal_switch_value(value) && !value.contains(['/', '\\', ':'])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_guards_keep_legacy_recovery_fail_closed() {
        for phase in CANONICAL_FORMAL_SWITCH_PHASES {
            assert!(is_canonical_formal_switch_phase(phase));
            assert!(is_valid_formal_switch_transition(phase, phase));
        }
        assert!(!is_canonical_formal_switch_phase("cleanup_pending"));
        assert!(is_valid_formal_switch_transition("prepared", "writeback_unknown"));
        assert!(is_valid_formal_switch_transition("writeback_unknown", "writeback_applied"));
        assert!(!is_valid_formal_switch_transition("prepared", "db_committed"));
        assert!(!is_valid_formal_switch_transition("resolved", "prepared"));
        assert!(!is_valid_formal_switch_transition("cancelled_safe", "prepared"));
    }

    #[test]
    fn scalar_and_file_name_guards_preserve_safe_boundaries() {
        for value in ["", " \t\r\n", "operation\0id"] {
            assert!(!safe_formal_switch_value(value));
            assert!(!safe_formal_switch_file_name(value));
        }
        assert!(safe_formal_switch_value(&"a".repeat(500)));
        assert!(!safe_formal_switch_value(&"a".repeat(501)));
        assert!(safe_formal_switch_file_name(&"a".repeat(500)));
        assert!(!safe_formal_switch_file_name(&"a".repeat(501)));
        assert!(safe_formal_switch_file_name("实验稿.md"));
        for name in ["../draft.md", "folder\\draft.md", "C:draft.md"] {
            assert!(!safe_formal_switch_file_name(name));
        }
    }
}
