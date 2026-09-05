use super::core::ProvisioningRuntime;
use super::database_provider::SqliteRuntimeDatabaseProvider;
use super::feedback::RuntimeSafeErrorCode;
#[cfg(test)]
use super::lifecycle::SystemMonotonicClock;
#[cfg(test)]
use super::lifecycle::{InlineRuntimeTaskSpawner, NoopRuntimeEventSink};
use super::lifecycle::{
    RuntimeEventSink, RuntimeStateNotification, TauriAsyncHeartbeatTicker, TauriRuntimeTaskSpawner,
};
use super::production_adapter_registry::ProductionAdapterRegistry;
use super::recovery_entry::ProvisioningRecoveryRuntimeFacade;
use super::review_recovery::CanonicalRecoveryNeedBridge;
use super::review_recovery_application_service::{
    CanonicalRecoveryApplicationOrchestration, ExperimentRecoveryApplicationService,
    ReviewRecoveryApplicationService,
};
use super::shared_executor::{SharedExecutorFoundation, SharedExecutorFoundationProvider};
use crate::db::manuscript_provisioning_operation_state::claim_ownership::ClaimOwnershipRepositoryContext;
#[cfg(test)]
use crate::db::manuscript_provisioning_operation_state::claim_ownership::FixedRepositoryUtcClock;
use crate::owner_authority_lease::OwnerAuthorityLeaseRegistry;
use crate::planning_authority_transport::PlanningAuthorityTransportFoundation;
use crate::provisioning_runtime_foundation::ProcessGeneration;
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub(crate) const PROVISIONING_RUNTIME_STATE_CHANGED_EVENT: &str =
    "provisioning-runtime-state-changed";

struct TauriRuntimeEventSink<R: Runtime> {
    app_handle: AppHandle<R>,
}

impl<R: Runtime> TauriRuntimeEventSink<R> {
    fn new(app_handle: AppHandle<R>) -> Self {
        Self { app_handle }
    }
}

impl<R: Runtime> RuntimeEventSink for TauriRuntimeEventSink<R> {
    fn notify(&self, notification: RuntimeStateNotification) {
        let _ = self
            .app_handle
            .emit(PROVISIONING_RUNTIME_STATE_CHANGED_EVENT, notification);
    }
}

pub(crate) fn install_provisioning_runtime<R: Runtime>(
    app_handle: &AppHandle<R>,
    initialized_database_path: PathBuf,
    ownership_context: Arc<ClaimOwnershipRepositoryContext>,
    process_generation: Arc<ProcessGeneration>,
    planning_transport: Arc<PlanningAuthorityTransportFoundation>,
    authority_registry: Arc<OwnerAuthorityLeaseRegistry>,
    monotonic_clock: Arc<dyn super::heartbeat_scheduler::MonotonicClock>,
) -> Result<(), RuntimeSafeErrorCode> {
    if app_handle.try_state::<Arc<ProvisioningRuntime>>().is_some() {
        return Err(RuntimeSafeErrorCode::RuntimeAlreadyInitialized);
    }
    let production_adapter_registry = Arc::new(
        ProductionAdapterRegistry::build_review_and_experiment_primary(
            initialized_database_path.clone(),
        )
        .map_err(|_| RuntimeSafeErrorCode::RuntimeAdapterUnavailable)?,
    );
    let database_provider = Arc::new(
        SqliteRuntimeDatabaseProvider::new_production_initialized(initialized_database_path)
            .map_err(|error| error.safe_error_code)?,
    );
    let ticker = Arc::new(TauriAsyncHeartbeatTicker::new(Duration::from_secs(30)));
    let runtime = Arc::new(ProvisioningRuntime::new_production(
        database_provider.clone(),
        ownership_context.clone(),
        monotonic_clock.clone(),
        ticker.clone(),
        Arc::new(TauriRuntimeTaskSpawner),
        Arc::new(TauriRuntimeEventSink::new(app_handle.clone())),
    ));
    bind_runtime_ticker(&runtime, &ticker)?;
    let foundation = Arc::new(
        SharedExecutorFoundation::from_runtime(
            &runtime,
            authority_registry,
            production_adapter_registry.clone(),
        )
        .ok_or(RuntimeSafeErrorCode::RuntimeAdapterUnavailable)?,
    );
    let foundation_provider = Arc::new(SharedExecutorFoundationProvider::new(foundation));
    let production = runtime
        .inner
        .production
        .as_ref()
        .ok_or(RuntimeSafeErrorCode::RuntimeAdapterUnavailable)?;
    let facade = Arc::new(ProvisioningRecoveryRuntimeFacade::new(
        planning_transport.clone(),
        process_generation.clone(),
        database_provider,
        ownership_context,
        production.ownership_supervisor.clone(),
        foundation_provider.clone(),
        monotonic_clock.clone(),
    ));
    let bridge = Arc::new(CanonicalRecoveryNeedBridge::new(
        production_adapter_registry.clone(),
    ));
    let orchestration = Arc::new(CanonicalRecoveryApplicationOrchestration::new(
        planning_transport,
        process_generation,
        facade.clone(),
        bridge.clone(),
        monotonic_clock,
    ));
    let review_application_service =
        Arc::new(ReviewRecoveryApplicationService::new(orchestration.clone()));
    let experiment_application_service = Arc::new(ExperimentRecoveryApplicationService::new(
        orchestration.clone(),
    ));
    if !app_handle.manage(production_adapter_registry)
        || !app_handle.manage(bridge)
        || !app_handle.manage(orchestration)
        || !app_handle.manage(review_application_service)
        || !app_handle.manage(experiment_application_service)
        || !app_handle.manage(foundation_provider)
        || !app_handle.manage(facade)
        || !app_handle.manage(runtime)
    {
        return Err(RuntimeSafeErrorCode::RuntimeAlreadyInitialized);
    }
    Ok(())
}

fn bind_runtime_ticker(
    runtime: &Arc<ProvisioningRuntime>,
    ticker: &Arc<TauriAsyncHeartbeatTicker>,
) -> Result<(), RuntimeSafeErrorCode> {
    let weak_runtime: Weak<ProvisioningRuntime> = Arc::downgrade(runtime);
    ticker.bind_tick(Arc::new(move || {
        if let Some(runtime) = weak_runtime.upgrade() {
            runtime.tick_heartbeats();
        }
    }))
}

#[cfg(test)]
pub(crate) fn install_isolated_provisioning_runtime_for_test<R: Runtime>(
    app_handle: &AppHandle<R>,
    isolated_database_path: PathBuf,
    isolated_identifier: &str,
) -> Result<Arc<ProvisioningRuntime>, RuntimeSafeErrorCode> {
    if app_handle.try_state::<Arc<ProvisioningRuntime>>().is_some() {
        return Err(RuntimeSafeErrorCode::RuntimeAlreadyInitialized);
    }
    let database_provider = Arc::new(
        SqliteRuntimeDatabaseProvider::new_isolated(isolated_database_path, isolated_identifier)
            .map_err(|error| error.safe_error_code)?,
    );
    let runtime = Arc::new(ProvisioningRuntime::new_production(
        database_provider,
        Arc::new(ClaimOwnershipRepositoryContext::new(
            Arc::new(ProcessGeneration::fixed_for_test(
                "isolated-p3b4-app-instance-token",
            )),
            Arc::new(FixedRepositoryUtcClock::new(1_700_000_000_000)),
        )),
        Arc::new(SystemMonotonicClock::default()),
        Arc::new(super::heartbeat_scheduler::RecordingTicker::default()),
        Arc::new(InlineRuntimeTaskSpawner),
        Arc::new(NoopRuntimeEventSink),
    ));
    if !app_handle.manage(runtime.clone()) {
        return Err(RuntimeSafeErrorCode::RuntimeAlreadyInitialized);
    }
    Ok(runtime)
}
