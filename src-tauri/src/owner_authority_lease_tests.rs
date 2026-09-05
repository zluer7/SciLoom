use crate::owner_authority_lease::{
    AuthorityKey, AuthorityLeaseError, AuthorityLeaseMode, AuthorityLeaseRequest,
    OwnerAuthorityLeaseRegistry,
};

fn project(project_id: &str, mode: AuthorityLeaseMode) -> AuthorityLeaseRequest {
    AuthorityLeaseRequest {
        key: AuthorityKey::Project {
            project_id: project_id.into(),
        },
        mode,
    }
}

fn owner(owner_id: &str, mode: AuthorityLeaseMode) -> AuthorityLeaseRequest {
    AuthorityLeaseRequest {
        key: AuthorityKey::Owner {
            owner_type: "review".into(),
            owner_id: owner_id.into(),
        },
        mode,
    }
}

fn channel(owner_id: &str, mode: AuthorityLeaseMode) -> AuthorityLeaseRequest {
    AuthorityLeaseRequest {
        key: AuthorityKey::ChannelScope {
            owner_type: "review".into(),
            owner_id: owner_id.into(),
            scope: "primary".into(),
        },
        mode,
    }
}

#[test]
fn read_read_is_compatible_and_write_conflicts_are_all_or_none() {
    let registry = OwnerAuthorityLeaseRegistry::new();
    let first = registry
        .try_acquire_many(
            "window-a",
            "request-a",
            vec![project("p", AuthorityLeaseMode::Read)],
        )
        .unwrap();
    let second = registry
        .try_acquire_many(
            "window-b",
            "request-b",
            vec![project("p", AuthorityLeaseMode::Read)],
        )
        .unwrap();

    let error = registry
        .try_acquire_many(
            "window-c",
            "request-c",
            vec![
                project("p", AuthorityLeaseMode::Write),
                owner("review-c", AuthorityLeaseMode::Write),
            ],
        )
        .unwrap_err();
    assert_eq!(error, AuthorityLeaseError::LeaseBusy);
    assert_eq!(registry.active_lease_count(), 2);

    registry.release("window-a", &first.token).unwrap();
    registry.release("window-b", &second.token).unwrap();
    assert_eq!(registry.active_lease_count(), 0);
}

#[test]
fn key_normalization_is_stable_deduplicated_and_write_dominates() {
    let registry = OwnerAuthorityLeaseRegistry::new();
    let lease = registry
        .try_acquire_many(
            "window-a",
            "request-a",
            vec![
                channel("r", AuthorityLeaseMode::Read),
                project("p", AuthorityLeaseMode::Read),
                owner("r", AuthorityLeaseMode::Read),
                project("p", AuthorityLeaseMode::Write),
                channel("r", AuthorityLeaseMode::Read),
            ],
        )
        .unwrap();

    assert_eq!(lease.requests.len(), 3);
    assert_eq!(lease.requests[0], project("p", AuthorityLeaseMode::Write));
    assert_eq!(lease.requests[1], owner("r", AuthorityLeaseMode::Read));
    assert_eq!(lease.requests[2], channel("r", AuthorityLeaseMode::Read));
}

#[test]
fn same_caller_cannot_implicitly_reenter_an_held_key() {
    let registry = OwnerAuthorityLeaseRegistry::new();
    let _lease = registry
        .try_acquire_many(
            "window-a",
            "request-a",
            vec![owner("r", AuthorityLeaseMode::Read)],
        )
        .unwrap();
    assert_eq!(
        registry
            .try_acquire_many(
                "window-a",
                "request-b",
                vec![owner("r", AuthorityLeaseMode::Read)]
            )
            .unwrap_err(),
        AuthorityLeaseError::LeaseConflict
    );
}

#[test]
fn actual_caller_owns_validation_and_release_and_duplicate_release_is_idempotent() {
    let registry = OwnerAuthorityLeaseRegistry::new();
    let lease = registry
        .try_acquire_many(
            "window-a",
            "request-a",
            vec![
                project("p", AuthorityLeaseMode::Read),
                owner("r", AuthorityLeaseMode::Read),
            ],
        )
        .unwrap();

    assert_eq!(
        registry
            .validate("window-b", &lease.token, &lease.requests)
            .unwrap_err(),
        AuthorityLeaseError::LeaseNotOwned
    );
    assert_eq!(
        registry.release("window-b", &lease.token).unwrap_err(),
        AuthorityLeaseError::LeaseNotOwned
    );
    registry
        .validate("window-a", &lease.token, &lease.requests)
        .unwrap();
    registry.release("window-a", &lease.token).unwrap();
    registry.release("window-a", &lease.token).unwrap();
}

#[test]
fn close_releases_only_the_actual_callers_leases() {
    let registry = OwnerAuthorityLeaseRegistry::new();
    registry
        .try_acquire_many(
            "window-a",
            "request-a",
            vec![project("a", AuthorityLeaseMode::Read)],
        )
        .unwrap();
    let lease_b = registry
        .try_acquire_many(
            "window-b",
            "request-b",
            vec![project("b", AuthorityLeaseMode::Read)],
        )
        .unwrap();

    assert_eq!(registry.release_caller("window-a"), 1);
    registry
        .validate("window-b", &lease_b.token, &lease_b.requests)
        .unwrap();
    assert_eq!(registry.active_lease_count(), 1);
}

#[test]
fn process_restart_and_generation_change_make_tokens_stale() {
    let registry = OwnerAuthorityLeaseRegistry::new();
    let lease = registry
        .try_acquire_many(
            "window-a",
            "request-a",
            vec![project("p", AuthorityLeaseMode::Read)],
        )
        .unwrap();
    registry.rotate_generation_for_test();
    assert_eq!(
        registry
            .validate("window-a", &lease.token, &lease.requests)
            .unwrap_err(),
        AuthorityLeaseError::LeaseStale
    );

    let restarted = OwnerAuthorityLeaseRegistry::new();
    assert_eq!(
        restarted
            .validate("window-a", &lease.token, &lease.requests)
            .unwrap_err(),
        AuthorityLeaseError::LeaseStale
    );
}

#[test]
fn project_owner_and_channel_combinations_express_the_hierarchy_without_waiting() {
    let registry = OwnerAuthorityLeaseRegistry::new();
    let _provisioning = registry
        .try_acquire_many(
            "window-a",
            "request-a",
            vec![
                project("p", AuthorityLeaseMode::Read),
                owner("r", AuthorityLeaseMode::Read),
                channel("r", AuthorityLeaseMode::Write),
            ],
        )
        .unwrap();

    assert_eq!(
        registry
            .try_acquire_many(
                "window-b",
                "request-b",
                vec![project("p", AuthorityLeaseMode::Write)]
            )
            .unwrap_err(),
        AuthorityLeaseError::LeaseBusy
    );
    assert_eq!(
        registry
            .try_acquire_many(
                "window-b",
                "request-c",
                vec![
                    project("p", AuthorityLeaseMode::Read),
                    owner("r", AuthorityLeaseMode::Write)
                ]
            )
            .unwrap_err(),
        AuthorityLeaseError::LeaseBusy
    );
}

#[test]
fn rust_guard_drop_and_panic_paths_release_the_callers_lease() {
    let registry = OwnerAuthorityLeaseRegistry::new();
    {
        let _guard = registry
            .try_acquire_guard(
                "window-a",
                "drop",
                vec![project("p", AuthorityLeaseMode::Write)],
            )
            .unwrap();
        assert_eq!(registry.active_lease_count(), 1);
    }
    assert_eq!(registry.active_lease_count(), 0);

    let outcome = std::panic::catch_unwind(|| {
        let _guard = registry
            .try_acquire_guard(
                "window-a",
                "panic",
                vec![project("p", AuthorityLeaseMode::Write)],
            )
            .unwrap();
        panic!("isolated panic fixture");
    });
    assert!(outcome.is_err());
    assert_eq!(registry.active_lease_count(), 0);
}
