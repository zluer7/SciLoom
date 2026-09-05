use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SqlTraceEvent {
    pub ordinal: usize,
    pub statement_kind: String,
    pub target_table: Option<String>,
    pub expanded_sql_sha256: String,
}

thread_local! {
    static SQL_TRACE: RefCell<Option<Vec<SqlTraceEvent>>> = const { RefCell::new(None) };
}

fn token_after<'a>(tokens: &'a [&'a str], keyword: &str) -> Option<&'a str> {
    tokens
        .iter()
        .position(|token| token.eq_ignore_ascii_case(keyword))
        .and_then(|index| tokens.get(index + 1).copied())
}

fn statement_metadata(sql: &str) -> (String, Option<String>) {
    let tokens = sql.split_whitespace().collect::<Vec<_>>();
    let statement_kind = tokens
        .first()
        .map(|token| token.trim_matches(|character: char| !character.is_ascii_alphabetic()))
        .unwrap_or_default()
        .to_ascii_uppercase();
    let target = match statement_kind.as_str() {
        "INSERT" => token_after(&tokens, "INTO"),
        "UPDATE" => tokens.get(1).copied(),
        "DELETE" | "SELECT" => token_after(&tokens, "FROM"),
        _ => None,
    }
    .map(|token| {
        token
            .trim_matches(|character: char| {
                matches!(
                    character,
                    '"' | '\'' | '`' | '[' | ']' | '(' | ')' | ',' | ';'
                )
            })
            .to_string()
    });
    (statement_kind, target)
}

fn trace_statement(expanded_sql: &str) {
    SQL_TRACE.with(|trace| {
        let mut trace = trace.borrow_mut();
        let Some(events) = trace.as_mut() else {
            return;
        };
        let (statement_kind, target_table) = statement_metadata(expanded_sql);
        events.push(SqlTraceEvent {
            ordinal: events.len(),
            statement_kind,
            target_table,
            expanded_sql_sha256: format!("{:x}", Sha256::digest(expanded_sql.as_bytes())),
        });
    });
}

pub(crate) fn start_sql_trace(connection: &mut Connection) {
    SQL_TRACE.with(|trace| {
        let replaced = trace.borrow_mut().replace(Vec::new());
        assert!(replaced.is_none(), "SQL trace scope must not be nested");
    });
    connection.trace(Some(trace_statement));
}

pub(crate) fn finish_sql_trace(connection: &mut Connection) -> Vec<SqlTraceEvent> {
    connection.trace(None);
    SQL_TRACE.with(|trace| {
        trace
            .borrow_mut()
            .take()
            .expect("SQL trace scope must be active")
    })
}

#[derive(Debug)]
struct NativeCommitAbortState {
    enabled: AtomicBool,
    callback_calls: AtomicUsize,
}

#[derive(Debug, Clone)]
pub(crate) struct NativeCommitAbortEvidence {
    state: Arc<NativeCommitAbortState>,
}

impl NativeCommitAbortEvidence {
    pub(crate) fn callback_calls(&self) -> usize {
        self.state.callback_calls.load(Ordering::SeqCst)
    }

    pub(crate) fn is_enabled(&self) -> bool {
        self.state.enabled.load(Ordering::SeqCst)
    }
}

#[derive(Debug)]
pub(crate) struct NativeCommitAbortScope {
    state: Arc<NativeCommitAbortState>,
}

impl Drop for NativeCommitAbortScope {
    fn drop(&mut self) {
        self.state.enabled.store(false, Ordering::SeqCst);
    }
}

pub(crate) fn arm_native_commit_hook_abort(
    connection: &Connection,
) -> (NativeCommitAbortScope, NativeCommitAbortEvidence) {
    let state = Arc::new(NativeCommitAbortState {
        enabled: AtomicBool::new(true),
        callback_calls: AtomicUsize::new(0),
    });
    let callback_state = Arc::clone(&state);
    connection.commit_hook(Some(move || {
        if callback_state.enabled.swap(false, Ordering::SeqCst) {
            callback_state.callback_calls.fetch_add(1, Ordering::SeqCst);
            true
        } else {
            false
        }
    }));
    (
        NativeCommitAbortScope {
            state: Arc::clone(&state),
        },
        NativeCommitAbortEvidence { state },
    )
}

pub(crate) fn remove_native_commit_hook(connection: &Connection) {
    connection.commit_hook(None::<fn() -> bool>);
}
