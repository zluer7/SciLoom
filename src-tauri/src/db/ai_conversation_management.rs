//! SC3-A4 Conversation-local lifecycle. Scientific owners/files are never deletion targets.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

pub(crate) const VERSION: i64 = 61;
pub(crate) const SCHEMA: &str = r#"
CREATE TABLE ai_conversation_management (
 conversation_id TEXT PRIMARY KEY NOT NULL,
 stable_key TEXT NOT NULL UNIQUE,
 title TEXT CHECK(title IS NULL OR (length(trim(title)) BETWEEN 1 AND 200)),
 archived_at TEXT,
 trashed_at TEXT,
 purged_at TEXT,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
 CHECK(purged_at IS NULL OR trashed_at IS NOT NULL)
);
INSERT INTO schema_migrations(version,name) VALUES(61,'conversation_local_lifecycle');
DROP TRIGGER trg_ai_context_request_delete_guard;
CREATE TRIGGER trg_ai_context_request_delete_guard BEFORE DELETE ON ai_context_requests
WHEN NOT EXISTS(SELECT 1 FROM ai_conversation_management WHERE conversation_id=OLD.conversation_id AND purged_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'AI_CONTEXT_REQUEST_DELETE_FORBIDDEN'); END;
DROP TRIGGER trg_ai_standard_result_delete_forbidden;
CREATE TRIGGER trg_ai_standard_result_delete_forbidden BEFORE DELETE ON ai_standard_results
WHEN NOT EXISTS(SELECT 1 FROM ai_conversation_management WHERE conversation_id=OLD.conversation_id AND purged_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'AI_STANDARD_RESULT_DELETE_FORBIDDEN'); END;
CREATE TRIGGER trg_ai_conversation_create_tombstone BEFORE INSERT ON ai_conversations
WHEN EXISTS(SELECT 1 FROM ai_conversation_management WHERE purged_at IS NOT NULL AND (conversation_id=NEW.id OR stable_key=NEW.stable_key))
BEGIN SELECT RAISE(ABORT,'AI_CONVERSATION_PERMANENTLY_DELETED'); END;
CREATE TRIGGER trg_ai_attempt_active_owner BEFORE INSERT ON ai_call_attempts
WHEN EXISTS(SELECT 1 FROM ai_conversation_management WHERE conversation_id=NEW.conversation_id AND (archived_at IS NOT NULL OR trashed_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'AI_CONVERSATION_NOT_ACTIVE'); END;
CREATE TRIGGER trg_ai_standard_result_active_owner BEFORE UPDATE ON ai_standard_results
WHEN EXISTS(SELECT 1 FROM ai_conversation_management WHERE conversation_id=OLD.conversation_id AND (archived_at IS NOT NULL OR trashed_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'AI_CONVERSATION_NOT_ACTIVE'); END;
CREATE TRIGGER trg_ai_context_request_active_owner BEFORE UPDATE ON ai_context_requests
WHEN EXISTS(SELECT 1 FROM ai_conversation_management WHERE conversation_id=OLD.conversation_id AND (archived_at IS NOT NULL OR trashed_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'AI_CONVERSATION_NOT_ACTIVE'); END;
"#;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all="camelCase")]
pub struct ConversationManagement {
    pub title: Option<String>,
    pub archived_at: Option<String>,
    pub trashed_at: Option<String>,
    pub revision: i64,
}

pub(crate) fn validate_schema(c: &Connection) -> rusqlite::Result<()> {
    c.prepare("SELECT conversation_id,stable_key,title,archived_at,trashed_at,purged_at,revision FROM ai_conversation_management LIMIT 0")?;
    let n:i64=c.query_row("SELECT COUNT(*) FROM schema_migrations WHERE version=61 AND name='conversation_local_lifecycle'",[],|r|r.get(0))?;
    let triggers:i64=c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN ('trg_ai_conversation_create_tombstone','trg_ai_attempt_active_owner','trg_ai_standard_result_active_owner','trg_ai_context_request_active_owner')",[],|r|r.get(0))?;
    if n!=1 || triggers!=4 {return Err(rusqlite::Error::InvalidQuery)}
    Ok(())
}

pub(crate) fn read(c:&Connection,id:&str)->rusqlite::Result<ConversationManagement>{
    c.query_row("SELECT title,archived_at,trashed_at,revision FROM ai_conversation_management WHERE conversation_id=?1 AND purged_at IS NULL",[id],|r|Ok(ConversationManagement{title:r.get(0)?,archived_at:r.get(1)?,trashed_at:r.get(2)?,revision:r.get(3)?})).optional().map(|v|v.unwrap_or_default())
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct ManageConversationInput {
    pub conversation_id:String,
    pub expected_revision:i64,
    pub action:String,
    pub title:Option<String>,
    pub confirmed:Option<bool>,
}

pub(crate) fn manage(c:&mut Connection,i:&ManageConversationInput)->Result<ConversationManagement,String>{
    let tx=c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let key:String=tx.query_row("SELECT stable_key FROM ai_conversations WHERE id=?1",[&i.conversation_id],|r|r.get(0)).map_err(|_|"AI_CONVERSATION_NOT_FOUND")?;
    let old=read(&tx,&i.conversation_id).map_err(|e|e.to_string())?;
    if old.revision!=i.expected_revision {return Err("AI_CONVERSATION_STATE_CHANGED".into())}
    let busy:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM ai_call_attempts WHERE conversation_id=?1 AND status='started') OR EXISTS(SELECT 1 FROM ai_standard_results WHERE conversation_id=?1 AND disposition='PENDING' AND confirmation_started_at IS NOT NULL)",[&i.conversation_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if busy {return Err("AI_CONVERSATION_BUSY_STOP_FIRST".into())}
    let now=chrono::Utc::now().to_rfc3339();
    let mut next=old.clone();
    match i.action.as_str(){
        "rename" if old.trashed_at.is_none()=>{
            let title=i.title.as_deref().unwrap_or("").trim();
            if title.is_empty()||title.chars().count()>200{return Err("AI_CONVERSATION_TITLE_INVALID".into())}
            next.title=Some(title.into());
        },
        "archive" if old.trashed_at.is_none()&&old.archived_at.is_none()=>next.archived_at=Some(now.clone()),
        "unarchive" if old.trashed_at.is_none()&&old.archived_at.is_some()=>next.archived_at=None,
        "trash" if old.trashed_at.is_none()=>next.trashed_at=Some(now.clone()),
        "restore" if old.trashed_at.is_some()=>next.trashed_at=None,
        "permanentDelete" if old.trashed_at.is_some()&&i.confirmed==Some(true)=>{},
        _=>return Err("AI_CONVERSATION_ACTION_NOT_ALLOWED".into()),
    }
    next.revision=old.revision.checked_add(1).ok_or("AI_CONVERSATION_REVISION_EXHAUSTED")?;
    let purge=if i.action=="permanentDelete"{Some(now)}else{None};
    tx.execute("INSERT INTO ai_conversation_management(conversation_id,stable_key,title,archived_at,trashed_at,purged_at,revision) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(conversation_id) DO UPDATE SET title=excluded.title,archived_at=excluded.archived_at,trashed_at=excluded.trashed_at,purged_at=excluded.purged_at,revision=excluded.revision",params![i.conversation_id,key,if purge.is_some(){None}else{next.title.clone()},next.archived_at,next.trashed_at,purge,next.revision]).map_err(|e|e.to_string())?;
    if i.action=="permanentDelete"{
        // Cyclic attempt/message references are checked at commit, not disabled.
        // Unknown incoming references make commit fail and roll back the whole purge.
        tx.execute_batch("PRAGMA defer_foreign_keys=ON;").map_err(|e|e.to_string())?;
        for table in ["ai_standard_results","ai_context_requests","ai_call_attempts","ai_messages"]{
            tx.execute(&format!("DELETE FROM {table} WHERE conversation_id=?1"),[&i.conversation_id]).map_err(|e|e.to_string())?;
        }
        tx.execute("DELETE FROM ai_conversations WHERE id=?1",[&i.conversation_id]).map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e|e.to_string())?;
    Ok(next)
}

#[tauri::command(rename_all="camelCase")]
pub fn db_manage_ai_conversation<R: tauri::Runtime>(app_handle:AppHandle<R>,input:ManageConversationInput)->Result<ConversationManagement,String>{
    let mut c=super::open_connection(&app_handle)?;manage(&mut c,&input)
}

#[cfg(test)]
#[path="ai_conversation_management_tests.rs"]
mod tests;
