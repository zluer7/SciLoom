use super::AppSecretLookupOutcome;
#[cfg(target_os = "macos")]
use super::CredentialStore;

// Generic-password service/account mapping is backend-local. The account is
// the complete existing logical target, including the active tuple target.
fn namespace(target: &str) -> (&'static str, &str) {
    ("local.labpod.desktop", target)
}

// Apple Security.framework errSecItemNotFound. All other OSStatus values,
// including denied access and unavailable/locked keychains, remain unavailable.
const ITEM_NOT_FOUND: i32 = -25300;

fn read_result(result: Result<Vec<u8>, i32>) -> AppSecretLookupOutcome {
    match result {
        Ok(bytes) => AppSecretLookupOutcome::Present(bytes),
        Err(ITEM_NOT_FOUND) => AppSecretLookupOutcome::Absent,
        Err(_) => AppSecretLookupOutcome::Unavailable,
    }
}

fn write_result(result: Result<(), i32>) -> Result<(), ()> {
    result.map_err(|_| ())
}

fn delete_result(result: Result<(), i32>) -> Result<(), ()> {
    match result {
        Ok(()) | Err(ITEM_NOT_FOUND) => Ok(()),
        Err(_) => Err(()),
    }
}

#[cfg(target_os = "macos")]
pub(super) struct MacCredentialStore {
    target: String,
}

#[cfg(target_os = "macos")]
impl MacCredentialStore {
    pub(super) fn new(target: String) -> Self {
        Self { target }
    }
}

#[cfg(target_os = "macos")]
impl CredentialStore for MacCredentialStore {
    fn read(&self) -> AppSecretLookupOutcome {
        let (service, account) = namespace(&self.target);
        read_result(
            security_framework::passwords::get_generic_password(service, account)
                .map_err(|error| error.code()),
        )
    }

    fn write(&self, value: &[u8]) -> Result<(), ()> {
        let (service, account) = namespace(&self.target);
        write_result(
            security_framework::passwords::set_generic_password(service, account, value)
                .map_err(|error| error.code()),
        )
    }

    fn delete(&self) -> Result<(), ()> {
        let (service, account) = namespace(&self.target);
        delete_result(
            security_framework::passwords::delete_generic_password(service, account)
                .map_err(|error| error.code()),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::super::{ACTIVE_TUPLE_TARGET, PROVIDER_PRESETS};
    use super::*;
    use std::collections::HashSet;

    #[cfg(target_os = "windows")]
    #[test]
    fn lp15_f2_windows_backend_target_and_error_classification_are_unchanged() {
        use super::super::WindowsCredentialStore;
        use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_NOT_FOUND};
        let target = WindowsCredentialStore::new(ACTIVE_TUPLE_TARGET.to_string());
        let wide = target.target_wide();
        assert_eq!(wide.last(), Some(&0));
        assert_eq!(
            String::from_utf16(&wide[..wide.len() - 1]).unwrap(),
            ACTIVE_TUPLE_TARGET
        );
        let missing = windows::core::Error::from_hresult(windows::core::HRESULT::from_win32(
            ERROR_NOT_FOUND.0,
        ));
        let denied = windows::core::Error::from_hresult(windows::core::HRESULT::from_win32(
            ERROR_ACCESS_DENIED.0,
        ));
        assert!(WindowsCredentialStore::is_not_found(&missing));
        assert!(!WindowsCredentialStore::is_not_found(&denied));
    }

    #[test]
    fn lp15_f2_keychain_namespace_preserves_tuple_and_every_canonical_slot() {
        let targets: HashSet<_> = std::iter::once(ACTIVE_TUPLE_TARGET)
            .chain(
                PROVIDER_PRESETS
                    .iter()
                    .map(|preset| preset.credential_target),
            )
            .collect();
        assert_eq!(targets.len(), 5);
        let mapped: HashSet<_> = targets.iter().map(|target| namespace(target)).collect();
        assert_eq!(mapped.len(), targets.len());
        for target in targets {
            assert_eq!(namespace(target), ("local.labpod.desktop", target));
        }
    }

    #[test]
    fn lp15_f2_keychain_only_missing_is_absent_and_delete_is_idempotent() {
        assert!(matches!(
            read_result(Err(ITEM_NOT_FOUND)),
            AppSecretLookupOutcome::Absent
        ));
        assert_eq!(delete_result(Err(ITEM_NOT_FOUND)), Ok(()));
        assert_eq!(write_result(Err(ITEM_NOT_FOUND)), Err(()));
        for code in [-25293, -25308, -25291, -50, -1] {
            assert!(matches!(
                read_result(Err(code)),
                AppSecretLookupOutcome::Unavailable
            ));
            assert_eq!(write_result(Err(code)), Err(()));
            assert_eq!(delete_result(Err(code)), Err(()));
        }
        let fixture = b"isolated-non-secret-fixture".to_vec();
        assert!(
            matches!(read_result(Ok(fixture.clone())), AppSecretLookupOutcome::Present(bytes) if bytes == fixture)
        );
        assert!(
            matches!(read_result(Ok(Vec::new())), AppSecretLookupOutcome::Present(bytes) if bytes.is_empty())
        );
        assert_eq!(write_result(Ok(())), Ok(()));
        assert_eq!(delete_result(Ok(())), Ok(()));
    }
}
