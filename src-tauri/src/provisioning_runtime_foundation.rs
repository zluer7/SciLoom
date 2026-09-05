use uuid::Uuid;

/// Opaque identity for one Rust/Tauri process lifetime.
///
/// Production constructs this exactly once in `lib::run` and shares the same
/// instance with every ownership authority consumer.
#[derive(Debug)]
pub(crate) struct ProcessGeneration {
    canonical: String,
}

impl ProcessGeneration {
    pub(crate) fn new_process() -> Self {
        Self {
            canonical: Uuid::new_v4().to_string(),
        }
    }

    pub(crate) fn canonical(&self) -> &str {
        &self.canonical
    }

    #[cfg(test)]
    pub(crate) fn fixed_for_test(canonical: &str) -> Self {
        assert!(!canonical.trim().is_empty());
        Self {
            canonical: canonical.to_string(),
        }
    }

    #[cfg(test)]
    pub(crate) fn new(canonical: &str) -> Self {
        Self::fixed_for_test(canonical)
    }
}

#[cfg(test)]
impl Default for ProcessGeneration {
    fn default() -> Self {
        Self::new_process()
    }
}
