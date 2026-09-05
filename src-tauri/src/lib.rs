#[cfg(all(test, target_os = "windows", target_env = "msvc"))]
#[used]
#[link_section = ".drectve"]
static TEST_COMMON_CONTROLS_MANIFEST_DEPENDENCY: [u8; b"/MANIFESTDEPENDENCY:\"type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'\"".len()] =
    *b"/MANIFESTDEPENDENCY:\"type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'\"";

mod commands;
mod authorized_material;
mod bundled_demo_resource;
pub mod db;
mod export_file;
#[allow(dead_code)]
mod manuscript_provisioning_contract;
mod manuscript_save_as_d1;
mod manuscript_save_as_target_guard;
mod manuscript_writable_admission;
mod managed_root_configuration;
mod markdown_file;
mod native_open;
mod owner_authority_lease;
mod physical_freshness;
#[allow(dead_code)]
mod planning_authority_transport;
mod provisioning;
mod provisioning_mainline;
#[allow(dead_code)]
mod provisioning_runtime;
#[allow(dead_code)]
mod provisioning_runtime_foundation;
#[cfg(target_os = "windows")]
mod windows_app_icon;

use std::sync::Arc;
use tauri::Manager;

#[cfg(test)]
mod manuscript_provisioning_contract_p4_3_a_tests;
#[cfg(test)]
mod lp12_3_b_f6_dynamic_evidence_tests;
#[cfg(test)]
mod owner_authority_lease_tests;
#[cfg(test)]
mod physical_freshness_tests;
#[cfg(test)]
mod provisioning_runtime_claim_ownership_pre_tests;
#[cfg(test)]
mod provisioning_runtime_non_completed_exit_tests;
#[cfg(test)]
mod provisioning_runtime_ownership_supervisor_tests;
#[cfg(test)]
mod provisioning_runtime_p3b3_tests;
#[cfg(test)]
mod provisioning_runtime_p3b4_tests;
#[cfg(test)]
mod provisioning_runtime_review_adapter_tests;
#[cfg(test)]
mod provisioning_runtime_shared_executor_tests;
#[cfg(test)]
mod provisioning_runtime_tests;

#[tauri::command]
fn app_health() -> &'static str {
    "SciLoom is running"
}

pub fn run() {
    let process_generation =
        Arc::new(provisioning_runtime_foundation::ProcessGeneration::new_process());
    let monotonic_clock =
        Arc::new(provisioning_runtime::lifecycle::SystemMonotonicClock::default());
    let ownership_context = Arc::new(
        db::manuscript_provisioning_operation_state::claim_ownership::
            ClaimOwnershipRepositoryContext::new(
                process_generation.clone(),
                Arc::new(
                    db::manuscript_provisioning_operation_state::claim_ownership::
                        SystemRepositoryUtcClock,
                ),
            ),
    );
    let authority_registry = Arc::new(
        owner_authority_lease::OwnerAuthorityLeaseRegistry::from_process_generation(
            process_generation.clone(),
        ),
    );
    let planning_authority_transport = Arc::new(
        planning_authority_transport::PlanningAuthorityTransportFoundation::new(
            process_generation.clone(),
            monotonic_clock.clone(),
        ),
    );
    let manuscript_writable_admission = Arc::new(
        manuscript_writable_admission::ManuscriptWritableAdmissionAuthority::
            from_process_generation(process_generation.clone()),
    );
    let manuscript_save_as_target_guard = Arc::new(
        manuscript_save_as_target_guard::ManuscriptSaveAsTargetGuardAuthority::
            from_process_generation(process_generation.clone()),
    );
    debug_assert_eq!(
        authority_registry.process_generation().canonical(),
        ownership_context.process_generation().canonical()
    );
    let app = tauri::Builder::default()
        .manage(db::experiment_run_lifecycle::LifecycleTokenStore::default())
        .manage(commands::ai_provider_configuration::ProviderConfigurationService::default())
        .manage(commands::ai_streaming::AIStreamingState::default())
        .manage(authority_registry.clone())
        .manage(planning_authority_transport.clone())
        .manage(manuscript_writable_admission.clone())
        .manage(manuscript_save_as_target_guard.clone())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            #[cfg(target_os = "windows")]
            {
                let main_window = app.get_webview_window("main").ok_or_else(|| {
                    std::io::Error::other("SciLoom main window was not created")
                })?;
                let icon_handles = windows_app_icon::install(&main_window).map_err(|error| {
                    eprintln!("SciLoom Windows icon initialization failed: {error}");
                    std::io::Error::other(error)
                })?;
                app.manage(icon_handles);
            }
            let initialized_database_path =
                db::initialize_database(app.handle()).map_err(|error| {
                    eprintln!("SciLoom SQLite initialization failed: {error}");
                    std::io::Error::other(error)
                })?;
            app.manage(authorized_material::AuthorizedMaterialRuntime::new(
                initialized_database_path.clone(),
            ));
            provisioning_runtime::tauri_state::install_provisioning_runtime(
                app.handle(),
                initialized_database_path,
                ownership_context.clone(),
                process_generation.clone(),
                planning_authority_transport.clone(),
                authority_registry.clone(),
                monotonic_clock.clone(),
            )
            .map_err(|error| {
                eprintln!("SciLoom Provisioning Runtime activation failed: {error:?}");
                std::io::Error::other("Provisioning Runtime activation failed")
            })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_health,
            bundled_demo_resource::read_bundled_demo_project_import,
            db::db_get_runtime_identity,
            db::db_count_records,
            db::db_list_records,
            db::db_get_record,
            db::db_list_deleted_records,
            db::db_get_deleted_record,
            db::db_save_record,
            db::db_insert_record_if_absent,
            db::db_update_record,
            db::db_soft_delete_record,
            db::db_restore_record,
            db::db_hard_delete_record,
            db::commit_output_lifecycle_transaction,
            db::ai_durable_foundation::db_create_ai_conversation,
            db::ai_durable_foundation::db_prepare_ai_call_attempt,
            db::ai_durable_foundation::db_prepare_ai_retry_regenerate_attempt,
            db::ai_durable_foundation::db_prepare_ai_context_request_followup,
            db::ai_durable_foundation::db_reject_ai_context_request,
            db::ai_durable_foundation::db_mark_ai_context_request_stale,
            db::ai_durable_foundation::db_update_ai_standard_result_draft,
            db::ai_durable_foundation::db_dismiss_ai_standard_result,
            db::ai_durable_foundation::db_begin_ai_standard_result_confirmation,
            db::ai_durable_foundation::db_settle_ai_standard_result_effect,
            db::ai_durable_foundation::db_fail_ai_standard_result,
            db::ai_durable_foundation::db_settle_ai_call_attempt_success,
            db::ai_durable_foundation::db_settle_ai_call_attempt_failure,
            db::ai_durable_foundation::db_read_ai_conversation,
            db::ai_durable_foundation::db_list_ai_conversations,
            db::ai_durable_foundation::db_list_ai_attachment_file_refs,
            db::manuscript_binding::db_read_manuscript_binding_identity,
            db::manuscript_binding::db_write_manuscript_binding,
            db::manuscript_binding::db_is_file_ref_referenced_by_binding,
            db::representative_runs::db_list_representative_runs,
            db::representative_runs::db_add_representative_run,
            db::representative_runs::db_remove_representative_run,
            db::representative_runs::db_set_representative_run_order,
            db::representative_runs::db_get_representative_run_aggregate,
            db::representative_runs::db_cleanup_representative_run_relations,
            db::manuscript_save_as_operation::create_save_as_operation,
            db::review_lifecycle_action::prepare_review_lifecycle_action,
            db::review_lifecycle_action::readback_review_lifecycle_action,
            db::review_lifecycle_action::read_pending_review_lifecycle_action,
            db::review_lifecycle_action::list_pending_review_lifecycle_actions,
            db::review_lifecycle_action::record_review_lifecycle_planning_commit,
            db::review_lifecycle_action::record_review_lifecycle_operation_log,
            db::review_lifecycle_action::record_review_lifecycle_recycle_create,
            db::review_lifecycle_action::record_review_lifecycle_recycle_restore,
            db::review_lifecycle_action::complete_review_lifecycle_action,
            db::review_lifecycle_action::record_review_lifecycle_action_failure,
            db::review_structured_state::migrate_review_structured_states,
            db::review_structured_state::provision_review_structured_state,
            db::review_structured_state::read_review_structured_states,
            db::review_structured_state::replace_review_structured_state,
            db::review_permanent_delete::read_review_permanent_delete_metadata_inventory,
            db::review_permanent_delete::prepare_review_permanent_delete_action,
            db::review_permanent_delete::readback_review_permanent_delete_action,
            db::review_permanent_delete::read_pending_review_permanent_delete_action,
            db::review_permanent_delete::record_review_permanent_delete_planning_commit,
            db::review_permanent_delete::finalize_review_permanent_delete_metadata,
            db::manuscript_save_as_operation::transition_save_as_operation,
            db::manuscript_save_as_operation::readback_save_as_operation,
            db::manuscript_save_as_operation::list_reconcilable_save_as_operations,
            db::manuscript_save_as_operation::claim_save_as_operation_observation,
            db::manuscript_save_as_operation::atomic_commit_save_as_d2,
            db::manuscript_save_as_operation::contain_unknown_save_as_d2,
            db::manuscript_save_as_operation::confirm_contained_save_as_d2,
            db::manuscript_save_as_operation::dismiss_contained_save_as_d2_notice,
            db::manuscript_save_as_operation::audit_terminal_save_as_d2_integrity,
            db::manuscript_save_as_operation::list_visible_save_as_d2_containment,
            db::manuscript_save_as_operation::list_reconciled_terminal_save_as_d2_operations,
            db::manuscript_save_as_candidate_custody::plan_save_as_candidate_custody,
            db::manuscript_save_as_candidate_custody::readback_save_as_candidate_custody,
            db::manuscript_save_as_candidate_custody::record_save_as_candidate_activation,
            db::manuscript_save_as_candidate_custody::record_save_as_candidate_recovery_activation,
            db::manuscript_save_as_candidate_custody::transfer_save_as_candidate_custody,
            db::manuscript_save_as_candidate_custody::claim_save_as_candidate_cleanup,
            db::manuscript_save_as_candidate_custody::record_save_as_candidate_cleanup,
            db::manuscript_save_as_finalization::record_save_as_presentation_completed,
            db::manuscript_save_as_finalization::issue_save_as_finalization_request,
            db::manuscript_save_as_finalization::readback_save_as_finalization,
            db::manuscript_save_as_finalization::list_pending_save_as_finalizations,
            db::manuscript_save_as_finalization::list_interrupted_save_as_finalizations,
            db::manuscript_save_as_finalization::contain_pre_presentation_missing_binding_save_as,
            db::manuscript_save_as_finalization::contain_interrupted_save_as_finalization,
            db::manuscript_save_as_finalization::reconcile_interrupted_save_as_preserving_target,
            db::manuscript_save_as_finalization::claim_save_as_finalization,
            db::manuscript_save_as_finalization::record_save_as_lifecycle_decision,
            db::manuscript_save_as_finalization::finalize_save_as_operation,
            db::manuscript_save_as_finalization::record_save_as_revoked_decision,
            db::manuscript_save_as_finalization::complete_save_as_finalization_compensation,
            db::manuscript_save_as_finalization::block_save_as_finalization,
            db::experiment_run_lifecycle::db_inspect_experiment_run_lifecycle,
            db::experiment_run_lifecycle::db_issue_experiment_run_lifecycle_preflight_token,
            db::experiment_run_lifecycle::db_soft_delete_experiment_run_metadata,
            db::experiment_run_lifecycle::db_restore_experiment_run_metadata,
            db::experiment_run_lifecycle::db_confirm_experiment_run_hard_metadata_delete,
            db::formal_switch_reference_owner_bridge::reference_owner_formal_switch_bridge,
            db::experiment_run_file_ref_cleanup::db_cleanup_experiment_run_file_refs,
            export_file::save_text_file,
            markdown_file::read_markdown_file,
            markdown_file::read_explicit_manuscript_file,
            markdown_file::select_markdown_save_path,
            markdown_file::save_markdown_file,
            markdown_file::write_current_markdown_file_atomic,
            markdown_file::save_explicit_manuscript_file_atomic,
            manuscript_writable_admission::manuscript_writable_admit,
            manuscript_writable_admission::manuscript_writable_retain,
            manuscript_writable_admission::manuscript_writable_validate,
            manuscript_writable_admission::manuscript_writable_renew,
            manuscript_writable_admission::manuscript_writable_release,
            manuscript_writable_admission::manuscript_writable_detach_window,
            managed_root_configuration::read_managed_root_configuration,
            managed_root_configuration::configure_managed_root_first_time,
            manuscript_save_as_target_guard::observe_save_as_process_generation,
            manuscript_save_as_target_guard::acquire_save_as_target_guard,
            manuscript_save_as_target_guard::retain_save_as_target_guard,
            manuscript_save_as_target_guard::validate_save_as_target_guard,
            manuscript_save_as_target_guard::release_save_as_target_guard,
            manuscript_save_as_target_guard::detach_save_as_target_guard_window,
            physical_freshness::observe_save_as_target_candidate,
            manuscript_save_as_d1::save_as_create_new_with_readback,
            markdown_file::create_managed_candidate_markdown,
            markdown_file::create_managed_workspace_markdown_copy,
            native_open::open_file,
            native_open::open_folder,
            native_open::validate_managed_folder,
            native_open::validate_existing_folder,
            native_open::reveal_in_folder,
            native_open::inspect_local_path,
            provisioning::provision_managed_entry,
            provisioning::provision_experiment_manuscript,
            provisioning::provision_experiment_run_manuscript,
            provisioning_mainline::provisioning_mainline_begin,
            provisioning_mainline::provisioning_mainline_finish,
            provisioning_runtime::adapter::provisioning_runtime_mark_main_window_ready,
            provisioning_runtime::adapter::provisioning_runtime_get_snapshot,
            provisioning_runtime::adapter::provisioning_runtime_get_startup_issues,
            provisioning_runtime::adapter::provisioning_runtime_retry_startup_scan,
            provisioning_runtime::adapter::provisioning_runtime_get_audit_summary,
            provisioning_runtime::adapter::provisioning_runtime_retry_audit_one,
            owner_authority_lease::owner_authority_try_acquire_many,
            owner_authority_lease::owner_authority_validate,
            owner_authority_lease::owner_authority_release,
            planning_authority_transport::planning_authority_register_producer,
            planning_authority_transport::planning_authority_submit_attestation,
            planning_authority_transport::planning_authority_revoke_producer,
            commands::ai_provider_configuration::get_ai_provider_configuration_status,
            commands::ai_provider_configuration::save_ai_provider_active_tuple,
            commands::ai_provider_configuration::clear_ai_provider_active_tuple,
            commands::ai_provider_configuration::set_ai_provider_api_key,
            commands::ai_provider_configuration::clear_ai_provider_api_key,
            commands::ai::run_ai_text,
            commands::ai_streaming::stream_ai_text,
            commands::ai_streaming::cancel_ai_text_stream
        ])
        .build(tauri::generate_context!())
        .expect("failed to build SciLoom");
    app.run(|app_handle, event| {
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } = &event
        {
            if let Some(registry) =
                app_handle.try_state::<Arc<owner_authority_lease::OwnerAuthorityLeaseRegistry>>()
            {
                registry.release_caller(label);
            }
            if let Some(transport) = app_handle
                .try_state::<Arc<planning_authority_transport::PlanningAuthorityTransportFoundation>>()
            {
                transport.revoke_window(label);
            }
            if let Some(authority) = app_handle.try_state::<Arc<
                manuscript_writable_admission::ManuscriptWritableAdmissionAuthority,
            >>() {
                authority.detach_caller(label);
            }
            if let Some(authority) = app_handle.try_state::<Arc<
                manuscript_save_as_target_guard::ManuscriptSaveAsTargetGuardAuthority,
            >>() {
                authority.detach_caller(label);
            }
        }
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            if let Some(runtime) =
                app_handle.try_state::<Arc<provisioning_runtime::core::ProvisioningRuntime>>()
            {
                runtime.shutdown_production();
            }
            if let Some(transport) = app_handle
                .try_state::<Arc<planning_authority_transport::PlanningAuthorityTransportFoundation>>()
            {
                transport.shutdown();
            }
        }
    });
}
