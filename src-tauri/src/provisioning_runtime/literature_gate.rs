use std::collections::HashMap;
use std::hash::Hash;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum LiteratureScope {
    Aggregate,
    Outline,
    Notes,
}

#[derive(Debug, Clone)]
struct OwnerGate<T> {
    aggregate: Option<T>,
    channels: HashMap<LiteratureScope, T>,
}

impl<T> Default for OwnerGate<T> {
    fn default() -> Self {
        Self {
            aggregate: None,
            channels: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct LiteratureGateRegistry<T> {
    owners: HashMap<String, OwnerGate<T>>,
}

impl<T> Default for LiteratureGateRegistry<T> {
    fn default() -> Self {
        Self {
            owners: HashMap::new(),
        }
    }
}

impl<T> LiteratureGateRegistry<T> {
    pub(super) fn conflict_ref(&self, owner_id: &str, scope: LiteratureScope) -> Option<&T> {
        let owner = self.owners.get(owner_id)?;
        match scope {
            LiteratureScope::Aggregate => owner
                .aggregate
                .as_ref()
                .or_else(|| owner.channels.get(&LiteratureScope::Outline))
                .or_else(|| owner.channels.get(&LiteratureScope::Notes)),
            LiteratureScope::Outline | LiteratureScope::Notes => owner
                .aggregate
                .as_ref()
                .or_else(|| owner.channels.get(&scope)),
        }
    }
}

impl<T: Clone> LiteratureGateRegistry<T> {
    pub(super) fn conflict(&self, owner_id: &str, scope: LiteratureScope) -> Option<T> {
        let owner = self.owners.get(owner_id)?;
        match scope {
            LiteratureScope::Aggregate => owner
                .aggregate
                .clone()
                .or_else(|| owner.channels.get(&LiteratureScope::Outline).cloned())
                .or_else(|| owner.channels.get(&LiteratureScope::Notes).cloned()),
            LiteratureScope::Outline | LiteratureScope::Notes => owner
                .aggregate
                .clone()
                .or_else(|| owner.channels.get(&scope).cloned()),
        }
    }
}

impl<T> LiteratureGateRegistry<T> {
    pub(super) fn insert(&mut self, owner_id: &str, scope: LiteratureScope, entry: T) {
        let owner = self.owners.entry(owner_id.to_string()).or_default();
        match scope {
            LiteratureScope::Aggregate => owner.aggregate = Some(entry),
            LiteratureScope::Outline | LiteratureScope::Notes => {
                owner.channels.insert(scope, entry);
            }
        }
    }

    pub(super) fn get_mut(&mut self, owner_id: &str, scope: LiteratureScope) -> Option<&mut T> {
        let owner = self.owners.get_mut(owner_id)?;
        match scope {
            LiteratureScope::Aggregate => owner.aggregate.as_mut(),
            LiteratureScope::Outline | LiteratureScope::Notes => owner.channels.get_mut(&scope),
        }
    }

    pub(super) fn get(&self, owner_id: &str, scope: LiteratureScope) -> Option<&T> {
        let owner = self.owners.get(owner_id)?;
        match scope {
            LiteratureScope::Aggregate => owner.aggregate.as_ref(),
            LiteratureScope::Outline | LiteratureScope::Notes => owner.channels.get(&scope),
        }
    }

    pub(super) fn entries(&self) -> impl Iterator<Item = &T> {
        self.owners
            .values()
            .flat_map(|owner| owner.aggregate.iter().chain(owner.channels.values()))
    }

    pub(super) fn remove_if(
        &mut self,
        owner_id: &str,
        scope: LiteratureScope,
        predicate: impl FnOnce(&T) -> bool,
    ) -> bool {
        let Some(owner) = self.owners.get_mut(owner_id) else {
            return false;
        };
        let removed = match scope {
            LiteratureScope::Aggregate => {
                if owner.aggregate.as_ref().is_some_and(predicate) {
                    owner.aggregate.take();
                    true
                } else {
                    false
                }
            }
            LiteratureScope::Outline | LiteratureScope::Notes => {
                if owner.channels.get(&scope).is_some_and(predicate) {
                    owner.channels.remove(&scope);
                    true
                } else {
                    false
                }
            }
        };
        if owner.aggregate.is_none() && owner.channels.is_empty() {
            self.owners.remove(owner_id);
        }
        removed
    }

    pub(super) fn entries_mut(&mut self) -> impl Iterator<Item = &mut T> {
        self.owners.values_mut().flat_map(|owner| {
            owner
                .aggregate
                .iter_mut()
                .chain(owner.channels.values_mut())
        })
    }

    pub(super) fn len(&self) -> usize {
        self.owners
            .values()
            .map(|owner| usize::from(owner.aggregate.is_some()) + owner.channels.len())
            .sum()
    }

    pub(super) fn owner_ids(&self) -> Vec<String> {
        self.owners.keys().cloned().collect()
    }
}
