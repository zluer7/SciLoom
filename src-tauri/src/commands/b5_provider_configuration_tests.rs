//! B5 focused tests and opt-in mounted harness bridge. Never compiled into the product.
use super::*;

#[test]
fn b5_direct_configuration_is_exact_and_never_uses_another_provider_credential() {
    let active = Arc::new(MemoryCredentialStore::absent());
    let service = ProviderConfigurationService::new(active.clone(), test_credential_stores(None), Arc::new(FakeEnvironmentSecretReader::absent()));
    for (provider, model, thinking) in [(PROVIDER_QWEN, QWEN_MODEL, ProviderThinkingField::EnableThinkingFalse), (PROVIDER_GEMINI, GEMINI_MODEL, ProviderThinkingField::Omit)] {
        let preset = provider_model_preset(provider, model).unwrap();
        assert_eq!(preset.thinking_field(), thinking);
        assert!(preset.endpoint().starts_with("https://"));
        let saved = service.save_active_tuple(provider.into(), model.into()).unwrap();
        assert_eq!(saved.active_provider, provider);
        assert_eq!(saved.active_model, model);
        assert_eq!(saved.effective_configured, ConfiguredState::No);
        match service.resolve_snapshot(saved.configuration_revision) {
            Err(error) => assert_eq!(serde_json::from_str::<serde_json::Value>(&error).unwrap()["code"], "missing_api_key"),
            Ok(_) => panic!("an unconfigured provider must not resolve a snapshot"),
        }
        let sentinel = format!("synthetic-b5-{provider}-only");
        let configured = service.set_api_key(provider.into(), sentinel.clone()).unwrap();
        assert!(!serde_json::to_string(&configured).unwrap().contains(&sentinel));
        let snapshot = service.resolve_snapshot(configured.configuration_revision).unwrap();
        assert_eq!(snapshot.provider(), provider);
        assert_eq!(snapshot.model(), model);
        let other = if provider == PROVIDER_QWEN { PROVIDER_GEMINI } else { PROVIDER_QWEN };
        assert_eq!(service.status(Some(other)).unwrap().effective_configured, ConfiguredState::No);
        service.clear_api_key(provider.into()).unwrap();
    }
    let before = serde_json::to_value(service.status(None).unwrap()).unwrap();
    assert!(service.save_active_tuple(PROVIDER_QWEN.into(), GEMINI_MODEL.into()).is_err());
    assert!(service.save_active_tuple(PROVIDER_GEMINI.into(), "arbitrary-model".into()).is_err());
    assert_eq!(serde_json::to_value(service.status(None).unwrap()).unwrap(), before);
    let recreated = ProviderConfigurationService::new(active, test_credential_stores(None), Arc::new(FakeEnvironmentSecretReader::absent()));
    assert_eq!(recreated.status(None).unwrap().active_provider, PROVIDER_GEMINI);
}

#[cfg(target_os = "windows")]
#[test]
#[ignore = "opt-in task-owned mounted Settings IPC / Windows secure tuple persistence bridge"]
fn b5_settings_persistence_bridge() {
    use std::io::{BufRead, Write};
    use tauri::Manager;
    let root = std::path::PathBuf::from(std::env::var("SCILOOM_B5_BRIDGE_ROOT").expect("explicit B5 fixture root"));
    // Reuse this opt-in native test seam without touching a prior task's evidence.
    let task = if root == std::path::PathBuf::from(r"N:\SciLoom\Records\Legacy-reports\Reports410\evidence\sc3_a4_c0") {
        "SC3-A4-C0"
    } else {
        assert_eq!(root, std::path::PathBuf::from(r"N:\SciLoom\Records\Legacy-reports\Reports410\evidence\sc3_a4_b5"));
        "SC3-A4-B5"
    };
    assert!(root.is_dir());
    let target = format!("SciLoom/TEST_ONLY/{task}/{}/active-provider-model", uuid::Uuid::new_v4());
    let active = Arc::new(WindowsCredentialStore::new(target.clone()));
    assert!(matches!(active.read(), AppSecretLookupOutcome::Absent));
    struct Cleanup(Arc<WindowsCredentialStore>);
    impl Drop for Cleanup { fn drop(&mut self) { self.0.delete().expect("delete only the fresh nonsecret B5 tuple target"); } }
    let _cleanup = Cleanup(active.clone());
    let production = ProviderConfigurationService::production();
    let ordinary_before = serde_json::to_value(production.status(None).expect("ordinary safe status read only")).unwrap();
    let live_status = serde_json::json!({"qwen":production.status(Some(PROVIDER_QWEN)).unwrap(),"gemini":production.status(Some(PROVIDER_GEMINI)).unwrap()});
    let make_app = || tauri::test::mock_builder()
        .manage(ProviderConfigurationService::new(Arc::new(WindowsCredentialStore::new(target.clone())),test_credential_stores(None),Arc::new(FakeEnvironmentSecretReader::absent())))
        .invoke_handler(tauri::generate_handler![get_ai_provider_configuration_status,save_ai_provider_active_tuple,clear_ai_provider_active_tuple,set_ai_provider_api_key,clear_ai_provider_api_key])
        .build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let mut app = make_app();
    let mut window = tauri::WebviewWindowBuilder::new(&app,"main",Default::default()).build().unwrap();
    let mut audit = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let input: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        let command = input["command"].as_str().unwrap();
        let body = input["args"].clone();
        if command == "__finish" { break; }
        let result: Result<serde_json::Value,String> = if command == "__production_status" {
            Ok(serde_json::json!({"before":ordinary_before,"liveStatus":live_status,"taskActiveTupleTarget":target,"secretValuesExported":false}))
        } else if command == "__restart" {
            drop(window);drop(app);app=make_app();window=tauri::WebviewWindowBuilder::new(&app,"main",Default::default()).build().unwrap();
            Ok(serde_json::to_value(app.state::<ProviderConfigurationService>().status(None).unwrap()).unwrap())
        } else if command == "__offline_wire" {
            let service=app.state::<ProviderConfigurationService>();
            match service.resolve_snapshot(body["revision"].as_u64().unwrap()) {
                Err(error)=>Err(error),
                Ok(snapshot)=>super::super::ai::b5_offline_wire(snapshot.provider(),snapshot.model(),body["prompt"].as_str().unwrap(),serde_json::to_vec(&body["responseBody"]).unwrap().as_slice(),body["constrained"].as_bool().unwrap_or(false))
            }
        } else {
            assert!(["get_ai_provider_configuration_status","save_ai_provider_active_tuple","set_ai_provider_api_key","clear_ai_provider_api_key","clear_ai_provider_active_tuple"].contains(&command));
            let request=tauri::webview::InvokeRequest {cmd:command.into(),callback:tauri::ipc::CallbackFn(0),error:tauri::ipc::CallbackFn(1),url:"http://tauri.localhost".parse().unwrap(),body:tauri::ipc::InvokeBody::Json(body),headers:Default::default(),invoke_key:tauri::test::INVOKE_KEY.to_string()};
            tauri::test::get_ipc_response(&window,request).map_err(|error|serde_json::from_value::<String>(error).unwrap()).map(|value|value.deserialize::<serde_json::Value>().unwrap())
        };
        // Never record input args: current credential input has a deliberately short lifetime.
        audit.push(serde_json::json!({"command":command,"result":result}));
        println!("B5_RESPONSE {}",serde_json::json!({"id":input["id"],"result":result}));std::io::stdout().flush().unwrap();
    }
    assert_eq!(serde_json::to_value(production.status(None).unwrap()).unwrap(),ordinary_before);
    app.state::<ProviderConfigurationService>().clear_active_tuple().unwrap();
    assert!(matches!(active.read(),AppSecretLookupOutcome::Absent));
    std::fs::write(root.join("native-settings-persistence.json"),serde_json::to_vec_pretty(&serde_json::json!({"target":target,"statusOnlyOrdinaryBefore":ordinary_before,"ordinaryStatusUnchanged":true,"liveStatus":live_status,"audit":audit,"taskOwnedTupleCleaned":true,"realSecretWrites":0,"providerLiveCalls":0,"ordinaryActiveTupleWrites":0,"backend":"existing native WindowsCredentialStore; task-owned nonsecret active tuple","productionTauriConfigurationCommandsUsed":true})).unwrap()).unwrap();
}
